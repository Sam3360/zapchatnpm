import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig, saveConfigTo, updateConfig } from '../../src/config/config.js';
import { createClientId, defaultUsername } from '../../src/config/identity.js';
import { resolveConfigDir, resolveConfigPath } from '../../src/config/paths.js';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapchat-test-'));
  tempRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('config paths', () => {
  it('honours ZAPCHAT_CONFIG_DIR above everything else', () => {
    const dir = resolveConfigDir({
      env: { ZAPCHAT_CONFIG_DIR: path.join('tmp', 'custom') },
      platform: 'linux',
      home: '/home/sam',
    });

    assert.equal(dir, path.resolve(path.join('tmp', 'custom')));
  });

  it('uses platform conventions elsewhere', () => {
    assert.equal(
      resolveConfigDir({ env: {}, platform: 'win32', home: 'C:\\Users\\sam' }),
      path.join('C:\\Users\\sam', 'AppData', 'Roaming', 'zapchat'),
    );
    assert.equal(
      resolveConfigDir({ env: { APPDATA: 'D:\\roaming' }, platform: 'win32', home: 'C:\\Users\\sam' }),
      path.join('D:\\roaming', 'zapchat'),
    );
    assert.equal(
      resolveConfigDir({ env: {}, platform: 'darwin', home: '/Users/sam' }),
      path.join('/Users/sam', 'Library', 'Application Support', 'zapchat'),
    );
    assert.equal(
      resolveConfigDir({ env: {}, platform: 'linux', home: '/home/sam' }),
      path.join('/home/sam', '.config', 'zapchat'),
    );
    assert.equal(
      resolveConfigDir({ env: { XDG_CONFIG_HOME: '/etc/xdg' }, platform: 'linux', home: '/home/sam' }),
      path.join('/etc/xdg', 'zapchat'),
    );
  });

  it('builds the config file path', () => {
    assert.equal(
      resolveConfigPath({ env: { ZAPCHAT_CONFIG_DIR: path.join('a', 'b') }, platform: 'linux' }),
      path.resolve(path.join('a', 'b', 'config.json')),
    );
  });
});

describe('identity', () => {
  it('generates valid, unique client ids', () => {
    const first = createClientId();
    const second = createClientId();

    assert.match(first, /^zc-[0-9a-f-]{36}$/);
    assert.notEqual(first, second);
  });

  it('suggests a usable default username', () => {
    const username = defaultUsername();
    assert.ok(username.length > 0 && username.length <= 20);
    assert.match(username, /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u);
  });
});

describe('config file', () => {
  it('creates a config file on first run', () => {
    const file = path.join(tempDir(), 'config.json');
    const result = loadConfig({ configPath: file, now: 1000 });

    assert.equal(result.created, true);
    assert.equal(result.config.version, 1);
    assert.equal(result.config.username, '');
    assert.equal(result.config.lastRoom, 'general');
    assert.ok(fs.existsSync(file));

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.clientId, result.config.clientId);
  });

  it('keeps the same client id across runs', () => {
    const file = path.join(tempDir(), 'config.json');
    const first = loadConfig({ configPath: file, now: 1000 });
    updateConfig({ username: 'sam' }, { configPath: file, now: 2000 });
    const second = loadConfig({ configPath: file, now: 3000 });

    assert.equal(second.config.clientId, first.config.clientId);
    assert.equal(second.config.username, 'sam');
  });

  it('repairs corrupt json instead of failing', () => {
    const file = path.join(tempDir(), 'config.json');
    fs.writeFileSync(file, '{ not json at all');

    const result = loadConfig({ configPath: file, now: 1000 });
    assert.ok(result.warning);
    assert.ok(result.config.clientId.length > 5);
    assert.ok(fs.existsSync(file));

    // The repaired file is readable on the next run.
    assert.equal(loadConfig({ configPath: file }).warning, undefined);
  });

  it('drops unusable stored values and regenerates the client id', () => {
    const file = path.join(tempDir(), 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        clientId: 'bad id with spaces',
        username: 'no spaces allowed',
        lastRoom: '#bad/room',
      }),
    );

    const result = loadConfig({ configPath: file, now: 1000 });
    assert.ok(result.warning);
    assert.match(result.config.clientId, /^zc-/);
    assert.equal(result.config.username, '');
    assert.equal(result.config.lastRoom, 'general');
  });

  it('writes atomically and leaves no temp files behind', () => {
    const dir = tempDir();
    const file = path.join(dir, 'config.json');
    const config = loadConfig({ configPath: file }).config;

    saveConfigTo({ ...config, username: 'sam' }, file);
    const entries = fs.readdirSync(dir);

    assert.deepEqual(entries, ['config.json']);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).username, 'sam');
  });

  it('reports a warning when the directory is not writable', () => {
    // A path that cannot exist on any platform: a file used as a directory.
    const dir = tempDir();
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');

    const result = loadConfig({ configPath: path.join(blocker, 'config.json'), now: 1000 });

    assert.ok(result.warning);
    assert.equal(result.created, true);
    assert.ok(result.config.clientId.length > 5);
  });
});
