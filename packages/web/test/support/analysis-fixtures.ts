/**
 * Shared DOM and payload fixtures for the analysis tests.
 *
 * Extracted so the variant-gate suite can live in its own file. That separation is not tidiness:
 * `loadCapabilities` memoises per module with deliberately no reset seam, so the first capability
 * payload fetched in a process is the one every later test sees — and a suite that needs to state
 * what the deployment advertises has to own that memo. `node --test` isolates per file, so a second
 * file is the only lever available.
 */
import type { AnalysisResponse } from '../../src/api/models.js';
import type { StateView, WsColor } from '../../src/net/ws-protocol.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/ports/http.js';
import { ENGINE_BOT_USER_IDS } from '@chess-platform/game';

export class FakeElement {
  private _innerHTML = '';
  textContent = '';
  classList = new Set<string>();
  /** Mirrors the real property, so a view that groups nodes by class can be asserted on. */
  className = '';
  disabled = false;
  /** Mirrors the real property, so a radio group's selected option can be asserted on. */
  checked = false;
  hidden = false;
  dataset: Record<string, string> = {};
  type = 'button';
  id = '';
  value = '3';
  focused = false;
  onclick: ((event: Event) => void) | null = null;
  readonly attributes = new Map<string, string>();
  readonly listeners: Record<string, ((e: Event) => void)[]> = {};
  children: FakeElement[] = [];

  constructor(id: string = '') {
    this.id = id;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  get childElementCount() {
    return this.children.length;
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
    if (val === '') {
      this.children = [];
    }
  }

  addEventListener = (type: string, fn: (e: Event) => void) => {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  };

  removeEventListener = (type: string, fn: (e: Event) => void) => {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((cb) => cb !== fn);
  };

  focus = () => {
    this.focused = true;
  };

  setAttribute = (name: string, value: string) => {
    this.attributes.set(name, value);
  };

  getAttribute = (name: string) => {
    return this.attributes.get(name) ?? null;
  };

  appendChild = (child: FakeElement) => {
    this.children.push(child);
    return child;
  };

  /** The variadic form. Views that build a control from several nodes at once use it. */
  append = (...nodes: FakeElement[]) => {
    this.children.push(...nodes);
  };

  replaceChildren = (...nodes: FakeElement[]) => {
    this.children = [...nodes];
  };

  removeChild = (child: FakeElement) => {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    return child;
  };

  querySelectorAll = () => [];
  querySelector = () => null;
  style: Record<string, string> = {};

  click() {
    if (this.disabled) return;
    const event = new Event('click');
    this.onclick?.(event);
    this.listeners['click']?.forEach((fn) => fn(event));
  }

  get ownerDocument() {
    return {
      createElement: (_tag: string) => new FakeElement(),
    } as unknown as Document;
  }
}

export class AsyncTransport implements HttpTransport {
  readonly calls: HttpRequest[] = [];
  handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;

  constructor(handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse) {
    this.handler = handler;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    return this.handler(req);
  }
}

export const GAME_ELEMENT_IDS = [
  'board',
  'status',
  'flip',
  'clock',
  'clock-white',
  'clock-black',
  'meta-connection',
  'meta-role',
  'meta-white',
  'meta-white-name',
  'meta-black',
  'meta-black-name',
  'meta-spectators',
  'meta-variant',
  'meta-time',
  'meta-live-status',
  'game-actions',
  'action-error',
  'action-offer-draw',
  'action-claim-flag',
  'action-resign',
  'action-abort',
  'confirm-resign',
  'confirm-resign-yes',
  'confirm-resign-no',
  'confirm-abort',
  'confirm-abort-yes',
  'confirm-abort-no',
  'draw-offer-received',
  'action-accept-draw',
  'action-decline-draw',
  'game-review',
  'game-review-run',
  'game-review-note',
  'game-review-error',
  'game-review-summary',
  'game-review-moves',
  'analysis',
  'analysis-heading',
  'analysis-run',
  'analysis-lines',
  'analysis-note',
  'analysis-error',
  'analysis-results',
  'analysis-reached',
  'analysis-limits',
  'puzzle',
  'puzzle-run',
  'puzzle-note',
  'puzzle-error',
  'puzzle-result',
  'puzzle-rows',
  'opening',
  'opening-heading',
  'opening-run',
  'opening-note',
  'opening-error',
  'opening-result',
  'opening-rows',
  'coach',
  'coach-heading',
  'coach-run',
  'coach-note',
  'coach-error',
  'coach-result',
  'coach-rows',
  'explain',
  'explain-run',
  'explain-note',
  'explain-error',
  'explain-result',
  'explain-evidence',
  'explain-prose',
  'explain-source',
  'assess',
  'assess-run',
  'assess-note',
  'assess-error',
  'assess-result',
  'assess-rows',
] as const;

export function createGameDocument(): {
  readonly doc: Document;
  readonly elements: Map<string, FakeElement>;
} {
  const elements = new Map<string, FakeElement>();
  for (const id of GAME_ELEMENT_IDS) {
    const el = new FakeElement(id);
    if (
      id === 'game-actions' ||
      id === 'action-error' ||
      id === 'confirm-resign' ||
      id === 'confirm-abort' ||
      id === 'draw-offer-received' ||
      id === 'game-review' ||
      id === 'game-review-error' ||
      id === 'game-review-summary' ||
      id === 'analysis' ||
      id === 'analysis-error' ||
      id === 'analysis-reached' ||
      id === 'analysis-limits' ||
      id === 'puzzle' ||
      id === 'puzzle-error' ||
      id === 'puzzle-result' ||
      // Mirrors index.html: the explain block and its result group ship hidden, so a test asserting
      // the capability reveals them starts from the same state the browser does.
      id === 'explain' ||
      id === 'explain-error' ||
      id === 'explain-result' ||
      id === 'assess' ||
      id === 'assess-error' ||
      id === 'assess-result' ||
      id === 'opening' ||
      id === 'opening-error' ||
      id === 'opening-result' ||
      id === 'coach' ||
      id === 'coach-error' ||
      id === 'coach-result'
    ) {
      el.hidden = true;
    }
    if (
      id === 'analysis-results' ||
      id === 'assess-result' ||
      id === 'puzzle-result' ||
      id === 'opening-result'
    ) {
      el.setAttribute('aria-busy', 'false');
    }
    elements.set(id, el);
  }

  const doc = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => new FakeElement(),
  } as unknown as Document;

  return { doc, elements };
}

/**
 * `moves` defaults to empty, which is what most fixtures want. Opening identification is the one
 * feature that reads the ledger rather than the position, so it passes a real one.
 */
export function makeState(
  fen: string,
  ply = 0,
  turn: WsColor = 'w',
  moves: readonly { readonly ply: number; readonly uci: string; readonly san: string; readonly by: WsColor }[] = [],
  players: StateView['players'] = { white: 'u1', black: ENGINE_BOT_USER_IDS.novice },
): StateView {
  return {
    gameId: 'g-test-1',
    variant: 'standard',
    players,
    timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    fen,
    fenHash: `h${ply}`,
    ply,
    turn,
    clock: { w: 60_000, b: 60_000 },
    turnStartedAt: null,
    status: { over: false },
    drawOffer: null,
    moves,
    legalMoves: {},
    chess960StartId: null,
  };
}

/** A completed game snapshot for controls that are intentionally post-game only. */
export function makeFinishedState(
  fen: string,
  ply = 0,
  turn: WsColor = 'w',
  moves: readonly { readonly ply: number; readonly uci: string; readonly san: string; readonly by: WsColor }[] = [],
  players?: StateView['players'],
): StateView {
  return {
    ...makeState(fen, ply, turn, moves, players),
    status: { over: true, result: '1-0', termination: 'checkmate', winner: 'w' },
    legalMoves: {},
  };
}

export function sampleAnalysisResponse(): AnalysisResponse {
  return {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    variant: 'standard',
    applied: {
      depth: 16,
      movetimeMs: 1000,
      multiPv: 3,
    },
    lines: [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 40 },
        moves: ['e2e4', 'e7e5', 'g1f3'],
        depth: 12,
        nodes: 150000,
        timeMs: 850,
      },
      {
        multipv: 2,
        evaluation: { type: 'cp', value: 25 },
        moves: ['d2d4', 'd7d5'],
        depth: 12,
        nodes: 140000,
        timeMs: 850,
      },
      {
        multipv: 3,
        evaluation: { type: 'cp', value: 10 },
        moves: ['c2c4', 'c7c5'],
        depth: 12,
        nodes: 130000,
        timeMs: 850,
      },
    ],
  };
}
