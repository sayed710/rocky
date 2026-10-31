/**
 * @packageDocumentation
 * A room is the set of connections watching or playing one game on this
 * gateway node. It owns local fanout and presence; it does not own game state
 * (the authority does) nor cross-node fanout (pub/sub does).
 */

import type { Connection } from './transport';
import type { Broadcast, PresenceMessage, Role, ServerMessage, StateMessage } from './protocol';

interface Member {
  readonly conn: Connection;
  readonly userId: string;
  readonly role: Role;
}

export class Room {
  private readonly members = new Map<string, Member>();

  constructor(readonly gameId: string) {}

  /** Add or replace a connection's membership. */
  add(conn: Connection, userId: string, role: Role): void {
    this.members.set(conn.id, { conn, userId, role });
  }

  /** Remove a connection; returns true if it was present. */
  remove(connId: string): boolean {
    return this.members.delete(connId);
  }

  has(connId: string): boolean {
    return this.members.has(connId);
  }

  get size(): number {
    return this.members.size;
  }

  /** Fan a broadcast out to every member of the room. */
  broadcast(msg: Broadcast | StateMessage): void {
    for (const m of this.members.values()) m.conn.send(msg);
  }

  /** Send a point-to-point message to one member, if present. */
  sendTo(connId: string, msg: ServerMessage): void {
    this.members.get(connId)?.conn.send(msg);
  }

  /** Send an arbitrary server message to every member of the room. */
  sendAll(msg: ServerMessage): void {
    for (const m of this.members.values()) m.conn.send(msg);
  }

  /** Current presence snapshot for this game. */
  presence(): PresenceMessage {
    let white = false;
    let black = false;
    let spectators = 0;
    for (const m of this.members.values()) {
      if (m.role === 'white') white = true;
      else if (m.role === 'black') black = true;
      else spectators++;
    }
    return { t: 'presence', gameId: this.gameId, white, black, spectators };
  }

  /** Broadcast the current presence to every member. */
  broadcastPresence(): void {
    const p = this.presence();
    for (const m of this.members.values()) m.conn.send(p);
  }
}
