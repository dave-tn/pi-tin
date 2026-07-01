import { describe, expect, test } from 'bun:test';
import { isNewerVersion, planUpdateNotice, formatUpdateNotice } from './update-plan.js';
import type { UpdateCheckCache } from './validators.js';

describe('isNewerVersion', () => {
  test('true when latest is a higher patch, minor, or major', () => {
    expect(isNewerVersion('1.2.4', '1.2.3')).toBe(true);
    expect(isNewerVersion('1.3.0', '1.2.9')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
  });

  test('false when latest is equal or older', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.2', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(false);
  });

  test('tolerates a leading v prefix', () => {
    expect(isNewerVersion('v1.2.4', '1.2.3')).toBe(true);
  });

  test('strips prerelease/build metadata before comparing', () => {
    expect(isNewerVersion('1.2.3-beta.1', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.4-beta.1', '1.2.3')).toBe(true);
    expect(isNewerVersion('1.2.4+build.5', '1.2.3')).toBe(true);
  });

  test('returns false (quiet) when either version is unparseable', () => {
    expect(isNewerVersion('not-a-version', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.3.4', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.3', 'garbage')).toBe(false);
  });
});

describe('planUpdateNotice', () => {
  const now = 1_000_000_000_000;
  const interval = 24 * 60 * 60 * 1000;
  const current = '1.2.3';
  const fresh = (latestVersion: string): UpdateCheckCache => ({ lastCheckMs: now - 1000, latestVersion });
  const stale = (latestVersion: string): UpdateCheckCache => ({ lastCheckMs: now - interval - 1, latestVersion });

  const plan = (cache: UpdateCheckCache | null) =>
    planUpdateNotice({ currentVersion: current, cache, nowMs: now, intervalMs: interval });

  test('missing cache -> spawn-check only', () => {
    expect(plan(null)).toEqual([{ kind: 'spawn-check' }]);
  });

  test('newer + fresh -> notify only', () => {
    expect(plan(fresh('1.3.0'))).toEqual([{ kind: 'notify', latest: '1.3.0' }]);
  });

  test('newer + stale -> notify then spawn-check', () => {
    expect(plan(stale('1.3.0'))).toEqual([{ kind: 'notify', latest: '1.3.0' }, { kind: 'spawn-check' }]);
  });

  test('not newer + fresh -> nothing', () => {
    expect(plan(fresh('1.2.3'))).toEqual([]);
  });

  test('not newer + stale -> spawn-check only', () => {
    expect(plan(stale('1.2.3'))).toEqual([{ kind: 'spawn-check' }]);
  });

  test('interval boundary counts as stale', () => {
    const atBoundary: UpdateCheckCache = { lastCheckMs: now - interval, latestVersion: '1.2.3' };
    expect(plan(atBoundary)).toEqual([{ kind: 'spawn-check' }]);
  });
});

describe('formatUpdateNotice', () => {
  test('renders the one-line notice', () => {
    expect(formatUpdateNotice('1.3.0', '1.2.3')).toBe(
      'pi-tin 1.3.0 available (you have 1.2.3) · update: npm i -g pi-tin',
    );
  });
});
