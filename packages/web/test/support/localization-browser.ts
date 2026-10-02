import { mountLesson } from '../../src/app/learning-mounts.js';
import { I18n } from '../../src/i18n/manager.js';
import { enMessages, type MessagesCatalog } from '../../src/i18n/catalog/index.js';
import type { GambitClient } from '../../src/api/client.js';
import type { AttemptResultView } from '../../src/api/models.js';
import { STARTING_FEN } from '../../src/core/position.js';

/** Real DOM harness: only the API response is held; rendering/events use production modules. */
export const harness = {
  current: null as null | {
    setLocale: (locale: 'en' | 'ar') => void;
    resolve: () => void;
    dispose: () => void;
    calls: () => number;
  },
  async mount(kind: 'move' | 'text' | 'quiz'): Promise<void> {
    this.current?.dispose();
    document.body.innerHTML = '<section id="lesson"><h1 id="lesson-title"></h1><p id="lesson-progress"></p><p id="lesson-error"></p><div id="step-list"></div></section>';
    let finish!: (result: AttemptResultView) => void;
    const response = new Promise<AttemptResultView>((resolve) => { finish = resolve; });
    let calls = 0;
    const client = { session: { isAuthenticated: false }, learning: {
      lesson: async () => ({ id: 'l1', courseId: 'c1', title: 'Lesson' }),
      steps: async () => [{ id: 's1', lessonId: 'l1', orderIndex: 0, active: true, kind, fen: STARTING_FEN, hint: null, prose: 'Read', question: 'Choose', options: ['A', 'B'] }],
      attempt: () => { calls++; return response; },
    } } as unknown as GambitClient;
    const i18n = new I18n({ doc: document, catalogs: { ar: Object.fromEntries(Object.entries(enMessages).map(([k, v]) => [k, `AR ${v}`])) as MessagesCatalog } });
    const mounted = mountLesson({ doc: document, surface: document.getElementById('lesson')!, client, lessonId: 'l1', sessionPresent: true, restorePromise: Promise.resolve(), i18n });
    this.current = { setLocale: (value) => i18n.setLocale(value), resolve: () => finish({ stepId: 's1', correct: true, attempts: 1 }), dispose: () => mounted.dispose(), calls: () => calls };
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  },
};

declare global {
  interface Window { localization: { harness: typeof harness } }
}
