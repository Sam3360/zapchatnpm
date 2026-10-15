/**
 * LAN discovery over UDP.
 *
 * Each client binds one UDP socket, joins the zapchat multicast group, enables
 * broadcast, and periodically sends the same small ANNOUNCE beacon to:
 *
 *   1. the multicast group      (works across switches, needs IGMP snooping)
 *   2. every subnet broadcast   (works on flat networks where multicast is blocked)
 *   3. 127.0.0.1                (so two instances on one machine find each other)
 *
 * Receiving beacons tells us which clients exist, which rooms they advertise and
 * which TCP port to talk to them on. Nothing here is required for chatting over
 * a manual connection: if UDP is blocked the app degrades and says so.
 */

import dgram, { type RemoteInfo, type Socket } from 'node:dgram';
import os from 'node:os';
import {
  ANNOUNCE_INTERVAL_MS,
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_MULTICAST_ADDRESS,
  DEFAULT_WIRE_VERSION,
  MAX_UDP_PACKET_BYTES,
  PEER_STALE_MS,
  SUPPORTED_WIRE_VERSIONS,
} from '../protocol/constants.js';
import {
  SUPPORTED_WIRE_VERSION_SET,
  createEnvelope,
  parseAnnounceData,
  parseEnvelope,
  type AnnounceData,
  type PeerContact,
} from '../protocol/messages.js';
import { localBroadcasts, localAddresses } from '../network/interfaces.js';

export interface AnnounceSnapshot {
  username: string;
  room: string | null;
  /** TCP port we are listening on. */
  port: number;
  /** Rooms we are willing to advertise so others can find empty rooms. */
  rooms: string[];
}

export interface AnnounceObservation {
  /** Address the datagram arrived from. */
  address: string;
  /** True when the beacon came back over loopback (same machine). */
  loopback: boolean;
}

/** A peer as announced on the LAN, including the rooms it is advertising. */
export interface AnnouncedPeer extends PeerContact {
  rooms: string[];
  /** Wire version from the peer's beacon (1 = legacy/Python, 2 = v2-capable). */
  wireVersion: number;
}

export interface DiscoveryOptions {
  clientId: string;
  /** Local UDP port to bind. */
  port?: number;
  multicastAddress?: string;
  /** Current state of the local client, read fresh for every beacon. */
  getAnnounce: () => AnnounceSnapshot;
  onAnnounce: (peer: AnnouncedPeer, observation: AnnounceObservation) => void;
  onError?: (error: Error) => void;
  announceIntervalMs?: number;
  /** Injectable for tests. */
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  now?: () => number;
}

export type DiscoveryKind = 'ok' | 'degraded' | 'unavailable';

export interface DiscoveryState {
  kind: DiscoveryKind;
  listening: boolean;
  /** True when at least one interface joined the multicast group. */
  multicast: boolean;
  /** True when the socket could be opened for broadcasting. */
  broadcast: boolean;
  port: number;
  /** Human-readable explanation when something is wrong. */
  detail: string;
  beaconsSent: number;
  beaconsReceived: number;
  sendFailures: number;
  dropped: number;
}

export class DiscoveryService {
  readonly #options: DiscoveryOptions;
  readonly #clientId: string;
  readonly #port: number;
  readonly #multicastAddress: string;
  readonly #intervalMs: number;
  readonly #interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  readonly #now: () => number;

  #socket: Socket | null = null;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;
  #warnedAboutDuplicateId = false;
  /** client id -> [ip, udp port] for direct unicast beacons (reliable path). */
  readonly #peerEndpoints = new Map<string, [string, number]>();
  /** client id -> last time we heard from them (prunes unicast targets). */
  readonly #lastSeenByPeer = new Map<string, number>();

  #state: DiscoveryState;

  constructor(options: DiscoveryOptions) {
    this.#options = options;
    this.#clientId = options.clientId;
    this.#port = options.port ?? DEFAULT_DISCOVERY_PORT;
    this.#multicastAddress = options.multicastAddress ?? DEFAULT_MULTICAST_ADDRESS;
    this.#intervalMs = options.announceIntervalMs ?? ANNOUNCE_INTERVAL_MS;
    this.#interfaces = options.networkInterfaces ?? os.networkInterfaces;
    this.#now = options.now ?? Date.now;

    this.#state = {
      kind: 'unavailable',
      listening: false,
      multicast: false,
      broadcast: false,
      port: this.#port,
      detail: 'not started',
      beaconsSent: 0,
      beaconsReceived: 0,
      sendFailures: 0,
      dropped: 0,
    };
  }

  get state(): DiscoveryState {
    return { ...this.#state };
  }

  get port(): number {
    return this.#port;
  }

  /**
   * Bind, join the multicast group and start beaconing.
   *
   * Never rejects: a failure to bind is reported through the returned state so
   * the caller can explain it to the user (and fall back to manual connections).
   */
  async start(): Promise<DiscoveryState> {
    if (this.#socket !== null) {
      return this.state;
    }

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.#socket = socket;

    return new Promise<DiscoveryState>(resolve => {
      let settled = false;
      const settle = (): void => {
        if (!settled) {
          settled = true;
          resolve(this.state);
        }
      };

      // Python clients bind the same well-known port and may hold it first;
      // on Windows the second bind can even surface as EACCES. Losing the
      // shared port must not kill discovery: multicast membership still
      // delivers group traffic regardless of bind port (the Python client
      // already behaves like this). Fall back to an ephemeral port once.
      let fallback = false;
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (!fallback && !this.#state.listening && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) {
          fallback = true;
          socket.removeAllListeners('error');
          socket.removeAllListeners('listening');
          socket.close();

          const retry = dgram.createSocket({ type: 'udp4', reuseAddr: true });
          this.#socket = retry;
          this.#bindAndListen(
            retry,
            { bindPort: 0, bindWarning: 'another instance holds the discovery port; using multicast' },
            settle,
          );
          return;
        }

        const detail = explainSocketError(error as Error, this.#port);
        this.#state = {
          ...this.#state,
          kind: 'unavailable',
          listening: false,
          detail,
        };
        this.#options.onError?.(error);
        settle();
      });

      socket.on('message', (message, remote) => {
        this.#handleDatagram(message, remote);
      });

    this.#bindAndListen(socket, { bindPort: this.#port, bindWarning: null }, settle);
    });
  }

  /**
   * Bind `socket` and wire the shared listening/setup path.
   *
   * `bindPort` 0 picks an ephemeral port — the deliberate fallback when the
   * well-known port is lost: on Windows a second bind of the shared port
   * fails outright (EACCES even with SO_REUSEADDR), but multicast membership
   * still delivers group traffic regardless of which instance holds the
   * well-known port.
   */
  #bindAndListen(socket: Socket, bind: { bindPort: number; bindWarning: string | null }, settle: () => void): void {
    socket.on('error', error => {
      const detail = explainSocketError(error as Error, this.#port);
      this.#state = {
        ...this.#state,
        kind: 'unavailable',
        listening: false,
        detail,
      };
      this.#options.onError?.(error as Error);
      settle();
    });

    socket.on('message', (message, remote) => {
      this.#handleDatagram(message, remote);
    });

    socket.on('listening', () => {
      const warnings: string[] = [];
      if (bind.bindWarning !== null) {
        warnings.push(bind.bindWarning);
      }

      try {
        socket.setBroadcast(true);
        this.#state = { ...this.#state, broadcast: true };
      } catch (error) {
        warnings.push(`broadcast unavailable (${(error as Error).message})`);
      }

      const multicast = this.#joinMulticast(socket, warnings);
      if (multicast) {
        try {
          socket.setMulticastTTL(1);
          socket.setMulticastLoopback(true);
        } catch {
          warnings.push('could not configure multicast TTL');
        }
      }

      this.#state = {
        ...this.#state,
        kind: bind.bindWarning !== null || warnings.length > 0 ? 'degraded' : 'ok',
        listening: true,
        multicast,
        detail:
          bind.bindWarning !== null && warnings.length > 1
            ? warnings.join('; ')
            : warnings[0] ?? `listening on udp:${this.#port}`,
      };

      this.#startTimer();
      this.announceNow();
      settle();
    });

    try {
      socket.bind({ port: bind.bindPort, address: '0.0.0.0', exclusive: false });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (bind.bindPort !== 0 && (code === 'EADDRINUSE' || code === 'EACCES')) {
        // Same fallback as the async path: an ephemeral port still receives
        // multicast group traffic, so discovery survives a lost well-known port.
        this.#bindAndListen(
          socket,
          { bindPort: 0, bindWarning: 'another instance holds the discovery port; using multicast' },
          settle,
        );
        try {
          socket.bind({ port: 0, address: '0.0.0.0', exclusive: false });
        } catch {
          this.#state = {
            ...this.#state,
            kind: 'unavailable',
            listening: false,
            detail: explainSocketError(error as Error, this.#port),
          };
          settle();
        }
        return;
      }

      // Synchronous bind failure (rare): report it like an async one.
      this.#state = {
        ...this.#state,
        kind: 'unavailable',
        listening: false,
        detail: explainSocketError(error as Error, this.#port),
      };
      settle();
    }
  }

  /** Join the multicast group on every usable interface. */
  #joinMulticast(socket: Socket, warnings: string[]): boolean {
    const addresses = localAddresses(this.#interfaces());
    let joined = 0;

    for (const address of addresses) {
      try {
        socket.addMembership(this.#multicastAddress, address);
        joined += 1;
      } catch {
        // Interface may not support multicast; other interfaces may still work.
      }
    }

    if (joined === 0) {
      try {
        socket.addMembership(this.#multicastAddress);
        joined += 1;
      } catch (error) {
        warnings.push(`multicast unavailable (${(error as Error).message})`);
      }
    }

    return joined > 0;
  }

  #startTimer(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      this.announceNow();
      this.#announceUnicast();
    }, this.#intervalMs);
    // Beacons must never keep the process alive on their own.
    this.#timer.unref?.();
  }

  /**
   * Unicast a beacon straight to every known peer's UDP source endpoint.
   *
   * Multicast and broadcast are best-effort; this is the reliable path that
   * keeps discovery converging even when multicast packets get lost. Both
   * wire versions are sent so the peer's classification never depends on
   * which single multicast packet happened to arrive.
   */
  #announceUnicast(): void {
    const socket = this.#socket;
    if (socket === null || this.#closed || !this.#state.listening) {
      return;
    }

    const snapshot = this.#options.getAnnounce();
    const announceData = {
      port: snapshot.port,
      addresses: localAddresses(this.#interfaces()),
      rooms: [snapshot.room, ...snapshot.rooms].filter(
        (room): room is string => typeof room === 'string',
      ),
    };

    const now = this.#now();
    for (const [clientId, endpoint] of [...this.#peerEndpoints.entries()]) {
      const lastSeen = this.#lastSeenByPeer.get(clientId) ?? 0;
      if (now - lastSeen > PEER_STALE_MS) {
        this.#peerEndpoints.delete(clientId);
        this.#lastSeenByPeer.delete(clientId);
        continue;
      }

      // Newest version first: a receiver creates its peer record from the
      // first packet it sees, and a record created as v1 makes both sides
      // refuse to dial until the v2 packet lands — which stalls
      // discovery-made links on lossy networks. The receiver's
      // never-downgrade Math.max makes the trailing v1 packet harmless.
      for (const version of [...SUPPORTED_WIRE_VERSIONS].reverse()) {
        const packet = buildBeacon(
          { clientId: this.#clientId, username: snapshot.username, room: snapshot.room },
          announceData,
          now,
          version,
        );
        if (packet === null) {
          continue;
        }

        socket.send(packet, 0, packet.length, endpoint[1], endpoint[0], error => {
          if (error === null) {
            this.#state = { ...this.#state, beaconsSent: this.#state.beaconsSent + 1 };
          }
        });
      }
    }
  }

  /** Send a beacon right now (used on startup, room changes and `/rescan`). */
  announceNow(): void {
    const socket = this.#socket;
    if (socket === null || this.#closed || !this.#state.listening) {
      return;
    }

    const snapshot = this.#options.getAnnounce();
    const announceData = {
      port: snapshot.port,
      addresses: localAddresses(this.#interfaces()),
      rooms: [snapshot.room, ...snapshot.rooms].filter(
        (room): room is string => typeof room === 'string',
      ),
    };

    // One beacon per supported wire version. v1 peers (the Python client) can
    // only parse v:1 envelopes and v2-only peers (npm 2.x-4.x) only v:2, so a
    // single-version beacon hides us from the other stack entirely. The
    // packets are byte-identical except for the `v` field. Newest first so a
    // receiver never creates its peer record as legacy (see the unicast loop).
    const packets: Buffer[] = [];
    for (const version of [...SUPPORTED_WIRE_VERSIONS].reverse()) {
      const packet = buildBeacon(
        // The room travels in the envelope, so receivers learn where to find us
        // from the beacon itself rather than waiting for a TCP handshake.
        { clientId: this.#clientId, username: snapshot.username, room: snapshot.room },
        announceData,
        this.#now(),
        version,
      );

      if (packet !== null) {
        packets.push(packet);
      } else {
        this.#state = { ...this.#state, dropped: this.#state.dropped + 1 };
      }
    }

    for (const target of this.#targets()) {
      for (const packet of packets) {
        socket.send(packet, 0, packet.length, this.#port, target, error => {
          if (error !== null) {
            this.#state = {
              ...this.#state,
              sendFailures: this.#state.sendFailures + 1,
            };
            return;
          }

          this.#state = { ...this.#state, beaconsSent: this.#state.beaconsSent + 1 };
        });
      }
    }
  }

  /** Where beacons go: multicast, global broadcast, each subnet, and loopback. */
  #targets(): string[] {
    return [
      ...new Set([
        this.#multicastAddress,
        '255.255.255.255',
        ...localBroadcasts(this.#interfaces()),
        '127.0.0.1',
      ]),
    ];
  }

  #handleDatagram(message: Buffer, remote: RemoteInfo): void {
    if (message.length > MAX_UDP_PACKET_BYTES) {
      this.#state = { ...this.#state, dropped: this.#state.dropped + 1 };
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(message.toString('utf8'));
    } catch {
      this.#state = { ...this.#state, dropped: this.#state.dropped + 1 };
      return;
    }

    const envelope = parseEnvelope(raw, {
      now: this.#now(),
      allowedVersions: SUPPORTED_WIRE_VERSION_SET,
    });
    if (envelope === null || envelope.type !== 'ANNOUNCE') {
      this.#state = { ...this.#state, dropped: this.#state.dropped + 1 };
      return;
    }

    if (envelope.from === this.#clientId) {
      // Our own beacon echoing back — unless it came from a *different* listening
      // port, which means another instance shares our identity (usually because
      // ZAPCHAT_CONFIG_DIR points at the same directory) and the two will never
      // see each other. Say so instead of failing silently.
      const data = parseAnnounceData(envelope.data);
      if (
        data !== null &&
        data.port !== this.#options.getAnnounce().port &&
        !this.#warnedAboutDuplicateId
      ) {
        this.#warnedAboutDuplicateId = true;
        this.#options.onError?.(
          new Error(
            'another instance is using this client id (shared config directory); give each instance its own ZAPCHAT_CONFIG_DIR',
          ),
        );
      }

      this.#state = { ...this.#state, dropped: this.#state.dropped + 1 };
      return;
    }

    const data = parseAnnounceData(envelope.data);
    if (data === null) {
      this.#state = { ...this.#state, dropped: this.#state.dropped + 1 };
      return;
    }

    this.#state = { ...this.#state, beaconsReceived: this.#state.beaconsReceived + 1 };

    this.#options.onAnnounce(
      {
        clientId: envelope.from,
        username: envelope.username,
        room: envelope.room,
        port: data.port,
        // Trust the address we actually received from first.
        addresses: dedupe([remote.address, ...data.addresses]),
        rooms: data.rooms,
        wireVersion: envelope.v,
      },
      {
        address: remote.address,
        loopback: remote.address === '127.0.0.1' || remote.address.startsWith('127.'),
      },
    );

    // Remember the beacon's source endpoint: unicast is the reliable path
    // that keeps the mesh converging when multicast drops packets (on
    // Windows a multicast-only listener can receive only the FIRST packet
    // of a back-to-back pair, starving it of one wire version).
    this.#peerEndpoints.set(envelope.from, [remote.address, remote.port]);
    this.#lastSeenByPeer.set(envelope.from, this.#now());
  }

  stop(): void {
    this.#closed = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    const socket = this.#socket;
    this.#socket = null;
    this.#state = { ...this.#state, listening: false };

    if (socket === null) {
      return;
    }

    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Build a beacon envelope, shrinking it (rooms first, then addresses) until it
 * fits comfortably inside one datagram.
 */
export function buildBeacon(
  sender: { clientId: string; username: string; room?: string | null },
  data: AnnounceData,
  now: number = Date.now(),
  version: number = DEFAULT_WIRE_VERSION,
): Buffer | null {
  const trim = (candidate: AnnounceData): Buffer =>
    Buffer.from(
      JSON.stringify(
        createEnvelope('ANNOUNCE', sender, {
          ts: now,
          room: sender.room ?? null,
          data: candidate,
          version,
        }),
      ),
      'utf8',
    );

  let attempt: AnnounceData = {
    port: data.port,
    addresses: dedupe(data.addresses).slice(0, 8),
    rooms: dedupe(data.rooms.filter(room => room.length > 0)).slice(0, 8),
  };

  let packet = trim(attempt);
  while (packet.length > MAX_UDP_PACKET_BYTES && attempt.rooms.length > 0) {
    attempt = { ...attempt, rooms: attempt.rooms.slice(0, attempt.rooms.length - 1) };
    packet = trim(attempt);
  }

  while (packet.length > MAX_UDP_PACKET_BYTES && attempt.addresses.length > 0) {
    attempt = { ...attempt, addresses: attempt.addresses.slice(0, attempt.addresses.length - 1) };
    packet = trim(attempt);
  }

  return packet.length > MAX_UDP_PACKET_BYTES ? null : packet;
}

/** Turn a Node socket error into something a human can act on. */
export function explainSocketError(error: Error, port: number): string {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case 'EADDRINUSE':
      return `UDP port ${port} is already in use by another program; LAN discovery is off (use /connect <ip> to join manually)`;
    case 'EACCES':
      return `permission denied binding UDP port ${port}; LAN discovery is off (use /connect <ip> to join manually)`;
    case 'ENETUNREACH':
      return 'no route to the local network; LAN discovery is off';
    case 'EAFNOSUPPORT':
      return 'this network stack does not support UDP/IPv4 discovery';
    default:
      return `LAN discovery failed (${error.message}); use /connect <ip> to join manually`;
  }
}
