/**
 * TCP transport: a full mesh between every client in range.
 *
 * There is no server and no leader. Each client listens on a TCP port (trying
 * 45913, 45914, … until one is free) and connects directly to every peer it
 * discovers. Both directions are attempted; if two clients connect to each
 * other at the same moment the duplicate is closed deterministically so exactly
 * one link survives.
 *
 * On connection:
 *   1. the initiator sends HELLO immediately;
 *   2. the acceptor replies with its own HELLO and only then considers the peer
 *      usable, so identity always comes from a validated HELLO, never from an
 *      address;
 *   3. PING/PONG keep the link warm and detect half-open sockets (common on
 *      Wi-Fi when a laptop sleeps).
 *
 * Frames that arrive before HELLO, oversized frames and unparseable JSON are
 * dropped: a connection that violates the protocol is closed, never trusted.
 */

import net from 'node:net';
import {
  DEFAULT_TCP_PORT_BASE,
  HELLO_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_PEERS,
  MAX_PENDING_WRITE_BYTES,
  PEER_SILENCE_MS,
  PING_INTERVAL_MS,
  TCP_PORT_ATTEMPTS,
} from '../protocol/constants.js';
import { FrameDecoder, encodeFrame } from '../protocol/framing.js';
import {
  createEnvelope,
  readHelloData,
  type Envelope,
  type HelloData,
} from '../protocol/messages.js';

export type PeerGoneReason =
  | 'closed'
  | 'error'
  | 'timeout'
  | 'hello-timeout'
  | 'duplicate'
  | 'protocol'
  | 'shutdown';

export interface PeerHandle {
  clientId: string;
  username: string;
  room: string | null;
  /** TCP port the peer is listening on (from HELLO). */
  port: number;
  /** Addresses the peer advertised. */
  addresses: string[];
  /** True when we opened this connection. */
  outbound: boolean;
  /** Address we actually see the peer on. */
  remoteAddress: string;
  remotePort: number;
  connectedAt: number;
  latencyMs: number | null;
}

export interface TransportHandlers {
  /** Fresh identity to send in HELLO (username/room can change at runtime). */
  getHello: () => { username: string; room: string | null; port: number; addresses: string[] };
  /** A peer finished the handshake and is ready for envelopes. */
  onPeerReady: (peer: PeerHandle) => void;
  /** A peer is gone (cleanly or otherwise). */
  onPeerGone: (peer: PeerHandle, reason: PeerGoneReason) => void;
  /** A validated envelope arrived from an established peer. */
  onEnvelope: (envelope: Envelope, peer: PeerHandle) => void;
  /** Round-trip time measured from a PONG. */
  onPeerLatency?: (peer: PeerHandle, latencyMs: number) => void;
  /** Non-fatal operational noise (reconnects, refused connections…). */
  onWarning?: (message: string, error?: unknown) => void;
}

export interface TransportOptions {
  clientId: string;
  maxPeers?: number;
  maxFrameBytes?: number;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  silenceTimeoutMs?: number;
  maxPendingWriteBytes?: number;
  maxConnectTimeoutMs?: number;
  now?: () => number;
}

interface Connection {
  socket: net.Socket;
  decoder: FrameDecoder;
  outbound: boolean;
  peer: PeerHandle | null;
  createdAt: number;
  lastActivity: number;
  lastPingSent: number;
  pingSentAt: number | null;
  closed: boolean;
  /** Set by #destroy before the socket's close event fires. */
  reason?: PeerGoneReason;
  /** Frames this connection's decoder has dropped so far. */
  lastDropped: number;
  /** Reject the `connect()` promise when a pending link dies. */
  settle: { resolve: (peer: PeerHandle) => void; reject: (error: Error) => void } | null;
  helloDeadline: number;
}

export class TcpTransport {
  readonly #handlers: TransportHandlers;
  readonly #clientId: string;
  readonly #maxPeers: number;
  readonly #helloTimeoutMs: number;
  readonly #pingIntervalMs: number;
  readonly #silenceTimeoutMs: number;
  readonly #maxPendingWriteBytes: number;
  readonly #maxConnectTimeoutMs: number;
  readonly #now: () => number;
  readonly #maxFrameBytes: number;

  #server: net.Server | null = null;
  #serverPort = 0;
  #droppedFrames = 0;
  #timer: NodeJS.Timeout | null = null;
  #closing = false;

  readonly #connections = new Set<Connection>();
  readonly #byClientId = new Map<string, Connection>();
  readonly #pendingConnect = new Map<string, Promise<PeerHandle>>();

  constructor(handlers: TransportHandlers, options: TransportOptions) {
    this.#handlers = handlers;
    this.#clientId = options.clientId;
    this.#maxPeers = options.maxPeers ?? MAX_PEERS;
    this.#maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.#pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.#silenceTimeoutMs = options.silenceTimeoutMs ?? PEER_SILENCE_MS;
    this.#maxPendingWriteBytes = options.maxPendingWriteBytes ?? MAX_PENDING_WRITE_BYTES;
    this.#maxConnectTimeoutMs = options.maxConnectTimeoutMs ?? 5000;
    this.#now = options.now ?? Date.now;
  }

  get port(): number {
    return this.#serverPort;
  }

  get peerCount(): number {
    return this.#byClientId.size;
  }

  peerIds(): string[] {
    return [...this.#byClientId.keys()];
  }

  /** Frames received from peers that failed validation (bad JSON, oversized, bad shape). */
  get droppedFrames(): number {
    return this.#droppedFrames;
  }

  hasPeer(clientId: string): boolean {
    return this.#byClientId.has(clientId);
  }

  getPeer(clientId: string): PeerHandle | undefined {
    return this.#byClientId.get(clientId)?.peer ?? undefined;
  }

  peers(): PeerHandle[] {
    return [...this.#byClientId.values()]
      .map(connection => connection.peer)
      .filter((peer): peer is PeerHandle => peer !== null);
  }

  /**
   * Start listening. Tries `portBase`, then the next few ports, and finally an
   * ephemeral port — so two clients on one machine (or a busy port) still work.
   * Returns the port actually bound.
   */
  async listen(
    portBase: number = DEFAULT_TCP_PORT_BASE,
    attempts: number = TCP_PORT_ATTEMPTS,
  ): Promise<number> {
    if (this.#server !== null) {
      return this.#serverPort;
    }

    const candidates: number[] = [];
    if (portBase > 0) {
      for (let offset = 0; offset < attempts; offset += 1) {
        candidates.push(portBase + offset);
      }
    }

    candidates.push(0); // ephemeral fallback

    let lastError: Error | null = null;
    for (const port of candidates) {
      try {
        this.#serverPort = await this.#listenOn(port);
        this.#startTimer();
        return this.#serverPort;
      } catch (error) {
        lastError = error as Error;
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          break;
        }
      }
    }

    throw lastError ?? new Error('could not bind a TCP port');
  }

  #listenOn(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: false }, socket => {
        this.#attach(socket, false);
      });

      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        try {
          server.close();
        } catch {
          // ignore
        }

        reject(error);
      };

      const onListening = (): void => {
        server.removeListener('error', onError);
        server.on('error', error => {
          this.#handlers.onWarning?.(`tcp listener error: ${error.message}`, error);
        });

        const address = server.address();
        this.#server = server;
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      };

      server.once('error', onError);
      server.once('listening', onListening);

      try {
        server.listen({ port, host: '0.0.0.0' });
      } catch (error) {
        onError(error as Error);
      }
    });
  }

  /**
   * Open a link to a peer. The promise resolves once the peer's HELLO has been
   * validated (so callers get a real identity back) and rejects on failure.
   * Concurrent calls for the same address share one attempt.
   */
  connect(
    address: string,
    port: number,
    timeoutMs: number = this.#maxConnectTimeoutMs,
  ): Promise<PeerHandle> {
    const key = `${address}:${port}`;
    const existing = this.#pendingConnect.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const promise = new Promise<PeerHandle>((resolve, reject) => {
      if (this.#closing) {
        reject(new Error('transport is closed'));
        return;
      }

      const socket = net.connect({ host: address, port });
      const connection = this.#attach(socket, true);
      connection.settle = { resolve, reject };

      const timer = setTimeout(() => {
        if (!connection.closed && connection.peer === null) {
          this.#destroy(connection, 'timeout');
        }
      }, Math.max(500, timeoutMs));
      timer.unref?.();

      socket.once('close', () => clearTimeout(timer));
      socket.once('error', error => {
        clearTimeout(timer);
        if (connection.peer === null && connection.settle !== null) {
          connection.settle.reject(friendlyConnectError(error, address, port));
          connection.settle = null;
        }
      });
    });

    this.#pendingConnect.set(key, promise);
    void promise
      .catch(() => undefined)
      .then(() => {
        if (this.#pendingConnect.get(key) === promise) {
          this.#pendingConnect.delete(key);
        }
      });

    return promise;
  }

  /** Send one envelope to a connected peer. Returns false when not connected. */
  sendTo(clientId: string, envelope: Envelope): boolean {
    const connection = this.#byClientId.get(clientId);
    if (connection === undefined) {
      return false;
    }

    return this.#write(connection, envelope);
  }

  /** Send to several peers, skipping the ones without a link. Returns the count. */
  sendMany(clientIds: Iterable<string>, envelope: Envelope): number {
    let sent = 0;
    for (const clientId of clientIds) {
      if (clientId === this.#clientId) {
        continue;
      }

      if (this.sendTo(clientId, envelope)) {
        sent += 1;
      }
    }

    return sent;
  }

  close(): void {
    this.#closing = true;

    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    for (const connection of [...this.#connections]) {
      this.#destroy(connection, 'shutdown');
    }

    const server = this.#server;
    this.#server = null;
    if (server !== null) {
      try {
        server.close();
      } catch {
        // ignore
      }
    }
  }

  #attach(socket: net.Socket, outbound: boolean): Connection {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15000);

    const now = this.#now();
    const connection: Connection = {
      socket,
      decoder: new FrameDecoder({ maxFrameBytes: this.#maxFrameBytes }),
      outbound,
      peer: null,
      createdAt: now,
      lastActivity: now,
      lastPingSent: 0,
      pingSentAt: null,
      closed: false,
      lastDropped: 0,
      settle: null,
      helloDeadline: now + this.#helloTimeoutMs,
    };

    this.#connections.add(connection);

    socket.on('data', chunk => {
      this.#onData(connection, chunk);
    });

    socket.on('error', error => {
      // Socket errors are normal (peer went away, Wi-Fi dropped). The close
      // handler does the cleanup; we only keep a reason for the logs.
      this.#handlers.onWarning?.(`peer socket error: ${error.message}`);
    });

    socket.on('close', () => {
      this.#teardown(connection, 'closed');
    });

    if (outbound) {
      this.#sendHello(connection);
    }

    return connection;
  }

  #onData(connection: Connection, chunk: Buffer): void {
    connection.lastActivity = this.#now();

    const frames = connection.decoder.push(chunk);
    const dropped = connection.decoder.stats.dropped;
    if (dropped > connection.lastDropped) {
      this.#droppedFrames += dropped - connection.lastDropped;
      connection.lastDropped = dropped;
    }

    for (const frame of frames) {
      if (connection.peer === null) {
        this.#handleHandshake(connection, frame);
        continue;
      }

      switch (frame.type) {
        case 'PING': {
          const pong = createEnvelope('PONG', this.#senderIdentity(), { data: null });
          this.#write(connection, pong);
          break;
        }

        case 'PONG': {
          if (connection.pingSentAt !== null) {
            const latency = Math.max(0, this.#now() - connection.pingSentAt);
            connection.pingSentAt = null;
            connection.peer.latencyMs = latency;
            this.#handlers.onPeerLatency?.(connection.peer, latency);
          }

          break;
        }

        case 'HELLO': {
          // Identity refresh from a known peer (e.g. username change).
          const hello = readHelloData(frame);
          if (hello !== null) {
            connection.peer.username = frame.username;
            connection.peer.room = frame.room;
            connection.peer.port = hello.port;
            connection.peer.addresses = hello.addresses;
            this.#handlers.onEnvelope(frame, connection.peer);
          }

          break;
        }

        default: {
          this.#handlers.onEnvelope(frame, connection.peer);
        }
      }
    }
  }

  #handleHandshake(connection: Connection, frame: Envelope): void {
    if (frame.type !== 'HELLO') {
      // Anything before HELLO is a protocol violation.
      this.#destroy(connection, 'protocol');
      return;
    }

    if (frame.from === this.#clientId) {
      this.#destroy(connection, 'protocol');
      return;
    }

    const hello = readHelloData(frame);
    if (hello === null) {
      this.#destroy(connection, 'protocol');
      return;
    }

    const duplicate = this.#byClientId.get(frame.from);
    if (duplicate !== undefined && duplicate !== connection) {
      // Both sides dialled at once (or the user connected manually to someone we
      // already talk to). The established link wins, and a pending `connect()`
      // call is satisfied by it rather than reported as a failure.
      const existing = duplicate.peer;
      const settle = connection.settle;
      connection.settle = null;
      if (existing !== null) {
        settle?.resolve(existing);
      }

      this.#destroy(connection, 'duplicate');
      return;
    }

    if (this.#byClientId.size >= this.#maxPeers) {
      this.#destroy(connection, 'protocol');
      return;
    }

    const peer: PeerHandle = {
      clientId: frame.from,
      username: frame.username,
      room: frame.room,
      port: hello.port,
      addresses: hello.addresses,
      outbound: connection.outbound,
      remoteAddress: connection.socket.remoteAddress ?? '',
      remotePort: connection.socket.remotePort ?? 0,
      connectedAt: this.#now(),
      latencyMs: null,
    };

    connection.peer = peer;
    this.#byClientId.set(peer.clientId, connection);

    // The acceptor answers with its own HELLO so both ends are identified.
    if (!connection.outbound) {
      this.#sendHello(connection);
    }

    const settle = connection.settle;
    connection.settle = null;
    settle?.resolve(peer);

    this.#handlers.onPeerReady(peer);
  }

  #sendHello(connection: Connection): void {
    const identity = this.#handlers.getHello();
    const data: HelloData = { port: identity.port, addresses: identity.addresses };
    const envelope = createEnvelope('HELLO', this.#senderIdentity(identity.username), {
      room: identity.room,
      data,
    });

    this.#write(connection, envelope);
  }

  #senderIdentity(username?: string): { clientId: string; username: string } {
    return {
      clientId: this.#clientId,
      username: username ?? this.#handlers.getHello().username,
    };
  }

  /**
   * Write one frame on a connection.
   *
   * Writes are allowed before the handshake completes (the HELLO itself is sent
   * as soon as the socket is created, and Node buffers it until the connection
   * is established). Higher-level sends still go through `sendTo`, which can
   * only resolve a peer that has already completed the handshake.
   */
  #write(connection: Connection, envelope: Envelope): boolean {
    if (connection.closed) {
      return false;
    }

    if (connection.socket.writableLength > this.#maxPendingWriteBytes) {
      // The peer is not reading fast enough; drop it rather than grow forever.
      this.#destroy(connection, 'timeout');
      return false;
    }

    const frame = encodeFrame(envelope);
    try {
      connection.socket.write(frame, error => {
        if (error !== null && error !== undefined) {
          this.#destroy(connection, 'error');
        }
      });
      return true;
    } catch {
      this.#destroy(connection, 'error');
      return false;
    }
  }


  #destroy(connection: Connection, reason: PeerGoneReason): void {
    connection.reason = reason;
    if (!connection.closed) {
      connection.socket.destroy();
    }
  }

  #teardown(connection: Connection, fallbackReason: PeerGoneReason): void {
    if (connection.closed) {
      return;
    }

    connection.closed = true;
    this.#connections.delete(connection);

    const reason = connection.reason ?? fallbackReason;
    const peer = connection.peer;
    if (peer !== null) {
      if (this.#byClientId.get(peer.clientId) === connection) {
        this.#byClientId.delete(peer.clientId);
      }

      this.#handlers.onPeerGone(peer, reason);
    } else if (connection.settle !== null) {
      const settle = connection.settle;
      connection.settle = null;
      settle.reject(
        new Error(
          reason === 'duplicate'
            ? 'a duplicate connection was already established'
            : `connection failed (${reason})`,
        ),
      );
    }
  }

  #startTimer(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      const now = this.#now();
      for (const connection of [...this.#connections]) {
        if (connection.closed) {
          continue;
        }

        if (connection.peer === null) {
          if (now > connection.helloDeadline) {
            this.#destroy(connection, 'hello-timeout');
          }

          continue;
        }

        if (now - connection.lastActivity > this.#silenceTimeoutMs) {
          this.#destroy(connection, 'timeout');
          continue;
        }

        if (now - connection.lastPingSent >= this.#pingIntervalMs) {
          connection.lastPingSent = now;
          connection.pingSentAt = now;
          this.#write(connection, createEnvelope('PING', this.#senderIdentity(), { data: null }));
        }
      }
    }, Math.max(500, Math.floor(this.#pingIntervalMs / 2)));

    this.#timer.unref?.();
  }
}

/** Connection errors that users actually hit deserve plain language. */
export function friendlyConnectError(error: Error, address: string, port: number): Error {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ECONNREFUSED':
      return new Error(`nothing is listening on ${address}:${port}`);
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new Error(`${address} is not reachable from this network`);
    case 'ETIMEDOUT':
      return new Error(`timed out connecting to ${address}:${port}`);
    case 'EACCES':
      return new Error(`permission denied connecting to ${address}:${port}`);
    default:
      return new Error(`could not connect to ${address}:${port} (${error.message})`);
  }
}
