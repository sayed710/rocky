import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createI18n } from '../src/i18n/manager.js';
import { LocaleStorage } from '../src/i18n/storage.js';
import { enMessages, arMessages, isMessageKey, type MessageKey } from '../src/i18n/catalog/index.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('production Arabic persists and restores without injected catalogues', () => {
  const values = new Map<string, string>();
  const storage = new LocaleStorage({ storage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  } });
  const manager = createI18n({ storage });
  manager.setLocale('ar');
  assert.equal(manager.locale, 'ar');
  assert.equal(manager.t('nav.play'), 'العب');
  const restored = createI18n({ storage });
  assert.equal(restored.locale, 'ar');
  assert.equal(restored.t('auth.signIn'), 'تسجيل الدخول');
  restored.setLocale('en');
  assert.equal(restored.t('nav.play'), 'Play');
});

test('Arabic has every English key and exactly the same interpolation parameters', () => {
  assert.deepEqual(Object.keys(arMessages).sort(), Object.keys(enMessages).sort());
  const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
  const unchanged = new Set(['shell.title', 'shell.brand', 'publicDocument.documentTitle', 'variant.chess960', 'ai.coach.label.eco', 'ai.opening.label.eco', 'ai.puzzle.distanceGap']);
  for (const key of Object.keys(enMessages) as MessageKey[]) {
    assert.ok(arMessages[key].trim(), `${key} is empty`);
    assert.deepEqual(placeholders(arMessages[key]), placeholders(enMessages[key]), key);
    if (!unchanged.has(key)) assert.notEqual(arMessages[key], enMessages[key], `${key} is untranslated`);
    assert.doesNotMatch(arMessages[key], /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/, `${key} contains directional controls`);
  }
});

test('pre-paint document locale agrees with runtime for valid, malformed and unavailable storage', () => {
  const script = readFileSync(new URL('../../public/locale-init.js', import.meta.url), 'utf8');
  for (const value of ['en', 'ar', 'fr', 'AR', 'ar-SA', '{bad}', '', null]) {
    const documentElement = { lang: '', dir: '' };
    const storage = { getItem: () => value, setItem: () => {}, removeItem: () => {} };
    runInNewContext(script, { document: { documentElement }, localStorage: storage });
    const manager = createI18n({ storage: new LocaleStorage({ storage }) });
    assert.equal(documentElement.lang, manager.locale);
    assert.equal(documentElement.dir, manager.locale === 'ar' ? 'rtl' : 'ltr');
  }
  const documentElement = { lang: '', dir: '' };
  runInNewContext(script, { document: { documentElement }, localStorage: { getItem: () => { throw new Error('blocked'); } } });
  assert.deepEqual(documentElement, { lang: 'en', dir: 'ltr' });
});

test('built-in achievement copy has English source parity and Arabic coverage', () => {
  const source = readFileSync(new URL('../../../achievements/src/catalogue.ts', import.meta.url), 'utf8');
  const entries = [...source.matchAll(/key: '([^']+)',\s+name: '([^']+)',\s+description: '([^']+)'/g)];
  assert.equal(entries.length, 13, 'every built-in definition must be considered, including hidden entries');
  for (const [, key, name, description] of entries) {
    const nameKey = `profile.achievements.catalog.${key}.name`;
    const descriptionKey = `profile.achievements.catalog.${key}.description`;
    assert.ok(isMessageKey(nameKey), `${key} has no localized name`);
    assert.ok(isMessageKey(descriptionKey), `${key} has no localized description`);
    assert.equal(enMessages[nameKey], name, `${key} English name drift`);
    assert.equal(enMessages[descriptionKey], description, `${key} English description drift`);
    assert.notEqual(arMessages[nameKey], name);
    assert.notEqual(arMessages[descriptionKey], description);
  }
});
