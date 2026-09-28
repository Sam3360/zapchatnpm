import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  centerTo,
  displayWidth,
  divider,
  graphemes,
  padEndTo,
  truncateStartToWidth,
  truncateToWidth,
  wrapText,
} from '../../src/tui/view/text.js';
import { composeRow, truncateSpans } from '../../src/tui/view/rows.js';
import { computeLayout } from '../../src/tui/view/layout.js';
import {
  buildTimeline,
  formatDate,
  formatTime,
  resolveColumns,
  sliceViewport,
  stabiliseScroll,
} from '../../src/tui/view/timeline.js';
import { renderPrompt } from '../../src/tui/view/prompt.js';
import { buildLobbyView, windowAround } from '../../src/tui/view/lobby.js';
import { emptyRoomRows, membersLabel, scrollLabel } from '../../src/tui/view/room.js';
import { describeStatus, footerStatus, onlineLabel, plural } from '../../src/tui/view/status.js';
import { userColor, USER_COLORS } from '../../src/tui/theme.js';
import { makeMessage, makePeer, makeSnapshot, makeStatus } from '../helpers/snapshot.js';

describe('text measurement', () => {
  it('measures display width, not string length', () => {
    assert.equal(displayWidth('hello'), 5);
    assert.equal(displayWidth('日本語'), 6);
    assert.equal(displayWidth('👋🏽'), 2);
    assert.equal(displayWidth(''), 0);
  });

  it('splits into grapheme clusters', () => {
    assert.deepEqual(graphemes('a👋🏽b'), ['a', '👋🏽', 'b']);
    assert.equal(graphemes('🇬🇧').length, 1);
  });

  it('truncates to a width with an ellipsis', () => {
    assert.equal(truncateToWidth('hello world', 8), 'hello w…');
    assert.equal(truncateToWidth('hello', 10), 'hello');
    assert.equal(truncateToWidth('hello', 0), '');
    assert.equal(truncateToWidth('日本語です', 5), '日本…');
  });

  it('keeps the tail when truncating from the start', () => {
    assert.equal(truncateStartToWidth('hello world', 5), '…orld');
    assert.equal(truncateStartToWidth('hi', 5), 'hi');
  });

  it('pads and centres', () => {
    assert.equal(padEndTo('ab', 5), 'ab   ');
    assert.equal(padEndTo('abcdef', 3), 'abcdef');
    assert.equal(centerTo('ab', 6), '  ab  ');
    assert.equal(centerTo('ab', 5), ' ab  ');
  });

  it('builds dividers', () => {
    assert.equal(divider(3), '───');
    assert.equal(divider(0), '');
  });
});

describe('word wrapping', () => {
  it('wraps on word boundaries', () => {
    assert.deepEqual(wrapText('the quick brown fox', 10), ['the quick', 'brown fox']);
  });

  it('hard-breaks words that are longer than the width', () => {
    assert.deepEqual(wrapText('supercalifragilistic', 6), ['superc', 'alifra', 'gilist', 'ic']);
  });

  it('handles empty strings, blank paragraphs and long input', () => {
    assert.deepEqual(wrapText('', 10), ['']);
    assert.deepEqual(wrapText('a\n\nb', 10), ['a', '', 'b']);
    assert.deepEqual(wrapText('anything', 0), []);
  });

  it('respects double-width characters', () => {
    const lines = wrapText('日本語 テスト', 7);
    for (const line of lines) {
      assert.ok(displayWidth(line) <= 7, `"${line}" is too wide`);
    }
  });
});

describe('row composition', () => {
  it('lays out left spans and a right label inside the width', () => {
    const row = composeRow([{ text: '#general', bold: true }], '3 online', 30);
    const width = row.left.reduce((total, span) => total + displayWidth(span.text), 0)
      + displayWidth(row.gap)
      + displayWidth(row.right);
    assert.equal(width, 30);
    assert.equal(row.right, '3 online');
  });

  it('drops the right label when there is no room for it', () => {
    const row = composeRow([{ text: 'a'.repeat(30) }], 'right', 20);
    assert.equal(row.right, '');
    assert.ok(displayWidth(row.gap) >= 1);
  });

  it('truncates spans without losing their styling', () => {
    const spans = truncateSpans(
      [
        { text: 'hello ', color: 'cyan' },
        { text: 'world' },
      ],
      8,
    );
    assert.equal(spans.map(span => span.text).join(''), 'hello w…');
    assert.equal(spans[0]?.color, 'cyan');
  });

  it('returns an empty row for non-positive widths', () => {
    assert.deepEqual(composeRow([{ text: 'x' }], 'y', 0), { left: [], gap: '', right: '' });
  });
});

describe('layout', () => {
  it('leaves the last terminal row free', () => {
    const layout = computeLayout(80, 24);
    assert.equal(layout.frameHeight, 23);
    assert.equal(layout.innerWidth, 76);
    assert.equal(layout.bodyRows, 23 - 8);
    assert.equal(layout.tooSmall, false);
    assert.equal(layout.compact, false);
  });

  it('flags small terminals and switches to compact chrome', () => {
    assert.equal(computeLayout(30, 20).tooSmall, true);
    assert.equal(computeLayout(40, 10).tooSmall, true);
    assert.equal(computeLayout(50, 20).compact, true);
  });

  it('keeps a usable body even on tiny terminals', () => {
    const layout = computeLayout(10, 6);
    assert.ok(layout.bodyRows >= 3);
    assert.ok(layout.frameHeight >= 6);
  });
});

describe('timeline', () => {
  it('renders chat lines with the name column and no overflow', () => {
    const lines = buildTimeline(
      [makeMessage({ username: 'sam', text: 'hello there', from: 'zc-sam' })],
      40,
      { selfName: 'me' },
    );

    assert.equal(lines.length, 1);
    const text = lines[0]?.spans.map(span => span.text).join('') ?? '';
    assert.ok(text.includes('sam'));
    assert.ok(text.includes('hello there'));
    assert.ok(displayWidth(text) <= 40);
  });

  it('indents wrapped continuation lines to the message column', () => {
    const lines = buildTimeline(
      [makeMessage({ username: 'sam', text: 'word '.repeat(40), from: 'zc-sam' })],
      40,
      { selfName: 'me' },
    );

    assert.ok(lines.length > 1);
    const continuation = lines[1]?.spans.map(span => span.text).join('') ?? '';
    assert.ok(continuation.startsWith(' '));
    for (const line of lines) {
      const width = line.spans.reduce((total, span) => total + displayWidth(span.text), 0);
      assert.ok(width <= 40, `line is ${width} wide`);
    }
  });

  it('styles our own messages and system notices differently', () => {
    const lines = buildTimeline(
      [
        makeMessage({ username: 'me', text: 'mine', self: true, id: 'self-1' }),
        makeMessage({
          kind: 'system',
          text: 'sam joined #general',
          username: '',
          tone: 'info',
          id: 'sys-1',
        }),
      ],
      80,
      { selfName: 'me' },
    );

    const mine = lines[0]?.spans.find(span => span.text.includes('mine'));
    assert.ok(mine);

    const system = lines.find(line => line.spans.some(span => span.text.includes('joined')));
    assert.ok(system);
    assert.ok(system.spans.some(span => span.dim === true));
  });

  it('adds a date separator when the day changes', () => {
    const dayOne = Date.UTC(2026, 0, 1, 12, 0, 0);
    const dayTwo = Date.UTC(2026, 0, 2, 12, 0, 0);

    const lines = buildTimeline(
      [
        makeMessage({ ts: dayOne, id: 'a', text: 'first' }),
        makeMessage({ ts: dayTwo, id: 'b', text: 'second' }),
      ],
      80,
      { selfName: 'me' },
    );

    const separator = lines.find(line => line.spans.some(span => span.text.includes('Jan')));
    assert.ok(separator, 'expected a date separator');

    assert.equal(formatDate(dayOne).includes('2026'), true);
    assert.match(formatTime(dayOne), /^\d{2}:\d{2}$/);
  });

  it('drops the timestamp column on narrow terminals without losing the name', () => {
    const narrow = resolveColumns(24, 10, { selfName: 'me' });
    assert.equal(narrow.showTime, false);
    assert.ok(narrow.prefixWidth < 24);

    const wide = resolveColumns(100, 10, { selfName: 'me' });
    assert.equal(wide.showTime, true);
  });

  it('returns nothing for a zero-width terminal instead of throwing', () => {
    assert.deepEqual(buildTimeline([makeMessage()], 0, { selfName: 'me' }), []);
  });
});

describe('viewport slicing', () => {
  const lines = Array.from({ length: 10 }, (_, index) => ({
    key: `line-${index}`,
    spans: [{ text: `line ${index}` }],
  }));

  it('is anchored to the newest line by default', () => {
    const viewport = sliceViewport(lines, 4, 0);
    assert.deepEqual(
      viewport.lines.map(line => line.key),
      ['line-6', 'line-7', 'line-8', 'line-9'],
    );
    assert.equal(viewport.hiddenAbove, 6);
    assert.equal(viewport.hiddenBelow, 0);
  });

  it('clamps an oversized scroll offset', () => {
    const viewport = sliceViewport(lines, 4, 99);
    assert.equal(viewport.offset, 6);
    assert.equal(viewport.hiddenAbove, 0);
    assert.equal(viewport.hiddenBelow, 6);
  });

  it('pins the visible window when new lines arrive while scrolled up', () => {
    const before = sliceViewport(lines, 4, 2);
    const grown = [...lines, { key: 'line-10', spans: [{ text: 'new' }] }];
    const offset = stabiliseScroll(2, 1, grown.length, 4);
    const after = sliceViewport(grown, 4, offset);

    assert.equal(offset, 3);
    assert.deepEqual(
      after.lines.map(line => line.key),
      before.lines.map(line => line.key),
    );
    assert.equal(after.hiddenBelow, before.hiddenBelow + 1);
  });

  it('stays pinned to the bottom when not scrolled, and never overshoots', () => {
    assert.equal(stabiliseScroll(0, 5, 20, 4), 0);
    assert.equal(stabiliseScroll(2, 0, 10, 4), 2);
    assert.equal(stabiliseScroll(2, 100, 10, 4), 6, 'clamped to the oldest line');
  });

  it('handles an empty timeline', () => {
    const viewport = sliceViewport([], 5, 0);
    assert.deepEqual(viewport.lines, []);
  });
});

describe('prompt rendering', () => {
  it('shows a placeholder for an empty line', () => {
    const render = renderPrompt('', 0, { maxWidth: 20, placeholder: 'type here' });
    assert.equal(render.placeholder, true);
    assert.equal(render.before, 'type here');
    assert.equal(render.cursor, ' ');
  });

  it('splits the line around the cursor', () => {
    const render = renderPrompt('hello', 2, { maxWidth: 20 });
    assert.equal(render.before, 'he');
    assert.equal(render.cursor, 'l');
    assert.equal(render.after, 'lo');
  });

  it('shows the caret as a space at the end of the line', () => {
    const render = renderPrompt('hello', 5, { maxWidth: 20 });
    assert.equal(render.before, 'hello');
    assert.equal(render.cursor, ' ');
    assert.equal(render.after, '');
  });

  it('scrolls long input so the caret stays visible', () => {
    const render = renderPrompt('x'.repeat(40), 40, { maxWidth: 10 });
    assert.equal(render.scrolled, true);
    assert.ok(render.before.length <= 10);
    assert.equal(render.cursor, ' ');
  });

  it('hides the caret when not focused', () => {
    assert.equal(renderPrompt('hi', 1, { maxWidth: 10, hideCursor: true }).cursor, '');
  });
});

describe('lobby view', () => {
  const snapshot = makeSnapshot({
    rooms: [
      { name: 'general', online: 3, self: true, connectedPeers: 2 },
      { name: 'coding', online: 1, self: false, connectedPeers: 1 },
      { name: 'gaming', online: 0, self: false, connectedPeers: 0 },
    ],
    peers: [
      makePeer({ clientId: 'zc-a', username: 'sam', room: 'general' }),
      makePeer({ clientId: 'zc-b', username: 'jay', room: 'coding', connected: false }),
    ],
  });

  it('fills exactly the available height', () => {
    for (const height of [3, 6, 10, 20]) {
      const view = buildLobbyView({ snapshot, height, selectedIndex: 0, log: [] });
      assert.equal(view.rows.length, height, `height ${height}`);
    }
  });

  it('marks the selected room', () => {
    const view = buildLobbyView({ snapshot, height: 12, selectedIndex: 2, log: [] });
    const selected = view.rows.filter(row => row.selected === true);
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.text, '#gaming');
  });

  it('keeps a distant selection inside the visible window', () => {
    const many = makeSnapshot({
      rooms: Array.from({ length: 30 }, (_, index) => ({
        name: `room-${index}`,
        online: 0,
        self: false,
        connectedPeers: 0,
      })),
    });

    const view = buildLobbyView({ snapshot: many, height: 8, selectedIndex: 29, log: [] });
    const selected = view.rows.find(row => row.selected === true);
    assert.equal(selected?.text, '#room-29');
    assert.ok(view.roomOffset > 0);
  });

  it('shows a searching hint when no rooms are known', () => {
    const view = buildLobbyView({
      snapshot: makeSnapshot({ rooms: [] }),
      height: 8,
      selectedIndex: 0,
      log: [],
    });

    assert.ok(view.rows.some(row => row.text.includes('searching')));
  });

  it('includes the activity log when there is room', () => {
    const view = buildLobbyView({
      snapshot,
      height: 14,
      selectedIndex: 0,
      log: ['one', 'two', 'three'],
    });

    assert.ok(view.rows.some(row => row.text.includes('three')));
  });

  it('windows around an index', () => {
    assert.deepEqual(windowAround(0, 3, 5), { offset: 0, count: 3 });
    assert.deepEqual(windowAround(9, 20, 5), { offset: 7, count: 5 });
  });
});

describe('room view helpers', () => {
  it('centres the empty state in the body', () => {
    const rows = emptyRoomRows('general', 40, 10);
    assert.equal(rows.length, 10);
    assert.ok(rows.some(row => row.includes('#general is quiet')));
    assert.ok(rows.every(row => displayWidth(row) <= 40));
  });

  it('labels scrolling state', () => {
    assert.equal(scrollLabel(0, 0), '');
    assert.match(scrollLabel(4, 0), /↑ 4 older/);
    assert.match(scrollLabel(0, 2), /↓ 2 new/);
    assert.match(scrollLabel(1, 1), /↑ 1 older · ↓ 1 new/);
  });

  it('summarises room members and truncates long lists', () => {
    assert.equal(membersLabel([], 20), 'nobody else here');
    assert.equal(membersLabel(['sam', 'jay'], 20), 'sam, jay');

    const long = membersLabel(['sam', 'jay', 'alex', 'rob', 'kim'], 14);
    assert.ok(long.includes('+'));
    assert.ok(displayWidth(long) <= 14);
  });
});

describe('status descriptions', () => {
  it('reports connected, searching and offline states', () => {
    assert.equal(describeStatus(makeSnapshot()).kind, 'searching');

    assert.equal(
      describeStatus(
        makeSnapshot({
          peers: [makePeer()],
          status: makeStatus({ peersOnline: 1, peersConnected: 1 }),
        }),
      ).kind,
      'connected',
    );

    assert.equal(
      describeStatus(
        makeSnapshot({
          peers: [makePeer({ connected: false })],
          status: makeStatus({ peersOnline: 1, peersConnected: 0 }),
        }),
      ).kind,
      'lan',
    );

    assert.equal(
      describeStatus(
        makeSnapshot({ status: makeStatus({ discovery: 'unavailable', discoveryDetail: 'off' }) }),
      ).kind,
      'offline',
    );

    assert.equal(
      describeStatus(makeSnapshot({ status: makeStatus({ discovery: 'degraded' }) })).kind,
      'degraded',
    );
  });

  it('prefers a notice, then discovery problems, then warnings, then the hint', () => {
    const hint = 'enter send';

    assert.equal(footerStatus(makeSnapshot(), hint).text, hint);

    assert.equal(
      footerStatus(makeSnapshot({ status: makeStatus({ warnings: ['beacon failed'] }) }), hint).text,
      'beacon failed',
    );

    assert.equal(
      footerStatus(
        makeSnapshot({
          status: makeStatus({ discovery: 'unavailable', discoveryDetail: 'no multicast' }),
        }),
        hint,
      ).text,
      'no multicast',
    );

    const notice = footerStatus(
      makeSnapshot({ notice: { tone: 'error', text: 'boom', ts: 1 } }),
      hint,
    );
    assert.equal(notice.text, 'boom');
    assert.equal(notice.color, 'red');
  });

  it('formats counts', () => {
    assert.equal(onlineLabel(1), '1 online');
    assert.equal(onlineLabel(4), '4 online');
    assert.equal(onlineLabel(0), 'nobody yet');
    assert.equal(plural(1, 'peer'), '1 peer');
    assert.equal(plural(2, 'peer'), '2 peers');
    assert.equal(plural(0, 'room'), '0 rooms');
  });
});

describe('user colours', () => {
  it('are stable and drawn from the palette', () => {
    assert.equal(userColor('zc-abc'), userColor('zc-abc'));
    assert.ok(USER_COLORS.includes(userColor('someone') as (typeof USER_COLORS)[number]));
  });
});
