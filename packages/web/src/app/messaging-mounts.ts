import type { GambitClient } from '../api/client.js';
import { shortId } from '../api/graphql.js';
import { MessagesController } from './messages-controller.js';
import type { MessagesCallbacks } from './messages-controller.js';
import { renderInbox, renderThread } from './messages-view.js';
import { applyAutoDirection } from '../i18n/bidi.js';
import type { I18n } from '../i18n/manager.js';
import type { ConversationSummary, MessageView, SocialPlayer } from '../api/models.js';

export interface MessagingMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly sessionPresent: boolean;
  readonly restorePromise: Promise<unknown>;
  readonly i18n?: I18n;
}

export interface ConversationMountDependencies extends MessagingMountDependencies {
  readonly conversationId: string;
}

interface InboxElements {
  readonly inbox: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface ConversationElements {
  readonly thread: HTMLElement | null;
  readonly participant: HTMLElement | null;
  readonly error: HTMLElement | null;
  readonly composer: HTMLFormElement | null;
  readonly input: HTMLInputElement | null;
}

function loadAfterSessionRestore(
  sessionPresent: boolean,
  restorePromise: Promise<unknown>,
  load: () => void,
): void {
  if (sessionPresent) load();
  else void restorePromise.then(() => load()).catch(() => undefined);
}

function updateParticipantHeader(
  headerEl: HTMLElement | null,
  names: ReadonlyMap<string, SocialPlayer>,
  otherParticipantId: string | null,
  i18n?: I18n,
): void {
  if (!headerEl) return;
  if (otherParticipantId === null) {
    headerEl.textContent = i18n ? i18n.t('community.messages.conversation') : 'Conversation';
    headerEl.removeAttribute('dir');
  } else {
    const handle = names.get(otherParticipantId)?.handle ?? shortId(otherParticipantId);
    headerEl.textContent = i18n
      ? i18n.t('community.messages.conversationWith', { handle })
      : `Conversation with ${handle}`;
    applyAutoDirection(headerEl);
  }
}

function bindComposer(
  elements: ConversationElements,
  controller: MessagesController,
  conversationId: string,
  sessionPresent: boolean,
  restorePromise: Promise<unknown>,
  i18n?: I18n,
): () => void {
  if (!elements.composer || !elements.input) return () => {};
  const composer = elements.composer;
  const input = elements.input;
  // This form is static markup reused across SPA mounts. A previous mount may have left a draft
  // pending while its session restored; the new mount owns a fresh, editable composer.
  input.disabled = false;
  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (input.disabled) return;
    const text = input.value.trim();
    if (!text) return;

    // A route can reveal this static form before the new app instance restores its access token.
    // Hold the draft and send after restoration; an early authenticated request would fail locally
    // with "no active session" before any POST. Ignore duplicate submits while it is pending.
    input.disabled = true;
    void (async () => {
      if (!sessionPresent) {
        // AuthController.restore normally settles with null on failure. If it rejects, let send()
        // surface the missing session while retaining the draft, rather than stranding the input.
        try { await restorePromise; } catch { /* send reports the auth state */ }
      }
      return controller.send(conversationId, text);
    })().then((sent) => {
      // A late result from an abandoned route must not clear, enable or focus the new mount's draft.
      if (composer.onsubmit !== onSubmit) return;
      input.disabled = false;
      if (sent) input.value = '';
      input.focus();
    }).catch((error: unknown) => {
      if (composer.onsubmit !== onSubmit) return;
      input.disabled = false;
      if (elements.error) {
        elements.error.textContent = error instanceof Error
          ? error.message
          : (i18n ? i18n.t('community.messages.sendFailed') : 'Message could not be sent');
      }
    });
  };
  composer.onsubmit = onSubmit;
  return () => {
    if (composer.onsubmit !== onSubmit) return;
    composer.onsubmit = null;
    input.disabled = false;
  };
}

export function mountMessagesInbox({
  doc,
  client,
  sessionPresent,
  restorePromise,
  i18n,
}: MessagingMountDependencies): MessagesController {
  const elements: InboxElements = {
    inbox: doc.getElementById('messages-inbox'),
    error: doc.getElementById('messages-error'),
  };

  let lastItems: readonly ConversationSummary[] | null = null;
  let lastNames: ReadonlyMap<string, SocialPlayer> | null = null;

  const currentUserId = (): string | null => client.session.current?.user.id ?? null;

  const callbacks: MessagesCallbacks = {
    onInbox: (items, names) => {
      lastItems = items;
      lastNames = names;
      if (elements.error) elements.error.textContent = '';
      if (elements.inbox) renderInbox(elements.inbox, items, names, currentUserId(), i18n);
    },
    onThread: () => {},
    onLoading: (loading) => {
      if (elements.inbox) elements.inbox.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
  };

  const unsubscribeLocale = i18n?.onLocaleChange(() => {
    if (lastItems !== null && lastNames !== null && elements.inbox) {
      renderInbox(elements.inbox, lastItems, lastNames, currentUserId(), i18n);
    }
  });

  const controller = new MessagesController({
    client,
    callbacks,
    onDispose: () => {
      unsubscribeLocale?.();
    },
  });

  loadAfterSessionRestore(sessionPresent, restorePromise, () => void controller.loadInbox());
  return controller;
}

export function mountConversation({
  doc,
  client,
  conversationId,
  sessionPresent,
  restorePromise,
  i18n,
}: ConversationMountDependencies): MessagesController {
  const elements: ConversationElements = {
    thread: doc.getElementById('conversation-thread'),
    participant: doc.getElementById('conversation-participant'),
    error: doc.getElementById('conversation-error'),
    composer: doc.getElementById('conversation-composer') as HTMLFormElement | null,
    input: doc.getElementById('composer-input') as HTMLInputElement | null,
  };

  let lastThread: {
    readonly conversationId: string;
    readonly messages: readonly MessageView[];
    readonly names: ReadonlyMap<string, SocialPlayer>;
    readonly otherParticipantId: string | null;
  } | null = null;

  const currentUserId = (): string | null => client.session.current?.user.id ?? null;

  const callbacks: MessagesCallbacks = {
    onInbox: () => {},
    onThread: (id, messages, names, otherParticipantId) => {
      lastThread = { conversationId: id, messages, names, otherParticipantId };
      if (elements.error) elements.error.textContent = '';
      if (elements.thread) renderThread(elements.thread, messages, names, currentUserId(), i18n);
      updateParticipantHeader(elements.participant, names, otherParticipantId, i18n);
    },
    onLoading: (loading) => {
      if (elements.thread) elements.thread.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
  };

  const unsubscribeLocale = i18n?.onLocaleChange(() => {
    if (lastThread !== null) {
      if (elements.thread) {
        renderThread(elements.thread, lastThread.messages, lastThread.names, currentUserId(), i18n);
      }
      updateParticipantHeader(
        elements.participant,
        lastThread.names,
        lastThread.otherParticipantId,
        i18n,
      );
    }
  });

  let unbindComposer = (): void => {};
  const controller = new MessagesController({
    client,
    callbacks,
    onDispose: () => {
      unbindComposer();
      unsubscribeLocale?.();
    },
  });

  unbindComposer = bindComposer(
    elements,
    controller,
    conversationId,
    sessionPresent,
    restorePromise,
    i18n,
  );
  loadAfterSessionRestore(sessionPresent, restorePromise, () => {
    void controller.loadThread(conversationId);
    controller.startPolling(conversationId);
  });
  return controller;
}
