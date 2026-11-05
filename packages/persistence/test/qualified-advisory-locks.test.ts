/**
 * Static guard: every advisory-lock and key-hash call the PostgreSQL adapters send is schema-
 * qualified with exact argument types, so an overload planted in `public` by a role with CREATE
 * there (the default before PostgreSQL 15) can never be chosen and run with the caller's rights.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = [
  join(__dirname, '../../src/pg'),
  join(__dirname, '../src/pg'),
  join(process.cwd(), 'src/pg'),
  join(process.cwd(), 'packages/persistence/src/pg'),
].find((d) => existsSync(d))!;

const CALLS = /(?<![.\w])(hashtextextended|pg_advisory_xact_lock|pg_try_advisory_lock|pg_advisory_lock|pg_advisory_unlock|pg_try_advisory_xact_lock)\(/g;

function sourceFiles(): string[] {
  return readdirSync(srcDir).filter((f) => f.endsWith('.ts')).map((f) => join(srcDir, f));
}

test('no adapter sends an unqualified advisory-lock or hashtextextended call', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(CALLS)) offenders.push(`${file}:${i + 1}: ${m[1]}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('every qualified hashtextextended call passes an exact bigint seed', () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/pg_catalog\.hashtextextended\(([\s\S]*?)\)\s*(?:\)|AS)/g)) {
      seen += 1;
      if (!/,\s*0::bigint$/.test(m[1]!.trim())) offenders.push(`${file}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.ok(seen >= 10, `expected the known call sites, found ${seen}`);
  assert.deepEqual(offenders, []);
});
