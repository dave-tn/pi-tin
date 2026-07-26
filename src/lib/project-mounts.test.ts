import { describe, test, expect } from 'bun:test';
import {
  countUniqueVolumeSources,
  resolveProjectVolumes,
  sharedDirectoryLimitMessage,
  basenameCollisionMessage,
} from './project-mounts.js';

describe('resolveProjectVolumes', () => {
  test('maps projects to /workspace by basename', () => {
    expect(resolveProjectVolumes([
      '/Users/dave/Dev/app-one',
      '/Users/dave/Dev/app-two',
    ])).toEqual([
      { host: '/Users/dave/Dev/app-one', container: '/workspace/app-one' },
      { host: '/Users/dave/Dev/app-two', container: '/workspace/app-two' },
    ]);
  });
});

describe('countUniqueVolumeSources', () => {
  test('deduplicates repeated host sources', () => {
    expect(countUniqueVolumeSources([
      { host: '/host/a', container: '/one' },
      { host: '/host/a', container: '/two' },
      { host: '/host/b', container: '/three' },
    ])).toBe(2);
  });
});

describe('sharedDirectoryLimitMessage', () => {
  test('names the workspace, the count, and the limit', () => {
    const msg = sharedDirectoryLimitMessage('work', 25);
    expect(msg).toContain("Workspace 'work'");
    expect(msg).toContain('25 shared host directories');
    expect(msg).toContain('up to 22');
  });
});

describe('basenameCollisionMessage', () => {
  test('names the colliding basename and the paths', () => {
    const msg = basenameCollisionMessage('app', ['/a/app', '/b/app']);
    expect(msg).toContain("basename collision 'app'");
    expect(msg).toContain('/a/app');
    expect(msg).toContain('/b/app');
  });
});
