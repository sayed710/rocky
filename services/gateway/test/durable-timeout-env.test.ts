import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDurableTimeoutEnv } from '../src/durable-timeouts.js';

test('parseDurableTimeoutEnv: defaults to 5000 when absent or empty', () => {
  assert.equal(parseDurableTimeoutEnv(undefined, 'GATEWAY_DURABLE_READ_TIMEOUT_MS'), 5000);
  assert.equal(parseDurableTimeoutEnv('', 'GATEWAY_DURABLE_READ_TIMEOUT_MS'), 5000);
});

test('parseDurableTimeoutEnv: accepts valid integer within 100 to 120000', () => {
  assert.equal(parseDurableTimeoutEnv('100', 'GATEWAY_DURABLE_READ_TIMEOUT_MS'), 100);
  assert.equal(parseDurableTimeoutEnv('5000', 'GATEWAY_DURABLE_READ_TIMEOUT_MS'), 5000);
  assert.equal(parseDurableTimeoutEnv('120000', 'GATEWAY_DURABLE_READ_TIMEOUT_MS'), 120000);
});

test('parseDurableTimeoutEnv: rejects out-of-range or non-integer values', () => {
  assert.throws(
    () => parseDurableTimeoutEnv('99', 'GATEWAY_DURABLE_READ_TIMEOUT_MS'),
    /GATEWAY_DURABLE_READ_TIMEOUT_MS must be an integer between 100 and 120000/,
  );
  assert.throws(
    () => parseDurableTimeoutEnv('120001', 'GATEWAY_DURABLE_READ_TIMEOUT_MS'),
    /GATEWAY_DURABLE_READ_TIMEOUT_MS must be an integer between 100 and 120000/,
  );
  assert.throws(
    () => parseDurableTimeoutEnv('5000.5', 'GATEWAY_DURABLE_READ_TIMEOUT_MS'),
    /GATEWAY_DURABLE_READ_TIMEOUT_MS must be an integer between 100 and 120000/,
  );
  assert.throws(
    () => parseDurableTimeoutEnv('invalid', 'GATEWAY_DURABLE_READ_TIMEOUT_MS'),
    /GATEWAY_DURABLE_READ_TIMEOUT_MS must be an integer between 100 and 120000/,
  );
});
