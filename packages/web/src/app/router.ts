/**
 * Client-side router — a pure, DOM-free path matcher for the Rookzen SPA.
 *
 * Parses the URL pathname into a typed route, and provides a `navigate`
 * function that updates the URL via `history.pushState` (injectable for
 * tests). The router does not touch the DOM; the bootstrap layer reads the
 * route and mounts the appropriate view.
 *
 * Supported routes:
 * - `/` → lobby
 * - `/game/{id}` → game view
 * - `/profile` → profile (future)
 * - `/profile/{handle}` → profile for a specific user (future)
 * - `/leaderboard` → variant leaderboard
 * - `/tournaments` → tournaments list
 * - `/tournaments/{id}` → tournament detail
 * - `/search` → search
 * - `/password-reset` → password recovery form (optional ?token=...)
 * - `/email-verify` → email verification (optional ?token=...)
 */

export type Route =
  | { readonly name: 'lobby' }
  | { readonly name: 'game'; readonly gameId: string }
  | { readonly name: 'profile'; readonly handle: string | null }
  | { readonly name: 'leaderboard' }
  | { readonly name: 'tournaments' }
  | { readonly name: 'tournament'; readonly id: string }
  | { readonly name: 'search' }
  | { readonly name: 'messages' }
  | { readonly name: 'conversation'; readonly id: string }
  | { readonly name: 'teams' }
  | { readonly name: 'team'; readonly slug: string }
  | { readonly name: 'forum'; readonly slug: string }
  | { readonly name: 'thread'; readonly slug: string; readonly threadId: string }
  | { readonly name: 'courses' }
  | { readonly name: 'course'; readonly slug: string }
  | { readonly name: 'lesson'; readonly id: string }
  | { readonly name: 'endgames' }
  | { readonly name: 'studies' }
  | { readonly name: 'study'; readonly id: string }
  | { readonly name: 'study-chapter'; readonly id: string; readonly chapterId: string }
  | { readonly name: 'password-reset' }
  | { readonly name: 'email-verify' }
  | { readonly name: 'not-found' };

/** Parse a URL pathname into a typed route. */
export function parseRoute(pathname: string): Route {
  const [pathOnly] = pathname.split('?');
  const segments = (pathOnly ?? '').split('/').filter(Boolean);
  if (segments.length === 0) return { name: 'lobby' };
  if (segments[0] === 'game') {
    return segments.length === 2
      ? { name: 'game', gameId: segments[1]! }
      : { name: 'not-found' };
  }
  if (segments[0] === 'profile') {
    if (segments.length === 1) return { name: 'profile', handle: null };
    return segments.length === 2
      ? { name: 'profile', handle: segments[1]! }
      : { name: 'not-found' };
  }
  if (segments[0] === 'password-reset') {
    return segments.length === 1 ? { name: 'password-reset' } : { name: 'not-found' };
  }
  if (segments[0] === 'email-verify') {
    return segments.length === 1 ? { name: 'email-verify' } : { name: 'not-found' };
  }
  if (segments[0] === 'leaderboard') {
    if (segments.length === 1) return { name: 'leaderboard' };
    return { name: 'not-found' };
  }
  if (segments[0] === 'tournaments') {
    if (segments.length === 1) return { name: 'tournaments' };
    return segments.length === 2
      ? { name: 'tournament', id: decodeSegment(segments[1]!) }
      : { name: 'not-found' };
  }
  if (segments[0] === 'search') {
    return segments.length === 1 ? { name: 'search' } : { name: 'not-found' };
  }
  if (segments[0] === 'messages') {
    if (segments.length === 1) return { name: 'messages' };
    return segments.length === 2
      ? { name: 'conversation', id: decodeSegment(segments[1]!) }
      : { name: 'not-found' };
  }
  if (segments[0] === 'courses') {
    if (segments.length === 1) return { name: 'courses' };
    return segments.length === 2
      ? { name: 'course', slug: decodeSegment(segments[1]!) }
      : { name: 'not-found' };
  }
  if (segments[0] === 'endgames') {
    return segments.length === 1 ? { name: 'endgames' } : { name: 'not-found' };
  }
  if (segments[0] === 'lessons') {
    if (segments.length === 2) {
      return { name: 'lesson', id: decodeSegment(segments[1]!) };
    }
    return { name: 'not-found' };
  }
  if (segments[0] === 'studies') {
    if (segments.length === 1) return { name: 'studies' };
    const id = decodeSegment(segments[1]!);
    if (segments.length === 2) return { name: 'study', id };
    if (segments.length === 4 && segments[2] === 'chapters') {
      return { name: 'study-chapter', id, chapterId: decodeSegment(segments[3]!) };
    }
    return { name: 'not-found' };
  }
  if (segments[0] === 'teams') {
    if (segments.length === 1) return { name: 'teams' };
    const slug = decodeSegment(segments[1]!);
    if (segments.length === 2) return { name: 'team', slug };
    // The forum is nested under its team, mirroring the API. Anything else under a team slug is
    // not a route we serve — say so rather than falling through to the team page.
    if (segments[2] === 'forum') {
      if (segments.length === 3) return { name: 'forum', slug };
      if (segments.length === 4) return { name: 'thread', slug, threadId: decodeSegment(segments[3]!) };
    }
    return { name: 'not-found' };
  }
  return { name: 'not-found' };
}

/** Decode a single path segment, tolerating malformed input. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Serialize a route back to a URL pathname. */
export function routeToPath(route: Route): string {
  switch (route.name) {
    case 'lobby':
      return '/';
    case 'game':
      return `/game/${route.gameId}`;
    case 'profile':
      return route.handle !== null ? `/profile/${route.handle}` : '/profile';
    case 'leaderboard':
      return '/leaderboard';
    case 'tournaments':
      return '/tournaments';
    case 'tournament':
      return `/tournaments/${route.id}`;
    case 'search':
      return '/search';
    case 'messages':
      return '/messages';
    case 'conversation':
      return `/messages/${route.id}`;
    case 'teams':
      return '/teams';
    case 'team':
      return `/teams/${route.slug}`;
    case 'forum':
      return `/teams/${route.slug}/forum`;
    case 'thread':
      return `/teams/${route.slug}/forum/${route.threadId}`;
    case 'courses':
      return '/courses';
    case 'course':
      return `/courses/${route.slug}`;
    case 'lesson':
      return `/lessons/${route.id}`;
    case 'endgames':
      return '/endgames';
    case 'studies':
      return '/studies';
    case 'study':
      return `/studies/${route.id}`;
    case 'study-chapter':
      return `/studies/${route.id}/chapters/${route.chapterId}`;
    case 'password-reset':
      return '/password-reset';
    case 'email-verify':
      return '/email-verify';
    case 'not-found':
      return '/not-found';
  }
}

/** Injectable history-like seam (for tests). */
export interface HistoryLike {
  pushState(data: unknown, title: string, url: string): void;
}

/** Navigate to a route by updating the URL. */
export function navigate(route: Route, hist?: HistoryLike): void {
  const path = routeToPath(route);
  const h = hist ?? (typeof globalThis !== 'undefined' && typeof globalThis.history !== 'undefined'
    ? (globalThis.history as unknown as HistoryLike)
    : undefined);
  h?.pushState(null, '', path);
}
