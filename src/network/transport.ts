/**
 * TCP transport: a full mesh between every client in range.
 *
 * There is no server and no leader. Each client listens on a TCP port (trying
 * 45913, 45914, … until one is free) and connects directly to every peer it
 * discovers. Both directions are attempted; if two clients connect to each
 * other at the same moment the duplicate is closed deterministically so exactly
 * one link survives.
 *
 * On connection (protocol v2 — encrypted):
 *   1. the initiator sends a HELLO carrying a signed ephemeral key exchange;
 *   2. the acceptor verifies the signature and its TOFU pin for the peer's
 *      identity key, completes the ECDH, and replies with its own signed HELLO;
 *   3. both sides now hold directional AES-256-GCM session keys; every later
 *      frame is sealed and sequence-numbered (see `protocol/secureFraming.ts`);
 *   4. PING/PONG keep the link warm and detect half-open sockets.
 *
 * A connection that never completes the handshake is dropped at the hello
 * deadline. Any bad magic byte, oversized frame, replayed sequence number or
 * frame that fails to decrypt is a protocol violation: the connection is
 * destroyed, never trusted. A peer whose identity key does not match the pin
 * we hold is refused (`tofu-mismatch`).
 */

import net from 'node:net';
import {
  DEFAULT_TCP_PORT_BASE,
  HELLO_TIMEOUT_MS,
  MAX_PEERS,
  MAX_PENDING_WRITE_BYTES,
  PEER_SILENCE_MS,
  PING_INTERVAL_MS,
  TCP_PORT_ATTEMPTS,
} from '../protocol/constants.js';
import { encodeFrame, FrameDecoder } from '../protocol/framing.js';
import {
  createKeyExchange,
  encodeKeyExchangeForWire,
  parseKeyExchangeFromWire,
  runHandshake,
  type HelloKeyExchange,
} from '../protocol/handshake.js';
import {
  createEnvelope,
  readHelloData,
  parseEnvelope,
  type Envelope,
  type HelloData,
} from '../protocol/messages.js';
import {
  createSecureSession,
  decodeSecurePayload,
  encodeHandshakeFrame,
  encodeSecureFrame,
  SecureFrameReader,
  SEQ_HANDSHAKE,
  type SecureSession,
} from '../protocol/secureFraming.js';

export type PeerGoneReason =
  | 'closed'
  | 'error'
  | 'timeout'
  | 'hello-timeout'
  | 'duplicate'
  | 'protocol'
  | 'tofu-mismatch'
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
  /** Fingerprint of the peer's long-term identity key (TOFU). */
  identityKeyId: string;
  /** Always true in protocol v2: every link is encrypted. */
  encrypted: true;
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

export type PeerPinVerdict = 'ok' | 'new' | 'mismatch';

export interface TransportOptions {
  clientId: string;
  /** Our long-term Ed25519 identity seed (signs every handshake). */
  identitySeed: Uint8Array;
  /** TOFU pin check; return 'mismatch' to refuse the peer. */
  checkPeerPin?: (clientId: string, identityKeyId: string) => PeerPinVerdict;
  maxPeers?: number;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  silenceTimeoutMs?: number;
  maxPendingWriteBytes?: number;
  maxConnectTimeoutMs?: number;
  now?: () => number;
}

/** Handshake progress for one connection. */
type HandshakeState =
  | { readonly phase: 'awaiting-hello' }
  | {
      readonly phase: 'awaiting-reply';
      /** Our ephemeral private key and the exchange we sent. */
      readonly mine: { privateKey: Buffer; exchange: HelloKeyExchange };
    }
  | {
      readonly phase: 'answering';
      /** Our reply HELLO must carry this exchange, unencrypted, before data. */
      readonly mine: { privateKey: Buffer; exchange: HelloKeyExchange };
      readonly session: SecureSession;
    }
  | { readonly phase: 'established'; readonly session: SecureSession };

interface Connection {
  socket: net.Socket;
  /** Reads raw v2 frames off the socket (binary, length-prefixed). */
  reader: SecureFrameReader;
  /** Splits decrypted plaintext back into JSON envelopes. */
  decoder: FrameDecoder;
  outbound: boolean;
  handshake: HandshakeState;
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
  /** Deadline for the handshake (hello timeout) while not established. */
  helloDeadline: number;
}

export class TcpTransport {
  readonly #handlers: TransportHandlers;
  readonly #clientId: string;
  readonly #identitySeed: Uint8Array;
  readonly #checkPeerPin: ((clientId: string, identityKeyId: string) => PeerPinVerdict) | undefined;
  readonly #maxPeers: number;
  readonly #helloTimeoutMs: number;
  readonly #pingIntervalMs: number;
  readonly #silenceTimeoutMs: number;
  readonly #maxPendingWriteBytes: number;
  readonly #maxConnectTimeoutMs: number;
  readonly #now: () => number;

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
    this.#identitySeed = options.identitySeed;
    this.#checkPeerPin = options.checkPeerPin;
    this.#maxPeers = options.maxPeers ?? MAX_PEERS;
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

  /** Frames received from peers that failed validation (bad JSON, bad shape). */
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
   * Open a link to a peer. The promise resolves once the encrypted handshake
   * has completed (so callers get a real identity back) and rejects on failure.
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
      reader: new SecureFrameReader(),
      decoder: new FrameDecoder(),
      outbound,
      handshake: { phase: 'awaiting-hello' },
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
      // Initiator: create a signed ephemeral exchange and send it immediately.
      const mine = createKeyExchange(this.#identitySeed);
      connection.handshake = { phase: 'awaiting-reply', mine };
      this.#sendHello(connection);
    }

    return connection;
  }

  #onData(connection: Connection, chunk: Buffer): void {
    connection.lastActivity = this.#now();

    const frames = connection.reader.push(chunk);
    if (frames === null) {
      // Wrong magic byte or absurd declared length: not a v2 stream.
      this.#destroy(connection, 'protocol');
      return;
    }

    for (const frame of frames) {
      if (frame.seq === SEQ_HANDSHAKE) {
        if (
          connection.handshake.phase !== 'awaiting-hello' &&
          connection.handshake.phase !== 'awaiting-reply'
        ) {
          // Handshake frames after the exchange started/finished are nonsense.
          this.#destroy(connection, 'protocol');
          return;
        }

        if (!this.#handleHandshakeFrame(connection, frame.payload)) {
          return; // connection destroyed inside
        }

        continue;
      }

      if (connection.handshake.phase !== 'established') {
        // Encrypted frame before the session exists: hostile.
        this.#destroy(connection, 'protocol');
        return;
      }

      const plain = decodeSecurePayload(
        connection.handshake.session,
        frame.seq,
        frame.head,
        frame.payload,
      );

      if (plain === null) {
        // Replay, gap, tampering or wrong key — none of which we tolerate.
        this.#destroy(connection, 'protocol');
        return;
      }

      const envelopes = connection.decoder.push(plain);
      const dropped = connection.decoder.stats.dropped;
      if (dropped > connection.lastDropped) {
        this.#droppedFrames += dropped - connection.lastDropped;
        connection.lastDropped = dropped;
      }

      for (const envelope of envelopes) {
        this.#dispatchEnvelope(connection, envelope);
      }
    }
  }

  #dispatchEnvelope(connection: Connection, frame: Envelope): void {
    if (connection.peer === null) {
      this.#destroy(connection, 'protocol');
      return;
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

  /**
   * Handle a seq-0 handshake frame. Returns false when the connection was (or
   * must be) destroyed.
   */
  #handleHandshakeFrame(connection: Connection, payload: Buffer): boolean {
    // Parse the HELLO envelope inside the plaintext handshake frame.
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString('utf8'));
    } catch {
      this.#destroy(connection, 'protocol');
      return false;
    }

    const envelope = parseEnvelope(raw, { now: this.#now() });
    if (envelope === null || envelope.type !== 'HELLO' || envelope.from === this.#clientId) {
      this.#destroy(connection, 'protocol');
      return false;
    }

    const hello = readHelloData(envelope);
    if (hello === null || hello.keyExchange === undefined) {
      this.#destroy(connection, 'protocol');
      return false;
    }

    const exchange = parseKeyExchangeFromWire(hello.keyExchange);
    if (exchange === null) {
      // Malformed, badly signed, or signed by an unknown key.
      this.#destroy(connection, 'protocol');
      return false;
    }

    // TOFU: refuse an identity key that changed for a client id we know.
    if (this.#checkPeerPin !== undefined) {
      const verdict = this.#checkPeerPin(envelope.from, exchange.identityKeyId);
      if (verdict === 'mismatch') {
        this.#handlers.onWarning?.(
          `peer ${envelope.username} (${envelope.from}) presented a different identity key; refusing`,
        );
        this.#destroy(connection, 'tofu-mismatch');
        return false;
      }
    }

    const duplicate = this.#byClientId.get(envelope.from);
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
      return false;
    }

    if (this.#byClientId.size >= this.#maxPeers) {
      this.#destroy(connection, 'protocol');
      return false;
    }

    let session: SecureSession;
    if (connection.handshake.phase === 'awaiting-reply') {
      // We are the initiator: the HKDF salt is our own nonce.
      const mine = connection.handshake.mine;
      const result = runHandshake(mine.privateKey, exchange, mine.exchange.nonce, true);
      if (result === null) {
        this.#destroy(connection, 'protocol');
        return false;
      }

      session = createSecureSession(result.keys.send, result.keys.recv);
    } else {
      // We are the acceptor: create our exchange now; the HKDF salt is the
      // initiator's nonce (the exchange we just received). Our reply HELLO —
      // carrying this exact exchange — must go out as a plaintext seq-0 frame
      // before the session switches on, hence the 'answering' phase.
      const mine = createKeyExchange(this.#identitySeed);
      const result = runHandshake(mine.privateKey, exchange, exchange.nonce, false);
      if (result === null) {
        this.#destroy(connection, 'protocol');
        return false;
      }

      session = createSecureSession(result.keys.send, result.keys.recv);
      connection.handshake = { phase: 'answering', mine, session };
      this.#sendHello(connection); // plaintext seq-0 frame with our exchange
      connection.handshake = { phase: 'established', session };
    }

    if (connection.handshake.phase !== 'established') {
      connection.handshake = { phase: 'established', session };
    }

    const peer: PeerHandle = {
      clientId: envelope.from,
      username: envelope.username,
      room: envelope.room,
      port: hello.port,
      addresses: hello.addresses,
      outbound: connection.outbound,
      remoteAddress: connection.socket.remoteAddress ?? '',
      remotePort: connection.socket.remotePort ?? 0,
      connectedAt: this.#now(),
      latencyMs: null,
      identityKeyId: exchange.identityKeyId,
      encrypted: true,
    };

    connection.peer = peer;
    this.#byClientId.set(peer.clientId, connection);

    const settle = connection.settle;
    connection.settle = null;
    settle?.resolve(peer);

    this.#handlers.onPeerReady(peer);
    return true;
  }

  #sendHello(connection: Connection): void {
    const identity = this.#handlers.getHello();
    const data: HelloData = { port: identity.port, addresses: identity.addresses };

    if (connection.handshake.phase === 'awaiting-reply' || connection.handshake.phase === 'answering') {
      // The HELLO that completes the key exchange carries our signed exchange;
      // it is always sent as a plaintext seq-0 frame.
      data.keyExchange = encodeKeyExchangeForWire(connection.handshake.mine.exchange);
    }
    // Refresh HELLOs (post-handshake identity updates) need no key exchange.

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
   * Write one envelope on a connection, encrypted once the session is up.
   *
   * Writes are allowed before the handshake completes (the HELLO itself is
   * sent as soon as the socket is created, and Node buffers it until the
   * connection is established). Higher-level sends still go through `sendTo`,
   * which can only resolve a peer that has already completed the handshake.
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
    let wire: Buffer;
    if (connection.handshake.phase === 'established') {
      try {
        wire = encodeSecureFrame(connection.handshake.session, frame);
      } catch {
        this.#destroy(connection, 'error');
        return false;
      }
    } else {
      wire = encodeHandshakeFrame(frame);
    }

    try {
      connection.socket.write(wire, error => {
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
            : reason === 'tofu-mismatch'
              ? 'peer identity key changed (possible impostor)'
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

        if (connection.handshake.phase !== 'established') {
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
