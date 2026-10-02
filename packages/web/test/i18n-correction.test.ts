import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeElement, createFakeDoc } from './support/localization-dom.js';
import { I18n } from '../src/i18n/manager.js';
import { enMessages, type MessagesCatalog } from '../src/i18n/catalog/index.js';
import { LocaleStorage } from '../src/i18n/storage.js';
import { createApp } from '../src/app/composition.js';
import { bootstrap } from '../src/app/bootstrap.js';
import { mountLesson } from '../src/app/learning-mounts.js';
import { mountStudyChapter } from '../src/app/studies-mounts.js';
import { mountEmailVerification } from '../src/app/email-verification-mount.js';
import { mountEndgames } from '../src/app/endgame-mount.js';
import { getEndgameMessage } from '../src/app/endgame-view.js';
import { mountGame } from '../src/app/game-mount.js';
import { CreateGamePanel } from '../src/app/create-game-panel.js';
import type { GambitClient } from '../src/api/client.js';
import type { AttemptResultView, StepView } from '../src/api/models.js';
import { FakeTransport, json } from './support/fake-transport.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { makeState, sampleAnalysisResponse } from './support/analysis-fixtures.js';
import { STARTING_FEN } from '../src/core/position.js';
import { RateLimitError, ServiceUnavailableError } from '../src/net/errors.js';

const CAPABILITIES = { capabilities: { analysis: true, mistakePrediction: true, openingExplorer: true, puzzleGeneration: true, coach: true }, analysisVariants: ['standard'], puzzleVariants: ['standard'] };

function locale(): I18n {
  return new I18n({ catalogs: { ar: Object.fromEntries(Object.entries(enMessages).map(([k, v]) => [k, `AR ${v}`])) as MessagesCatalog } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function documentWith(ids: readonly string[]) {
  const elements = new Map(ids.map((id) => [id, new FakeElement(id.includes('form') ? 'form' : 'div', id)]));
  return { elements, doc: createFakeDoc(elements) };
}

test('correction: blocked storage getter still permits default composition and bootstrap', () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('SecurityError'); } });
  try {
    const storage = new LocaleStorage();
    assert.equal(storage.load(), 'en');
    assert.doesNotThrow(() => { storage.save('ar'); storage.clear(); });
    const { doc } = documentWith([]);
    const app = createApp({ doc, config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' } });
    assert.equal(app.i18n.locale, 'en');
    app.i18n.registerCatalog('ar', enMessages);
    app.i18n.setLocale('ar');
    assert.equal(app.i18n.locale, 'ar');
    app.dispose();
    const shell = bootstrap(doc, { config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' }, httpTransport: new FakeTransport().onEach(() => json(200, CAPABILITIES)) });
    shell.auth.dispose();
    shell.shellLocalization?.dispose();
    shell.app.dispose();
  } finally {
    if (old) Object.defineProperty(globalThis, 'localStorage', old);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

for (const kind of ['move', 'text', 'quiz'] as const) {
  test(`correction: lesson ${kind} pending controls and duplicate guard survive locale and settlement`, async () => {
    const { elements, doc } = documentWith(['lesson-title', 'lesson-progress', 'step-list', 'lesson-error']);
    const surface = doc.createElement('section');
    for (const el of elements.values()) surface.appendChild(el as unknown as HTMLElement);
    const oldDoc = globalThis.document;
    globalThis.document = doc;
    const attempt = deferred<AttemptResultView>();
    let calls = 0;
    const step = { id: 's1', lessonId: 'l1', orderIndex: 0, kind, fen: STARTING_FEN, hint: null, prose: 'Read', question: 'Choose', options: ['A', 'B'], active: true } as unknown as StepView;
    const client = { session: { isAuthenticated: false }, learning: {
      lesson: async () => ({ id: 'l1', courseId: 'c1', title: 'Lesson' }), steps: async () => [step],
      attempt: () => { calls++; return attempt.promise; },
    } } as unknown as GambitClient;
    const i18n = locale();
    const mounted = mountLesson({ doc, surface, client, lessonId: 'l1', sessionPresent: true, restorePromise: Promise.resolve(), i18n });
    try {
      await settle();
      const list = elements.get('step-list')!;
      const invoke = () => {
        if (kind === 'move') list.querySelector('form')!.dispatchEvent({ type: 'submit' });
        else list.querySelector('button')!.dispatchEvent({ type: 'click' });
      };
      if (kind === 'move') {
        const input = list.querySelector('input')!;
        input.value = 'Nf3';
        input.focus();
        input.setSelectionRange(1, 2, 'backward');
      }
      invoke();
      assert.equal(calls, 1);
      assert.ok(list.querySelectorAll('button').every((b) => b.disabled));
      i18n.setLocale('ar');
      assert.ok(list.querySelectorAll('button').every((b) => b.disabled), 'replacement actions must remain pending');
      if (kind === 'move') assert.equal(list.querySelector('input')!.disabled, true);
      if (kind !== 'move') invoke(); // bypass disabled UI to prove the action guard.
      assert.equal(calls, 1, 'event layer rejects duplicates');
      attempt.resolve({ stepId: 's1', correct: true, attempts: 1 });
      await settle();
      assert.ok(list.querySelectorAll('button').every((b) => !b.disabled), 'CURRENT controls unlock');
      if (kind === 'move') { assert.equal(list.querySelector('input')!.disabled, false); assert.equal(list.querySelector('input')!.value, 'Nf3'); }
      const finalText = list.textContent;
      mounted.dispose();
      i18n.setLocale('en');
      assert.equal(list.textContent, finalText);
    } finally { mounted.dispose(); globalThis.document = oldDoc; }
  });
}

test('correction: real assessment failure retains its semantic identity across locales', async () => {
  const g = await gameSetup({ predictMistake: async () => { throw new ServiceUnavailableError({ status: 503, code: 'unavailable', message: 'Unavailable', retryable: true }); } });
  try {
    g.sockets.last.emit({ t: 'move', gameId: 'g-test-1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w', fenHash: 'h1', clock: { w: 59000, b: 60000 }, serverTs: 1, legalMoves: {} });
    g.elements.get('assess-run')!.click(); await settle();
    assert.equal(g.elements.get('assess-note')!.textContent, g.i18n.t('ai.assess.unavailable'));
    g.i18n.setLocale('ar');
    assert.equal(g.elements.get('assess-note')!.textContent, g.i18n.t('ai.assess.unavailable'));
    g.i18n.setLocale('en');
    assert.equal(g.elements.get('assess-note')!.textContent, g.i18n.t('ai.assess.unavailable'));
  } finally { g.dispose(); }
});

test('correction: pending verification relocalizes without another request', async () => {
  const { doc, elements } = documentWith(['email-verify', 'email-verify-status', 'email-verify-error', 'email-verify-retry']);
  const response = deferred<{ ok: boolean }>();
  let calls = 0;
  const client = { auth: { verifyEmail: () => { calls++; return response.promise; } } } as unknown as GambitClient;
  const i18n = locale();
  const mounted = mountEmailVerification({ doc, client, verificationToken: 'token', i18n });
  try {
    assert.equal(elements.get('email-verify-status')!.textContent, i18n.t('emailVerification.verifyingStatus'));
    i18n.setLocale('ar');
    assert.equal(elements.get('email-verify-status')!.textContent, i18n.t('emailVerification.verifyingStatus'));
    assert.equal(calls, 1);
    response.resolve({ ok: true }); await settle();
    assert.equal(elements.get('email-verify-status')!.textContent, i18n.t('emailVerification.verified'));
  } finally { mounted.dispose(); }
});

test('correction: create-game variant labels change without resetting selection', () => {
  const { doc } = documentWith([]);
  const mount = doc.createElement('section');
  const i18n = locale();
  const panel = new CreateGamePanel({ doc, mount, initialAuthenticated: true, i18n, callbacks: { onSubmit: async () => true, onError: () => {} } });
  try {
    const radio = mount.querySelector<HTMLInputElement>('input[name="cg-variant"][value="crazyhouse"]')!;
    radio.checked = true;
    const label = radio.closest('label')!.querySelector('.cg-option-label')!;
    i18n.setLocale('ar');
    assert.equal(label.textContent, i18n.t('variant.crazyhouse'));
    assert.equal(radio.checked, true);
  } finally { panel.dispose(); }
});

for (const note of ['loading', 'judging', 'rateLimited', 'unavailable'] as const) {
  test(`correction: endgame authentication display preserves ${note} semantic status`, async () => {
    const { doc, elements } = documentWith(['endgame-next', 'endgame-submit', 'endgame-move', 'endgame-form', 'endgame-note', 'endgame-error', 'endgame-result', 'endgame-rows', 'endgame-position-rows']);
    let authenticated = true;
    let calls = 0;
    const pending = deferred<unknown>();
    const position = { id: 'p1', type: 'KQ_vs_K', name: 'Mate', fen: STARTING_FEN, sideToMove: 'w', objective: 'mate', difficulty: 'beginner', technique: 'Box' };
    const client = { analysis: {
      nextEndgame: () => { calls++; return note === 'loading' ? pending.promise : Promise.resolve(position); },
      attemptEndgame: () => {
        calls++;
        if (note === 'rateLimited') throw new RateLimitError({ status: 429, code: 'rate-limited', message: 'Too many', retryable: true });
        if (note === 'unavailable') throw new ServiceUnavailableError({ status: 503, code: 'unavailable', message: 'Unavailable', retryable: true });
        return pending.promise;
      },
    } } as unknown as GambitClient;
    const i18n = locale();
    const mounted = mountEndgames({ doc, client, isAuthenticated: () => authenticated, i18n });
    try {
      elements.get('endgame-next')!.click(); await settle();
      if (note !== 'loading') {
        elements.get('endgame-move')!.value = 'e2e4';
        elements.get('endgame-form')!.dispatchEvent({ type: 'submit' }); await settle();
      }
      assert.equal(elements.get('endgame-note')!.textContent, getEndgameMessage(note, i18n));
      const initialCalls = calls;
      authenticated = false; mounted.onSessionChange();
      i18n.setLocale('ar');
      assert.equal(elements.get('endgame-note')!.textContent, getEndgameMessage('signedOut', i18n));
      authenticated = true; mounted.onSessionChange();
      assert.equal(elements.get('endgame-note')!.textContent, getEndgameMessage(note, i18n));
      i18n.setLocale('en');
      assert.equal(elements.get('endgame-note')!.textContent, getEndgameMessage(note, i18n));
      assert.equal(calls, initialCalls, 'authentication and locale replay must not restart the request');
      if (note === 'loading') {
        pending.resolve(position); await settle();
        assert.equal(elements.get('endgame-note')!.textContent, getEndgameMessage('yourMove', i18n));
      } else if (note === 'judging') {
        pending.resolve({ kind: 'terminal', id: 'p1', move: 'e2e4', fenAfter: STARTING_FEN, terminal: { reason: 'checkmate', result: '1-0' } }); await settle();
        assert.equal(elements.get('endgame-note')!.hidden, true);
      }
    } finally { mounted.dispose(); }
  });
}

for (const outcome of ['terminal', 'judged', 'failed'] as const) {
  test(`correction: endgame sign-out overrides ${outcome} presentation and relocalizes`, async () => {
    const { doc, elements } = documentWith(['endgame-next', 'endgame-submit', 'endgame-move', 'endgame-form', 'endgame-note', 'endgame-error', 'endgame-result', 'endgame-rows', 'endgame-position-rows']);
    let authenticated = true;
    const client = { analysis: {
      nextEndgame: async () => ({ id: 'p1', type: 'KQ_vs_K', name: 'Mate', fen: STARTING_FEN, sideToMove: 'w', objective: 'mate', difficulty: 'beginner', technique: 'Box' }),
      attemptEndgame: async () => {
        if (outcome === 'failed') throw new Error('move failed');
        return outcome === 'terminal'
          ? { kind: 'terminal', id: 'p1', move: 'e2e4', fenAfter: STARTING_FEN, terminal: { reason: 'checkmate', result: '1-0' } }
          : { kind: 'judged', id: 'p1', move: 'e2e4', fenAfter: STARTING_FEN, classification: 'acceptable', goalPreserved: true, evalBefore: { type: 'cp', value: 50 }, evalAfter: { type: 'cp', value: 50 }, loss: { kind: 'centipawns', value: 0 }, betterMove: 'e2e4', bestLine: [], depth: 16 };
      },
    } } as unknown as GambitClient;
    const i18n = locale();
    const mounted = mountEndgames({ doc, client, isAuthenticated: () => authenticated, i18n });
    try {
      elements.get('endgame-next')!.click(); await settle();
      elements.get('endgame-move')!.value = 'e2e4';
      elements.get('endgame-form')!.dispatchEvent({ type: 'submit' }); await settle();
      if (outcome === 'judged') assert.equal(elements.get('endgame-note')!.textContent, i18n.t('learning.endgames.msgYourMove'));
      authenticated = false;
      mounted.onSessionChange();
      assert.equal(elements.get('endgame-note')!.textContent, i18n.t('learning.endgames.msgSignedOut'));
      assert.equal(elements.get('endgame-submit')!.disabled, true);
      i18n.setLocale('ar');
      assert.equal(elements.get('endgame-note')!.textContent, i18n.t('learning.endgames.msgSignedOut'));
      authenticated = true;
      mounted.onSessionChange();
      assert.doesNotMatch(elements.get('endgame-note')!.textContent, /Sign in|AR Sign in/);
      if (outcome === 'terminal') assert.equal(elements.get('endgame-note')!.hidden, true);
      if (outcome === 'failed') assert.equal(elements.get('endgame-error')!.hidden, false);
    } finally { mounted.dispose(); }
  });
}

test('correction: final endgame verdict never revives judging on locale change', async () => {
  const { doc, elements } = documentWith(['endgame-next', 'endgame-submit', 'endgame-move', 'endgame-form', 'endgame-note', 'endgame-error', 'endgame-result', 'endgame-rows', 'endgame-position-rows', 'endgame-board']);
  const response = deferred<unknown>();
  const client = { analysis: {
    nextEndgame: async () => ({ id: 'p1', type: 'KQ_vs_K', name: 'Mate', fen: STARTING_FEN, sideToMove: 'w', objective: 'mate', difficulty: 'beginner', technique: 'Box' }),
    attemptEndgame: () => response.promise,
  } } as unknown as GambitClient;
  const i18n = locale();
  const mounted = mountEndgames({ doc, client, isAuthenticated: () => true, i18n });
  try {
    elements.get('endgame-next')!.click(); await settle();
    elements.get('endgame-move')!.value = 'e2e4';
    elements.get('endgame-form')!.dispatchEvent({ type: 'submit' });
    assert.match(elements.get('endgame-note')!.textContent, /Checking/);
    response.resolve({ kind: 'terminal', id: 'p1', move: 'e2e4', fenAfter: STARTING_FEN, classification: 'optimal', goalPreserved: true, terminal: { reason: 'checkmate', result: '1-0' } });
    await settle();
    i18n.setLocale('ar');
    assert.doesNotMatch(elements.get('endgame-note')!.textContent, /Checking/);
    assert.equal(elements.get('endgame-result')!.hidden, false);
    assert.equal(elements.get('endgame-note')!.hidden, true, 'verdict owns final presentation');
  } finally { mounted.dispose(); }
});

const GAME_IDS = ['board', 'status', 'flip', 'analysis', 'analysis-run', 'analysis-lines', 'analysis-note', 'analysis-error', 'analysis-results', 'analysis-reached', 'analysis-limits', ...['assess', 'opening', 'puzzle', 'coach'].flatMap((p) => [p, `${p}-run`, `${p}-note`, `${p}-error`, `${p}-rows`, `${p}-result`])];
async function gameSetup(analysis: Record<string, unknown> = {}) {
  const { doc, elements } = documentWith(GAME_IDS);
  const i18n = locale();
  const sockets = new FakeSocketFactory();
  const app = createApp({ config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' }, wsFactory: sockets.factory, i18n });
  const client = { session: { current: null }, predictMistake: analysis['predictMistake'], capabilities: async () => CAPABILITIES, analysis } as unknown as GambitClient;
  const mounted = mountGame({ doc, boardEl: elements.get('board')! as unknown as HTMLElement, gameId: 'g-test-1', createGameSync: app.createGameSync, createGameOracle: app.createGameOracle, getAccessToken: () => 'token', client, token: 'token', restorePromise: Promise.resolve(null), i18n });
  sockets.last.open();
  sockets.last.emit({ t: 'joined', gameId: 'g-test-1', role: 'white', state: makeState(STARTING_FEN) });
  await settle();
  return { elements, i18n, sockets, mounted, dispose: () => { mounted.controller.dispose(); mounted.board.dispose(); mounted.connectivity.dispose(); mounted.analysis.dispose(); app.dispose(); } };
}

test('correction: assessment control refresh updates semantic note before another locale change', async () => {
  const g = await gameSetup();
  try {
    assert.equal(g.elements.get('assess-note')!.textContent, g.i18n.t('ai.assess.noMove'));
    g.i18n.setLocale('ar');
    g.sockets.last.emit({ t: 'move', gameId: 'g-test-1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w', fenHash: 'h1', clock: { w: 59000, b: 60000 }, serverTs: 1, legalMoves: {} });
    assert.equal(g.elements.get('assess-note')!.textContent, g.i18n.t('ai.assess.idle'));
    g.i18n.setLocale('en');
    assert.equal(g.elements.get('assess-note')!.textContent, g.i18n.t('ai.assess.idle'));
  } finally { g.dispose(); }
});

test('correction: analysis pending notice and completed labels relocalize without rerunning', async () => {
  const result = deferred<ReturnType<typeof sampleAnalysisResponse>>();
  let calls = 0;
  const g = await gameSetup({ analyse: () => { calls++; return result.promise; } });
  try {
    g.elements.get('analysis-run')!.click();
    assert.equal(calls, 1);
    g.i18n.setLocale('ar');
    assert.equal(g.elements.get('analysis-note')!.textContent, g.i18n.t('game.analysis.loading'));
    result.resolve(sampleAnalysisResponse()); await settle();
    g.i18n.setLocale('en');
    assert.match(g.elements.get('analysis-reached')!.textContent, /^Reached depth/);
    g.i18n.setLocale('ar');
    assert.match(g.elements.get('analysis-reached')!.textContent, /^AR /);
    assert.match(g.elements.get('analysis-limits')!.textContent, /^AR /);
    assert.equal(calls, 1);
    g.sockets.last.emit({ t: 'state', gameId: 'g-test-1', state: makeState('8/8/8/8/8/8/4K3/7k w - - 0 1') });
    g.i18n.setLocale('en');
    assert.equal(g.elements.get('analysis-reached')!.hidden, true, 'invalidated result stays cleared');
  } finally { g.dispose(); }
});

for (const feature of ['opening', 'puzzle', 'coach'] as const) {
  test(`correction: ${feature} empty-result note relocalizes`, async () => {
    const responses = {
      opening: { moves: ['e2e4'], found: false, eco: null, name: null, matchedMoves: 0, outOfBook: false, continuations: [] },
      puzzle: { kind: 'no_tactic', fen: STARTING_FEN, variant: 'standard', evidence: { kind: 'centipawn_gap', gapCp: 80 }, bestMove: 'e2e4', comparisonMove: 'd2d4', bestEvaluation: { type: 'cp', value: 120 }, comparisonEvaluation: { type: 'cp', value: 40 }, depth: 16 },
      coach: { fen: STARTING_FEN, variant: 'standard', move: null, mistake: { kind: 'omitted', reason: 'not_requested' }, explanation: { kind: 'omitted', reason: 'not_requested' }, opening: { kind: 'omitted', reason: 'not_requested' }, puzzle: { kind: 'omitted', reason: 'not_requested' }, endgame: { kind: 'omitted', reason: 'not_requested' }, featuresFired: [] },
    };
    const pending = deferred<unknown>();
    let calls = 0;
    const request = () => { calls++; return calls === 1 ? Promise.resolve(responses[feature]) : pending.promise; };
    const g = await gameSetup({ exploreOpening: request, findPuzzle: request, coach: request });
    try {
      g.sockets.last.emit({ t: 'move', gameId: 'g-test-1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w', fenHash: 'h1', clock: { w: 59000, b: 60000 }, serverTs: 1, legalMoves: {} });
      g.elements.get(`${feature}-run`)!.click(); await settle();
      const note = g.elements.get(`${feature}-note`)!;
      const before = note.textContent;
      assert.equal(calls, 1);
      assert.ok(before.length > 0);
      g.i18n.setLocale('ar');
      assert.equal(note.textContent, `AR ${before}`);
      assert.equal(calls, 1, 'translation never reruns the request');
      g.elements.get(`${feature}-run`)!.click();
      assert.equal(calls, 2);
      assert.equal(note.textContent, g.i18n.t(`ai.${feature}.running`));
      g.i18n.setLocale('en');
      assert.equal(note.textContent, g.i18n.t(`ai.${feature}.running`), 'cached result must not suppress new pending state');
      g.dispose();
      const disposedText = note.textContent;
      pending.resolve(responses[feature]); await settle();
      g.i18n.setLocale('ar');
      assert.equal(note.textContent, disposedText, 'detached mount stops reacting');
    } finally { g.dispose(); }
  });
}

test('correction: completed analysis metadata survives locale replay', async () => {
  let calls = 0;
  const g = await gameSetup({ analyse: async () => { calls++; return sampleAnalysisResponse(); } });
  try {
    g.elements.get('analysis-run')!.click(); await settle();
    assert.equal(calls, 1);
    g.i18n.setLocale('ar');
    assert.match(g.elements.get('analysis-reached')!.textContent, /^AR /);
    assert.match(g.elements.get('analysis-limits')!.textContent, /^AR /);
    assert.equal(calls, 1);
  } finally { g.dispose(); }
});

test('correction: unavailable lesson keeps its current outcome during locale replay', async () => {
  const { doc, elements } = documentWith(['step-list']);
  const surface = doc.createElement('section');
  surface.appendChild(elements.get('step-list')! as unknown as HTMLElement);
  const oldDoc = globalThis.document;
  globalThis.document = doc;
  const client = { session: { isAuthenticated: false }, learning: {
    lesson: async () => ({ id: 'l1', courseId: 'c1', title: 'Lesson' }),
    steps: async () => [{ id: 's1', kind: 'text', orderIndex: 0, active: true, prose: 'Read' }],
    attempt: async () => { throw new ServiceUnavailableError({ status: 503, code: 'unavailable', message: 'Unavailable', retryable: false }); },
  } } as unknown as GambitClient;
  const i18n = locale();
  const mounted = mountLesson({ doc, surface, client, lessonId: 'l1', sessionPresent: true, restorePromise: Promise.resolve(), i18n });
  try {
    await settle();
    elements.get('step-list')!.querySelector('button')!.click(); await settle();
    assert.equal(surface.textContent, i18n.t('learning.serviceUnavailable'));
    i18n.setLocale('ar');
    assert.equal(surface.textContent, i18n.t('learning.serviceUnavailable'));
    assert.equal(surface.querySelector('button'), null);
  } finally { mounted.dispose(); globalThis.document = oldDoc; }
});

test('correction: analysis failure notice remains translated across later locale changes', async () => {
  const response = deferred<ReturnType<typeof sampleAnalysisResponse>>();
  const g = await gameSetup({ analyse: () => response.promise });
  try {
    g.elements.get('analysis-run')!.click();
    g.i18n.setLocale('ar');
    response.reject(new ServiceUnavailableError({ status: 503, code: 'unavailable', message: 'Unavailable', retryable: true }));
    await settle();
    assert.equal(g.elements.get('analysis-note')!.textContent, g.i18n.t('game.analysis.unavailable'));
    g.i18n.setLocale('en');
    assert.equal(g.elements.get('analysis-note')!.textContent, g.i18n.t('game.analysis.unavailable'));
  } finally { g.dispose(); }
});

test('correction: disposed lesson ignores old controls and an in-flight completion', async () => {
  const { doc, elements } = documentWith(['step-list', 'lesson-progress']);
  const surface = doc.createElement('section');
  for (const el of elements.values()) surface.appendChild(el as unknown as HTMLElement);
  const oldDoc = globalThis.document;
  globalThis.document = doc;
  const answer = deferred<AttemptResultView>();
  let calls = 0;
  const client = { session: { isAuthenticated: false }, learning: {
    lesson: async () => ({ id: 'l1', courseId: 'c1', title: 'Lesson' }),
    steps: async () => [{ id: 's1', kind: 'text', orderIndex: 0, active: true, prose: 'Read' }],
    attempt: () => { calls++; return answer.promise; },
  } } as unknown as GambitClient;
  const i18n = locale();
  const mounted = mountLesson({ doc, surface, client, lessonId: 'l1', sessionPresent: true, restorePromise: Promise.resolve(), i18n });
  try {
    await settle();
    const btn = elements.get('step-list')!.querySelector('button')!;
    btn.click();
    mounted.dispose();
    const snapshot = surface.textContent;
    answer.resolve({ stepId: 's1', correct: true, attempts: 1 }); await settle();
    btn.dispatchEvent({ type: 'click' });
    i18n.setLocale('ar');
    assert.equal(calls, 1);
    assert.equal(surface.textContent, snapshot);
    assert.equal(btn.disabled, true, 'settlement cannot modify disposed controls');
  } finally { mounted.dispose(); globalThis.document = oldDoc; }
});

test('correction: idle lesson draft focus and selection survive mounted locale change', async () => {
  const { doc, elements } = documentWith(['step-list']);
  const surface = doc.createElement('section');
  surface.appendChild(elements.get('step-list')! as unknown as HTMLElement);
  const oldDoc = globalThis.document;
  globalThis.document = doc;
  const client = { session: { isAuthenticated: false }, learning: {
    lesson: async () => ({ id: 'l1', courseId: 'c1', title: 'Lesson' }),
    steps: async () => [{ id: 's1', kind: 'move', orderIndex: 0, active: true, fen: STARTING_FEN }],
  } } as unknown as GambitClient;
  const i18n = locale();
  const mounted = mountLesson({ doc, surface, client, lessonId: 'l1', sessionPresent: true, restorePromise: Promise.resolve(), i18n });
  try {
    await settle();
    const input = elements.get('step-list')!.querySelector('input')!;
    input.value = 'Nf3'; input.focus(); input.setSelectionRange(1, 2, 'backward');
    i18n.setLocale('ar');
    const next = elements.get('step-list')!.querySelector('input')!;
    assert.ok((doc.activeElement as unknown) === next, 'focus follows the current visible control');
    assert.deepEqual([next.value, next.selectionStart, next.selectionEnd, next.selectionDirection], ['Nf3', 1, 2, 'backward']);
  } finally { mounted.dispose(); globalThis.document = oldDoc; }
});

test('correction: mounted study locale replay preserves selected node, aria-current and focus', async () => {
  const { doc, elements } = documentWith(['chapter-tree', 'chapter-name', 'chapter-study-link']);
  const surface = doc.createElement('section');
  const oldDoc = globalThis.document;
  globalThis.document = doc;
  const chapter = { id: 'c1', name: 'Chapter', startingFen: STARTING_FEN };
  const client = { studies: {
    study: async () => ({ id: 's1', name: 'Study', variant: 'standard', visibility: 'public' }),
    chapterDetail: async () => ({ chapter, tree: [{ id: 'n1', chapterId: 'c1', fenAfter: STARTING_FEN, san: 'e4', parentId: null, nags: [], orderIndex: 0 }] }),
    chapters: async () => ({ items: [chapter] }), exportPgnUrl: () => '/export',
  } } as unknown as GambitClient;
  const i18n = locale();
  const mounted = mountStudyChapter({ doc, surface, client, studyId: 's1', chapterId: 'c1', i18n });
  try {
    await settle();
    const tree = elements.get('chapter-tree')!;
    const btn = tree.querySelector('[data-node-id="n1"]')!;
    btn.click(); btn.focus();
    i18n.setLocale('ar');
    const next = tree.querySelector('[data-node-id="n1"]')!;
    assert.equal(next.getAttribute('aria-current'), 'true');
    assert.ok((doc.activeElement as unknown) === next, 'focus follows the current visible control');
    assert.match(next.getAttribute('aria-label')!, /AR /);
  } finally { mounted.studies.dispose(); mounted.board?.dispose(); globalThis.document = oldDoc; }
});
