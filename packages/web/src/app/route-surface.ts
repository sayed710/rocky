import type { Route } from './router.js';

// A new route must make an explicit visibility decision before TypeScript will compile it.
const ROUTE_SURFACE_IDS: Readonly<Record<Route['name'], string | null>> = {
  lobby: 'lobby',
  game: 'game-main',
  profile: 'profile',
  leaderboard: 'leaderboard',
  tournaments: 'tournaments',
  tournament: 'tournament',
  search: 'search',
  messages: 'messages',
  conversation: 'conversation',
  teams: 'teams',
  team: 'team',
  forum: 'forum',
  thread: 'thread',
  courses: 'courses',
  course: 'course',
  lesson: 'lesson',
  endgames: 'endgames',
  studies: 'studies',
  study: 'study',
  'study-chapter': 'study-chapter',
  'password-reset': 'password-reset',
  'email-verify': 'email-verify',
  'not-found': 'not-found',
};

const GAME_ONLY_CONTROL_IDS = ['flip', 'skip-board'] as const;

/**
 * Applies the appropriate visibility surface for the current route.
 *
 * @param doc - The document object to manipulate.
 * @param route - The active route to apply.
 */
export function applyRouteSurface(doc: Document, route: Route): void {
  const activeSurfaceId = ROUTE_SURFACE_IDS[route.name];
  const isGameRoute = route.name === 'game';
  doc.body.classList.toggle('route-game', isGameRoute);

  for (const surfaceId of Object.values(ROUTE_SURFACE_IDS)) {
    if (surfaceId === null) continue;
    const surface = doc.getElementById(surfaceId);
    if (surface) surface.hidden = surfaceId !== activeSurfaceId;
  }

  for (const controlId of GAME_ONLY_CONTROL_IDS) {
    const control = doc.getElementById(controlId);
    if (control) control.hidden = !isGameRoute;
  }
}
