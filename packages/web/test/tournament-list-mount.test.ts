import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mountTournamentList } from '../src/app/competition-mounts.js';
import type { TournamentController } from '../src/app/tournament-controller.js';
import { GambitClient } from '../src/api/client.js';
import { createI18nManager } from '../src/i18n/index.js';
import { json } from './support/fake-transport.js';
import type { HttpTransport, HttpRequest, HttpResponse } from '../src/ports/http.js';
import type { TournamentSummary } from '../src/api/models.js';
import { FakeElement, createFakeDoc } from './support/localization-dom.js';

interface DeferredRequest {
  readonly request: HttpRequest;
  readonly resolve: (res: HttpResponse) => void;
  readonly reject: (err: unknown) => void;
}

class DeferredTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  readonly pending: DeferredRequest[] = [];

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return new Promise<HttpResponse>((resolve, reject) => {
      this.pending.push({ request, resolve, reject });
    });
  }

  flush(response: HttpResponse): void {
    const next = this.pending.shift();
    if (!next) throw new Error('No pending request to flush');
    next.resolve(response);
  }

  rejectNext(error: unknown): void {
    const next = this.pending.shift();
    if (!next) throw new Error('No pending request to reject');
    next.reject(error);
  }
}

const flushAsync = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

function changeFilter(filterEl: FakeElement, value: string): void {
  filterEl.value = value;
  filterEl.dispatchEvent({ type: 'change', target: filterEl });
}

const getRows = (el: FakeElement): FakeElement[] =>
  el.children.filter((c) => c.classList.contains('panel-row'));

interface FixtureContext {
  doc: Document;
  listEl: FakeElement;
  errorEl: FakeElement;
  filterEl: FakeElement;
  statusEl: FakeElement;
  labelEl: FakeElement;
  transport: DeferredTransport;
  client: GambitClient;
  i18n: ReturnType<typeof createI18nManager>;
  mount: () => TournamentController;
}

async function withFixture(fn: (f: FixtureContext) => Promise<void>): Promise<void> {
  const elementMap = new Map<string, FakeElement>();
  const listEl = new FakeElement('div', 'tournament-list');
  const errorEl = new FakeElement('div', 'tournaments-error');
  const filterEl = new FakeElement('select', 'tournament-state-filter');
  const statusEl = new FakeElement('div', 'tournaments-status');
  const labelEl = new FakeElement('label', 'tournament-state-filter-label');
  labelEl.textContent = 'Filter loaded tournaments';

  elementMap.set('tournament-list', listEl);
  elementMap.set('tournaments-error', errorEl);
  elementMap.set('tournament-state-filter', filterEl);
  elementMap.set('tournaments-status', statusEl);
  elementMap.set('tournament-state-filter-label', labelEl);

  const doc = createFakeDoc(elementMap);
  const transport = new DeferredTransport();
  const client = new GambitClient({ baseUrl: 'https://api.test', transport });
  const i18n = createI18nManager();

  const controllers: TournamentController[] = [];
  const mount = (): TournamentController => {
    const c = mountTournamentList(doc, client, i18n);
    controllers.push(c);
    return c;
  };

  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    Object.defineProperty(globalThis, 'document', {
      value: doc,
      configurable: true,
      writable: true,
    });
    await fn({ doc, listEl, errorEl, filterEl, statusEl, labelEl, transport, client, i18n, mount });
  } finally {
    for (const c of controllers) c.dispose();
    if (prevDescriptor !== undefined) {
      Object.defineProperty(globalThis, 'document', prevDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  }
}

describe('mountTournamentList', () => {
  it('TSF01/02: exercises all 3 state filters, order restoration, pending selection, invalid changes, and no extra HTTP', () =>
    withFixture(async ({ listEl, filterEl, statusEl, labelEl, transport, i18n, mount }) => {
      mount();
      await flushAsync();
      assert.equal(transport.requests.length, 1);
      assert.equal(listEl.getAttribute('aria-busy'), 'true');
      assert.ok(listEl.textContent.includes(i18n.t('common.loading')));

      changeFilter(filterEl, 'running');
      assert.equal(filterEl.value, 'running');

      const data: readonly TournamentSummary[] = [
        { id: 't-1', name: 'Alpha Reg', state: 'registration', format: 'swiss', participantCount: 4 },
        { id: 't-2', name: 'Beta Run', state: 'running', format: 'arena', participantCount: 8 },
        { id: 't-3', name: 'Gamma Fin', state: 'finished', format: 'round_robin', participantCount: 6 },
        { id: 't-4', name: 'Delta Reg', state: 'registration', format: 'swiss', participantCount: 12 },
      ];
      transport.flush(json(200, data));
      await flushAsync();

      assert.equal(listEl.getAttribute('aria-busy'), 'false');
      assert.equal(filterEl.value, 'running');
      assert.equal(statusEl.textContent.trim(), 'Showing 1 of 4 loaded tournaments');
      assert.equal(getRows(listEl).length, 1);
      assert.ok(getRows(listEl)[0]?.textContent.includes('Beta Run'));

      changeFilter(filterEl, 'registration');
      assert.equal(statusEl.textContent.trim(), 'Showing 2 of 4 loaded tournaments');
      const regRows = getRows(listEl);
      assert.equal(regRows.length, 2);
      assert.ok(regRows[0]?.textContent.includes('Alpha Reg'));
      assert.ok(regRows[1]?.textContent.includes('Delta Reg'));

      changeFilter(filterEl, 'finished');
      assert.equal(statusEl.textContent.trim(), 'Showing 1 of 4 loaded tournaments');
      assert.equal(getRows(listEl).length, 1);
      assert.ok(getRows(listEl)[0]?.textContent.includes('Gamma Fin'));

      changeFilter(filterEl, 'all');
      assert.equal(statusEl.textContent.trim(), 'Showing 4 of 4 loaded tournaments');
      const allRows = getRows(listEl);
      assert.equal(allRows.length, 4);
      assert.ok(allRows[0]?.textContent.includes('Alpha Reg'));
      assert.ok(allRows[1]?.textContent.includes('Beta Run'));
      assert.ok(allRows[2]?.textContent.includes('Gamma Fin'));
      assert.ok(allRows[3]?.textContent.includes('Delta Reg'));

      changeFilter(filterEl, 'bogus_state');
      assert.equal(filterEl.value, 'all');
      assert.equal(statusEl.textContent.trim(), 'Showing 4 of 4 loaded tournaments');
      const bogusRows = getRows(listEl);
      assert.equal(bogusRows.length, 4);
      assert.ok(bogusRows[0]?.textContent.includes('Alpha Reg'));
      assert.ok(bogusRows[1]?.textContent.includes('Beta Run'));
      assert.ok(bogusRows[2]?.textContent.includes('Gamma Fin'));
      assert.ok(bogusRows[3]?.textContent.includes('Delta Reg'));

      assert.ok(labelEl.textContent.includes(i18n.t('tournaments.filterLabel')));
      assert.equal(transport.requests.length, 1);
    }));

  it('TSF03: differentiates true empty vs success no-match with counts, titles, and encoded links', () =>
    withFixture(async ({ listEl, filterEl, statusEl, transport, i18n, mount }) => {
      const controller = mount();
      await flushAsync();
      transport.flush(json(200, []));
      await flushAsync();

      assert.equal(statusEl.textContent.trim(), 'Showing 0 of 0 loaded tournaments');
      assert.ok(listEl.textContent.includes(i18n.t('tournaments.emptyListTitle')));
      assert.ok(listEl.textContent.includes(i18n.t('tournaments.emptyListBody')));

      const reload = controller.loadList();
      await flushAsync();
      assert.equal(transport.requests.length, 2);

      const specId = 't/special id?q=a&flag=<x>';
      const specName = '<script>alert(1)</script> & "Lit"';
      const items: readonly TournamentSummary[] = [
        { id: specId, name: specName, state: 'registration', format: 'swiss', participantCount: 2 },
        { id: 't-2', name: 'Reg Two', state: 'registration', format: 'arena', participantCount: 4 },
      ];
      transport.flush(json(200, items));
      await reload;
      await flushAsync();

      changeFilter(filterEl, 'finished');
      assert.equal(statusEl.textContent.trim(), 'Showing 0 of 2 loaded tournaments');
      assert.ok(listEl.textContent.includes(i18n.t('tournaments.noMatchTitle')));
      assert.ok(listEl.textContent.includes(i18n.t('tournaments.noMatchBody')));
      assert.equal(listEl.textContent.includes(i18n.t('tournaments.emptyListTitle')), false);
      assert.equal(getRows(listEl).length, 0);

      changeFilter(filterEl, 'all');
      const link = getRows(listEl)[0]?.children.find((c) => c.tagName === 'A');
      assert.ok(link);
      assert.equal(link.getAttribute('href'), `/tournaments/${encodeURIComponent(specId)}`);
      assert.equal(link.textContent, specName);
      assert.equal(link.querySelector('script'), null);
      assert.equal(link.querySelector('img'), null);
    }));

  it('TSF04: loadList handles lifecycle, retains filter, clears errors, and prevents resurrection', () =>
    withFixture(async ({ listEl, errorEl, filterEl, statusEl, transport, i18n, mount }) => {
      const controller = mount();
      await flushAsync();
      transport.flush(json(200, [
        { id: '1', name: 'R1', state: 'registration', format: 'swiss', participantCount: 2 },
        { id: '2', name: 'U1', state: 'running', format: 'arena', participantCount: 2 },
      ]));
      await flushAsync();

      changeFilter(filterEl, 'running');
      assert.equal(statusEl.textContent.trim(), 'Showing 1 of 2 loaded tournaments');

      const reload1 = controller.loadList();
      await flushAsync();
      assert.equal(listEl.getAttribute('aria-busy'), 'true');
      assert.ok(listEl.textContent.includes(i18n.t('common.loading')));
      assert.equal(statusEl.textContent, '');
      assert.equal(errorEl.textContent, '');

      changeFilter(filterEl, 'registration');
      await i18n.setLocale('ar');
      await flushAsync();
      assert.equal(listEl.getAttribute('aria-busy'), 'true');
      assert.ok(listEl.textContent.includes(i18n.t('common.loading')));
      assert.equal(listEl.textContent.includes('R1'), false);
      assert.equal(listEl.textContent.includes('U1'), false);

      transport.flush(json(400, { error: { code: 'bad_request', message: 'Tournament list failed' } }));
      await reload1;
      await flushAsync();

      assert.equal(listEl.getAttribute('aria-busy'), 'false');
      assert.ok(errorEl.textContent.includes('Tournament list failed'));
      assert.equal(statusEl.textContent, '');
      assert.equal(listEl.children.length, 0);

      changeFilter(filterEl, 'all');
      assert.equal(listEl.children.length, 0);
      assert.equal(statusEl.textContent, '');

      await i18n.setLocale('en');
      await flushAsync();
      changeFilter(filterEl, 'running');

      const reload2 = controller.loadList();
      await flushAsync();
      transport.flush(json(200, [
        { id: '3', name: 'R2', state: 'registration', format: 'swiss', participantCount: 4 },
        { id: '4', name: 'U2', state: 'running', format: 'arena', participantCount: 4 },
        { id: '5', name: 'U3', state: 'running', format: 'arena', participantCount: 4 },
      ]));
      await reload2;
      await flushAsync();

      assert.equal(errorEl.textContent, '');
      assert.equal(filterEl.value, 'running');
      assert.equal(statusEl.textContent.trim(), 'Showing 2 of 3 loaded tournaments');
      assert.equal(getRows(listEl).length, 2);
    }));

  it('TSF05/06: old deferred completion and listener inert on same DOM, remount resets, and EN/AR preserved', () =>
    withFixture(async ({ doc, listEl, errorEl, filterEl, statusEl, labelEl, transport, i18n, mount }) => {
      const c1 = mount();
      await flushAsync();
      assert.equal(transport.requests.length, 1);
      const oldListener = filterEl.listeners['change']?.[0];
      assert.ok(oldListener);
      errorEl.textContent = 'Stale error';
      statusEl.textContent = 'Stale status';
      c1.dispose();

      const c2 = mount();
      await flushAsync();
      assert.equal(transport.requests.length, 2);
      assert.equal(filterEl.value, 'all');
      assert.equal(errorEl.textContent, '');
      assert.equal(statusEl.textContent, '');

      filterEl.value = 'finished';
      oldListener({ type: 'change', target: filterEl });
      assert.equal(transport.requests.length, 2);
      assert.equal(statusEl.textContent, '');
      assert.equal(errorEl.textContent, '');
      assert.equal(listEl.getAttribute('aria-busy'), 'true');
      assert.ok(listEl.textContent.includes(i18n.t('common.loading')));
      filterEl.value = 'all';

      transport.flush(json(200, [{ id: 'old', name: 'Old', state: 'registration', format: 'swiss', participantCount: 1 }]));
      await flushAsync();
      assert.equal(listEl.getAttribute('aria-busy'), 'true');
      assert.ok(listEl.textContent.includes(i18n.t('common.loading')));
      assert.equal(statusEl.textContent, '');
      assert.equal(errorEl.textContent, '');
      assert.equal(listEl.textContent.includes('Old'), false);

      transport.flush(json(200, [
        { id: 'new-1', name: 'New Reg', state: 'registration', format: 'swiss', participantCount: 2 },
        { id: 'new-2', name: 'New Run', state: 'running', format: 'arena', participantCount: 2 },
      ]));
      await flushAsync();
      assert.equal(listEl.getAttribute('aria-busy'), 'false');
      assert.ok(listEl.textContent.includes('New Reg'));
      assert.ok(listEl.textContent.includes('New Run'));

      assert.doesNotThrow(() => c1.dispose());

      changeFilter(filterEl, 'running');
      filterEl.focus();
      assert.equal(doc.activeElement, filterEl);

      const reqCount = transport.requests.length;
      await i18n.setLocale('ar');
      await flushAsync();

      assert.equal(transport.requests.length, reqCount);
      assert.equal(filterEl.value, 'running');
      assert.equal(doc.activeElement, filterEl);
      assert.ok(statusEl.textContent.includes('عرض 1 من أصل 2 من البطولات المحملة'));
      assert.ok(labelEl.textContent.includes(i18n.t('tournaments.filterLabel')));

      c2.dispose();
      await i18n.setLocale('en');
      await flushAsync();
      assert.ok(statusEl.textContent.includes('عرض 1 من أصل 2 من البطولات المحملة'));
    }));
});
