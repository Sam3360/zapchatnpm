import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTION_BYTE,
  actionBody,
  encodeActionMessage,
  isActionMessage,
  renderAction,
} from '../../src/protocol/actions.js';
import { RateLimiter } from '../../src/protocol/ratelimit.js';
import { createEnvelope, parseMessageData } from '../../src/protocol/messages.js';

describe('action messages (/me)', () => {
  it('frames and identifies an action', () => {
    const framed = encodeActionMessage('waves hello');
    assert.ok(framed !== null);
    assert.ok(isActionMessage(framed));
    assert.equal(actionBody(framed), 'waves hello');
  });

  it('rejects empty actions', () => {
    assert.equal(encodeActionMessage(''), null);
    assert.equal(encodeActionMessage('   '), null);
  });

  it('does not mistake ordinary text for actions', () => {
    assert.equal(isActionMessage('hello there'), false);
    assert.equal(isActionMessage(`${ACTION_BYTE}ACTION no trailing marker`), false);
    assert.equal(isActionMessage(`${ACTION_BYTE}ACTION${ACTION_BYTE}`), false);
  });

  it('renders with the sender as the subject', () => {
    const framed = encodeActionMessage('waves hello');
    assert.ok(framed !== null);
    assert.equal(renderAction('sam', framed), '* sam waves hello');
  });

  it('survives the wire: parseMessageData keeps valid framing', () => {
    const framed = encodeActionMessage('waves');
    assert.ok(framed !== null);
    const parsed = parseMessageData({ text: framed });
    assert.ok(parsed !== null);
    assert.ok(isActionMessage(parsed.text));
    assert.equal(actionBody(parsed.text), 'waves');
  });

  it('strips hostile content inside the action body', () => {
    const hostile = `${ACTION_BYTE}ACTION hi\x1b[31mthere${ACTION_BYTE}`;
    const parsed = parseMessageData({ text: hostile });
    assert.ok(parsed !== null);
    assert.ok(isActionMessage(parsed.text));
    assert.equal(actionBody(parsed.text), 'hithere');
  });

  it('does not let plain chat fake the framing', () => {
    // Only the exact CTCP prefix+suffix pattern is an action. A stray 0x01 in
    // ordinary chat has no framing, so the sanitiser strips the control byte
    // and the text renders as typed.
    const stray = parseMessageData({ text: `hello ${ACTION_BYTE} world` });
    assert.ok(stray !== null);
    assert.equal(isActionMessage(stray.text), false);
    assert.equal(stray.text, 'hello world');

    // A framed prefix without the closing marker is plain text too.
    const prefixOnly = parseMessageData({ text: `${ACTION_BYTE}ACTION sneaky` });
    assert.ok(prefixOnly !== null);
    assert.equal(isActionMessage(prefixOnly.text), false);
    assert.equal(prefixOnly.text, 'ACTION sneaky');
  });

  it('keeps the envelope shape unchanged for actions', () => {
    const framed = encodeActionMessage('waves');
    assert.ok(framed !== null);
    const envelope = createEnvelope('MESSAGE', { clientId: 'zc-test-12345', username: 'sam' }, {
      room: 'general',
      data: { text: framed },
    });
    assert.equal(envelope.type, 'MESSAGE');
    assert.equal(envelope.v, 2);
  });
});

describe('rate limiter', () => {
  it('allows a normal burst and blocks the flood', () => {
    let clock = 1_000;
    const limiter = new RateLimiter({ now: () => clock });

    for (let i = 0; i < 12; i += 1) {
      assert.equal(limiter.allow('peer-a'), true, `burst message ${i}`);
    }
    assert.equal(limiter.allow('peer-a'), false, 'bucket empty');
  });

  it('refills over time', () => {
    let clock = 1_000;
    const limiter = new RateLimiter({ now: () => clock });

    for (let i = 0; i < 12; i += 1) {
      limiter.allow('peer-a');
    }
    assert.equal(limiter.allow('peer-a'), false);

    clock += 1_000; // one second: ~5 tokens back
    assert.equal(limiter.allow('peer-a'), true);
    assert.equal(limiter.allow('peer-a'), true);
    assert.equal(limiter.allow('peer-a'), true);
    assert.equal(limiter.allow('peer-a'), true);
    assert.equal(limiter.allow('peer-a'), true);
    assert.equal(limiter.allow('peer-a'), false); // 5/sec cap reached
  });

  it('tracks peers independently', () => {
    const limiter = new RateLimiter({ now: () => 1_000 });

    for (let i = 0; i < 12; i += 1) {
      limiter.allow('peer-a');
    }
    assert.equal(limiter.allow('peer-a'), false);
    assert.equal(limiter.allow('peer-b'), true);
    assert.equal(limiter.size, 2);
  });

  it('forgets peers so the map cannot grow forever', () => {
    const limiter = new RateLimiter({ now: () => 1_000 });
    limiter.allow('peer-a');
    limiter.forget('peer-a');
    assert.equal(limiter.size, 0);
  });
});
