/**
 * Tests for the active-sessions view.
 *
 * The view owns two decisions worth pinning: which sessions count as active, and how a row reads
 * when the API supplies only some of the fields it could.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeSessions,
  describeDevice as describeDeviceBase,
  renderSessions as renderSessionsBase,
} from '../src/app/sessions-view.js';
import { createI18nManager, type I18nManager } from '../src/i18n/index.js';
import type { SessionView } from '../src/api/models.js';

const testI18n = createI18nManager();

function describeDevice(ua: string | null, i18n: I18nManager = testI18n): string {
  return describeDeviceBase(ua, i18n);
}

function renderSessions(
  container: HTMLElement,
  sessions: readonly SessionView[],
  onRevoke: (id: string) => void,
  busy: boolean,
  nowMs: number,
  i18n: I18nManager = testI18n,
): void {
  renderSessionsBase(container, sessions, onRevoke, busy, nowMs, i18n);
}

const NOW = Date.parse('2026-08-16T00:00:00.000Z');

/**
 * Shaped like a row the server actually returns: the `last*` fields are null, because nothing
 * writes them (`SessionsRepository.touch` has no production caller), and the `created*` fields carry
 * the request metadata every session insert records. A fixture with `last*` populated is the reason
 * an earlier version of these tests passed while every real row rendered as a bare "Unknown device".
 */
function session(id: string, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    createdAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:00:00.000Z',
    revokedAt: null,
    lastSeenAt: null,
    lastIp: null,
    lastUserAgent: null,
    createdIp: '203.0.113.9',
    createdUserAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    ...over,
  };
}

// --- which sessions are "active" -------------------------------------------

test('a revoked session is not active', () => {
  const list = [session('live'), session('dead', { revokedAt: '2026-08-10T00:00:00.000Z' })];
  assert.deepEqual(activeSessions(list, NOW).map((s) => s.id), ['live']);
});

test('an expired session is not active', () => {
  const list = [session('live'), session('stale', { expiresAt: '2026-08-01T00:00:00.000Z' })];
  assert.deepEqual(activeSessions(list, NOW).map((s) => s.id), ['live']);
});

test('an unparseable expiry is treated as active rather than silently hidden', () => {
  const list = [session('odd', { expiresAt: 'not-a-date' })];
  assert.deepEqual(activeSessions(list, NOW).map((s) => s.id), ['odd']);
});

// --- device description ------------------------------------------------------

test('describeDevice names browser and platform when both are recognisable', () => {
  assert.equal(
    describeDevice('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36'),
    'Chrome on Windows',
  );
  assert.equal(describeDevice('Mozilla/5.0 (Macintosh; Mac OS X 10_15) Safari/605'), 'Safari on macOS');
  assert.equal(describeDevice('Mozilla/5.0 (X11; Linux x86_64) Firefox/121'), 'Firefox on Linux');
});

/** Edge and Opera both carry `Chrome/` in their UA, so order of checks matters. */
test('describeDevice does not mistake Edge or Opera for Chrome', () => {
  assert.equal(describeDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36 Edg/120'), 'Edge on Windows');
  assert.equal(describeDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36 OPR/106'), 'Opera on Windows');
});

test('describeDevice degrades to a readable label rather than a raw user agent', () => {
  assert.equal(describeDevice(null), 'Unknown device');
  assert.equal(describeDevice('curl/8.4.0'), 'Unknown device');
  assert.equal(describeDevice('Mozilla/5.0 (Windows NT 10.0)'), 'Windows');
});

// --- rendering ---------------------------------------------------------------

function container(): HTMLElement {
  const rows: unknown[] = [];
  const el = {
    innerHTML: '',
    children: rows,
    ownerDocument: undefined as unknown,
    appendChild(child: unknown) { rows.push(child); return child; },
    querySelectorAll: () => [] as unknown[],
  };
  const doc = {
    createElement: (tag: string) => {
      const node: Record<string, unknown> = {
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        type: '',
        disabled: false,
        children: [] as unknown[],
        appendChild(c: unknown) { (node['children'] as unknown[]).push(c); return c; },
        setAttribute: () => {},
        addEventListener: (_e: string, fn: () => void) => { node['click'] = fn; },
      };
      return node;
    },
  };
  el.ownerDocument = doc;
  return el as unknown as HTMLElement;
}

/** Flatten the rendered tree to text so assertions read like what a user sees. */
function textOf(el: HTMLElement): string {
  const walk = (node: any): string => {
    const own = typeof node.textContent === 'string' ? node.textContent : '';
    const kids = Array.isArray(node.children) ? node.children.map(walk).join(' ') : '';
    return `${own} ${kids}`;
  };
  return walk(el).replace(/\s+/g, ' ').trim();
}

test('an empty list renders the empty state, not a bare panel', () => {
  const el = container();
  renderSessions(el, [], () => {}, false, NOW);
  assert.match(textOf(el), /No other active sessions/);
});

test('a list containing only revoked sessions renders as empty', () => {
  const el = container();
  renderSessions(el, [session('dead', { revokedAt: '2026-08-10T00:00:00.000Z' })], () => {}, false, NOW);
  assert.match(textOf(el), /No other active sessions/);
});

test('a row states device, address and last-seen date', () => {
  const el = container();
  renderSessions(el, [session('s1')], () => {}, false, NOW);
  const text = textOf(el);
  assert.match(text, /Chrome on Windows/);
  assert.match(text, /203\.0\.113\.9/);
  assert.match(text, /last seen 2026-08-01/);
  assert.match(text, /Revoke/);
});

/** Any of the three parts can be absent; none may leave a dangling separator behind. */
test('missing fields are omitted without stray separators', () => {
  const el = container();
  const bare = session('s1', { lastIp: null, lastSeenAt: null, lastUserAgent: null, createdIp: null, createdUserAgent: null, createdAt: '' });
  renderSessions(el, [bare], () => {}, false, NOW);
  const text = textOf(el);
  assert.match(text, /Unknown device/);
  assert.equal(text.includes('· ·'), false, 'no doubled separator');
  assert.equal(/·\s*(Revoke|$)/.test(text.replace('Unknown device', '')), false, 'no trailing separator');
  assert.equal(text.includes('null'), false);
  assert.equal(text.includes('undefined'), false);
});

/**
 * The regression that made this screen worth nothing: reading only `lastUserAgent`/`lastIp`, which
 * no production code path ever writes, rendered every session as an identical "Unknown device" with
 * no address and no date — on the one screen whose entire job is telling sessions apart.
 */
test('a row identifies a session from the metadata the server actually writes', () => {
  const el = container();
  renderSessions(el, [session('s1')], () => {}, false, NOW);
  const text = textOf(el);
  assert.equal(text.includes('Unknown device'), false, 'created metadata identifies the device');
  assert.match(text, /Chrome on Windows · 203\.0\.113\.9 · last seen 2026-08-01/);
});

test('a session that has been touched prefers its last-seen metadata over its first', () => {
  const el = container();
  const touched = session('s1', {
    lastSeenAt: '2026-08-15T00:00:00.000Z',
    lastIp: '198.51.100.4',
    lastUserAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121',
  });
  renderSessions(el, [touched], () => {}, false, NOW);
  assert.match(textOf(el), /Firefox on Linux · 198\.51\.100\.4 · last seen 2026-08-15/);
});

test('the revoke action reports the id of its own row', () => {
  const el = container();
  const revoked: string[] = [];
  renderSessions(el, [session('a'), session('b')], (id) => revoked.push(id), false, NOW);

  const buttons: any[] = [];
  const collect = (node: any): void => {
    if (node.tagName === 'BUTTON') buttons.push(node);
    if (Array.isArray(node.children)) node.children.forEach(collect);
  };
  (el as any).children.forEach(collect);

  assert.equal(buttons.length, 2);
  buttons[1].click();
  assert.deepEqual(revoked, ['b']);
});

test('busy disables every revoke control', () => {
  const el = container();
  renderSessions(el, [session('a'), session('b')], () => {}, true, NOW);

  const buttons: any[] = [];
  const collect = (node: any): void => {
    if (node.tagName === 'BUTTON') buttons.push(node);
    if (Array.isArray(node.children)) node.children.forEach(collect);
  };
  (el as any).children.forEach(collect);

  assert.equal(buttons.length, 2);
  assert.equal(buttons.every((b) => b.disabled === true), true);
});
