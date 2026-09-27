/**
 * Messages controller — a pure, DOM-free orchestrator for the direct messaging UI.
 *
 * Mirrors TournamentController:
 *  - a requestGeneration counter so a slow response for an abandoned view is discarded
 *  - an injectable timer (setInterval/clearInterval passed in), never a bare global
 *  - a pollInFlight guard so a slow poll cannot stack
 *  - dispose() that clears the timer and stops all work
 */
import type { GambitClient } from '../api/client.js';
import { getOtherParticipantId } from './messages-helpers.js';
import type {
  ConversationSummary,
  ConversationView,
  MessageView,
  SocialPlayer,
} from '../api/models.js';

export interface MessagesCallbacks {
  onInbox: (
    items: readonly ConversationSummary[],
    names: ReadonlyMap<string, SocialPlayer>,
  ) => void;
  onThread: (
    conversationId: string,
    messages: readonly MessageView[],
    names: ReadonlyMap<string, SocialPlayer>,
    /**
     * The other participant, from the conversation itself. A `MessageView` carries only a
     * `senderId`, so a thread the caller alone has posted in — the state every conversation
     * starts in — cannot name the other party from its messages.
     */
    otherParticipantId: string | null,
  ) => void;
  onLoading: (loading: boolean) => void;
  onError: (message: string) => void;
}

export interface MessagesControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: MessagesCallbacks;
  readonly onDispose?: () => void;
  /** Live polling interval in milliseconds (default 5000ms). */
  readonly pollIntervalMs?: number;
  /** Injected timer (for tests). */
  readonly setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (id: ReturnType<typeof setInterval>) => void;
}

export class MessagesController {
  private readonly client: GambitClient;
  private readonly callbacks: MessagesCallbacks;
  private readonly onDispose: (() => void) | undefined;
  private readonly pollIntervalMs: number;
  private readonly _setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly _clearInterval: (id: ReturnType<typeof setInterval>) => void;
  private requestGeneration = 0;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private activeConversationId: string | null = null;
  private pollInFlight = false;
  private otherParticipantId: string | null = null;
  private disposed = false;

  constructor(opts: MessagesControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.onDispose = opts.onDispose;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this._setInterval = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = opts.clearInterval ?? ((id) => clearInterval(id));
  }

  /** Fetch the inbox list of conversations. */
  async loadInbox(opts?: { limit?: number; offset?: number }): Promise<void> {
    if (this.disposed) return;
    this.stopPolling();
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const list = await this.client.messages.listConversations(opts);
      if (!this.isCurrent(generation)) return;

      const playerIds = list.items.flatMap((item) => [
        item.conversation.participantA,
        item.conversation.participantB,
      ]);
      const names = await this.client.graphql.resolvePlayers(playerIds);
      if (!this.isCurrent(generation)) return;

      this.callbacks.onInbox(list.items, names);
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.callbacks.onLoading(false);
      }
    }
  }

  /** Fetch messages for a specific conversation thread and mark it read. */
  async loadThread(conversationId: string, opts?: { limit?: number; offset?: number }): Promise<void> {
    if (this.disposed) return;
    this.stopPolling();
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      // The conversation is fetched alongside the messages, not instead of them: it is the only
      // source of the other participant's id when the caller is the only one who has posted.
      const [conversation, msgList] = await Promise.all([
        this.client.messages.conversation(conversationId),
        this.client.messages.messages(conversationId, opts),
      ]);
      if (!this.isCurrent(generation)) return;

      const otherId = this.otherParticipantOf(conversation);
      this.otherParticipantId = otherId;

      const playerIds = msgList.items.map((m) => m.senderId);
      if (otherId !== null) playerIds.push(otherId);
      const names = await this.client.graphql.resolvePlayers(playerIds);
      if (!this.isCurrent(generation)) return;

      this.callbacks.onThread(conversationId, msgList.items, names, otherId);

      // On opening a thread, mark it as read. A failure of markRead must NOT fail the thread render.
      try {
        await this.client.messages.markRead(conversationId);
      } catch {
        // Quiet failure for markRead — the messages are rendered and available to user
      }
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.callbacks.onLoading(false);
      }
    }
  }

  /**
   * Send a message to the active thread and reload it.
   *
   * Returns whether the send succeeded, so the caller can decide what to do with the text it took
   * from the user. Clearing a composer before knowing the send landed loses whatever they typed.
   */
  async send(conversationId: string, body: string): Promise<boolean> {
    if (this.disposed) return false;
    const wasPolling = this.timerId !== null && this.activeConversationId === conversationId;
    this.callbacks.onLoading(true);
    try {
      await this.client.messages.send(conversationId, body);
      if (this.disposed) return true;
      await this.loadThread(conversationId);
      if (wasPolling && !this.disposed) {
        this.startPolling(conversationId);
      }
      return true;
    } catch (err) {
      if (!this.disposed) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
      return false;
    } finally {
      if (!this.disposed) {
        this.callbacks.onLoading(false);
      }
    }
  }

  /** Start polling the open thread for new messages every 5000ms. */
  startPolling(conversationId: string): void {
    if (this.disposed) return;
    this.stopPolling();
    this.activeConversationId = conversationId;

    const poll = async () => {
      if (this.disposed || this.activeConversationId !== conversationId) return;
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      try {
        const msgList = await this.client.messages.messages(conversationId);
        if (this.disposed || this.activeConversationId !== conversationId) return;
        // Reuse the participant resolved by `loadThread`; participants cannot change, so the poll
        // does not re-fetch the conversation every 5 seconds to learn something it already knows.
        const otherId = this.otherParticipantId;
        const playerIds = msgList.items.map((m) => m.senderId);
        if (otherId !== null) playerIds.push(otherId);
        const names = await this.client.graphql.resolvePlayers(playerIds);
        if (this.disposed || this.activeConversationId !== conversationId) return;
        this.callbacks.onThread(conversationId, msgList.items, names, otherId);
      } catch (err) {
        if (!this.disposed && this.activeConversationId === conversationId) {
          this.callbacks.onError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        this.pollInFlight = false;
      }
    };

    if (this.pollIntervalMs > 0) {
      this.timerId = this._setInterval(() => void poll(), this.pollIntervalMs);
    }
  }

  /** Stop the thread polling timer. */
  stopPolling(): void {
    if (this.timerId !== null) {
      this._clearInterval(this.timerId);
      this.timerId = null;
    }
    this.activeConversationId = null;
    this.pollInFlight = false;
  }

  /** Permanently dispose the controller. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPolling();
    this.onDispose?.();
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }

  /**
   * The participant who is not the caller. Returns `null` when the viewer's identity is unknown
   * (signed out) rather than guessing a side — naming the wrong person is worse than naming none.
   */
  private otherParticipantOf(conversation: ConversationView): string | null {
    const viewerId = this.client.session.current?.user.id ?? null;
    if (viewerId === null) return null;
    return getOtherParticipantId(conversation, viewerId);
  }
}
