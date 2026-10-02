import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_REPOSITORY,
  createSourceMetadata,
  parseRevision,
  readBuildSourceMetadata,
  resolveBuildRevision,
} from '../src/app/source-metadata.js';

const SHA1 = '5d0a20e1a2a6d3f36645ae14cc0d631824b86b93';
const SHA256 = 'a'.repeat(64);

test('the canonical repository is the public sayed710/rocky GitHub repository over HTTPS', () => {
  assert.equal(SOURCE_REPOSITORY.slug, 'sayed710/rocky');
  assert.equal(SOURCE_REPOSITORY.url, 'https://github.com/sayed710/rocky');
  const url = new URL(SOURCE_REPOSITORY.url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
});

test('parseRevision accepts full SHA-1 and SHA-256 object names and normalizes case', () => {
  assert.equal(parseRevision(SHA1), SHA1);
  assert.equal(parseRevision(SHA1.toUpperCase()), SHA1);
  assert.equal(parseRevision(SHA256), SHA256);
});

test('parseRevision never invents a revision: anything else is unavailable', () => {
  for (const raw of [
    undefined,
    null,
    '',
    42,
    {},
    SHA1.slice(0, 7), // abbreviated: ambiguous, not an exact build identity
    SHA1.slice(0, 39),
    `${SHA1}0`,
    ` ${SHA1}`,
    `${SHA1}\n`,
    'g'.repeat(40),
    '0'.repeat(40), // Git's null object name, never a real commit
    '0'.repeat(64),
    'HEAD',
    'main',
    'unknown',
    'javascript:alert(1)',
    `${SHA1}/../../evil`,
  ]) {
    assert.equal(parseRevision(raw), null, JSON.stringify(raw));
  }
});

test('resolveBuildRevision treats a missing or empty VITE_GIT_SHA as an unavailable revision', () => {
  assert.equal(resolveBuildRevision({}), null);
  assert.equal(resolveBuildRevision({ VITE_GIT_SHA: '' }), null);
  assert.equal(resolveBuildRevision({ VITE_GIT_SHA: undefined }), null);
});

test('resolveBuildRevision accepts a well-formed VITE_GIT_SHA', () => {
  assert.equal(resolveBuildRevision({ VITE_GIT_SHA: SHA1 }), SHA1);
  assert.equal(resolveBuildRevision({ VITE_GIT_SHA: SHA1.toUpperCase() }), SHA1);
});

test('resolveBuildRevision fails the build closed on a malformed VITE_GIT_SHA', () => {
  for (const raw of ['abc1234', 'HEAD', ' ', `${SHA1} `, '0'.repeat(40), 'not-a-sha']) {
    assert.throws(
      () => resolveBuildRevision({ VITE_GIT_SHA: raw }),
      /VITE_GIT_SHA/,
      JSON.stringify(raw),
    );
  }
});

test('createSourceMetadata links the exact commit only for a validated revision', () => {
  const withSha = createSourceMetadata(SHA1);
  assert.deepEqual(withSha.repository, SOURCE_REPOSITORY);
  assert.deepEqual(withSha.revision, {
    sha: SHA1,
    commitUrl: `https://github.com/sayed710/rocky/commit/${SHA1}`,
  });
  const commit = new URL(withSha.revision!.commitUrl);
  assert.equal(commit.origin, 'https://github.com');
  assert.equal(commit.pathname, `/sayed710/rocky/commit/${SHA1}`);
});

test('createSourceMetadata reports an unavailable revision rather than a fake one', () => {
  for (const raw of [null, undefined, '', 'HEAD', 'deadbeef']) {
    const metadata = createSourceMetadata(raw);
    assert.equal(metadata.revision, null, JSON.stringify(raw));
    assert.deepEqual(metadata.repository, SOURCE_REPOSITORY);
  }
});

test('outside a Vite build (no compile-time constant) the build revision is unavailable', () => {
  // Node runs these tests from tsc output, where Vite's `define` never substituted the constant.
  assert.equal(readBuildSourceMetadata().revision, null);
});

test('metadata objects are frozen so a consumer cannot rewrite the link target', () => {
  const metadata = createSourceMetadata(SHA1);
  assert.ok(Object.isFrozen(metadata));
  assert.ok(Object.isFrozen(metadata.repository));
  assert.ok(Object.isFrozen(metadata.revision));
});
