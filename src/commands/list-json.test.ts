import { describe, expect, test } from 'bun:test';
import { toWorkspaceListJson } from './list.js';

describe('toWorkspaceListJson', () => {
  test('maps a running workspace to numeric sessions', () => {
    const json = toWorkspaceListJson([
      { workspace: 'web', profile: 'node-dev', status: 'running', sessions: '2', shutdown: '–', projects: '3' },
    ]);
    expect(json).toEqual([
      { workspace: 'web', profile: 'node-dev', status: 'running', sessions: 2, shutdownMs: null, projects: 3 },
    ]);
  });

  test('maps not-found / unknown sentinels to null', () => {
    const json = toWorkspaceListJson([
      { workspace: 'idle', profile: 'bun-dev', status: 'not-found', sessions: '–', shutdown: '–', projects: '1' },
      { workspace: 'broken', profile: 'rust-dev', status: 'running', sessions: '?', shutdown: '?', projects: '0' },
    ]);
    expect(json[0]?.sessions).toBeNull();
    expect(json[1]?.sessions).toBeNull();
    expect(json[1]?.shutdownMs).toBeNull();
  });
});
