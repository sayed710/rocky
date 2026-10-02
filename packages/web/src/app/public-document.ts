/**
 * Public document pages: `/privacy`, `/terms`, `/fair-play` and `/about` (ADR-0153).
 *
 * One renderer and a typed spec per page, rather than a controller per page. A spec names message
 * keys only; every visible string goes through `i18n.t` and lands in `textContent`, so catalog text
 * is never parsed as markup and no policy body is fetched or rendered from Markdown at runtime.
 *
 * Content boundary: the three policy pages carry neutral publication-state copy and nothing else.
 * The authoritative policy text, and where these pages are linked from (D-06) or how registration
 * refers to them (D-07), are owner/legal decisions this module deliberately does not make.
 */
import { el } from './dom.js';
import type { PublicDocumentId } from './router.js';
import type { SourceMetadata } from './source-metadata.js';
import type { MessageKey } from '../i18n/catalog/index.js';
import type { I18n } from '../i18n/manager.js';
import { applyLtrIsolation } from '../i18n/bidi.js';

export interface PublicDocumentSection {
  readonly headingKey: MessageKey;
  readonly paragraphKeys: readonly MessageKey[];
  /** Render the repository and build-revision facts after the paragraphs. */
  readonly sourceDisclosure?: true;
}

export interface PublicDocumentSpec {
  readonly titleKey: MessageKey;
  /** Paragraphs inside the article header, under the title. */
  readonly introKeys: readonly MessageKey[];
  readonly sections: readonly PublicDocumentSection[];
}

function pendingPublication(titleKey: MessageKey, pendingKey: MessageKey): PublicDocumentSpec {
  return {
    titleKey,
    introKeys: [],
    sections: [{ headingKey: 'publicDocument.publicationStatus', paragraphKeys: [pendingKey] }],
  };
}

export const PUBLIC_DOCUMENT_SPECS: Readonly<Record<PublicDocumentId, PublicDocumentSpec>> = {
  privacy: pendingPublication('publicDocument.privacy.title', 'publicDocument.privacy.pending'),
  terms: pendingPublication('publicDocument.terms.title', 'publicDocument.terms.pending'),
  'fair-play': pendingPublication('publicDocument.fairPlay.title', 'publicDocument.fairPlay.pending'),
  about: {
    titleKey: 'publicDocument.about.title',
    introKeys: ['publicDocument.about.intro'],
    sections: [{
      headingKey: 'publicDocument.about.sourceHeading',
      paragraphKeys: ['publicDocument.about.license'],
      sourceDisclosure: true,
    }],
  },
};

export interface PublicDocumentMountOptions {
  readonly doc: Document;
  readonly surface: HTMLElement;
  readonly document: PublicDocumentId;
  readonly i18n: I18n;
  readonly source: SourceMetadata;
  /**
   * Move focus to the title. True for in-app navigation, so keyboard and screen-reader users land
   * on the new page; false for a direct load, where the browser's own start position is right.
   */
  readonly focusHeading: boolean;
}

export interface MountedPublicDocument {
  dispose: () => void;
}

const TITLE_ID = 'public-document-title';
// Same-tab navigation: no `target`, so there is no opener to abuse. `noreferrer` also implies
// `noopener` should a future change add a target.
const EXTERNAL_REL = 'external noreferrer';

/** A text node bound to a message key, re-translated in place on every locale change. */
interface Binding {
  readonly node: HTMLElement;
  readonly key: MessageKey;
}

/** Render a public document into `surface`, keeping it localized until disposed. */
export function mountPublicDocument(options: PublicDocumentMountOptions): MountedPublicDocument {
  const { doc, surface, i18n } = options;
  const spec = PUBLIC_DOCUMENT_SPECS[options.document];
  const bindings: Binding[] = [];
  const bind: Bind = (tag, key, attrs = {}) => {
    const node = el(doc, tag, attrs);
    bindings.push({ node, key });
    return node;
  };

  const title = bind('h2', spec.titleKey, { id: TITLE_ID, class: 'public-document-title', tabindex: '-1' });
  const header = el(doc, 'header', { class: 'public-document-header' }, title);
  for (const key of spec.introKeys) header.append(bind('p', key, { class: 'public-document-lede' }));

  const article = el(doc, 'article', { 'aria-labelledby': TITLE_ID }, header);
  spec.sections.forEach((section, index) => {
    const headingId = `public-document-section-${index + 1}`;
    const node = el(
      doc,
      'section',
      { class: 'public-document-section', 'aria-labelledby': headingId },
      bind('h3', section.headingKey, { id: headingId }),
    );
    for (const key of section.paragraphKeys) node.append(bind('p', key));
    if (section.sourceDisclosure) node.append(renderSourceFacts(doc, options.source, bind));
    article.append(node);
  });

  const previousTitle = doc.title;
  const localize = (): void => {
    for (const { node, key } of bindings) node.textContent = i18n.t(key);
    doc.title = i18n.t('publicDocument.documentTitle', {
      page: i18n.t(spec.titleKey),
      brand: i18n.t('shell.brand'),
    });
  };
  localize();
  surface.replaceChildren(article);
  if (options.focusHeading) title.focus();

  const unsubscribe = i18n.onLocaleChange(localize);
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      surface.replaceChildren();
      doc.title = previousTitle;
    },
  };
}

type Bind = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  key: MessageKey,
  attrs?: Record<string, string>,
) => HTMLElementTagNameMap[K];

/**
 * Repository and build revision as a description list. Both values are technical LTR tokens, so
 * they are isolated from the surrounding page direction. The revision is linked only when the
 * build recorded a validated one; otherwise the list says so in words.
 */
function renderSourceFacts(doc: Document, source: SourceMetadata, bind: Bind): HTMLDListElement {
  const repositoryLink = externalLink(doc, source.repository.url, 'repository');
  repositoryLink.textContent = source.repository.url;

  let revisionValue: HTMLElement;
  if (source.revision === null) {
    revisionValue = bind('span', 'publicDocument.about.revisionUnavailable');
  } else {
    revisionValue = externalLink(doc, source.revision.commitUrl, 'revision');
    const code = el(doc, 'code', { class: 'public-document-sha' });
    code.textContent = source.revision.sha;
    applyLtrIsolation(code);
    revisionValue.append(code);
  }

  return el(
    doc,
    'dl',
    { class: 'public-document-facts' },
    bind('dt', 'publicDocument.about.repositoryLabel'),
    el(doc, 'dd', {}, repositoryLink),
    bind('dt', 'publicDocument.about.revisionLabel'),
    el(doc, 'dd', {}, revisionValue),
  );
}

/**
 * `href` values come only from {@link SourceMetadata}, which builds them from validated parts. The
 * protocol is still checked here, at the sink, so no later change can route another scheme into it.
 */
function externalLink(doc: Document, href: string, kind: 'repository' | 'revision'): HTMLAnchorElement {
  if (new URL(href).protocol !== 'https:') throw new Error(`Refusing non-HTTPS source link: ${href}`);
  const link = el(doc, 'a', { href, rel: EXTERNAL_REL, class: 'public-document-link', 'data-source-link': kind });
  applyLtrIsolation(link);
  return link;
}
