/**
 * App root: picks the screen, owns the input line, and dispatches commands.
 *
 * The screen is *derived* from the client snapshot (no username confirmed →
 * welcome, no room → lobby, otherwise room), so the UI can never disagree with
 * the networking state.
 */

import { useApp, useInput, useWindowSize } from 'ink';
import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import type { Snapshot, ZapClient } from '../core/client.js';
import { parseCommand } from '../commands/commands.js';
import { runCommand } from './runCommand.js';
import { computeLayout } from './view/layout.js';
import { useActivityLog, useGracefulExit, useLineEditor, useZapSnapshot } from './hooks.js';
import { WelcomeScreen } from './screens/WelcomeScreen.js';
import { LobbyScreen } from './screens/LobbyScreen.js';
import { RoomScreen } from './screens/RoomScreen.js';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

export interface AppProps {
  client: ZapClient;
}

export function App({ client }: AppProps): ReactNode {
  const snapshot = useZapSnapshot(client);
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const layout = useMemo(() => computeLayout(columns, rows), [columns, rows]);

  const editor = useLineEditor();
  const log = useActivityLog(6);
  const quit = useGracefulExit(client, exit);

  // Latest snapshot without re-creating the callbacks on every message.
  const snapshotRef = useRef<Snapshot>(snapshot);
  snapshotRef.current = snapshot;

  /** Local output: room timeline when in a room, lobby log otherwise. */
  const print = useCallback(
    (text: string, tone: 'info' | 'warn' | 'error' = 'info') => {
      if (client.room !== null) {
        client.systemMessage(text, tone);
      } else {
        log.push(text);
      }
    },
    [client, log],
  );

  /** Handle a submitted line: a `/command`, or chat depending on the screen. */
  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return;
      }

      const parsed = parseCommand(trimmed);
      if (parsed !== null) {
        const outcome = runCommand(parsed, { client, print, clearOutput: log.clear });
        if (outcome === 'quit') {
          quit();
        }

        return;
      }

      if (client.room !== null) {
        client.send(trimmed);
        return;
      }

      // In the lobby, a bare name opens that room (creating it if it does not
      // exist yet) — the fastest path from "install" to "chatting".
      const exists = snapshotRef.current.rooms.some(
        room => room.name === trimmed.toLowerCase(),
      );
      const result = exists ? client.join(trimmed) : client.create(trimmed);
      if (!result.ok && result.error !== undefined) {
        print(result.error, 'warn');
      }
    },
    [client, log, print, quit],
  );

  const joinRoom = useCallback(
    (room: string) => {
      const result = client.join(room);
      if (!result.ok && result.error !== undefined) {
        print(result.error, 'warn');
      }
    },
    [client, print],
  );

  const leaveRoom = useCallback(() => {
    client.leave();
  }, [client]);

  useInput((input, key) => {
    // Ctrl+C: stop cleanly (announce departure, close sockets, restore terminal).
    if (key.ctrl === true && input === 'c') {
      quit();
    }
  });

  if (layout.tooSmall) {
    return <TooSmallScreen layout={layout} />;
  }

  if (!snapshot.me.usernameConfirmed) {
    return (
      <WelcomeScreen
        layout={layout}
        snapshot={snapshot}
        client={client}
        editor={editor}
      />
    );
  }

  if (snapshot.room === null) {
    return (
      <LobbyScreen
        layout={layout}
        snapshot={snapshot}
        client={client}
        editor={editor}
        submit={submit}
        joinRoom={joinRoom}
        log={log.lines}
      />
    );
  }

  return (
    <RoomScreen
      layout={layout}
      snapshot={snapshot}
      editor={editor}
      submit={submit}
      leaveRoom={leaveRoom}
    />
  );
}

/** Shown when the terminal is too small to hold the frame. */
function TooSmallScreen({ layout }: { layout: ReturnType<typeof computeLayout> }): ReactNode {
  return (
    <Box
      height={Math.max(4, layout.rows - 1)}
      width={layout.columns}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <Box
        borderStyle="round"
        borderColor={theme.warn}
        paddingX={2}
        flexDirection="column"
        alignItems="center"
      >
        <Text bold color={theme.title}>
          zapchat
        </Text>
        <Text dimColor>terminal too small</Text>
        <Text>
          {layout.columns}×{layout.rows}
        </Text>
        <Text dimColor>resize to at least 34×12</Text>
      </Box>
    </Box>
  );
}
