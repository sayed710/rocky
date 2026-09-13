import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Accessibility (a11y) tests for the Rookzen web frontend.
 *
 * These tests validate the ARIA structure, keyboard navigation support,
 * and semantic HTML in the real index.html — not a hand-maintained copy.
 * The HTML is read from the source file so that any regression in
 * index.html is caught immediately.
 *
 * Limitation (m2): these tests check the static markup only — they
 * cannot see the rendered board/lobby/profile states after JavaScript
 * executes. Full a11y validation requires:
 *   1. The Lighthouse a11y audit (≥ 95) via the Playwright e2e suite.
 *   2. A keyboard-drive-the-board Playwright spec that verifies
 *      focus management and keyboard operability of the live board.
 * Both are part of the M6 acceptance gate and run against the served app.
 */

// Resolve the package root from this test file's URL.
// Tests compile to dist-test/test/a11y.test.js, so we need to go up
// to the package root and then read index.html from there.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// From dist-test/test/ → package root is ../../
const PACKAGE_ROOT = resolve(__dirname, '..', '..');
const HTML_TEMPLATE = readFileSync(resolve(PACKAGE_ROOT, 'index.html'), 'utf8');

test('html has lang attribute', () => {
  assert.ok(HTML_TEMPLATE.includes('<html lang="en">'));
});

test('skip link is present and points to board', () => {
  assert.ok(HTML_TEMPLATE.includes('class="skip-link"'));
  assert.ok(HTML_TEMPLATE.includes('href="#board"'));
});

test('board section has aria-label', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Chess board"'));
});

test('status has role=status and aria-live=polite', () => {
  assert.ok(HTML_TEMPLATE.includes('role="status"'));
  assert.ok(HTML_TEMPLATE.includes('aria-live="polite"'));
});

test('error regions have role=alert', () => {
  const alerts = (HTML_TEMPLATE.match(/role="alert"/g) || []).length;
  assert.ok(alerts >= 3, 'expected at least 3 role=alert regions (auth, lobby, profile)');
});

test('seek list has role=list', () => {
  assert.ok(HTML_TEMPLATE.includes('role="list"'));
});

test('buttons have aria-label or text content', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Toggle light/dark theme"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Flip board"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Sign out"'));
});

test('nav links are present for play and profile', () => {
  assert.ok(HTML_TEMPLATE.includes('href="/" data-route="lobby">Play</a>'));
  assert.ok(HTML_TEMPLATE.includes('href="/profile" data-route="profile">Profile</a>'));
});

test('viewport meta tag is present for mobile', () => {
  assert.ok(HTML_TEMPLATE.includes('name="viewport"'));
  assert.ok(HTML_TEMPLATE.includes('width=device-width'));
});

test('manifest link is present for PWA', () => {
  assert.ok(HTML_TEMPLATE.includes('rel="manifest"'));
});

test('favicon icon link is present in head', () => {
  assert.ok(HTML_TEMPLATE.includes('rel="icon"'));
  assert.ok(HTML_TEMPLATE.includes('href="/icon.svg"'));
});

test('theme-color meta is present', () => {
  assert.ok(HTML_TEMPLATE.includes('name="theme-color"'));
});

test('hidden sections use hidden attribute (not display:none)', () => {
  assert.ok(HTML_TEMPLATE.includes('hidden>'));
});

test('all interactive elements are buttons or links (no div onclick)', () => {
  assert.ok(!HTML_TEMPLATE.includes('onclick='));
});

// Auth form a11y checks (R5#2)
/**
 * The section is still named; the name now comes from the visible `<h2>` rather than an
 * `aria-label` only a screen reader could hear. That is the stronger contract, not a relaxed one:
 * an invisible label can drift away from the visible heading beside it, and this one cannot —
 * the section had no visible heading at all while every other section (`Open seeks`, `Profile`)
 * had one. Asserting the wiring rather than a literal string is what makes it stronger.
 */
test('the auth section is named by its visible heading', () => {
  assert.ok(
    HTML_TEMPLATE.includes('aria-labelledby="auth-heading"'),
    'the auth section must take its accessible name from an element, not a hidden string',
  );
  assert.ok(
    /<h2 id="auth-heading">[^<]+<\/h2>/.test(HTML_TEMPLATE),
    'the element it points at must be a visible heading with text',
  );
});

test('auth form inputs have associated labels', () => {
  assert.ok(HTML_TEMPLATE.includes('label for="auth-handle"'));
  assert.ok(HTML_TEMPLATE.includes('label for="auth-password"'));
});

test('auth inputs have autocomplete attributes', () => {
  assert.ok(HTML_TEMPLATE.includes('autocomplete="username"'));
  assert.ok(HTML_TEMPLATE.includes('autocomplete="current-password"'));
});

test('auth status has role=status', () => {
  assert.ok(HTML_TEMPLATE.includes('id="auth-status" role="status"'));
});

test('lobby mounts the create-a-game panel', () => {
  // The create action is the CreateGamePanel (built in JS). Its trigger is
  // gated at runtime — disabled with a "Sign in to create a seek" title until
  // authenticated — which the Playwright/Lighthouse suite exercises live.
  assert.ok(HTML_TEMPLATE.includes('id="create-game"'));
});

test('lobby mounts the play vs computer dialog', () => {
  assert.ok(HTML_TEMPLATE.includes('id="play-bot-mount"'));
});

// --- Social region (M10 inc 9) ---

test('every social list region carries an aria-label', () => {
  // Six lists sit on one page with visually similar rows; without labels a
  // screen-reader user cannot tell followers from blocked players.
  for (const label of [
    'aria-label="Followers"',
    'aria-label="Following"',
    'aria-label="Friend requests received"',
    'aria-label="Friend requests sent"',
    'aria-label="Friends"',
    'aria-label="Blocked players"',
  ]) {
    assert.ok(HTML_TEMPLATE.includes(label), `missing ${label}`);
  }
});

test('social errors are announced', () => {
  assert.match(HTML_TEMPLATE, /id="social-error"[^>]*role="alert"/);
});

test('the viewer-only social block starts hidden', () => {
  // It holds the viewer's own requests, friends and blocks. Rendering it before
  // the controller decides whose profile this is would expose one account's
  // relationships on another account's page.
  assert.match(HTML_TEMPLATE, /id="social-self"[^>]*hidden/);
});

// --- Tournaments region (M14 inc 15) ---

test('nav link is present for tournaments', () => {
  assert.ok(HTML_TEMPLATE.includes('href="/tournaments" data-route="tournaments">Tournaments</a>'));
});

test('every tournament section carries an aria-label', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Tournaments"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Tournament"'));
});

test('every tournament list region carries an aria-label', () => {
  for (const label of [
    'aria-label="Tournaments list"',
    'aria-label="Standings"',
    'aria-label="Live games"',
  ]) {
    assert.ok(HTML_TEMPLATE.includes(label), `missing ${label}`);
  }
});

test('tournament errors are announced', () => {
  assert.match(HTML_TEMPLATE, /id="tournaments-error"[^>]*role="alert"/);
  assert.match(HTML_TEMPLATE, /id="tournament-error"[^>]*role="alert"/);
});

// --- Search region (M14 inc 16) ---

test('search section carries an aria-label', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Search"'));
});

test('search results list region carries an aria-label', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Search results"'));
});

test('nav search form has role=search and associated label', () => {
  assert.ok(HTML_TEMPLATE.includes('role="search"'));
  assert.ok(HTML_TEMPLATE.includes('for="search-input"'));
});

test('search error region has role=alert', () => {
  assert.match(HTML_TEMPLATE, /id="search-error"[^>]*role="alert"/);
});

// --- Direct Messaging region (M14 inc 18) ---

test('nav link is present for messages', () => {
  assert.ok(HTML_TEMPLATE.includes('href="/messages" data-route="messages">Messages</a>'));
});

test('every messaging section carries an aria-label', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Messages"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Conversation"'));
});

test('messaging list regions carry aria-labels', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Inbox"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Message thread"'));
});

test('messaging error regions have role=alert', () => {
  assert.match(HTML_TEMPLATE, /id="messages-error"[^>]*role="alert"/);
  assert.match(HTML_TEMPLATE, /id="conversation-error"[^>]*role="alert"/);
});

test('conversation composer form has labelled input', () => {
  assert.ok(HTML_TEMPLATE.includes('id="conversation-composer"'));
  assert.ok(HTML_TEMPLATE.includes('for="composer-input"'));
});




// --- Teams region (M14 inc 20) ---

test('nav link is present for teams', () => {
  assert.ok(HTML_TEMPLATE.includes('href="/teams" data-route="teams">Teams</a>'));
});

test('every teams section carries an aria-label', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Teams"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Team"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Team members"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Pending join requests"'));
});

test('join requests panel list starts hidden', () => {
  assert.match(HTML_TEMPLATE, /id="join-requests-heading"[^>]*hidden/);
  assert.match(HTML_TEMPLATE, /id="join-requests"[^>]*hidden/);
});

test('teams error regions have role=alert', () => {
  assert.match(HTML_TEMPLATE, /id="teams-error"[^>]*role="alert"/);
  assert.match(HTML_TEMPLATE, /id="team-error"[^>]*role="alert"/);
});

test('team search form has a labelled input', () => {
  assert.ok(HTML_TEMPLATE.includes('id="team-search-form"'));
  assert.ok(HTML_TEMPLATE.includes('for="team-search-input"'));
});

// --- Team forum region (M14 inc 21) ---

test('every forum section carries an aria-label', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Team forum"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Forum thread"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Forum threads"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Thread posts"'));
});

test('forum error regions have role=alert', () => {
  assert.match(HTML_TEMPLATE, /id="forum-error"[^>]*role="alert"/);
  assert.match(HTML_TEMPLATE, /id="thread-error"[^>]*role="alert"/);
});

test('forum composers have labelled inputs', () => {
  assert.ok(HTML_TEMPLATE.includes('for="thread-title-input"'));
  assert.ok(HTML_TEMPLATE.includes('for="thread-body-input"'));
  assert.ok(HTML_TEMPLATE.includes('for="reply-input"'));
});

// --- Achievements region (M14 inc 22) ---

test('the achievements list carries an aria-label', () => {
  // It sits among five other visually similar panel lists on the profile page.
  assert.ok(HTML_TEMPLATE.includes('aria-label="Achievements"'));
});

test('achievements errors are announced', () => {
  assert.match(HTML_TEMPLATE, /id="achievements-error"[^>]*role="alert"/);
});

test('the achievements region starts hidden', () => {
  // A deployment without ACHIEVEMENTS_ENABLED answers 503 on every profile. Shipping the heading
  // visible would put an empty "Achievements" on every profile in that deployment, and a screen
  // reader would announce a section that never gets content.
  assert.match(HTML_TEMPLATE, /id="achievements"[^>]*hidden/);
});

// --- WebAuthn / Passkeys region (M14 inc 44) ---

test('auth section has sign in with passkey button', () => {
  assert.ok(HTML_TEMPLATE.includes('id="auth-passkey"'));
});

test('passkeys list region carries an aria-label', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Passkeys"'));
});

test('passkeys status region has role=status and aria-live=polite', () => {
  assert.match(HTML_TEMPLATE, /id="passkeys-note"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('passkeys error region has role=alert', () => {
  assert.match(HTML_TEMPLATE, /id="passkeys-error"[^>]*role="alert"/);
});

// --- Password Recovery region (M14 inc 45) ---

test('auth section carries a forgot password link', () => {
  assert.ok(HTML_TEMPLATE.includes('id="auth-forgot-password"'));
});

test('password reset section carries aria-labelledby heading', () => {
  assert.ok(HTML_TEMPLATE.includes('id="password-reset"'));
  assert.ok(HTML_TEMPLATE.includes('aria-labelledby="password-reset-heading"'));
});

test('password reset forms carry labelled inputs', () => {
  assert.ok(HTML_TEMPLATE.includes('for="password-reset-request-input"'));
  assert.ok(HTML_TEMPLATE.includes('for="password-reset-confirm-password"'));
  assert.ok(HTML_TEMPLATE.includes('for="password-reset-confirm-password-confirm"'));
});

test('password reset status and error regions have appropriate ARIA roles', () => {
  assert.match(HTML_TEMPLATE, /id="password-reset-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(HTML_TEMPLATE, /id="password-reset-error"[^>]*role="alert"/);
});

// --- Email verification region (M14 inc 48) ---

test('email verify section carries aria-labelledby heading with visible text', () => {
  assert.ok(HTML_TEMPLATE.includes('id="email-verify"'));
  assert.ok(HTML_TEMPLATE.includes('aria-labelledby="email-verify-heading"'));
  assert.ok(
    /<h2 id="email-verify-heading">[^<]+<\/h2>/.test(HTML_TEMPLATE),
    '<h2 id="email-verify-heading"> must be a visible heading with text',
  );
});

test('email verify status and error regions have appropriate ARIA roles', () => {
  assert.match(HTML_TEMPLATE, /id="email-verify-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(HTML_TEMPLATE, /id="email-verify-error"[^>]*role="alert"/);
});

test('email verify section starts hidden', () => {
  assert.match(HTML_TEMPLATE, /<section id="email-verify"[^>]*\bhidden\b/);
});

test('auth email field has associated label, proper type and autocomplete, and is optional', () => {
  assert.ok(HTML_TEMPLATE.includes('label for="auth-email"'));
  const inputMatch = HTML_TEMPLATE.match(/<input id="auth-email"[^>]*\/>/);
  assert.ok(inputMatch, 'could not find #auth-email input tag');
  const inputTag = inputMatch[0];
  assert.ok(inputTag.includes('type="email"'));
  assert.ok(inputTag.includes('autocomplete="email"'));
  assert.ok(!inputTag.includes(' required'), '#auth-email must not be required');
});

/**
 * The header search form ships hidden (ADR-0132 §5).
 *
 * It is revealed by `applySearchCapability` once `GET /v1/capabilities` reports `search: true`.
 * Shipping it visible would put a search box on every page of a deployment that has search switched
 * off — an entry point into a disabled feature — and, even where search works, would show it for the
 * length of one request before the answer could withdraw it.
 *
 * Asserted against the real markup because the gate depends on this attribute and nothing else in
 * the suite reads the file. Delete the attribute and every unit test still passes; this is the one
 * that does not.
 */
test('the header search form ships hidden, to be revealed by capability', () => {
  const form = HTML_TEMPLATE.match(/<form id="search-form"[^>]*>/);
  assert.ok(form, 'the header search form must exist');
  assert.match(
    form[0],
    /\shidden\b/,
    'the search form must ship hidden — it is revealed only when capabilities report search: true',
  );
});
