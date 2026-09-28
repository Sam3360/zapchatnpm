/**
 * Render tests for the TUI.
 *
 * These render the real components (not mocks) to a string and assert the
 * structural invariants that keep the interface from breaking a terminal:
 * the frame never exceeds the terminal height, no row is wider than the frame,
 * and the important chrome (header, prompt, messages) is present.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderToString } from 'ink';
import { describe, it } from 'node:test';
import { App } from '../../src/tui/App.js';
import { LobbyScreen } from '../../src/tui/screens/LobbyScreen.js';
import { RoomScreen } from '../../src/tui/screens/RoomScreen.js';
import { WelcomeScreen } from '../../src/tui/screens/WelcomeScreen.js';
import { ZapClient } from '../../src/core/client.js';
import { computeLayout } from '../../src/tui/view/layout.js';
import { displayWidth, wrapText } from '../../src/tui/view/text.js';
import { graphemes } from '../../src/tui/view/text.js';
import type { LineEditor } from '../../src/tui/hooks.js';
import { makeMessage, makePeer, makeSnapshot } from '../helpers/snapshot.js';

const COLUMNS = 80;
const ROWS = 24;

function tempClient(options: { username?: string; room?: string } = {}): ZapClient {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapchat-render-'));
  return new ZapClient({
    configPath: path.join(dir, 'config.json'),
    ...options,
  });
}

/** A stand-in editor: the screens only read state from it during a render. */
function fakeEditor(text = '', cursor = text.length): LineEditor {
  return {
    state: { text, cursor },
    isEmpty: text.length === 0,
    handleKey: () => 'none',
    read: () => ({ text, cursor }),
    setText: () => {},
    reset: () => {},
    pushHistory: () => {},
  };
}

function lines(output: string): string[] {
  return output.split('\n');
}

/** Assert the rendered frame fits inside the terminal it was told about. */
function assertFits(output: string, columns = COLUMNS, rows = ROWS): void {
  const rendered = lines(output);
  const widest = Math.max(...rendered.map(line => displayWidth(line)));
  assert.ok(
    rendered.length <= rows,
    `frame is ${rendered.length} rows tall, terminal has ${rows}`,
  );
  assert.ok(widest <= columns, `frame is ${widest} columns wide, terminal has ${columns}`);
}

describe('app shell', () => {
  it('renders the room screen for a client that is in a room', () => {
    const client = tempClient({ username: 'tester' });
    client.join('general');
    client.systemMessage('alex joined #general');

    const output = renderToString(<App client={client} />, { columns: COLUMNS });

    assert.ok(output.includes('╭'), 'rounded frame top');
    assert.ok(output.includes('╰'), 'rounded frame bottom');
    assert.ok(output.includes('zapchat'));
    assert.ok(output.includes('#general'));
    assert.ok(output.includes('›'), 'input prompt');
    assert.ok(output.includes('alex joined #general'));
    assertFits(output);
  });

  it('renders the welcome screen before a username is confirmed', () => {
    const client = tempClient();
    // Fresh config + no --name means the OS default is suggested but unconfirmed.
    assert.equal(client.usernameConfirmed, false);

    const output = renderToString(<WelcomeScreen
      layout={computeLayout(COLUMNS, ROWS)}
      snapshot={client.getSnapshot()}
      client={client}
      editor={fakeEditor()}
    />, { columns: COLUMNS });

    assert.ok(output.includes('Welcome to zapchat'));
    assert.ok(output.includes('What should people call you?'));
    assert.ok(output.includes('your name'), 'placeholder shown for an empty input');
    assertFits(output);
  });
});

describe('lobby screen', () => {
  const snapshot = makeSnapshot({
    room: null,
    rooms: [
      { name: 'general', online: 3, self: false, connectedPeers: 2 },
      { name: 'coding', online: 1, self: false, connectedPeers: 1 },
    ],
    peers: [makePeer({ username: 'sam', room: 'general' })],
  });

  it('lists rooms, peers and the activity log inside the frame', () => {
    const client = tempClient({ username: 'tester' });
    const layout = computeLayout(COLUMNS, ROWS);

    const output = renderToString(
      <LobbyScreen
        layout={layout}
        snapshot={snapshot}
        client={client}
        editor={fakeEditor()}
        submit={() => {}}
        joinRoom={() => {}}
        log={['#general 3 online', '#coding 1 online']}
      />,
      { columns: COLUMNS },
    );

    assert.ok(output.includes('ROOMS'));
    assert.ok(output.includes('#general'));
    assert.ok(output.includes('#coding'));
    assert.ok(output.includes('3 online'));
    assert.ok(output.includes('ON THE LAN'));
    assert.ok(output.includes('sam'));
    assert.ok(output.includes('#coding 1 online'), 'activity log lines are shown');
    assert.ok(output.includes('enter to join'));
    assertFits(output);
  });

  it('keeps the frame intact on a narrow terminal', () => {
    const client = tempClient({ username: 'tester' });
    const columns = 36;
    const layout = computeLayout(columns, ROWS);

    const output = renderToString(
      <LobbyScreen
        layout={layout}
        snapshot={snapshot}
        client={client}
        editor={fakeEditor()}
        submit={() => {}}
        joinRoom={() => {}}
        log={['a fairly long log line that must be truncated somewhere']}
      />,
      { columns },
    );

    assert.ok(output.includes('ROOMS'));
    assertFits(output, columns, ROWS);
  });
});

describe('room screen', () => {
  it('shows messages, presence and the prompt', () => {
    const layout = computeLayout(COLUMNS, ROWS);
    const snapshot = makeSnapshot({
      room: 'general',
      me: { clientId: 'zc-self', username: 'tester', usernameConfirmed: true },
      members: [makePeer({ username: 'alex' })],
      messages: [
        makeMessage({ username: 'alex', text: 'hey there', from: 'zc-alex', id: 'm1' }),
        makeMessage({
          username: 'tester',
          text: 'hello!',
          from: 'zc-self',
          self: true,
          id: 'm2',
        }),
      ],
    });

    const output = renderToString(
      <RoomScreen
        layout={layout}
        snapshot={snapshot}
        editor={fakeEditor()}
        submit={() => {}}
        leaveRoom={() => {}}
      />,
      { columns: COLUMNS },
    );

    assert.ok(output.includes('hey there'));
    assert.ok(output.includes('hello!'));
    assert.ok(output.includes('alex'));
    assert.ok(output.includes('2 online'), 'includes the local user in the count');
    assert.ok(output.includes('message #general'));
    assertFits(output);
  });

  it('scrolls a long conversation without overflowing the frame', () => {
    const layout = computeLayout(COLUMNS, ROWS);
    const messages = Array.from({ length: 40 }, (_, index) =>
      makeMessage({
        id: `m-${index}`,
        username: index % 2 === 0 ? 'alex' : 'tester',
        from: index % 2 === 0 ? 'zc-alex' : 'zc-self',
        self: index % 2 !== 0,
        text: `message number ${index} with some words in it so wrapping is exercised`,
        ts: 1_700_000_000_000 + index * 1000,
      }),
    );

    const output = renderToString(
      <RoomScreen
        layout={layout}
        snapshot={makeSnapshot({ room: 'general', messages })}
        editor={fakeEditor()}
        submit={() => {}}
        leaveRoom={() => {}}
      />,
      { columns: COLUMNS },
    );

    // Only the tail of the conversation is visible, and it fits.
    assert.ok(output.includes('message number 39'));
    assert.equal(output.includes('message number 0 '), false, 'oldest messages are scrolled off');
    assertFits(output);
  });

  it('survives emoji, CJK and very long words', () => {
    const layout = computeLayout(COLUMNS, ROWS);
    const snapshot = makeSnapshot({
      room: 'general',
      messages: [
        makeMessage({ id: 'e1', username: 'alex', text: '日本語のメッセージ 👋🏽 with emoji' }),
        makeMessage({ id: 'e2', username: 'blob', text: 'x'.repeat(500) }),
        makeMessage({ id: 'e3', username: '🇬🇧flag', text: 'flag names are wide' }),
      ],
    });

    const output = renderToString(
      <RoomScreen
        layout={layout}
        snapshot={snapshot}
        editor={fakeEditor()}
        submit={() => {}}
        leaveRoom={() => {}}
      />,
      { columns: COLUMNS },
    );

    assert.ok(output.includes('日本語のメッセージ'));
    assertFits(output);
    assert.ok(graphemes('🇬🇧').length === 1);
    assert.ok(wrapText('x'.repeat(500), 20).length === 25);
  });

  it('renders a placeholder when the room is empty', () => {
    const output = renderToString(
      <RoomScreen
        layout={computeLayout(COLUMNS, ROWS)}
        snapshot={makeSnapshot({ room: 'general', messages: [] })}
        editor={fakeEditor()}
        submit={() => {}}
        leaveRoom={() => {}}
      />,
      { columns: COLUMNS },
    );

    assert.ok(output.includes('#general is quiet'));
    assertFits(output);
  });

  it('shows a caret and the typed text in the input row', () => {
    const output = renderToString(
      <RoomScreen
        layout={computeLayout(COLUMNS, ROWS)}
        snapshot={makeSnapshot({ room: 'general' })}
        editor={fakeEditor('half written')}
        submit={() => {}}
        leaveRoom={() => {}}
      />,
      { columns: COLUMNS },
    );

    assert.ok(output.includes('half written'));
    assertFits(output);
  });
});
