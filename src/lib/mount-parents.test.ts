import { describe, expect, test } from 'bun:test';
import { chownMountParents, planMountParentChown } from './mount-parents.js';

const home = '/home/dev';

describe('planMountParentChown', () => {
  test('returns the runtime-created ancestor of a nested mount', () => {
    const parents = planMountParentChown(
      [{ container: '/home/dev/.nuget/packages' }],
      home,
    );

    expect(parents).toEqual(['/home/dev/.nuget']);
  });

  test('mounts directly under home need no fixup', () => {
    const parents = planMountParentChown(
      [{ container: '/home/dev/.claude' }, { container: '/home/dev/.pi' }],
      home,
    );

    expect(parents).toEqual([]);
  });

  test('deeply nested mounts list every ancestor, parent first', () => {
    const parents = planMountParentChown(
      [{ container: '/home/dev/.cache/tool/data' }],
      home,
    );

    expect(parents).toEqual(['/home/dev/.cache', '/home/dev/.cache/tool']);
  });

  test('mounts sharing a parent yield it once', () => {
    const parents = planMountParentChown(
      [
        { container: '/home/dev/.config/tmux' },
        { container: '/home/dev/.config/gh' },
      ],
      home,
    );

    expect(parents).toEqual(['/home/dev/.config']);
  });

  test('an ancestor that is itself a mount target is excluded', () => {
    const parents = planMountParentChown(
      [
        { container: '/home/dev/.config' },
        { container: '/home/dev/.config/gh' },
      ],
      home,
    );

    expect(parents).toEqual([]);
  });

  test('mounts outside home are ignored', () => {
    const parents = planMountParentChown(
      [{ container: '/workspace/app' }, { container: '/data/cache/pkgs' }],
      home,
    );

    expect(parents).toEqual([]);
  });

  test('container paths are normalised before deriving ancestors', () => {
    const parents = planMountParentChown(
      [{ container: '/home/dev/.nuget/packages/' }],
      home,
    );

    expect(parents).toEqual(['/home/dev/.nuget']);
  });
});

describe('chownMountParents', () => {
  test('runs a single root chown covering every parent', () => {
    const calls: string[][] = [];

    chownMountParents({
      containerName: 'pi-tin-demo',
      user: 'dev',
      parentDirs: ['/home/dev/.config', '/home/dev/.nuget'],
      run: (_file, args) => {
        calls.push(args);
      },
    });

    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'chown', 'dev:dev', '/home/dev/.config', '/home/dev/.nuget'],
    ]);
  });

  test('runs nothing when there are no parents to fix', () => {
    const calls: string[][] = [];

    chownMountParents({
      containerName: 'pi-tin-demo',
      user: 'dev',
      parentDirs: [],
      run: (_file, args) => {
        calls.push(args);
      },
    });

    expect(calls).toEqual([]);
  });

  test('a failed chown warns and does not throw', () => {
    const warnings: string[] = [];

    chownMountParents({
      containerName: 'pi-tin-demo',
      user: 'dev',
      parentDirs: ['/home/dev/.nuget'],
      run: () => {
        throw new Error('exec failed');
      },
      warn: (message) => {
        warnings.push(message);
      },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/home/dev/.nuget');
  });
});
