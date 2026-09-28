/**
 * Lobby: the rooms discovered on the LAN, who is on it, and a small activity log.
 *
 * Rooms are derived from what clients announce, so the list updates on its own as
 * people join and leave. There is no room server to keep in sync with.
 */

import { useInput } from 'ink';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Snapshot, ZapClient } from '../../core/client.js';
import { theme, glyphs } from '../theme.js';
import type { ScreenLayout } from '../view/layout.js';
import { describeStatus, footerStatus, plural } from '../view/status.js';
import { buildLobbyView, type LobbyRow } from '../view/lobby.js';
import { BlankRow, Divider, Frame, HeaderBar, HintRow, PromptRow, SpanRow } from '../components/Frame.js';
import type { LineEditor } from '../hooks.js';
import { footerHint } from '../../commands/commands.js';

export interface LobbyScreenProps {
  layout: ScreenLayout;
  snapshot: Snapshot;
  client: ZapClient;
  editor: LineEditor;
  /** Handle a typed line: a `/command` or a room name to open. */
  submit: (text: string) => void;
  /** Join a specific room (room list selection). */
  joinRoom: (room: string) => void;
  log: readonly string[];
}

export function LobbyScreen({
  layout,
  snapshot,
  client,
  editor,
  submit,
  joinRoom,
  log,
}: LobbyScreenProps): ReactNode {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const roomCount = snapshot.rooms.length;
  const preselectedRef = useRef(false);

  // Keep the selection inside the list as rooms appear and disappear.
  useEffect(() => {
    setSelectedIndex(index => {
      if (roomCount === 0) {
        return 0;
      }

      return Math.min(index, roomCount - 1);
    });
  }, [roomCount]);

  // Preselect the room we were last in — once, when the list first appears.
  const rooms = snapshot.rooms;
  useEffect(() => {
    if (preselectedRef.current || rooms.length === 0) {
      return;
    }

    preselectedRef.current = true;
    const lastRoom = client.lastRoomHint;
    if (lastRoom === null) {
      return;
    }

    const index = rooms.findIndex(room => room.name === lastRoom);
    if (index >= 0) {
      setSelectedIndex(index);
    }
  }, [rooms, client]);

  useInput((input, key) => {
    if (key.upArrow === true || key.downArrow === true) {
      if (roomCount > 0) {
        setSelectedIndex(index =>
          key.upArrow === true
            ? Math.max(0, index - 1)
            : Math.min(roomCount - 1, index + 1),
        );
      }

      return;
    }

    if (key.pageUp === true || key.pageDown === true) {
      if (roomCount > 0) {
        setSelectedIndex(index =>
          key.pageUp === true
            ? Math.max(0, index - 5)
            : Math.min(roomCount - 1, index + 5),
        );
      }

      return;
    }

    const action = editor.handleKey({ input, ...key });

    if (action === 'submit') {
      const value = editor.read().text.trim();
      editor.reset();

      if (value.length === 0) {
        if (roomCount === 0) {
          client.setNotice('warn', 'no rooms yet — type a name and press enter to start one');
          return;
        }

        const room = rooms[selectedIndex];
        if (room !== undefined) {
          joinRoom(room.name);
        }

        return;
      }

      editor.pushHistory(value);
      submit(value);
      return;
    }

    if (action === 'cancel') {
      editor.reset();
      client.dismissNotice();
    }
  });

  const view = useMemo(
    () =>
      buildLobbyView({
        snapshot,
        height: layout.bodyRows,
        selectedIndex,
        log,
        logLines: layout.compact ? 2 : 3,
      }),
    [snapshot, layout.bodyRows, layout.compact, selectedIndex, log],
  );

  const status = describeStatus(snapshot);
  const footer = footerStatus(snapshot, footerHint('lobby'));
  const peers = snapshot.peers.filter(peer => peer.online).length;

  return (
    <Frame layout={layout}>
      <HeaderBar
        layout={layout}
        username={snapshot.me.username}
        status={status}
        contextLabel="lobby"
        contextColor={theme.muted}
        summary={`${plural(snapshot.rooms.length, 'room')} · ${plural(peers, 'peer')}`}
        detail={layout.compact ? undefined : `udp:${snapshot.status.discoveryPort}`}
      />

      {view.rows.map((row, index) => (
        <LobbyRowView key={`${row.kind}-${index}`} layout={layout} row={row} />
      ))}

      <Divider layout={layout} />
      <PromptRow layout={layout} state={editor.state} placeholder="type a room name, or /help" />
      <HintRow
        layout={layout}
        left={footer.text}
        leftColor={footer.color}
        leftDim={footer.dim}
        right={roomCount === 0 ? '' : 'enter to join'}
      />
    </Frame>
  );
}

function LobbyRowView({ layout, row }: { layout: ScreenLayout; row: LobbyRow }): ReactNode {
  switch (row.kind) {
    case 'blank':
      return <BlankRow />;

    case 'label':
      return (
        <SpanRow
          layout={layout}
          spans={[{ text: row.text, dim: true, bold: true }]}
          right={row.right ?? ''}
        />
      );

    case 'room':
      return (
        <SpanRow
          layout={layout}
          prefix={row.selected === true ? `${glyphs.pointer} ` : '  '}
          spans={[
            {
              text: row.text,
              bold: row.selected === true,
              color: row.selected === true ? theme.accent : undefined,
            },
          ]}
          right={row.right ?? ''}
          rightColor={row.selected === true ? theme.accent : theme.muted}
        />
      );

    case 'peer':
      return (
        <SpanRow
          layout={layout}
          spans={[{ text: row.text, color: row.color, dim: row.dim }]}
          right={row.right ?? ''}
        />
      );

    default:
      return (
        <SpanRow layout={layout} spans={[{ text: row.text, dim: true, color: row.color }]} />
      );
  }
}
