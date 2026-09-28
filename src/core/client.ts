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

import os from 'node:os';
import {
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_ROOM,
  DEFAULT_TCP_PORT_BASE,
  MAX_ROOM_NAME_LENGTH,
  MAX_USERNAME_LENGTH,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  SWEEP_INTERVAL_MS,
} from '../protocol/constants.js';
import {
  createEnvelope,
  readHelloData,
  readMessageData,
  readPeerListData,
  readRoomListData,
  newMessageId,
  type Envelope,
  type PeerContact,
} from '../protocol/messages.js';
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
  configPath?: string;
  staleMs?: number;
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

/** How long a footer notice stays on screen before the hints come back. */
const NOTICE_TTL_MS = 6000;

export class ZapClient {
  readonly #options: ZapClientOptions;
  readonly #now: () => number;
  readonly #log: (message: string, level: 'info' | 'warn' | 'error') => void;

  #config: Config;
  #configPath: string;
  #clientId: string;
  #username: string;
  #usernameConfirmed: boolean;
  #registry: RoomRegistry;
  /** TOFU pin store for peer identity keys (protocol v2). */
  #pinStore: PeerPinStore;

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
  readonly #attempts = new Map<string, AttemptState>();
  /** Peers we have shown a "reconnecting" notice for. */
  readonly #reconnecting = new Set<string>();
  #peerListDirty = false;

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

    this.#registry = new RoomRegistry({
      selfClientId: this.#clientId,
      selfUsername: this.#username,
      ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
    });

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
          const verdict = this.#pinStore.check(clientId, identityKeyId, this.#now());
          if (verdict === 'new') {
            // First contact with this peer: persist the pin immediately so it
            // is already on disk before the next encounter.
            this.#config = { ...this.#config, peerPins: this.#pinStore.toConfig() };
            this.#writeConfig();
          }

          return verdict;
        },
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
      this.#setNotice('warn', 'no peers are connected yet — your message is only local for now');
    } else if (this.#notice?.tone === 'warn') {
      this.#notice = null;
    }

    this.#markDirty();
    this.#emit();
    return { ok: true };
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
      const peer = await transport.connect(host, targetPort);
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

  #onAnnounce(peer: PeerContact & { rooms: string[] }, address: string): void {
    if (peer.clientId === this.#clientId) {
      return;
    }

    const now = this.#now();
    const { peer: record, added, previousRoom } = this.#registry.upsertPeer(
      { ...peer, addresses: [address, ...peer.addresses] },
      'lan',
      now,
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

    this.#log(`connected to ${peer.username} (${peer.remoteAddress})`, 'info');
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
            text: data.text,
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

    void this.#transport
      .connect(address, peer.port)
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

    if (this.#dirty) {
      this.#emit();
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
    };
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
