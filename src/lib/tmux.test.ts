import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureWorkspaceTmuxDir,
  getWorkspaceTmuxDir,
} from './tmux.js';

describe('ensureWorkspaceTmuxDir', () => {
  let tmpDir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-tmux-'));
    originalXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalXdg;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates persistent workspace tmux directories and config file', () => {
    const dir = ensureWorkspaceTmuxDir('demo');

    expect(dir).toBe(getWorkspaceTmuxDir('demo'));
    expect(fs.existsSync(path.join(dir, '.config', 'tmux'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.tmux'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.config', 'tmux', 'tmux.conf'))).toBe(true);
  });
});
