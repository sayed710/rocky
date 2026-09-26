/** The games fold over readiness and no-show events (ADR-0148, ADR-0147). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, type GameEvent, type TimeControl } from '@chess-platform/game';
import { projectGameStream } from '../src/games-projection';
import type { StoredEvent } from '../src/event-store';

const TC: TimeControl = { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 };

function stored(events: readonly GameEvent[]): StoredEvent[] {
  return events.map((event, seq) => ({ gameId: 'g', seq, version: 1, event, serverTs: 0 }));
}

test('readiness advances last_seq but never ply_count; a no-show ending projects its result and cause', () => {
  const created = Game.create({ gameId: 'g', timeControl: TC, players: { white: 'w', black: 'b' }, at: 1_000, source: 'tournament' });
  const ready = created.game.markReady('w', 2_000);
  const ended = ready.game.expireNoShow(300_000, 301_000);
  const row = projectGameStream('g', stored([...created.events, ...ready.events, ...ended.events]));
  assert.equal(row.source, 'tournament');
  assert.equal(row.plyCount, 0);
  assert.equal(row.lastSeq, 2);
  assert.equal(row.result, '1-0');
  assert.equal(row.termination, 'no_show');
  assert.deepEqual(row.endedAt, new Date(301_000));
});

test('a game without a source projects a NULL source, and an unknown stored source is corrupt', () => {
  const legacy = Game.create({ gameId: 'g', timeControl: TC, players: { white: 'w', black: 'b' }, at: 1_000 }).events;
  assert.equal(projectGameStream('g', stored(legacy)).source, null);
  const forged = [{ ...legacy[0]!, source: 'lobby' } as unknown as GameEvent];
  assert.throws(() => projectGameStream('g', stored(forged)), /unknown source/);
});
