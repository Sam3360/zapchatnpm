import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseEnvelope,
  parseReplyData,
  parseReactionData,
  parseFileOfferData,
  parseFileChunkData,
} from '../../src/protocol/messages.js';
import {
  MAX_FILE_BYTES,
  MAX_REACTION_CHARS,
  MAX_FILE_CHUNKS,
  MAX_ACTIVE_TRANSFERS,
  RECEIVED_FILES_DIR,
} from '../../src/protocol/constants.js';

describe('protocol — v8 payloads', () => {
  it('parseReplyData keeps a valid reply', () => {
    const result = parseReplyData({
      text: 'see above',
      replyTo: 'aBc12345',
    });
    assert.ok(result);
    assert.equal(result.text, 'see above');
    assert.equal(result.replyTo, 'aBc12345');
  });

  it('parseReplyData rejects too-short replyTo', () => {
    assert.ok(parseReplyData({ text: 'hi', replyTo: 'abc' }) === null);
  });

  it('parseReactionData accepts an allowed reaction', () => {
    const r = parseReactionData({ target: 'aBc12345', reaction: '+1' });
    assert.ok(r);
    assert.equal(r.reaction, '+1');
  });

  it('parseReactionData rejects a reaction outside the set', () => {
    assert.ok(parseReactionData({ target: 'aBc12345', reaction: ':-)' }) === null);
  });

  it('parseReactionData rejects a too-long reaction', () => {
    const tooLong = 'a'.repeat(MAX_REACTION_CHARS + 1);
    assert.ok(parseReactionData({ target: 'aBc12345', reaction: tooLong }) === null);
  });

  it('parseFileOfferData sanitises a path-traversal name to a bare component', () => {
    const safe = parseFileOfferData({ transferId: 'transfer-001', name: '../etc/passwd', size: 100 });
    assert.ok(safe !== null);
    assert.equal(safe!.name, 'passwd');
  });

  it('parseFileOfferData rejects a dot-only name', () => {
    assert.ok(parseFileOfferData({ transferId: 'transfer-001b', name: '..', size: 100 }) === null);
  });

  it('parseFileOfferData rejects a totally empty name', () => {
    assert.ok(parseFileOfferData({ transferId: 'transfer-001c', name: '', size: 100 }) === null);
  });

  it('parseFileOfferData accepts a bare file name', () => {
    const offer = parseFileOfferData({ transferId: 'transfer-002', name: 'notes.txt', size: 1200 });
    assert.ok(offer);
    assert.equal(offer.name, 'notes.txt');
    assert.equal(offer.size, 1200);
  });

  it('parseFileOfferData rejects a size over the cap', () => {
    assert.ok(parseFileOfferData({ transferId: 't', name: 'big.bin', size: MAX_FILE_BYTES + 1 }) === null);
  });

  it('parseFileChunkData accepts a valid chunk', () => {
    const chunk = parseFileChunkData({ transferId: 'transfer-003', index: 0, data: 'AA==' });
    assert.ok(chunk);
    assert.equal(chunk.index, 0);
  });

  it('parseFileChunkData rejects an out-of-range index', () => {
    assert.ok(parseFileChunkData({ transferId: 't', index: MAX_FILE_CHUNKS, data: 'AA==' }) === null);
  });

  it('parseEnvelope validates a REPLY envelope', () => {
    const env = parseEnvelope({
      v: 2,
      id: 'aBc123456789',
      type: 'REPLY',
      ts: Date.now(),
      from: 'zc-valid-id',
      username: 'sam',
      room: 'general',
      data: { text: 'quoted', replyTo: 'aBc12345' },
    });
    assert.ok(env);
    assert.equal(env.type, 'REPLY');
  });

  it('parseEnvelope validates a REACTION envelope', () => {
    const env = parseEnvelope({
      v: 2,
      id: 'aBc123456789',
      type: 'REACTION',
      ts: Date.now(),
      from: 'zc-valid-id',
      username: 'sam',
      room: 'general',
      data: { target: 'aBc12345', reaction: '❤' },
    });
    assert.ok(env);
    assert.equal(env.type, 'REACTION');
  });

  it('parseEnvelope validates a FILE_OFFER envelope', () => {
    const env = parseEnvelope({
      v: 2,
      id: 'aBc123456789',
      type: 'FILE_OFFER',
      ts: Date.now(),
      from: 'zc-valid-id',
      username: 'sam',
      room: 'general',
      data: { transferId: 'transfer-004', name: 'doc.pdf', size: 500 },
    });
    assert.ok(env);
    assert.equal(env.type, 'FILE_OFFER');
  });

  it('parseEnvelope validates transfer-id-only file control envelopes', () => {
    for (const type of ['FILE_ACCEPT', 'FILE_REJECT', 'FILE_COMPLETE', 'FILE_CANCEL'] as const) {
      const env = parseEnvelope({
        v: 2,
        id: 'aBc123456789',
        type,
        ts: Date.now(),
        from: 'zc-valid-id',
        username: 'sam',
        room: 'general',
        data: { transferId: 'transfer-005' },
      });
      assert.ok(env, `should accept ${type}`);
      assert.equal(env.type, type);
    }
  });

  it('parseEnvelope rejects REACTION with a disallowed reaction on the wire', () => {
    // 'ok' is in REACTION_SET, so this should parse; a non-set value must not.
    const envBad = parseEnvelope({
      v: 2,
      id: 'aBc123456789',
      type: 'REACTION',
      ts: Date.now(),
      from: 'zc-valid-id',
      username: 'sam',
      room: 'general',
      data: { target: 'aBc12345', reaction: 'notallowed' },
    });
    assert.ok(envBad === null);
  });

  it('constants expose RECEIVED_FILES_DIR and MAX_ACTIVE_TRANSFERS', () => {
    assert.equal(RECEIVED_FILES_DIR, 'zapchat-received');
    assert.ok(Number.isInteger(MAX_ACTIVE_TRANSFERS) && MAX_ACTIVE_TRANSFERS > 0);
  });
});
