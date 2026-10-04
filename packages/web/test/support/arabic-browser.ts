import { renderGameStatusText, renderInterpolatedText } from '../../src/i18n/bidi.js';
import { renderSessions } from '../../src/app/sessions-view.js';
import { createI18n } from '../../src/i18n/manager.js';
import { renderAchievements } from '../../src/app/achievements-view.js';
import { renderLiveBoards, renderStandings } from '../../src/app/tournament-view.js';
import { renderStudyDetail } from '../../src/app/studies-view.js';
import { renderEvidence } from '../../src/app/explain-view.js';
import { renderCoachResult } from '../../src/app/coach-view.js';
import { renderPuzzleResult } from '../../src/app/puzzle-view.js';
import { renderEndgameVerdict } from '../../src/app/endgame-view.js';

/** Browser-only test entry. Bundled in memory, never imported by the production app. */
export function render(tokens: string[]) {
  const node = document.createElement('div');
  node.dir = 'rtl';
  document.body.appendChild(node);
  renderInterpolatedText(node, `بيانات ${tokens.map((_, i) => `{p${i}}`).join(' ')}`, Object.fromEntries(tokens.map((value, i) => [`p${i}`, value])));
  const status = document.createElement('div');
  status.dir = 'rtl';
  renderGameStatusText(status, 'نتيجتان: {result0} {toString} 1-0 و0-1');
  const sessions = document.createElement('div');
  sessions.dir = 'rtl';
  renderSessions(sessions, [{
    id: 'session-id', createdAt: '2026-10-04T00:00:00Z', expiresAt: '2030-01-01T00:00:00Z',
    revokedAt: null, lastSeenAt: null, lastIp: '127.0.0.1', lastUserAgent: 'Chrome/130 Windows',
    createdIp: null, createdUserAgent: null,
  }], () => {}, false, Date.parse('2026-10-04'), createI18n({ initialLocale: 'ar' }));
  const achievements = document.createElement('div');
  achievements.dir = 'rtl';
  renderAchievements(achievements, [{
    key: 'external-entry', name: 'External <img src=x onerror=alert(1)>', description: 'Unmodified content',
    category: 'external', tier: 'gold', points: 10, hidden: false, progress: 0, target: 12, unlockedAt: null,
  }, {
    key: 'first-game', name: 'First Moves', description: 'Play your first chess game.',
    category: 'games', tier: 'bronze', points: 10, hidden: false, progress: 0, target: 1, unlockedAt: null,
  }], createI18n({ initialLocale: 'ar' }));
  const liveGames = document.createElement('div');
  const standings = document.createElement('div');
  liveGames.dir = 'rtl';
  standings.dir = 'rtl';
  const i18n = createI18n({ initialLocale: 'ar' });
  const names = new Map([['white', { id: 'white', handle: 'Alice_لاعب' }], ['black', { id: 'black', handle: 'Bob' }]]);
  const game = { gameId: 'game-id', white: 'white', black: 'black', ply: 3, turn: 'b' as const, fen: '', fenHash: '', clock: { w: 300_000, b: 240_000 } };
  renderLiveBoards(liveGames, [
    { ...game, status: { over: false } },
    { ...game, status: { over: true, result: '1-0', termination: 'resignation', winner: 'w' } },
  ], names, i18n);
  document.body.append(status, sessions, achievements, liveGames, standings);
  renderStandings(standings, [
    { rank: 1, playerId: 'white', points: 5, wins: 2, draws: 1, losses: 0, gamesPlayed: 3, onFire: true },
    { rank: 2, playerId: 'black', points: 2, tiebreak: 1, buchholz: 5, medianBuchholz: 3, withdrawn: false },
  ], names, i18n);
  const visibility = document.createElement('div');
  const collaborators = document.createElement('div');
  visibility.dir = collaborators.dir = 'rtl';
  document.body.append(visibility, collaborators);
  const playerId = 'b013f563-d849-4d23-91d1-e9c4557d334f';
  renderStudyDetail({ nameEl: null, descEl: null, visEl: visibility, exportEl: null, chaptersEl: null, collabsEl: collaborators }, {
    id: 'study', ownerId: playerId, name: 'Study', description: '', visibility: 'unlisted', variant: 'standard', createdAt: '', updatedAt: '',
  }, [], ['owner', 'contributor', 'viewer'].map((role) => ({ studyId: 'study', playerId, role: role as 'owner' | 'contributor' | 'viewer' })), '', i18n);
  const ai = document.createElement('div');
  ai.dir = 'rtl';
  document.body.appendChild(ai);
  renderEvidence(ai, { fen: '', variant: 'standard', move: 'e2e4', explanation: '', providerId: '', model: '', citation: {
    moveOutcome: { kind: 'evaluation', evalKind: 'cp', evalValue: -20, evalLabel: '-0.20' }, evalKind: 'cp', evalValue: 35, evalLabel: '+0.35', bestMove: 'd2d4', bestLine: [], depth: 16,
  } }, i18n);
  const coach = document.createElement('div');
  ai.appendChild(coach);
  renderCoachResult(coach, document.createElement('div'), { fen: '', variant: 'standard', move: null, featuresFired: [],
    mistake: { kind: 'omitted', reason: 'not_requested' }, explanation: { kind: 'omitted', reason: 'not_requested' }, opening: { kind: 'omitted', reason: 'not_requested' },
    puzzle: { kind: 'present', value: { kind: 'puzzle', fen: '', variant: 'standard', difficulty: 'hard' } },
    endgame: { kind: 'present', value: { id: 'endgame', type: 'Lucena', name: 'Lucena', fen: '', sideToMove: 'w', objective: 'win', difficulty: 'advanced', technique: null } },
  }, i18n);
  const puzzle = document.createElement('div');
  ai.appendChild(puzzle);
  renderPuzzleResult(puzzle, document.createElement('div'), { kind: 'puzzle', fen: '', variant: 'standard', evidence: { kind: 'mate', relation: 'faster_mate', distanceGap: 2 }, bestMove: 'e2e4', comparisonMove: 'd2d4', bestEvaluation: { type: 'cp', value: 35 }, comparisonEvaluation: { type: 'cp', value: -20 }, depth: 16, solutionMove: 'e2e4', solutionLine: ['e2e4', 'e7e5'], difficulty: 'hard' }, i18n);
  const endgame = document.createElement('div');
  ai.appendChild(endgame);
  renderEndgameVerdict(document, endgame, document.createElement('div'), { kind: 'terminal', id: 'endgame', move: 'e1d2', fenAfter: '', classification: 'throws_result', goalPreserved: false, terminal: { reason: 'stalemate', result: '1/2-1/2' } }, i18n);
  const unknownEndgame = document.createElement('div');
  ai.appendChild(unknownEndgame);
  renderEndgameVerdict(document, unknownEndgame, document.createElement('div'), { kind: 'terminal', id: 'endgame', move: 'e1d2', fenAfter: '', classification: 'throws_result', goalPreserved: false, terminal: { reason: 'toString', result: '1/2-1/2' } }, i18n);
  return {
    text: node.textContent,
    children: [...node.querySelectorAll('bdi')].map((child) => ({ text: child.textContent, dir: child.dir, isolation: getComputedStyle(child).unicodeBidi })),
    images: node.querySelectorAll('img').length,
    result: { text: status.textContent, directions: [...status.querySelectorAll('bdi')].map((child) => child.dir) },
    sessionTokens: [...sessions.querySelectorAll('bdi')].map((child) => ({ text: child.textContent, dir: child.dir })),
    sessionName: { visible: sessions.querySelector('.panel-row > span')?.textContent, action: sessions.querySelector('button')?.getAttribute('aria-label') },
    achievement: { text: achievements.textContent, images: achievements.querySelectorAll('img').length, progressDir: achievements.querySelector<HTMLElement>('bdi[dir="ltr"]')?.dir },
    tournament: { liveText: liveGames.textContent, ltrTokens: [...liveGames.querySelectorAll('bdi[dir="ltr"]')].map((child) => child.textContent), standingsText: standings.textContent },
    study: { visibility: visibility.textContent, roles: [...collaborators.querySelectorAll('.count')].map((child) => child.textContent), ids: [...collaborators.querySelectorAll<HTMLElement>('.row-main')].map((child) => ({ text: child.textContent, dir: child.dir })) },
    ai: { text: ai.textContent, ltrTokens: [...ai.querySelectorAll<HTMLElement>('[dir="ltr"]')].map((child) => child.textContent) },
  };
}
