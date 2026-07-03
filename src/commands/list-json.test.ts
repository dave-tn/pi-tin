import { describe, expect, test } from 'bun:test';
import { toWorkspaceListJson } from './list.js';

describe('toWorkspaceListJson', () => {
  test('emits numeric sessions and remaining shutdownMs for an armed shutdown', () => {
    const nowMs = 1_000_000;
    const json = toWorkspaceListJson([
      {
        workspace: 'web',
        profile: 'node-dev',
        status: 'running',
        activity: { kind: 'active', sessions: 2, shutdownDeadlineMs: nowMs + 90_000 },
        projects: 3,
      },
    ], nowMs);
    expect(json).toEqual([
      { workspace: 'web', profile: 'node-dev', status: 'running', sessions: 2, shutdownMs: 90_000, projects: 3 },
    ]);
  });

  test('emits null shutdownMs when no shutdown is armed', () => {
    const json = toWorkspaceListJson([
      {
        workspace: 'web',
        profile: 'node-dev',
        status: 'running',
        activity: { kind: 'active', sessions: 1, shutdownDeadlineMs: null },
        projects: 1,
      },
    ], 1_000_000);
    expect(json[0]?.sessions).toBe(1);
    expect(json[0]?.shutdownMs).toBeNull();
  });

  test('clamps an expired shutdown deadline to zero, matching the table countdown', () => {
    const nowMs = 1_000_000;
    const json = toWorkspaceListJson([
      {
        workspace: 'web',
        profile: 'node-dev',
        status: 'running',
        activity: { kind: 'active', sessions: 1, shutdownDeadlineMs: nowMs - 5_000 },
        projects: 1,
      },
    ], nowMs);
    expect(json[0]?.shutdownMs).toBe(0);
  });

  test('maps inactive and unreadable runtime state to null, not NaN', () => {
    const json = toWorkspaceListJson([
      { workspace: 'idle', profile: 'bun-dev', status: 'not-found', activity: { kind: 'inactive' }, projects: 1 },
      { workspace: 'broken', profile: 'rust-dev', status: 'running', activity: { kind: 'unreadable' }, projects: 0 },
    ], 1_000_000);
    expect(json[0]?.sessions).toBeNull();
    expect(json[0]?.shutdownMs).toBeNull();
    expect(json[1]?.sessions).toBeNull();
    expect(json[1]?.shutdownMs).toBeNull();
  });
});
