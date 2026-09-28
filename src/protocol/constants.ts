/**
 * Protocol-wide limits and defaults.
 *
 * The protocol is deliberately tiny: newline-delimited JSON envelopes over TCP
 * for messaging, and the same envelope shape over UDP for discovery beacons.
 * Every limit here exists to keep a hostile or buggy peer from crashing us or
 * exhausting memory.
 */

/**
 * Wire protocol version. Peers with a different version refuse to talk.
 *
 * v2 hardens the TCP mesh: every connection runs an ephemeral X25519 key
 * exchange and all data frames are sealed with AES-256-GCM (see
 * `protocol/crypto.ts`, `protocol/secureFraming.ts`, `protocol/handshake.ts`).
 * There is no fallback to v1 — a v1 peer is refused with an upgrade notice.
 */
export const PROTOCOL_VERSION = 2;

/** First byte of every v2 TCP frame; a v1 peer never emits it. */
export const MAGIC_BYTE = 0xc2;

/** v2 TCP frame header: magic(1) + sequence(8) + payload length(4). */
export const HEADER_BYTES = 13;

/** Largest v2 TCP frame payload we will accept (sealed envelope room + headroom). */
export const MAX_SECURE_PAYLOAD_BYTES = 16 * 1024;

/** Upper bound on v2 sequence numbers (JSON-safe, far beyond any session). */
export const MAX_SEQ = 2 ** 53 - 1;

/** Length of an X25519 public key on the wire. */
export const PUBLIC_KEY_BYTES = 32;

/** Seconds a peer's TOFU key pin stays trusted after its last sighting. */
export const PEER_PIN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** UDP port used for discovery beacons (multicast + broadcast). */
export const DEFAULT_DISCOVERY_PORT = 45912;

/** IPv4 multicast group used for discovery. Administratively scoped (local). */
export const DEFAULT_MULTICAST_ADDRESS = '239.255.42.99';

/** First TCP port we try to listen on. `/connect <ip>` without a port uses this. */
export const DEFAULT_TCP_PORT_BASE = 45913;

/** How many sequential TCP ports to try before falling back to an ephemeral port. */
export const TCP_PORT_ATTEMPTS = 12;

/** Largest UDP beacon we will send, and the largest we will accept. */
export const MAX_UDP_PACKET_BYTES = 1100;

/** Largest single TCP frame (one JSON envelope) we will accept. */
export const MAX_FRAME_BYTES = 8 * 1024;

/** Bytes of entropy in a handshake freshness nonce. */
export const HANDSHAKE_NONCE_BYTES = 32;

/** Largest chat message body, in Unicode code points. */
export const MAX_MESSAGE_CHARS = 1000;

export const MAX_USERNAME_LENGTH = 20;
export const MAX_ROOM_NAME_LENGTH = 20;

/** Upper bound on advertised LAN addresses inside a beacon. */
export const MAX_ADDRESSES = 8;

/** Upper bound on rooms a client advertises in a beacon. */
export const MAX_ADVERTISED_ROOMS = 8;

/** Discovery beacon cadence. */
export const ANNOUNCE_INTERVAL_MS = 2000;

/** A peer that has not announced for this long is considered gone. */
export const PEER_STALE_MS = 7000;

/** Rooms learned from the LAN are forgotten after this long if not refreshed. */
export const KNOWN_ROOM_TTL_MS = 10 * 60 * 1000;

/** TCP keepalive: how often we send PING on an idle link. */
export const PING_INTERVAL_MS = 5000;

/** TCP keepalive: drop a link that has been silent for this long. */
export const PEER_SILENCE_MS = 16000;

/** Time an inbound TCP connection has to send a valid HELLO before we drop it. */
export const HELLO_TIMEOUT_MS = 5000;

/** Reconnect backoff for a discovered-but-unconnected peer. */
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 15000;

/** Hard cap on simultaneous TCP peers. */
export const MAX_PEERS = 64;

/** How many message ids we remember for duplicate suppression. */
export const DEDUP_CACHE_SIZE = 1024;

/** How many message ids we keep before purging ids older than the window. */
export const DEDUP_WINDOW_MS = 5 * 60 * 1000;

/** In-memory chat history per room. Never written to disk in v1. */
export const HISTORY_LIMIT = 400;

/** Drop a peer whose socket write buffer grows past this (memory guard). */
export const MAX_PENDING_WRITE_BYTES = 1024 * 1024;

/** Interval of the internal presence/reconnect sweep. */
export const SWEEP_INTERVAL_MS = 1000;

/** Default room used when the user just wants to chat now. */
export const DEFAULT_ROOM = 'general';

/** Tolerance for incoming timestamps (beacon/frame skew). */
export const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
