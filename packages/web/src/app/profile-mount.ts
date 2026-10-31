import type { GambitClient } from '../api/client.js';
import { VARIANTS } from '../api/models.js';
import type { GameSummary, PlayerAchievement, SocialPlayer, UserProfile, Variant } from '../api/models.js';
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
import { applyAutoDirection, applyLtrIsolation, createLtrElement } from '../i18n/bidi.js';
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
  i18n: I18nManager,
  onOpenMessage?: () => void,
): void {
  container.innerHTML = '';
  if (relationship === null) return;

  const actions: RowAction[] = [];

  if (relationship.blocked) {
    // A block supersedes everything else, so offering follow or friend controls
    // beside it would advertise actions the server will refuse.
    actions.push({
      label: i18n.t('profile.social.unblock'),
      run: () => void social.unblockSubject(),
    });
  } else {
    actions.push(
      relationship.following
        ? {
            label: i18n.t('profile.social.unfollow'),
            run: () => void social.unfollow(),
          }
        : {
            label: i18n.t('profile.social.follow'),
            run: () => void social.follow(),
          },
    );

    if (onOpenMessage) {
      actions.push({
        label: i18n.t('profile.social.message'),
        run: onOpenMessage,
        communicative: true,
      });
    }

    if (relationship.incomingRequestId !== null) {
      const id = relationship.incomingRequestId;
      actions.push(
        {
          label: i18n.t('profile.social.acceptFriend'),
          run: () => void social.respond(id, 'accept'),
        },
        {
          label: i18n.t('profile.social.declineFriend'),
          run: () => void social.respond(id, 'decline'),
        },
      );
    } else if (relationship.outgoingRequestId !== null) {
      const id = relationship.outgoingRequestId;
      actions.push({
        label: i18n.t('profile.social.cancelFriend'),
        run: () => void social.respond(id, 'cancel'),
      });
    } else {
      actions.push({
        label: i18n.t('profile.social.addFriend'),
        run: () => void social.sendFriendRequest(),
      });
    }

    actions.push({
      label: i18n.t('profile.social.block'),
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
  readonly i18n: I18nManager;
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

  let routeActive = true;

  const handleEl = doc.getElementById('profile-handle');
  const ratingsEl = doc.getElementById('profile-ratings');
  const gamesEl = doc.getElementById('profile-games');
  const filterHostEl = doc.getElementById('profile-games-filter');
  const profileErrorEl = doc.getElementById('profile-error');

  if (gamesEl) gamesEl.innerHTML = '';

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
  let lastSubjectId: string | null = null;
  const isVariant = (val: string): val is Variant => (VARIANTS as readonly string[]).includes(val);
  let selectedVariant: Variant | 'all' = 'all';
  let filterSelectEl: HTMLSelectElement | null = null;
  let filterLabelEl: HTMLLabelElement | null = null;
  let filterResetEl: HTMLButtonElement | null = null;
  let filterHelpEl: HTMLElement | null = null;
  let filterStatusEl: HTMLElement | null = null;
  let filterAnnouncementEl: HTMLElement | null = null;
  let lastAnnouncedMessage: string | null = null;
  let hasAnnounced = false;
  let optionNodes: { opt: HTMLOptionElement; value: Variant | 'all' }[] = [];

  const clearAnnouncement = (): void => {
    if (filterAnnouncementEl && filterAnnouncementEl.textContent !== '') {
      filterAnnouncementEl.textContent = '';
    }
    lastAnnouncedMessage = null;
    hasAnnounced = false;
  };

  const announceFilter = (): void => {
    if (!routeActive || !filterAnnouncementEl || lastGames === null || lastGames.length === 0) return;
    const visibleCount = selectedVariant === 'all'
      ? lastGames.length
      : lastGames.filter((g) => g.variant === selectedVariant).length;
    const variantName = selectedVariant === 'all'
      ? i18n.t('profile.games.allVariants')
      : getVariantLabel(selectedVariant, i18n);
    const statusText = i18n.t('profile.games.filterStatus', { shown: visibleCount, total: lastGames.length });
    const message = `${variantName}: ${statusText}`;
    if (message === lastAnnouncedMessage) return;
    lastAnnouncedMessage = message;
    hasAnnounced = true;
    filterAnnouncementEl.textContent = message;
  };

  const updateStatus = (shown: number, total: number): void => {
    if (!filterStatusEl) return;
    if (lastGames === null || total === 0) {
      filterStatusEl.textContent = '';
      return;
    }
    filterStatusEl.textContent = i18n.t('profile.games.filterStatus', { shown, total });
  };

  const updateFilterLocale = (): void => {
    if (filterLabelEl) filterLabelEl.textContent = i18n.t('profile.games.filterLabel');
    if (filterResetEl) filterResetEl.textContent = i18n.t('profile.games.resetFilter');
    if (filterHelpEl) filterHelpEl.textContent = i18n.t('profile.games.filterScope');
    for (const entry of optionNodes) {
      if (entry.value === 'all') {
        entry.opt.textContent = i18n.t('profile.games.allVariants');
      } else {
        entry.opt.textContent = getVariantLabel(entry.value, i18n);
      }
    }
    if (lastGames !== null) {
      const visibleCount = selectedVariant === 'all'
        ? lastGames.length
        : lastGames.filter((g) => g.variant === selectedVariant).length;
      updateStatus(visibleCount, lastGames.length);
    }
    if (hasAnnounced) {
      announceFilter();
    }
  };

  const onFilterChange = (): void => {
    if (!routeActive || !filterSelectEl) return;
    const rawVal = filterSelectEl.value;
    let nextVariant: Variant | 'all';
    if (rawVal === 'all') {
      nextVariant = 'all';
    } else if (isVariant(rawVal)) {
      nextVariant = rawVal;
    } else {
      filterSelectEl.value = selectedVariant;
      return;
    }
    if (nextVariant === selectedVariant) return;
    selectedVariant = nextVariant;
    if (filterResetEl) filterResetEl.disabled = selectedVariant === 'all';
    if (lastGames !== null) {
      renderProfileGames(lastGames);
      announceFilter();
    }
  };

  const onResetClick = (): void => {
    if (!routeActive || selectedVariant === 'all') return;
    const wasResetFocused = doc.activeElement === filterResetEl;
    selectedVariant = 'all';
    if (filterSelectEl) filterSelectEl.value = 'all';
    if (filterResetEl) filterResetEl.disabled = true;
    if (wasResetFocused && filterSelectEl) {
      filterSelectEl.focus();
    }
    if (lastGames !== null) {
      renderProfileGames(lastGames);
      announceFilter();
    }
  };

  const mountFilterControls = (): void => {
    if (!filterHostEl) return;
    filterHostEl.innerHTML = '';
    optionNodes = [];

    const label = doc.createElement('label') as HTMLLabelElement;
    label.setAttribute('for', 'profile-games-variant');
    label.className = 'profile-games-filter-label';
    label.textContent = i18n.t('profile.games.filterLabel');
    filterLabelEl = label;

    const select = doc.createElement('select') as HTMLSelectElement;
    select.id = 'profile-games-variant';
    select.className = 'profile-games-variant';
    select.setAttribute('aria-describedby', 'profile-games-filter-help');

    const allOpt = doc.createElement('option') as HTMLOptionElement;
    allOpt.value = 'all';
    allOpt.textContent = i18n.t('profile.games.allVariants');
    select.appendChild(allOpt);
    optionNodes.push({ opt: allOpt, value: 'all' });

    for (const v of VARIANTS) {
      const opt = doc.createElement('option') as HTMLOptionElement;
      opt.value = v;
      opt.textContent = getVariantLabel(v, i18n);
      select.appendChild(opt);
      optionNodes.push({ opt, value: v });
    }
    select.value = selectedVariant;
    select.addEventListener('change', onFilterChange);
    filterSelectEl = select;

    const resetBtn = doc.createElement('button') as HTMLButtonElement;
    resetBtn.type = 'button';
    resetBtn.className = 'profile-games-filter-reset';
    resetBtn.id = 'profile-games-filter-reset';
    resetBtn.textContent = i18n.t('profile.games.resetFilter');
    resetBtn.disabled = selectedVariant === 'all';
    resetBtn.addEventListener('click', onResetClick);
    filterResetEl = resetBtn;

    const help = doc.createElement('span');
    help.className = 'profile-games-filter-help';
    help.id = 'profile-games-filter-help';
    help.textContent = i18n.t('profile.games.filterScope');
    filterHelpEl = help;

    const status = doc.createElement('span');
    status.className = 'profile-games-filter-status';
    status.id = 'profile-games-filter-status';
    filterStatusEl = status;

    const announcement = doc.createElement('span');
    announcement.className = 'sr-only profile-games-filter-announcement';
    announcement.setAttribute('role', 'status');
    announcement.setAttribute('aria-live', 'polite');
    filterAnnouncementEl = announcement;

    filterHostEl.append(label, select, resetBtn, help, status, announcement);
  };

  mountFilterControls();

  const renderProfileRatings = (p: UserProfile): void => {
    if (!ratingsEl) return;
    if (p.ratings.length === 0) {
      renderEmpty(ratingsEl, {
        title: i18n.t('profile.ratings.emptyTitle'),
        body: i18n.t('profile.ratings.emptyBody'),
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

    const activeNode = doc.activeElement;
    let focusedGameId: string | null = null;
    let focusedIndex = -1;
    const isFocusInsideGames = Boolean(activeNode && gamesEl.contains(activeNode));

    if (isFocusInsideGames) {
      const rows = gamesEl.querySelectorAll<HTMLAnchorElement>('a.game-row');
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row && (row === activeNode || row.contains(activeNode))) {
          focusedIndex = i;
          focusedGameId = row.getAttribute('data-game-id');
          break;
        }
      }
    }

    if (games.length === 0) {
      updateStatus(0, 0);
      if (filterResetEl) filterResetEl.disabled = selectedVariant === 'all';
      renderEmpty(gamesEl, {
        mark: '♞',
        title: i18n.t('profile.games.emptyTitle'),
        body: i18n.t('profile.games.emptyBody'),
        cta: {
          label: i18n.t('profile.games.findGame'),
          href: '/',
          route: 'lobby',
        },
      });
      if (isFocusInsideGames && filterSelectEl) {
        filterSelectEl.focus();
      }
      return;
    }

    const visibleGames = selectedVariant === 'all'
      ? games
      : games.filter((g) => g.variant === selectedVariant);

    updateStatus(visibleGames.length, games.length);
    if (filterResetEl) filterResetEl.disabled = selectedVariant === 'all';

    gamesEl.innerHTML = '';
    if (visibleGames.length === 0) {
      renderEmpty(gamesEl, {
        title: i18n.t('profile.games.filterEmptyTitle'),
        body: i18n.t('profile.games.filterEmptyBody'),
        inline: true,
      });
      if (isFocusInsideGames && filterSelectEl) {
        filterSelectEl.focus();
      }
      return;
    }

    for (const g of visibleGames) {
        const row = doc.createElement('a');
        row.className = 'game-row';
        row.setAttribute('data-game-id', g.id);
        row.setAttribute('href', `/game/${encodeURIComponent(g.id)}`);
        row.setAttribute('data-route', 'game');
        const variantStr = getVariantLabel(g.variant, i18n);
        const speedStr = getSpeedLabel(g.speed, i18n);
        const resultStr = g.result ?? i18n.t('profile.games.ongoing');
        const plyStr = i18n.t('profile.games.plyCount', { count: g.plyCount });
        row.append(`${variantStr} · ${speedStr} · `);
        if (g.result) row.append(createLtrElement(doc, 'bdi', resultStr));
        else row.append(resultStr);
        row.append(` · ${plyStr}`);
        gamesEl.appendChild(row);
      }

    if (isFocusInsideGames) {
      const newRows = gamesEl.querySelectorAll<HTMLAnchorElement>('a.game-row');
      let targetToFocus: HTMLAnchorElement | null = null;
      if (focusedGameId !== null) {
        for (let i = 0; i < visibleGames.length; i++) {
          if (visibleGames[i]?.id === focusedGameId) {
            targetToFocus = newRows[i] ?? null;
            break;
          }
        }
      }
      if (!targetToFocus && focusedIndex >= 0 && newRows.length > 0) {
        const targetIndex = Math.min(focusedIndex, newRows.length - 1);
        targetToFocus = newRows[targetIndex] ?? null;
      }
      if (targetToFocus) {
        targetToFocus.focus();
      } else if (filterSelectEl) {
        filterSelectEl.focus();
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
          title: i18n.t('profile.social.emptyFollowersTitle'),
          body: i18n.t('profile.social.emptyFollowersBody'),
        },
        socialBusy,
      );
    }
    if (followingEl) {
      renderPlayerList(
        followingEl,
        c.following,
        {
          title: i18n.t('profile.social.emptyFollowingTitle'),
          body: i18n.t('profile.social.emptyFollowingBody'),
        },
        socialBusy,
      );
    }
    if (socialNoteEl) {
      socialNoteEl.textContent = c.named
        ? ''
        : i18n.t('profile.social.noteNoNames');
    }
  };

  const renderSelfSocialView = (s: SelfSocial): void => {
    if (socialSelfEl) socialSelfEl.hidden = false;
    if (incomingEl) {
      incomingEl.innerHTML = '';
      if (s.incoming.length === 0) {
        renderEmpty(incomingEl, {
          title: i18n.t('profile.social.emptyIncomingTitle'),
          body: i18n.t('profile.social.emptyIncomingBody'),
          inline: true,
        });
      } else {
        for (const { request, player } of s.incoming) {
          appendPanelRow(
            incomingEl,
            player.handle,
            [
              {
                label: i18n.t('profile.social.accept'),
                run: () => void social.respond(request.id, 'accept'),
              },
              {
                label: i18n.t('profile.social.decline'),
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
          title: i18n.t('profile.social.emptyOutgoingTitle'),
          body: i18n.t('profile.social.emptyOutgoingBody'),
          inline: true,
        });
      } else {
        for (const { request, player } of s.outgoing) {
          appendPanelRow(
            outgoingEl,
            player.handle,
            [{
              label: i18n.t('profile.social.cancel'),
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
          title: i18n.t('profile.social.emptyFriendsTitle'),
          body: i18n.t('profile.social.emptyFriendsBody'),
        },
        socialBusy,
      );
    }
    if (blockedEl) {
      renderPlayerList(
        blockedEl,
        s.blocked,
        {
          title: i18n.t('profile.social.emptyBlockedTitle'),
          body: i18n.t('profile.social.emptyBlockedBody'),
        },
        socialBusy,
        (player) => [{
          label: i18n.t('profile.social.unblock'),
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

  const unsubLocale = i18n.onLocaleChange(() => {
    if (!routeActive) return;
    updateFilterLocale();
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
      profileErrorEl.textContent = i18n.t('profile.signInToView');
    }
  });

  const profile = new ProfileController({
    client,
    onDispose: () => {
      if (!routeActive) return;
      routeActive = false;
      clearAnnouncement();
      if (filterSelectEl) {
        filterSelectEl.removeEventListener('change', onFilterChange);
        filterSelectEl = null;
      }
      if (filterResetEl) {
        filterResetEl.removeEventListener('click', onResetClick);
        filterResetEl = null;
      }
      filterLabelEl = null;
      filterHelpEl = null;
      filterStatusEl = null;
      filterAnnouncementEl = null;
      optionNodes = [];
      if (filterHostEl) {
        filterHostEl.innerHTML = '';
      }
      unsubLocale();
    },
    callbacks: {
      onProfile: (p) => {
        if (!routeActive) return;
        if (lastSubjectId !== null && lastSubjectId !== p.user.id) {
          const activeNode = doc.activeElement;
          const shouldRecoverFocus = Boolean(
            activeNode && ((gamesEl && gamesEl.contains(activeNode)) || activeNode === filterResetEl),
          );
          lastGames = null;
          selectedVariant = 'all';
          if (filterSelectEl) filterSelectEl.value = 'all';
          if (filterResetEl) filterResetEl.disabled = true;
          updateStatus(0, 0);
          clearAnnouncement();
          if (gamesEl) gamesEl.innerHTML = '';
          if (shouldRecoverFocus && filterSelectEl) {
            filterSelectEl.focus();
          }
        }
        lastSubjectId = p.user.id;
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
        if (!routeActive) return;
        lastGames = games;
        if (games.length === 0) {
          clearAnnouncement();
        }
        renderProfileGames(games);
      },
      onError: (msg) => {
        if (!routeActive) return;
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
      if (!routeActive) return;
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
      const activeNode = doc.activeElement;
      const shouldRecoverFocus = Boolean(
        activeNode && ((gamesEl && gamesEl.contains(activeNode)) || activeNode === filterResetEl),
      );
      lastProfile = null;
      lastSubjectId = null;
      lastGames = null;
      selectedVariant = 'all';
      if (filterSelectEl) filterSelectEl.value = 'all';
      if (filterResetEl) filterResetEl.disabled = true;
      updateStatus(0, 0);
      clearAnnouncement();
      lastConnections = null;
      lastSelfSocial = null;
      lastAchievements = null;
      lastPasskeys = null;
      lastSessions = null;
      if (handleEl) handleEl.textContent = '';
      if (ratingsEl) ratingsEl.innerHTML = '';
      if (gamesEl) gamesEl.innerHTML = '';
      if (profileErrorEl) profileErrorEl.textContent = '';
      if (shouldRecoverFocus && filterSelectEl) {
        filterSelectEl.focus();
      }
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
      if (!routeActive) return;
      if (session === null) {
        loadedUserId = null;
        profile.reset();
        clearSelfProfile();
        if (profileErrorEl) profileErrorEl.textContent = i18n.t('profile.signInToView');
        return;
      }

      if (session.userId === loadedUserId) return;

      const wasInitial = loadedUserId === null;
      const preservedVariant = selectedVariant;
      loadedUserId = session.userId;
      profile.reset();
      clearSelfProfile();
      if (wasInitial) {
        selectedVariant = preservedVariant;
        if (filterSelectEl) filterSelectEl.value = preservedVariant;
        if (filterResetEl) filterResetEl.disabled = preservedVariant === 'all';
      }
      void profile.loadSelf();
      if (passkeysSelfEl) passkeysSelfEl.hidden = false;
      void passkeysCtrl?.load();
      void sessionsCtrl?.load();
    };

    onSessionChange = (session: AuthSession | null): void => {
      if (!routeActive) return;
      handleSelfSessionChange(session);
    };

    const initialSession = getCurrentSession();
    if (initialSession !== null) {
      handleSelfSessionChange(initialSession);
    } else {
      void restorePromise.then((session) => {
        if (!routeActive) return;
        handleSelfSessionChange(session);
      });
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
