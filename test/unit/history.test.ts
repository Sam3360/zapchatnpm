import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { HistoryStore, HISTORY_DIR_NAME } from '../../src/config/history.js';
import type { ChatMessage } from '../../src/rooms/registry.js';
import { ZapClient } from '../../src/core/client.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zapchat-hist-'));
}

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    room: 'general',
    kind: 'chat',
    text: `text of ${id}`,
    from: 'zc-peer',
    username: 'tester',
    ts: 1_700_000_000_000,
    self: false,
    ...overrides,
  };
}

describe('HistoryStore', () => {
  it('round-trips chat messages, oldest first', () => {
    const store = new HistoryStore(tempDir(), 10);
    store.append(message('id-1'));
    store.append(message('id-2'));

    const loaded = store.load('general');
    assert.deepEqual(loaded.map(m => m.id), ['id-1', 'id-2']);
    assert.equal(loaded[0]?.text, 'text of id-1');
  });

  it('never persists system notices', () => {
    const store = new HistoryStore(tempDir(), 10);
    store.append(message('sys-1', { kind: 'system', text: 'you joined #general' }));
    store.append(message('chat-1'));

    assert.deepEqual(store.load('general').map(m => m.id), ['chat-1']);
  });

  it('keeps only the newest `limit` messages, on disk as well as in memory', () => {
    const dir = tempDir();
    const store = new HistoryStore(dir, 3);
    for (let index = 1; index <= 5; index += 1) {
      store.append(message(`id-${index}`));
    }

    assert.deepEqual(store.load('general').map(m => m.id), ['id-3', 'id-4', 'id-5']);

    // A fresh instance reads straight from disk: the file itself must have
    // been rewritten bounded, not merely the in-memory view.
    const reread = new HistoryStore(dir, 3);
    assert.deepEqual(reread.load('general').map(m => m.id), ['id-3', 'id-4', 'id-5']);
  });

  it('clearRoom deletes the file', () => {
    const dir = tempDir();
    const store = new HistoryStore(dir, 10);
    store.append(message('id-1'));
    assert.deepEqual(store.load('general').map(m => m.id), ['id-1']);

    store.clearRoom('general');
    assert.deepEqual(store.load('general'), []);
    assert.equal(fs.existsSync(path.join(dir, HISTORY_DIR_NAME, 'general.jsonl')), false);
  });

  it('skips torn or garbage lines instead of failing', () => {
    const dir = tempDir();
    const store = new HistoryStore(dir, 10);
    store.append(message('id-1'));
    store.append(message('id-3'));

    const file = path.join(dir, HISTORY_DIR_NAME, 'general.jsonl');
    fs.appendFileSync(file, '{"id":"id-4","room":"gen', 'utf8'); // torn write

    const loaded = store.load('general');
    assert.deepEqual(loaded.map(m => m.id), ['id-1', 'id-3']);
  });

  it('cannot be steered outside its directory by a hostile room name', () => {
    const dir = tempDir();
    const store = new HistoryStore(dir, 10);
    store.append(message('id-1', { room: '../../evil' }));

    assert.deepEqual(store.load('../../evil').map(m => m.id), ['id-1']);
    assert.equal(fs.existsSync(path.join(dir, '..', '..', 'evil.jsonl')), false);
    assert.equal(store.rooms().includes('../../evil'), false);
  });
});

describe('ZapClient history (v8.1)', () => {
  function configPath(): string {
    const dir = tempDir();
    return path.join(dir, 'config.json');
  }

  it('restores chat lines after a restart', async () => {
    const config = configPath();
    const first = new ZapClient({ username: 'tester', configPath: config });
    try {
      assert.equal(first.join('general').ok, true);
      assert.equal(first.send('persisted line').ok, true);
    } finally {
      await first.stop();
    }

    const second = new ZapClient({ username: 'tester', configPath: config });
    try {
      // A fresh client starts in the lobby (room === null): the restored
      // timeline becomes visible when the user enters the room again.
      second.join('general');
      const chat = second.getSnapshot().messages.filter(m => m.kind === 'chat');
      assert.deepEqual(chat.map(m => m.text), ['persisted line']);
      // System notices from the previous session must NOT be replayed.
      assert.equal(chat.some(m => m.text.includes('you joined')), false);
    } finally {
      await second.stop();
    }
  });

  it('does not persist or restore anything with history disabled', async () => {
    const config = configPath();
    const first = new ZapClient({ username: 'tester', configPath: config, history: false });
    try {
      first.join('general');
      first.send('forgotten line');
    } finally {
      await first.stop();
    }

    const second = new ZapClient({ username: 'tester', configPath: config, history: false });
    try {
      second.join('general');
      const chat = second.getSnapshot().messages.filter(m => m.kind === 'chat');
      assert.deepEqual(chat, []);
    } finally {
      await second.stop();
    }
  });

  it('clearHistory wipes the persisted copy too', async () => {
    const config = configPath();
    const first = new ZapClient({ username: 'tester', configPath: config });
    try {
      first.join('general');
      first.send('to be cleared');
    } finally {
      await first.stop();
    }

    const second = new ZapClient({ username: 'tester', configPath: config });
    try {
      second.join('general');
      assert.equal(second.getSnapshot().messages.some(m => m.text === 'to be cleared'), true);
      second.clearHistory();
      assert.deepEqual(second.getSnapshot().messages, []);
    } finally {
      await second.stop();
    }

    const third = new ZapClient({ username: 'tester', configPath: config });
    try {
      assert.deepEqual(third.getSnapshot().messages, []);
    } finally {
      await third.stop();
    }
  });
});
