import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { completeInput } from '../../src/tui/completion.js';

function ctx(overrides: Partial<{ members: string[]; rooms: string[] }> = {}) {
  return {
    members: overrides.members ?? [],
    rooms: overrides.rooms ?? [],
  };
}

describe('tab completion — commands', () => {
  it('completes a command from a prefix', () => {
    const result = completeInput('/jo', ctx(), { matchIndex: 0 });

    assert.equal(result.text, '/join');
    assert.deepEqual(result.matches, ['join']);
  });

  it('completes aliases as well as names', () => {
    const result = completeInput('/wh', ctx(), { matchIndex: 0 });
    assert.equal(result.text, '/who');
  });

  it('keeps the leading slash', () => {
    const result = completeInput('/st', ctx(), { matchIndex: 0 });
    assert.equal(result.text, '/status');
  });

  it('rotates through several command matches on repeated tabs', () => {
    // Sorted command words starting with "c": clear, connect, create.
    const first = completeInput('/c', ctx(), { matchIndex: 0 });
    assert.deepEqual(first.matches, ['clear', 'connect', 'create']);
    assert.equal(first.text, '/clear');

    assert.equal(completeInput('/c', ctx(), { matchIndex: 1 }).text, '/connect');
    assert.equal(completeInput('/c', ctx(), { matchIndex: 2 }).text, '/create');
    // Wraps around.
    assert.equal(completeInput('/c', ctx(), { matchIndex: 3 }).text, '/clear');
  });

  it('never completes plain chat into a command', () => {
    const result = completeInput('me too', ctx(), { matchIndex: 0 });
    assert.equal(result.text, 'me too');
    assert.deepEqual(result.matches, []);
  });

  it('leaves a bare slash alone (no needle)', () => {
    const result = completeInput('/', ctx(), { matchIndex: 0 });
    assert.equal(result.text, '/');
    assert.deepEqual(result.matches, []);
  });

  it('returns no match for an unknown command prefix', () => {
    const result = completeInput('/zz', ctx(), { matchIndex: 0 });
    assert.equal(result.text, '/zz');
    assert.deepEqual(result.matches, []);
  });

  it('anchors on an exact command: first tab is a no-op', () => {
    const result = completeInput('/join', ctx({ rooms: ['general'] }), { matchIndex: 0 });
    assert.equal(result.text, '/join');
  });
});

describe('tab completion — usernames', () => {
  const members = ['sam', 'sasha', 'alex'];

  it('completes a member name on a later word', () => {
    const result = completeInput('/me waves sa', ctx({ members }), { matchIndex: 0 });
    assert.equal(result.text, '/me waves sam');
    assert.deepEqual(result.matches, ['sam', 'sasha']);
  });

  it('rotates between two matching members', () => {
    assert.equal(
      completeInput('/me waves sa', ctx({ members }), { matchIndex: 1 }).text,
      '/me waves sasha',
    );
    // Wraps back to the first match.
    assert.equal(
      completeInput('/me waves sa', ctx({ members }), { matchIndex: 2 }).text,
      '/me waves sam',
    );
  });

  it('keeps a typed @ prefix and strips it for matching', () => {
    const result = completeInput('hey @sa', ctx({ members }), { matchIndex: 0 });
    assert.equal(result.text, 'hey @sam');
  });

  it('matches case-insensitively and completes in the member case', () => {
    const result = completeInput('/me SAM', ctx({ members }), { matchIndex: 0 });
    assert.equal(result.text, '/me sam');
  });

  it('anchors on an exact member: first tab is a no-op, next tab cycles', () => {
    const members2 = ['sam', 'sammy'];
    const first = completeInput('/me sam', ctx({ members: members2 }), { matchIndex: 0 });
    assert.equal(first.text, '/me sam');

    const second = completeInput('/me sam', ctx({ members: members2 }), { matchIndex: 1 });
    assert.equal(second.text, '/me sammy');
  });

  it('does not complete usernames on the command word', () => {
    const result = completeInput('sa', ctx({ members }), { matchIndex: 0 });
    assert.equal(result.text, 'sa');
    assert.deepEqual(result.matches, []);
  });

  it('completes usernames in plain chat too (they are just words)', () => {
    const result = completeInput('thanks sa', ctx({ members }), { matchIndex: 0 });
    assert.equal(result.text, 'thanks sam');
  });
});

describe('tab completion — rooms', () => {
  const rooms = ['general', 'gaming', 'lounge'];

  it('completes rooms for /join', () => {
    const result = completeInput('/join #ge', ctx({ rooms }), { matchIndex: 0 });
    assert.equal(result.text, '/join #general');
    assert.deepEqual(result.matches, ['general']);
  });

  it('completes rooms for /create without a # prefix', () => {
    const result = completeInput('/create lo', ctx({ rooms }), { matchIndex: 0 });
    assert.equal(result.text, '/create lounge');
  });

  it('rotates room matches in candidate order', () => {
    const first = completeInput('/join g', ctx({ rooms }), { matchIndex: 0 });
    assert.deepEqual(first.matches, ['general', 'gaming']);
    assert.equal(first.text, '/join general');

    const second = completeInput('/join g', ctx({ rooms }), { matchIndex: 1 });
    assert.equal(second.text, '/join gaming');
  });

  it('does not complete rooms for commands without room arguments', () => {
    const result = completeInput('/me ge', ctx({ rooms }), { matchIndex: 0 });
    assert.equal(result.text, '/me ge');
    assert.deepEqual(result.matches, []);
  });
});

describe('tab completion — editing behaviour', () => {
  it('only ever replaces the last (cursor) word', () => {
    const result = completeInput(
      '/join gaming lo',
      ctx({ rooms: ['gaming', 'lounge'] }),
      { matchIndex: 0 },
    );
    assert.equal(result.text, '/join gaming lounge');
  });

  it('is a no-op on an empty word', () => {
    const result = completeInput('/join ', ctx({ rooms: ['general'] }), { matchIndex: 0 });
    assert.equal(result.text, '/join ');
    assert.deepEqual(result.matches, []);
  });
});
