/**
 * Every alert names a runbook section that exists, and a failing ratings batch alerts directly.
 *
 * A renamed runbook heading silently breaks the link an on-call engineer follows during the incident.
 * Reads the real rules and runbook, since the value is in catching drift between the two files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const rules = read('deploy/observability/prometheus/rules/gambit.rules.yml');
const runbooks = read('docs/RUNBOOKS.md');

/** GitHub's heading anchor: lowercase, punctuation dropped, each space a hyphen. */
const anchor = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/ /g, '-');

/** Each alert's name and body, up to the next rule or group. */
function alerts(text) {
  return [...text.matchAll(/^\s*- alert:\s*(\S+)\n([\s\S]*?)(?=^\s*- (?:alert|record):|^\s*- name:|(?![\s\S]))/gm)]
    .map(([, name, body]) => ({ name, body }));
}

test('every alert links to a heading that exists in docs/RUNBOOKS.md', () => {
  const headings = new Set([...runbooks.matchAll(/^#{2,3} (.+)$/gm)].map(([, h]) => anchor(h)));
  const found = alerts(rules);
  assert.ok(found.length > 0, 'no alerts parsed');
  for (const { name, body } of found) {
    const url = body.match(/runbook_url:\s*"([^"]+)"/)?.[1];
    assert.ok(url, `${name} has no runbook_url`);
    const [, section] = url.split('RUNBOOKS.md#');
    assert.ok(section, `${name} does not link a RUNBOOKS.md section`);
    assert.ok(headings.has(section), `${name} links #${section}, which is not a RUNBOOKS.md heading`);
  }
});

test('a failing ratings batch alerts on the failure counter itself', () => {
  const alert = alerts(rules).find(({ body }) => /expr:.*\bratings_batch_failures_total\b/.test(body));
  assert.ok(alert, 'no alert reads ratings_batch_failures_total');
  assert.match(alert.body, /RUNBOOKS\.md#ratings-batch-failures"/);
});
