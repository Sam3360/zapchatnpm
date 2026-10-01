import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { isDirectRunOf } from '../../src/cli/main.js';

const CLI = path.resolve('dist/cli/main.js');

/**
 * The exact macOS/Homebrew failure from v2-v7.0.0, reproduced with plain
 * strings (no symlink privilege needed anywhere):
 *
 *   argv[1]        = /opt/homebrew/bin/zapchat          (the npm symlink)
 *   import.meta.url = file:///opt/homebrew/lib/node_modules/zapchat/dist/cli/main.js
 *
 * The old guard compared those two strings directly, never matched, and the
 * CLI exited 0 without printing anything — the "silent zapchat on macOS" bug.
 */
const MAC_BIN = '/opt/homebrew/bin/zapchat';
const MAC_REAL = '/opt/homebrew/lib/node_modules/zapchat/dist/cli/main.js';

describe('direct-run guard (npm global bin layout)', () => {
  it('recognises the macOS symlinked bin as a direct run', () => {
    // A POSIX-style realpath resolver maps the symlink onto the real file.
    const posixRealpath = (p: string): string =>
      p === MAC_BIN ? MAC_REAL : p;

    assert.equal(isDirectRunOf(MAC_REAL, MAC_BIN, posixRealpath), true);
  });

  it('never auto-starts when merely imported (argv[1] is another program)', () => {
    assert.equal(isDirectRunOf(MAC_REAL, '/usr/bin/some-test-runner', p => p), false);
    assert.equal(isDirectRunOf(MAC_REAL, undefined), false);
  });

  it('keeps plain direct launches working (Windows .cmd shim, dev runs)', () => {
    assert.equal(isDirectRunOf(CLI, CLI, p => p), true);
    assert.equal(isDirectRunOf(CLI, path.join(CLI, '..') + path.sep + 'main.js', p => p), true);
  });

  it('stays false for unresolvable paths instead of throwing', () => {
    const throwing = (): string => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    };

    assert.equal(isDirectRunOf('file:///x/y/main.js', '/x/y/link', throwing), false);
  });

  // End-to-end proof on platforms where symlinks need no privilege (Linux
  // CI): launch through a real symlink and expect the version banner.
  it('launches through a real symlink', { skip: !canSymlink() }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapchat-symlink-'));
    const link = path.join(dir, 'zapchat');
    fs.symlinkSync(CLI, link, 'file');

    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [link, '--version'], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', chunk => (stdout += chunk));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`symlinked launch timed out; stdout=${JSON.stringify(stdout)}`));
      }, 15_000);
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer);
        resolve({ code, stdout });
      });
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);
  });
});

function canSymlink(): boolean {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapchat-symprobe-'));
    const target = path.join(dir, 't');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, path.join(dir, 'l'), 'file');
    return true;
  } catch {
    return false;
  }
}
