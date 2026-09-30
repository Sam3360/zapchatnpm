/**
 * Room screen: the scrollable conversation, presence, and the message input.
 *
 * Scrolling is expressed as "lines above the bottom", which means new messages
 * arriving while you read older ones do not yank the view: the window stays put
 * and the footer shows how many new lines are waiting below.
 */

import { useInput } from 'ink';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Snapshot } from '../../core/client.js';
import { theme } from '../theme.js';
import type { ScreenLayout } from '../view/layout.js';
import { describeStatus, footerStatus, onlineLabel } from '../view/status.js';
import { buildTimeline, sliceViewport, stabiliseScroll } from '../view/timeline.js';
import { emptyRoomRows, membersLabel, scrollLabel } from '../view/room.js';
import { PlainRows, TimelineView } from '../components/TimelineView.js';
import { Divider, Frame, HeaderBar, HintRow, PromptRow } from '../components/Frame.js';
import type { LineEditor } from '../hooks.js';
import { footerHint } from '../../commands/commands.js';

export interface RoomScreenProps {
  layout: ScreenLayout;
  snapshot: Snapshot;
  editor: LineEditor;
  submit: (text: string) => void;
  leaveRoom: () => void;
}

export function RoomScreen({
  layout,
  snapshot,
  editor,
  submit,
  leaveRoom,
}: RoomScreenProps): ReactNode {
  const [scrollOffset, setScrollOffset] = useState(0);
  const room = snapshot.room ?? '';

  // Starting a new room always starts at the bottom.
  useEffect(() => {
    setScrollOffset(0);
  }, [room]);

  const timeline = useMemo(
    () =>
      buildTimeline(snapshot.messages, layout.innerWidth, {
        selfName: snapshot.me.username,
        timestamps: !layout.compact,
        dateSeparators: !layout.compact,
      }),
    [snapshot.messages, layout.innerWidth, layout.compact, snapshot.me.username],
  );

  const viewport = useMemo(
    () => sliceViewport(timeline, layout.bodyRows, scrollOffset),
    [timeline, layout.bodyRows, scrollOffset],
  );

  // While the user is reading older messages, new arrivals must not move the
  // window: push the offset by the number of lines that were appended.
  const lineCountRef = useRef(timeline.length);
  useEffect(() => {
    const added = timeline.length - lineCountRef.current;
    lineCountRef.current = timeline.length;
    if (added > 0) {
      setScrollOffset(offset =>
        stabiliseScroll(offset, added, timeline.length, layout.bodyRows),
      );
    }
  }, [timeline.length, layout.bodyRows]);

  useInput((input, key) => {
    if (key.upArrow === true || key.downArrow === true) {
      setScrollOffset(offset =>
        key.upArrow === true ? offset + 1 : Math.max(0, offset - 1),
      );
      return;
    }

    if (key.pageUp === true || key.pageDown === true) {
      setScrollOffset(offset =>
        key.pageUp === true
          ? offset + Math.max(1, layout.bodyRows - 2)
          : Math.max(0, offset - Math.max(1, layout.bodyRows - 2)),
      );
      return;
    }

    const action = editor.handleKey({ input, ...key });

    if (action === 'submit') {
      const value = editor.read().text;
      editor.reset();

      if (value.trim().length === 0) {
        // Enter on an empty line jumps back to the newest message.
        setScrollOffset(0);
        return;
      }

      editor.pushHistory(value);
      setScrollOffset(0);
      submit(value);
      return;
    }

    if (action === 'cancel') {
      if (editor.read().text.length > 0) {
        editor.reset();
        return;
      }

      leaveRoom();
      return;
    }

    if (action === 'tab') {
      // Complete the word before the cursor: /commands, room names for
      // /join//create, member usernames everywhere else.
      editor.completeTab({
        members: snapshot.members.map(member => member.username),
        rooms: snapshot.rooms.map(entry => entry.name),
      });
    }
  });

  const status = describeStatus(snapshot);
  const footer = footerStatus(snapshot, footerHint('room'));
  const members = snapshot.members.map(member => member.username);
  const summary = `${onlineLabel(members.length + 1)}${layout.compact ? '' : ` · ${membersLabel(members, Math.max(8, Math.floor(layout.innerWidth / 3)))}`}`;

  return (
    <Frame layout={layout}>
      <HeaderBar
        layout={layout}
        username={snapshot.me.username}
        status={status}
        contextLabel={`#${room}`}
        summary={summary}
        detail={layout.compact ? undefined : `tcp:${snapshot.status.tcpPort}`}
      />

      {timeline.length === 0 ? (
        <PlainRows
          rows={emptyRoomRows(room, layout.innerWidth, layout.bodyRows)}
          width={layout.innerWidth}
        />
      ) : (
        <TimelineView lines={viewport.lines} width={layout.innerWidth} />
      )}

      <Divider layout={layout} />
      <PromptRow
        layout={layout}
        state={editor.state}
        placeholder={`message #${room}`}
      />
      <HintRow
        layout={layout}
        left={footer.text}
        leftColor={footer.color}
        leftDim={footer.dim}
        right={scrollLabel(viewport.hiddenAbove, viewport.hiddenBelow)}
        rightColor={theme.accent}
      />
    </Frame>
  );
}
