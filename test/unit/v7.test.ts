import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMMANDS } from '../../src/commands/commands.js';
import { completeInput } from '../../src/tui/completion.js';

function ctx(overrides: Partial<{ members: string[]; rooms: string[] }> = {}) {
  return {
    text: '',
    members: overrides.members ?? [],
    rooms: overrides.rooms ?? [],
  };
}

describe('tab completion — commands', () => {
  it('completes a command from a prefix', () => {
    const state = { matchCount: 0 };
    const result = completeInput('/jo', ctx(), state);

    assert.equal(result.text, '/join');
    assert.deepEqual(result.matches, ['join']);
    assert.equal(state.matchCount, 1);
  });

  it('completes aliases as well as names', () => {
    const result = completeInput('/wh', ctx(), { matchCount: 0 });
    assert.equal(result.text, '/who');
  });

  it('rotates through all commands on repeated tabs', () => {
    const state = { matchCount: 0 };
    const expected = COMMANDS.map(c => c.name).concat(
      COMMANDS.flatMap(c => c.aliases ?? []),
    ).sort();

    const first = completeInput('/', ctx(), state);
    assert.equal(first.matches.length, expected.length);
    assert.equal(first.text, `/${expected[0]}`);

    const second = completeInput('/', ctx(), state);
    assert.equal(second.text, `/${expected[1]}`);

    // Wraps back to the first match after the full rotation.
    let last = second;
    for (let i = 2; i < expected.length; i += 1) {
      last = completeInput('/', ctx(), state);
    }
    assert.equal(last.text, `/${expected[0]}`);
    assert.equal(state.matchCount, expected.length + 1);
  });

  it('never completes plain chat into a command', () => {
    const result = completeInput('me too', ctx(), { matchCount: 0 });
    assert.equal(result.text, 'me too');
    assert.deepEqual(result.matches, []);
  });

  it('returns no match for an unknown command prefix', () => {
    const result = completeInput('/zz', ctx(), { matchCount: 0 });
    assert.equal(result.text, '/zz');
    assert.deepEqual(result.matches, []);
  });

  it('completes an empty command query to the first command', () => {
    const result = completeInput('/', ctx(), { matchCount: 0 });
    assert.ok(result.text.length > 1);
    assert.ok(result.matches.length > 0);
  });
});

describe('tab completion — usernames', () => {
  const members = ['sam', 'sasha', 'alex'];

  it('completes a member name on a later word', () => {
    const result = completeInput('/me waves sa', ctx({ members }), { matchCount: 0 });
    assert.equal(result.text, '/me waves sam');
    assert.deepEqual(result.matches, ['sam', 'sasha']);
  });

  it('rotates between two matching members', () => {
    const state = { matchCount: 0 };
    const first = completeInput('/me waves sa', ctx({ members }), state);
    assert.equal(first.text, '/me waves sam');

    const second = completeInput('/me waves sa', ctx({ members }), state);
    assert.equal(second.text, '/me waves sasha');
  });

  it('keeps a typed @ prefix and strips it for matching', () => {
    const result = completeInput('hey @sa', ctx({ members }), { matchCount: 0 });
    assert.equal(result.text, 'hey @sam');
  });

  it('matches case-insensitively and completes in the member case', () => {
    const result = completeInput('/me SAM', ctx({ members }), { matchCount: 0 });
    assert.equal(result.text, '/me sam');
  });

  it('does not complete usernames on the command word', () => {
    const result = completeInput('sa', ctx({ members }), { matchCount: 0 });
    assert.equal(result.text, 'sa');
    assert.deepEqual(result.matches, []);
  });
});

describe('tab completion — rooms', () => {
  const rooms = ['general', 'gaming', 'lounge'];

  it('completes rooms for /join', () => {
    const result = completeInput('/join #ge', ctx({ rooms }), { matchCount: 0 });
    assert.equal(result.text, '/join #general');
    assert.deepEqual(result.matches, ['general']);
  });

  it('completes rooms for /create without a # prefix', () => {
    const result = completeInput('/create lo', ctx({ rooms }), { matchCount: 0 });
    assert.equal(result.text, '/create lounge');
  });

  it('rotates room matches', () => {
    const state = { matchCount: 0 };
    const first = completeInput('/join g', ctx({ rooms }), state);
    assert.equal(first.text, '/join gaming');
    assert.deepEqual(first.matches, ['gaming', 'general']);

    const second = completeInput('/join g', ctx({ rooms }), state);
    assert.equal(second.text, '/join general');
  });

  it('does not complete rooms for commands without room arguments', () => {
    const result = completeInput('/me ge', ctx({ rooms }), { matchCount: 0 });
    assert.equal(result.text, '/me ge');
    assert.deepEqual(result.matches, []);
  });
});

describe('tab completion — editing behaviour', () => {
  it('preserves the rest of the line after the cursor word', () => {
    // The TUI cursor is always at the end today, but the contract is
    // "replace the cursor word, keep any trailing text".
    const state = { matchCount: 0 };
    const result = completeInput('/join g extra', ctx({ rooms: ['gaming'] }), state);
    assert.equal(result.text, '/join gaming extra');
  });

  it('is a no-op on an empty word', () => {
    const result = completeInput('/join ', ctx({ rooms: ['general'] }), { matchCount: 0 });
    assert.equal(result.text, '/join ');
    assert.deepEqual(result.matches, []);
  });
});
