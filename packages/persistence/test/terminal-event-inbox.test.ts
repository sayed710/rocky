import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryTerminalEventInbox } from '../src/in-memory-terminal-event-inbox';
import { terminalDeadline, terminalRetryDelay, TERMINAL_LEASE_MS, TERMINAL_MAX_FAILURES, TERMINAL_RETRY_BASE_MS, TERMINAL_RETRY_CAP_MS } from '../src/terminal-event-retry';
import type { TerminalEventWork } from '../src/event-store';

const work: TerminalEventWork[] = [{ gameId: 'poison', seq: 0, decodeError: 'corrupt' }];

test('deterministic backoff grows, caps, and rejects unsafe arithmetic', () => {
  assert.deepEqual([1, 2, 3, 8, 9, 10, TERMINAL_MAX_FAILURES].map(terminalRetryDelay),
    [120_000, 240_000, 480_000, 15_360_000, 21_600_000, 21_600_000, 21_600_000]);
  for (const invalid of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => terminalRetryDelay(invalid));
  const maxNow = 8_640_000_000_000_000 - TERMINAL_RETRY_CAP_MS;
  assert.equal(terminalDeadline(maxNow, TERMINAL_RETRY_CAP_MS), 8_640_000_000_000_000);
  for (const invalid of [-1, NaN, maxNow + 1]) assert.throws(() => terminalDeadline(invalid, TERMINAL_RETRY_BASE_MS));
});

test('fake claims enforce expiry, independent consumers, fencing, due-time and receipt cleanup', async () => {
  let now = 0;
  const inbox = new InMemoryTerminalEventInbox(work, () => now);
  const first = await inbox.claimAfter('bot-analysis', null);
  assert.ok(first);
  assert.equal(await inbox.claimAfter('bot-analysis', null), undefined);
  const other = await inbox.claimAfter('anti-cheat-analysis', null);
  assert.ok(other);
  now = TERMINAL_LEASE_MS - 1;
  assert.equal(await inbox.claimAfter('bot-analysis', null), undefined);
  now++;
  const recovered = await inbox.claimAfter('bot-analysis', null);
  assert.ok(recovered);
  assert.notEqual(recovered.lease.token, first.lease.token);
  assert.equal(await inbox.renew(first.lease), false);
  assert.equal(await inbox.acknowledge(first.lease), false);
  assert.equal(await inbox.fail(first.lease), undefined);
  const failure = await inbox.fail(recovered.lease);
  assert.deepEqual(failure, { failures: 1, nextRetryAt: now + TERMINAL_RETRY_BASE_MS });
  assert.equal(await inbox.fail(recovered.lease), undefined);
  now = failure!.nextRetryAt - 1;
  assert.equal(await inbox.claimBefore('bot-analysis', { gameId: 'z', seq: 0 }), undefined);
  now++;
  const due = await inbox.claimBefore('bot-analysis', { gameId: 'z', seq: 0 });
  assert.ok(due);
  assert.equal(await inbox.acknowledge(due.lease), true);
  assert.equal(await inbox.acknowledge(due.lease), false);
  now += TERMINAL_LEASE_MS + TERMINAL_RETRY_CAP_MS;
  assert.equal(await inbox.claimAfter('bot-analysis', null), undefined);
  assert.ok(await inbox.claimAfter('anti-cheat-analysis', null));
});
