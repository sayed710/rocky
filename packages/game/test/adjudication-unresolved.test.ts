/**
 * Issue #124: a proof that runs out of resources concludes `unresolved`. It never declares a dead
 * position, so settlement applies the ordinary rules, exactly as the game does without proofs, and
 * replay accepts exactly that recorded form.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Game,
  GameError,
  prepareFlagExpiry,
  prepareMove,
  type AdjudicationStartedEvent,
  type GameEvent,
  type PreparedOperation,
} from '../src';
import { AdjudicationJobController } from '../src/adjudication-controller';

const PLAYERS = { white: 'alice', black: 'bob' };
const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;

function startedFor(game: Game, op: PreparedOperation): AdjudicationStartedEvent {
  return {
    type: 'AdjudicationStarted', gameId: game.id, operationId: op.operationId, baseRevision: op.baseRevision,
    at: op.at, rulesVersion: op.rulesVersion, prepared: op,
  };
}

/** Step to a final state, concluding each exhausted question as unresolved; returns how many were. */
function proveOrConclude(ctrl: AdjudicationJobController, operationId: string): number {
  let concluded = 0;
  for (let i = 0; i < 200_000; i++) {
    const status = ctrl.getJob(operationId)!.status;
    if (status === 'ready') return concluded;
    if (status === 'resource_limit') {
      ctrl.concludeUnresolved(operationId);
      concluded += 1;
      continue;
    }
    ctrl.stepJob(operationId, 100);
  }
  throw new Error('proof did not finish');
}

test('an exhausted move proof settles as an ordinary move and replays', () => {
  const created = Game.create({ gameId: 'g-unresolved', players: PLAYERS, timeControl: TC, rated: false, at: 1000 });
  const op = prepareMove(created.game, { uci: 'e2e4', at: 2000, operationId: 'op-e4', rulesVersion: '1.0.0' });
  const ctrl = new AdjudicationJobController();
  ctrl.createJob(op, created.game);
  const concluded = proveOrConclude(ctrl, op.operationId);
  assert.ok(concluded >= 1, 'the opening position exhausts the bounded search');

  const proving = created.game.withEvents([startedFor(created.game, op)]);
  const settlement = ctrl.settleJob(proving, op.operationId, 2100);
  assert.deepEqual(settlement.batch.map((e) => e.type), ['AdjudicationResolved', 'MovePlayed']);
  assert.equal(settlement.resolved.evidence?.base?.status, 'unresolved');
  assert.ok(!settlement.batch.some((e) => e.type === 'GameEnded'), 'no dead-position ending is declared');
  assert.equal(settlement.game.ply, 1);

  const history: GameEvent[] = [...created.events, startedFor(created.game, op), ...settlement.batch];
  assert.deepEqual(Game.fromEvents(history).snapshot(), settlement.game.snapshot());

  // Replay accepts exactly the recorded unresolved form and nothing looser.
  const resolved = settlement.resolved;
  const tamper = (base: object) => [...created.events, startedFor(created.game, op),
    { ...resolved, evidence: { ...resolved.evidence, base } } as GameEvent, ...settlement.batch.slice(1)];
  assert.throws(() => Game.fromEvents(tamper({ status: 'unresolved', reason: 'timeout' })), GameError);
  assert.throws(() => Game.fromEvents(tamper({ status: 'unresolved', reason: 'resource_limit', extra: 1 })), GameError);
});

test('an exhausted flag proof settles as an ordinary loss on time', () => {
  const created = Game.create({ gameId: 'g-flag', players: PLAYERS, timeControl: TC, rated: false, at: 1000 });
  const afterW = created.game.move('e2e4', 2000);
  const afterB = afterW.game.move('e7e5', 3000);
  const flagAt = 3000 + 60_000 + 10;
  assert.equal(afterB.game.timeoutDue(flagAt), true);
  const op = prepareFlagExpiry(afterB.game, { flagged: 'w', at: flagAt, operationId: 'op-flag', rulesVersion: '1.0.0' });
  const ctrl = new AdjudicationJobController();
  ctrl.createJob(op, afterB.game);
  assert.ok(proveOrConclude(ctrl, op.operationId) >= 1);
  const proving = afterB.game.withEvents([startedFor(afterB.game, op)]);
  const settlement = ctrl.settleJob(proving, op.operationId, flagAt + 5);
  const ended = settlement.batch.at(-1)!;
  assert.equal(ended.type, 'GameEnded');
  assert.deepEqual(
    ended.type === 'GameEnded' ? { result: ended.result, termination: ended.termination } : null,
    { result: '0-1', termination: 'timeout' },
  );
  const history: GameEvent[] = [...created.events, ...afterW.events, ...afterB.events, startedFor(afterB.game, op), ...settlement.batch];
  assert.deepEqual(Game.fromEvents(history).snapshot(), settlement.game.snapshot());
});

test('only an exhausted job can be concluded unresolved', () => {
  const created = Game.create({ gameId: 'g-guard', players: PLAYERS, timeControl: TC, rated: false, at: 1000 });
  const op = prepareMove(created.game, { uci: 'e2e4', at: 2000, operationId: 'op-guard', rulesVersion: '1.0.0' });
  const ctrl = new AdjudicationJobController();
  ctrl.createJob(op, created.game);
  assert.equal(ctrl.getJob(op.operationId)!.status, 'active');
  assert.throws(() => ctrl.concludeUnresolved(op.operationId), GameError);
  assert.throws(() => ctrl.concludeUnresolved('missing'), GameError);
});

test('an unresolved flag falls back to the unmanaged rule: a lone-king winner draws, never wins', () => {
  // Black flags on move with only a king against White's rook: White can mate, Black cannot.
  const fen = '4k3/8/8/8/8/8/8/4K2R w - - 0 1';
  const created = Game.create({ gameId: 'g-lone', players: PLAYERS, timeControl: TC, rated: false, at: 1000, initialFen: fen });
  const afterW = created.game.move('h1h2', 2000);
  const afterB = afterW.game.move('e8e7', 3000);
  const afterW2 = afterB.game.move('h2h3', 4000);
  // Black to move flags; the winner would be White, who can mate: an unresolved proof is a loss.
  const flagAt = 4000 + 60_000 - 1000 + 10;
  assert.equal(afterW2.game.timeoutDue(flagAt), true);
  const op = prepareFlagExpiry(afterW2.game, { flagged: 'b', at: flagAt, operationId: 'op-lone', rulesVersion: '1.0.0' });
  const ctrl = new AdjudicationJobController();
  ctrl.createJob(op, afterW2.game);
  proveOrConclude(ctrl, op.operationId);
  const proving = afterW2.game.withEvents([startedFor(afterW2.game, op)]);
  const settlement = ctrl.settleJob(proving, op.operationId, flagAt + 5);
  const prefix: GameEvent[] = [...created.events, ...afterW.events, ...afterB.events, ...afterW2.events, startedFor(afterW2.game, op)];
  const resolved = settlement.resolved;
  const asUnresolved = (winner: 'w' | 'b') => ({
    ...resolved,
    evidence: { ...resolved.evidence, timeout: { winner, outcome: { status: 'unresolved', reason: 'resource_limit' } } },
  }) as GameEvent;
  const ended = (result: string, termination: string, winner: 'w' | 'b' | null) =>
    ({ type: 'GameEnded', result, termination, winner, at: flagAt + 5 }) as GameEvent;

  // White can mate: unresolved settles as White's win on time, and only that.
  assert.equal(Game.fromEvents([...prefix, asUnresolved('w'), ended('1-0', 'timeout', 'w')]).status.over, true);
  assert.throws(() => Game.fromEvents([...prefix, asUnresolved('w'), ended('1/2-1/2', 'insufficient_material', null)]), GameError);

  // White flags instead, so the winner would be Black's lone king: unresolved is a draw, never a win.
  const whiteFlagAt = 3000 + 60_000 + 10;
  assert.equal(afterB.game.timeoutDue(whiteFlagAt), true);
  const opW = prepareFlagExpiry(afterB.game, { flagged: 'w', at: whiteFlagAt, operationId: 'op-lone-w', rulesVersion: '1.0.0' });
  const ctrlW = new AdjudicationJobController();
  ctrlW.createJob(opW, afterB.game);
  proveOrConclude(ctrlW, opW.operationId);
  const settledW = ctrlW.settleJob(afterB.game.withEvents([startedFor(afterB.game, opW)]), opW.operationId, whiteFlagAt + 5);
  const prefixW: GameEvent[] = [...created.events, ...afterW.events, ...afterB.events, startedFor(afterB.game, opW)];
  const unresolvedB = {
    ...settledW.resolved,
    evidence: { ...settledW.resolved.evidence, timeout: { winner: 'b', outcome: { status: 'unresolved', reason: 'resource_limit' } } },
  } as GameEvent;
  const draw = Game.fromEvents([...prefixW, unresolvedB, { type: 'GameEnded', result: '1/2-1/2', termination: 'insufficient_material', winner: null, at: whiteFlagAt + 5 } as GameEvent]);
  assert.deepEqual(draw.status, { over: true, result: '1/2-1/2', termination: 'insufficient_material', winner: null });
  assert.throws(() => Game.fromEvents([...prefixW, unresolvedB, { type: 'GameEnded', result: '0-1', termination: 'timeout', winner: 'b', at: whiteFlagAt + 5 } as GameEvent]), GameError);
});
