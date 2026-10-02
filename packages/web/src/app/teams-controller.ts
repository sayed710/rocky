/**
 * Teams controller — a pure, DOM-free orchestrator for the teams UI.
 *
 * Mirrors MessagesController's `requestGeneration` stale-response guard and `dispose()`. There is
 * deliberately no timer here: nothing on these pages updates on its own, so an injectable timer
 * seam would be a lever with nothing on the end of it.
 */
import type { GambitClient } from '../api/client.js';
import { NotFoundError } from '../net/errors.js';
import type { JoinRequestView, SocialPlayer, TeamDetailView, TeamMembership, TeamView } from '../api/models.js';

export interface TeamsCallbacks {
  onList: (teams: readonly TeamView[], total: number) => void;
  onTeam: (
    team: TeamDetailView,
    members: readonly TeamMembership[],
    names: ReadonlyMap<string, SocialPlayer>,
    joinRequests?: readonly JoinRequestView[],
  ) => void;
  onLoading: (loading: boolean) => void;
  onError: (message: string) => void;
  /** A team that does not exist, or a private one the viewer cannot see — the two are the same
   *  answer from the API on purpose (ADR-0069), so they are the same state here. */
  onNotFound: () => void;
}

export interface TeamsControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: TeamsCallbacks;
  readonly onDispose?: (() => void) | undefined;
}

export class TeamsController {
  private readonly client: GambitClient;
  private readonly callbacks: TeamsCallbacks;
  private readonly onDispose?: (() => void) | undefined;
  private requestGeneration = 0;
  private disposed = false;

  constructor(opts: TeamsControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.onDispose = opts.onDispose;
  }

  /** Load the team list, optionally filtered by a search term. */
  async loadList(search?: string): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const page = await this.client.teams.list(search ? { search } : {});
      if (!this.isCurrent(generation)) return;
      this.callbacks.onList(page.items, page.total);
    } catch (err) {
      if (this.isCurrent(generation)) this.callbacks.onError(messageOf(err));
    } finally {
      if (this.isCurrent(generation)) this.callbacks.onLoading(false);
    }
  }

  /** Load one team plus its members, with every member id resolved to a handle in one batch. */
  async loadTeam(slugOrId: string): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const team = await this.client.teams.byId(slugOrId);
      if (!this.isCurrent(generation)) return;

      // Members are keyed by the team's real id: the URL may carry a slug, and the members route
      // takes an id.
      const memberPage = await this.client.teams.members(team.id);
      if (!this.isCurrent(generation)) return;

      // From the team response, not from the member page. That page is capped at 50 and sorted
      // owner → admin → member, so on a large team the viewer is simply not in it — an admin behind
      // 50 other admins never saw the queue, and an ordinary member was offered a Join button for a
      // team they were already in.
      const canModerate = team.viewerRole === 'owner' || team.viewerRole === 'admin';

      let joinRequests: readonly JoinRequestView[] | undefined = undefined;
      let joinReqPlayerIds: string[] = [];

      if (canModerate) {
        const joinReqPage = await this.client.teams.joinRequests(team.id, { status: 'pending' });
        if (!this.isCurrent(generation)) return;
        joinRequests = joinReqPage.items;
        joinReqPlayerIds = joinReqPage.items.map((r) => r.playerId);
      }

      const ids = Array.from(
        new Set([...memberPage.items.map((m) => m.playerId), ...joinReqPlayerIds]),
      );
      const names = await this.client.graphql.resolvePlayers(ids);
      if (!this.isCurrent(generation)) return;

      this.callbacks.onTeam(team, memberPage.items, names, joinRequests);
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      // A private team the viewer cannot see answers 404, identically to one that does not exist.
      // Rendering "forbidden" here would confirm it exists and undo that protection.
      if (err instanceof NotFoundError) this.callbacks.onNotFound();
      else this.callbacks.onError(messageOf(err));
    } finally {
      if (this.isCurrent(generation)) this.callbacks.onLoading(false);
    }
  }

  /** Join a public team, then reload so the member list and the offered action both catch up. */
  async join(teamId: string, slugOrId: string): Promise<boolean> {
    if (this.disposed) return false;
    try {
      await this.client.teams.join(teamId);
    } catch (err) {
      if (!this.disposed) this.callbacks.onError(messageOf(err));
      return false;
    }
    if (!this.disposed) await this.loadTeam(slugOrId);
    return true;
  }

  /** Leave a team, then reload for the same reason. */
  async leave(teamId: string, playerId: string, slugOrId: string): Promise<boolean> {
    if (this.disposed) return false;
    try {
      await this.client.teams.leave(teamId, playerId);
    } catch (err) {
      if (!this.disposed) this.callbacks.onError(messageOf(err));
      return false;
    }
    if (!this.disposed) await this.loadTeam(slugOrId);
    return true;
  }

  /** Respond to a join request (accept or decline), then reload team. */
  async respondToJoinRequest(
    teamId: string,
    requestId: string,
    status: 'accepted' | 'declined',
    slugOrId: string,
  ): Promise<boolean> {
    if (this.disposed) return false;
    try {
      await this.client.teams.respondToJoinRequest(teamId, requestId, status);
    } catch (err) {
      if (!this.disposed) this.callbacks.onError(messageOf(err));
      return false;
    }
    if (!this.disposed) await this.loadTeam(slugOrId);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.onDispose?.();
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
