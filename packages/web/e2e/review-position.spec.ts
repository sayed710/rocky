/** Browser-only review targeting contract; API/socket fixtures isolate keyboard and locale behavior. */
import { expect, test } from '@playwright/test';
import type { GameReviewMove, GameReviewResponse } from '../src/api/models.js';
import { makeFinishedState, sampleAnalysisResponse } from '../test/support/analysis-fixtures.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FINAL = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const GAME_ID = 'review-position-game';
const SESSION = {
  user: { id: 'review-user', handle: 'reviewer', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
  tokens: { accessToken: 'review-token', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
};

/** Real review response shape, including the pre-move position and server-owned assessment. */
function reviewMove(ply: number, fenBefore: string): GameReviewMove {
  return { ply, fenBefore, san: ply === 1 ? 'e4' : 'Nf3', move: ply === 1 ? 'e2e4' : 'g1f3',
    classification: 'best', assessment: { fen: fenBefore, variant: 'standard', move: 'e2e4',
      classification: 'ok', before: { evalKind: 'cp', evalValue: 20, evalLabel: '+0.20' },
      after: { kind: 'evaluation', evalKind: 'cp', evalValue: 10, evalLabel: '+0.10' },
      centipawnLoss: 10, bestMove: 'e2e4', bestLine: ['e2e4'], depth: 16 } };
}

const REVIEW: GameReviewResponse = {
  gameId: GAME_ID, variant: 'standard', playerColor: 'white', result: '1-0', termination: 'checkmate',
  moves: [reviewMove(1, START), reviewMove(3, FINAL)], isPartial: false,
  summary: { brilliant: 0, great: 0, best: 2, excellent: 0, good: 0, book: 0,
    inaccuracy: 0, mistake: 0, miss: 0, blunder: 0, missed_win: 0 },
};

for (const locale of ['en', 'ar'] as const) {
  test(`keyboard review selection targets the displayed FEN in ${locale} and clears on navigation`, async ({ page }) => {
    const analysisFens: string[] = [];
    const puzzleFens: string[] = [];
    const moveCommands: unknown[] = [];
    const interceptedHttpRequests: string[] = [];
    const outboundWsMessages: unknown[] = [];
    await page.route('**/v1/**', async (route) => {
      const url = route.request().url();
      interceptedHttpRequests.push(url);
      const path = new URL(url).pathname;
      let body: unknown = {};
      if (path === '/v1/auth/refresh') body = SESSION;
      else if (path === '/v1/capabilities') body = {
        capabilities: { gameReview: true, analysis: true, puzzleGeneration: true },
        gameReviewVariants: ['standard'], analysisVariants: ['standard'], puzzleVariants: ['standard'],
      };
      else if (path.endsWith('/review')) body = REVIEW;
      else if (path === '/v1/analysis') {
        const fen = route.request().postDataJSON().fen as string;
        analysisFens.push(fen);
        body = { ...sampleAnalysisResponse(), fen };
      } else if (path === '/v1/analysis/puzzle') {
        const fen = route.request().postDataJSON().fen as string;
        puzzleFens.push(fen);
        body = { kind: 'no_tactic', fen, variant: 'standard',
          evidence: { kind: 'centipawn_gap', gapCp: 80 }, bestMove: 'e2e4', comparisonMove: 'd2d4',
          bestEvaluation: { type: 'cp', value: 120 }, comparisonEvaluation: { type: 'cp', value: 40 }, depth: 16 };
      } else if (path === '/v1/seeks') body = [];
      await route.fulfill({ json: body });
    });
    await page.routeWebSocket('**/ws', (socket) => {
      socket.onMessage((data) => {
        const message = JSON.parse(String(data));
        if (message.t === 'move') moveCommands.push(message);
        if (message.t !== 'ping') outboundWsMessages.push(message);
        if (message.t === 'join') socket.send(JSON.stringify({ t: 'joined', gameId: message.gameId, role: 'white',
          state: { ...makeFinishedState(FINAL), gameId: message.gameId,
            players: { white: SESSION.user.id, black: 'other-player' } } }));
        if (message.t === 'ping') socket.send(JSON.stringify({ t: 'pong', ts: message.ts, serverTs: Date.now() }));
      });
    });
    await page.addInitScript(({ chosenLocale }) => {
      localStorage.setItem('gambit-session', JSON.stringify({ userId: 'review-user', handle: 'reviewer' }));
      localStorage.setItem('rookzen_locale_v1', chosenLocale);
    }, { chosenLocale: locale });
    await page.goto(`/game/${GAME_ID}`);
    await page.evaluate(() => { document.documentElement.dataset['reviewDocument'] = 'retained'; });
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    const status = page.locator('#status');
    const expectedFinalStatus = locale === 'ar' ? 'كش مات — فوز الأبيض (1-0)' : 'Checkmate — White wins (1-0)';
    await expect(page.locator('#game-review-run')).toBeEnabled();
    await expect(status).toHaveText(expectedFinalStatus);
    const returnFinal = page.locator('#game-review-return-final');
    await expect(returnFinal).toBeHidden();
    const returnFinalLabel = locale === 'ar' ? 'العودة إلى الوضع النهائي' : 'Return to final position';
    await page.locator('#game-review-run').click();
    const rows = page.locator('#game-review-moves button');
    await expect(rows).toHaveCount(2);
    await expect(page.locator('#game-review-summary')).toBeVisible();
    await expect(returnFinal).toBeHidden();
    await rows.first().focus();
    await page.keyboard.press('Enter');
    await expect(rows.first()).toBeFocused();
    await expect(returnFinal).toBeVisible();
    await expect(returnFinal).toHaveText(returnFinalLabel);
    await expect(status).not.toHaveText(expectedFinalStatus);
    await expect(page.locator('[data-square="e2"] .cb-piece')).toHaveCount(1);
    await expect(page.locator('[data-square="e4"] .cb-piece')).toHaveCount(0);
    await page.locator('#analysis-run').click();
    await expect(page.locator('#analysis-results .panel-row')).toHaveCount(3);
    await page.locator('#puzzle-run').click();
    await expect(page.locator('#puzzle-result')).toBeVisible();
    expect(analysisFens).toEqual([START]);
    expect(puzzleFens).toEqual([START]);
    await rows.nth(1).focus();
    await page.keyboard.press('Space');
    await expect(rows.nth(1)).toBeFocused();
    await expect(returnFinal).toBeVisible();
    await expect(returnFinal).toHaveText(returnFinalLabel);
    await expect(page.locator('[data-square="e4"] .cb-piece')).toHaveCount(1);
    await expect(page.locator('#analysis-results .panel-row')).toHaveCount(0);
    await expect(page.locator('#puzzle-result')).toBeHidden();
    await page.locator('#analysis-run').click();
    await expect(page.locator('#analysis-results .panel-row')).toHaveCount(3);
    expect(analysisFens).toEqual([START, FINAL]);

    if (locale === 'ar') {
      await page.setViewportSize({ width: 390, height: 844 });
      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalOverflow).toBe(false);
    }

    const httpCountBefore1 = interceptedHttpRequests.length;
    const wsCountBefore1 = outboundWsMessages.length;

    await returnFinal.focus();
    await expect(returnFinal).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(returnFinal).toBeHidden();
    await expect(status).toBeFocused();
    await expect(status).toHaveText(expectedFinalStatus);
    await expect(page.locator('[data-square="e2"] .cb-piece')).toHaveCount(0);
    await expect(page.locator('[data-square="e4"] .cb-piece')).toHaveCount(1);
    await expect(page.locator('#analysis-results .panel-row')).toHaveCount(0);
    await expect(page.locator('#puzzle-result')).toBeHidden();
    await expect(rows).toHaveCount(2);
    await expect(page.locator('#game-review-summary')).toBeVisible();

    expect(interceptedHttpRequests.length).toBe(httpCountBefore1);
    expect(outboundWsMessages.length).toBe(wsCountBefore1);

    await page.locator('#analysis-run').click();
    await expect(page.locator('#analysis-results .panel-row')).toHaveCount(3);
    await page.locator('#puzzle-run').click();
    await expect(page.locator('#puzzle-result')).toBeVisible();
    expect(analysisFens).toEqual([START, FINAL, FINAL]);
    expect(puzzleFens).toEqual([START, FINAL]);

    await rows.first().focus();
    await page.keyboard.press('Enter');
    await expect(rows.first()).toBeFocused();
    await expect(returnFinal).toBeVisible();
    await expect(page.locator('[data-square="e2"] .cb-piece')).toHaveCount(1);
    await expect(page.locator('[data-square="e4"] .cb-piece')).toHaveCount(0);
    await expect(page.locator('#analysis-results .panel-row')).toHaveCount(0);
    await expect(page.locator('#puzzle-result')).toBeHidden();

    if (locale === 'en') {
      await expect(status).toHaveText('Reviewing e4. Best move: e2e4.');
      await page.locator('#locale-select').focus();
      await page.locator('#locale-select').selectOption('ar');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
      await expect(returnFinal).toBeVisible();
      await expect(returnFinal).toHaveText('العودة إلى الوضع النهائي');
      await expect(status).toHaveText('جارٍ مراجعة e4. أفضل نقلة: e2e4.');
      await expect(page.locator('[data-square="e2"] .cb-piece')).toHaveCount(1);
      await expect(page.locator('#locale-select')).toBeFocused();

      await returnFinal.focus();
      await expect(returnFinal).toBeFocused();
      await page.keyboard.press('Space');

      await expect(returnFinal).toBeHidden();
      await expect(status).toBeFocused();
      await expect(status).toHaveText('كش مات — فوز الأبيض (1-0)');
      await expect(page.locator('[data-square="e2"] .cb-piece')).toHaveCount(0);
      await expect(page.locator('[data-square="e4"] .cb-piece')).toHaveCount(1);

      await page.locator('#locale-select').focus();
      await page.locator('#locale-select').selectOption('en');
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(status).toHaveText('Checkmate — White wins (1-0)');
      await expect(returnFinal).toBeHidden();
      await expect(page.locator('#locale-select')).toBeFocused();
    } else {
      await returnFinal.focus();
      await expect(returnFinal).toBeFocused();
      await page.keyboard.press('Space');
      await expect(returnFinal).toBeHidden();
      await expect(status).toBeFocused();
      await expect(status).toHaveText(expectedFinalStatus);
      await expect(page.locator('[data-square="e2"] .cb-piece')).toHaveCount(0);
      await expect(page.locator('[data-square="e4"] .cb-piece')).toHaveCount(1);
    }

    await rows.first().focus();
    await page.keyboard.press('Enter');
    // A real SPA route change disposes the private selection before another game mounts.
    await page.locator('a[href="/"]').first().click();
    await expect(page).toHaveURL('/');
    await expect(page.locator('#game-review-moves button')).toHaveCount(0);
    await expect(page.locator('#analysis-results .panel-row')).toHaveCount(0);
    await page.evaluate(() => {
      history.pushState(null, '', '/game/another-review-game');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('html')).toHaveAttribute('data-review-document', 'retained');
    await expect(page.locator('#analysis-run')).toBeEnabled();
    await page.locator('#analysis-run').click();
    await expect(page.locator('#analysis-results .panel-row')).toHaveCount(3);
    expect(analysisFens).toEqual([START, FINAL, FINAL, FINAL]);
    expect(moveCommands).toEqual([]);
  });
}
