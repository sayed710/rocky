import type { Variant } from '@chess-platform/core';
import type { TimeControl } from '@chess-platform/game';
import type { GameResult } from './standings';

export interface ArenaConfig {
  readonly id: string;
  readonly name: string;
  readonly format: 'arena';
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly durationMs: number;
}

export interface ArenaPairing {
  readonly pairingId: string;
  readonly white: string;
  readonly black: string;
}

export interface ArenaStanding {
  readonly playerId: string;
  readonly points: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly gamesPlayed: number;
  readonly onFire: boolean;
}

export type ArenaState = 'registration' | 'running' | 'finished';

export interface ArenaSnapshot {
  readonly config: ArenaConfig;
  readonly state: ArenaState;
  readonly startedAtMs?: number;
  readonly participants: readonly string[];
  readonly withdrawn: readonly string[];
  readonly playerStates: Record<string, {
    points: number;
    wins: number;
    draws: number;
    losses: number;
    consecutiveWins: number;
    onFire: boolean;
    gamesPlayed: number;
  }>;
  readonly activeGames: Record<string, { white: string; black: string; launchNamespace?: 'committed-v1' }>;
  readonly pairingSequence: number;
  readonly lastOpponents: Record<string, string>;
  readonly playedAsWhite: Record<string, number>;
  readonly playedAsBlack: Record<string, number>;
  readonly gameLinks?: readonly [string, string][];
}

export class ArenaTournament {
  private state: ArenaState = 'registration';
  private startedAtMs?: number;
  private readonly participants = new Set<string>();
  private readonly withdrawn = new Set<string>();

  private readonly playerStates = new Map<string, {
    points: number;
    wins: number;
    draws: number;
    losses: number;
    consecutiveWins: number;
    onFire: boolean;
    gamesPlayed: number;
  }>();

  private readonly activeGames = new Map<string, { white: string; black: string; launchNamespace?: 'committed-v1' }>();
  private pairingSequence = 0;
  
  // Rematch avoidance
  private readonly lastOpponents = new Map<string, string>();

  // Color balancing
  private readonly playedAsWhite = new Map<string, number>();
  private readonly playedAsBlack = new Map<string, number>();

  private readonly gameLinks = new Map<string, string>(); // pairingId -> gameId

  constructor(public readonly config: ArenaConfig) {}

  getState(): ArenaState {
    return this.state;
  }

  isExpired(nowMs: number): boolean {
    if (this.state === 'registration' || this.startedAtMs === undefined) return false;
    return nowMs >= this.startedAtMs + this.config.durationMs;
  }

  register(playerId: string): void {
    if (this.state === 'finished') return; // Cannot register after finished
    if (this.participants.has(playerId)) return;
    this.participants.add(playerId);
    this.playerStates.set(playerId, {
      points: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      consecutiveWins: 0,
      onFire: false,
      gamesPlayed: 0
    });
    this.playedAsWhite.set(playerId, 0);
    this.playedAsBlack.set(playerId, 0);
  }

  withdraw(playerId: string): void {
    if (!this.participants.has(playerId)) return;
    this.withdrawn.add(playerId);
  }

  start(nowMs: number): void {
    if (this.state !== 'registration') return;
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(this.config.durationMs)
      || this.config.durationMs <= 0 || !Number.isSafeInteger(nowMs + this.config.durationMs)) {
      throw new Error('Invalid Arena start/deadline milliseconds');
    }
    this.state = 'running';
    this.startedAtMs = nowMs;
  }
  
  settle(nowMs: number): void {
    if (this.state !== 'running') return;
    if (this.isExpired(nowMs) && this.activeGames.size === 0) {
      this.state = 'finished';
    }
  }

  pairAvailable(nowMs: number): ArenaPairing[] {
    if (this.state !== 'running' || this.isExpired(nowMs)) {
      // Finish an expired arena that has no games left. settle() is a no-op
      // unless the arena is running, expired, and has no active games — so an
      // idle arena polled after its deadline transitions to 'finished' here,
      // rather than being stuck 'running' until a (never-arriving) result.
      this.settle(nowMs);
      return [];
    }

    // A player is "available" iff registered, not withdrawn, and not currently in an active game.
    const activeInGames = new Set<string>();
    for (const game of this.activeGames.values()) {
      activeInGames.add(game.white);
      activeInGames.add(game.black);
    }

    const availablePlayers = Array.from(this.participants).filter(
      p => !this.withdrawn.has(p) && !activeInGames.has(p)
    );

    if (availablePlayers.length < 2) return [];

    // Pair competitively: sort by score desc, then stable order (playerId)
    availablePlayers.sort((a, b) => {
      const stateA = this.playerStates.get(a)!;
      const stateB = this.playerStates.get(b)!;
      if (stateA.points !== stateB.points) {
        return stateB.points - stateA.points;
      }
      return a.localeCompare(b);
    });

    const newPairings: ArenaPairing[] = [];
    const pool = [...availablePlayers];

    while (pool.length >= 2) {
      const p1 = pool.shift()!;
      let bestP2Index = 0;
      
      // Rematch avoidance: prefer not to pair against immediately previous opponent
      const p1LastOpponent = this.lastOpponents.get(p1);
      
      if (p1LastOpponent === pool[0] && pool.length > 1) {
        // Try to swap with the next player to avoid rematch
        bestP2Index = 1;
      }

      const p2 = pool.splice(bestP2Index, 1)[0];

      // Assign colors to balance white/black counts
      let whitePlayer: string;
      let blackPlayer: string;

      const p1WhiteBal = this.playedAsWhite.get(p1)! - this.playedAsBlack.get(p1)!;
      const p2WhiteBal = this.playedAsWhite.get(p2)! - this.playedAsBlack.get(p2)!;

      if (p1WhiteBal < p2WhiteBal) {
        whitePlayer = p1;
        blackPlayer = p2;
      } else if (p2WhiteBal < p1WhiteBal) {
        whitePlayer = p2;
        blackPlayer = p1;
      } else {
        // Deterministic tie-break
        if (p1.localeCompare(p2) < 0) {
          whitePlayer = p1;
          blackPlayer = p2;
        } else {
          whitePlayer = p2;
          blackPlayer = p1;
        }
      }

      this.playedAsWhite.set(whitePlayer, this.playedAsWhite.get(whitePlayer)! + 1);
      this.playedAsBlack.set(blackPlayer, this.playedAsBlack.get(blackPlayer)! + 1);

      const pairingId = `a:${++this.pairingSequence}`;
      
      this.activeGames.set(pairingId, { white: whitePlayer, black: blackPlayer, launchNamespace: 'committed-v1' });
      
      newPairings.push({
        pairingId,
        white: whitePlayer,
        black: blackPlayer
      });
    }

    return newPairings;
  }

  recordResult(pairingId: string, result: GameResult, nowMs: number): void {
    const game = this.activeGames.get(pairingId);
    if (!game) {
      throw new Error(`Unknown or already-resolved pairingId: ${pairingId}`);
    }

    this.activeGames.delete(pairingId);
    // Drop the resolved game's link so gameLinks tracks only in-flight games:
    // keeps the snapshot bounded and the live-board reconstruction from having
    // to walk (and discard) every finished game over a long arena.
    this.gameLinks.delete(pairingId);

    this.lastOpponents.set(game.white, game.black);
    this.lastOpponents.set(game.black, game.white);

    if (result === 'double_forfeit') {
      this.applyResult(game.white, 'loss');
      this.applyResult(game.black, 'loss');
    } else {
      this.applyResult(game.white, result === 'white_win' ? 'win' : result === 'black_win' ? 'loss' : 'draw');
      this.applyResult(game.black, result === 'black_win' ? 'win' : result === 'white_win' ? 'loss' : 'draw');
    }

    this.settle(nowMs);
  }

  linkGame(pairingId: string, gameId: string): void {
    if (!this.activeGames.has(pairingId)) {
      throw new Error(`Cannot link game for unknown or resolved pairingId: ${pairingId}`);
    }
    const previous = this.gameLinks.get(pairingId);
    if (previous !== undefined && previous !== gameId) throw new Error('Arena pairing already linked to a live game');
    for (const [other, linked] of this.gameLinks) {
      if (other !== pairingId && linked === gameId) throw new Error('Arena game belongs to another pairing');
    }
    this.gameLinks.set(pairingId, gameId);
  }

  gameIdFor(pairingId: string): string | undefined {
    return this.gameLinks.get(pairingId);
  }

  pairingForGame(gameId: string): string | undefined {
    for (const [pId, gId] of this.gameLinks.entries()) {
      if (gId === gameId) return pId;
    }
    return undefined;
  }

  recordResultByGame(gameId: string, result: GameResult, nowMs: number): void {
    const pairingId = this.pairingForGame(gameId);
    if (!pairingId) {
      throw new Error(`Unknown gameId: ${gameId}`);
    }
    this.recordResult(pairingId, result, nowMs);
  }

  abandonGame(gameId: string): void {
    const pairingId = this.pairingForGame(gameId);
    if (!pairingId) {
      throw new Error(`Unknown gameId: ${gameId}`);
    }
    this.abandonPairing(pairingId);
  }

  /** Resolve a durably authorized pairing whose game ended before link recovery. */
  abandonPairing(pairingId: string): void {
    if (!this.activeGames.has(pairingId)) throw new Error('Unknown or resolved Arena pairing');
    // Remove the pairing completely, putting players back into the pool.
    this.activeGames.delete(pairingId);
    this.gameLinks.delete(pairingId);
  }

  private applyResult(playerId: string, result: 'win' | 'loss' | 'draw') {
    const state = this.playerStates.get(playerId)!;
    state.gamesPlayed++;
    if (result === 'win') {
      state.wins++;
      state.points += state.onFire ? 4 : 2;
      state.consecutiveWins++;
      if (state.consecutiveWins >= 2) {
        state.onFire = true;
      }
    } else if (result === 'draw') {
      state.draws++;
      state.points += state.onFire ? 2 : 1;
      state.consecutiveWins = 0;
      state.onFire = false;
    } else {
      state.losses++;
      state.consecutiveWins = 0;
      state.onFire = false;
    }
  }

  standings(): ArenaStanding[] {
    const arr: ArenaStanding[] = [];
    for (const p of this.participants) {
      const st = this.playerStates.get(p)!;
      arr.push({
        playerId: p,
        points: st.points,
        wins: st.wins,
        draws: st.draws,
        losses: st.losses,
        gamesPlayed: st.gamesPlayed,
        onFire: st.onFire
      });
    }

    // sort by points desc, then deterministic tie-break
    arr.sort((a, b) => {
      if (a.points !== b.points) {
        return b.points - a.points;
      }
      return a.playerId.localeCompare(b.playerId);
    });

    return arr;
  }

  toSnapshot(): ArenaSnapshot {
    return {
      config: this.config,
      state: this.state,
      startedAtMs: this.startedAtMs,
      participants: Array.from(this.participants),
      withdrawn: Array.from(this.withdrawn),
      // Copy the nested mutable objects so the snapshot is independent of the
      // aggregate: later mutations must not leak into an already-taken snapshot.
      playerStates: Object.fromEntries(
        Array.from(this.playerStates.entries(), ([p, s]) => [p, { ...s }]),
      ),
      activeGames: Object.fromEntries(
        Array.from(this.activeGames.entries(), ([id, g]) => [id, { ...g }]),
      ),
      pairingSequence: this.pairingSequence,
      lastOpponents: Object.fromEntries(this.lastOpponents.entries()),
      playedAsWhite: Object.fromEntries(this.playedAsWhite.entries()),
      playedAsBlack: Object.fromEntries(this.playedAsBlack.entries()),
      gameLinks: Array.from(this.gameLinks.entries())
    };
  }

  static restore(snap: ArenaSnapshot): ArenaTournament {
    if (!Number.isSafeInteger(snap.config.durationMs) || snap.config.durationMs <= 0
      || (snap.state === 'registration' && snap.startedAtMs !== undefined)) {
      throw new Error('Invalid persisted Arena deadline; operator repair required');
    }
    if (!['registration', 'running', 'finished'].includes(snap.state)
      || !Array.isArray(snap.participants) || !Array.isArray(snap.withdrawn)
      || !snap.activeGames || typeof snap.activeGames !== 'object' || Array.isArray(snap.activeGames)
      || !snap.playerStates || typeof snap.playerStates !== 'object'
      || !Number.isSafeInteger(snap.pairingSequence) || snap.pairingSequence < 0
      || (snap.gameLinks !== undefined && !Array.isArray(snap.gameLinks))) {
      throw new Error('Invalid persisted Arena structure; operator repair required');
    }
    const participants = new Set(snap.participants);
    if (participants.size !== snap.participants.length || snap.participants.some(p => typeof p !== 'string' || !Object.hasOwn(snap.playerStates, p) || !snap.playerStates[p])) {
      throw new Error('Invalid persisted Arena participants; operator repair required');
    }
    if (!snap.playedAsWhite || !snap.playedAsBlack || !snap.lastOpponents
      || typeof snap.playedAsWhite !== 'object' || typeof snap.playedAsBlack !== 'object' || typeof snap.lastOpponents !== 'object'
      || Array.isArray(snap.playerStates) || Array.isArray(snap.playedAsWhite)
      || Array.isArray(snap.playedAsBlack) || Array.isArray(snap.lastOpponents)
      || snap.withdrawn.some(p => !participants.has(p))) {
      throw new Error('Invalid persisted Arena player maps; operator repair required');
    }
    for (const player of snap.participants) {
      const state = snap.playerStates[player]!;
      const values = [state.points, state.wins, state.draws, state.losses, state.consecutiveWins, state.gamesPlayed,
        snap.playedAsWhite[player], snap.playedAsBlack[player]];
      if (values.some(value => !Number.isSafeInteger(value) || value < 0) || typeof state.onFire !== 'boolean'
        || state.gamesPlayed !== state.wins + state.draws + state.losses) {
        throw new Error('Invalid persisted Arena player state; operator repair required');
      }
    }
    const activePlayers = new Set<string>();
    for (const [id, game] of Object.entries(snap.activeGames)) {
      const sequence = Number(id.slice(2));
      if (!id.startsWith('a:') || !Number.isSafeInteger(sequence) || sequence <= 0 || sequence > snap.pairingSequence
        || !game || (game.launchNamespace !== undefined && game.launchNamespace !== 'committed-v1')
        || game.white === game.black || !participants.has(game.white) || !participants.has(game.black)
        || activePlayers.has(game.white) || activePlayers.has(game.black)) {
        throw new Error('Invalid persisted Arena pairing; operator repair required');
      }
      activePlayers.add(game.white); activePlayers.add(game.black);
    }
    const linkedPairings = new Set<string>(), linkedGames = new Set<string>();
    for (const link of snap.gameLinks ?? []) {
      if (!Array.isArray(link) || link.length !== 2 || typeof link[0] !== 'string' || typeof link[1] !== 'string'
        || !Object.hasOwn(snap.activeGames, link[0]) || linkedPairings.has(link[0]) || linkedGames.has(link[1])) {
        throw new Error('Invalid persisted Arena game link; operator repair required');
      }
      linkedPairings.add(link[0]); linkedGames.add(link[1]);
    }
    if (snap.state !== 'running' && activePlayers.size > 0) throw new Error('Invalid inactive Arena games; operator repair required');
    if (snap.state !== 'registration' && (!Number.isSafeInteger(snap.startedAtMs)
      || snap.startedAtMs! < 0 || !Number.isSafeInteger(snap.config.durationMs)
      || snap.config.durationMs <= 0 || !Number.isSafeInteger(snap.startedAtMs! + snap.config.durationMs))) {
      throw new Error('Invalid persisted Arena deadline; operator repair required');
    }
    const t = new ArenaTournament(snap.config);
    t.state = snap.state;
    t.startedAtMs = snap.startedAtMs;
    
    for (const p of (snap.participants || [])) {
      t.participants.add(p);
    }
    for (const p of (snap.withdrawn || [])) {
      t.withdrawn.add(p);
    }
    
    if (snap.playerStates) {
      for (const [p, state] of Object.entries(snap.playerStates)) {
        t.playerStates.set(p, { ...state });
      }
    }
    if (snap.activeGames) {
      for (const [id, game] of Object.entries(snap.activeGames)) {
        t.activeGames.set(id, { ...game });
      }
    }
    
    t.pairingSequence = snap.pairingSequence || 0;
    
    if (snap.lastOpponents) {
      for (const [p, opp] of Object.entries(snap.lastOpponents)) {
        t.lastOpponents.set(p, opp);
      }
    }
    
    if (snap.playedAsWhite) {
      for (const [p, num] of Object.entries(snap.playedAsWhite)) {
        t.playedAsWhite.set(p, num);
      }
    }
    
    if (snap.playedAsBlack) {
      for (const [p, num] of Object.entries(snap.playedAsBlack)) {
        t.playedAsBlack.set(p, num);
      }
    }
    
    if (snap.gameLinks) {
      for (const [pId, gId] of snap.gameLinks) {
        t.gameLinks.set(pId, gId);
      }
    }
    
    return t;
  }
}
