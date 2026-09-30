import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate } from '../src/i18n/interpolate.js';

describe('i18n interpolate', () => {
  it('returns template as-is when no params provided or no placeholders', () => {
    assert.equal(interpolate('Hello world'), 'Hello world');
    assert.equal(interpolate('Hello {name}'), 'Hello {name}');
  });

  it('interpolates single string parameter', () => {
    assert.equal(interpolate('Hello {name}!', { name: 'Alice' }), 'Hello Alice!');
  });

  it('interpolates multiple different parameters', () => {
    const template = '{winner} defeated {loser} in {moves} moves';
    const result = interpolate(template, {
      winner: 'Magnus',
      loser: 'Hikaru',
      moves: 42,
    });
    assert.equal(result, 'Magnus defeated Hikaru in 42 moves');
  });

  it('interpolates repeated placeholders of the same parameter', () => {
    assert.equal(
      interpolate('{item} and {item} again', { item: 'pawn' }),
      'pawn and pawn again',
    );
  });

  it('preserves unsupplied placeholders without throwing or destroying template', () => {
    assert.equal(
      interpolate('Hello {first} {last}!', { first: 'John' }),
      'Hello John {last}!',
    );
  });

  it('handles numeric parameters correctly including zero and negative numbers', () => {
    assert.equal(interpolate('Score: {score}', { score: 0 }), 'Score: 0');
    assert.equal(interpolate('Eval: {eval}', { eval: -2.5 }), 'Eval: -2.5');
  });

  it('safely ignores excess parameters not present in the template', () => {
    assert.equal(
      interpolate('Welcome {user}', { user: 'Bob', unused: 'foo', count: 99 }),
      'Welcome Bob',
    );
  });

  it('handles empty template or empty parameters gracefully', () => {
    assert.equal(interpolate(''), '');
    assert.equal(interpolate('', { foo: 'bar' }), '');
    assert.equal(interpolate('test', {}), 'test');
  });

  it('does not evaluate code, regex tokens, or HTML markup', () => {
    const malicious = '<script>alert(1)</script>';
    const result = interpolate('Player: {player}', { player: malicious });
    assert.equal(result, 'Player: <script>alert(1)</script>');
  });
});
