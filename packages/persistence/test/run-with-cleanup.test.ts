import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithCleanup } from './run-with-cleanup';

test('a rejected first cleanup step does not skip later steps and is surfaced', async () => {
  const ran: string[] = [];
  const closeError = new Error('close rejected');
  await assert.rejects(
    runWithCleanup(async () => undefined, [
      { name: 'close', run: async () => { ran.push('close'); throw closeError; } },
      { name: 'drop owned', run: async () => { ran.push('drop owned'); } },
      { name: 'drop role', run: async () => { ran.push('drop role'); } },
    ]),
    (error: Error) => {
      assert.match(error.message, /"close" failed/);
      assert.equal(error.cause, closeError);
      return true;
    },
  );
  assert.deepEqual(ran, ['close', 'drop owned', 'drop role']);
});

test('the original test failure is kept alongside cleanup failures, in order', async () => {
  const bodyError = new Error('assertion failed');
  const dropError = new Error('role still owns objects');
  await assert.rejects(
    runWithCleanup(async () => { throw bodyError; }, [
      { name: 'close', run: async () => undefined },
      { name: 'drop role', run: async () => { throw dropError; } },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], bodyError);
      assert.equal((error.errors[1] as Error).cause, dropError);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
});

test('a lone body failure is rethrown unchanged and cleanup still runs', async () => {
  const bodyError = new Error('assertion failed');
  let cleaned = false;
  await assert.rejects(
    runWithCleanup(async () => { throw bodyError; }, [{ name: 'close', run: async () => { cleaned = true; } }]),
    (error: unknown) => error === bodyError,
  );
  assert.equal(cleaned, true);
});

test('no failure resolves', async () => {
  await runWithCleanup(async () => undefined, [{ name: 'close', run: async () => undefined }]);
});
