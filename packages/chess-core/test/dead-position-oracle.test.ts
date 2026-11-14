import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position, typeOf, type Piece, type Color } from '../src';
import { isFrozenDeadPosition } from '../src/dead-position';

interface OracleResult {
  closed: boolean;
  statesVisited: number;
  transitions: number;
  checkmateFound: boolean;
  pawnsChanged: boolean;
  verdict: 'PROVEN_DEAD' | 'MATE_POSSIBLE' | 'PAWNS_CHANGED' | 'INCONCLUSIVE';
}

/**
 * Extracts a normalized board representation of pawns only.
 */
function extractPawnFingerprint(board: readonly (Piece | null)[]): string {
  let fp = '';
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const p = board[sq];
    fp += (p !== null && typeOf(p) === 'p') ? p : '.';
  }
  return fp;
}

/**
 * Complete canonical legal state key: includes king squares, turn, castling rights, and epSquare.
 * Move clocks, fifty-move counter, and repetition history are intentionally excluded.
 */
function canonicalStateKey(pos: Position): string {
  const snap = pos.snapshot();
  let wk = -1;
  let bk = -1;
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    if (snap.board[sq] === 'K') wk = sq;
    else if (snap.board[sq] === 'k') bk = sq;
  }
  const castlingStr = `${snap.castling.w.k},${snap.castling.w.q},${snap.castling.b.k},${snap.castling.b.q}`;
  return `${wk}:${bk}:${snap.turn}:${castlingStr}:${snap.epSquare}`;
}

/**
 * Independent fixed-pawn king-state graph oracle.
 *
 * Traverses the complete reachable legal game tree from pos:
 * - Strictly validates root domain: standard/chess960 only, no castling rights, no EP, pawns and kings only.
 * - Uses raw Position.legalMoves() and Position.play() exclusively.
 * - Does NOT call isFrozenDeadPosition() or use Position.status() pruning.
 * - Ignores 50-move rule and repetition cutoffs to exhaustively test all legal continuations.
 * - Confirms that every legal edge strictly preserves the initial pawn structure.
 * - Reports PROVEN_DEAD only if the state graph is completely closed with zero checkmates
 *   and zero pawn modifications.
 * - Any budget cutoff returns INCONCLUSIVE.
 */
function exploreKingStateGraph(initialPos: Position, maxStates = 10_000): OracleResult {
  const snap = initialPos.snapshot();
  // Enforce root domain preconditions
  if (snap.variant !== 'standard' && snap.variant !== 'chess960') {
    throw new Error(`exploreKingStateGraph domain error: unsupported variant ${snap.variant}`);
  }
  if (
    snap.castling.w.k !== -1 ||
    snap.castling.w.q !== -1 ||
    snap.castling.b.k !== -1 ||
    snap.castling.b.q !== -1
  ) {
    throw new Error('exploreKingStateGraph domain error: castling rights must be empty');
  }
  if (snap.epSquare !== -1) {
    throw new Error('exploreKingStateGraph domain error: en passant square must be -1');
  }
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const p = snap.board[sq];
    if (p !== null && typeOf(p) !== 'k' && typeOf(p) !== 'p') {
      throw new Error(`exploreKingStateGraph domain error: non-K/P piece ${p} found`);
    }
  }

  const initialPawns = extractPawnFingerprint(snap.board);

  const visited = new Set<string>();
  const queue: Position[] = [initialPos];
  visited.add(canonicalStateKey(initialPos));

  let transitions = 0;
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    const legalMoves = current.legalMoves();

    if (legalMoves.length === 0) {
      if (current.isCheck()) {
        return {
          closed: false,
          statesVisited: visited.size,
          transitions,
          checkmateFound: true,
          pawnsChanged: false,
          verdict: 'MATE_POSSIBLE',
        };
      }
      // Stalemate is a terminal draw leaf; no outgoing transitions.
      continue;
    }

    for (const move of legalMoves) {
      transitions++;

      // Check if move itself involves pawns
      if (typeOf(move.piece) === 'p' || (move.captured !== undefined && typeOf(move.captured) === 'p')) {
        return {
          closed: false,
          statesVisited: visited.size,
          transitions,
          checkmateFound: false,
          pawnsChanged: true,
          verdict: 'PAWNS_CHANGED',
        };
      }

      const nextPos = current.play(move);

      // Verify that pawn layout remains byte-for-byte identical
      const nextPawns = extractPawnFingerprint(nextPos.snapshot().board);
      if (nextPawns !== initialPawns) {
        return {
          closed: false,
          statesVisited: visited.size,
          transitions,
          checkmateFound: false,
          pawnsChanged: true,
          verdict: 'PAWNS_CHANGED',
        };
      }

      // Check for checkmate on the next state
      if (nextPos.isCheck() && nextPos.legalMoves().length === 0) {
        return {
          closed: false,
          statesVisited: visited.size,
          transitions,
          checkmateFound: true,
          pawnsChanged: false,
          verdict: 'MATE_POSSIBLE',
        };
      }

      const key = canonicalStateKey(nextPos);
      if (!visited.has(key)) {
        if (visited.size >= maxStates) {
          return {
            closed: false,
            statesVisited: visited.size,
            transitions,
            checkmateFound: false,
            pawnsChanged: false,
            verdict: 'INCONCLUSIVE',
          };
        }
        visited.add(key);
        queue.push(nextPos);
      }
    }
  }

  return {
    closed: true,
    statesVisited: visited.size,
    transitions,
    checkmateFound: false,
    pawnsChanged: false,
    verdict: 'PROVEN_DEAD',
  };
}

function reflectAndColorSwapFen(fen: string): string {
  const parts = fen.trim().split(/\s+/);
  const ranks = parts[0]!.split('/');
  const reversedRanks = ranks.slice().reverse();
  const swappedRanks = reversedRanks.map((r) =>
    r
      .split('')
      .map((c) => {
        if (c >= 'A' && c <= 'Z') return c.toLowerCase();
        if (c >= 'a' && c <= 'z') return c.toUpperCase();
        return c;
      })
      .join(''),
  );
  const newBoard = swappedRanks.join('/');
  const newTurn = parts[1] === 'w' ? 'b' : 'w';
  return `${newBoard} ${newTurn} - - ${parts[4] ?? '0'} ${parts[5] ?? '1'}`;
}

test('oracle positive control: issue FEN completes full closure with zero checkmates and zero pawn changes', () => {
  const fen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
  const pos = Position.fromFen(fen);

  const result = exploreKingStateGraph(pos);
  // Independent oracle metrics: exactly 577 reachable states and 2336 transitions
  assert.equal(result.verdict, 'PROVEN_DEAD');
  assert.equal(result.closed, true);
  assert.equal(result.checkmateFound, false);
  assert.equal(result.pawnsChanged, false);
  assert.equal(result.statesVisited, 577);
  assert.equal(result.transitions, 2336);

  // Compare independent oracle verdict with production certificate OUTSIDE the oracle algorithm
  assert.equal(isFrozenDeadPosition(pos.snapshot()), true, 'Production certificate must agree with oracle proof');
});

test('oracle positive control: issue FEN reflection completes full closure with identical symmetric proof', () => {
  const originalFen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
  const reflectedFen = reflectAndColorSwapFen(originalFen);
  const pos = Position.fromFen(reflectedFen);

  const result = exploreKingStateGraph(pos);
  assert.equal(result.verdict, 'PROVEN_DEAD');
  assert.equal(result.closed, true);
  assert.equal(result.checkmateFound, false);
  assert.equal(result.pawnsChanged, false);
  assert.equal(result.statesVisited, 577);
  assert.equal(result.transitions, 2336);

  // Compare independent oracle verdict with production certificate OUTSIDE the oracle algorithm
  assert.equal(isFrozenDeadPosition(pos.snapshot()), true, 'Production certificate must agree with oracle proof');
});

test('oracle negative control: Pi counterexample detects pawn capture', () => {
  const fen = '7k/8/8/pK6/P7/8/8/8 w - - 0 1';
  const pos = Position.fromFen(fen);

  const result = exploreKingStateGraph(pos);
  assert.equal(result.verdict, 'PAWNS_CHANGED');
  assert.equal(result.closed, false);
  assert.equal(result.pawnsChanged, true);

  // Production certificate must also reject
  assert.equal(isFrozenDeadPosition(pos.snapshot()), false);
});

test('oracle negative control: removing White pawn on a5 opens Black a6 pawn push (c7d7, f4e3, a6a5)', () => {
  // Original: 8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1
  // Mutated: a5 removed (rank 4 becomes 2P1P1P1 instead of P1P1P1P1)
  const validMutatedFen = '8/1pk2p1p/pPp1pPpP/2P1P1P1/5K2/8/8/8 b - - 0 1';
  const pos = Position.fromFen(validMutatedFen);

  // Verify the actual legal sequence opening the a-file pawn push:
  // 1. Black king escapes check: c7d7
  // 2. White king moves: f4e3
  // 3. Black pawn pushes: a6a5 (unblocked because a5 is now empty!)
  const p1 = pos.play('c7d7');
  const p2 = p1.play('f4e3');
  const p3 = p2.play('a6a5');
  assert.equal(p3.fen(), '8/1p1k1p1p/1Pp1pPpP/p1P1P1P1/8/4K3/8/8 w - - 0 3');

  const result = exploreKingStateGraph(pos);
  assert.equal(result.verdict, 'PAWNS_CHANGED');
  assert.equal(result.pawnsChanged, true);
  assert.equal(result.closed, false);

  // Production certificate must also reject
  assert.equal(isFrozenDeadPosition(pos.snapshot()), false);
});

test('oracle inconclusive control: artificially bounded state cap halts and reports INCONCLUSIVE', () => {
  const fen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
  const pos = Position.fromFen(fen);

  // Set an impossible cap of 2 states
  const result = exploreKingStateGraph(pos, 2);
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.equal(result.closed, false);
});
