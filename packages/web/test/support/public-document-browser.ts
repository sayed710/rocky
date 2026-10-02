/**
 * Real-DOM harness for the public document view under an Arabic, right-to-left test catalog.
 *
 * Production registers English only, so the app itself cannot be switched to Arabic. This mounts
 * the production renderer against `document` with a test-only Arabic catalog, letting a browser
 * measure real RTL layout, bidi isolation and focus. The Arabic strings below are test fixtures,
 * not an approved translation.
 */
import { mountPublicDocument } from '../../src/app/public-document.js';
import { createSourceMetadata } from '../../src/app/source-metadata.js';
import type { PublicDocumentId } from '../../src/app/router.js';
import { I18n } from '../../src/i18n/manager.js';
import { enMessages, type MessageKey, type MessagesCatalog } from '../../src/i18n/catalog/index.js';

const ARABIC_TEST_STRINGS: Partial<Record<MessageKey, string>> = {
  'shell.brand': 'روك زن',
  'publicDocument.documentTitle': '{page} · {brand}',
  'publicDocument.publicationStatus': 'حالة النشر',
  'publicDocument.privacy.title': 'الخصوصية',
  'publicDocument.privacy.pending': 'نص اختباري: لم يُنشر النص المعتمد لهذه الصفحة بعد.',
  'publicDocument.terms.title': 'الشروط',
  'publicDocument.terms.pending': 'نص اختباري: لم يُنشر النص المعتمد لهذه الصفحة بعد.',
  'publicDocument.fairPlay.title': 'اللعب النظيف',
  'publicDocument.fairPlay.pending': 'نص اختباري: لم يُنشر النص المعتمد لهذه الصفحة بعد.',
  'publicDocument.about.title': 'حول روك زن',
  'publicDocument.about.intro': 'نص اختباري لصفحة حول.',
  'publicDocument.about.sourceHeading': 'الشيفرة المصدرية',
  'publicDocument.about.license': 'نص اختباري عن الترخيص.',
  'publicDocument.about.repositoryLabel': 'مستودع المصدر',
  'publicDocument.about.revisionLabel': 'مراجعة البناء',
  'publicDocument.about.revisionUnavailable': 'نص اختباري: المراجعة غير متاحة.',
};

export const harness = {
  current: null as null | { setLocale: (locale: 'en' | 'ar') => void; dispose: () => void },
  mount(document_: PublicDocumentId, revision: string | null, locale: 'en' | 'ar'): void {
    this.current?.dispose();
    document.body.innerHTML = '<main id="app-main"><section id="public-document" class="public-document"></section></main>';
    const i18n = new I18n({
      doc: document,
      catalogs: { ar: { ...enMessages, ...ARABIC_TEST_STRINGS } as MessagesCatalog },
      initialLocale: locale,
    });
    const mounted = mountPublicDocument({
      doc: document,
      surface: document.getElementById('public-document')!,
      document: document_,
      i18n,
      source: createSourceMetadata(revision),
      focusHeading: true,
    });
    this.current = { setLocale: (value) => i18n.setLocale(value), dispose: () => mounted.dispose() };
  },
};

declare global {
  interface Window { publicDocumentBrowser: { harness: typeof harness } }
}
