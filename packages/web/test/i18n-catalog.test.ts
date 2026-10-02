import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enMessages, type MessageKey, type MessagesCatalog } from '../src/i18n/catalog/index.js';

describe('i18n canonical English catalog', () => {
  it('exports a valid messages object', () => {
    assert.ok(enMessages);
    assert.equal(typeof enMessages, 'object');
  });

  it('contains non-empty strings for all message keys', () => {
    const keys = Object.keys(enMessages) as MessageKey[];
    assert.ok(keys.length > 50, `Expected substantial catalog, found ${keys.length} keys`);

    for (const key of keys) {
      const value = enMessages[key];
      assert.equal(typeof value, 'string', `Key ${key} must be a string`);
      assert.ok(value.trim().length > 0, `Key ${key} must not be empty or whitespace`);
    }
  });

  it('contains expected core shell keys matching visible English product', () => {
    assert.equal(enMessages['shell.brand'], 'Rookzen');
    assert.equal(enMessages['shell.skipBoard'], 'Skip to board');
    assert.equal(enMessages['nav.play'], 'Play');
    assert.equal(enMessages['nav.learn'], 'Learn');
    assert.equal(enMessages['nav.profile'], 'Profile');
    assert.equal(enMessages['nav.tournaments'], 'Tournaments');
    assert.equal(enMessages['nav.leaderboard'], 'Leaderboard');
    assert.equal(enMessages['nav.teams'], 'Teams');
    assert.equal(enMessages['nav.messages'], 'Messages');
  });

  it('contains expected auth keys matching current copy', () => {
    assert.equal(enMessages['auth.heading'], 'Sign in to play');
    assert.equal(enMessages['auth.signIn'], 'Sign in');
    assert.equal(enMessages['auth.register'], 'Register');
    assert.equal(enMessages['auth.passkey'], 'Sign in with passkey');
  });

  it('contains expected game actions and status keys', () => {
    assert.equal(enMessages['game.status.yourMove'], 'Your move.');
    assert.equal(enMessages['game.actions.offerDraw'], 'Offer draw');
    assert.equal(enMessages['game.actions.resign'], 'Resign');
    assert.equal(enMessages['game.actions.abort'], 'Abort');
  });

  it('validates placeholder syntax format in catalog messages', () => {
    const placeholderRegex = /\{([a-zA-Z0-9_]+)\}/g;
    for (const [key, value] of Object.entries(enMessages) as [string, string][]) {
      const matches = [...value.matchAll(placeholderRegex)];
      for (const match of matches) {
        assert.ok(match[1], `Placeholder in ${key} should have a non-empty name`);
      }
    }
  });
});
