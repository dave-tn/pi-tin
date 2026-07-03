import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeUpdateNoticeEnabled,
  readUpdateCache,
  runUpdateCheckHelper,
  writeUpdateCache,
} from './update-check.js';

describe('computeUpdateNoticeEnabled', () => {
  const base = { argv: ['open', 'demo'], env: {} as NodeJS.ProcessEnv, isTty: true };

  test('enabled on an interactive TTY with a clean env', () => {
    expect(computeUpdateNoticeEnabled(base)).toBe(true);
  });

  test('disabled when stdout is not a TTY', () => {
    expect(computeUpdateNoticeEnabled({ ...base, isTty: false })).toBe(false);
  });

  test('disabled when --json is present', () => {
    expect(computeUpdateNoticeEnabled({ ...base, argv: ['ls', '--json'] })).toBe(false);
  });

  test('disabled when CI is set', () => {
    expect(computeUpdateNoticeEnabled({ ...base, env: { CI: 'true' } })).toBe(false);
  });

  test('disabled by the pi-tin-namespaced opt-out', () => {
    expect(computeUpdateNoticeEnabled({ ...base, env: { PI_TIN_NO_UPDATE_NOTIFIER: '1' } })).toBe(false);
  });

  test('disabled by the ecosystem opt-out', () => {
    expect(computeUpdateNoticeEnabled({ ...base, env: { NO_UPDATE_NOTIFIER: '1' } })).toBe(false);
  });

  test('an empty env var does not opt out', () => {
    expect(computeUpdateNoticeEnabled({ ...base, env: { CI: '' } })).toBe(true);
  });
});

describe('readUpdateCache', () => {
  let tmpDir: string;
  const original = process.env['XDG_CONFIG_HOME'];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-update-'));
    process.env['XDG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = original;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns null when the cache file is missing', () => {
    expect(readUpdateCache()).toBeNull();
  });

  test('round-trips a written cache', () => {
    writeUpdateCache({ lastCheckMs: 42, latestVersion: '0.2.0' });
    expect(readUpdateCache()).toEqual({ lastCheckMs: 42, latestVersion: '0.2.0' });
  });

  test('returns null on corrupt JSON', () => {
    const statePath = path.join(tmpDir, 'pi-tin', 'state', 'update-check.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{ not json', 'utf-8');
    expect(readUpdateCache()).toBeNull();
  });

  test('returns null when the JSON does not match the schema', () => {
    const statePath = path.join(tmpDir, 'pi-tin', 'state', 'update-check.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ lastCheckMs: 'nope' }), 'utf-8');
    expect(readUpdateCache()).toBeNull();
  });
});

describe('runUpdateCheckHelper', () => {
  let tmpDir: string;
  const originalXdg = process.env['XDG_CONFIG_HOME'];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-update-helper-'));
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    // PKG_VERSION is a build-time define; provide it for the test runtime.
    Reflect.set(globalThis, 'PKG_VERSION', '0.0.0-test');
  });

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalXdg;
    }
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, 'PKG_VERSION');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const mockFetch = (impl: () => Promise<Response>): void => {
    globalThis.fetch = Object.assign(impl, { preconnect: originalFetch.preconnect });
  };

  test('a network failure resolves silently and leaves the cache untouched', async () => {
    mockFetch(() => Promise.reject(new TypeError('fetch failed')));
    await runUpdateCheckHelper();
    expect(readUpdateCache()).toBeNull();
  });

  test('a non-ok response resolves silently and leaves the cache untouched', async () => {
    mockFetch(() => Promise.resolve(new Response('nope', { status: 500 })));
    await runUpdateCheckHelper();
    expect(readUpdateCache()).toBeNull();
  });

  test('a malformed JSON body resolves silently and leaves the cache untouched', async () => {
    mockFetch(() => Promise.resolve(new Response('not json', { status: 200 })));
    await runUpdateCheckHelper();
    expect(readUpdateCache()).toBeNull();
  });

  test('a successful check writes the cache', async () => {
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ latest: '9.9.9' }), { status: 200 })));
    await runUpdateCheckHelper();
    expect(readUpdateCache()?.latestVersion).toBe('9.9.9');
  });

  test('an unwritable cache path resolves silently', async () => {
    // A file where the config dir should be makes the cache mkdir/write fail.
    process.env['XDG_CONFIG_HOME'] = path.join(tmpDir, 'blocker');
    fs.writeFileSync(path.join(tmpDir, 'blocker'), 'not a directory', 'utf-8');
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ latest: '9.9.9' }), { status: 200 })));
    await runUpdateCheckHelper();
  });

  test('an unexpected programming error propagates instead of being swallowed', async () => {
    // Regression: the shipped PKG_VERSION ReferenceError was hidden for a full
    // release by a blanket catch. Unexpected errors must reject the helper.
    Reflect.deleteProperty(globalThis, 'PKG_VERSION');
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ latest: '9.9.9' }), { status: 200 })));
    await expect(runUpdateCheckHelper()).rejects.toThrow(ReferenceError);
  });
});
