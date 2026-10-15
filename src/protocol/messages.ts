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
  ACTION_BYTE,
  actionBody,
  isActionMessage,
} from './actions.js';
import {
  FILE_CHUNK_BYTES,
  MAX_ADDRESSES,
  MAX_CLOCK_SKEW_MS,
  MAX_FILE_BYTES,
  MAX_FILE_CHUNKS,
  MAX_FILE_NAME_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_PEERS,
  MAX_REACTION_CHARS,
  MIN_ID_PREFIX_CHARS,
  PROTOCOL_VERSION,
  REACTION_SET,
  SUPPORTED_WIRE_VERSIONS,
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
  // ---- v8: everything below is additive. Older peers drop these frames at
  // ---- parse time (unknown type ⇒ null) exactly like v1 peers do with v2
  // ---- HELLO key exchanges: no crash, no misparse, full interop.
  /** A chat message that visually quotes/replies to an earlier message. */
  'REPLY',
  /** An emoji reaction attached to an earlier message. */
  'REACTION',
  /** Offer to send a file: metadata only, no payload (receiver must accept). */
  'FILE_OFFER',
  /** The receiver agrees to accept an offered file. */
  'FILE_ACCEPT',
  /** The receiver declines an offered file. */
  'FILE_REJECT',
  /** One base64 chunk of an accepted file. */
  'FILE_CHUNK',
  /** The sender has sent the final chunk of a file. */
  'FILE_COMPLETE',
  /** Either side aborts an in-flight transfer. */
  'FILE_CANCEL',
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

// ---- v8 payload shapes (wire keys are camelCase on both stacks) ----------

export interface ReplyData {
  text: string;
  /** Message id (or unique prefix) the reply visually quotes. */
  replyTo: string;
}

export interface ReactionData {
  /** Message id (or unique prefix) being reacted to. */
  target: string;
  /** Must be a member of REACTION_SET. */
  reaction: string;
}

export interface FileOfferData {
  transferId: string;
  /** Bare file name only (no path parts survive parsing). */
  name: string;
  /** Exact size in bytes; receivers refuse anything over MAX_FILE_BYTES. */
  size: number;
  /** Optional MIME-ish hint, display only. */
  mime?: string;
}

export interface FileAcceptData {
  transferId: string;
}

export interface FileRejectData {
  transferId: string;
}

export interface FileChunkData {
  transferId: string;
  /** Zero-based chunk index. */
  index: number;
  /** Base64 payload; decoded size must be ≤ FILE_CHUNK_BYTES. */
  data: string;
}

export interface FileCompleteData {
  transferId: string;
}

export interface FileCancelData {
  transferId: string;
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
  /** Wire version to stamp (default: our native version). */
  version?: number;
}

/** Build an envelope from an identity. Senders always use this helper. */
export function createEnvelope(
  type: MessageType,
  sender: EnvelopeSender,
  options: CreateEnvelopeOptions = {},
): Envelope {
  return {
    v: options.version ?? PROTOCOL_VERSION,
    id: options.id ?? newMessageId(),
    type,
    ts: options.ts ?? Date.now(),
    from: sender.clientId,
    username: sender.username,
    room: options.room ?? null,
    data: options.data ?? null,
  };
}

const DEFAULT_WIRE_VERSION_SET: ReadonlySet<number> = new Set([PROTOCOL_VERSION]);

/** Set of every wire version this build can parse (discovery + plaintext links). */
export const SUPPORTED_WIRE_VERSION_SET: ReadonlySet<number> = new Set<number>(SUPPORTED_WIRE_VERSIONS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ParseEnvelopeResult {
  envelope: Envelope;
  /** Wire version the sender used (1 = legacy/Python, 2 = encrypted-capable). */
  wireVersion: number;
}

/**
 * Re-stamp an envelope for a peer that speaks a different wire version.
 *
 * Envelope shapes are identical across v1 and v2 (same routing metadata, same
 * payloads), so relaying a v1-sourced message to a v2 peer is a pure version
 * rewrite: the id, timestamps and text are untouched. Returns null when the
 * target version is unsupported, so callers drop rather than guess.
 */
export function rewriteEnvelopeForWire(
  envelope: Envelope,
  targetVersion: number,
): Envelope | null {
  if (!SUPPORTED_WIRE_VERSION_SET.has(targetVersion) || envelope.v === targetVersion) {
    return envelope.v === targetVersion ? envelope : null;
  }

  return { ...envelope, v: targetVersion };
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

  // CTCP-style action framing (0x01 ACTION ... 0x01) must be checked BEFORE
  // sanitising: the control-byte strip would otherwise destroy the framing of
  // legitimate actions. The body between the markers is sanitised normally.
  if (isActionMessage(raw)) {
    const body = sanitizeMessageText(actionBody(raw));
    return body.length === 0 ? null : { text: `${ACTION_BYTE}ACTION ${body}${ACTION_BYTE}` };
  }

  const text = sanitizeMessageText(raw);
  return text.length === 0 ? null : { text };
}

/**
 * A message-id reference (reply target / reaction target). Accepts a full id
 * or a unique prefix; anything malformed is rejected so hostile peers cannot
 * smuggle junk into the timeline metadata.
 */
export function parseMessageRef(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length < MIN_ID_PREFIX_CHARS || trimmed.length > 64) {
    return null;
  }

  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

export function parseReplyData(data: unknown): ReplyData | null {
  if (!isPlainObject(data)) {
    return null;
  }

  const replyTo = parseMessageRef(data['replyTo']);
  if (replyTo === null) {
    return null;
  }

  const raw = data['text'];
  if (typeof raw !== 'string' || charLength(raw) > MAX_MESSAGE_CHARS * 4) {
    return null;
  }

  const text = sanitizeMessageText(raw);
  return text.length === 0 ? null : { text, replyTo };
}

export function parseReactionData(data: unknown): ReactionData | null {
  if (!isPlainObject(data)) {
    return null;
  }

  const target = parseMessageRef(data['target']);
  const reaction = data['reaction'];
  if (target === null || typeof reaction !== 'string') {
    return null;
  }

  // Emoji are multi-code-point; compare against the allow-list exactly.
  if (charLength(reaction) > MAX_REACTION_CHARS) {
    return null;
  }

  return (REACTION_SET as readonly string[]).includes(reaction) ? { target, reaction } : null;
}

function parseTransferId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return value.length >= 8 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

export function parseFileOfferData(data: unknown): FileOfferData | null {
  if (!isPlainObject(data)) {
    return null;
  }

  const transferId = parseTransferId(data['transferId']);
  const size = data['size'];
  if (transferId === null || typeof size !== 'number' || !Number.isInteger(size)) {
    return null;
  }

  if (size <= 0 || size > MAX_FILE_BYTES) {
    return null;
  }

  // Names are display-only and must never carry path parts (path traversal):
  // strip every separator, keep only the final bare component.
  const rawName = typeof data['name'] === 'string' ? data['name'] : '';
  const bare = rawName.split(/[\\/]/).pop() ?? '';
  const name = truncateChars(stripControlSequences(bare).trim(), MAX_FILE_NAME_CHARS);
  if (name.length === 0 || name === '.' || name === '..') {
    return null;
  }

  const mimeRaw = data['mime'];
  const mime =
    typeof mimeRaw === 'string' && mimeRaw.length > 0 && mimeRaw.length <= 64
      ? truncateChars(stripControlSequences(mimeRaw).trim(), 64)
      : undefined;

  return {
    transferId,
    name,
    size,
    ...(mime !== undefined && mime.length > 0 ? { mime } : {}),
  };
}

interface TransferIdPayload {
  transferId: string;
}

function parseTransferIdData(data: unknown): TransferIdPayload | null {
  if (!isPlainObject(data)) {
    return null;
  }

  const transferId = parseTransferId(data['transferId']);
  return transferId === null ? null : { transferId };
}

export function parseFileChunkData(data: unknown): FileChunkData | null {
  if (!isPlainObject(data)) {
    return null;
  }

  const transferId = parseTransferId(data['transferId']);
  const index = data['index'];
  if (transferId === null || typeof index !== 'number' || !Number.isInteger(index)) {
    return null;
  }

  if (index < 0 || index >= MAX_FILE_CHUNKS) {
    return null;
  }

  const encoded = data['data'];
  if (typeof encoded !== 'string' || encoded.length === 0) {
    return null;
  }

  // Hard cap before decoding: base64 of FILE_CHUNK_BYTES is ~5.5 KiB; anything
  // larger can never be legal and must not reach Buffer.from (memory guard).
  if (encoded.length > Math.ceil(FILE_CHUNK_BYTES / 3) * 4 + 8) {
    return null;
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return null;
  }

  return { transferId, index, data: encoded };
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

export function readReplyData(envelope: Envelope): ReplyData | null {
  return parseReplyData(envelope.data);
}

export function readReactionData(envelope: Envelope): ReactionData | null {
  return parseReactionData(envelope.data);
}

export function readFileOfferData(envelope: Envelope): FileOfferData | null {
  return parseFileOfferData(envelope.data);
}

export function readFileChunkData(envelope: Envelope): FileChunkData | null {
  return parseFileChunkData(envelope.data);
}

export function readTransferIdData(envelope: Envelope): TransferIdPayload | null {
  return parseTransferIdData(envelope.data);
}

export interface ParseEnvelopeOptions {
  /** Current time, injectable for tests. */
  now?: number;
  /** Set to false to accept envelopes with a skewed timestamp. */
  checkClockSkew?: boolean;
  /** Wire versions to accept (default: our native version only). */
  allowedVersions?: ReadonlySet<number>;
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

  const allowed = options.allowedVersions ?? DEFAULT_WIRE_VERSION_SET;
  const rawVersion = value['v'];
  if (typeof rawVersion !== 'number' || !allowed.has(rawVersion)) {
    return null;
  }
  // Remember the version the peer speaks so per-link behaviour can adapt.
  const wireVersion = rawVersion;

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
    v: wireVersion,
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
    case 'REPLY':
      return readReplyData(envelope) === null ? null : envelope;
    case 'REACTION':
      return readReactionData(envelope) === null ? null : envelope;
    case 'FILE_OFFER':
      return readFileOfferData(envelope) === null ? null : envelope;
    case 'FILE_CHUNK':
      return readFileChunkData(envelope) === null ? null : envelope;
    case 'FILE_ACCEPT':
    case 'FILE_REJECT':
    case 'FILE_COMPLETE':
    case 'FILE_CANCEL':
      return isPlainObject(envelope.data) && parseTransferId(envelope.data['transferId']) !== null
        ? envelope
        : null;
    case 'JOIN':
    case 'LEAVE':
    case 'PING':
    case 'PONG':
      return envelope;
    default:
      return null;
  }
}
