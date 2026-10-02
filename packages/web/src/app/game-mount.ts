/**
 * Game route DOM mount.
 *
 * Wires the interactive board, the game synchronization client, the game
 * metadata/clock/status indicators, and player action controls (draw, resign,
 * abort, claim flag) for `/game/:id` routes.
 */
import type { App } from './composition.js';
import type { GambitClient } from '../api/client.js';
import { mountBoard, type MountedBoard } from './board.js';
import { GameController, type GameActionState, type GameMetadataState } from './game-controller.js';
import { AnalysisController } from './analysis-controller.js';
import {
  getAnalysisMessage,
  type AnalysisMessageKey,
  clearLines,
  renderError,
  renderLimits,
  renderLines,
  renderNote,
  renderReached,
  setBusy,
} from './analysis-view.js';
import {
  analysisEnabled,
  analysisSupportsVariant,
  loadCapabilities,
  mistakePredictionEnabled,
  mistakePredictionSupportsVariant,
  moveExplanationEnabled,
  moveExplanationSupportsVariant,
  openingExplorerEnabled,
  coachEnabled,
  puzzleGenerationEnabled,
  puzzleGenerationSupportsVariant,
  gameReviewSupportsVariant,
} from './capabilities-nav.js';
import { PuzzleController } from './puzzle-controller.js';
import { MAX_OPENING_PLIES, OpeningController } from './opening-controller.js';
import type { OpeningTarget } from './opening-controller.js';
import type {
  AnalysisResponse,
  CoachResponse,
  MistakePredictionResponse,
  MoveExplanationResponse,
  OpeningExplorationResponse,
  PuzzleGenerationResponse,
} from '../api/models.js';
import {
  clearOpening,
  openingMessage,
  renderOpeningError,
  renderOpeningNote,
  renderOpeningResult,
  setOpeningBusy,
  type OpeningMessageKey,
} from './opening-view.js';
import { CoachController, MAX_COACH_PLIES } from './coach-controller.js';
import type { CoachTarget } from './coach-controller.js';
import {
  clearCoach,
  coachMessage,
  renderCoachError,
  renderCoachNote,
  renderCoachResult,
  setCoachBusy,
  type CoachMessageKey,
} from './coach-view.js';
import {
  clearPuzzle,
  puzzleMessage,
  renderPuzzleError,
  renderPuzzleNote,
  renderPuzzleResult,
  setPuzzleBusy,
  type PuzzleMessageKey,
} from './puzzle-view.js';
import { AssessController } from './assess-controller.js';
import {
  assessMessage,
  clearVerdict,
  renderAssessError,
  renderAssessNote,
  renderVerdict,
  setAssessBusy,
  setVerdictVisible,
  type AssessMessageKey,
} from './assess-view.js';
import { ExplainController } from './explain-controller.js';
import {
  clearExplanation,
  explainMessage,
  renderError as renderExplainError,
  renderEvidence,
  renderNote as renderExplainNote,
  renderProse,
  renderSource,
  setBusy as setExplainBusy,
  setResultVisible as setExplainResultVisible,
  type ExplainMessageKey,
} from './explain-view.js';
import { formatClock, formatTimeControl } from './render-helpers.js';
import type { AuthSession } from './auth-controller.js';
import { gameReviewAnnotation } from './game-review-annotation.js';
import { GameReviewController } from './game-review-controller.js';
import { isEngineBotUserId } from '@chess-platform/game';
import { applyAutoDirection, applyLtrIsolation } from '../i18n/bidi.js';
import { createI18nManager } from '../i18n/manager.js';
import type { I18nManager } from '../i18n/manager.js';
import { getVariantLabel } from './variant-labels.js';

/**
 * The line counts the panel offers. Every one is at or below the server's published MultiPV
 * maximum, so no selection this UI can produce is outside the contract.
 */
const ANALYSIS_LINE_CHOICES: readonly number[] = [1, 3, 5];
const DEFAULT_ANALYSIS_LINES = 3;

/** Dependencies required to mount the game route. */
interface GameMountDependencies {
  readonly doc: Document;
  readonly boardEl: HTMLElement;
  readonly gameId: string;
  readonly createGameSync: App['createGameSync'];
  readonly createGameOracle: App['createGameOracle'];
  readonly getAccessToken: () => string | undefined;
  readonly client: GambitClient;
  readonly token?: string;
  readonly initialSessionId?: string;
  readonly restorePromise: Promise<AuthSession | null>;
  readonly i18n: I18nManager;
}

/** The result of mounting the game route. */
interface MountedGame {
  readonly board: MountedBoard;
  readonly controller: GameController;
  readonly connectivity: { dispose: () => void };
  readonly analysis: { dispose: () => void };
  /**
   * Called by bootstrap when the signed-in session changes while this route is mounted.
   *
   * Without it, signing in on an open game left Analyse disabled under a stale "Sign in to analyse"
   * note until something incidental — a move, a failed request — happened to refresh it, and signing
   * out left it enabled. The lobby and the profile are notified through the same slot; the game route
   * simply was not.
   */
  readonly onSessionChange: (session: AuthSession | null) => void;
  readonly dispose?: () => void;
}

/**
 * Mount the game route against the given DOM document.
 */
export function mountGame(deps: GameMountDependencies): MountedGame {
  const {
    doc,
    boardEl,
    gameId,
    createGameSync,
    createGameOracle,
    getAccessToken,
    token,
    restorePromise,
    i18n,
  } = deps;

  let lastMetadataState: GameMetadataState | null = null;
  let lastActionState: GameActionState | null = null;
  let lastReviewResult: Awaited<ReturnType<GambitClient['games']['review']>> | null = null;

  const statusEl = doc.getElementById('status');
  const flipEl = doc.getElementById('flip');
  const clockEl = doc.getElementById('clock');
  const whiteClockEl = doc.getElementById('clock-white');
  const blackClockEl = doc.getElementById('clock-black');

  // Game metadata
  const metaConnectionEl = doc.getElementById('meta-connection');
  const metaRoleEl = doc.getElementById('meta-role');
  const metaWhiteEl = doc.getElementById('meta-white');
  const metaWhiteNameEl = doc.getElementById('meta-white-name');
  const metaBlackEl = doc.getElementById('meta-black');
  const metaBlackNameEl = doc.getElementById('meta-black-name');
  const metaSpectatorsEl = doc.getElementById('meta-spectators');
  const metaVariantEl = doc.getElementById('meta-variant');
  const metaTimeEl = doc.getElementById('meta-time');
  const metaLiveStatusEl = doc.getElementById('meta-live-status');

  // Game action controls
  const actionsPanelEl = doc.getElementById('game-actions');
  const actionErrorEl = doc.getElementById('action-error');
  const btnOfferDraw = doc.getElementById('action-offer-draw') as HTMLButtonElement | null;
  const btnClaimFlag = doc.getElementById('action-claim-flag') as HTMLButtonElement | null;
  const btnResign = doc.getElementById('action-resign') as HTMLButtonElement | null;
  const btnAbort = doc.getElementById('action-abort') as HTMLButtonElement | null;
  const confirmResignEl = doc.getElementById('confirm-resign');
  const confirmResignYes = doc.getElementById('confirm-resign-yes');
  const confirmResignNo = doc.getElementById('confirm-resign-no');
  const confirmAbortEl = doc.getElementById('confirm-abort');
  const confirmAbortYes = doc.getElementById('confirm-abort-yes');
  const confirmAbortNo = doc.getElementById('confirm-abort-no');
  const drawOfferReceivedEl = doc.getElementById('draw-offer-received');
  const btnAcceptDraw = doc.getElementById('action-accept-draw');
  const btnDeclineDraw = doc.getElementById('action-decline-draw');

  // Post-game review is deliberately separate from the live engine tools. It is not constructed
  // from browser history: the server owns the finished event stream and verifies player ownership.
  const gameReviewSectionEl = doc.getElementById('game-review');
  const gameReviewRunBtn = doc.getElementById('game-review-run') as HTMLButtonElement | null;
  const gameReviewNoteEl = doc.getElementById('game-review-note');
  const gameReviewErrorEl = doc.getElementById('game-review-error');
  const gameReviewSummaryEl = doc.getElementById('game-review-summary');
  const gameReviewMovesEl = doc.getElementById('game-review-moves');
  let gameReviewCapabilities: unknown = null;
  let gameOver = false;
  let isGamePlayer = false;
  let isHumanGame = false;
  let gameReviewPending = false;
  let currentReviewNoteKey: 'game.review.reviewingMoves' | null = null;
  let currentReviewErrorKey: 'game.review.unavailableError' | null = null;
  let gameReviewSessionId = deps.initialSessionId ?? null;
  let authoritativeGameFen: string | null = null;
  let authoritativeGameTurn = false;
  let authoritativeGameStatus = '';
  let authoritativeLastMove: readonly [string, string] | null = null;

  /** Recompute visibility and availability from game, capability, session, and request state. */
  const refreshGameReview = (): void => {
    const variantSupported = gameReviewSupportsVariant(gameReviewCapabilities, currentVariant);
    if (gameReviewSectionEl) gameReviewSectionEl.hidden = !gameOver || !isGamePlayer || !variantSupported;
    if (gameReviewRunBtn) {
      gameReviewRunBtn.disabled = !gameOver
        || !isGamePlayer
        || !variantSupported
        || gameReviewSessionId === null
        || gameReviewPending;
    }
    if (gameReviewNoteEl && currentReviewNoteKey) {
      gameReviewNoteEl.textContent = i18n.t(currentReviewNoteKey);
    } else if (gameReviewNoteEl && !gameReviewPending && gameReviewMovesEl?.childElementCount === 0) {
      gameReviewNoteEl.textContent = gameReviewSessionId !== null
        ? i18n.t('game.review.noteSignedIn')
        : i18n.t('game.review.noteSignedOut');
    }
    if (gameReviewErrorEl) {
      gameReviewErrorEl.hidden = currentReviewErrorKey === null;
      gameReviewErrorEl.textContent = currentReviewErrorKey ? i18n.t(currentReviewErrorKey) : '';
    }
  };

  /** Remove all private review nodes from persistent route DOM. */
  const clearGameReview = (): void => {
    lastReviewResult = null;
    currentReviewNoteKey = null;
    currentReviewErrorKey = null;
    if (gameReviewErrorEl) {
      gameReviewErrorEl.hidden = true;
      gameReviewErrorEl.textContent = '';
    }
    if (gameReviewSummaryEl) {
      gameReviewSummaryEl.hidden = true;
      gameReviewSummaryEl.replaceChildren();
    }
    gameReviewMovesEl?.replaceChildren();
  };
  clearGameReview();

  // Engine analysis panel (M15 inc 2)
  const analysisSectionEl = doc.getElementById('analysis');
  const analysisRunBtn = doc.getElementById('analysis-run') as HTMLButtonElement | null;
  const analysisLinesSelect = doc.getElementById('analysis-lines') as HTMLSelectElement | null;
  const analysisNoteEl = doc.getElementById('analysis-note');
  const analysisErrorEl = doc.getElementById('analysis-error');
  const analysisResultsEl = doc.getElementById('analysis-results');
  const analysisReachedEl = doc.getElementById('analysis-reached');
  const analysisLimitsEl = doc.getElementById('analysis-limits');

  let lastAnalysisResult: AnalysisResponse | null = null;
  let currentAnalysisNoteKey: AnalysisMessageKey | null = 'idle';
  let currentAnalysisErrorKey: AnalysisMessageKey | null = null;
  const setAnalysisNote = (key: AnalysisMessageKey | null): void => {
    currentAnalysisNoteKey = key;
    if (analysisNoteEl) renderNote(analysisNoteEl, key ? getAnalysisMessage(key, i18n) : null);
  };
  const setAnalysisError = (key: AnalysisMessageKey | null): void => {
    currentAnalysisErrorKey = key;
    if (analysisErrorEl) renderError(analysisErrorEl, key ? getAnalysisMessage(key, i18n) : null);
  };
  const renderAnalysisResult = (): void => {
    if (!lastAnalysisResult) return;
    if (analysisResultsEl) renderLines(analysisResultsEl, lastAnalysisResult);
    if (analysisReachedEl) renderReached(analysisReachedEl, lastAnalysisResult, i18n);
    if (analysisLimitsEl) renderLimits(analysisLimitsEl, lastAnalysisResult, i18n);
  };
  let currentVariant: string | null = null;
  let analysisDisposed = false;
  let analysisAvailable = false;
  /**
   * Set when this game's variant has no engine here — either advertised up front by
   * `analysisVariants`, or learned from a 422 if the advertisement was unavailable. Permanent for
   * the mount, because a game's variant does not change.
   */
  let analysisUnsupported = false;
  /** The capability payload, once it answers. Held so the variant gate can re-run when the variant lands. */
  let analysisCapabilities: unknown = null;

  /**
   * Return the panel to its initial state.
   *
   * Called at mount, because the panel's DOM lives in `index.html` and outlives any single mount —
   * so the rows rendered for the last game are still there when the next one mounts. A fresh
   * controller cannot detect that: it has never analysed anything, so `positionChanged` correctly
   * stays quiet, and the previous game's evaluation would sit beside a new board with nothing to
   * mark it stale. Nothing in the request lifecycle catches it, because no request is involved.
   */
  const resetAnalysisPanel = (): void => {
    lastAnalysisResult = null;
    if (analysisResultsEl) {
      clearLines(analysisResultsEl);
      setBusy(analysisResultsEl, false);
    }
    for (const el of [analysisReachedEl, analysisLimitsEl]) {
      if (el) {
        el.textContent = '';
        el.hidden = true;
      }
    }
    setAnalysisError(null);
    setAnalysisNote('idle');
  };

  resetAnalysisPanel();

  /** Keep mount-time control visibility aligned with the active client session. */
  const isUserAuthenticated = (): boolean => {
    return Boolean(getAccessToken() ?? deps.client.session.current?.tokens.accessToken);
  };

  /** UI-only reinforcement; the API independently enforces the account-wide boundary. */
  const liveHumanGameBlocksAssistance = (): boolean =>
    isGamePlayer && isHumanGame && !gameOver;

  /** Whether there is actually something on the board to analyse yet. */
  const hasPosition = (): boolean => Boolean(currentVariant) && Boolean(controller?.fen);

  /**
   * The single place the run control's enabled state is decided.
   *
   * Three conditions have to hold, and the third is the one that is easy to miss: **there has to be
   * a position**. The panel is revealed as soon as capabilities answer, which happens well before
   * the first game snapshot arrives over the socket — so for a moment the button is present,
   * enabled, and backed by nothing. Clicking it in that window did exactly nothing: `getPosition`
   * returned `null`, `analyse` returned early, and the user got no request and no message. Caught by
   * the e2e spec, whose first test only passed because it happened to change the line selector first
   * and that delay let the snapshot land.
   *
   * Keeping it in one function matters as much as the fix: this was previously decided in two places
   * with two different conditions, which is how they came to disagree.
   */
  const refreshAnalysisControls = (): void => {
    if (analysisDisposed || !analysisAvailable) return;

    // The variant arrives on a game snapshot, which can land either side of the capability answer,
    // so the gate is evaluated here rather than at either arrival point.
    if (
      !analysisUnsupported &&
      currentVariant !== null &&
      !analysisSupportsVariant(analysisCapabilities, currentVariant)
    ) {
      analysisUnsupported = true;
      setAnalysisNote('unsupportedVariant');
    }

    const blocked = liveHumanGameBlocksAssistance();
    if (analysisSectionEl) analysisSectionEl.hidden = analysisUnsupported || blocked;
    if (blocked) {
      if (analysisRunBtn) analysisRunBtn.disabled = true;
      return;
    }
    const authed = isUserAuthenticated();
    if (analysisRunBtn) {
      analysisRunBtn.disabled = !authed || analysisUnsupported || analysisController.isPending || !hasPosition();
    }
    // The note is owned by whatever last had something to say — a result, a failure, an
    // invalidation. This function only handles the one message that is a property of the *control*
    // rather than of a request, and only transitions in and out of exactly that message. An earlier
    // version also restored the idle text whenever the note was empty, which meant a failure that
    // had deliberately cleared it got "Analyse the position on the board." printed back underneath
    // its own error.
    if (!analysisNoteEl) return;
    if (!authed) {
      setAnalysisNote('signedOut');
    } else if (currentAnalysisNoteKey === 'signedOut') {
      setAnalysisNote('idle');
    }
  };

  // Puzzle Generation (M15 inc 17), using the exact position on the board.
  const puzzleBlockEl = doc.getElementById('puzzle');
  const puzzleRunBtn = doc.getElementById('puzzle-run') as HTMLButtonElement | null;
  const puzzleNoteEl = doc.getElementById('puzzle-note');
  const puzzleErrorEl = doc.getElementById('puzzle-error');
  const puzzleResultEl = doc.getElementById('puzzle-result');
  const puzzleRowsEl = doc.getElementById('puzzle-rows');
  let puzzleAvailable = false;
  let puzzleCapabilities: unknown = null;
  let puzzleUnsupported = false;

  let lastPuzzleResult: PuzzleGenerationResponse | null = null;
  let currentPuzzleNoteKey: PuzzleMessageKey | null = null;
  let currentPuzzleErrorKey: PuzzleMessageKey | null = null;
  const resetPuzzleBlock = (): void => {
    lastPuzzleResult = null;
    currentPuzzleNoteKey = 'idle';
    currentPuzzleErrorKey = null;
    if (puzzleRowsEl && puzzleResultEl) clearPuzzle(puzzleRowsEl, puzzleResultEl);
    if (puzzleErrorEl) renderPuzzleError(puzzleErrorEl, null);
    if (puzzleNoteEl) renderPuzzleNote(puzzleNoteEl, puzzleMessage('idle', i18n));
  };
  resetPuzzleBlock();

  /** Keep puzzle visibility and button state aligned with capabilities and the live-game rule. */
  const refreshPuzzleControls = (): void => {
    if (analysisDisposed || !puzzleAvailable) return;
    if (
      !puzzleUnsupported &&
      currentVariant !== null &&
      !puzzleGenerationSupportsVariant(puzzleCapabilities, currentVariant)
    ) puzzleUnsupported = true;

    const servable = !puzzleUnsupported && !liveHumanGameBlocksAssistance();
    if (puzzleBlockEl) puzzleBlockEl.hidden = !servable;
    if (!servable) {
      if (puzzleRunBtn) puzzleRunBtn.disabled = true;
      return;
    }
    const authed = isUserAuthenticated();
    if (puzzleRunBtn) {
      puzzleRunBtn.disabled = !authed || !hasPosition() || puzzleController.isPending;
    }
    const ownsControlNote = currentPuzzleNoteKey === 'idle' || currentPuzzleNoteKey === 'signedOut';
    if (!ownsControlNote || lastPuzzleResult || currentPuzzleErrorKey) return;
    currentPuzzleNoteKey = authed ? 'idle' : 'signedOut';
    if (puzzleNoteEl) renderPuzzleNote(puzzleNoteEl, puzzleMessage(currentPuzzleNoteKey, i18n));
  };

  // Opening identification (M15 inc 19), keyed on the game's move order rather than its position.
  const openingBlockEl = doc.getElementById('opening');
  const openingRunBtn = doc.getElementById('opening-run') as HTMLButtonElement | null;
  const openingNoteEl = doc.getElementById('opening-note');
  const openingErrorEl = doc.getElementById('opening-error');
  const openingResultEl = doc.getElementById('opening-result');
  const openingRowsEl = doc.getElementById('opening-rows');
  let openingAvailable = false;

  // Coaching section (M15 inc 21, ADR-0129).
  const coachBlockEl = doc.getElementById('coach');
  const coachRunBtn = doc.getElementById('coach-run') as HTMLButtonElement | null;
  const coachNoteEl = doc.getElementById('coach-note');
  const coachErrorEl = doc.getElementById('coach-error');
  const coachResultEl = doc.getElementById('coach-result');
  const coachRowsEl = doc.getElementById('coach-rows');
  let coachAvailable = false;

  let lastOpeningResult: OpeningExplorationResponse | null = null;
  let currentOpeningNoteKey: OpeningMessageKey | null = null;
  let currentOpeningErrorKey: OpeningMessageKey | null = null;
  /** Clear the section's content back to the unanswered state, leaving its visibility alone. */
  const resetOpeningBlock = (): void => {
    lastOpeningResult = null;
    currentOpeningNoteKey = 'idle';
    currentOpeningErrorKey = null;
    if (openingRowsEl && openingResultEl) clearOpening(openingRowsEl, openingResultEl);
    if (openingErrorEl) renderOpeningError(openingErrorEl, null);
    if (openingNoteEl) renderOpeningNote(openingNoteEl, openingMessage('idle', i18n));
  };
  resetOpeningBlock();
  // The section lives in `index.html` and outlives the mount, so a previous game's reveal is still
  // in effect here. Re-hidden explicitly rather than left alone: `refreshOpeningControls` reveals
  // it only when the capability says so, and the capability read can fail — in which case nothing
  // would hide it again, and a deployment that does not offer the feature would show it.
  if (openingBlockEl) openingBlockEl.hidden = true;

  let lastCoachResult: CoachResponse | null = null;
  let currentCoachNoteKey: CoachMessageKey | null = null;
  let currentCoachErrorKey: CoachMessageKey | null = null;
  /** Clear the section back to its unasked state: no rows, no error, the idle note. */
  const resetCoachBlock = (): void => {
    lastCoachResult = null;
    currentCoachNoteKey = 'idle';
    currentCoachErrorKey = null;
    if (coachRowsEl && coachResultEl) clearCoach(coachRowsEl, coachResultEl);
    if (coachErrorEl) renderCoachError(coachErrorEl, null);
    if (coachNoteEl) renderCoachNote(coachNoteEl, coachMessage('idle', i18n));
  };
  resetCoachBlock();
  if (coachBlockEl) coachBlockEl.hidden = true;

  /**
   * What the Coach should be asked about, or `null` when there is nothing to ask.
   *
   * The move sequence is sent only while it is within the server's ply ceiling. Past it the opening
   * section of the response would be refused, and the request would fail as a whole rather than
   * simply losing that one section — so the sequence is dropped and the other four still answer.
   */
  const coachTarget = (): CoachTarget | null => {
    if (!coachAvailable || !currentVariant || !controller?.fen) return null;
    const last = controller.lastReplayedMove;
    const moves = controller.moveSequence;
    // `lastReplayedMove.fen` is the position the move was played *from*; `controller.fen` is the
    // position it produced. A move is judged against the position it was played in, so the two must
    // travel together — pairing the played move with the resulting position asks the server to play
    // a move that has already been played, which is illegal in almost every position and answered
    // 422 for every move-coaching request. `lastMoveTarget` below has always paired them correctly;
    // this did not.
    return {
      fen: last ? last.fen : controller.fen,
      variant: currentVariant,
      ...(last ? { move: last.uci } : {}),
      ...(moves && moves.length > 0 && moves.length <= MAX_COACH_PLIES ? { moves } : {}),
    };
  };

  /**
   * The single place the coaching control's enabled state is decided.
   *
   * Split out for the same reason as its siblings: two places deciding it is how they came to
   * disagree last time. Returns early when the deployment does not coach, so the section stays
   * hidden rather than appearing disabled with no explanation.
   */
  const refreshCoachControls = (): void => {
    if (analysisDisposed || !coachAvailable) return;
    const blocked = liveHumanGameBlocksAssistance();
    if (coachBlockEl) coachBlockEl.hidden = blocked;
    if (blocked) {
      if (coachRunBtn) coachRunBtn.disabled = true;
      return;
    }
    const authed = isUserAuthenticated();
    if (coachRunBtn) {
      coachRunBtn.disabled = !authed || coachTarget() === null || coachController.isPending;
    }
    const ownsControlNote = currentCoachNoteKey === 'idle' || currentCoachNoteKey === 'signedOut';
    if (!ownsControlNote || lastCoachResult || currentCoachErrorKey) return;
    currentCoachNoteKey = authed ? 'idle' : 'signedOut';
    if (coachNoteEl) renderCoachNote(coachNoteEl, coachMessage(currentCoachNoteKey, i18n));
  };

  /**
   * What the server can be asked about, or the reason there is nothing to ask.
   *
   * One computation rather than a predicate plus a parallel set of tests for the note, because the
   * two would be free to disagree about why the control is off — and the reasons are not
   * interchangeable to a reader: a game past the ceiling has left the opening behind, while one
   * with an unrecoverable ledger is a limitation of what arrived.
   *
   * In every unavailable case sending the request would spend a refusal to learn something already
   * known here, so the control declines instead.
   */
  type OpeningAvailability =
    | { readonly kind: 'ready'; readonly target: OpeningTarget }
    | { readonly kind: 'off' }
    | { readonly kind: 'unsupported-variant' }
    | { readonly kind: 'no-moves' }
    | { readonly kind: 'no-sequence' }
    | { readonly kind: 'beyond-opening' };

  const openingAvailability = (): OpeningAvailability => {
    if (!openingAvailable) return { kind: 'off' };
    if (currentVariant === null) return { kind: 'no-sequence' };
    if (currentVariant !== 'standard') return { kind: 'unsupported-variant' };
    const moves = controller.moveSequence;
    if (moves === null) return { kind: 'no-sequence' };
    // An empty ledger is answerable — the server returns a clean no-match — but the answer is known
    // in advance and is not worth a request, so the control waits for a move to be played.
    if (moves.length === 0) return { kind: 'no-moves' };
    if (moves.length > MAX_OPENING_PLIES) return { kind: 'beyond-opening' };
    return { kind: 'ready', target: { variant: currentVariant, moves } };
  };

  /** @returns the target when there is one, for the controller's own `getTarget` port. */
  const openingTarget = (): OpeningTarget | null => {
    const availability = openingAvailability();
    return availability.kind === 'ready' ? availability.target : null;
  };

  /** Why the control is off, said in the terms a reader cares about. `null` means it is on. */
  const openingNoteFor = (availability: OpeningAvailability): OpeningMessageKey | null => {
    switch (availability.kind) {
      case 'ready': return null;
      case 'unsupported-variant': return 'unsupportedVariant';
      case 'no-moves': return 'noMoves';
      case 'beyond-opening': return 'beyondOpening';
      default: return 'noSequence';
    }
  };

  /** Bring the button state and the note back into agreement with the game and the session. */
  const refreshOpeningControls = (): void => {
    if (analysisDisposed || !openingAvailable) return;
    const blocked = liveHumanGameBlocksAssistance();
    if (openingBlockEl) openingBlockEl.hidden = blocked;
    if (blocked) {
      if (openingRunBtn) openingRunBtn.disabled = true;
      return;
    }
    const authed = isUserAuthenticated();
    const availability = openingAvailability();
    if (openingRunBtn) {
      openingRunBtn.disabled =
        !authed || availability.kind !== 'ready' || openingController.isPending;
    }
    const ownsControlNote = currentOpeningNoteKey === 'idle' || currentOpeningNoteKey === 'signedOut' || currentOpeningNoteKey === 'unsupportedVariant' || currentOpeningNoteKey === 'noMoves' || currentOpeningNoteKey === 'noSequence' || currentOpeningNoteKey === 'beyondOpening';
    if (!ownsControlNote || lastOpeningResult || currentOpeningErrorKey) return;
    currentOpeningNoteKey = !authed ? 'signedOut' : (openingNoteFor(availability) ?? 'idle');
    if (openingNoteEl) renderOpeningNote(openingNoteEl, openingMessage(currentOpeningNoteKey, i18n));
  };

  /**
   * Tell the controller what the game is now about.
   *
   * Called on every authoritative change, not only the ones that produce a target. When the target
   * disappears — the ledger outran the ceiling, stopped being contiguous, or the variant left
   * standard — a displayed result would otherwise keep describing a move order the game no longer
   * has, and `refreshOpeningControls` would not correct the note, because a result note is not one
   * this block owns. Raised in the Qodo and CodeRabbit reviews of PR #150.
   */
  /** Tell the controller the board moved, and re-decide whether the control should be offered. */
  const coachStateChanged = (): void => {
    coachController.positionChanged(coachTarget());
    refreshCoachControls();
  };

  const openingStateChanged = (): void => {
    const availability = openingAvailability();
    if (availability.kind === 'ready') openingController.sequenceChanged(availability.target);
    else openingController.targetLost();
  };

  // Move Explanation block (M15 inc 4), inside the same panel.
  const explainBlockEl = doc.getElementById('explain');
  const explainRunBtn = doc.getElementById('explain-run') as HTMLButtonElement | null;
  const explainNoteEl = doc.getElementById('explain-note');
  const explainErrorEl = doc.getElementById('explain-error');
  const explainResultEl = doc.getElementById('explain-result');
  const explainEvidenceEl = doc.getElementById('explain-evidence');
  const explainProseEl = doc.getElementById('explain-prose');
  const explainSourceEl = doc.getElementById('explain-source');

  let explainAvailable = false;
  /** The capability payload, held so the variant gate can re-run when the variant lands. */
  let explainCapabilities: unknown = null;

  /**
   * Clear the block, for the same reason the analysis panel is reset at mount: this DOM lives in
   * `index.html` and outlives any single mount, so last game's explanation is still sitting there
   * when the next one mounts. No request is involved, so nothing in the request lifecycle catches
   * it.
   */
  let lastExplainResult: MoveExplanationResponse | null = null;
  let currentExplainNoteKey: ExplainMessageKey | null = null;
  let currentExplainErrorKey: ExplainMessageKey | null = null;
  const resetExplainBlock = (): void => {
    lastExplainResult = null;
    currentExplainNoteKey = 'idle';
    currentExplainErrorKey = null;
    if (explainEvidenceEl && explainProseEl && explainSourceEl && explainResultEl) {
      clearExplanation({
        evidence: explainEvidenceEl,
        prose: explainProseEl,
        source: explainSourceEl,
        result: explainResultEl,
      });
    }
    if (explainErrorEl) renderExplainError(explainErrorEl, null);
    if (explainNoteEl) renderExplainNote(explainNoteEl, explainMessage('idle', i18n));
  };

  resetExplainBlock();

  /**
   * The move both controls ask about, or `null` — see `GameController.lastReplayedMove` for when
   * that happens.
   *
   * **One function, two consumers.** Explain and Assess need the identical thing: the position the
   * last move was played from, that move in full UCI, and the variant. A second copy would be a
   * second place for the promotion suffix to get dropped, and a second thing to remember to update
   * when the replay rules change.
   */
  const lastMoveTarget = (): { fen: string; variant: string; move: string } | null => {
    const last = controller?.lastReplayedMove;
    if (!last || !currentVariant) return null;
    return { fen: last.fen, variant: currentVariant, move: last.uci };
  };

  /**
   * The single place the explain control's enabled state is decided — same rule as
   * `refreshAnalysisControls`, and split out for the same reason: two places deciding it is how they
   * came to disagree last time.
   */
  const refreshExplainControls = (): void => {
    if (analysisDisposed || !explainAvailable) return;

    // The variant gate is evaluated here rather than once at capability time, because the two
    // arrivals race: the capability answer and the game snapshot can land in either order, and only
    // this function runs on both. Deciding it at capability time treated an unknown variant as
    // supported and never revisited it, so a Crazyhouse game on a Stockfish-only deployment got an
    // enabled control whose every request answers 422 — the exact failure ADR-0114 Decision 7 was
    // written about. Raised in the Qodo review of PR #135.
    const servable =
      !liveHumanGameBlocksAssistance()
      && (currentVariant === null || moveExplanationSupportsVariant(explainCapabilities, currentVariant));
    if (explainBlockEl) explainBlockEl.hidden = !servable;
    if (!servable) {
      if (explainRunBtn) explainRunBtn.disabled = true;
      return;
    }

    const authed = isUserAuthenticated();
    const target = lastMoveTarget();
    if (explainRunBtn) {
      explainRunBtn.disabled = !authed || target === null || explainController.isPending;
    }
    const ownsControlNote = currentExplainNoteKey === 'idle' || currentExplainNoteKey === 'signedOut' || currentExplainNoteKey === 'noMove';
    if (!ownsControlNote || lastExplainResult || currentExplainErrorKey) return;
    currentExplainNoteKey = !authed ? 'signedOut' : target === null ? 'noMove' : 'idle';
    if (explainNoteEl) renderExplainNote(explainNoteEl, explainMessage(currentExplainNoteKey, i18n));
  };

  // Mistake Prediction block (M15 inc 5), the third in the same panel.
  const assessBlockEl = doc.getElementById('assess');
  const assessRunBtn = doc.getElementById('assess-run') as HTMLButtonElement | null;
  const assessNoteEl = doc.getElementById('assess-note');
  const assessErrorEl = doc.getElementById('assess-error');
  const assessResultEl = doc.getElementById('assess-result');
  const assessRowsEl = doc.getElementById('assess-rows');

  let assessAvailable = false;
  /** The capability payload, held so the variant gate can re-run when the variant lands. */
  let assessCapabilities: unknown = null;

  let lastAssessResult: MistakePredictionResponse | null = null;
  let currentAssessNoteKey: AssessMessageKey | null = null;
  let currentAssessErrorKey: AssessMessageKey | null = null;
  /** Clear the block, for the same reason the other two are reset at mount: this DOM outlives it. */
  const resetAssessBlock = (): void => {
    lastAssessResult = null;
    currentAssessNoteKey = 'idle';
    currentAssessErrorKey = null;
    if (assessRowsEl && assessResultEl) {
      clearVerdict({ rows: assessRowsEl, result: assessResultEl });
    }
    if (assessErrorEl) renderAssessError(assessErrorEl, null);
    if (assessNoteEl) renderAssessNote(assessNoteEl, assessMessage('idle', i18n));
  };

  resetAssessBlock();

  /**
   * The single place the assess control's enabled state is decided — the same rule and the same
   * structure as `refreshExplainControls`, including the variant gate being evaluated here rather
   * than once at capability time, because the capability answer and the game snapshot race and only
   * this function runs on both (ADR-0114 Decision 7).
   */
  const refreshAssessControls = (): void => {
    if (analysisDisposed || !assessAvailable) return;

    const servable =
      !liveHumanGameBlocksAssistance()
      && (currentVariant === null || mistakePredictionSupportsVariant(assessCapabilities, currentVariant));
    if (assessBlockEl) assessBlockEl.hidden = !servable;
    if (!servable) {
      if (assessRunBtn) assessRunBtn.disabled = true;
      return;
    }

    const authed = isUserAuthenticated();
    const target = lastMoveTarget();
    if (assessRunBtn) {
      assessRunBtn.disabled = !authed || target === null || assessController.isPending;
    }
    const ownsControlNote = currentAssessNoteKey === 'idle' || currentAssessNoteKey === 'signedOut' || currentAssessNoteKey === 'noMove';
    if (!ownsControlNote || lastAssessResult || currentAssessErrorKey) return;
    currentAssessNoteKey = !authed ? 'signedOut' : target === null ? 'noMove' : 'idle';
    if (assessNoteEl) renderAssessNote(assessNoteEl, assessMessage(currentAssessNoteKey, i18n));
  };

  let controller: GameController;

  const renderPuzzlePresentation = (): void => {
    let resultNote: string | null = null;
    if (lastPuzzleResult && puzzleRowsEl && puzzleResultEl) {
      resultNote = renderPuzzleResult(puzzleRowsEl, puzzleResultEl, lastPuzzleResult, i18n);
    }
    if (puzzleNoteEl) renderPuzzleNote(puzzleNoteEl, currentPuzzleNoteKey ? puzzleMessage(currentPuzzleNoteKey, i18n) : currentPuzzleErrorKey ? null : resultNote);
    if (puzzleErrorEl) renderPuzzleError(puzzleErrorEl, currentPuzzleErrorKey ? puzzleMessage(currentPuzzleErrorKey, i18n) : null);
  };

  const puzzleController = new PuzzleController({
    client: deps.client,
    getPosition: () => {
      const fen = controller.fen;
      if (!fen || !currentVariant) return null;
      return { fen, variant: currentVariant };
    },
    callbacks: {
      onPhase: (phase) => {
        if (puzzleResultEl) setPuzzleBusy(puzzleResultEl, phase === 'loading');
        refreshPuzzleControls();
        if (phase === 'loading') {
          currentPuzzleNoteKey = 'running';
          currentPuzzleErrorKey = null;
          if (puzzleNoteEl) renderPuzzleNote(puzzleNoteEl, puzzleMessage('running', i18n));
          if (puzzleErrorEl) renderPuzzleError(puzzleErrorEl, null);
        }
      },
      onResult: (result) => {
        lastPuzzleResult = result;
        currentPuzzleNoteKey = null;
        currentPuzzleErrorKey = null;
        renderPuzzlePresentation();
      },
      onFailure: (failure) => {
        resetPuzzleBlock();
        if (failure === 'unsupported-variant') {
          puzzleUnsupported = true;
          if (puzzleBlockEl) puzzleBlockEl.hidden = true;
          return;
        }
        const noteFor: Partial<Record<typeof failure, PuzzleMessageKey>> = {
          'rate-limited': 'rateLimited',
          unavailable: 'unavailable',
          'active-game': 'activeGame',
          unauthenticated: 'signedOut',
        };
        const key = noteFor[failure];
        if (key) {
          currentPuzzleNoteKey = key;
          if (puzzleNoteEl) renderPuzzleNote(puzzleNoteEl, puzzleMessage(key, i18n));
        } else {
          currentPuzzleNoteKey = null;
          currentPuzzleErrorKey = failure === 'rejected' ? 'rejected' : 'failed';
          if (puzzleNoteEl) renderPuzzleNote(puzzleNoteEl, null);
          if (puzzleErrorEl) {
            renderPuzzleError(
              puzzleErrorEl,
              failure === 'rejected' ? puzzleMessage('rejected', i18n) : puzzleMessage('failed', i18n),
            );
          }
        }
      },
      onInvalidated: () => {
        resetPuzzleBlock();
        currentPuzzleNoteKey = 'positionChanged';
        if (puzzleNoteEl) renderPuzzleNote(puzzleNoteEl, puzzleMessage('positionChanged', i18n));
      },
    },
  });

  const renderOpeningPresentation = (): void => {
    let resultNote: string | null = null;
    if (lastOpeningResult && openingRowsEl && openingResultEl) {
      resultNote = renderOpeningResult(openingRowsEl, openingResultEl, lastOpeningResult, i18n);
    }
    if (openingNoteEl) renderOpeningNote(openingNoteEl, currentOpeningNoteKey ? openingMessage(currentOpeningNoteKey, i18n) : currentOpeningErrorKey ? null : resultNote);
    if (openingErrorEl) renderOpeningError(openingErrorEl, currentOpeningErrorKey ? openingMessage(currentOpeningErrorKey, i18n) : null);
  };

  const openingController = new OpeningController({
    client: deps.client,
    getTarget: openingTarget,
    callbacks: {
      onPhase: (phase) => {
        if (openingResultEl) setOpeningBusy(openingResultEl, phase === 'loading');
        refreshOpeningControls();
        if (phase === 'loading') {
          currentOpeningNoteKey = 'running';
          currentOpeningErrorKey = null;
          if (openingNoteEl) renderOpeningNote(openingNoteEl, openingMessage('running', i18n));
          if (openingErrorEl) renderOpeningError(openingErrorEl, null);
        }
      },
      onResult: (result) => {
        lastOpeningResult = result;
        currentOpeningNoteKey = null;
        currentOpeningErrorKey = null;
        renderOpeningPresentation();
      },
      onFailure: (failure) => {
        resetOpeningBlock();
        const noteFor: Partial<Record<typeof failure, OpeningMessageKey>> = {
          'rate-limited': 'rateLimited',
          unavailable: 'unavailable',
          'active-game': 'activeGame',
          unauthenticated: 'signedOut',
          'unsupported-variant': 'unsupportedVariant',
        };
        const key = noteFor[failure];
        if (key) {
          currentOpeningNoteKey = key;
          if (openingNoteEl) renderOpeningNote(openingNoteEl, openingMessage(key, i18n));
        } else {
          currentOpeningNoteKey = null;
          currentOpeningErrorKey = failure === 'rejected' ? 'rejected' : 'failed';
          if (openingNoteEl) renderOpeningNote(openingNoteEl, null);
          if (openingErrorEl) {
            renderOpeningError(
              openingErrorEl,
              failure === 'rejected' ? openingMessage('rejected', i18n) : openingMessage('failed', i18n),
            );
          }
        }
      },
      onInvalidated: () => {
        resetOpeningBlock();
        currentOpeningNoteKey = 'sequenceChanged';
        if (openingNoteEl) renderOpeningNote(openingNoteEl, openingMessage('sequenceChanged', i18n));
      },
    },
  });

  const renderCoachPresentation = (): void => {
    let resultNote: string | null = null;
    if (lastCoachResult && coachRowsEl && coachResultEl) {
      resultNote = renderCoachResult(coachRowsEl, coachResultEl, lastCoachResult, i18n);
    }
    if (coachNoteEl) renderCoachNote(coachNoteEl, currentCoachNoteKey ? coachMessage(currentCoachNoteKey, i18n) : currentCoachErrorKey ? null : resultNote);
    if (coachErrorEl) renderCoachError(coachErrorEl, currentCoachErrorKey ? coachMessage(currentCoachErrorKey, i18n) : null);
  };

  const coachController = new CoachController({
    client: deps.client,
    getTarget: coachTarget,
    callbacks: {
      onPhase: (phase) => {
        if (coachResultEl) setCoachBusy(coachResultEl, phase === 'loading');
        refreshCoachControls();
        if (phase === 'loading') {
          currentCoachNoteKey = 'running';
          currentCoachErrorKey = null;
          if (coachNoteEl) renderCoachNote(coachNoteEl, coachMessage('running', i18n));
          if (coachErrorEl) renderCoachError(coachErrorEl, null);
        }
      },
      onResult: (result) => {
        lastCoachResult = result;
        currentCoachNoteKey = null;
        currentCoachErrorKey = null;
        renderCoachPresentation();
      },
      onFailure: (failure) => {
        resetCoachBlock();
        const noteFor: Partial<Record<typeof failure, CoachMessageKey>> = {
          'rate-limited': 'rateLimited',
          unavailable: 'unavailable',
          'active-game': 'activeGame',
          unauthenticated: 'signedOut',
          'unsupported-variant': 'unsupportedVariant',
        };
        const key = noteFor[failure];
        if (key) {
          currentCoachNoteKey = key;
          if (coachNoteEl) renderCoachNote(coachNoteEl, coachMessage(key, i18n));
        } else {
          currentCoachNoteKey = null;
          currentCoachErrorKey = failure === 'rejected' ? 'rejected' : 'failed';
          if (coachNoteEl) renderCoachNote(coachNoteEl, null);
          if (coachErrorEl) {
            renderCoachError(
              coachErrorEl,
              failure === 'rejected' ? coachMessage('rejected', i18n) : coachMessage('failed', i18n),
            );
          }
        }
      },
      onInvalidated: () => {
        resetCoachBlock();
        currentCoachNoteKey = 'positionChanged';
        if (coachNoteEl) renderCoachNote(coachNoteEl, coachMessage('positionChanged', i18n));
      },
    },
  });

  const assessController = new AssessController({
    client: deps.client,
    getTarget: lastMoveTarget,
    callbacks: {
      onPhase: (phase) => {
        if (assessResultEl) setAssessBusy(assessResultEl, phase === 'loading');
        refreshAssessControls();
        if (phase === 'loading') {
          currentAssessNoteKey = 'running';
          currentAssessErrorKey = null;
          if (assessNoteEl) renderAssessNote(assessNoteEl, assessMessage('running', i18n));
          if (assessErrorEl) renderAssessError(assessErrorEl, null);
        }
      },
      onResult: (result) => {
        lastAssessResult = result;
        currentAssessNoteKey = null;
        currentAssessErrorKey = null;
        if (assessRowsEl) renderVerdict(assessRowsEl, result, i18n);
        if (assessResultEl) setVerdictVisible(assessResultEl, true);
        if (assessNoteEl) renderAssessNote(assessNoteEl, null);
        if (assessErrorEl) renderAssessError(assessErrorEl, null);
      },
      onFailure: (failure) => {
        resetAssessBlock();
        const noteFor: Partial<Record<typeof failure, AssessMessageKey>> = {
          'rate-limited': 'rateLimited',
          unavailable: 'unavailable',
          'active-game': 'activeGame',
          unauthenticated: 'signedOut',
        };
        const key = noteFor[failure];
        if (key !== undefined) {
          currentAssessNoteKey = key;
          if (assessNoteEl) renderAssessNote(assessNoteEl, assessMessage(key, i18n));
          return;
        }
        currentAssessNoteKey = null;
        currentAssessErrorKey = failure === 'rejected' ? 'rejected' : 'failed';
        if (assessNoteEl) renderAssessNote(assessNoteEl, null);
        if (assessErrorEl) {
          renderAssessError(
            assessErrorEl,
            failure === 'rejected' ? assessMessage('rejected', i18n) : assessMessage('failed', i18n),
          );
        }
      },
      onInvalidated: () => {
        resetAssessBlock();
      },
    },
  });

  const explainController = new ExplainController({
    client: deps.client,
    getTarget: lastMoveTarget,
    callbacks: {
      onPhase: (phase) => {
        if (explainResultEl) setExplainBusy(explainResultEl, phase === 'loading');
        refreshExplainControls();
        if (phase === 'loading') {
          currentExplainNoteKey = 'running';
          currentExplainErrorKey = null;
          if (explainNoteEl) renderExplainNote(explainNoteEl, explainMessage('running', i18n));
          if (explainErrorEl) renderExplainError(explainErrorEl, null);
        }
      },
      onResult: (result) => {
        lastExplainResult = result;
        currentExplainNoteKey = null;
        currentExplainErrorKey = null;
        if (explainEvidenceEl) renderEvidence(explainEvidenceEl, result, i18n);
        if (explainProseEl) renderProse(explainProseEl, result);
        if (explainSourceEl) renderSource(explainSourceEl, result, i18n);
        if (explainResultEl) setExplainResultVisible(explainResultEl, true);
        if (explainNoteEl) renderExplainNote(explainNoteEl, null);
        if (explainErrorEl) renderExplainError(explainErrorEl, null);
      },
      onFailure: (failure) => {
        resetExplainBlock();
        const noteFor: Partial<Record<typeof failure, ExplainMessageKey>> = {
          'rate-limited': 'rateLimited',
          unavailable: 'unavailable',
          'active-game': 'activeGame',
          unauthenticated: 'signedOut',
        };
        const key = noteFor[failure];
        if (key !== undefined) {
          currentExplainNoteKey = key;
          if (explainNoteEl) renderExplainNote(explainNoteEl, explainMessage(key, i18n));
          return;
        }
        currentExplainNoteKey = null;
        currentExplainErrorKey = failure === 'rejected' ? 'rejected' : 'failed';
        if (explainNoteEl) renderExplainNote(explainNoteEl, null);
        if (explainErrorEl) {
          renderExplainError(
            explainErrorEl,
            failure === 'rejected' ? explainMessage('rejected', i18n) : explainMessage('failed', i18n),
          );
        }
      },
      onInvalidated: () => {
        resetExplainBlock();
      },
    },
  });

  const analysisController = new AnalysisController({
    client: deps.client,
    getPosition: () => {
      const fen = controller.fen;
      if (!fen || !currentVariant) return null;
      return { fen, variant: currentVariant };
    },
    callbacks: {
      onPhase: (phase) => {
        if (analysisResultsEl) {
          setBusy(analysisResultsEl, phase === 'loading');
        }
        refreshAnalysisControls();
        if (phase === 'loading') {
          setAnalysisNote('loading');
          setAnalysisError(null);
        }
      },
      onResult: (result) => {
        lastAnalysisResult = result;
        renderAnalysisResult();
        setAnalysisNote(null);
        setAnalysisError(null);
      },
      onFailure: (failure) => {
        lastAnalysisResult = null;
        if (analysisResultsEl) clearLines(analysisResultsEl);
        if (analysisReachedEl) {
          analysisReachedEl.hidden = true;
          analysisReachedEl.textContent = '';
        }
        if (analysisLimitsEl) {
          analysisLimitsEl.hidden = true;
          analysisLimitsEl.textContent = '';
        }
        if (failure === 'rate-limited') {
          setAnalysisNote('rateLimited');
          setAnalysisError(null);
        } else if (failure === 'unavailable') {
          setAnalysisNote('unavailable');
          setAnalysisError(null);
        } else if (failure === 'unsupported-variant') {
          // Permanent for this game, so stop offering the control rather than let it fail the same
          // way on every click. DESIGN.md's rule for a composer that cannot succeed: hide the
          // control and name the actual obstacle.
          analysisUnsupported = true;
          if (analysisRunBtn) analysisRunBtn.disabled = true;
          setAnalysisNote('unsupportedVariant');
          setAnalysisError(null);
        } else if (failure === 'unauthenticated') {
          setAnalysisNote('unauthenticated');
          setAnalysisError(null);
        } else if (failure === 'active-game') {
          setAnalysisNote('activeGame');
          setAnalysisError(null);
        } else if (failure === 'rejected') {
          setAnalysisNote(null);
          setAnalysisError('rejected');
        } else {
          setAnalysisNote(null);
          setAnalysisError('failed');
        }
      },
      onInvalidated: () => {
        lastAnalysisResult = null;
        if (analysisResultsEl) clearLines(analysisResultsEl);
        if (analysisReachedEl) {
          analysisReachedEl.hidden = true;
          analysisReachedEl.textContent = '';
        }
        if (analysisLimitsEl) {
          analysisLimitsEl.hidden = true;
          analysisLimitsEl.textContent = '';
        }
        setAnalysisError(null);
        setAnalysisNote('positionChanged');
      },
    },
  });

  const gameSync = createGameSync({ gameId, ...(token !== undefined ? { token } : {}) });
  const oracle = createGameOracle(gameSync);

  const board = mountBoard(
    { boardEl, statusEl, flipEl },
    {
      oracle,
      onMove: (uci: string) => {
        controller.submitMove(uci);
      },
      i18n,
    },
  );

  const renderMetadata = (state: GameMetadataState): void => {
    let liveAnnouncement = '';

    if (metaConnectionEl) {
      const connText = state.connected
        ? i18n.t('game.connection.connected')
        : state.role !== null
          ? i18n.t('game.connection.reconnecting')
          : i18n.t('game.connection.connecting');
      if (metaConnectionEl.textContent !== connText) {
        metaConnectionEl.textContent = connText;
        liveAnnouncement += i18n.t('game.connection.announcement', { status: connText });
      }
    }

    if (metaRoleEl) {
      const roleText = state.role === 'white' ? i18n.t('game.role.playingWhite')
        : state.role === 'black' ? i18n.t('game.role.playingBlack')
        : state.role === 'spectator' ? i18n.t('game.role.spectating')
        : i18n.t('game.role.waiting');
      metaRoleEl.textContent = roleText;
    }

    const unknownPresence = !state.connected || !state.presence;

    if (metaWhiteEl && metaWhiteNameEl) {
      const isMe = state.myColor === 'w';
      metaWhiteNameEl.textContent = isMe ? i18n.t('game.player.whiteYou') : i18n.t('game.player.white');
      applyAutoDirection(metaWhiteNameEl);

      const dot = metaWhiteEl.querySelector<HTMLElement>('.presence-dot');
      const txt = metaWhiteEl.querySelector('.presence-text');
      if (dot && txt) {
        if (state.players && isEngineBotUserId(state.players.white)) {
          dot.hidden = true;
          txt.textContent = i18n.t('game.presence.computer');
        } else if (unknownPresence) {
          dot.hidden = false;
          dot.className = 'presence-dot offline';
          txt.textContent = i18n.t('game.presence.unknown');
        } else {
          dot.hidden = false;
          const online = state.presence!.white;
          dot.className = `presence-dot ${online ? 'online' : 'offline'}`;
          const newTxt = online ? i18n.t('game.presence.online') : i18n.t('game.presence.offline');
          if (txt.textContent !== newTxt) {
            txt.textContent = newTxt;
            liveAnnouncement += i18n.t('game.presence.whiteIs', { status: newTxt });
          }
        }
      }
    }

    if (metaBlackEl && metaBlackNameEl) {
      const isMe = state.myColor === 'b';
      metaBlackNameEl.textContent = isMe ? i18n.t('game.player.blackYou') : i18n.t('game.player.black');
      applyAutoDirection(metaBlackNameEl);

      const dot = metaBlackEl.querySelector<HTMLElement>('.presence-dot');
      const txt = metaBlackEl.querySelector('.presence-text');
      if (dot && txt) {
        if (state.players && isEngineBotUserId(state.players.black)) {
          dot.hidden = true;
          txt.textContent = i18n.t('game.presence.computer');
        } else if (unknownPresence) {
          dot.hidden = false;
          dot.className = 'presence-dot offline';
          txt.textContent = i18n.t('game.presence.unknown');
        } else {
          dot.hidden = false;
          const online = state.presence!.black;
          dot.className = `presence-dot ${online ? 'online' : 'offline'}`;
          const newTxt = online ? i18n.t('game.presence.online') : i18n.t('game.presence.offline');
          if (txt.textContent !== newTxt) {
            txt.textContent = newTxt;
            liveAnnouncement += i18n.t('game.presence.blackIs', { status: newTxt });
          }
        }
      }
    }

    if (metaSpectatorsEl) {
      metaSpectatorsEl.textContent = unknownPresence ? '—' : String(state.presence!.spectators);
    }

    if (metaVariantEl && state.variant) {
      const label = getVariantLabel(state.variant, i18n);
      metaVariantEl.textContent =
        typeof state.chess960StartId === 'number'
          ? `${label} · #${state.chess960StartId}`
          : label;
    }
    if (metaTimeEl && state.timeControl) {
      metaTimeEl.textContent = formatTimeControl(state.timeControl, i18n);
    }

    if (metaLiveStatusEl && liveAnnouncement) {
      metaLiveStatusEl.textContent = liveAnnouncement.trim();
    }
  };

  const renderActionState = (state: GameActionState): void => {
    isGamePlayer = state.isPlayer;
    isHumanGame = state.isHumanGame;
    gameOver = state.isOver;
    refreshGameReview();
    refreshAnalysisControls();
    refreshPuzzleControls();
    refreshOpeningControls();
    refreshCoachControls();
    refreshExplainControls();
    refreshAssessControls();
    if (actionsPanelEl) {
      if (state.isOver && !actionsPanelEl.hidden && doc.activeElement && actionsPanelEl.contains(doc.activeElement)) {
        statusEl?.focus();
      }
      actionsPanelEl.hidden = !state.isPlayer || state.isOver;
    }
    if (!state.isPlayer) return;

    const disabled = !state.connected || state.isOver || state.pendingAction !== null;

    if (btnOfferDraw) {
      if (state.drawOffer === 'sent') {
        btnOfferDraw.textContent = i18n.t('game.actions.drawOfferSent');
        btnOfferDraw.disabled = true;
      } else {
        btnOfferDraw.textContent = i18n.t('game.actions.offerDraw');
        btnOfferDraw.disabled = disabled || state.drawOffer !== 'none';
      }
    }
    if (btnClaimFlag) btnClaimFlag.disabled = disabled;

    if (btnResign) {
      btnResign.disabled = disabled;
      if (disabled && confirmResignEl && !confirmResignEl.hidden) {
        confirmResignEl.hidden = true;
        if (confirmResignYes) (confirmResignYes as HTMLButtonElement).disabled = true;
        if (confirmResignNo) (confirmResignNo as HTMLButtonElement).disabled = true;
        btnResign.hidden = false;
        statusEl?.focus();
      }
    }

    if (btnAbort) {
      btnAbort.hidden = !state.canAbort;
      btnAbort.disabled = disabled;
      if ((disabled || !state.canAbort) && confirmAbortEl && !confirmAbortEl.hidden) {
        confirmAbortEl.hidden = true;
        if (confirmAbortYes) (confirmAbortYes as HTMLButtonElement).disabled = true;
        if (confirmAbortNo) (confirmAbortNo as HTMLButtonElement).disabled = true;
        btnAbort.hidden = !state.canAbort;
        statusEl?.focus();
      }
    }

    if (drawOfferReceivedEl) {
      drawOfferReceivedEl.hidden = state.drawOffer !== 'received' || state.isOver;
    }
    if (btnAcceptDraw) {
      (btnAcceptDraw as HTMLButtonElement).disabled = disabled || state.drawOffer !== 'received';
    }
    if (btnDeclineDraw) {
      (btnDeclineDraw as HTMLButtonElement).disabled = disabled || state.drawOffer !== 'received';
    }

    if (actionErrorEl) {
      actionErrorEl.hidden = state.lastReject === null;
      actionErrorEl.textContent = state.lastReject ?? '';
    }
  };

  const unsubscribeLocale = i18n.onLocaleChange(() => {
    refreshGameReview();
    if (lastMetadataState) {
      renderMetadata(lastMetadataState);
    }
    if (lastActionState) {
      renderActionState(lastActionState);
    }
    if (lastReviewResult) {
      renderGameReview(lastReviewResult);
    }
    refreshAnalysisControls();
    refreshPuzzleControls();
    refreshOpeningControls();
    refreshCoachControls();
    refreshExplainControls();
    refreshAssessControls();

    renderAnalysisResult();
    setAnalysisNote(currentAnalysisNoteKey);
    setAnalysisError(currentAnalysisErrorKey);
    if (lastAssessResult && assessRowsEl) renderVerdict(assessRowsEl, lastAssessResult, i18n);
    if (assessNoteEl) renderAssessNote(assessNoteEl, currentAssessNoteKey ? assessMessage(currentAssessNoteKey, i18n) : null);
    if (assessErrorEl) renderAssessError(assessErrorEl, currentAssessErrorKey ? assessMessage(currentAssessErrorKey, i18n) : null);
    if (lastExplainResult) {
      if (explainEvidenceEl) renderEvidence(explainEvidenceEl, lastExplainResult, i18n);
      if (explainSourceEl) renderSource(explainSourceEl, lastExplainResult, i18n);
    }
    if (explainNoteEl) renderExplainNote(explainNoteEl, currentExplainNoteKey ? explainMessage(currentExplainNoteKey, i18n) : null);
    if (explainErrorEl) renderExplainError(explainErrorEl, currentExplainErrorKey ? explainMessage(currentExplainErrorKey, i18n) : null);
    renderOpeningPresentation();
    renderPuzzlePresentation();
    renderCoachPresentation();
  });

  controller = new GameController({
    gameSync,
    i18n,
    onDispose: () => unsubscribeLocale(),
    callbacks: {
      onPosition: (fen: string) => {
        authoritativeGameFen = fen;
        board.setPosition(fen);
        analysisController.positionChanged(fen);
        if (currentVariant) puzzleController.positionChanged({ fen, variant: currentVariant });
        openingStateChanged();
        coachStateChanged();
        explainController.targetChanged();
        assessController.targetChanged();
        refreshAnalysisControls();
        refreshPuzzleControls();
        refreshOpeningControls();
        refreshExplainControls();
        refreshAssessControls();
      },
      onExplainableChange: () => {
        explainController.targetChanged();
        assessController.targetChanged();
        refreshExplainControls();
        refreshAssessControls();
        openingStateChanged();
        refreshOpeningControls();
        coachStateChanged();
      },
      onTurn: (myTurn: boolean) => {
        authoritativeGameTurn = myTurn;
        board.setTurn(myTurn);
      },
      onClock: (whiteMs: number, blackMs: number) => {
        if (whiteClockEl) {
          whiteClockEl.textContent = formatClock(whiteMs);
          applyLtrIsolation(whiteClockEl);
        }
        if (blackClockEl) {
          blackClockEl.textContent = formatClock(blackMs);
          applyLtrIsolation(blackClockEl);
        }
        if (clockEl) {
          clockEl.textContent = `${formatClock(whiteMs)} – ${formatClock(blackMs)}`;
          applyLtrIsolation(clockEl);
        }
      },
      onStatus: (text: string) => {
        authoritativeGameStatus = text;
        if (statusEl) statusEl.textContent = text;
      },
      onLastMove: (from: string | null, to: string | null) => {
        authoritativeLastMove = from !== null && to !== null ? [from, to] : null;
        board.setLastMove(from, to);
      },
      onColor: (color) => {
        if (color === 'b') board.setOrientation('black');
      },
      onMetadata: (state) => {
        lastMetadataState = state;
        if (state.variant) {
          currentVariant = state.variant;
          refreshAnalysisControls();
          refreshPuzzleControls();
          refreshExplainControls();
          refreshAssessControls();
          refreshOpeningControls();
          refreshCoachControls();
          refreshGameReview();
        }
        renderMetadata(state);
      },
      onActionState: (state) => {
        lastActionState = state;
        renderActionState(state);
      },
    },
  });

  // Wire action buttons and inline confirmations with route-scoped lifecycle ownership
  const unbinds: (() => void)[] = [];
  const bindClick = (el: HTMLElement | null, listener: () => void): void => {
    if (!el) return;
    el.addEventListener('click', listener);
    unbinds.push(() => el.removeEventListener('click', listener));
  };

  /** Remove private review output and restore the latest server-owned game presentation. */
  const invalidateGameReviewPresentation = (): void => {
    clearGameReview();
    if (authoritativeGameFen === null) return;
    board.setPosition(authoritativeGameFen);
    board.setTurn(authoritativeGameTurn);
    board.setLastMove(authoritativeLastMove?.[0] ?? null, authoritativeLastMove?.[1] ?? null);
    if (statusEl) statusEl.textContent = authoritativeGameStatus;
  };

  const classificationLabel = (name: string): string => {
    switch (name) {
      case 'Brilliant': return i18n.t('game.review.classification.brilliant');
      case 'Great': return i18n.t('game.review.classification.great');
      case 'Best': return i18n.t('game.review.classification.best');
      case 'Best move': return i18n.t('game.review.classification.bestMove');
      case 'Excellent': return i18n.t('game.review.classification.excellent');
      case 'Good': return i18n.t('game.review.classification.good');
      case 'Good move': return i18n.t('game.review.classification.goodMove');
      case 'Book': return i18n.t('game.review.classification.book');
      case 'Inaccuracy': return i18n.t('game.review.classification.inaccuracy');
      case 'Mistake': return i18n.t('game.review.classification.mistake');
      case 'Miss': return i18n.t('game.review.classification.miss');
      case 'Blunder': return i18n.t('game.review.classification.blunder');
      case 'Missed win': return i18n.t('game.review.classification.missedWin');
      default: return i18n.t('game.review.classification.unrated');
    }
  };

  /** Render a controller-approved review and its navigable pre-move positions. */
  const renderGameReview = (review: Awaited<ReturnType<GambitClient['games']['review']>>): void => {
    lastReviewResult = review;
    currentReviewNoteKey = null;
    currentReviewErrorKey = null;
    if (gameReviewSummaryEl) {
      const summary = [
        [classificationLabel('Brilliant'), '!!', review.summary.brilliant, 'brilliant'],
        [classificationLabel('Great'), '!', review.summary.great, 'great'],
        [classificationLabel('Best'), '★', review.summary.best, 'best'],
        [classificationLabel('Excellent'), '✓', review.summary.excellent, 'excellent'],
        [classificationLabel('Good'), '✓', review.summary.good, 'good'],
        [classificationLabel('Book'), '📖', review.summary.book, 'book'],
        [classificationLabel('Inaccuracy'), '?!', review.summary.inaccuracy, 'inaccuracy'],
        [classificationLabel('Mistake'), '?', review.summary.mistake, 'mistake'],
        [classificationLabel('Miss'), '×', review.summary.miss, 'miss'],
        [classificationLabel('Blunder'), '??', review.summary.blunder, 'blunder'],
        [classificationLabel('Missed win'), '×', review.summary.missed_win, 'missed_win'],
      ] as const;
      gameReviewSummaryEl.replaceChildren(...summary.map(([label, symbol, count, tone]) => {
        const stat = doc.createElement('div');
        stat.className = `game-review-stat game-review-${tone}`;
        const name = doc.createElement('span');
        name.textContent = `${symbol} ${label}`;
        const value = doc.createElement('strong');
        value.textContent = String(count);
        stat.replaceChildren(name, value);
        return stat;
      }));
      gameReviewSummaryEl.hidden = false;
    }
    if (gameReviewMovesEl) {
      gameReviewMovesEl.replaceChildren(...review.moves.map((move) => {
        const row = doc.createElement('button');
        row.type = 'button';
        const annotation = gameReviewAnnotation(move.classification);
        row.className = `panel-row game-review-move game-review-${annotation.tone}`;
        const loss = move.assessment.centipawnLoss === null
          ? ''
          : ` · ${move.assessment.centipawnLoss} cp`;
        const moveLabel = doc.createElement('span');
        moveLabel.textContent = `${move.ply}. ${move.san}`;
        applyLtrIsolation(moveLabel);
        const verdict = doc.createElement('strong');
        verdict.textContent = `${annotation.symbol} ${classificationLabel(annotation.label)}${loss}`;
        row.replaceChildren(moveLabel, verdict);
        row.addEventListener('click', () => {
          board.setPosition(move.fenBefore);
          board.setTurn(false);
          if (move.move.length >= 4) board.setLastMove(move.move.slice(0, 2), move.move.slice(2, 4));
          if (statusEl) {
            statusEl.textContent = i18n.t('game.review.statusReviewing', {
              san: move.san,
              bestMove: move.assessment.bestMove ?? i18n.t('game.review.bestMoveNotAvailable'),
            });
          }
        });
        return row;
      }));
    }
    if (gameReviewNoteEl) {
      if (review.isPartial) {
        const analyzed = review.analyzedPlayerMoves ?? review.moves.length;
        const total = review.totalPlayerMoves ?? analyzed;
        gameReviewNoteEl.textContent = i18n.t('game.review.partialNote', {
          analyzed: String(analyzed),
          total: String(total),
        });
      } else {
        gameReviewNoteEl.textContent = i18n.t('game.review.selectMoveNote');
      }
    }
  };

  const gameReviewController = new GameReviewController({
    gameId,
    sessionId: gameReviewSessionId,
    requestReview: (requestedGameId, signal) => deps.client.games.review(requestedGameId, signal),
    callbacks: {
      onPhase: (phase) => {
        gameReviewPending = phase === 'loading';
        if (gameReviewMovesEl) gameReviewMovesEl.setAttribute('aria-busy', String(gameReviewPending));
        currentReviewNoteKey = phase === 'loading' ? 'game.review.reviewingMoves' : null;
        refreshGameReview();
      },
      onResult: renderGameReview,
      onFailure: () => {
        currentReviewErrorKey = 'game.review.unavailableError';
        if (gameReviewErrorEl) {
          gameReviewErrorEl.hidden = false;
          gameReviewErrorEl.textContent = i18n.t(currentReviewErrorKey);
        }
      },
      onInvalidated: invalidateGameReviewPresentation,
    },
  });

  bindClick(gameReviewRunBtn, () => {
    if (!gameOver || gameReviewPending || !gameReviewSupportsVariant(gameReviewCapabilities, currentVariant)) return;
    invalidateGameReviewPresentation();
    void gameReviewController.review();
  });

  // Route-scoped, like every other control here. A bare `addEventListener` on this element stacked a
  // new listener — each holding a disposed controller — on every SPA navigation to a game, because
  // the panel's DOM lives in index.html and outlives the mount. Raised in the Qodo review of PR #135.
  bindClick(explainRunBtn, () => {
    void explainController.explain();
  });

  // Route-scoped for the same reason. A bare `addEventListener` here would stack a new listener —
  // each holding a disposed controller — on every SPA navigation to a game, because this panel's
  // DOM lives in index.html and outlives the mount.
  bindClick(assessRunBtn, () => {
    void assessController.assess();
  });

  bindClick(puzzleRunBtn, () => {
    void puzzleController.find();
  });

  bindClick(openingRunBtn, () => {
    void openingController.identify();
  });

  bindClick(coachRunBtn, () => {
    void coachController.coach();
  });

  bindClick(btnOfferDraw, () => controller.offerDraw());
  bindClick(btnClaimFlag, () => controller.claimFlag());
  bindClick(btnAcceptDraw, () => controller.acceptDraw());
  bindClick(btnDeclineDraw, () => controller.declineDraw());
  bindClick(analysisRunBtn, () => {
    // Read the selector, but trust only the values this UI offers. The `<select>` cannot produce
    // anything else, so this is not about the user interface — it is about the request never
    // carrying a `multiPv` outside the published contract even if the option list is edited in the
    // page. The server clamps and rejects independently; this keeps the client honest at its own
    // boundary rather than relying on the far side to catch it.
    const requested = Number.parseInt(analysisLinesSelect?.value ?? '', 10);
    const lines = ANALYSIS_LINE_CHOICES.includes(requested) ? requested : DEFAULT_ANALYSIS_LINES;
    void analysisController.analyse(lines);
  });

  if (btnResign && confirmResignEl && confirmResignYes && confirmResignNo) {
    bindClick(btnResign, () => {
      btnResign.hidden = true;
      confirmResignEl.hidden = false;
      (confirmResignYes as HTMLButtonElement).disabled = false;
      (confirmResignNo as HTMLButtonElement).disabled = false;
      confirmResignYes.focus();
    });
    bindClick(confirmResignNo, () => {
      confirmResignEl.hidden = true;
      btnResign.hidden = false;
      btnResign.focus();
    });
    bindClick(confirmResignYes, () => {
      if (controller.resign()) {
        // Immediately disable to prevent double clicks before GameSync patches state
        (confirmResignYes as HTMLButtonElement).disabled = true;
        (confirmResignNo as HTMLButtonElement).disabled = true;
        statusEl?.focus();
      }
    });
  }

  if (btnAbort && confirmAbortEl && confirmAbortYes && confirmAbortNo) {
    bindClick(btnAbort, () => {
      btnAbort.hidden = true;
      confirmAbortEl.hidden = false;
      (confirmAbortYes as HTMLButtonElement).disabled = false;
      (confirmAbortNo as HTMLButtonElement).disabled = false;
      confirmAbortYes.focus();
    });
    bindClick(confirmAbortNo, () => {
      confirmAbortEl.hidden = true;
      btnAbort.hidden = false;
      btnAbort.focus();
    });
    bindClick(confirmAbortYes, () => {
      if (controller.abort()) {
        // Immediately disable to prevent double clicks before GameSync patches state
        (confirmAbortYes as HTMLButtonElement).disabled = true;
        (confirmAbortNo as HTMLButtonElement).disabled = true;
        statusEl?.focus();
      }
    });
  }

  controller.start();

  // Capability and auth gating for the analysis panel.
  //
  // `loadCapabilities` is the memoised shared read, not a fresh `client.capabilities()`. This mount
  // runs on every SPA navigation to a game, so an unmemoised call here would ask the same question
  // on every in-app click — the refetch `capabilities-nav.ts` already documents avoiding.
  void loadCapabilities(deps.client)
    .then((flags) => {
      if (analysisDisposed) return;
      // Read before the engine gate below, and deliberately not behind it. Opening identification
      // borrows no engine, so a deployment with none still serves it — and every other block here
      // is inside that early return (ADR-0127).
      openingAvailable = openingExplorerEnabled(flags);
      coachAvailable = coachEnabled(flags);
      gameReviewCapabilities = flags;
      refreshGameReview();
      refreshCoachControls();
      refreshOpeningControls();
      if (!analysisEnabled(flags)) return;
      analysisCapabilities = flags;
      analysisAvailable = true;
      if (analysisSectionEl) {
        analysisSectionEl.hidden = false;
      }
      refreshAnalysisControls();
      // Revealed on its own capability, not on the analysis one: a deployment can serve analysis
      // without an AI provider, and the server only reports this true when both halves exist.
      explainCapabilities = flags;
      explainAvailable = moveExplanationEnabled(flags);
      refreshExplainControls();
      // Its own capability again, and a strictly broader one: assessment needs no AI provider, so a
      // deployment with an engine and no provider offers this control while the explain block above
      // it stays hidden.
      assessCapabilities = flags;
      assessAvailable = mistakePredictionEnabled(flags);
      refreshAssessControls();
      puzzleCapabilities = flags;
      puzzleAvailable = puzzleGenerationEnabled(flags);
      refreshPuzzleControls();
    })
    .catch(() => {
      // Fail quiet: leave section hidden
    });

  // React to real browser connectivity changes: on `offline`, drop into the
  // reconnect flow immediately (a browser going offline should show
  // "Reconnecting…" now, not after a full heartbeat interval); on `online`,
  // retry at once instead of waiting out the backoff.
  let gameRouteActive = true;
  let disposed = false;
  const connectivityTarget = typeof window !== 'undefined' ? window : null;
  const onOffline = (): void => gameSync.networkOffline();
  const onOnline = (): void => gameSync.networkOnline();
  if (connectivityTarget) {
    connectivityTarget.addEventListener('offline', onOffline);
    connectivityTarget.addEventListener('online', onOnline);
  }
  const connectivity = {
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      gameRouteActive = false;
      connectivityTarget?.removeEventListener('offline', onOffline);
      connectivityTarget?.removeEventListener('online', onOnline);
      for (const unbind of unbinds) {
        unbind();
      }
      unbinds.length = 0;
    },
  };

  const analysis = {
    dispose: (): void => {
      if (analysisDisposed) return;
      analysisDisposed = true;
      analysisController.dispose();
      explainController.dispose();
      assessController.dispose();
      puzzleController.dispose();
      openingController.dispose();
      coachController.dispose();
      gameReviewController.dispose();
    },
  };

  if (token !== undefined) {
    gameSync.start();
  } else {
    // M12 inc 2: the access token arrives asynchronously via the httpOnly
    // refresh cookie (restore → refresh). Open the authenticated socket once
    // it resolves; fall back to a spectator connection if restore fails.
    void restorePromise
      .then(() => {
        const t = getAccessToken();
        if (t !== undefined) gameSync.setToken(t);
        if (!analysisDisposed) refreshAnalysisControls();
        if (!analysisDisposed) refreshPuzzleControls();
        if (!analysisDisposed) refreshOpeningControls();
        if (!analysisDisposed) refreshCoachControls();
      })
      .catch(() => {
        if (!analysisDisposed) refreshAnalysisControls();
        if (!analysisDisposed) refreshPuzzleControls();
        if (!analysisDisposed) refreshOpeningControls();
        if (!analysisDisposed) refreshCoachControls();
      })
      .finally(() => {
        if (gameRouteActive) gameSync.start();
      });
  }

  return {
    board,
    controller,
    connectivity,
    analysis,
    onSessionChange: (session) => {
      if (analysisDisposed) return;
      gameReviewSessionId = session?.userId ?? null;
      gameReviewController.sessionChanged(gameReviewSessionId);
      refreshAnalysisControls();
      // Every control depends on live authentication; refreshing only one left Explain disabled under
      // a stale sign-in note after signing in, and enabled after signing out, until some unrelated
      // event happened to refresh it. Raised in the Qodo review of PR #135.
      refreshExplainControls();
      refreshAssessControls();
      refreshPuzzleControls();
      refreshOpeningControls();
      // Signing out abandons the coaching on screen, not just the button.
      //
      // Refreshing the controls alone disabled the control and showed the signed-out note while the
      // previous session's advice stayed rendered beside it — a page saying two contradictory things
      // at once, and one account's answer left in front of whoever is there now. `targetLost` aborts
      // anything in flight and clears the section, which is the same rule ADR-0074 applied to the
      // social region. Raised in the Qodo review of PR #152.
      if (!isUserAuthenticated()) coachController.targetLost();
      refreshCoachControls();
    },
    dispose: () => {
      unsubscribeLocale();
      controller.dispose();
    },
  };
}
