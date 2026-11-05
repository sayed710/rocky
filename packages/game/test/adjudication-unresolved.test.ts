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
