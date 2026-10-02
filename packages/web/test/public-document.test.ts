import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeElement, createFakeDoc, createTestI18n } from './support/localization-dom.js';
import { mountPublicDocument, PUBLIC_DOCUMENT_SPECS } from '../src/app/public-document.js';
import { createSourceMetadata } from '../src/app/source-metadata.js';
import { PUBLIC_DOCUMENT_IDS, type PublicDocumentId } from '../src/app/router.js';
import { enMessages } from '../src/i18n/catalog/en.js';
import type { I18n } from '../src/i18n/manager.js';

const SHA = '5d0a20e1a2a6d3f36645ae14cc0d631824b86b93';

interface Mounted {
  readonly doc: Document;
  readonly surface: FakeElement;
  readonly i18n: I18n;
  readonly handle: { dispose: () => void };
}

function mount(
  documentId: PublicDocumentId,
  options: { revision?: string | null; focusHeading?: boolean; i18n?: I18n } = {},
): Mounted {
  const surface = new FakeElement('section', 'public-document');
  const doc = createFakeDoc(new Map([['public-document', surface]]));
  (doc as unknown as { title: string }).title = 'Rookzen';
  const i18n = options.i18n ?? createTestI18n({ doc });
  const handle = mountPublicDocument({
    doc,
    surface: surface as unknown as HTMLElement,
    document: documentId,
    i18n,
    source: createSourceMetadata(options.revision ?? null),
    focusHeading: options.focusHeading ?? false,
  });
  return { doc, surface, i18n, handle };
}

function only(surface: FakeElement, selector: string): FakeElement {
  const found = surface.querySelectorAll(selector);
  assert.equal(found.length, 1, `expected exactly one ${selector}, found ${found.length}`);
  return found[0]!;
}

test('every public document renders one labelled article with one title heading in its header', () => {
  for (const id of PUBLIC_DOCUMENT_IDS) {
    const { surface, handle } = mount(id);
    const article = only(surface, 'article');
    const header = only(article, 'header');
    const title = only(header, 'h2');
    // The topbar brand is the page's single <h1>; route surfaces start at <h2>.
    assert.equal(surface.querySelectorAll('h1').length, 0, id);
    assert.equal(article.querySelectorAll('h2').length, 1, id);
    assert.ok(title.id, `${id}: title needs an id to label the article`);
    assert.equal(article.getAttribute('aria-labelledby'), title.id, id);
    assert.equal(title.textContent, enMessages[PUBLIC_DOCUMENT_SPECS[id].titleKey], id);
    handle.dispose();
  }
});

test('sections nest under the title: each is labelled by its own <h3>', () => {
  for (const id of PUBLIC_DOCUMENT_IDS) {
    const { surface, handle } = mount(id);
    const sections = surface.querySelectorAll('section');
    assert.ok(sections.length >= 1, id);
    for (const section of sections) {
      const heading = only(section, 'h3');
      assert.equal(section.getAttribute('aria-labelledby'), heading.id, id);
      assert.equal(section.querySelectorAll('h2').length, 0, `${id}: no second title inside a section`);
    }
    handle.dispose();
  }
});

test('policy pages state, in text, that the authoritative policy is not yet published', () => {
  const expected: Readonly<Record<'privacy' | 'terms' | 'fair-play', string>> = {
    privacy: enMessages['publicDocument.privacy.pending'],
    terms: enMessages['publicDocument.terms.pending'],
    'fair-play': enMessages['publicDocument.fairPlay.pending'],
  };
  for (const [id, pending] of Object.entries(expected) as Array<[PublicDocumentId, string]>) {
    const { surface, handle } = mount(id);
    const text = surface.textContent;
    assert.ok(text.includes(enMessages['publicDocument.publicationStatus']), id);
    assert.ok(text.includes(pending), id);
    assert.match(pending, /not been published/, id);
    assert.match(pending, /not the final/, id);
    handle.dispose();
  }
});

/**
 * Neutral publication-state copy only. These patterns name the kinds of statement this
 * engineering increment must not author (obligations, promises, legal claims, sanctions,
 * retention, consent): their appearance means policy text was invented without approval.
 */
const FORBIDDEN_POLICY_CLAIMS: readonly RegExp[] = [
  /\bGDPR\b/i,
  /\bCCPA\b/i,
  /\bcomplian(t|ce)\b/i,
  /\bSection 13\b/i,
  /\bconsent\b/i,
  /\bagree(s|d|ment)?\b/i,
  /\bmust\b/i,
  /\bshall\b/i,
  /\bwe (will|never|always|collect|store|retain|share|sell|ban|delete)\b/i,
  /\bretain(ed|s)?\b|\bretention\b/i,
  /\bpermanent(ly)?\b/i,
  /\bban(s|ned|ning)?\b/i,
  /\bsuspen(d|sion)\b/i,
  /\bcheat(s|ers?|ing)?\b/i,
  /\bengine assistance\b/i,
  /\barbitration\b/i,
  /\bjurisdiction\b/i,
  /\b(age|years old|under 1[0-9])\b/i,
  /\brefund/i,
  /\bcookie/i,
  /\bliab(le|ility)\b/i,
  /\bwarrant(y|ies)\b/i,
  /\bright to\b/i,
];

test('no public-document message key carries policy, consent or legal-sufficiency claims', () => {
  const keys = Object.keys(enMessages).filter((key) => key.startsWith('publicDocument.'));
  assert.ok(keys.length > 0);
  for (const key of keys) {
    const text = enMessages[key as keyof typeof enMessages];
    for (const pattern of FORBIDDEN_POLICY_CLAIMS) {
      assert.doesNotMatch(text, pattern, `${key}: "${text}"`);
    }
  }
});

test('every key a spec references exists in the English catalog', () => {
  for (const id of PUBLIC_DOCUMENT_IDS) {
    const spec = PUBLIC_DOCUMENT_SPECS[id];
    const keys = [
      spec.titleKey,
      ...spec.introKeys,
      ...spec.sections.flatMap((section) => [section.headingKey, ...section.paragraphKeys]),
    ];
    for (const key of keys) assert.ok(key in enMessages, `${id}: ${key}`);
  }
});

test('the document title names the page while mounted and is restored on dispose', () => {
  const { doc, handle } = mount('privacy');
  assert.equal(
    (doc as unknown as { title: string }).title,
    `${enMessages['publicDocument.privacy.title']} · ${enMessages['shell.title']}`,
  );
  handle.dispose();
  assert.equal((doc as unknown as { title: string }).title, 'Rookzen');
});

test('dispose empties the surface and stops reacting to locale changes', () => {
  const { doc, surface, i18n, handle } = mount('terms');
  assert.ok(surface.children.length > 0);
  handle.dispose();
  assert.equal(surface.children.length, 0);
  i18n.setLocale('ar');
  assert.equal(surface.children.length, 0, 'a disposed document must not re-render');
  // A listener left subscribed would retitle whatever route is showing now.
  assert.equal((doc as unknown as { title: string }).title, 'Rookzen');
  handle.dispose(); // idempotent
  assert.equal((doc as unknown as { title: string }).title, 'Rookzen');
});

test('focus moves to the title only for in-app navigation, never on a direct load', () => {
  const navigated = mount('fair-play', { focusHeading: true });
  const title = only(navigated.surface, 'h2');
  assert.equal(title.getAttribute('tabindex'), '-1', 'programmatic focus target, not a tab stop');
  assert.equal((navigated.doc as unknown as { activeElement?: unknown }).activeElement, title);
  navigated.handle.dispose();

  const direct = mount('fair-play', { focusHeading: false });
  assert.equal((direct.doc as unknown as { activeElement?: unknown }).activeElement, undefined);
  direct.handle.dispose();
});

test('a locale change relocalizes in place: same nodes, focus kept, direction applied', () => {
  const { doc, surface, i18n, handle } = mount('about', { revision: SHA, focusHeading: true });
  const title = only(surface, 'h2');
  const link = only(surface, 'a[data-source-link="repository"]');
  assert.equal((doc as unknown as { activeElement?: unknown }).activeElement, title);

  i18n.setLocale('ar');

  assert.equal(only(surface, 'h2'), title, 'the heading node is reused, not rebuilt');
  assert.equal(only(surface, 'a[data-source-link="repository"]'), link);
  assert.equal((doc as unknown as { activeElement?: unknown }).activeElement, title, 'focus survives');
  assert.equal(title.textContent, 'حول روك زن');
  assert.equal(doc.documentElement.getAttribute('dir'), 'rtl');
  // Technical tokens stay LTR inside the RTL page.
  assert.equal(link.getAttribute('dir'), 'ltr');
  assert.equal(only(surface, 'code').getAttribute('dir'), 'ltr');
  assert.equal((doc as unknown as { title: string }).title, 'حول روك زن · روك زن');
  handle.dispose();
});

test('/about links the canonical repository with a safe, same-tab external link', () => {
  const { surface, handle } = mount('about');
  const link = only(surface, 'a[data-source-link="repository"]');
  assert.equal(link.getAttribute('href'), 'https://github.com/sayed710/rocky');
  assert.equal(new URL(link.getAttribute('href')!).protocol, 'https:');
  assert.equal(link.textContent, 'https://github.com/sayed710/rocky', 'the accessible name is the URL itself');
  assert.equal(link.getAttribute('target'), null, 'no new browsing context, so no tabnabbing surface');
  assert.match(link.getAttribute('rel') ?? '', /\bnoreferrer\b/);
  assert.equal(link.getAttribute('data-route'), null, 'external: must not be captured by the SPA router');
  assert.ok(link.classList.contains('bidi-ltr'));
  handle.dispose();
});

test('/about states the declared license and labels each source fact', () => {
  const { surface, handle } = mount('about');
  const text = surface.textContent;
  assert.ok(text.includes(enMessages['publicDocument.about.license']));
  assert.match(enMessages['publicDocument.about.license'], /AGPL-3\.0-or-later/);
  const terms = surface.querySelectorAll('dt').map((dt) => dt.textContent);
  assert.deepEqual(terms, [
    enMessages['publicDocument.about.repositoryLabel'],
    enMessages['publicDocument.about.revisionLabel'],
  ]);
  handle.dispose();
});

test('/about links the exact build commit when the build recorded one', () => {
  const { surface, handle } = mount('about', { revision: SHA });
  const link = only(surface, 'a[data-source-link="revision"]');
  assert.equal(link.getAttribute('href'), `https://github.com/sayed710/rocky/commit/${SHA}`);
  assert.equal(link.getAttribute('target'), null);
  assert.match(link.getAttribute('rel') ?? '', /\bnoreferrer\b/);
  const code = only(link, 'code');
  assert.equal(code.textContent, SHA);
  assert.equal(code.getAttribute('dir'), 'ltr');
  assert.equal(surface.textContent.includes(enMessages['publicDocument.about.revisionUnavailable']), false);
  handle.dispose();
});

test('/about says the revision is unavailable instead of inventing one', () => {
  for (const revision of [null, 'HEAD', 'abc1234', '0'.repeat(40)]) {
    const { surface, handle } = mount('about', { revision });
    assert.equal(surface.querySelectorAll('a[data-source-link="revision"]').length, 0, String(revision));
    assert.equal(surface.querySelectorAll('code').length, 0, String(revision));
    assert.ok(surface.textContent.includes(enMessages['publicDocument.about.revisionUnavailable']));
    handle.dispose();
  }
});

test('policy pages do not carry source links: disclosure lives on /about only', () => {
  for (const id of ['privacy', 'terms', 'fair-play'] as const) {
    const { surface, handle } = mount(id, { revision: SHA });
    assert.equal(surface.querySelectorAll('a').length, 0, id);
    assert.equal(surface.querySelectorAll('dl').length, 0, id);
    handle.dispose();
  }
});

test('no interactive control other than the source links is rendered', () => {
  for (const id of PUBLIC_DOCUMENT_IDS) {
    const { surface, handle } = mount(id, { revision: SHA });
    for (const tag of ['button', 'input', 'form', 'select', 'textarea']) {
      assert.equal(surface.querySelectorAll(tag).length, 0, `${id}: unexpected <${tag}>`);
    }
    handle.dispose();
  }
});

test('copy is written as text, never parsed as markup', () => {
  // A catalog value containing markup must arrive as literal text.
  const i18n = createTestI18n();
  i18n.registerCatalog('ar', {
    ...enMessages,
    'publicDocument.terms.title': '<img src=x onerror=alert(1)>',
  });
  i18n.setLocale('ar');
  const { surface, handle } = mount('terms', { i18n });
  const title = only(surface, 'h2');
  assert.equal(title.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(surface.querySelectorAll('img').length, 0);
  for (const node of surface.querySelectorAll()) assert.equal(node.innerHTML, '', 'innerHTML must stay unused');
  handle.dispose();
});
