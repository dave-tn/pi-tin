import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeUpdateNoticeEnabled, readUpdateCache, writeUpdateCache } from './update-check.js';

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
