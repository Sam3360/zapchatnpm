/**
 * zapchat — public library entry point.
 *
 * The CLI is the main way to use this package, but everything is importable so
 * the networking core can be embedded, scripted or tested:
 *
 * ```ts
 * import { createClient } from 'zapchat';
 *
 * const client = createClient({ username: 'sam', room: 'general' });
 * await client.start();
 * client.send('hello LAN');
 * ```
 */

export { ZapClient, createClient } from './core/client.js';
export type {
  ActionResult,
  PeerSnapshot,
  Snapshot,
  StatusSnapshot,
  NoticeSnapshot,
  ZapClientOptions,
} from './core/client.js';

export { RoomRegistry, mergeAddresses } from './rooms/registry.js';
export type {
  ChatMessage,
  PeerRecord,
  RoomRegistryOptions,
  RoomSummary,
} from './rooms/registry.js';

export { DiscoveryService, buildBeacon, explainSocketError } from './discovery/discovery.js';
export type {
  AnnounceObservation,
  AnnounceSnapshot,
  AnnouncedPeer,
  DiscoveryKind,
  DiscoveryOptions,
  DiscoveryState,
} from './discovery/discovery.js';

export { TcpTransport, friendlyConnectError } from './network/transport.js';
export type {
  PeerGoneReason,
  PeerHandle,
  TransportHandlers,
  TransportOptions,
} from './network/transport.js';

export {
  broadcastFor,
  describeNetwork,
  listLocalInterfaces,
  localAddresses,
  localBroadcasts,
} from './network/interfaces.js';
export type { LocalInterface } from './network/interfaces.js';

export {
  createEnvelope,
  newMessageId,
  parseAnnounceData,
  parseEnvelope,
  parseHelloData,
  parseMessageData,
  parsePeerContact,
  parsePeerListData,
  parseRoomListData,
  readHelloData,
  readMessageData,
  readPeerListData,
  readRoomListData,
  MESSAGE_TYPES,
} from './protocol/messages.js';
export type {
  AnnounceData,
  Envelope,
  EnvelopeSender,
  HelloData,
  MessageData,
  MessageType,
  PeerContact,
  PeerListData,
  RoomCount,
  RoomListData,
} from './protocol/messages.js';

export { FrameDecoder, encodeFrame, FRAME_DELIMITER } from './protocol/framing.js';
export type { FrameDecoderOptions, FrameDecoderStats } from './protocol/framing.js';

export {
  charLength,
  isValidClientId,
  isValidHost,
  isValidIpv4,
  isValidPort,
  isValidRoomName,
  isValidUsername,
  sanitizeAddressList,
  sanitizeMessageText,
  sanitizeRoomName,
  sanitizeUsername,
  stripControlSequences,
  truncateChars,
} from './protocol/sanitize.js';

export * from './protocol/constants.js';

export { loadConfig, saveConfigTo, updateConfig } from './config/config.js';
export type { Config, LoadConfigResult } from './config/config.js';
export { resolveConfigDir, resolveConfigPath } from './config/paths.js';
export { createClientId, defaultUsername, randomUsername } from './config/identity.js';

export { COMMANDS, parseCommand, helpLines } from './commands/commands.js';
export type { CommandSpec, ParsedCommand } from './commands/commands.js';

export { VERSION } from './version.js';
