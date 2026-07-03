import type { UpdateCheckCache } from './validators.js';
import { parseSemver } from './semver.js';

export type UpdateAction =
  | { kind: 'notify'; latest: string }
  | { kind: 'spawn-check' };

// True only when `latest` is a strictly higher release than `current`. Unknown
// or malformed versions compare as "not newer" so we stay quiet rather than
// nag on garbage input.
export function isNewerVersion(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (!l || !c) {
    return false;
  }
  if (l.major !== c.major) {
    return l.major > c.major;
  }
  if (l.minor !== c.minor) {
    return l.minor > c.minor;
  }
  return l.patch > c.patch;
}

// Pure decision: given the current version, the last cached result, and the
// clock, return the ordered actions to perform. `notify` is driven purely by
// the cached version (no network); `spawn-check` refreshes the cache for next
// time. Both may co-occur.
export function planUpdateNotice(input: {
  currentVersion: string;
  cache: UpdateCheckCache | null;
  nowMs: number;
  intervalMs: number;
}): UpdateAction[] {
  const { currentVersion, cache, nowMs, intervalMs } = input;
  const actions: UpdateAction[] = [];

  if (cache && isNewerVersion(cache.latestVersion, currentVersion)) {
    actions.push({ kind: 'notify', latest: cache.latestVersion });
  }

  const stale = !cache || nowMs - cache.lastCheckMs >= intervalMs;
  if (stale) {
    actions.push({ kind: 'spawn-check' });
  }

  return actions;
}

export function formatUpdateNotice(latest: string, current: string): string {
  return `pi-tin ${latest} available (you have ${current}) · update: npm i -g pi-tin`;
}
