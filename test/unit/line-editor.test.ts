import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EMPTY_EDITOR,
  applyKey,
  type EditorState,
  type KeyDescriptor,
} from '../../src/tui/input/lineEditor.js';

function type(state: EditorState, text: string): EditorState {
  return applyKey(state, { input: text }).state;
}

function press(state: EditorState, key: Partial<KeyDescriptor>): EditorState {
  return applyKey(state, { input: '', ...key }).state;
}

describe('typing', () => {
  it('inserts characters at the cursor', () => {
    const state = type(EMPTY_EDITOR, 'hel');
    const second = type(state, 'lo');
    assert.deepEqual(second, { text: 'hello', cursor: 5 });
  });

  it('handles multi-character paste in one call', () => {
    const state = applyKey(EMPTY_EDITOR, { input: 'hello world' });
    assert.deepEqual(state.state, { text: 'hello world', cursor: 11 });
  });

  it('inserts in the middle of the line', () => {
    let state = type(EMPTY_EDITOR, 'hlo');
    state = press(state, { leftArrow: true });
    state = press(state, { leftArrow: true });
    state = type(state, 'el');
    assert.equal(state.text, 'hello');
  });

  it('treats emoji as single characters', () => {
    let state = type(EMPTY_EDITOR, 'ab');
    state = type(state, '👋🏽');
    assert.equal(state.text, 'ab👋🏽');
    assert.equal(state.cursor, 3);

    // Backspace removes the whole emoji, not half of it.
    state = press(state, { backspace: true });
    assert.equal(state.text, 'ab');
    assert.equal(state.cursor, 2);
  });

  it('ignores bare control characters', () => {
    const state = applyKey(EMPTY_EDITOR, { input: '\u0001' });
    assert.deepEqual(state.state, EMPTY_EDITOR);
    assert.equal(state.action, 'none');
  });
});

describe('editing keys', () => {
  const base: EditorState = { text: 'hello world', cursor: 11 };

  it('moves with arrows, home and end', () => {
    assert.equal(press(base, { leftArrow: true }).cursor, 10);
    assert.equal(press(base, { rightArrow: true }).cursor, 11);
    assert.equal(press(base, { home: true }).cursor, 0);
    assert.equal(press(base, { end: true }).cursor, 11);

    const clamped = press({ text: 'hi', cursor: 0 }, { leftArrow: true });
    assert.equal(clamped.cursor, 0, 'cursor cannot go before the start');
  });

  it('deletes backwards and forwards', () => {
    assert.equal(press(base, { backspace: true }).text, 'hello worl');
    assert.equal(press(base, { backspace: true }).cursor, 10);
    assert.equal(press({ text: 'hello', cursor: 0 }, { backspace: true }).text, 'hello');
    assert.equal(press(base, { delete: true }).text, 'hello world');

    const mid: EditorState = { text: 'hello', cursor: 1 };
    assert.equal(press(mid, { delete: true }).text, 'hllo');
  });

  it('supports the usual readline shortcuts', () => {
    const word: EditorState = { text: 'one two three', cursor: 13 };
    assert.equal(press(word, { ctrl: true, input: 'w' }).text, 'one two ');

    const mid: EditorState = { text: 'one two', cursor: 3 };
    // Ctrl+U kills everything before the cursor ("one"), including the space.
    assert.deepEqual(press(mid, { ctrl: true, input: 'u' }), { text: ' two', cursor: 0 });
    assert.equal(press(mid, { ctrl: true, input: 'k' }).text, 'one');
    assert.equal(press(mid, { ctrl: true, input: 'a' }).cursor, 0);
    assert.equal(press(mid, { ctrl: true, input: 'e' }).cursor, 7);
  });

  it('never leaves text or cursor out of range', () => {
    const state = press({ text: 'abc', cursor: 99 }, { backspace: true });
    assert.equal(state.text, 'ab');
    assert.equal(state.cursor, 2);
  });
});

describe('actions', () => {
  const state: EditorState = { text: 'hi', cursor: 2 };

  it('reports submit and cancel without changing the text', () => {
    assert.deepEqual(applyKey(state, { input: '', return: true }), {
      state,
      action: 'submit',
    });
    assert.deepEqual(applyKey(state, { input: '', escape: true }), {
      state,
      action: 'cancel',
    });
  });

  it('maps scroll/history keys to actions', () => {
    assert.equal(applyKey(state, { input: '', upArrow: true }).action, 'previous');
    assert.equal(applyKey(state, { input: '', downArrow: true }).action, 'next');
    assert.equal(applyKey(state, { input: '', pageUp: true }).action, 'page-up');
    assert.equal(applyKey(state, { input: '', pageDown: true }).action, 'page-down');
    assert.equal(applyKey(state, { input: '', tab: true }).action, 'tab');
  });

  it('maps ctrl+p and ctrl+n to history navigation', () => {
    assert.equal(applyKey(state, { input: 'p', ctrl: true }).action, 'previous');
    assert.equal(applyKey(state, { input: 'n', ctrl: true }).action, 'next');
  });

  it('ignores unbound modifier combinations', () => {
    assert.equal(applyKey(EMPTY_EDITOR, { input: 'x', meta: true }).action, 'none');
    assert.deepEqual(applyKey(EMPTY_EDITOR, { input: 'z', ctrl: true }).state, EMPTY_EDITOR);
  });
});
