import test from 'node:test';
import assert from 'node:assert/strict';
import * as pgApi from '../src/pg/index';

test('PG-F1 exposes a separate protected adapter and controlled preparation, not optional legacy tokens', () => {
  assert.equal(Object.hasOwn(pgApi,'PostgresFencedEventStore'),true);
  assert.equal(Object.hasOwn(pgApi,'FencingAcquireIntent'),true);
  assert.equal(Object.hasOwn(pgApi,'prepareGameFencing'),true);
});
