/**
 * Pure helpers for the Teams UI.
 *
 * The only interesting decision this feature makes is which action to offer on a team page, and
 * every wrong answer produces a button the server rejects. The rules come from the route
 * definitions in `packages/api/src/routes.ts`:
 *
 * - joining a private team answers 403 (join requests are a separate, unbuilt feature)
 * - joining twice answers 409
 * - the owner leaving answers 409 until ownership is transferred
 *
 * Ownership is read from the viewer's own membership row, never from `team.createdBy` — ownership
 * transfers, and the creator is not necessarily the current owner.
 */
import type { TeamMembership, TeamView } from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';

/** A viewer's role in a team, or null when they are not a member. */
export type TeamRole = 'owner' | 'admin' | 'member';

/**
 * What the team page offers the viewer.
 *
 * `none` carries a reason so the page can explain itself instead of silently showing nothing —
 * "joining is by request" and "sign in to join" are very different dead ends for a user.
 */
export type TeamAction =
  | { readonly kind: 'join' }
  | { readonly kind: 'leave' }
  | { readonly kind: 'none'; readonly reason: 'signed-out' | 'by-request' | 'owner' };

/** Find the viewer's membership row, or null when they are not a member. */
export function membershipOf(
  members: readonly TeamMembership[],
  viewerId: string | null,
): TeamMembership | null {
  if (viewerId === null) return null;
  return members.find((m) => m.playerId === viewerId) ?? null;
}

/**
 * Decide which action to offer. Order matters: membership is checked before visibility, because a
 * member of a private team can still leave it.
 *
 * `viewerRole` comes from the server on the team detail response rather than being looked up in the
 * member list. That list is paginated and sorted owner → admin → member, so an ordinary member of a
 * team with more members than one page is not in it, and searching it offered them a Join button for
 * a team they were already in.
 */
export function teamAction(
  team: TeamView,
  viewerRole: TeamRole | null,
  viewerId: string | null,
): TeamAction {
  if (viewerId === null) return { kind: 'none', reason: 'signed-out' };

  if (viewerRole !== null) {
    // The owner cannot leave without transferring ownership first, and transfer is not built yet.
    return viewerRole === 'owner' ? { kind: 'none', reason: 'owner' } : { kind: 'leave' };
  }

  // Not a member. Only public teams can be joined directly.
  return team.visibility === 'public' ? { kind: 'join' } : { kind: 'none', reason: 'by-request' };
}

/** The sentence shown in place of an action, so a dead end always explains itself. */
export function actionExplanation(
  reason: 'signed-out' | 'by-request' | 'owner',
  i18n: I18nManager,
): string {
  switch (reason) {
    case 'signed-out':
      return i18n.t('community.teams.reasonSignedOut');
    case 'by-request':
      return i18n.t('community.teams.reasonByRequest');
    case 'owner':
      return i18n.t('community.teams.reasonOwner');
  }
}

export interface JoinRequestQueue {
  readonly render: () => void;
  readonly respond: (requestId: string, status: 'accepted' | 'declined') => Promise<void>;
}

export function createJoinRequestQueue(deps: {
  readonly renderQueue: (busy: boolean) => void;
  readonly respond: (requestId: string, status: 'accepted' | 'declined') => Promise<boolean>;
}): JoinRequestQueue {
  return {
    render: () => {
      deps.renderQueue(false);
    },
    respond: async (requestId: string, status: 'accepted' | 'declined') => {
      deps.renderQueue(true);
      try {
        // `respond` reports failure by returning false, not by throwing — the controller catches and
        // surfaces the error itself. Awaiting without reading the result is what left the queue with
        // every button disabled after a 409, which is the case this whole seam exists for.
        const ok = await deps.respond(requestId, status);
        if (!ok) deps.renderQueue(false);
      } catch (err) {
        deps.renderQueue(false);
        throw err;
      }
    },
  };
}
