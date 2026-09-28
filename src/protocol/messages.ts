/**
 * The zapchat wire protocol.
 *
 * Every message on the wire is one JSON `Envelope`, newline-delimited over TCP
 * and sent as a single datagram over UDP. The envelope carries routing metadata
 * (who sent it, which room it belongs to, a unique id and a timestamp) and a
 * `data` payload whose shape depends on `type`.
 *
 * Nothing is trusted: `parseEnvelope` returns `null` for anything that does not
 * match the expected shape, and callers simply drop those frames.
 */

import { randomUUID } from 'node:crypto';
import {
  MAX_ADDRESSES,
  MAX_CLOCK_SKEW_MS,
  MAX_MESSAGE_CHARS,
  MAX_PEERS,
  PROTOCOL_VERSION,
} from './constants.js';
import {
  charLength,
  isValidClientId,
  isValidPort,
  sanitizeAddressList,
  sanitizeMessageText,
  sanitizeRoomName,
  sanitizeUsername,
  stripControlSequences,
  truncateChars,
} from './sanitize.js';

export const MESSAGE_TYPES = [
  /** TCP handshake: identity + listening port. May be resent to update identity. */
  'HELLO',
  /** UDP discovery beacon: "I exist, here is my running config". */
  'ANNOUNCE',
  /** Rooms the sender currently knows about. */
  'ROOM_LIST',
  /** Other peers the sender knows about (used for gossip / manual connect). */
  'PEER_LIST',
  /** The sender entered a room. */
  'JOIN',
  /** The sender left its room. */
  'LEAVE',
  /** A chat message scoped to a room. */
  'MESSAGE',
  /** Liveness probe. */
  'PING',
  /** Liveness reply. */
  'PONG',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

const MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(MESSAGE_TYPES);

const ENVELOPE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Identity of the client sending an envelope. */
export interface EnvelopeSender {
  clientId: string;
  username: string;
}

export interface Envelope {
  /** Protocol version. */
  v: number;
  /** Unique message id (used for duplicate suppression). */
  id: string;
  type: MessageType;
  /** Sender clock, milliseconds since epoch. */
  ts: number;
  /** Sender client id. */
  from: string;
  /** Sender display name, already sanitised. */
  username: string;
  /** Room this envelope is scoped to, or `null` when it is not room-scoped. */
  room: string | null;
  data: unknown;
}

export interface HelloData {
  /** TCP port the sender is listening on. */
  port: number;
  /** IPv4 addresses the sender believes it can be reached on. */
  addresses: string[];
  /**
   * Protocol v2 key exchange: ephemeral X25519 public key, its fingerprint and
   * a fresh nonce (all base64). Present in every v2 HELLO.
   */
  keyExchange?: Record<string, unknown>;
}

export interface AnnounceData extends HelloData {
  /** Rooms the sender is currently hosting / interested in. */
  rooms: string[];
}

export interface RoomCount {
  name: string;
  online: number;
}

export interface RoomListData {
  rooms: RoomCount[];
}

export interface PeerContact {
  clientId: string;
  username: string;
  room: string | null;
  port: number;
  addresses: string[];
}

export interface PeerListData {
  peers: PeerContact[];
}

export interface MessageData {
  text: string;
}

/** Generate a fresh, collision-resistant message id. */
export function newMessageId(): string {
  return randomUUID();
}

export interface CreateEnvelopeOptions {
  id?: string;
  ts?: number;
  room?: string | null;
  data?: unknown;
}

/** Build an envelope from an identity. Senders always use this helper. */
export function createEnvelope(
  type: MessageType,
  sender: EnvelopeSender,
  options: CreateEnvelopeOptions = {},
): Envelope {
  return {
    v: PROTOCOL_VERSION,
    id: options.id ?? newMessageId(),
    type,
    ts: options.ts ?? Date.now(),
    from: sender.clientId,
    username: sender.username,
    room: options.room ?? null,
    data: options.data ?? null,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Usernames from the wire are only ever used for display, so we repair rather
 * than reject: strip anything dangerous, cap the length, and fall back to a
 * placeholder so a peer with a broken name is still reachable.
 */
function coerceWireUsername(value: unknown): string {
  if (typeof value !== 'string') {
    return 'unnamed';
  }

  return sanitizeUsername(value) ?? (truncateChars(stripControlSequences(value).trim(), 20) || 'unnamed');
}

function coerceRoom(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    return undefined; // invalid → reject the envelope
  }

  return sanitizeRoomName(value) ?? undefined;
}

function parsePort(value: unknown): number | null {
  return isValidPort(value) ? value : null;
}

export function parseHelloData(data: unknown): HelloData | null {
  if (!isPlainObject(data)) {
    return null;
  }

  const port = parsePort(data['port']);
  if (port === null) {
    return null;
  }

  // The key exchange is opaque here (validated by protocol/handshake.ts); keep
  // it only when it is a plain object so the envelope shape stays strict.
  const keyExchangeRaw = data['keyExchange'];
  const keyExchange: Record<string, unknown> | undefined =
    typeof keyExchangeRaw === 'object' && keyExchangeRaw !== null && !Array.isArray(keyExchangeRaw)
      ? (keyExchangeRaw as Record<string, unknown>)
      : undefined;

  return {
    port,
    addresses: sanitizeAddressList(data['addresses'], MAX_ADDRESSES),
    ...(keyExchange !== undefined ? { keyExchange } : {}),
  };
}

export function parseAnnounceData(data: unknown): AnnounceData | null {
  const hello = parseHelloData(data);
  if (hello === null || !isPlainObject(data)) {
    return null;
  }

  const rooms: string[] = [];
  const rawRooms = data['rooms'];
  if (Array.isArray(rawRooms)) {
    for (const candidate of rawRooms) {
      if (typeof candidate !== 'string') {
        continue;
      }

      const room = sanitizeRoomName(candidate);
      if (room !== null && !rooms.includes(room)) {
        rooms.push(room);
      }
    }
  }

  return { ...hello, rooms };
}

export function parseRoomListData(data: unknown): RoomListData | null {
  if (!isPlainObject(data) || !Array.isArray(data['rooms'])) {
    return null;
  }

  const rooms: RoomCount[] = [];
  for (const entry of data['rooms'].slice(0, MAX_PEERS * 2)) {
    if (!isPlainObject(entry)) {
      continue;
    }

    if (typeof entry['name'] !== 'string') {
      continue;
    }

    const name = sanitizeRoomName(entry['name']);
    if (name === null) {
      continue;
    }

    const online = Number(entry['online']);
    rooms.push({
      name,
      online: Number.isInteger(online) && online >= 0 && online <= 1000 ? online : 0,
    });

    if (rooms.length >= MAX_PEERS * 2) {
      break;
    }
  }

  return { rooms };
}

export function parsePeerContact(entry: unknown): PeerContact | null {
  if (!isPlainObject(entry)) {
    return null;
  }

  const clientId = entry['clientId'];
  const port = parsePort(entry['port']);
  if (!isValidClientId(clientId) || port === null) {
    return null;
  }

  const roomRaw = entry['room'];
  const room =
    roomRaw === null || roomRaw === undefined
      ? null
      : typeof roomRaw === 'string'
        ? sanitizeRoomName(roomRaw)
        : null;

  return {
    clientId,
    username: coerceWireUsername(entry['username']),
    room,
    port,
    addresses: sanitizeAddressList(entry['addresses'], MAX_ADDRESSES),
  };
}

export function parsePeerListData(data: unknown): PeerListData | null {
  if (!isPlainObject(data) || !Array.isArray(data['peers'])) {
    return null;
  }

  const peers: PeerContact[] = [];
  for (const entry of data['peers'].slice(0, MAX_PEERS)) {
    const contact = parsePeerContact(entry);
    if (contact !== null) {
      peers.push(contact);
    }
  }

  return { peers };
}

export function parseMessageData(data: unknown): MessageData | null {
  if (!isPlainObject(data) || typeof data['text'] !== 'string') {
    return null;
  }

  const raw = data['text'];
  // Reject absurd payloads before doing any work on them.
  if (charLength(raw) > MAX_MESSAGE_CHARS * 4) {
    return null;
  }

  const text = sanitizeMessageText(raw);
  return text.length === 0 ? null : { text };
}

/** Type-guard helpers so consumers can narrow `envelope.data` safely. */
export function readHelloData(envelope: Envelope): HelloData | null {
  return parseHelloData(envelope.data);
}

export function readAnnounceData(envelope: Envelope): AnnounceData | null {
  return parseAnnounceData(envelope.data);
}

export function readRoomListData(envelope: Envelope): RoomListData | null {
  return parseRoomListData(envelope.data);
}

export function readPeerListData(envelope: Envelope): PeerListData | null {
  return parsePeerListData(envelope.data);
}

export function readMessageData(envelope: Envelope): MessageData | null {
  return parseMessageData(envelope.data);
}

export interface ParseEnvelopeOptions {
  /** Current time, injectable for tests. */
  now?: number;
  /** Set to false to accept envelopes with a skewed timestamp. */
  checkClockSkew?: boolean;
}

/**
 * Validate an untrusted value into an `Envelope`.
 *
 * Returns `null` for malformed input. The returned envelope has been sanitised:
 * `username` is display-safe and `room` is canonical.
 */
export function parseEnvelope(
  value: unknown,
  options: ParseEnvelopeOptions = {},
): Envelope | null {
  if (!isPlainObject(value)) {
    return null;
  }

  if (value['v'] !== PROTOCOL_VERSION) {
    return null;
  }

  const id = value['id'];
  if (typeof id !== 'string' || !ENVELOPE_ID_PATTERN.test(id)) {
    return null;
  }

  const type = value['type'];
  if (typeof type !== 'string' || !MESSAGE_TYPE_SET.has(type)) {
    return null;
  }

  const from = value['from'];
  if (!isValidClientId(from)) {
    return null;
  }

  const ts = value['ts'];
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
    return null;
  }

  if (options.checkClockSkew !== false) {
    const now = options.now ?? Date.now();
    if (Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) {
      return null;
    }
  }

  const room = coerceRoom(value['room']);
  if (room === undefined) {
    return null;
  }

  const envelope: Envelope = {
    v: PROTOCOL_VERSION,
    id,
    type: type as MessageType,
    ts,
    from,
    username: coerceWireUsername(value['username']),
    room: room ?? null,
    data: value['data'] ?? null,
  };

  // Validate the payload shape for the types we act on. PING/PONG carry no data.
  switch (envelope.type) {
    case 'HELLO':
      return readHelloData(envelope) === null ? null : envelope;
    case 'ANNOUNCE':
      return readAnnounceData(envelope) === null ? null : envelope;
    case 'ROOM_LIST':
      return readRoomListData(envelope) === null ? null : envelope;
    case 'PEER_LIST':
      return readPeerListData(envelope) === null ? null : envelope;
    case 'MESSAGE':
      return readMessageData(envelope) === null ? null : envelope;
    case 'JOIN':
    case 'LEAVE':
    case 'PING':
    case 'PONG':
      return envelope;
    default:
      return null;
  }
}
