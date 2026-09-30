import type { GambitClient } from '../api/client.js';
import type { GameSummary, PlayerAchievement, SocialPlayer, UserProfile } from '../api/models.js';
import type { AuthSession } from './auth-controller.js';
import { ProfileController } from './profile-controller.js';
import { SocialController } from './social-controller.js';
import type { Relationship, SelfSocial } from './social-controller.js';
import { AchievementsController } from './achievements-controller.js';
import { renderAchievements } from './achievements-view.js';
import { summaryLabel } from './achievements-helpers.js';
import { PasskeysController } from './passkeys-controller.js';
import { renderPasskeys } from './passkeys-view.js';
import { SessionsController } from './sessions-controller.js';
import { activeSessions, renderSessions } from './sessions-view.js';
import type { WebAuthnAdapter } from '../ports/webauthn.js';
import {
  renderEmpty,
  appendPanelRow,
} from './render-helpers.js';
import type { RowAction } from './render-helpers.js';
import { getSpeedLabel, getVariantLabel } from './variant-labels.js';
import { applyAutoDirection, applyLtrIsolation } from '../i18n/bidi.js';
import type { I18nManager } from '../i18n/manager.js';

/**
 * Render the action bar shown on another player's profile.
 *
 * A relationship of `null` means there is nothing to offer — the viewer is
 * signed out, or looking at their own profile — so the bar is emptied rather
 * than filled with disabled controls that suggest a signed-in affordance.
 *
 * Follow state is carried by the verb ("Follow" vs "Unfollow"), never by colour
 * alone: this system has exactly one accent and it means "active", so a colour
 * difference here would be both off-system and invisible to a colourblind user.
 */
function renderSocialActions(
  container: HTMLElement,
  relationship: Relationship | null,
  social: SocialController,
  busy: boolean,
  i18n?: I18nManager,
  onOpenMessage?: () => void,
): void {
  container.innerHTML = '';
  if (relationship === null) return;

  const actions: RowAction[] = [];

  if (relationship.blocked) {
    // A block supersedes everything else, so offering follow or friend controls
    // beside it would advertise actions the server will refuse.
    actions.push({
      label: i18n ? i18n.t('profile.social.unblock') : 'Unblock',
      run: () => void social.unblockSubject(),
    });
  } else {
    actions.push(
      relationship.following
        ? {
            label: i18n ? i18n.t('profile.social.unfollow') : 'Unfollow',
            run: () => void social.unfollow(),
          }
        : {
            label: i18n ? i18n.t('profile.social.follow') : 'Follow',
            run: () => void social.follow(),
          },
    );

    if (onOpenMessage) {
      actions.push({
        label: i18n ? i18n.t('profile.social.message') : 'Message',
        run: onOpenMessage,
        communicative: true,
      });
    }

    if (relationship.incomingRequestId !== null) {
      const id = relationship.incomingRequestId;
      actions.push(
        {
          label: i18n ? i18n.t('profile.social.acceptFriend') : 'Accept friend request',
          run: () => void social.respond(id, 'accept'),
        },
        {
          label: i18n ? i18n.t('profile.social.declineFriend') : 'Decline friend request',
          run: () => void social.respond(id, 'decline'),
        },
      );
    } else if (relationship.outgoingRequestId !== null) {
      const id = relationship.outgoingRequestId;
      actions.push({
        label: i18n ? i18n.t('profile.social.cancelFriend') : 'Cancel friend request',
        run: () => void social.respond(id, 'cancel'),
      });
    } else {
      actions.push({
        label: i18n ? i18n.t('profile.social.addFriend') : 'Add friend',
        run: () => void social.sendFriendRequest(),
      });
    }

    actions.push({
      label: i18n ? i18n.t('profile.social.block') : 'Block',
      run: () => void social.block(),
      destructive: true,
    });
  }

  const doc = container.ownerDocument;
  for (const action of actions) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.disabled = busy;
    // Block is destructive and must not sit flush against the connective
    // actions, where a mis-aimed click is one pixel away from severing a
    // relationship. DESIGN.md is explicit that hierarchy here comes from
    // placement and copy rather than a second button treatment, so it is
    // separated by position — not by colour or weight.
    if (action.destructive) button.classList.add('social-action-destructive');
    if (action.communicative) button.classList.add('social-action-communicate');
    button.addEventListener('click', action.run);
    container.appendChild(button);
  }
}

/** Render a list of players, each with the actions that apply to them. */
function renderPlayerList(
  container: HTMLElement,
  players: readonly SocialPlayer[],
  empty: { readonly title: string; readonly body: string },
  busy: boolean,
  actionsFor: (player: SocialPlayer) => readonly RowAction[] = () => [],
): void {
  container.innerHTML = '';
  if (players.length === 0) {
    renderEmpty(container, { ...empty, inline: true });
    return;
  }
  for (const player of players) {
    appendPanelRow(container, player.handle, actionsFor(player), busy);
  }
}

/** Dependencies required to mount the profile view. */
interface ProfileMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly handle: string | null;
  readonly getCurrentSession: () => AuthSession | null;
  readonly restorePromise: Promise<AuthSession | null>;
  readonly webauthnAdapter?: WebAuthnAdapter;
  readonly i18n?: I18nManager;
}

/** The result of mounting the profile view. */
interface MountedProfile {
  readonly profile: ProfileController;
  readonly passkeys: { dispose: () => void } | null;
  readonly onSessionChange: (session: AuthSession | null) => void;
}

/**
 * Mount the profile view against the given DOM document.
 *
 * Handles both public profiles (`/profile/:handle`) and self-profiles (`/profile`),
 * wiring ratings, recent games, social relationships, achievements, and passkey management.
 */
export function mountProfile(deps: ProfileMountDependencies): MountedProfile {
  const { doc, client, handle, webauthnAdapter, getCurrentSession, restorePromise, i18n } = deps;

  const handleEl = doc.getElementById('profile-handle');
  const ratingsEl = doc.getElementById('profile-ratings');
  const gamesEl = doc.getElementById('profile-games');
  const profileErrorEl = doc.getElementById('profile-error');

  // --- Social region (M10 inc 9) ---
  const socialActionsEl = doc.getElementById('social-actions');
  const followersEl = doc.getElementById('social-followers');
  const followingEl = doc.getElementById('social-following');
  const followerCountEl = doc.getElementById('social-follower-count');
  const followingCountEl = doc.getElementById('social-following-count');
  const socialSelfEl = doc.getElementById('social-self');
  const incomingEl = doc.getElementById('social-incoming');
  const outgoingEl = doc.getElementById('social-outgoing');
  const friendsEl = doc.getElementById('social-friends');
  const friendCountEl = doc.getElementById('social-friend-count');
  const blockedEl = doc.getElementById('social-blocked');
  const socialNoteEl = doc.getElementById('social-note');
  const socialErrorEl = doc.getElementById('social-error');

  // --- Achievements region (M14 inc 22) ---
  const achievementsEl = doc.getElementById('achievements');
  const achievementsListEl = doc.getElementById('achievements-list');
  const achievementsCountEl = doc.getElementById('achievements-count');
  const achievementsErrorEl = doc.getElementById('achievements-error');

  // --- Passkeys region (M14 inc 44) ---
  const passkeysSelfEl = doc.getElementById('passkeys-self');
  const passkeysCountEl = doc.getElementById('passkeys-count');
  const passkeysRegisterEl = doc.getElementById('passkey-register');
  const passkeysListEl = doc.getElementById('passkeys-list');
  const passkeysNoteEl = doc.getElementById('passkeys-note');
  const passkeysErrorEl = doc.getElementById('passkeys-error');

  // --- Active sessions region (M14 inc 46) ---
  // Shares the `passkeys-self` container: both are account-security controls for the signed-in
  // user's own profile, and neither has any meaning on someone else's.
  const sessionsCountEl = doc.getElementById('sessions-count');
  const sessionsListEl = doc.getElementById('sessions-list');
  const sessionsNoteEl = doc.getElementById('sessions-note');
  const sessionsErrorEl = doc.getElementById('sessions-error');

  let socialBusy = false;
  let passkeysBusy = false;
  let sessionsBusy = false;
  let lastProfile: UserProfile | null = null;
  let lastGames: readonly GameSummary[] | null = null;
  let lastConnections: {
    followers: readonly SocialPlayer[];
    following: readonly SocialPlayer[];
    followerCount: number;
    followingCount: number;
    named: boolean;
  } | null = null;
  let lastRelationship: Relationship | null = null;
  let lastSelfSocial: SelfSocial | null = null;
  let lastAchievements: { items: readonly PlayerAchievement[]; summary: Parameters<typeof summaryLabel>[0] } | null = null;
  let lastPasskeys: Parameters<typeof renderPasskeys>[1] | null = null;
  let lastSessions: Parameters<typeof renderSessions>[1] | null = null;
  let passkeysCtrl: PasskeysController | null = null;
  let passkeysUnbind = () => {};
  let sessionsCtrl: SessionsController | null = null;

  const renderProfileRatings = (p: UserProfile): void => {
    if (!ratingsEl) return;
    if (p.ratings.length === 0) {
      renderEmpty(ratingsEl, {
        title: i18n ? i18n.t('profile.ratings.emptyTitle') : 'No ratings yet',
        body: i18n ? i18n.t('profile.ratings.emptyBody') : 'Play a rated game to establish a rating.',
        inline: true,
      });
    } else {
      ratingsEl.innerHTML = '';
      for (const r of p.ratings) {
        const row = doc.createElement('div');
        row.className = 'rating-row';
        const labelSpan = doc.createElement('span');
        labelSpan.textContent = `${getVariantLabel(r.variant, i18n)} · ${getSpeedLabel(r.speed, i18n)}: `;
        const statsSpan = doc.createElement('span');
        statsSpan.textContent = `${Math.round(r.rating)} (RD ${Math.round(r.rd)})`;
        applyLtrIsolation(statsSpan);
        row.append(labelSpan, statsSpan);
        ratingsEl.appendChild(row);
      }
    }
  };

  const renderProfileGames = (games: readonly GameSummary[]): void => {
    if (!gamesEl) return;
    if (games.length === 0) {
      renderEmpty(gamesEl, {
        mark: '♞',
        title: i18n ? i18n.t('profile.games.emptyTitle') : 'No games yet',
        body: i18n ? i18n.t('profile.games.emptyBody') : 'Your finished games will show up here.',
        cta: {
          label: i18n ? i18n.t('profile.games.findGame') : 'Find a game',
          href: '/',
          route: 'lobby',
        },
      });
    } else {
      gamesEl.innerHTML = '';
      for (const g of games) {
        const row = doc.createElement('div');
        row.className = 'game-row';
        const variantStr = getVariantLabel(g.variant, i18n);
        const speedStr = getSpeedLabel(g.speed, i18n);
        const resultStr = g.result ?? (i18n ? i18n.t('profile.games.ongoing') : 'ongoing');
        const plyStr = i18n ? i18n.t('profile.games.plyCount', { count: g.plyCount }) : `${g.plyCount} ply`;
        row.textContent = `${variantStr} · ${speedStr} · ${resultStr} · ${plyStr}`;
        gamesEl.appendChild(row);
      }
    }
  };

  const renderConnectionsView = (c: {
    followers: readonly SocialPlayer[];
    following: readonly SocialPlayer[];
    followerCount: number;
    followingCount: number;
    named: boolean;
  }): void => {
    if (followerCountEl) followerCountEl.textContent = String(c.followerCount);
    if (followingCountEl) followingCountEl.textContent = String(c.followingCount);
    if (followersEl) {
      renderPlayerList(
        followersEl,
        c.followers,
        {
          title: i18n ? i18n.t('profile.social.emptyFollowersTitle') : 'No followers yet',
          body: i18n ? i18n.t('profile.social.emptyFollowersBody') : 'Followers appear here once someone follows this player.',
        },
        socialBusy,
      );
    }
    if (followingEl) {
      renderPlayerList(
        followingEl,
        c.following,
        {
          title: i18n ? i18n.t('profile.social.emptyFollowingTitle') : 'Not following anyone yet',
          body: i18n ? i18n.t('profile.social.emptyFollowingBody') : 'Players this account follows appear here.',
        },
        socialBusy,
      );
    }
    if (socialNoteEl) {
      socialNoteEl.textContent = c.named
        ? ''
        : (i18n ? i18n.t('profile.social.noteNoNames') : 'Player names are unavailable while the read layer is disabled; showing partial ids.');
    }
  };

  const renderSelfSocialView = (s: SelfSocial): void => {
    if (socialSelfEl) socialSelfEl.hidden = false;
    if (incomingEl) {
      incomingEl.innerHTML = '';
      if (s.incoming.length === 0) {
        renderEmpty(incomingEl, {
          title: i18n ? i18n.t('profile.social.emptyIncomingTitle') : 'No requests waiting',
          body: i18n ? i18n.t('profile.social.emptyIncomingBody') : 'Friend requests sent to you appear here.',
          inline: true,
        });
      } else {
        for (const { request, player } of s.incoming) {
          appendPanelRow(
            incomingEl,
            player.handle,
            [
              {
                label: i18n ? i18n.t('profile.social.accept') : 'Accept',
                run: () => void social.respond(request.id, 'accept'),
              },
              {
                label: i18n ? i18n.t('profile.social.decline') : 'Decline',
                run: () => void social.respond(request.id, 'decline'),
              },
            ],
            socialBusy,
          );
        }
      }
    }
    if (outgoingEl) {
      outgoingEl.innerHTML = '';
      if (s.outgoing.length === 0) {
        renderEmpty(outgoingEl, {
          title: i18n ? i18n.t('profile.social.emptyOutgoingTitle') : 'Nothing pending',
          body: i18n ? i18n.t('profile.social.emptyOutgoingBody') : 'Requests you send appear here until they are answered.',
          inline: true,
        });
      } else {
        for (const { request, player } of s.outgoing) {
          appendPanelRow(
            outgoingEl,
            player.handle,
            [{
              label: i18n ? i18n.t('profile.social.cancel') : 'Cancel',
              run: () => void social.respond(request.id, 'cancel'),
            }],
            socialBusy,
          );
        }
      }
    }
    if (friendCountEl) friendCountEl.textContent = String(s.friends.length);
    if (friendsEl) {
      renderPlayerList(
        friendsEl,
        s.friends,
        {
          title: i18n ? i18n.t('profile.social.emptyFriendsTitle') : 'No friends yet',
          body: i18n ? i18n.t('profile.social.emptyFriendsBody') : 'Accepted friend requests appear here.',
        },
        socialBusy,
      );
    }
    if (blockedEl) {
      renderPlayerList(
        blockedEl,
        s.blocked,
        {
          title: i18n ? i18n.t('profile.social.emptyBlockedTitle') : 'No blocked players',
          body: i18n ? i18n.t('profile.social.emptyBlockedBody') : 'Players you block appear here.',
        },
        socialBusy,
        (player) => [{
          label: i18n ? i18n.t('profile.social.unblock') : 'Unblock',
          run: () => void social.unblock(player.id),
        }],
      );
    }
  };

  if (!handle) {
    passkeysCtrl = new PasskeysController({
      client,
      ...(webauthnAdapter !== undefined ? { webauthnAdapter } : {}),
      callbacks: {
        onPasskeys: (items) => {
          lastPasskeys = items;
          if (passkeysCountEl) passkeysCountEl.textContent = items.length > 0 ? `(${items.length})` : '';
          if (passkeysListEl) {
            renderPasskeys(
              passkeysListEl,
              items,
              (id) => void passkeysCtrl?.deletePasskey(id),
              passkeysBusy,
              i18n,
            );
          }
        },
        onPending: (pending) => {
          passkeysBusy = pending;
          if (passkeysRegisterEl instanceof HTMLButtonElement) {
            passkeysRegisterEl.disabled = pending;
          }
          if (passkeysListEl) {
            for (const btn of passkeysListEl.querySelectorAll('button')) {
              btn.disabled = pending;
            }
          }
        },
        onError: (msg) => {
          if (passkeysErrorEl) passkeysErrorEl.textContent = msg;
        },
        onStatus: (msg) => {
          if (passkeysNoteEl) passkeysNoteEl.textContent = msg;
          if (passkeysErrorEl) passkeysErrorEl.textContent = '';
        },
      },
    });

    if (passkeysRegisterEl instanceof HTMLButtonElement) {
      const handler = () => {
        if (passkeysNoteEl) passkeysNoteEl.textContent = '';
        if (passkeysErrorEl) passkeysErrorEl.textContent = '';
        void passkeysCtrl?.registerPasskey();
      };
      passkeysRegisterEl.addEventListener('click', handler);
      passkeysUnbind = () => passkeysRegisterEl.removeEventListener('click', handler);
    }

    sessionsCtrl = new SessionsController({
      client,
      callbacks: {
        onSessions: (items) => {
          lastSessions = items;
          const active = activeSessions(items, Date.now());
          if (sessionsCountEl) sessionsCountEl.textContent = active.length > 0 ? `(${active.length})` : '';
          if (sessionsListEl) {
            renderSessions(
              sessionsListEl,
              items,
              (id) => void sessionsCtrl?.revokeSession(id),
              sessionsBusy,
              Date.now(),
              i18n,
            );
          }
        },
        onPending: (pending) => {
          sessionsBusy = pending;
          if (sessionsListEl) {
            for (const btn of sessionsListEl.querySelectorAll('button')) {
              btn.disabled = pending;
            }
          }
        },
        onError: (msg) => {
          if (sessionsErrorEl) sessionsErrorEl.textContent = msg;
        },
        onStatus: (msg) => {
          if (sessionsNoteEl) sessionsNoteEl.textContent = msg;
          if (sessionsErrorEl) sessionsErrorEl.textContent = '';
        },
      },
    });
  }

  const social = new SocialController({
    client,
    callbacks: {
      onConnections: (c) => {
        lastConnections = c;
        renderConnectionsView(c);
      },
      onRelationship: (r) => {
        lastRelationship = r;
        if (socialActionsEl) renderSocialActions(socialActionsEl, r, social, socialBusy, i18n, getOpenMessageFn());
      },
      onSelfSocial: (s) => {
        lastSelfSocial = s;
        if (socialSelfEl) socialSelfEl.hidden = s === null;
        if (s === null) return;
        renderSelfSocialView(s);
      },
      onBusy: (busy) => {
        socialBusy = busy;
        // Re-render only what carries controls, so a click cannot land twice.
        if (socialActionsEl) renderSocialActions(socialActionsEl, lastRelationship, social, busy, i18n, getOpenMessageFn());
        if (lastSelfSocial !== null && socialSelfEl && !socialSelfEl.hidden) {
          for (const el of [incomingEl, outgoingEl, blockedEl]) {
            if (!el) continue;
            for (const button of el.querySelectorAll('button')) button.disabled = busy;
          }
        }
      },
      onError: (msg) => {
        if (socialErrorEl) socialErrorEl.textContent = msg;
      },
    },
  });

  // Remembered so a later sign-in or sign-out can reload the region for the
  // new viewer. Without this the relationship is a snapshot of whoever was
  // signed in when the profile rendered: signing out would leave working
  // Follow/Block controls on screen, and signing in would show none at all,
  // until the visitor happened to navigate.
  let socialSubject: SocialPlayer | null = null;

  const getOpenMessageFn = (): (() => void) | undefined => {
    const viewerId = getCurrentSession()?.userId;
    const targetId = socialSubject?.id;
    if (!viewerId || !targetId || viewerId === targetId) return undefined;
    return () => {
      void (async () => {
        try {
          const conv = await client.messages.openWith(targetId);
          history.pushState(null, '', `/messages/${encodeURIComponent(conv.id)}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
        } catch (err) {
          if (socialErrorEl) socialErrorEl.textContent = err instanceof Error ? err.message : String(err);
        }
      })();
    };
  };

  const loadSocialFor = (player: SocialPlayer): void => {
    socialSubject = player;
    if (socialErrorEl) socialErrorEl.textContent = '';
    void social.load(player, getCurrentSession()?.userId ?? null);
  };

  const achievements = new AchievementsController({
    client,
    callbacks: {
      onAchievements: (items, summary) => {
        lastAchievements = { items, summary };
        if (achievementsCountEl) achievementsCountEl.textContent = summaryLabel(summary, items, i18n);
        if (achievementsListEl) renderAchievements(achievementsListEl, items, i18n);
        if (achievementsErrorEl) achievementsErrorEl.textContent = '';
        if (achievementsEl) achievementsEl.hidden = false;
      },
      onError: (msg) => {
        // Revealed on failure, unlike the unavailable case: a load that broke for this profile is
        // something the visitor can retry, so saying nothing would look like the player has none.
        if (achievementsErrorEl) achievementsErrorEl.textContent = msg;
        if (achievementsEl) achievementsEl.hidden = false;
      },
      onUnavailable: () => {
        if (achievementsEl) achievementsEl.hidden = true;
      },
    },
  });

  const loadAchievementsFor = (playerId: string): void => {
    achievements.reset();
    if (achievementsListEl) achievementsListEl.replaceChildren();
    if (achievementsCountEl) achievementsCountEl.textContent = '';
    if (achievementsErrorEl) achievementsErrorEl.textContent = '';
    void achievements.load(playerId);
  };

  const unsubLocale = i18n?.onLocaleChange(() => {
    if (lastProfile) renderProfileRatings(lastProfile);
    if (lastGames) renderProfileGames(lastGames);
    if (lastConnections) renderConnectionsView(lastConnections);
    if (lastRelationship && socialActionsEl) {
      renderSocialActions(socialActionsEl, lastRelationship, social, socialBusy, i18n, getOpenMessageFn());
    }
    if (lastSelfSocial) renderSelfSocialView(lastSelfSocial);
    if (lastAchievements) {
      if (achievementsCountEl) achievementsCountEl.textContent = summaryLabel(lastAchievements.summary, lastAchievements.items, i18n);
      if (achievementsListEl) renderAchievements(achievementsListEl, lastAchievements.items, i18n);
    }
    if (lastPasskeys && passkeysListEl) {
      renderPasskeys(passkeysListEl, lastPasskeys, (id) => void passkeysCtrl?.deletePasskey(id), passkeysBusy, i18n);
    }
    if (lastSessions && sessionsListEl) {
      renderSessions(sessionsListEl, lastSessions, (id) => void sessionsCtrl?.revokeSession(id), sessionsBusy, Date.now(), i18n);
    }
    if (!handle && getCurrentSession() === null && profileErrorEl && profileErrorEl.textContent) {
      profileErrorEl.textContent = i18n ? i18n.t('profile.signInToView') : 'Sign in to view your profile.';
    }
  });

  const profile = new ProfileController({
    client,
    onDispose: () => {
      unsubLocale?.();
    },
    callbacks: {
      onProfile: (p) => {
        lastProfile = p;
        if (handleEl) {
          handleEl.textContent = p.user.handle;
          applyAutoDirection(handleEl);
        }
        loadSocialFor({ id: p.user.id, handle: p.user.handle });
        // Keyed by id, not handle: both achievements routes take a player id, and this is the
        // first point on the page where one is known.
        loadAchievementsFor(p.user.id);
        renderProfileRatings(p);
      },
      onGames: (games) => {
        lastGames = games;
        renderProfileGames(games);
      },
      onError: (msg) => {
        if (profileErrorEl) profileErrorEl.textContent = msg;
      },
    },
  });

  let onSessionChange: (session: AuthSession | null) => void;

  if (handle) {
    void profile.load(handle);
    // Another player's profile: the page itself does not change when the
    // viewer's session does, but who they are to this player does — so the
    // social region reloads while the profile above it stays put.
    onSessionChange = () => {
      if (socialSubject !== null) loadSocialFor(socialSubject);
    };
  } else {
    // Session restoration rotates the httpOnly refresh cookie and is
    // asynchronous. Loading /users/me before it finishes produces a false
    // "no active session" error even though the header becomes signed-in a
    // moment later. Wait for the authenticated session, and also react when
    // a user signs in while already on this route.
    let loadedUserId: string | null = null;
    const clearSelfProfile = (): void => {
      lastProfile = null;
      lastGames = null;
      lastConnections = null;
      lastSelfSocial = null;
      lastAchievements = null;
      lastPasskeys = null;
      lastSessions = null;
      if (handleEl) handleEl.textContent = '';
      if (ratingsEl) ratingsEl.innerHTML = '';
      if (gamesEl) gamesEl.innerHTML = '';
      if (profileErrorEl) profileErrorEl.textContent = '';
      // Signing out must take the social region with it — leaving one
      // account's friends and blocked list on screen for the next visitor
      // would be a disclosure, not a stale render.
      social.reset();
      // Achievements are public, so a stale one is not a disclosure the way a friends list is —
      // but leaving the previous account's row of unlocks under a blank handle still reads as
      // the next visitor's, so it goes with the rest.
      achievements.reset();
      passkeysCtrl?.reset();
      sessionsCtrl?.reset();
      if (achievementsEl) achievementsEl.hidden = true;
      if (achievementsCountEl) achievementsCountEl.textContent = '';
      if (passkeysCountEl) passkeysCountEl.textContent = '';
      if (passkeysNoteEl) passkeysNoteEl.textContent = '';
      if (passkeysErrorEl) passkeysErrorEl.textContent = '';
      // A previous account's session list — its devices, IPs and last-seen times — must not survive
      // a sign-out on screen. Same disclosure argument as the friends list above, and stronger.
      if (sessionsCountEl) sessionsCountEl.textContent = '';
      if (sessionsNoteEl) sessionsNoteEl.textContent = '';
      if (sessionsErrorEl) sessionsErrorEl.textContent = '';
      if (passkeysSelfEl) passkeysSelfEl.hidden = true;
      for (const el of [socialActionsEl, followersEl, followingEl, incomingEl, outgoingEl, friendsEl, blockedEl, achievementsListEl, passkeysListEl, sessionsListEl]) {
        if (el) el.innerHTML = '';
      }
      for (const el of [followerCountEl, followingCountEl, friendCountEl, socialNoteEl, socialErrorEl]) {
        if (el) el.textContent = '';
      }
      if (socialSelfEl) socialSelfEl.hidden = true;
    };

    const handleSelfSessionChange = (session: AuthSession | null): void => {
      if (session === null) {
        loadedUserId = null;
        profile.reset();
        clearSelfProfile();
        if (profileErrorEl) profileErrorEl.textContent = i18n ? i18n.t('profile.signInToView') : 'Sign in to view your profile.';
        return;
      }

      if (session.userId === loadedUserId) return;

      loadedUserId = session.userId;
      profile.reset();
      clearSelfProfile();
      void profile.loadSelf();
      if (passkeysSelfEl) passkeysSelfEl.hidden = false;
      void passkeysCtrl?.load();
      void sessionsCtrl?.load();
    };

    onSessionChange = handleSelfSessionChange;

    const initialSession = getCurrentSession();
    if (initialSession !== null) {
      handleSelfSessionChange(initialSession);
    } else {
      void restorePromise.then(handleSelfSessionChange);
    }
  }

  const passkeys = passkeysCtrl
    ? {
        dispose: (): void => {
          passkeysUnbind();
          passkeysCtrl?.dispose();
          // Both account-security controllers are created together on the self-profile and share
          // this one disposal, so neither can be left running when the route goes.
          sessionsCtrl?.dispose();
        },
      }
    : null;

  return {
    profile,
    passkeys,
    onSessionChange,
  };
}
