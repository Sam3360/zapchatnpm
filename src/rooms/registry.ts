/**
 * The in-memory model of everything we know about the LAN.
 *
 * This module is deliberately free of sockets and timers: it is a plain data
 * structure that answers "who is online, what rooms exist, who is in them, and
 * have I already seen this message id". That makes the interesting behaviour
 * (membership changes, duplicate suppression, peers disappearing) unit-testable
 * without touching the network.
 *
 * Rooms are *derived*: a room exists while somebody announces it. There is no
 * room server and no room registry to keep consistent.
 */

import {
  DEDUP_CACHE_SIZE,
  DEDUP_WINDOW_MS,
  DEFAULT_WIRE_VERSION,
  HISTORY_LIMIT,
  KNOWN_ROOM_TTL_MS,
  PEER_STALE_MS,
} from '../protocol/constants.js';
import { newMessageId, type PeerContact } from '../protocol/messages.js';

export type PeerSource = 'lan' | 'tcp' | 'manual';

export interface PeerRecord {
  clientId: string;
  username: string;
  /** Room the peer says it is in, or null. */
  room: string | null;
  /** TCP port the peer listens on. */
  port: number;
  /** IPv4 addresses, most-recently-observed first. */
  addresses: string[];
  /** How we learned about the peer. */
  source: PeerSource;
  /** Last time we heard anything from this peer (announce or frame). */
  lastSeen: number;
  /** True while a TCP link to this peer is established. */
  connected: boolean;
  connectedAt: number | null;
  /** Round-trip time of the last PONG, when known. */
  latencyMs: number | null;
  /** Wire version the peer was last seen speaking (1 = legacy, 2 = v2-capable). */
  wireVersion: number;
}

export interface RoomSummary {
  name: string;
  /** Non-stale peers in the room, including us when we are in it. */
  online: number;
  /** True when the local user is in this room. */
  self: boolean;
  /** How many peers in the room have a live TCP link. */
  connectedPeers: number;
}

export interface ChatMessage {
  id: string;
  room: string;
  kind: 'chat' | 'system';
  text: string;
  from: string;
  username: string;
  ts: number;
  self: boolean;
  /** Marks locally generated notices, e.g. "you joined #general". */
  tone?: 'info' | 'warn' | 'error';
}

export interface RoomRegistryOptions {
  selfClientId: string;
  selfUsername?: string;
  staleMs?: number;
  historyLimit?: number;
  dedupLimit?: number;
  dedupWindowMs?: number;
  knownRoomTtlMs?: number;
}

export interface UpsertPeerResult {
  peer: PeerRecord;
  /** True when this clientId was not known before. */
  added: boolean;
  /** Previous room, so callers can emit join/leave notices. */
  previousRoom: string | null;
}

export interface UpsertPeerOptions {
  /** Wire version advertised by the peer (beacons) or negotiated (links). */
  wireVersion?: number;
}

export class RoomRegistry {
  readonly #selfClientId: string;
  readonly #staleMs: number;
  readonly #historyLimit: number;
  readonly #dedupLimit: number;
  readonly #dedupWindowMs: number;
  readonly #knownRoomTtlMs: number;

  #selfUsername: string;
  #selfRoom: string | null = null;

  readonly #peers = new Map<string, PeerRecord>();
  /** Room name → last time it was announced by anybody. */
  readonly #knownRooms = new Map<string, number>();
  /** Message id → time first seen, insertion ordered for cheap eviction. */
  readonly #seenIds = new Map<string, number>();
  readonly #history = new Map<string, ChatMessage[]>();

  constructor(options: RoomRegistryOptions) {
    this.#selfClientId = options.selfClientId;
    this.#selfUsername = options.selfUsername ?? '';
    this.#staleMs = options.staleMs ?? PEER_STALE_MS;
    this.#historyLimit = options.historyLimit ?? HISTORY_LIMIT;
    this.#dedupLimit = options.dedupLimit ?? DEDUP_CACHE_SIZE;
    this.#dedupWindowMs = options.dedupWindowMs ?? DEDUP_WINDOW_MS;
    this.#knownRoomTtlMs = options.knownRoomTtlMs ?? KNOWN_ROOM_TTL_MS;
  }

  get selfClientId(): string {
    return this.#selfClientId;
  }

  get selfUsername(): string {
    return this.#selfUsername;
  }

  get selfRoom(): string | null {
    return this.#selfRoom;
  }

  get staleMs(): number {
    return this.#staleMs;
  }

  setSelfUsername(username: string): void {
    this.#selfUsername = username;
  }

  /** Change our own room. Returns the previous room. */
  setSelfRoom(room: string | null): string | null {
    const previous = this.#selfRoom;
    this.#selfRoom = room;
    if (room !== null) {
      this.noteRoom(room);
    }

    return previous;
  }

  /** Record that a room exists (from an announce or a room list). */
  noteRoom(room: string, now: number = Date.now()): void {
    this.#knownRooms.set(room, now);
  }

  /** Rooms we have heard about, newest first, expired entries pruned. */
  knownRooms(now: number = Date.now()): string[] {
    const live: Array<[string, number]> = [];
    for (const [name, seenAt] of this.#knownRooms) {
      if (now - seenAt <= this.#knownRoomTtlMs) {
        live.push([name, seenAt]);
      } else {
        this.#knownRooms.delete(name);
      }
    }

    return live.sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }

  /**
   * Insert or refresh a peer. Refreshing keeps the newest display name, room and
   * advertised addresses while preserving connection state.
   */
  upsertPeer(
    contact: PeerContact,
    source: PeerSource,
    now: number = Date.now(),
    options: UpsertPeerOptions = {},
  ): UpsertPeerResult {
    const existing = this.#peers.get(contact.clientId);
    if (existing === undefined) {
      const peer: PeerRecord = {
        clientId: contact.clientId,
        username: contact.username,
        room: contact.room,
        port: contact.port,
        addresses: [...contact.addresses],
        source,
        lastSeen: now,
        connected: false,
        connectedAt: null,
        latencyMs: null,
        wireVersion: options.wireVersion ?? DEFAULT_WIRE_VERSION,
      };
      this.#peers.set(peer.clientId, peer);
      if (peer.room !== null) {
        this.noteRoom(peer.room, now);
      }

      return { peer, added: true, previousRoom: null };
    }

    const previousRoom = existing.room;
    existing.username = contact.username.length > 0 ? contact.username : existing.username;
    existing.room = contact.room;
    existing.port = contact.port;
    existing.addresses = mergeAddresses(existing.addresses, contact.addresses);
    existing.lastSeen = now;
    if (options.wireVersion !== undefined) {
      // Never downgrade: clients that speak several wire versions announce in
      // all of them (v6+ sends v1 AND v2 beacons every few seconds), so the
      // last packet to arrive must not re-classify a v2-capable peer as
      // legacy — that used to stall the mesh until a manual /connect.
      existing.wireVersion = Math.max(existing.wireVersion, options.wireVersion);
    }
    if (source === 'manual') {
      existing.source = 'manual';
    } else if (existing.source === 'lan' && source === 'tcp') {
      existing.source = 'tcp';
    }

    if (existing.room !== null) {
      this.noteRoom(existing.room, now);
    }

    return { peer: existing, added: false, previousRoom };
  }

  /**
   * Note an address we observed traffic from, and move it to the front of the
   * candidate list: the address a peer actually reached us from is the most
   * likely one to work in the other direction.
   */
  notePeerAddress(clientId: string, address: string, now: number = Date.now()): void {
    const peer = this.#peers.get(clientId);
    if (peer === undefined) {
      return;
    }

    peer.addresses = mergeAddresses([address], peer.addresses);
    peer.lastSeen = now;
  }

  setPeerConnection(
    clientId: string,
    connected: boolean,
    now: number = Date.now(),
  ): PeerRecord | undefined {
    const peer = this.#peers.get(clientId);
    if (peer === undefined) {
      return undefined;
    }

    peer.connected = connected;
    peer.connectedAt = connected ? now : null;
    if (!connected) {
      peer.latencyMs = null;
    }

    return peer;
  }

  setPeerLatency(clientId: string, latencyMs: number): void {
    const peer = this.#peers.get(clientId);
    if (peer !== undefined) {
      peer.latencyMs = latencyMs;
    }
  }

  /** Update a peer's room from a JOIN/LEAVE/HELLO. Returns the previous room. */
  setPeerRoom(
    clientId: string,
    room: string | null,
    now: number = Date.now(),
  ): string | null | undefined {
    const peer = this.#peers.get(clientId);
    if (peer === undefined) {
      return undefined;
    }

    const previous = peer.room;
    peer.room = room;
    peer.lastSeen = now;
    if (room !== null) {
      this.noteRoom(room, now);
    }

    return previous;
  }

  touchPeer(clientId: string, now: number = Date.now()): void {
    const peer = this.#peers.get(clientId);
    if (peer !== undefined) {
      peer.lastSeen = now;
    }
  }

  getPeer(clientId: string): PeerRecord | undefined {
    return this.#peers.get(clientId);
  }

  /** All peers, online first, then by username. */
  peers(now: number = Date.now()): PeerRecord[] {
    return [...this.#peers.values()].sort((a, b) => {
      const aOnline = this.isOnline(a, now) ? 0 : 1;
      const bOnline = this.isOnline(b, now) ? 0 : 1;
      if (aOnline !== bOnline) {
        return aOnline - bOnline;
      }

      return a.username.localeCompare(b.username);
    });
  }

  online(now: number = Date.now()): PeerRecord[] {
    return this.peers(now).filter(peer => this.isOnline(peer, now));
  }

  isOnline(peer: PeerRecord, now: number = Date.now()): boolean {
    return now - peer.lastSeen <= this.#staleMs;
  }

  /** Peers currently in a room (never includes us). */
  membersIn(room: string, now: number = Date.now()): PeerRecord[] {
    return this.online(now).filter(peer => peer.room === room);
  }

  /**
   * Drop peers we have not heard from in a while. Returns the peers that were
   * removed so the caller can emit "left" notices.
   */
  removeStale(now: number = Date.now()): PeerRecord[] {
    const removed: PeerRecord[] = [];
    for (const [clientId, peer] of this.#peers) {
      if (now - peer.lastSeen > this.#staleMs) {
        removed.push(peer);
        this.#peers.delete(clientId);
      }
    }

    return removed;
  }

  removePeer(clientId: string): PeerRecord | undefined {
    const peer = this.#peers.get(clientId);
    this.#peers.delete(clientId);
    return peer;
  }

  /** Rooms known to the LAN right now, most populated first. */
  rooms(now: number = Date.now()): RoomSummary[] {
    const online = this.online(now);
    const connected = [...this.#peers.values()].filter(peer => peer.connected);

    const names = new Set<string>();
    for (const peer of online) {
      if (peer.room !== null) {
        names.add(peer.room);
      }
    }

    for (const name of this.knownRooms(now)) {
      names.add(name);
    }

    if (this.#selfRoom !== null) {
      names.add(this.#selfRoom);
    }

    const summaries: RoomSummary[] = [...names].map(name => {
      const members = online.filter(peer => peer.room === name);
      return {
        name,
        online: members.length + (this.#selfRoom === name ? 1 : 0),
        self: this.#selfRoom === name,
        connectedPeers: connected.filter(peer => peer.room === name).length,
      };
    });

    return summaries.sort((a, b) => {
      if (a.online !== b.online) {
        return b.online - a.online;
      }

      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Duplicate suppression. Returns `false` when the id was already seen, which
   * is how relayed messages avoid being delivered twice.
   */
  markSeen(messageId: string, now: number = Date.now()): boolean {
    this.#expireSeen(now);

    if (this.#seenIds.has(messageId)) {
      return false;
    }

    this.#seenIds.set(messageId, now);

    // Oldest-first eviction keeps the cache strictly within its budget.
    while (this.#seenIds.size > this.#dedupLimit) {
      const oldest = this.#seenIds.keys().next().value;
      if (oldest === undefined) {
        break;
      }

      this.#seenIds.delete(oldest);
    }

    return true;
  }

  hasSeen(messageId: string): boolean {
    return this.#seenIds.has(messageId);
  }

  get seenCount(): number {
    return this.#seenIds.size;
  }

  /** Forget ids older than the dedup window. */
  #expireSeen(now: number): void {
    for (const [id, seenAt] of this.#seenIds) {
      if (now - seenAt > this.#dedupWindowMs) {
        this.#seenIds.delete(id);
      }
    }
  }

  /**
   * Store a message in the room timeline, trimming the oldest entries.
   *
   * Duplicate suppression is the caller's job (`markSeen`), because relayed
   * messages must be dropped *before* anything is stored or re-forwarded.
   */
  recordMessage(message: ChatMessage): void {
    const bucket = this.#history.get(message.room);
    if (bucket === undefined) {
      this.#history.set(message.room, [message]);
      return;
    }

    bucket.push(message);
    if (bucket.length > this.#historyLimit) {
      bucket.splice(0, bucket.length - this.#historyLimit);
    }
  }

  /** Append a locally generated notice (join/leave/error) to a room timeline. */
  appendSystem(
    room: string,
    text: string,
    tone: 'info' | 'warn' | 'error' = 'info',
    now: number = Date.now(),
  ): ChatMessage {
    const message: ChatMessage = {
      id: newMessageId(),
      room,
      kind: 'system',
      text,
      from: this.#selfClientId,
      username: '',
      ts: now,
      self: true,
      tone,
    };

    this.recordMessage(message);
    return message;
  }

  history(room: string): ChatMessage[] {
    return this.#history.get(room) ?? [];
  }

  clearHistory(room: string): void {
    this.#history.delete(room);
  }

  /** Number of rooms with stored history (used by tests and diagnostics). */
  get historyRoomCount(): number {
    return this.#history.size;
  }
}

/** Union of two address lists, newest first, de-duplicated, capped at 8. */
export function mergeAddresses(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const address of [...primary, ...secondary]) {
    if (seen.has(address)) {
      continue;
    }

    seen.add(address);
    merged.push(address);
    if (merged.length >= 8) {
      break;
    }
  }

  return merged;
}
