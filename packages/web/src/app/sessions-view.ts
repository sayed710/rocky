/**
 * DOM rendering for the active-sessions section of the account-security panel.
 *
 * Uses the shared `.panel-list`/`.panel-row` composition and `renderEmpty`, exactly as the passkeys
 * section beside it does. No new visual language: this is a list of rows with one trailing action,
 * which the system already has a treatment for.
 */
import type { SessionView } from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';
import { appendPanelRow, renderEmpty } from './render-helpers.js';

/**
 * A session the user can still act on: not revoked, not past its expiry.
 *
 * `GET /v1/auth/sessions` returns the user's whole session history, including revoked and expired
 * rows. Listing those under a heading that says "Active" would be false, and a revoked row with a
 * disabled Revoke button is the "control that can never enable" DESIGN.md rules out. Filtering also
 * gives revocation its feedback: the row leaves the list.
 */
export function activeSessions(sessions: readonly SessionView[], now: number): SessionView[] {
  return sessions.filter((s) => {
    if (s.revokedAt !== null) return false;
    const expires = Date.parse(s.expiresAt);
    return Number.isNaN(expires) || expires > now;
  });
}

/**
 * A short, human-readable hint at which device a session belongs to.
 *
 * Deliberately crude, and used for display only — never for any decision. The point is to let
 * someone notice "there is a Linux session and I only own a Windows machine"; getting the browser
 * minor version right is worth nothing here. Anything unrecognised reads as "Unknown device" rather
 * than dumping a 120-character user-agent string into a row built for one line.
 */
export function describeDevice(userAgent: string | null, i18n?: I18nManager): string {
  if (!userAgent) return i18n ? i18n.t('profile.sessions.unknownDevice') : 'Unknown device';
  const browser =
    /\bEdg\//.test(userAgent) ? 'Edge'
      : /\bOPR\//.test(userAgent) ? 'Opera'
      : /\bFirefox\//.test(userAgent) ? 'Firefox'
      : /\bChrome\//.test(userAgent) ? 'Chrome'
      : /\bSafari\//.test(userAgent) ? 'Safari'
      : null;
  const platform =
    /\bAndroid\b/.test(userAgent) ? 'Android'
      : /\b(iPhone|iPad|iOS)\b/.test(userAgent) ? 'iOS'
      : /\bWindows\b/.test(userAgent) ? 'Windows'
      : /\bMac OS X\b/.test(userAgent) ? 'macOS'
      : /\bLinux\b/.test(userAgent) ? 'Linux'
      : null;

  if (browser && platform) {
    return i18n ? i18n.t('profile.sessions.deviceOnPlatform', { browser, platform }) : `${browser} on ${platform}`;
  }
  return browser ?? platform ?? (i18n ? i18n.t('profile.sessions.unknownDevice') : 'Unknown device');
}

/** `2026-08-16` from an ISO timestamp; the raw value if it is not parseable. */
function isoDate(value: string | null): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

export function renderSessions(
  container: HTMLElement,
  sessions: readonly SessionView[],
  onRevoke: (id: string) => void,
  busy: boolean,
  now: number = Date.now(),
  i18n?: I18nManager,
): void {
  container.innerHTML = '';

  const active = activeSessions(sessions, now);
  if (active.length === 0) {
    renderEmpty(container, {
      title: i18n ? i18n.t('profile.sessions.emptyTitle') : 'No other active sessions',
      body: i18n ? i18n.t('profile.sessions.emptyBody') : 'Signing in on another browser or device will list it here.',
      inline: true,
    });
    return;
  }

  for (const session of active) {
    // One line, most identifying part first: what device, then where from, then when it was last
    // used. Any of the three can legitimately be absent, so none of them may leave a stray
    // separator behind when it is.
    //
    // Each part falls back to what the session was *created* with, because nothing on the server
    // writes the `last*` fields — reading only those would render every row as a bare
    // "Unknown device" and leave the user nothing to tell their sessions apart by. `createdAt` is
    // the honest last-seen time regardless: every refresh rotates the session, so an active row was
    // created the last time that browser was actually here.
    const lastSeen = isoDate(session.lastSeenAt) ?? isoDate(session.createdAt);
    const lastSeenStr = lastSeen ? (i18n ? i18n.t('profile.sessions.lastSeen', { date: lastSeen }) : `last seen ${lastSeen}`) : null;
    const parts = [
      describeDevice(session.lastUserAgent ?? session.createdUserAgent, i18n),
      session.lastIp ?? session.createdIp,
      lastSeenStr,
    ].filter((part): part is string => Boolean(part));

    const revokeLabel = i18n ? i18n.t('profile.sessions.revoke') : 'Revoke';
    appendPanelRow(
      container,
      parts.join(' · '),
      [{ label: revokeLabel, run: () => onRevoke(session.id) }],
      busy,
    );
  }
}
