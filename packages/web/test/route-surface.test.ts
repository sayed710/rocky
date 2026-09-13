import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRouteSurface } from '../src/app/route-surface.js';
import type { Route } from '../src/app/router.js';

const SURFACE_IDS = [
  'lobby',
  'game-main',
  'endgames',
  'profile',
  'leaderboard',
  'tournaments',
  'tournament',
  'search',
  'messages',
  'conversation',
  'teams',
  'team',
  'forum',
  'thread',
  'courses',
  'course',
  'lesson',
  'studies',
  'study',
  'study-chapter',
  'password-reset',
  'email-verify',
  'not-found',
] as const;

interface RouteCase {
  readonly route: Route;
  readonly activeSurfaceId: string | null;
}

const ROUTE_CASES: Readonly<Record<Route['name'], RouteCase>> = {
  lobby: { route: { name: 'lobby' }, activeSurfaceId: 'lobby' },
  game: { route: { name: 'game', gameId: 'g1' }, activeSurfaceId: 'game-main' },
  profile: { route: { name: 'profile', handle: null }, activeSurfaceId: 'profile' },
  leaderboard: { route: { name: 'leaderboard' }, activeSurfaceId: 'leaderboard' },
  tournaments: { route: { name: 'tournaments' }, activeSurfaceId: 'tournaments' },
  tournament: { route: { name: 'tournament', id: 't1' }, activeSurfaceId: 'tournament' },
  search: { route: { name: 'search' }, activeSurfaceId: 'search' },
  messages: { route: { name: 'messages' }, activeSurfaceId: 'messages' },
  conversation: { route: { name: 'conversation', id: 'c1' }, activeSurfaceId: 'conversation' },
  teams: { route: { name: 'teams' }, activeSurfaceId: 'teams' },
  team: { route: { name: 'team', slug: 'city-chess' }, activeSurfaceId: 'team' },
  forum: { route: { name: 'forum', slug: 'city-chess' }, activeSurfaceId: 'forum' },
  thread: {
    route: { name: 'thread', slug: 'city-chess', threadId: 'th1' },
    activeSurfaceId: 'thread',
  },
  courses: { route: { name: 'courses' }, activeSurfaceId: 'courses' },
  endgames: { route: { name: 'endgames' }, activeSurfaceId: 'endgames' },
  course: { route: { name: 'course', slug: 'openings' }, activeSurfaceId: 'course' },
  lesson: { route: { name: 'lesson', id: 'l1' }, activeSurfaceId: 'lesson' },
  studies: { route: { name: 'studies' }, activeSurfaceId: 'studies' },
  study: { route: { name: 'study', id: 's1' }, activeSurfaceId: 'study' },
  'study-chapter': {
    route: { name: 'study-chapter', id: 's1', chapterId: 'ch1' },
    activeSurfaceId: 'study-chapter',
  },
  'password-reset': { route: { name: 'password-reset' }, activeSurfaceId: 'password-reset' },
  'email-verify': { route: { name: 'email-verify' }, activeSurfaceId: 'email-verify' },
  'not-found': { route: { name: 'not-found' }, activeSurfaceId: 'not-found' },
};

interface SurfaceDocument {
  readonly doc: Document;
  readonly elements: ReadonlyMap<string, { hidden: boolean }>;
  readonly bodyClasses: ReadonlySet<string>;
}

function createSurfaceDocument(): SurfaceDocument {
  const elements = new Map<string, { hidden: boolean }>();
  for (const id of [...SURFACE_IDS, 'flip', 'skip-board']) {
    elements.set(id, { hidden: false });
  }
  const bodyClasses = new Set<string>();
  const doc = {
    getElementById: (id: string) => elements.get(id) ?? null,
    body: {
      classList: {
        toggle: (name: string, force: boolean) => {
          if (force) bodyClasses.add(name);
          else bodyClasses.delete(name);
          return force;
        },
      },
    },
  } as unknown as Document;
  return { doc, elements, bodyClasses };
}

test('every route shows only its top-level surface and exposes game controls only for games', () => {
  for (const [routeName, routeCase] of Object.entries(ROUTE_CASES)) {
    const surfaceDocument = createSurfaceDocument();
    applyRouteSurface(surfaceDocument.doc, routeCase.route);

    for (const surfaceId of SURFACE_IDS) {
      assert.equal(
        surfaceDocument.elements.get(surfaceId)?.hidden,
        surfaceId !== routeCase.activeSurfaceId,
        `${routeName} set unexpected visibility for #${surfaceId}`,
      );
    }

    const isGameRoute = routeName === 'game';
    assert.equal(surfaceDocument.bodyClasses.has('route-game'), isGameRoute);
    assert.equal(surfaceDocument.elements.get('flip')?.hidden, !isGameRoute);
    assert.equal(surfaceDocument.elements.get('skip-board')?.hidden, !isGameRoute);
  }
});
