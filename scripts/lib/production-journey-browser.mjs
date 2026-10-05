import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { requireComplete, requireEdge, requireFinished, requireRatings, ratingInPool } from './production-journey-contract.mjs';

const expect = playwrightExpect.configure({ timeout: 20_000 });

/** Reach the native link through the real tab order; programmatic focus would hide regressions. */
async function focusByKeyboard(page, link) {
  for (let attempt = 0; attempt < 64; attempt++) {
    await page.keyboard.press('Tab');
    if (await link.evaluate(element => element === element.ownerDocument.activeElement)) return;
  }
  throw new Error('Finished-game history link is not keyboard reachable');
}

/** Execute product actions in independent contexts; deployment controls stay with the runner. */
export async function browserJourney({ baseURL, evidence, stage, database, restart, replayObserved, setBrowser, protect }) {
  const browser = await chromium.launch();
  setBrowser(browser);
  evidence.chromium = browser.version();
  const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const violations = [];
  evidence.moves = [];
  evidence.sockets = [[], []];
  evidence.roles = [[], []];
  evidence.apiPaths = [];
  for (const [index, page] of pages.entries()) {
    page.setDefaultTimeout(20_000);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!['http:', 'https:'].includes(url.protocol)) return;
      try { requireEdge(url.href, baseURL); } catch (error) { violations.push(error.message); }
      if (url.pathname.startsWith('/v1/')) evidence.apiPaths.push(url.pathname);
    });
    page.on('websocket', socket => {
      evidence.sockets[index].push(socket.url());
      try { requireEdge(socket.url(), baseURL, true); } catch (error) { violations.push(error.message); }
      socket.on('framesent', ({ payload }) => {
        const frame = JSON.parse(String(payload));
        // Never retain join frames: they carry access tokens.
        if (frame.t === 'move') evidence.moves.push(frame.uci);
      });
      socket.on('framereceived', ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.t === 'joined') evidence.roles[index].push({ gameId: frame.gameId, role: frame.role });
      });
    });
  }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  evidence.handles = [`o09w-${suffix}`, `o09b-${suffix}`];
  try {
    stage('register');
    for (const [index, page] of pages.entries()) {
      await page.goto('/');
      await page.locator('#auth-handle').fill(evidence.handles[index]);
      await page.locator('#auth-password').fill(protect(`O09-${randomUUID()}!`));
      await page.locator('#auth-email').fill(protect(`${evidence.handles[index]}@example.test`));
      await page.locator('#auth-register').click();
      await expect(page.locator('#auth-logout')).toBeVisible();
    }
    evidence.stages.registered = true;
    const json = async (page, path) => {
      const response = await page.request.get(path, { timeout: 10_000 });
      assert.equal(response.status(), 200, `Product API failed: ${path}`);
      return response.json();
    };
    const profiles = await Promise.all(pages.map((page, index) => json(page, `/v1/users/${evidence.handles[index]}`)));
    evidence.players = profiles.map(profile => profile.user.id);
    evidence.before = profiles.map(profile => ratingInPool(profile.ratings));

    stage('rated seek');
    const [white, black] = pages;
    await white.locator('#create-seek').click();
    await white.locator('input[name="cg-mode"][value="rated"]').check();
    await white.locator('input[name="cg-variant"][value="standard"]').check();
    await white.locator('input[name="cg-color"][value="white"]').check();
    await white.locator('input[name="cg-time"][value="5+0"]').check();
    await white.locator('#create-game-form .cg-submit').click();
    await expect(white.locator('.seek-row-own')).toBeVisible();
    const seekId = await white.locator('.seek-row-own').getAttribute('data-seek-id');
    assert.ok(seekId);
    const seek = black.locator(`.seek-row[data-seek-id="${seekId}"]`);
    await expect(seek).toBeVisible({ timeout: 30_000 });
    await expect(seek).toContainText(evidence.handles[0]);
    await expect(seek).toContainText(/ · rated/);
    await seek.locator('.seek-accept').click();
    await black.waitForURL(/\/game\/[0-9a-f-]+$/);
    await white.waitForURL(black.url(), { timeout: 30_000 });
    evidence.gameId = new URL(white.url()).pathname.split('/').at(-1);
    assert.match(evidence.gameId, /^[0-9a-f-]{36}$/);
    for (const [index, page] of pages.entries()) {
      await expect(page.locator('#board [data-square]').first()).toHaveAttribute('data-square', index === 0 ? 'a8' : 'h1');
      await expect(page.locator('#status')).toHaveText(index === 0 ? /your move/i : /white to move/i);
    }
    evidence.stages.matched = true;
    for (const [index, roles] of evidence.roles.entries()) {
      assert.ok(roles.some(join => join.gameId === evidence.gameId && join.role === (index === 0 ? 'white' : 'black')), 'Browser joined as a spectator or wrong participant');
    }

    stage('legal board moves');
    for (const [index, from, to, piece] of [[0, 'f2', 'f3', 'white pawn'], [1, 'e7', 'e5', 'black pawn'], [0, 'g2', 'g4', 'white pawn'], [1, 'd8', 'h4', 'black queen']]) {
      await pages[index].locator(`[data-square="${from}"]`).click();
      await pages[index].locator(`[data-square="${to}"]`).click();
      for (const page of pages) {
        await expect(page.locator(`[data-square="${to}"]`)).toHaveAttribute('aria-label', `${to}, ${piece}`);
        await expect(page.locator(`[data-square="${from}"]`)).toHaveAttribute('aria-label', `${from}, empty`);
      }
    }
    evidence.stages.moves = true;
    for (const page of pages) {
      await expect(page.locator('#status')).toContainText(/checkmate/i);
      await expect(page.locator('#status')).toContainText('0-1');
      await expect(page.locator('#action-resign')).toBeHidden();
      await expect(page.locator('#game-review-run')).toBeVisible();
    }
    const sentAtEnd = evidence.moves.length;
    await white.locator('[data-square="a2"]').click();
    await white.locator('[data-square="a3"]').click();
    await expect(white.locator('[data-square="a2"]')).toHaveAttribute('aria-label', 'a2, white pawn');
    assert.equal(evidence.moves.length, sentAtEnd, 'Terminal board sent another move');
    evidence.stages.terminal = true;

    stage('durable projection and ratings');
    await expect.poll(async () => {
      const game = await json(white, `/v1/games/${evidence.gameId}`);
      try { requireFinished(game, evidence.gameId, ...evidence.players); return true; } catch { return false; }
    }, { timeout: 30_000, message: 'Durable game never reached the expected terminal contract' }).toBe(true);
    evidence.game = await json(white, `/v1/games/${evidence.gameId}`);
    evidence.stages.durable = true;
    const ratings = () => Promise.all(pages.map((page, index) => json(page, `/v1/users/${evidence.handles[index]}/ratings`)));
    await expect.poll(async () => (await ratings()).every(rows => rows.length === 1), { timeout: 30_000 }).toBe(true);
    evidence.after = (await ratings()).map(rows => ratingInPool(rows, true));
    evidence.applications = await database(evidence.gameId);
    requireRatings(evidence.before, evidence.after, evidence.applications, evidence.gameId, ...evidence.players);
    evidence.stages.ratings = true;

    const history = async (page, index) => {
      await page.locator('nav a[href="/profile"]').click();
      await expect(page.locator('#profile-handle')).toHaveText(evidence.handles[index]);
      const link = page.locator(`#profile-games a[href="/game/${evidence.gameId}"]`);
      await expect(link).toContainText(/standard.*blitz.*0-1.*4/i);
      await page.reload();
      await expect(link).toBeVisible();
      await expect(link).toHaveCSS('display', 'block');
      await expect(link).toHaveCSS('text-decoration-line', 'none');
      if (!evidence.keyboardControl) {
        // An isolated DOM mutation proves that bypassing the tab order cannot satisfy this check.
        const originalTabindex = await link.getAttribute('tabindex');
        await link.evaluate(element => element.setAttribute('tabindex', '-1'));
        try {
          await assert.rejects(focusByKeyboard(page, link), /not keyboard reachable/);
        } finally {
          await link.evaluate((element, original) => {
            if (original === null) element.removeAttribute('tabindex');
            else element.setAttribute('tabindex', original);
          }, originalTabindex);
        }
        evidence.keyboardControl = 'tabindex=-1 rejected';
      }
      await focusByKeyboard(page, link);
      assert.equal(await link.evaluate(element => element.matches(':focus-visible')), true);
      await expect(link).toHaveCSS('outline-width', '3px');
      await expect(link).toHaveCSS('outline-style', 'solid');
      await expect(link).toHaveCSS('outline-offset', '2px');
      const games = await json(page, `/v1/users/${evidence.handles[index]}/games`);
      requireFinished(games.find(game => game.id === evidence.gameId), evidence.gameId, ...evidence.players);
      await page.keyboard.press('Enter');
      await page.waitForURL(`${baseURL}/game/${evidence.gameId}`);
      await expect(page.locator('[data-square="h4"]')).toHaveAttribute('aria-label', 'h4, black queen');
      await expect(page.locator('#status')).toContainText('0-1');
    };
    const review = async () => {
      const responsePromise = white.waitForResponse(response => new URL(response.url()).pathname === `/v1/games/${evidence.gameId}/review` && response.request().method() === 'POST');
      await white.locator('#game-review-run').click();
      const response = await responsePromise;
      assert.equal(response.status(), 200, 'Real local-engine review failed');
      const result = await response.json();
      assert.equal(result.gameId, evidence.gameId);
      assert.equal(result.playerColor, 'white');
      assert.equal(result.result, '0-1');
      assert.equal(result.termination, 'checkmate');
      assert.equal(result.isPartial, false);
      assert.deepEqual(result.moves.map(move => move.move), ['f2f3', 'g2g4']);
      await expect(white.locator('#game-review-moves .game-review-move')).toHaveCount(2);
      await expect(white.locator('#game-review-error')).toBeHidden();
      evidence.review = { gameId: result.gameId, playerColor: result.playerColor, moves: result.moves.map(move => move.move), isPartial: result.isPartial };
    };
    stage('history and review');
    await history(white, 0);
    await history(black, 1);
    evidence.stages.history = true;
    await review();
    evidence.stages.review = true;

    stage('application restart and same-cluster rating replay');
    await restart();
    evidence.stages.restart = true;
    await replayObserved();
    evidence.stages.replay = true;
    for (const page of pages) await page.reload();
    await history(white, 0);
    await history(black, 1);
    await review();
    const recovered = (await ratings()).map(rows => ratingInPool(rows, true));
    assert.deepEqual(recovered, evidence.after, 'Rating changed during replay');
    assert.deepEqual(await database(evidence.gameId), evidence.applications, 'Application ledger changed during replay');
    requireFinished(await json(white, `/v1/games/${evidence.gameId}`), evidence.gameId, ...evidence.players);
    evidence.stages.recovered = true;
    assert.deepEqual(violations, [], 'Browser traffic bypassed edge');
    requireComplete(evidence);
  } finally {
    await browser.close();
    setBrowser(null);
  }
}
