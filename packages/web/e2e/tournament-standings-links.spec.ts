import { test, expect } from '@playwright/test';
import type {
  ArenaStanding,
  SwissOrRoundRobinStanding,
  TournamentDetail,
  TournamentStanding,
} from '../src/api/models.js';

test.describe('Tournament standings profile links and focus preservation', () => {
  let currentParticipants: string[] = ['p1', 'p2', 'p3'];
  let currentTournament: TournamentDetail;
  let currentStandings: TournamentStanding[] = [];
  let currentPlayers: Record<string, { handle: string } | null> = {};
  let liveRequestCount = 0;
  let userProfileRequests: string[] = [];
  let userGamesRequests: string[] = [];

  test.beforeEach(async ({ page }) => {
    liveRequestCount = 0;
    userProfileRequests = [];
    userGamesRequests = [];
    currentParticipants = ['p1', 'p2', 'p3'];
    currentTournament = {
      id: 't1',
      name: 'Demo Arena',
      format: 'arena',
      variant: 'standard',
      timeControl: { initialMs: 180000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      durationMs: 600000,
      state: 'running',
      participants: currentParticipants,
      startedAtMs: 0,
    };
    currentStandings = [];
    currentPlayers = {};

    await page.route('**/v1/capabilities', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ capabilities: { social: true } }),
      }),
    );

    await page.route('**/v1/seeks', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );

    await page.route('**/v1/tournaments/t1', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(currentTournament),
      }),
    );

    await page.route('**/v1/tournaments/t1/live', (route) => {
      liveRequestCount++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ standings: currentStandings, games: [] }),
      });
    });

    await page.route('**/v1/tournaments/t1/standings', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(currentStandings),
      }),
    );

    await page.route('**/v1/users/**', (route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      if (pathname.endsWith('/games')) {
        userGamesRequests.push(pathname);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '[]',
        });
      }
      if (pathname.endsWith('/ratings')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '[]',
        });
      }
      userProfileRequests.push(pathname);
      const rawHandle = pathname.replace('/v1/users/', '');
      const decodedHandle = decodeURIComponent(rawHandle);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'p1',
            handle: decodedHandle,
            country: null,
            createdAt: '2026-10-31T00:00:00Z',
          },
          ratings: [],
        }),
      });
    });

    await page.route('**/v1/social/players/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ total: 0, items: [] }),
      }),
    );

    await page.route('**/v1/players/*/achievements', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Achievements unavailable' }),
      }),
    );

    await page.route('**/achievements/summary**', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Achievements unavailable' }),
      }),
    );

    await page.route('**/graphql', (route) => {
      let postData: { query?: string; variables?: Record<string, unknown> } | null = null;
      try {
        postData = route.request().postDataJSON();
      } catch {
        postData = null;
      }
      const variables = postData?.variables || {};

      if (postData?.query?.includes('Connections') || ('id' in variables && !('id0' in variables))) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { player: { followers: [], following: [] } } }),
        });
      }

      const data: Record<string, { id: string; handle: string } | null> = {};
      for (const [key, val] of Object.entries(variables)) {
        const alias = key.replace('id', 'p');
        const id = String(val);
        const player = currentPlayers[id];
        data[alias] = player ? { id, handle: player.handle } : null;
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data }),
      });
    });
  });

  test('renders resolved handles as native profile links with encoding and LTR rank, leaving unresolved IDs plaintext', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 600 });

    const maliciousHandle = '<script>alert("xss")</script>';
    const arabicHandle = 'لاعب_شطرنج_عربي';

    currentParticipants = ['p1', 'p2', 'p3'];
    const arenaStandings: ArenaStanding[] = [
      { rank: 1, playerId: 'p1', points: 4, wins: 2, draws: 0, losses: 0, gamesPlayed: 2, onFire: true },
      { rank: 2, playerId: 'p2', points: 2, wins: 1, draws: 0, losses: 1, gamesPlayed: 2, onFire: false },
      { rank: 3, playerId: 'p3', points: 0, wins: 0, draws: 0, losses: 2, gamesPlayed: 2, onFire: false },
    ];
    currentStandings = arenaStandings;
    currentPlayers = {
      p1: { handle: maliciousHandle },
      p2: { handle: arabicHandle },
      p3: null,
    };

    await page.goto('/tournaments/t1');

    const container = page.locator('#tournament-standings');
    await expect(container).toBeVisible();

    const p1Anchor = container.locator('a[data-route="profile"][data-player-id="p1"]');
    await expect(p1Anchor).toBeVisible();
    await expect(p1Anchor).toHaveAttribute('href', `/profile/${encodeURIComponent(maliciousHandle)}`);
    await expect(p1Anchor).toHaveAttribute('dir', 'auto');
    await expect(p1Anchor).toHaveAttribute('data-player-id', 'p1');
    await expect(p1Anchor).toHaveText(maliciousHandle);
    expect(await container.locator('script').count()).toBe(0);

    const p2Anchor = container.locator('a[data-route="profile"][data-player-id="p2"]');
    await expect(p2Anchor).toBeVisible();
    await expect(p2Anchor).toHaveAttribute('href', `/profile/${encodeURIComponent(arabicHandle)}`);
    await expect(p2Anchor).toHaveAttribute('dir', 'auto');
    await expect(p2Anchor).toHaveAttribute('data-player-id', 'p2');
    await expect(p2Anchor).toHaveText(arabicHandle);

    const rankSpans = container.locator('span[dir="ltr"]');
    await expect(rankSpans.first()).toHaveText(/1/);
    await expect(rankSpans.nth(1)).toHaveText(/2/);
    await expect(rankSpans.nth(2)).toHaveText(/3/);

    await expect(container.locator('a[data-player-id="p3"]')).toHaveCount(0);
    await expect(container).toContainText('p3');
    const p1Row = p1Anchor.locator('..').locator('..');
    await expect(p1Row).toContainText('2W/0D/0L');
    await expect(p1Row).toContainText('🔥 On fire');

    await p1Anchor.focus();
    await expect(p1Anchor).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(p2Anchor).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(p2Anchor).not.toBeFocused();
    await expect(container.getByText('p3')).not.toBeFocused();

    const localeSelect = page.locator('#locale-select');
    await expect(localeSelect).toBeVisible();
    await localeSelect.selectOption('ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const docWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(docWidth).toBeLessThanOrEqual(320);
    await expect(p2Anchor).toHaveAttribute('dir', 'auto');
    await expect(rankSpans.first()).toHaveAttribute('dir', 'ltr');
    await expect(p1Row).toContainText('فوز: 2');
    await expect(p1Row).toContainText('🔥 سلسلة انتصارات');
    await localeSelect.selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('maintains focus across live polling reorders and updates, moving focus to container on player removal without stealing external focus', async ({ page }) => {
    await page.clock.install();

    currentParticipants = ['p1', 'p2', 'p3'];
    currentPlayers = {
      p1: { handle: 'alice' },
      p2: { handle: 'bob' },
      p3: { handle: 'charlie' },
    };
    currentStandings = [
      { rank: 1, playerId: 'p1', points: 10, wins: 5, draws: 0, losses: 0, gamesPlayed: 5, onFire: true },
      { rank: 2, playerId: 'p2', points: 8, wins: 4, draws: 0, losses: 1, gamesPlayed: 5, onFire: false },
      { rank: 3, playerId: 'p3', points: 6, wins: 3, draws: 0, losses: 2, gamesPlayed: 5, onFire: false },
    ];

    await page.goto('/tournaments/t1');

    const container = page.locator('#tournament-standings');
    const aliceAnchor = container.locator('a[data-route="profile"][data-player-id="p1"]');
    await expect(aliceAnchor).toBeVisible();
    await expect(aliceAnchor).toHaveText('alice');
    await expect.poll(() => liveRequestCount).toBe(1);

    await aliceAnchor.focus();
    await expect(aliceAnchor).toBeFocused();

    await page.evaluate(() => {
      document.documentElement.style.overflowAnchor = 'none';
      document.body.style.overflowAnchor = 'none';
      const spacer = document.createElement('div');
      spacer.id = 'scroll-spacer';
      spacer.style.height = '3000px';
      document.body.appendChild(spacer);
    });
    const targetScrollY = await aliceAnchor.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return Math.ceil(window.scrollY + rect.bottom + window.innerHeight + 100);
    });
    await page.evaluate((y) => window.scrollTo(0, y), targetScrollY);
    const scrollYBefore = await page.evaluate(() => window.scrollY);
    expect(scrollYBefore).toBeGreaterThan(0);
    expect(await aliceAnchor.evaluate((el) => el.getBoundingClientRect().bottom < 0)).toBe(true);
    expect(await aliceAnchor.evaluate((el) => document.activeElement === el)).toBe(true);

    currentPlayers = {
      p1: { handle: 'alice_gm' },
      p2: { handle: 'bob' },
      p3: { handle: 'charlie' },
    };
    currentStandings = [
      { rank: 1, playerId: 'p2', points: 12, wins: 6, draws: 0, losses: 1, gamesPlayed: 7, onFire: true },
      { rank: 2, playerId: 'p1', points: 11, wins: 5, draws: 1, losses: 1, gamesPlayed: 7, onFire: false },
      { rank: 3, playerId: 'p3', points: 6, wins: 3, draws: 0, losses: 4, gamesPlayed: 7, onFire: false },
    ];

    await page.clock.fastForward(5000);
    await expect.poll(() => liveRequestCount).toBe(2);

    const updatedAliceAnchor = container.locator('a[data-route="profile"][data-player-id="p1"]');
    await expect(updatedAliceAnchor).toHaveText('alice_gm');
    await expect(updatedAliceAnchor).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollYBefore);

    currentStandings = [
      { rank: 1, playerId: 'p2', points: 14, wins: 7, draws: 0, losses: 1, gamesPlayed: 8, onFire: true },
      { rank: 2, playerId: 'p3', points: 8, wins: 4, draws: 0, losses: 4, gamesPlayed: 8, onFire: false },
    ];

    await page.clock.fastForward(5000);
    await expect.poll(() => liveRequestCount).toBe(3);

    await expect(container.locator('a[data-player-id="p1"]')).toHaveCount(0);
    await expect(container).toBeFocused();
    await expect(container).toHaveAttribute('tabindex', '-1');
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollYBefore);

    const externalControl = page.locator('#locale-select');
    await externalControl.focus();
    await expect(externalControl).toBeFocused();

    currentStandings = [
      { rank: 1, playerId: 'p2', points: 16, wins: 8, draws: 0, losses: 1, gamesPlayed: 9, onFire: true },
      { rank: 2, playerId: 'p3', points: 10, wins: 5, draws: 0, losses: 4, gamesPlayed: 9, onFire: false },
    ];

    await page.clock.fastForward(5000);
    await expect.poll(() => liveRequestCount).toBe(4);

    await expect(container).toContainText(/16/);
    await expect(externalControl).toBeFocused();

    const bobAnchor = container.locator('a[data-player-id="p2"]');
    await bobAnchor.focus();
    await expect(bobAnchor).toBeFocused();
    await page.evaluate((y) => window.scrollTo(0, y), scrollYBefore);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollYBefore);
    expect(await bobAnchor.evaluate((el) => document.activeElement === el)).toBe(true);

    currentStandings = [];

    await page.clock.fastForward(5000);
    await expect.poll(() => liveRequestCount).toBe(5);

    await expect(container.locator('a[data-route="profile"]')).toHaveCount(0);
    await expect(container).toBeFocused();
    await expect(container).toHaveAttribute('tabindex', '-1');
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollYBefore);
  });

  test('navigates to profile on Enter and preserves native anchor attributes for modified clicks', async ({ page }) => {
    const unicodeHandle = 'لاعب_شطرنج';
    currentParticipants = ['p1'];
    currentPlayers = { p1: { handle: unicodeHandle } };
    currentStandings = [
      { rank: 1, playerId: 'p1', points: 4, wins: 2, draws: 0, losses: 0, gamesPlayed: 2, onFire: false },
    ];

    await page.goto('/tournaments/t1');

    const container = page.locator('#tournament-standings');
    const profileAnchor = container.locator('a[data-route="profile"][data-player-id="p1"]');
    await expect(profileAnchor).toBeVisible();
    await expect(profileAnchor).toHaveAttribute('href', `/profile/${encodeURIComponent(unicodeHandle)}`);
    await expect(profileAnchor).toHaveAttribute('data-route', 'profile');
    await expect(profileAnchor).toHaveAttribute('data-player-id', 'p1');
    expect(await profileAnchor.getAttribute('download')).toBeNull();

    const target = await profileAnchor.getAttribute('target');
    expect(target === null || target === '_self').toBe(true);

    const ctrlPrevented = await profileAnchor.evaluate((el) => {
      const evt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
      el.dispatchEvent(evt);
      return evt.defaultPrevented;
    });
    expect(ctrlPrevented).toBe(false);

    const middlePrevented = await profileAnchor.evaluate((el) => {
      const evt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 });
      el.dispatchEvent(evt);
      return evt.defaultPrevented;
    });
    expect(middlePrevented).toBe(false);

    await profileAnchor.focus();
    await expect(profileAnchor).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/profile/${encodeURIComponent(unicodeHandle)}$`));

    const expectedProfilePath = `/v1/users/${encodeURIComponent(unicodeHandle)}`;
    const expectedGamesPath = `/v1/users/${encodeURIComponent(unicodeHandle)}/games`;

    await expect.poll(() => userProfileRequests.length).toBe(1);
    expect(userProfileRequests[0]).toBe(expectedProfilePath);
    expect(userProfileRequests[0]).not.toContain('%25');

    await expect.poll(() => userGamesRequests.length).toBe(1);
    expect(userGamesRequests[0]).toBe(expectedGamesPath);
    expect(userGamesRequests[0]).not.toContain('%25');

    await expect(page.locator('#profile-handle')).toHaveText(unicodeHandle);
    await expect(page.locator('#profile-error')).toBeEmpty();
    await expect(page.locator('#profile-ratings')).toContainText('No ratings yet');
    await expect(page.locator('#profile-games')).toContainText('No games yet');
  });

  test('renders swiss tournament standings with tiebreak buchholz and withdrawn stats in EN and AR', async ({ page }) => {
    currentParticipants = ['p1', 'p2'];
    currentTournament = {
      id: 't1',
      name: 'Demo Swiss',
      format: 'swiss',
      variant: 'standard',
      timeControl: { initialMs: 180000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rounds: 5,
      state: 'finished',
      participants: currentParticipants,
      roundsGenerated: 5,
      tiebreakOrder: ['buchholz', 'medianBuchholz'],
    };

    const swissStandings: SwissOrRoundRobinStanding[] = [
      {
        rank: 1,
        playerId: 'p1',
        points: 4.5,
        tiebreak: 18.5,
        buchholz: 18.5,
        medianBuchholz: 12.0,
        withdrawn: false,
      },
      {
        rank: 2,
        playerId: 'p2',
        points: 3.5,
        tiebreak: 15.0,
        buchholz: 15.0,
        medianBuchholz: 10.5,
        withdrawn: true,
      },
    ];
    currentStandings = swissStandings;
    currentPlayers = {
      p1: { handle: 'alice' },
      p2: { handle: 'لاعب_سويسري' },
    };

    await page.goto('/tournaments/t1');

    const container = page.locator('#tournament-standings');
    await expect(container).toBeVisible();

    const p1Anchor = container.locator('a[data-route="profile"][data-player-id="p1"]');
    await expect(p1Anchor).toBeVisible();
    await expect(p1Anchor).toHaveAttribute('href', '/profile/alice');

    const p2Anchor = container.locator('a[data-route="profile"][data-player-id="p2"]');
    await expect(p2Anchor).toBeVisible();
    await expect(p2Anchor).toHaveAttribute('href', `/profile/${encodeURIComponent('لاعب_سويسري')}`);
    await expect(p2Anchor).toHaveAttribute('dir', 'auto');

    const p2Row = p2Anchor.locator('..').locator('..');
    await expect(p2Row).toContainText('Tiebreak: 15');
    await expect(p2Row).toContainText('Buchholz: 15');
    await expect(p2Row).toContainText('[Withdrawn]');

    const localeSelect = page.locator('#locale-select');
    await expect(localeSelect).toBeVisible();
    await localeSelect.selectOption('ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(p2Anchor).toHaveAttribute('dir', 'auto');
    await expect(p2Row).toContainText('كسر التعادل: 15');
    await expect(p2Row).toContainText('بوخهولز: 15');
    await expect(p2Row).toContainText('[منسحب]');
    await localeSelect.selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });
});
