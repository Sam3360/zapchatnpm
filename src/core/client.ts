/**
 * ZapClient — the whole application minus the terminal UI.
 *
 * It owns the discovery socket, the TCP mesh and the room registry, and exposes
 * a small imperative API (`join`, `leave`, `send`, …) plus an immutable
 * snapshot that a UI can render. The TUI is a pure consumer of that snapshot,
 * which is also how the test suite drives two clients against each other.
 *
 * Local-first by construction: the only sockets opened are UDP beacons on the
 * local subnet and direct TCP links to peers on the LAN.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_ROOM,
  DEFAULT_TCP_PORT_BASE,
  FILE_CHUNK_BYTES,
  HISTORY_LIMIT,
  LEGACY_WIRE_VERSION,
  MAX_ACTIVE_TRANSFERS,
  MAX_FILE_BYTES,
  MAX_ROOM_NAME_LENGTH,
  MAX_USERNAME_LENGTH,
  OFFLINE_QUEUE_LIMIT,
  PROTOCOL_VERSION,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  SWEEP_INTERVAL_MS,
  TRANSFER_IDLE_TIMEOUT_MS,
} from '../protocol/constants.js';
import {
  createEnvelope,
  newMessageId,
  readFileChunkData,
  readFileOfferData,
  readHelloData,
  readMessageData,
  readPeerListData,
  readReplyData,
  readReactionData,
  readRoomListData,
  readTransferIdData,
  type Envelope,
  type PeerContact,
} from '../protocol/messages.js';
import {
  formatBytes,
  isTransferableSize,
  receivedFilesDir,
  receivedFilePath,
  sanitizeFileName,
} from '../files/transfers.js';
import { encodeActionMessage, isActionMessage, renderAction } from '../protocol/actions.js';
import { RateLimiter } from '../protocol/ratelimit.js';
import {
  charLength,
  isValidHost,
  isValidPort,
  sanitizeRoomName,
  sanitizeMessageText,
  sanitizeUsername,
} from '../protocol/sanitize.js';
import { loadConfig, saveConfigTo, type Config, type LoadConfigOptions } from '../config/config.js';
import { createClientId, defaultUsername } from '../config/identity.js';
import { HistoryStore } from '../config/history.js';
import { identityKeyId } from '../config/config.js';
import { DiscoveryService, type DiscoveryKind, type DiscoveryState } from '../discovery/discovery.js';
import { TcpTransport, type PeerGoneReason, type PeerHandle } from '../network/transport.js';
import { PeerPinStore } from '../protocol/handshake.js';
import { describeNetwork, localAddresses } from '../network/interfaces.js';
import {
  RoomRegistry,
  type ChatMessage,
  type PeerRecord,
  type RoomSummary,
} from '../rooms/registry.js';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface PeerSnapshot {
  clientId: string;
  username: string;
  room: string | null;
  online: boolean;
  connected: boolean;
  addresses: string[];
  latencyMs: number | null;
  source: PeerRecord['source'];
  /** Wire version the peer speaks (1 = legacy/Python, 2 = encrypted-capable). */
  wireVersion: number;
}

export interface NoticeSnapshot {
  tone: 'info' | 'warn' | 'error' | 'ok';
  text: string;
  ts: number;
}

export interface StatusSnapshot {
  discovery: DiscoveryKind;
  discoveryDetail: string;
  multicast: boolean;
  broadcast: boolean;
  discoveryPort: number;
  tcpPort: number;
  peersOnline: number;
  peersConnected: number;
  beaconsSent: number;
  beaconsReceived: number;
  droppedFrames: number;
  lan: string;
  warnings: string[];
  /** Number of established links running without encryption. */
  plaintextLinks: number;
}

export interface Snapshot {
  /** Bumped on every change so UIs can skip identical frames. */
  revision: number;
  me: { clientId: string; username: string; usernameConfirmed: boolean };
  room: string | null;
  rooms: RoomSummary[];
  peers: PeerSnapshot[];
  /** Peers currently in the local user's room (excludes the local user). */
  members: PeerSnapshot[];
  messages: ChatMessage[];
  notice: NoticeSnapshot | null;
  /** v8: active file transfers (incoming and outgoing), for progress UI. */
  transfers: TransferSnapshot[];
  /** v8: messages buffered while nobody was reachable, oldest first. */
  queued: QueuedMessageSnapshot[];
  status: StatusSnapshot;
}

export interface ZapClientOptions {
  username?: string;
  clientId?: string;
  /** Join this room on start (used by `--room` and headless mode). */
  room?: string | null;
  /** Turn off UDP discovery (manual connections only). */
  discovery?: boolean;
  discoveryPort?: number;
  multicastAddress?: string;
  tcpPortBase?: number;
  /**
   * Opt-in (v5): allow unencrypted protocol v1 links to legacy peers (the
   * Python client). Default off; every plaintext link is announced loudly.
   */
  allowPlaintext?: boolean;
  configPath?: string;
  staleMs?: number;
  /**
   * Persist chat history across restarts (v8.1, default on): one JSONL file
   * per room under the config directory. `false` disables both writing and
   * restoring — the session behaves exactly like v8.0.
   */
  history?: boolean;
  /** Extra config lookup options (tests inject env/platform). */
  configOptions?: LoadConfigOptions;
  log?: (message: string, level: 'info' | 'warn' | 'error') => void;
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  now?: () => number;
}

interface AttemptState {
  count: number;
  nextAt: number;
}

// ------------------------------------------------------------------ transfers

/** Where an outgoing offer has got to for one specific room member. */
type OutgoingPeerPhase = 'offered' | 'sending' | 'done' | 'rejected' | 'cancelled';

interface OutgoingPeer {
  phase: OutgoingPeerPhase;
  /** Bytes handed to the socket for this peer so far. */
  sent: number;
}

/** A file we offered to the room (`/file <path>`). */
interface OutgoingTransfer {
  id: string;
  room: string;
  path: string;
  /** Sanitised bare name sent on the wire and shown in the timeline. */
  name: string;
  size: number;
  /** Last time we pushed bytes or saw a peer response (drives the sweep). */
  lastActivity: number;
  /** Set by `cancelTransfer` / the idle sweep; stream loops watch it. */
  cancelled: boolean;
  peers: Map<string, OutgoingPeer>;
}

/** A file a peer is streaming to us, already opened in the received dir. */
interface IncomingTransfer {
  id: string;
  from: string;
  fromUsername: string;
  room: string;
  name: string;
  size: number;
  /** Absolute path inside the received dir (unique `<id>-<name>` prefix). */
  target: string;
  /** Bytes accepted so far (equals the sum of queued writes). */
  received: number;
  /** Next wire chunk index we will accept (TCP keeps them ordered). */
  nextIndex: number;
  lastActivity: number;
  handle: fsp.FileHandle;
  /** Serialises disk writes so chunks land on disk in wire order. */
  pending: Promise<void>;
}

/** UI-facing view of one buffered message (`Snapshot.queued`). */
export interface QueuedMessageSnapshot {
  id: string;
  room: string;
  /** One-line preview: the text as typed (truncated by the caller). */
  text: string;
  ts: number;
}

/** UI-facing view of one active transfer (`Snapshot.transfers`). */
export interface TransferSnapshot {
  id: string;
  direction: 'send' | 'receive';
  /** Bare file name (already sanitised). */
  name: string;
  size: number;
  /** For sends: max bytes pushed to any peer. For receives: bytes on disk. */
  transferred: number;
  state: 'offering' | 'sending' | 'receiving';
}

/** How long a footer notice stays on screen before the hints come back. */
const NOTICE_TTL_MS = 6000;

/**
 * Chunk-sender pacing: wait for the socket buffer to drain below this before
 * writing more. Must stay comfortably under the transport's drop threshold
 * (MAX_PENDING_WRITE_BYTES) so a fast sender never trips the peer-drop guard.
 */
const TRANSFER_PACE_BYTES = 256 * 1024;

/** Minimum gap between transfer-progress snapshot emissions. */
const TRANSFER_EMIT_MS = 200;

export class ZapClient {
  readonly #options: ZapClientOptions;
  readonly #now: () => number;
  readonly #log: (message: string, level: 'info' | 'warn' | 'error') => void;

  #config: Config;
  #configPath: string;
  /** Durable per-room chat history; null when --no-history (or tests) opt out. */
  #historyStore: HistoryStore | null = null;
  #clientId: string;
  #username: string;
  #usernameConfirmed: boolean;
  #registry: RoomRegistry;
  /** TOFU pin store for peer identity keys (protocol v2). */
  #pinStore: PeerPinStore;
  /**
   * Identity key id last presented by each peer, for `/fingerprint`. Kept
   * separate from the pin store so a peer's key is still shown after `/untrust`.
   */
  readonly #peerKeyIds = new Map<string, string>();

  #discovery: DiscoveryService | null = null;
  #transport: TcpTransport | null = null;
  #tcpPort = 0;
  #started = false;
  #stopping = false;

  #sweepTimer: NodeJS.Timeout | null = null;
  #subscribers = new Set<() => void>();
  #snapshot: Snapshot;
  #revision = 0;
  #dirty = true;

  #notice: NoticeSnapshot | null = null;
  #warnings: string[] = [];

  readonly #advertisedRooms = new Set<string>();
  /** Per-peer flood guard for MESSAGE frames (v4). */
  readonly #messageLimiter = new RateLimiter();
  readonly #attempts = new Map<string, AttemptState>();
  /** Peers we have shown a "reconnecting" notice for. */
  readonly #reconnecting = new Set<string>();
  /** Peers we have warned about legacy-protocol plaintext dials (v5). */
  readonly #legacyWarned = new Set<string>();
  #peerListDirty = false;

  // ---- v8 file transfers -------------------------------------------------
  /** Offers we published: room, path and per-peer send progress. */
  readonly #outgoing = new Map<string, OutgoingTransfer>();
  /** Files peers are streaming to us, keyed by transfer id. */
  readonly #incoming = new Map<string, IncomingTransfer>();
  /** Ids whose target file is being opened (dedup + capacity guard). */
  readonly #pendingIncoming = new Set<string>();
  /**
   * Messages sent while the room had no reachable peer. They keep their
   * original envelope (and therefore id and timestamp) so the replay looks
   * like the delayed send it was, not a fresh message.
   */
  readonly #offlineQueue = new Map<string, Envelope>();
  /** Throttle for progress-only snapshot emissions. */
  #lastTransferEmit = 0;

  constructor(options: ZapClientOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
    this.#pinStore = new PeerPinStore();

    const loaded = loadConfig({
      ...(options.configOptions ?? {}),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      now: this.#now(),
    });

    this.#config = loaded.config;
    this.#configPath = loaded.path;
    this.#clientId = options.clientId ?? loaded.config.clientId;
    this.#pinStore.seed(loaded.config.peerPins);

    if (loaded.warning !== undefined) {
      this.#addWarning(loaded.warning);
    }

    const requestedUsername =
      options.username === undefined ? undefined : sanitizeUsername(options.username);

    if (requestedUsername !== null && requestedUsername !== undefined) {
      this.#username = requestedUsername;
      this.#usernameConfirmed = true;
    } else if (loaded.config.username.length > 0) {
      this.#username = loaded.config.username;
      this.#usernameConfirmed = true;
    } else {
      this.#username = defaultUsername();
      this.#usernameConfirmed = false;
    }

    if (options.username !== undefined && requestedUsername === null) {
      this.#addWarning(`ignored invalid username "${options.username}"`);
    }

    // Durable history must be wired before the registry exists: the registry
    // hands every timeline entry to the store as it is appended, so what is
    // on disk can never drift from what the timeline shows.
    this.#historyStore =
      options.history === false
        ? null
        : new HistoryStore(path.dirname(this.#configPath), HISTORY_LIMIT);

    this.#registry = new RoomRegistry({
      selfClientId: this.#clientId,
      selfUsername: this.#username,
      ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
      onAppend: message => this.#historyStore?.append(message),
    });

    if (this.#historyStore !== null) {
      for (const room of this.#historyStore.rooms()) {
        for (const message of this.#historyStore.load(room)) {
          this.#registry.restoreMessage(message);
        }
      }
    }

    this.#snapshot = this.#buildSnapshot();
  }

  get clientId(): string {
    return this.#clientId;
  }

  get username(): string {
    return this.#username;
  }

  get usernameConfirmed(): boolean {
    return this.#usernameConfirmed;
  }

  get room(): string | null {
    return this.#registry.selfRoom;
  }

  get tcpPort(): number {
    return this.#tcpPort;
  }

  get configPath(): string {
    return this.#configPath;
  }

  /** Room from the last session, used to preselect a room in the lobby. */
  get lastRoomHint(): string | null {
    return this.#config.lastRoom.length > 0 ? this.#config.lastRoom : null;
  }

  get discoveryPort(): number {
    return this.#discovery?.port ?? this.#options.discoveryPort ?? DEFAULT_DISCOVERY_PORT;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Start listening, begin beaconing and (optionally) join a room. */
  async start(): Promise<void> {
    if (this.#started) {
      return;
    }

    this.#started = true;
    this.#stopping = false;

    const transport = new TcpTransport(
      {
        getHello: () => ({
          username: this.#username,
          room: this.#registry.selfRoom,
          port: this.#tcpPort,
          addresses: localAddresses(this.#options.networkInterfaces?.() ?? os.networkInterfaces()),
        }),
        onPeerReady: peer => this.#onPeerReady(peer),
        onPeerGone: (peer, reason) => this.#onPeerGone(peer, reason),
        onEnvelope: (envelope, peer) => this.#onEnvelope(envelope, peer),
        onPeerLatency: (peer, latency) => {
          this.#registry.setPeerLatency(peer.clientId, latency);
          this.#markDirty();
        },
        onWarning: message => this.#addWarning(message),
      },
      {
        clientId: this.#clientId,
        identitySeed: Buffer.from(this.#config.identityKey, 'base64'),
        checkPeerPin: (clientId, identityKeyId) => {
          this.#peerKeyIds.set(clientId, identityKeyId);
          const verdict = this.#pinStore.check(clientId, identityKeyId, this.#now());
          if (verdict === 'new') {
            // First contact with this peer: persist the pin immediately so it
            // is already on disk before the next encounter.
            this.#config = { ...this.#config, peerPins: this.#pinStore.toConfig() };
            this.#writeConfig();
          }

          return verdict;
        },
        allowPlaintext: this.#options.allowPlaintext === true,
        now: this.#now,
      },
    );

    this.#transport = transport;

    try {
      this.#tcpPort = await transport.listen(this.#options.tcpPortBase ?? DEFAULT_TCP_PORT_BASE);
    } catch (error) {
      this.#started = false;
      throw new Error(
        `could not open a TCP port for incoming peers (${(error as Error).message})`,
      );
    }

    if (this.#options.discovery !== false) {
      const discovery = new DiscoveryService({
        clientId: this.#clientId,
        ...(this.#options.discoveryPort === undefined
          ? {}
          : { port: this.#options.discoveryPort }),
        ...(this.#options.multicastAddress === undefined
          ? {}
          : { multicastAddress: this.#options.multicastAddress }),
        getAnnounce: () => ({
          username: this.#username,
          room: this.#registry.selfRoom,
          port: this.#tcpPort,
          rooms: [...this.#advertisedRooms],
        }),
        onAnnounce: (peer, observation) => this.#onAnnounce(peer, observation.address),
        onError: error => this.#addWarning(`discovery: ${error.message}`),
        ...(this.#options.networkInterfaces === undefined
          ? {}
          : { networkInterfaces: this.#options.networkInterfaces }),
        now: this.#now,
      });

      this.#discovery = discovery;
      const state = await discovery.start();
      if (state.kind !== 'ok') {
        this.#addWarning(state.detail);
      }
    }

    const initialRoom = this.#normaliseRoom(this.#options.room);
    if (initialRoom !== null) {
      this.join(initialRoom);
    }

    this.#sweepTimer = setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS);
    this.#sweepTimer.unref?.();

    this.#log(`listening on tcp:${this.#tcpPort} as ${this.#username} (${this.#clientId})`, 'info');
    this.#markDirty();
    this.#emit();
  }

  /** Stop everything: tell peers we left, close sockets, persist config. */
  async stop(): Promise<void> {
    if (!this.#started || this.#stopping) {
      return;
    }

    this.#stopping = true;

    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }

    if (this.#registry.selfRoom !== null) {
      this.#broadcastPresence('LEAVE');
    }

    // Abort transfers: peers get FILE_CANCEL where a link is still open, and
    // partial incoming files are removed from disk.
    for (const [id, transfer] of [...this.#outgoing]) {
      this.#outgoing.delete(id);
      transfer.cancelled = true;
      for (const peerId of transfer.peers.keys()) {
        this.#sendTransferControl('FILE_CANCEL', peerId, transfer.id, transfer.room);
      }
    }

    for (const [id, transfer] of [...this.#incoming]) {
      this.#incoming.delete(id);
      this.#discardIncoming(transfer);
    }

    this.#transport?.close();
    this.#discovery?.stop();

    this.#persistConfig();
    this.#started = false;
    this.#stopping = false;
    this.#markDirty();
  }

  // -------------------------------------------------------------- subscription

  /** Current immutable snapshot. Stable between changes. */
  getSnapshot(): Snapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  // ------------------------------------------------------------------- actions

  /** Join a room (creating it implicitly on the LAN). */
  join(roomInput: string): ActionResult {
    const room = this.#normaliseRoom(roomInput);
    if (room === null) {
      return this.#fail(`"${roomInput}" is not a valid room name (letters, numbers, . _ - )`);
    }

    const previous = this.#registry.selfRoom;
    if (previous === room) {
      return { ok: true };
    }

    if (previous !== null) {
      this.#broadcastPresence('LEAVE');
    }

    this.#registry.setSelfRoom(room);
    this.#advertisedRooms.add(room);
    this.#registry.noteRoom(room, this.#now());

    this.#broadcastPresence('JOIN');
    this.#discovery?.announceNow();

    const members = this.#registry.membersIn(room);
    const others = members.length === 0 ? 'nobody else is here yet' : `${describeMembers(members)} here`;
    this.#registry.appendSystem(room, `you joined #${room} — ${others}`, 'info', this.#now());
    this.#setNotice('ok', `joined #${room}`);
    this.#saveLastRoom(room);

    this.#markDirty();
    this.#emit();
    return { ok: true };
  }

  /** Create and join a room. Rooms are implicit, so this is join + advertise. */
  create(roomInput: string): ActionResult {
    const result = this.join(roomInput);
    if (result.ok) {
      const room = this.#normaliseRoom(roomInput);
      if (room !== null) {
        this.#registry.noteRoom(room, this.#now());
        this.#discovery?.announceNow();
      }
    }

    return result;
  }

  /** Leave the current room. History is kept locally so re-joining shows it. */
  leave(): ActionResult {
    const current = this.#registry.selfRoom;
    if (current === null) {
      return this.#fail('you are not in a room');
    }

    this.#broadcastPresence('LEAVE');
    this.#registry.setSelfRoom(null);
    this.#discovery?.announceNow();
    this.#setNotice('info', `left #${current}`);
    this.#markDirty();
    this.#emit();
    return { ok: true };
  }

  /** Send a chat message to everyone in the current room. */
  send(text: string): ActionResult {
    const room = this.#registry.selfRoom;
    if (room === null) {
      return this.#fail('join a room first (/join general)');
    }

    if (charLength(text) > 4000) {
      return this.#fail('message is too long');
    }

    const body = sanitizeMessageText(text);
    if (body.length === 0) {
      return this.#fail('message is empty');
    }

    const envelope = createEnvelope('MESSAGE', this.#identity(), {
      room,
      data: { text: body },
      ts: this.#now(),
    });

    return this.#sendMessageEnvelope(envelope, room, body);
  }

  /** Send a `/me` action, rendered as "* yourname waves" on every peer. */
  sendAction(text: string): ActionResult {
    const room = this.#registry.selfRoom;
    if (room === null) {
      return this.#fail('join a room first (/join general)');
    }

    const framed = encodeActionMessage(text);
    if (framed === null) {
      return this.#fail('action is empty');
    }

    // Re-check the length against the *framed* payload so actions obey the
    // same wire limit as ordinary messages.
    if (charLength(framed) > 4000) {
      return this.#fail('message is too long');
    }

    const envelope = createEnvelope('MESSAGE', this.#identity(), {
      room,
      data: { text: framed },
      ts: this.#now(),
    });

    // The local echo is the rendered form ("* alice waves"); the wire payload
    // stays the framed text. #sendMessageEnvelope records the message, sends,
    // and shows the no-peers notice when needed.
    return this.#sendMessageEnvelope(envelope, room, renderAction(this.#username, framed));
  }

  #sendMessageEnvelope(envelope: Envelope, room: string, body: string): ActionResult {

    // Mark our own id as seen so a relayed echo is ignored.
    this.#registry.markSeen(envelope.id, this.#now());

    this.#registry.recordMessage({
      id: envelope.id,
      room,
      kind: 'chat',
      text: body,
      from: this.#clientId,
      username: this.#username,
      ts: envelope.ts,
      self: true,
    });

    const delivered = this.#sendToRoom(room, envelope);
    if (delivered === 0) {
      // Nobody was reachable: buffer it and replay when a peer shows up rather
      // than silently dropping what the user just wrote.
      const queued = this.#queueOffline(envelope, room);
      this.#setNotice(
        'warn',
        queued
          ? 'no peers are connected yet — your message is queued and will send when one joins'
          : 'no peers are connected yet — the offline queue was full, so the oldest queued message was dropped',
      );
    } else if (this.#notice?.tone === 'warn') {
      this.#notice = null;
    }

    this.#markDirty();
    this.#emit();
    return { ok: true };
  }

  /**
   * Buffer an envelope that reached nobody. Returns false when the queue is
   * full (the caller tells the user their message was not sent at all, which
   * is far better than pretending it is waiting somewhere).
   */
  #queueOffline(envelope: Envelope, room: string): boolean {
    const hadRoom = this.#offlineQueue.size < OFFLINE_QUEUE_LIMIT;
    if (!hadRoom) {
      // Full: drop the oldest so the message the user just wrote survives, and
      // say so rather than losing their history silently.
      const oldest = this.#offlineQueue.keys().next();
      if (oldest.done !== true) {
        this.#offlineQueue.delete(oldest.value);
      }
    }

    this.#offlineQueue.set(envelope.id, envelope);
    this.#registry.setQueued(room, envelope.id, true);

    return hadRoom;
  }

  /**
   * Replay buffered messages once their room has somebody in it.
   *
   * Per-envelope rather than per-room so one busy room cannot hold up (or
   * leak) another room's backlog; the oldest message goes first.
   */
  #flushOfflineQueue(): void {
    if (this.#offlineQueue.size === 0) {
      return;
    }

    const transport = this.#transport;
    if (transport === null) {
      return;
    }

    let flushed = 0;
    const flushedByRoom = new Map<string, number>();
    for (const [id, envelope] of [...this.#offlineQueue]) {
      const room = envelope.room;
      if (room === null || this.#membersInRoom(room).length === 0) {
        continue;
      }

      if (this.#sendToRoom(room, envelope) > 0) {
        // Capture the room before dropping it from the queue: the timeline
        // still needs to know which room's echo to un-flag.
        this.#offlineQueue.delete(id);
        this.#registry.setQueued(room, id, false);
        flushedByRoom.set(room, (flushedByRoom.get(room) ?? 0) + 1);
        flushed += 1;
      }
    }

    if (flushed === 0) {
      return;
    }

    for (const [room, count] of flushedByRoom) {
      this.#registry.appendSystem(
        room,
        `sent ${count} queued ${count === 1 ? 'message' : 'messages'} now that a peer is here`,
        'info',
        this.#now(),
      );
    }

    this.#setNotice('ok', `sent ${flushed} queued ${flushed === 1 ? 'message' : 'messages'}`);
    this.#markDirty();
  }

  /** Client ids of peers currently in `room` (excluding the local user). */
  #membersInRoom(room: string): string[] {
    const transport = this.#transport;
    if (transport === null) {
      return [];
    }

    return transport
      .peerIds()
      .filter(clientId => clientId !== this.#clientId)
      .filter(clientId => this.#registry.getPeer(clientId)?.room === room);
  }

  /** Change the display name and tell peers about it immediately. */
  setUsername(input: string): ActionResult {
    const username = sanitizeUsername(input, MAX_USERNAME_LENGTH);
    if (username === null) {
      return this.#fail('username must be 1-20 chars: letters, numbers, . _ -');
    }

    this.#username = username;
    this.#usernameConfirmed = true;
    this.#registry.setSelfUsername(username);
    this.#saveUsername(username);

    // Re-announce our identity on every existing link.
    const transport = this.#transport;
    if (transport !== null) {
      const hello = createEnvelope('HELLO', this.#identity(), {
        room: this.#registry.selfRoom,
        data: {
          port: this.#tcpPort,
          addresses: localAddresses(this.#options.networkInterfaces?.() ?? os.networkInterfaces()),
        },
      });
      transport.sendMany(transport.peerIds(), hello);
    }

    this.#discovery?.announceNow();
    this.#setNotice('ok', `you are now ${username}`);
    this.#markDirty();
    this.#emit();
    return { ok: true };
  }

  /**
   * Connect to a peer by address. Also the escape hatch when the network blocks
   * UDP discovery entirely.
   */
  async manualConnect(host: string, port?: number): Promise<ActionResult> {
    if (!isValidHost(host)) {
      return this.#fail(`"${host}" is not a valid host`);
    }

    const targetPort = port ?? DEFAULT_TCP_PORT_BASE;
    if (!isValidPort(targetPort)) {
      return this.#fail(`"${String(port)}" is not a valid port`);
    }

    const transport = this.#transport;
    if (transport === null) {
      return this.#fail('client is not started');
    }

    this.#setNotice('info', `connecting to ${host}:${targetPort}…`);
    this.#emit();

    try {
      // Manual connects try v2 first; if the peer only speaks legacy v1 it
      // stays silent and the v2 dial times out — then we retry once in
      // plaintext when (and only when) the user allowed plaintext links.
      let peer: Awaited<ReturnType<typeof transport.connect>>;
      try {
        peer = await transport.connect(host, targetPort);
      } catch (v2Error) {
        const existing = transport
          .peers()
          .find(
            candidate =>
              candidate.port === targetPort &&
              (candidate.remoteAddress === host || candidate.addresses.includes(host)),
          );
        if (existing !== undefined) {
          this.#setNotice('ok', `already connected to ${existing.username}`);
          this.#emit();
          return { ok: true };
        }

        if (this.#options.allowPlaintext === true) {
          peer = await transport.connect(host, targetPort, { plaintext: true });
        } else {
          throw v2Error;
        }
      }
      this.#setNotice('ok', `connected to ${peer.username} (${host}:${targetPort})`);
      this.#emit();
      return { ok: true };
    } catch (error) {
      // We may already be talking to this peer (for example they dialled us
      // first). That is the outcome the user wanted, so report it as success.
      const existing = transport
        .peers()
        .find(
          peer =>
            peer.port === targetPort &&
            (peer.remoteAddress === host || peer.addresses.includes(host)),
        );

      if (existing !== undefined) {
        this.#setNotice('ok', `already connected to ${existing.username}`);
        this.#emit();
        return { ok: true };
      }

      return this.#fail((error as Error).message);
    }
  }

  /** Send a beacon immediately (used by `/rescan`). */
  rescan(): ActionResult {
    if (this.#discovery === null) {
      return this.#fail('LAN discovery is disabled');
    }

    this.#discovery.announceNow();
    this.#setNotice('info', 'announced ourselves on the LAN');
    this.#emit();
    return { ok: true };
  }

  /** Clear the local chat history for the current room. */
  clearHistory(): void {
    const room = this.#registry.selfRoom;
    if (room !== null) {
      this.#registry.clearHistory(room);
      // Wiping the view must wipe the disk copy too, or the next restart
      // would resurrect lines the user explicitly deleted.
      this.#historyStore?.clearRoom(room);
      this.#markDirty();
      this.#emit();
    }
  }

  /** Push a locally generated notice into the current room timeline. */
  systemMessage(text: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
    const room = this.#registry.selfRoom;
    if (room === null) {
      this.#setNotice(tone === 'info' ? 'info' : tone, text);
    } else {
      this.#registry.appendSystem(room, text, tone, this.#now());
    }

    this.#markDirty();
    this.#emit();
  }

  /** Send a reply to a message in the current room. */
  sendReply(targetId: string, text: string): ActionResult {
    return this.#sendReplyReaction('REPLY', targetId, text);
  }

  /** Send a reaction to a message in the current room. */
  sendReaction(targetId: string, reaction: string): ActionResult {
    return this.#sendReplyReaction('REACTION', targetId, reaction);
  }

  /**
   * Our own long-term identity: the fingerprint of the Ed25519 key in the
   * config file. Two peers can compare this out of band to be sure they are
   * talking to the same person across a hostile network.
   */
  identityFingerprint(): string {
    return identityKeyId(this.#config);
  }

  /** Fingerprint of a peer's identity key, or null when we have not seen one. */
  peerFingerprint(clientId: string): string | null {
    return this.#peerKeyIds.get(clientId) ?? null;
  }

  /**
   * Pin a peer's current key (`/trust <user>`).
   *
   * After a legitimate reinstall a peer presents a new key, which TOFU would
   * refuse as an impostor. Trusting re-pins the key they have now, so the link
   * works again — and a *third* key is still refused.
   */
  trust(clientId: string): ActionResult {
    const peer = this.#registry.getPeer(clientId);
    if (peer === undefined) {
      return this.#fail(`no peer with client id ${clientId}`);
    }

    const keyId = this.#peerKeyIds.get(clientId);
    if (keyId === undefined) {
      return this.#fail(`${peer.username} has not completed a handshake yet — no key to trust`);
    }

    this.#pinStore.trust(clientId, keyId, this.#now());
    this.#config = { ...this.#config, peerPins: this.#pinStore.toConfig() };
    this.#writeConfig();
    this.#markDirty();
    this.#emit();
    return { ok: true };
  }

  /**
   * Forget a peer's pin (`/untrust <user>`).
   *
   * The next contact is treated as first contact, so a rebuilt install gets in
   * — but at the cost of the protection against an impostor, which is why the
   * command exists rather than being automatic.
   */
  untrust(clientId: string): ActionResult {
    const peer = this.#registry.getPeer(clientId);
    if (peer === undefined) {
      return this.#fail(`no peer with client id ${clientId}`);
    }

    if (!this.#pinStore.untrust(clientId)) {
      return this.#fail(`${peer.username} had no pinned key`);
    }

    this.#config = { ...this.#config, peerPins: this.#pinStore.toConfig() };
    this.#writeConfig();
    this.#markDirty();
    this.#emit();
    return { ok: true };
  }

  /** Offer a local file to everyone in the current room. */
  offerFile(filePath: string): ActionResult {
    const room = this.#registry.selfRoom;
    if (room === null) {
      return this.#fail('join a room first (/join general)');
    }

    const trimmed = filePath.trim();
    if (trimmed.length === 0) {
      return this.#fail('usage: /file <file-path>');
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(trimmed);
    } catch {
      return this.#fail(`cannot read ${trimmed} (no such file)`);
    }

    if (!stats.isFile()) {
      return this.#fail(`${trimmed} is not a regular file`);
    }

    if (!isTransferableSize(stats.size) || stats.size === 0) {
      return this.#fail(
        `file is empty or larger than ${formatBytes(MAX_FILE_BYTES)}`,
      );
    }

    const name = sanitizeFileName(path.basename(trimmed));
    if (name === null) {
      return this.#fail('file name is not usable');
    }

    if (
      this.#outgoing.size + this.#incoming.size + this.#pendingIncoming.size >=
      MAX_ACTIVE_TRANSFERS
    ) {
      return this.#fail(`too many active transfers (max ${MAX_ACTIVE_TRANSFERS})`);
    }

    const transport = this.#transport;
    if (transport === null) {
      return this.#fail('client is not started');
    }

    const targets = transport
      .peerIds()
      .filter(clientId => clientId !== this.#clientId)
      .filter(clientId => this.#registry.getPeer(clientId)?.room === room);

    if (targets.length === 0) {
      return this.#fail('no peers are connected in this room yet — nobody can accept the offer');
    }

    const now = this.#now();
    const transfer: OutgoingTransfer = {
      id: newMessageId(),
      room,
      path: trimmed,
      name,
      size: stats.size,
      lastActivity: now,
      cancelled: false,
      peers: new Map(targets.map(clientId => [clientId, { phase: 'offered', sent: 0 }])),
    };
    this.#outgoing.set(transfer.id, transfer);

    const envelope = createEnvelope('FILE_OFFER', this.#identity(), {
      room,
      data: { transferId: transfer.id, name, size: stats.size },
      ts: now,
    });
    transport.sendMany(targets, envelope);

    this.#registry.appendSystem(
      room,
      `offering ${name} (${formatBytes(stats.size)}) to ${targets.length === 1 ? 'the room' : `${targets.length} peers`}`,
      'info',
      now,
    );
    this.#setNotice('info', `offering ${name} — waiting for someone to accept`);
    this.#markDirty();
    this.#emit();
    return { ok: true };
  }

  /**
   * Abort transfers. With no argument every active transfer is cancelled:
   * outgoing offers tell their peers (FILE_CANCEL) and stop streaming, incoming
   * partials are closed and deleted so nothing half-written survives.
   */
  cancelTransfer(transferId?: string): ActionResult {
    const wanted = transferId?.trim();
    let cancelled = 0;

    for (const [id, transfer] of [...this.#outgoing]) {
      if (wanted !== undefined && wanted.length > 0 && !id.startsWith(wanted)) {
        continue;
      }

      this.#outgoing.delete(id);
      transfer.cancelled = true;

      const transport = this.#transport;
      if (transport !== null) {
        for (const peerId of transfer.peers.keys()) {
          if (transport.hasPeer(peerId)) {
            transport.sendTo(
              peerId,
              createEnvelope('FILE_CANCEL', this.#identity(), {
                room: transfer.room,
                data: { transferId: transfer.id },
                ts: this.#now(),
              }),
            );
          }
        }
      }

      this.#registry.appendSystem(
        transfer.room,
        `cancelled sending ${transfer.name}`,
        'warn',
        this.#now(),
      );
      cancelled += 1;
    }

    for (const [id, transfer] of [...this.#incoming]) {
      if (wanted !== undefined && wanted.length > 0 && !id.startsWith(wanted)) {
        continue;
      }

      this.#incoming.delete(id);
      this.#discardIncoming(transfer);
      // Tell the sender to stop: a cancelled download must never count as
      // received, and the sender must retire its offer instead of streaming
      // chunks into the void until the whole file is pushed.
      this.#sendTransferControl('FILE_CANCEL', transfer.from, transfer.id, transfer.room);
      cancelled += 1;
    }

    if (cancelled === 0) {
      return this.#fail(
        wanted !== undefined && wanted.length > 0
          ? `no transfer matching "${wanted}"`
          : 'no active transfers',
      );
    }

    this.#markDirty();
    this.#emit();
    return { ok: true };
  }

  #sendReplyReaction(
    type: 'REPLY' | 'REACTION',
    targetId: string,
    payload: string,
  ): ActionResult {
    const room = this.#registry.selfRoom;
    if (room === null) {
      return this.#fail('join a room first (/join general)');
    }

    const envelope = createEnvelope(type, this.#identity(), {
      room,
      data:
        type === 'REPLY'
          ? { text: payload, replyTo: targetId }
          : { target: targetId, reaction: payload },
      ts: this.#now(),
    });

    this.#registry.markSeen(envelope.id, this.#now());

    this.#registry.recordMessage({
      id: envelope.id,
      room,
      kind: 'chat',
      text: type === 'REPLY' ? payload : '',
      replyTo: type === 'REPLY' ? targetId : undefined,
      reaction: type === 'REACTION' ? payload : undefined,
      from: this.#clientId,
      username: this.#username,
      ts: envelope.ts,
      self: true,
    });

    const delivered = this.#sendToRoom(room, envelope);
    if (delivered === 0) {
      this.#setNotice('warn', 'no peers are connected yet — your reaction is only local for now');
    } else if (this.#notice?.tone === 'warn') {
      this.#notice = null;
    }

    this.#markDirty();
    this.#emit();
    return { ok: true };
  }

  /** Footer notice (transient status message). */
  setNotice(tone: NoticeSnapshot['tone'], text: string): void {
    this.#setNotice(tone, text);
    this.#emit();
  }

  /** Drop the footer notice. */
  dismissNotice(): void {
    if (this.#notice !== null) {
      this.#notice = null;
      this.#markDirty();
      this.#emit();
    }
  }

  /** Rooms we advertise in our beacons (so empty rooms stay discoverable). */
  get advertisedRooms(): string[] {
    return [...this.#advertisedRooms];
  }

  // ------------------------------------------------------------------ internal

  #identity(): { clientId: string; username: string } {
    return { clientId: this.#clientId, username: this.#username };
  }

  #normaliseRoom(input: string | null | undefined): string | null {
    if (typeof input !== 'string' || input.trim().length === 0) {
      return null;
    }

    return sanitizeRoomName(input, MAX_ROOM_NAME_LENGTH);
  }

  #onAnnounce(peer: PeerContact & { rooms: string[]; wireVersion: number }, address: string): void {
    if (peer.clientId === this.#clientId) {
      return;
    }

    const now = this.#now();
    const { peer: record, added, previousRoom } = this.#registry.upsertPeer(
      { ...peer, addresses: [address, ...peer.addresses] },
      'lan',
      now,
      { wireVersion: peer.wireVersion },
    );

    for (const room of peer.rooms) {
      this.#registry.noteRoom(room, now);
    }

    if (added) {
      this.#log(`discovered ${record.username} at ${address}:${peer.port}`, 'info');
    }

    this.#applyPresence(previousRoom, record.room, record);
    this.#maybeConnect(record, now);
    this.#markDirty();
  }

  #onPeerReady(peer: PeerHandle): void {
    const now = this.#now();
    const { peer: record, previousRoom } = this.#registry.upsertPeer(
      {
        clientId: peer.clientId,
        username: peer.username,
        room: peer.room,
        port: peer.port,
        addresses: peer.addresses,
      },
      'tcp',
      now,
      // The link itself is the ground truth: a plaintext link makes the peer
      // legacy regardless of what its beacon claimed.
      { wireVersion: peer.encrypted ? PROTOCOL_VERSION : LEGACY_WIRE_VERSION },
    );

    this.#registry.setPeerConnection(peer.clientId, true, now);
    if (peer.remoteAddress.length > 0) {
      // The address traffic actually arrived on is the best guess for dialling back.
      this.#registry.notePeerAddress(peer.clientId, peer.remoteAddress, now);
    }

    this.#applyPresence(previousRoom, peer.room, record);
    this.#attempts.delete(peer.clientId);
    this.#reconnecting.delete(peer.clientId);

    // Introduce ourselves properly: our rooms and everyone we know.
    this.#sendRoomList(peer.clientId);
    this.#sendPeerList(peer.clientId);
    this.#peerListDirty = true;

    if (!peer.encrypted) {
      this.#log(
        `linked to ${record.username} WITHOUT encryption (legacy v1 peer) — chat content travels in clear text`,
        'warn',
      );
    }

    this.#log(`connected to ${record.username} (${peer.remoteAddress})`, 'info');
    this.#markDirty();
    this.#emit();
  }

  #onPeerGone(peer: PeerHandle, reason: PeerGoneReason): void {
    if (this.#stopping || !this.#started) {
      return;
    }

    const now = this.#now();
    this.#registry.setPeerConnection(peer.clientId, false, now);
    this.#peerListDirty = true;

    // In-flight transfers with this peer can never finish: abort both sides so
    // partial files do not linger until the idle sweep reaps them.
    let changed = false;
    for (const transfer of this.#outgoing.values()) {
      const entry = transfer.peers.get(peer.clientId);
      if (entry === undefined || entry.phase === 'done') {
        continue;
      }

      entry.phase = 'cancelled';
      this.#maybeRetireOutgoing(transfer);
    }

    for (const [id, transfer] of [...this.#incoming]) {
      if (transfer.from !== peer.clientId) {
        continue;
      }

      this.#incoming.delete(id);
      this.#discardIncoming(transfer);
      this.#registry.appendSystem(
        transfer.room,
        `${peer.username} disconnected — ${transfer.name} transfer aborted`,
        'warn',
        now,
      );
      changed = true;
    }

    if (changed) {
      this.#markDirty();
    }

    if (reason !== 'shutdown' && !this.#reconnecting.has(peer.clientId)) {
      this.#reconnecting.add(peer.clientId);
      this.#setNotice('warn', `connection to ${peer.username} lost — reconnecting…`);
    }

    this.#log(`connection to ${peer.username} closed (${reason})`, 'info');
    this.#markDirty();
    this.#emit();
  }

  #onEnvelope(envelope: Envelope, peer: PeerHandle): void {
    if (this.#stopping || envelope.from !== peer.clientId) {
      return;
    }

    const now = this.#now();
    this.#registry.touchPeer(envelope.from, now);

    switch (envelope.type) {
      case 'HELLO': {
        const hello = readHelloData(envelope);
        if (hello === null) {
          return;
        }

        const previousRoom = this.#registry.getPeer(envelope.from)?.room ?? null;
        const { peer: record } = this.#registry.upsertPeer(
          {
            clientId: envelope.from,
            username: envelope.username,
            room: envelope.room,
            port: hello.port,
            addresses: hello.addresses,
          },
          'tcp',
          now,
        );
        this.#registry.setPeerConnection(envelope.from, true, now);
        this.#applyPresence(previousRoom, record.room, record);
        break;
      }

      case 'ROOM_LIST': {
        const data = readRoomListData(envelope);
        if (data === null) {
          return;
        }

        for (const room of data.rooms) {
          this.#registry.noteRoom(room.name, now);
        }

        break;
      }

      case 'PEER_LIST': {
        const data = readPeerListData(envelope);
        if (data === null) {
          return;
        }

        for (const contact of data.peers) {
          if (contact.clientId === this.#clientId) {
            continue;
          }

          const { peer: record, previousRoom } = this.#registry.upsertPeer(contact, 'tcp', now);
          this.#applyPresence(previousRoom, record.room, record);
          this.#maybeConnect(record, now);
        }

        this.#peerListDirty = true;
        break;
      }

      case 'JOIN':
      case 'LEAVE': {
        const room = envelope.type === 'JOIN' ? envelope.room : null;
        const existing = this.#registry.getPeer(envelope.from);
        if (existing === undefined) {
          const { peer: record, previousRoom } = this.#registry.upsertPeer(
            {
              clientId: envelope.from,
              username: envelope.username,
              room,
              port: peer.port,
              addresses: peer.addresses,
            },
            'tcp',
            now,
          );
          this.#applyPresence(previousRoom, record.room, record);
        } else {
          const previousRoom = this.#registry.setPeerRoom(envelope.from, room, now);
          this.#applyPresence(previousRoom ?? null, room, existing);
        }

        this.#peerListDirty = true;
        break;
      }

      case 'MESSAGE': {
        const data = readMessageData(envelope);
        if (data === null || envelope.room === null) {
          return;
        }

        // Flood guard: a hostile peer spraying messages gets dropped on the
        // floor once its bucket is empty (normal chat never comes close).
        if (!this.#messageLimiter.allow(envelope.from)) {
          return;
        }

        if (!this.#registry.markSeen(envelope.id, now)) {
          // Already delivered (relayed by another peer): drop silently.
          return;
        }

        this.#registry.noteRoom(envelope.room, now);
        const myRoom = this.#registry.selfRoom;
        if (envelope.room === myRoom) {
          this.#registry.recordMessage({
            id: envelope.id,
            room: envelope.room,
            kind: 'chat',
            // /me actions arrive framed (0x01 ACTION ... 0x01); render them.
            text: isActionMessage(data.text)
              ? renderAction(envelope.username, data.text)
              : data.text,
            from: envelope.from,
            username: envelope.username,
            ts: envelope.ts,
            self: false,
          });
          this.#markDirty();
          this.#emit();
        }

        // Relay to room members we are directly connected to, except the sender.
        // That keeps a message flowing when a direct link between two peers is
        // missing, and only ever within the room we are actually in.
        if (myRoom !== null && envelope.room === myRoom) {
          this.#sendToRoom(myRoom, envelope, envelope.from);
        }

        break;
      }

      case 'REPLY':
      case 'REACTION': {
        if (envelope.room === null) {
          break;
        }

        // Same flood guard and dedup as ordinary messages, so a hostile peer
        // cannot bypass the limiter by using a reply instead of a message.
        if (!this.#messageLimiter.allow(envelope.from)) {
          break;
        }

        if (!this.#registry.markSeen(envelope.id, now)) {
          break;
        }

        this.#registry.noteRoom(envelope.room, now);
        const myRoom = this.#registry.selfRoom;
        if (envelope.room === myRoom) {
          if (envelope.type === 'REPLY') {
            const data = readReplyData(envelope);
            if (data === null) {
              break;
            }

            this.#registry.recordMessage({
              id: envelope.id,
              room: envelope.room,
              kind: 'chat',
              text: data.text,
              replyTo: data.replyTo,
              from: envelope.from,
              username: envelope.username,
              ts: envelope.ts,
              self: false,
            });
          } else {
            const data = readReactionData(envelope);
            if (data === null) {
              break;
            }

            this.#registry.recordMessage({
              id: envelope.id,
              room: envelope.room,
              kind: 'chat',
              text: '',
              reaction: data.reaction,
              replyTo: data.target,
              from: envelope.from,
              username: envelope.username,
              ts: envelope.ts,
              self: false,
            });
          }

          this.#markDirty();
          this.#emit();
        }

        // Relay to direct room members except the sender, like MESSAGE.
        if (myRoom !== null && envelope.room === myRoom) {
          this.#sendToRoom(myRoom, envelope, envelope.from);
        }

        break;
      }

      case 'FILE_OFFER': {
        const data = readFileOfferData(envelope);
        if (data === null || envelope.room === null) {
          break;
        }

        // Offers follow the same flood/dedup rules as chat: a hostile peer
        // must not be able to open hundreds of half-written files on disk.
        if (!this.#messageLimiter.allow(envelope.from)) {
          break;
        }

        if (!this.#registry.markSeen(envelope.id, now)) {
          break;
        }

        this.#registry.noteRoom(envelope.room, now);
        if (envelope.room !== this.#registry.selfRoom) {
          break;
        }

        void this.#acceptOffer(envelope, data.transferId, data.name, data.size);
        break;
      }

      case 'FILE_ACCEPT': {
        const parsed = readTransferIdData(envelope);
        if (parsed === null) {
          break;
        }

        const transfer = this.#outgoing.get(parsed.transferId);
        if (transfer === undefined || transfer.cancelled) {
          // We are no longer offering it (cancelled/expired): tell the peer to
          // stop waiting for chunks.
          this.#sendTransferControl('FILE_CANCEL', envelope.from, parsed.transferId, transfer?.room ?? envelope.room);
          break;
        }

        const entry = transfer.peers.get(envelope.from);
        if (entry === undefined || entry.phase !== 'offered') {
          break;
        }

        entry.phase = 'sending';
        transfer.lastActivity = this.#now();
        void this.#streamToPeer(transfer, envelope.from);
        break;
      }

      case 'FILE_REJECT': {
        const parsed = readTransferIdData(envelope);
        if (parsed === null) {
          break;
        }

        const transfer = this.#outgoing.get(parsed.transferId);
        const entry = transfer?.peers.get(envelope.from);
        if (transfer !== undefined && entry !== undefined && entry.phase === 'offered') {
          entry.phase = 'rejected';
          this.#maybeRetireOutgoing(transfer);
        }
        break;
      }

      case 'FILE_CHUNK': {
        const chunk = readFileChunkData(envelope);
        if (chunk === null) {
          break;
        }

        const transfer = this.#incoming.get(chunk.transferId);
        // Chunks only ever come from the peer whose offer we accepted, only in
        // order, and only up to the advertised size — anything else is dropped.
        if (transfer === undefined || transfer.from !== envelope.from) {
          break;
        }

        if (chunk.index !== transfer.nextIndex) {
          break;
        }

        const bytes = Buffer.from(chunk.data, 'base64');
        if (bytes.length === 0 || bytes.length > FILE_CHUNK_BYTES) {
          break;
        }

        if (transfer.received + bytes.length > transfer.size) {
          // Sender overshot its own advertised size: abort, delete the partial.
          this.#incoming.delete(chunk.transferId);
          this.#sendTransferControl('FILE_CANCEL', transfer.from, transfer.id, transfer.room);
          this.#discardIncoming(transfer);
          this.#registry.appendSystem(
            transfer.room,
            `${transfer.fromUsername} sent more data than promised for ${transfer.name} — discarded`,
            'error',
            this.#now(),
          );
          this.#markDirty();
          this.#emit();
          break;
        }

        transfer.nextIndex += 1;
        transfer.received += bytes.length;
        transfer.lastActivity = this.#now();
        this.#queueChunkWrite(transfer, bytes);
        break;
      }

      case 'FILE_COMPLETE': {
        const parsed = readTransferIdData(envelope);
        if (parsed === null) {
          break;
        }

        const transfer = this.#incoming.get(parsed.transferId);
        if (transfer === undefined || transfer.from !== envelope.from) {
          break;
        }

        this.#incoming.delete(parsed.transferId);
        const { target, name, fromUsername, room, size } = transfer;

        // Drain queued writes, then confirm the size actually matches what the
        // sender advertised before we announce success.
        transfer.pending
          .then(() => transfer.handle.close())
          .then(() => {
            const written = fs.statSync(target).size;
            if (written !== size) {
              fs.rmSync(target, { force: true });
              this.#registry.appendSystem(
                room,
                `received ${name} from ${fromUsername} was incomplete (${written} of ${size} bytes) — discarded`,
                'error',
                this.#now(),
              );
            } else {
              this.#registry.appendSystem(
                room,
                `received ${name} (${formatBytes(size)}) from ${fromUsername} → ${target}`,
                'info',
                this.#now(),
              );
            }

            this.#markDirty();
            this.#emit();
          })
          .catch(error => {
            this.#log(`incoming transfer failed: ${(error as Error).message}`, 'warn');
          });
        break;
      }

      case 'FILE_CANCEL': {
        const parsed = readTransferIdData(envelope);
        if (parsed === null) {
          break;
        }

        const outgoing = this.#outgoing.get(parsed.transferId);
        if (outgoing !== undefined) {
          const entry = outgoing.peers.get(envelope.from);
          if (entry !== undefined && entry.phase === 'sending') {
            entry.phase = 'cancelled';
            outgoing.cancelled = outgoing.cancelled || this.#allPeersSettled(outgoing);
            this.#maybeRetireOutgoing(outgoing);
          }
          break;
        }

        const incoming = this.#incoming.get(parsed.transferId);
        if (incoming !== undefined && incoming.from === envelope.from) {
          this.#incoming.delete(parsed.transferId);
          this.#discardIncoming(incoming);
          this.#registry.appendSystem(
            incoming.room,
            `${incoming.fromUsername} cancelled the transfer of ${incoming.name}`,
            'warn',
            this.#now(),
          );
          this.#markDirty();
          this.#emit();
        }
        break;
      }

      default:
        break;
    }

    this.#markDirty();
  }

  /**
   * Emit join/leave notices for the room we are currently in. Called with the
   * peer's previous and new room so we only narrate relevant transitions.
   */
  #applyPresence(previousRoom: string | null, newRoom: string | null, peer: PeerRecord): void {
    const myRoom = this.#registry.selfRoom;
    if (myRoom === null) {
      return;
    }

    if (newRoom !== null) {
      this.#registry.noteRoom(newRoom, this.#now());
    }

    if (previousRoom === myRoom && newRoom !== myRoom) {
      this.#registry.appendSystem(
        myRoom,
        `${peer.username} left #${myRoom}`,
        'info',
        this.#now(),
      );
      this.#markDirty();
      return;
    }

    if (newRoom === myRoom && previousRoom !== myRoom) {
      this.#registry.appendSystem(
        myRoom,
        `${peer.username} joined #${myRoom}`,
        'info',
        this.#now(),
      );
      this.#markDirty();
    }
  }

  #maybeConnect(peer: PeerRecord, now: number): void {
    if (this.#stopping || this.#transport === null || this.#options.discovery === false) {
      return;
    }

    if (peer.clientId === this.#clientId || this.#transport.hasPeer(peer.clientId)) {
      return;
    }

    if (!this.#shouldInitiate(peer.clientId) || peer.addresses.length === 0 || peer.port === 0) {
      return;
    }

    const attempt = this.#attempts.get(peer.clientId) ?? { count: 0, nextAt: 0 };
    if (now < attempt.nextAt) {
      return;
    }

    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt.count);
    this.#attempts.set(peer.clientId, { count: attempt.count + 1, nextAt: now + backoff });

    const address = peer.addresses[0];
    if (address === undefined) {
      return;
    }

    // A peer advertising v1 only is legacy (e.g. a zapchat ≤ 5 Python
    // client). Without --allow-plaintext there is nothing to dial: a v2
    // handshake against a v1 peer just times out in silence. Say so once,
    // then leave the peer alone until it announces v2 (e.g. after an
    // upgrade) or the user opts in.
    const legacy = peer.wireVersion === LEGACY_WIRE_VERSION;
    if (legacy && this.#options.allowPlaintext !== true) {
      if (!this.#legacyWarned.has(peer.clientId)) {
        this.#legacyWarned.add(peer.clientId);
        this.#log(
          `${peer.username} runs an older client without encryption (protocol v1); ` +
            'not linking — start with --allow-plaintext to allow unencrypted links, or ask them to upgrade to zapchat 6+',
          'warn',
        );
      }

      return;
    }

    if (legacy && !this.#legacyWarned.has(peer.clientId)) {
      this.#legacyWarned.add(peer.clientId);
      this.#log(
        `${peer.username} speaks the legacy protocol; connecting without encryption (plaintext)`,
        'warn',
      );
    }

    void this.#transport
      .connect(address, peer.port, legacy && this.#options.allowPlaintext === true ? { plaintext: true } : {})
      .then(connected => {
        this.#attempts.delete(connected.clientId);
      })
      .catch(error => {
        this.#log(`connect to ${peer.username} (${address}:${peer.port}) failed: ${error.message}`, 'info');
      });
  }

  /**
   * Deterministic tie-break so two peers never keep two links between them:
   * the client with the smaller id dials.
   */
  #shouldInitiate(remoteClientId: string): boolean {
    return this.#clientId < remoteClientId;
  }

  #sweep(): void {
    if (this.#stopping) {
      return;
    }

    const now = this.#now();

    // Notices are transient: the footer goes back to showing hints on its own.
    if (this.#notice !== null && now - this.#notice.ts > NOTICE_TTL_MS) {
      this.#notice = null;
      this.#markDirty();
    }

    for (const stale of this.#registry.removeStale(now)) {
      this.#attempts.delete(stale.clientId);
      this.#reconnecting.delete(stale.clientId);
      this.#applyPresence(stale.room, null, stale);
      this.#log(`${stale.username} went offline`, 'info');
      this.#markDirty();
    }

    for (const peer of this.#registry.online(now)) {
      this.#maybeConnect(peer, now);
    }

    if (this.#peerListDirty) {
      this.#broadcastPeerList();
      this.#peerListDirty = false;
    }

    this.#sweepTransfers(now);
    this.#flushOfflineQueue();

    if (this.#dirty) {
      this.#emit();
    }
  }

  /**
   * Expire transfers nobody is feeding any more: incoming partials are deleted
   * from disk, outgoing offers are cancelled to their peers. A transfer that
   * keeps moving updates `lastActivity` on every chunk, so only genuinely
   * stalled transfers are reaped.
   */
  #sweepTransfers(now: number): void {
    let changed = false;

    for (const [id, transfer] of [...this.#incoming]) {
      if (now - transfer.lastActivity <= TRANSFER_IDLE_TIMEOUT_MS) {
        continue;
      }

      this.#incoming.delete(id);
      this.#discardIncoming(transfer);
      this.#sendTransferControl('FILE_CANCEL', transfer.from, transfer.id, transfer.room);
      this.#registry.appendSystem(
        transfer.room,
        `transfer of ${transfer.name} from ${transfer.fromUsername} timed out — partial file deleted`,
        'warn',
        now,
      );
      changed = true;
    }

    for (const [id, transfer] of [...this.#outgoing]) {
      if (now - transfer.lastActivity <= TRANSFER_IDLE_TIMEOUT_MS) {
        continue;
      }

      this.#outgoing.delete(id);
      transfer.cancelled = true;
      const transport = this.#transport;
      if (transport !== null) {
        for (const peerId of transfer.peers.keys()) {
          this.#sendTransferControl('FILE_CANCEL', peerId, transfer.id, transfer.room);
        }
      }

      this.#registry.appendSystem(
        transfer.room,
        `offer of ${transfer.name} expired (no peer response)`,
        'warn',
        now,
      );
      changed = true;
    }

    if (changed) {
      this.#markDirty();
    }
  }

  #sendToRoom(room: string, envelope: Envelope, excludeClientId?: string): number {
    const transport = this.#transport;
    if (transport === null) {
      return 0;
    }

    const targets = transport
      .peerIds()
      .filter(clientId => clientId !== excludeClientId && clientId !== this.#clientId)
      .filter(clientId => this.#registry.getPeer(clientId)?.room === room);

    return transport.sendMany(targets, envelope);
  }

  #broadcastPresence(type: 'JOIN' | 'LEAVE'): void {
    const transport = this.#transport;
    if (transport === null) {
      return;
    }

    const envelope = createEnvelope(type, this.#identity(), {
      room: this.#registry.selfRoom,
      ts: this.#now(),
    });

    transport.sendMany(transport.peerIds(), envelope);
  }

  #sendRoomList(clientId: string): void {
    const transport = this.#transport;
    if (transport === null) {
      return;
    }

    const rooms = this.#registry.rooms(this.#now()).map(room => ({
      name: room.name,
      online: room.online,
    }));

    transport.sendTo(
      clientId,
      createEnvelope('ROOM_LIST', this.#identity(), { data: { rooms }, ts: this.#now() }),
    );
  }

  #sendPeerList(clientId: string): void {
    const transport = this.#transport;
    if (transport === null) {
      return;
    }

    const peers = this.#registry
      .online(this.#now())
      .map(record => ({
        clientId: record.clientId,
        username: record.username,
        room: record.room,
        port: record.port,
        addresses: record.addresses,
      }));

    transport.sendTo(
      clientId,
      createEnvelope('PEER_LIST', this.#identity(), { data: { peers }, ts: this.#now() }),
    );
  }

  #broadcastPeerList(): void {
    const transport = this.#transport;
    if (transport === null) {
      return;
    }

    for (const clientId of transport.peerIds()) {
      this.#sendPeerList(clientId);
    }
  }

  // --------------------------------------------------------------- transfers

  /** Unicast a FILE_ACCEPT/REJECT/COMPLETE/CANCEL control frame to one peer. */
  #sendTransferControl(
    type: 'FILE_ACCEPT' | 'FILE_REJECT' | 'FILE_COMPLETE' | 'FILE_CANCEL',
    toClientId: string,
    transferId: string,
    room: string | null,
  ): void {
    const transport = this.#transport;
    if (transport === null || !transport.hasPeer(toClientId)) {
      return;
    }

    transport.sendTo(
      toClientId,
      createEnvelope(type, this.#identity(), {
        room,
        data: { transferId },
        ts: this.#now(),
      }),
    );
  }

  /**
   * A peer offered us a file in our room. Auto-accept within the hard limits
   * (size cap, slot cap, sanitised name in the OS temp dir) unless the offer is
   * stale or we are already receiving this exact transfer.
   */
  async #acceptOffer(
    envelope: Envelope,
    transferId: string,
    name: string,
    size: number,
  ): Promise<void> {
    const room = envelope.room;
    if (room === null) {
      return;
    }

    if (
      this.#incoming.has(transferId) ||
      this.#pendingIncoming.has(transferId) ||
      this.#outgoing.size + this.#incoming.size + this.#pendingIncoming.size >=
        MAX_ACTIVE_TRANSFERS
    ) {
      this.#sendTransferControl('FILE_REJECT', envelope.from, transferId, room);
      return;
    }

    this.#pendingIncoming.add(transferId);
    try {
      const dir = receivedFilesDir();
      await fsp.mkdir(dir, { recursive: true });

      const target = receivedFilePath(dir, transferId, name);
      if (target === null) {
        this.#sendTransferControl('FILE_REJECT', envelope.from, transferId, room);
        return;
      }

      // "w" creates-or-truncates; the unique `<transferId>-` prefix means we
      // never clobber an earlier download of the same name.
      const handle = await fsp.open(target, 'w');
      const transfer: IncomingTransfer = {
        id: transferId,
        from: envelope.from,
        fromUsername: envelope.username,
        room,
        name,
        size,
        target,
        received: 0,
        nextIndex: 0,
        lastActivity: this.#now(),
        handle,
        pending: Promise.resolve(),
      };
      this.#incoming.set(transferId, transfer);
      this.#sendTransferControl('FILE_ACCEPT', envelope.from, transferId, room);

      this.#registry.appendSystem(
        room,
        `${envelope.username} offers ${name} (${formatBytes(size)}) — receiving…`,
        'info',
        this.#now(),
      );
      this.#setNotice('info', `receiving ${name} from ${envelope.username}…`);
      this.#markDirty();
      this.#emit();
    } catch (error) {
      this.#log(`could not open incoming transfer: ${(error as Error).message}`, 'warn');
      this.#sendTransferControl('FILE_REJECT', envelope.from, transferId, room);
    } finally {
      this.#pendingIncoming.delete(transferId);
    }
  }

  /**
   * Append one decoded chunk to the open file. Writes are chained on
   * `transfer.pending` so they hit the disk in wire order even though each
   * `FileHandle.write` is asynchronous; a failed write aborts the transfer.
   */
  #queueChunkWrite(transfer: IncomingTransfer, bytes: Buffer): void {
    transfer.pending = transfer.pending
      .then(() => transfer.handle.write(bytes))
      .then(() => {
        // Progress: rebuild the snapshot at most every TRANSFER_EMIT_MS.
        const now = this.#now();
        if (now - this.#lastTransferEmit >= TRANSFER_EMIT_MS) {
          this.#lastTransferEmit = now;
          this.#markDirty();
          this.#emit();
        }
      })
      .catch(error => {
        this.#log(`incoming transfer write failed: ${(error as Error).message}`, 'warn');
        if (this.#incoming.delete(transfer.id)) {
          this.#sendTransferControl('FILE_CANCEL', transfer.from, transfer.id, transfer.room);
          this.#discardIncoming(transfer);
          this.#registry.appendSystem(
            transfer.room,
            `could not write ${transfer.name} to disk — transfer cancelled`,
            'error',
            this.#now(),
          );
          this.#markDirty();
          this.#emit();
        }
      });
  }

  /** Close and delete a partial download. Tolerant: never throws. */
  #discardIncoming(transfer: IncomingTransfer): void {
    void transfer.pending
      .catch(() => undefined)
      .then(() => transfer.handle.close())
      .catch(() => undefined)
      .then(() => fsp.rm(transfer.target, { force: true }))
      .catch(() => undefined);
  }

  /**
   * Stream one offered file to one accepting peer, chunk by chunk.
   *
   * Pacing matters: the transport destroys peers whose socket write buffer
   * passes MAX_PENDING_WRITE_BYTES, so we wait for the kernel to catch up
   * instead of racing into that threshold. Any of — local cancel, shutdown,
   * peer disconnect, write refusal — stops the stream cleanly.
   */
  async #streamToPeer(transfer: OutgoingTransfer, peerId: string): Promise<void> {
    const transport = this.#transport;
    const entry = transfer.peers.get(peerId);
    if (transport === null || entry === undefined) {
      return;
    }

    let handle: fsp.FileHandle | null = null;
    let completed = false;
    try {
      handle = await fsp.open(transfer.path, 'r');
      const buffer = Buffer.alloc(FILE_CHUNK_BYTES);
      let index = 0;

      while (true) {
        if (transfer.cancelled || this.#stopping || !transport.hasPeer(peerId)) {
          break;
        }

        // Backpressure: let the socket drain before loading it up again.
        while (transport.pendingBytes(peerId) > TRANSFER_PACE_BYTES) {
          if (transfer.cancelled || this.#stopping || !transport.hasPeer(peerId)) {
            break;
          }

          await new Promise(resolve => setTimeout(resolve, 10));
        }

        if (transfer.cancelled || this.#stopping || !transport.hasPeer(peerId)) {
          break;
        }

        const { bytesRead } = await handle.read(buffer, 0, FILE_CHUNK_BYTES, null);
        if (bytesRead === 0) {
          completed = true;
          break;
        }

        const sent = transport.sendTo(
          peerId,
          createEnvelope('FILE_CHUNK', this.#identity(), {
            room: transfer.room,
            data: {
              transferId: transfer.id,
              index,
              data: buffer.subarray(0, bytesRead).toString('base64'),
            },
            ts: this.#now(),
          }),
        );

        if (!sent) {
          break;
        }

        index += 1;
        entry.sent += bytesRead;
        transfer.lastActivity = this.#now();

        const now = this.#now();
        if (now - this.#lastTransferEmit >= TRANSFER_EMIT_MS) {
          this.#lastTransferEmit = now;
          this.#markDirty();
          this.#emit();
        }
      }

      if (completed && !transfer.cancelled && !this.#stopping && transport.hasPeer(peerId)) {
        this.#sendTransferControl('FILE_COMPLETE', peerId, transfer.id, transfer.room);
        entry.phase = 'done';
      } else {
        entry.phase = 'cancelled';
        if (transport.hasPeer(peerId)) {
          this.#sendTransferControl('FILE_CANCEL', peerId, transfer.id, transfer.room);
        }
      }
    } catch (error) {
      entry.phase = 'cancelled';
      this.#log(`outgoing transfer failed: ${(error as Error).message}`, 'warn');
      if (transport.hasPeer(peerId)) {
        this.#sendTransferControl('FILE_CANCEL', peerId, transfer.id, transfer.room);
      }
    } finally {
      if (handle !== null) {
        await handle.close().catch(() => undefined);
      }
    }

    this.#maybeRetireOutgoing(transfer);
  }

  /** True when no peer is still 'offered' or 'sending' on this offer. */
  #allPeersSettled(transfer: OutgoingTransfer): boolean {
    for (const peer of transfer.peers.values()) {
      if (peer.phase === 'offered' || peer.phase === 'sending') {
        return false;
      }
    }

    return true;
  }

  /** Drop a fully settled offer and tell the user how it went. */
  #maybeRetireOutgoing(transfer: OutgoingTransfer): void {
    if (!this.#allPeersSettled(transfer) || !this.#outgoing.has(transfer.id)) {
      return;
    }

    this.#outgoing.delete(transfer.id);

    const accepted = [...transfer.peers.values()]
      .filter(peer => peer.phase === 'done')
      .length;
    const total = transfer.peers.size;

    if (accepted === 0) {
      this.#registry.appendSystem(
        transfer.room,
        `nobody accepted ${transfer.name}`,
        'warn',
        this.#now(),
      );
    } else {
      this.#registry.appendSystem(
        transfer.room,
        `sent ${transfer.name} (${formatBytes(transfer.size)}) to ${accepted} of ${total} ${accepted === 1 ? 'peer' : 'peers'}`,
        'info',
        this.#now(),
      );
    }

    this.#markDirty();
    this.#emit();
  }

  #fail(error: string): ActionResult {
    this.#setNotice('error', error);
    this.#markDirty();
    this.#emit();
    return { ok: false, error };
  }

  #setNotice(tone: NoticeSnapshot['tone'], text: string): void {
    this.#notice = { tone, text, ts: this.#now() };
  }

  #addWarning(message: string): void {
    this.#warnings = [...this.#warnings, message].slice(-5);
    this.#log(message, 'warn');
    this.#markDirty();
  }

  #markDirty(): void {
    this.#dirty = true;
  }

  #saveUsername(username: string): void {
    this.#config = { ...this.#config, username, updatedAt: this.#now() };
    this.#writeConfig();
  }

  #saveLastRoom(room: string): void {
    this.#config = { ...this.#config, lastRoom: room, updatedAt: this.#now() };
    this.#writeConfig();
  }

  #persistConfig(): void {
    this.#config = {
      ...this.#config,
      username: this.#usernameConfirmed ? this.#username : this.#config.username,
      lastRoom: this.#registry.selfRoom ?? this.#config.lastRoom,
      updatedAt: this.#now(),
    };
    this.#writeConfig();
  }

  #writeConfig(): void {
    try {
      saveConfigTo(this.#config, this.#configPath);
    } catch (error) {
      this.#addWarning(`could not save config (${(error as Error).message})`);
    }
  }

  #statusFromDiscovery(): DiscoveryState {
    return (
      this.#discovery?.state ?? {
        kind: 'unavailable' as DiscoveryKind,
        listening: false,
        multicast: false,
        broadcast: false,
        port: this.#options.discoveryPort ?? DEFAULT_DISCOVERY_PORT,
        detail: 'LAN discovery is disabled (--no-discovery)',
        beaconsSent: 0,
        beaconsReceived: 0,
        sendFailures: 0,
        dropped: 0,
      }
    );
  }

  #buildSnapshot(): Snapshot {
    const now = this.#now();
    const discovery = this.#statusFromDiscovery();
    const peers = this.#registry.peers(now);
    const room = this.#registry.selfRoom;

    return {
      revision: this.#revision,
      me: {
        clientId: this.#clientId,
        username: this.#username,
        usernameConfirmed: this.#usernameConfirmed,
      },
      room,
      rooms: this.#registry.rooms(now),
      peers: peers.map(record => this.#toPeerSnapshot(record, now)),
      members:
        room === null
          ? []
          : this.#registry
              .membersIn(room, now)
              .map(record => this.#toPeerSnapshot(record, now)),
      messages: room === null ? [] : this.#registry.history(room),
      notice: this.#notice,
      transfers: this.#transferSnapshots(),
      queued: this.#queuedSnapshots(),
      status: {
        discovery: discovery.kind,
        discoveryDetail: discovery.detail,
        multicast: discovery.multicast,
        broadcast: discovery.broadcast,
        discoveryPort: discovery.port,
        tcpPort: this.#tcpPort,
        peersOnline: this.#registry.online(now).length,
        peersConnected: peers.filter(record => record.connected).length,
        beaconsSent: discovery.beaconsSent,
        beaconsReceived: discovery.beaconsReceived,
        droppedFrames: discovery.dropped + (this.#transport?.droppedFrames ?? 0),
        lan: describeNetwork(this.#options.networkInterfaces?.() ?? os.networkInterfaces()),
        warnings: [...this.#warnings],
        plaintextLinks: peers.filter(record => record.connected && record.wireVersion === LEGACY_WIRE_VERSION).length,
      },
    };
  }

  #toPeerSnapshot(record: PeerRecord, now: number): PeerSnapshot {
    return {
      clientId: record.clientId,
      username: record.username,
      room: record.room,
      online: this.#registry.isOnline(record, now),
      connected: record.connected,
      addresses: [...record.addresses],
      latencyMs: record.latencyMs,
      source: record.source,
      wireVersion: record.wireVersion,
    };
  }

  /** Still-buffered messages, oldest first, for the footer/room banner. */
  #queuedSnapshots(): QueuedMessageSnapshot[] {
    const result: QueuedMessageSnapshot[] = [];
    for (const envelope of this.#offlineQueue.values()) {
      const room = envelope.room;
      if (room === null) {
        continue;
      }

      const message = this.#registry.history(room).find(entry => entry.id === envelope.id);
      if (message === undefined) {
        continue;
      }

      result.push({
        id: message.id,
        room,
        text: message.text.length > 60 ? `${message.text.slice(0, 57)}…` : message.text,
        ts: message.ts,
      });
    }

    return result;
  }

  /** Active transfers as plain data for the UI (progress, cancel affordances). */
  #transferSnapshots(): TransferSnapshot[] {
    const result: TransferSnapshot[] = [];

    for (const transfer of this.#outgoing.values()) {
      let sent = 0;
      let active = false;
      for (const peer of transfer.peers.values()) {
        sent = Math.max(sent, peer.sent);
        if (peer.phase === 'sending' || peer.phase === 'offered') {
          active = true;
        }
      }

      if (active) {
        result.push({
          id: transfer.id,
          direction: 'send',
          name: transfer.name,
          size: transfer.size,
          transferred: sent,
          state: transfer.peers.size > 0 && [...transfer.peers.values()].some(p => p.phase === 'sending')
            ? 'sending'
            : 'offering',
        });
      }
    }

    for (const transfer of this.#incoming.values()) {
      result.push({
        id: transfer.id,
        direction: 'receive',
        name: transfer.name,
        size: transfer.size,
        transferred: transfer.received,
        state: 'receiving',
      });
    }

    return result;
  }

  #emit(): void {
    if (!this.#dirty && this.#snapshot.revision > 0) {
      // Still rebuild when nothing changed? No: subscribers only need changes.
      return;
    }

    this.#revision += 1;
    this.#snapshot = this.#buildSnapshot();
    this.#dirty = false;

    for (const listener of [...this.#subscribers]) {
      try {
        listener();
      } catch (error) {
        this.#log(`subscriber threw: ${(error as Error).message}`, 'error');
      }
    }
  }
}

function describeMembers(members: PeerRecord[]): string {
  const names = members.map(member => member.username);
  if (names.length <= 3) {
    return names.join(', ');
  }

  return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

/** Convenience factory used by the CLI and by tests. */
export function createClient(options: ZapClientOptions = {}): ZapClient {
  return new ZapClient(options);
}

export { createClientId, newMessageId, DEFAULT_ROOM };
