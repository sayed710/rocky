/**
 * Forum controller — a pure, DOM-free orchestrator for a team's forum.
 *
 * Mirrors TeamsController: a `requestGeneration` stale-response guard and `dispose()`, no timer
 * because nothing here updates on its own.
 *
 * A thread view needs three things before it can decide what to offer: the thread, its posts, and
 * the team's member list — replying requires membership *and* an unlocked thread, and neither the
 * thread nor the posts carry membership.
 */
import type { GambitClient } from '../api/client.js';
import { NotFoundError } from '../net/errors.js';
import type {
  ForumPost,
  ForumThread,
  SocialPlayer,
  TeamMembership,
  TeamView,
} from '../api/models.js';

export interface ForumCallbacks {
  onThreads: (
    team: TeamView,
    threads: readonly ForumThread[],
    members: readonly TeamMembership[],
    names: ReadonlyMap<string, SocialPlayer>,
  ) => void;
  onThread: (
    team: TeamView,
    thread: ForumThread,
    posts: readonly ForumPost[],
    members: readonly TeamMembership[],
    names: ReadonlyMap<string, SocialPlayer>,
  ) => void;
  onLoading: (loading: boolean) => void;
  onError: (message: string) => void;
  /** Missing, or private and invisible to this viewer — the API answers both the same way. */
  onNotFound: () => void;
}

export interface ForumControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: ForumCallbacks;
  readonly onDispose?: (() => void) | undefined;
}

export class ForumController {
  private readonly client: GambitClient;
  private readonly callbacks: ForumCallbacks;
  private readonly onDispose?: (() => void) | undefined;
  private requestGeneration = 0;
  private disposed = false;

  constructor(opts: ForumControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.onDispose = opts.onDispose;
  }

  /** Load a team's thread list, with the members needed to decide who may start a thread. */
  async loadThreads(slugOrId: string): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      // The URL carries a slug; every forum route needs the team's real id.
      const team = await this.client.teams.byId(slugOrId);
      if (!this.isCurrent(generation)) return;

      const [threadPage, memberPage] = await Promise.all([
        this.client.teams.threads(team.id),
        this.client.teams.members(team.id),
      ]);
      if (!this.isCurrent(generation)) return;

      // Authors only. The member list is fetched for the membership DECISION, which compares ids —
      // no member name is ever rendered here, so resolving them would buy nothing and cost a
      // GraphQL round-trip per alias chunk on a large team.
      const names = await this.resolveAuthors(threadPage.items.map((t) => t.authorId));
      if (!this.isCurrent(generation)) return;

      this.callbacks.onThreads(team, threadPage.items, memberPage.items, names);
    } catch (err) {
      this.report(generation, err);
    } finally {
      if (this.isCurrent(generation)) this.callbacks.onLoading(false);
    }
  }

  /** Load one thread with its posts and the team's members. */
  async loadThread(slugOrId: string, threadId: string): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const team = await this.client.teams.byId(slugOrId);
      if (!this.isCurrent(generation)) return;

      const [thread, postPage, memberPage] = await Promise.all([
        this.client.teams.thread(team.id, threadId),
        this.client.teams.posts(team.id, threadId),
        this.client.teams.members(team.id),
      ]);
      if (!this.isCurrent(generation)) return;

      // Authors only, for the same reason as the thread list.
      const names = await this.resolveAuthors([
        thread.authorId,
        ...postPage.items.map((p) => p.authorId),
      ]);
      if (!this.isCurrent(generation)) return;

      this.callbacks.onThread(team, thread, postPage.items, memberPage.items, names);
    } catch (err) {
      this.report(generation, err);
    } finally {
      if (this.isCurrent(generation)) this.callbacks.onLoading(false);
    }
  }

  /**
   * Start a thread, then reload the list.
   *
   * Returns whether it landed so the caller can decide what to do with the text it took from the
   * user — clearing a composer before knowing the request succeeded loses what they wrote.
   */
  async createThread(teamId: string, slugOrId: string, title: string, body: string): Promise<boolean> {
    if (this.disposed) return false;
    try {
      await this.client.teams.createThread(teamId, title, body);
    } catch (err) {
      if (!this.disposed) this.callbacks.onError(messageOf(err));
      return false;
    }
    if (!this.disposed) await this.loadThreads(slugOrId);
    return true;
  }

  /** Reply to a thread, then reload it. Same return contract as `createThread`. */
  async createPost(teamId: string, slugOrId: string, threadId: string, body: string): Promise<boolean> {
    if (this.disposed) return false;
    try {
      await this.client.teams.createPost(teamId, threadId, body);
    } catch (err) {
      if (!this.disposed) this.callbacks.onError(messageOf(err));
      return false;
    }
    if (!this.disposed) await this.loadThread(slugOrId, threadId);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.onDispose?.();
  }

  /** One batched lookup per render, de-duplicated by the read layer. */
  private resolveAuthors(ids: readonly string[]): Promise<ReadonlyMap<string, SocialPlayer>> {
    return this.client.graphql.resolvePlayers(ids);
  }

  private report(generation: number, err: unknown): void {
    if (!this.isCurrent(generation)) return;
    // A private team, a missing team and a missing thread all answer 404 — deliberately, so the
    // API is not an existence oracle (ADR-0069). Reporting "forbidden" would undo that.
    if (err instanceof NotFoundError) this.callbacks.onNotFound();
    else this.callbacks.onError(messageOf(err));
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
