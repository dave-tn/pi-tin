import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chmodSeededHerdrBinary,
  ensureWorkspaceStateMountDir,
  managedInstallMountPaths,
  measureWorkspaceStateSnapshot,
  planWorkspaceStateSync,
  removeWorkspaceStateSnapshot,
  syncableWorkspaceStatePaths,
  syncWorkspaceState,
  workspaceStateMountDir,
} from './workspace-state.js';
import type { SyncProgressReporter } from './sync-progress.js';
import type { Workspace } from './validators.js';

const hostStateDir = '/host/workspace-state/myws';

// Pinned copy of streamToContainer's pipeline (see src/lib/container.ts): a
// host tar streamed into `container exec`, extracted as the container user.
const STREAM_SCRIPT =
  'set -o pipefail; COPYFILE_DISABLE=1 tar -cf - --format ustar -C "$1" -- "$2" | ' +
  'container exec --interactive --user "$3" "$4" sh -c \'mkdir -p "$1" && tar -xf - -C "$1"\' sh "$5"';

const streamInArgs = (hostParent: string, basename: string, user: string, destParent: string): string[] =>
  ['-c', STREAM_SCRIPT, 'sh', hostParent, basename, user, 'pi-tin-demo', destParent];

// Pinned copy of streamFromContainer's pipeline (see src/lib/container.ts): a
// container-side tar streamed out through `container exec`, extracted on the
// host.
const STREAM_OUT_SCRIPT =
  'set -o pipefail; mkdir -p "$2" && ' +
  'container exec --user root "$3" sh -c \'cd "$1" && tar -cf - .\' sh "$1" | ' +
  'tar -xf - -C "$2"';

const streamOutArgs = (containerPath: string, hostPath: string): string[] =>
  ['-c', STREAM_OUT_SCRIPT, 'sh', containerPath, hostPath, 'pi-tin-demo'];

// Pinned copy of probeContainerPathShape's script (see workspace-state.ts):
// the single exec round-trip that answers both existence and shape. Absence is
// the non-zero exit, not a stdout token, so noisy output can never be mistaken
// for a present path (or vice versa).
const SHAPE_SCRIPT = 'if [ -d "$1" ]; then echo dir; elif [ -e "$1" ]; then echo file; else exit 3; fi';

const shapeProbeArgs = (containerPath: string): string[] =>
  ['exec', '--user', 'root', 'pi-tin-demo', 'sh', '-c', SHAPE_SCRIPT, 'sh', containerPath];

const CLAUDE_TOOL = { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' };
const OPENCODE_TOOL = { name: 'OpenCode', package: 'opencode-ai@latest' };
const CODEX_TOOL = { name: 'Codex', package: '@openai/codex@latest' };

describe('managedInstallMountPaths', () => {
  test('herdr workspaces mount the server bin dir and the session state dir', () => {
    expect(managedInstallMountPaths({ attach: 'herdr', tools: [] }))
      .toEqual(['.local/bin', '.config/herdr']);
  });

  test('shell workspaces without native agents mount nothing', () => {
    expect(managedInstallMountPaths({ attach: 'shell', tools: [CODEX_TOOL] })).toEqual([]);
  });

  test('Claude Code mounts its versions dir and launcher bin dir', () => {
    expect(managedInstallMountPaths({ attach: 'shell', tools: [CLAUDE_TOOL] }))
      .toEqual(['.local/share/claude', '.local/bin']);
  });

  test('OpenCode mounts its bin dir; npm agents add nothing', () => {
    expect(managedInstallMountPaths({ attach: 'shell', tools: [CODEX_TOOL, OPENCODE_TOOL] }))
      .toEqual(['.opencode/bin']);
  });

  // Two mounts at the same container path would be a duplicate --volume for
  // the same host dir, and would double-count against MAX_SHARED_DIRECTORIES.
  test('.local/bin is deduped across Claude Code and herdr', () => {
    expect(managedInstallMountPaths({ attach: 'herdr', tools: [CLAUDE_TOOL] }))
      .toEqual(['.local/share/claude', '.local/bin', '.config/herdr']);
  });
});

describe('syncableWorkspaceStatePaths', () => {
  // A herdr workspace running Claude Code — the widest managed mount set
  // (.local/share/claude, .local/bin, .config/herdr), so one workspace covers
  // every overlap shape.
  const workspace: Pick<Workspace, 'attach' | 'tools'> = { attach: 'herdr', tools: [CLAUDE_TOOL] };
  const profile = (...workspace_state: string[]): { workspace_state: string[] } =>
    ({ workspace_state });

  test('paths that touch no managed mount sync unchanged', () => {
    expect(syncableWorkspaceStatePaths(workspace, profile('.zsh_history', '.local/share/zoxide')))
      .toEqual({ syncable: ['.zsh_history', '.local/share/zoxide'], dropped: [] });
  });

  // The copy-in recipe opens with a root `rm -rf` of the container path. On a
  // live mount that deletes the *host* contents through virtiofs — the
  // agent's install, or herdr's session state.
  test('a path equal to a mount is dropped', () => {
    expect(syncableWorkspaceStatePaths(workspace, profile('.local/bin')))
      .toEqual({ syncable: [], dropped: [{ statePath: '.local/bin', mountPath: '.local/bin' }] });
  });

  test('an ancestor of a mount is dropped — it reaches into the mount just as surely', () => {
    expect(syncableWorkspaceStatePaths(workspace, profile('.local')))
      .toEqual({ syncable: [], dropped: [{ statePath: '.local', mountPath: '.local/share/claude' }] });
  });

  test('a descendant of a mount is dropped', () => {
    expect(syncableWorkspaceStatePaths(workspace, profile('.config/herdr/session.json')))
      .toEqual({
        syncable: [],
        dropped: [{ statePath: '.config/herdr/session.json', mountPath: '.config/herdr' }],
      });
  });

  // Lexical prefix matching alone would drop `.local/binaries` against the
  // `.local/bin` mount, silently losing a legitimate snapshot.
  test('a sibling sharing a name prefix is not an overlap', () => {
    expect(syncableWorkspaceStatePaths(workspace, profile('.local/binaries')).syncable)
      .toEqual(['.local/binaries']);
  });

  // The same profile against a workspace that mounts nothing: the paths are
  // only hazardous because *this* workspace mounts them.
  test('a workspace with no managed mounts syncs every path', () => {
    expect(syncableWorkspaceStatePaths(
      { attach: 'shell', tools: [] },
      profile('.local/bin', '.config/herdr'),
    ).syncable).toEqual(['.local/bin', '.config/herdr']);
  });
});

describe('planWorkspaceStateSync copy-in', () => {
  test('per path: remove stale destination, then copy in as the container user', () => {
    const groups = planWorkspaceStateSync({
      paths: ['.zsh_history'],
      user: 'dev',
      hostStateDir,
      direction: 'copy-in',
    });

    expect(groups).toEqual([[
      { kind: 'remove-container-path', containerPath: '/home/dev/.zsh_history' },
      { kind: 'copy-in', hostPath: '/host/workspace-state/myws/.zsh_history', containerPath: '/home/dev/.zsh_history', user: 'dev' },
    ]]);
  });

  test('uses /root as home for the root user', () => {
    const groups = planWorkspaceStateSync({
      paths: ['.zsh_history'],
      user: 'root',
      hostStateDir,
      direction: 'copy-in',
    });

    expect(groups[0]?.[0]).toEqual({ kind: 'remove-container-path', containerPath: '/root/.zsh_history' });
  });
});

describe('planWorkspaceStateSync copy-out', () => {
  test('per path: copy into a temp sibling, then swap it into place', () => {
    const groups = planWorkspaceStateSync({
      paths: ['.zsh_history'],
      user: 'dev',
      hostStateDir,
      direction: 'copy-out',
    });

    expect(groups).toEqual([[
      { kind: 'ensure-host-parent', hostPath: '/host/workspace-state/myws/.zsh_history' },
      { kind: 'remove-host-path', hostPath: '/host/workspace-state/myws/.zsh_history.pi-tin-tmp' },
      { kind: 'probe-container-path', containerPath: '/home/dev/.zsh_history' },
      { kind: 'copy-out', containerPath: '/home/dev/.zsh_history', hostPath: '/host/workspace-state/myws/.zsh_history.pi-tin-tmp' },
      { kind: 'promote-temp', tempPath: '/host/workspace-state/myws/.zsh_history.pi-tin-tmp', hostPath: '/host/workspace-state/myws/.zsh_history' },
    ]]);
  });

  test('copies out before removing the previous snapshot, so a failed copy cannot destroy it', () => {
    const ops = planWorkspaceStateSync({
      paths: ['.zsh_history'],
      user: 'dev',
      hostStateDir,
      direction: 'copy-out',
    }).flat();

    const copyOutIndex = ops.findIndex((op) => op.kind === 'copy-out');
    const promoteIndex = ops.findIndex((op) => op.kind === 'promote-temp');
    // The only op that touches the real snapshot path is promote-temp, and it
    // runs after the copy — nothing deletes the live snapshot up front.
    expect(copyOutIndex).toBeLessThan(promoteIndex);
    expect(ops.some((op) => op.kind === 'remove-host-path' && op.hostPath === '/host/workspace-state/myws/.zsh_history')).toBe(false);
  });
});

describe('planWorkspaceStateSync ordering and edges', () => {
  test('preserves path order across the op groups', () => {
    const ops = planWorkspaceStateSync({
      paths: ['.zsh_history', '.local/share/zoxide'],
      user: 'dev',
      hostStateDir,
      direction: 'copy-in',
    }).flat();

    const containerPaths = ops.flatMap((op) =>
      op.kind === 'copy-in' ? [op.containerPath] : [],
    );
    expect(containerPaths).toEqual(['/home/dev/.zsh_history', '/home/dev/.local/share/zoxide']);
  });

  test('no paths produces no operations', () => {
    expect(planWorkspaceStateSync({ paths: [], user: 'dev', hostStateDir, direction: 'copy-in' })).toEqual([]);
    expect(planWorkspaceStateSync({ paths: [], user: 'dev', hostStateDir, direction: 'copy-out' })).toEqual([]);
  });
});

describe('managed mount host dirs', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  // Same path the old copy-out machinery snapshotted to, so existing
  // snapshots seed the mounts on upgrade instead of starting empty.
  test('a mount dir sits at its home-relative path inside the workspace state dir', () => {
    expect(workspaceStateMountDir('demo', '.local/share/claude'))
      .toBe(path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo', '.local', 'share', 'claude'));
  });

  test('the pure helper creates nothing; the ensure helper creates the whole chain', () => {
    const mountDir = workspaceStateMountDir('demo', '.local/share/claude');
    expect(fs.existsSync(mountDir)).toBe(false);

    expect(ensureWorkspaceStateMountDir('demo', '.local/share/claude')).toBe(mountDir);
    expect(fs.statSync(mountDir).isDirectory()).toBe(true);
  });

  // herdr is the one mounted binary with no installer behind it to self-heal,
  // and old snapshots may have lost the bit to a `container cp` round-trip.
  test('a seeded herdr binary regains its exec bit', () => {
    const binDir = ensureWorkspaceStateMountDir('demo', '.local/bin');
    const binaryPath = path.join(binDir, 'herdr');
    fs.writeFileSync(binaryPath, 'server', { mode: 0o644 });

    chmodSeededHerdrBinary('demo');

    expect(fs.statSync(binaryPath).mode & 0o111).toBe(0o111);
  });

  test('no seeded binary is not an error', () => {
    ensureWorkspaceStateMountDir('demo', '.local/bin');
    expect(() => { chmodSeededHerdrBinary('demo'); }).not.toThrow();
  });
});

function timeoutError(): Error {
  const error = new Error('spawnSync container ETIMEDOUT');
  Object.assign(error, { code: 'ETIMEDOUT' });
  return error;
}

describe('copy-out mechanism selection', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    stateDir = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  test('a directory entry streams out through tar', async () => {
    const copyCalls: Array<{ file: string; args: string[] }> = [];
    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', paths: ['.config/herdr'], user: 'dev', direction: 'copy-out' },
      {
        capture: (_file, args): string => (args.join(' ').includes('echo dir') ? 'dir\n' : ''),
        copy: (file, args): Promise<void> => {
          copyCalls.push({ file, args });
          return Promise.resolve();
        },
        // Guard the seam the sibling blocks guard: a tool-state copy-out
        // recipe touches no `run` op today, so an unexpected subprocess here
        // would mean the recipe grew one silently.
        run: (): void => { throw new Error('unexpected run seam'); },
      },
    );
    expect(copyCalls).toEqual([{
      file: '/bin/sh',
      args: streamOutArgs('/home/dev/.config/herdr', path.join(stateDir, '.config', 'herdr.pi-tin-tmp')),
    }]);
  });

  test('a single-file entry still uses container cp', async () => {
    const copyCalls: Array<{ file: string; args: string[] }> = [];
    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', paths: ['.zsh_history'], user: 'dev', direction: 'copy-out' },
      {
        capture: (_file, args): string => (args.join(' ').includes('echo dir') ? 'file\n' : ''),
        copy: (file, args): Promise<void> => {
          copyCalls.push({ file, args });
          return Promise.resolve();
        },
      },
    );
    expect(copyCalls).toHaveLength(1);
    expect(copyCalls[0]?.file).toBe('container');
    expect(copyCalls[0]?.args[0]).toBe('cp');
  });

  // copyOutIsDirectory lives on the per-entry context, so a directory entry
  // must not leave the next entry streaming a single file through tar.
  test('a file entry after a directory entry still uses container cp', async () => {
    const copyCalls: Array<{ file: string; args: string[] }> = [];
    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        paths: ['.config/herdr', '.zsh_history'],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        capture: (_file, args): string =>
          (args.includes('/home/dev/.config/herdr') ? 'dir\n' : 'file\n'),
        copy: (file, args): Promise<void> => {
          copyCalls.push({ file, args });
          return Promise.resolve();
        },
      },
    );
    expect(copyCalls).toEqual([
      {
        file: '/bin/sh',
        args: streamOutArgs('/home/dev/.config/herdr', path.join(stateDir, '.config', 'herdr.pi-tin-tmp')),
      },
      {
        file: 'container',
        args: ['cp', 'pi-tin-demo:/home/dev/.zsh_history', path.join(stateDir, '.zsh_history.pi-tin-tmp')],
      },
    ]);
  });

  // Container output is untrusted: an unrecognised shape must fall back to cp,
  // which is correct for every shape. Guessing 'dir' for a real file would make
  // the tar stream fail and lose that entry's snapshot update.
  test('unrecognised probe output falls back to container cp', async () => {
    const copyCalls: Array<{ file: string; args: string[] }> = [];
    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', paths: ['.config/herdr'], user: 'dev', direction: 'copy-out' },
      {
        capture: (_file, args): string => (args.join(' ').includes('echo dir') ? 'wat\n' : ''),
        copy: (file, args): Promise<void> => {
          copyCalls.push({ file, args });
          return Promise.resolve();
        },
      },
    );
    expect(copyCalls[0]?.file).toBe('container');
  });

  // Absence rides the probe's non-zero exit, never a stdout token: stdout is
  // untrusted and the 'file' fallback would send a missing path to
  // `container cp`, which can wedge.
  test('an absent container path still skips the entry without copying', async () => {
    const copyCalls: string[] = [];
    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', paths: ['.config/herdr'], user: 'dev', direction: 'copy-out' },
      {
        capture: (): string => { throw new Error("'container' exited with status 3"); },
        copy: (file): Promise<void> => {
          copyCalls.push(file);
          return Promise.resolve();
        },
      },
    );
    expect(copyCalls).toEqual([]);
  });
});

describe('syncWorkspaceState timeout handling', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  test('skips a missing container path and continues with later entries', async () => {
    const calls: string[][] = [];

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        paths: ['.local/share/zoxide', '.zsh_history'],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        // A tool-state copy-out recipe never uses the run seam; a future op
        // added on it should fail loudly here rather than silently spawning
        // a real `container`.
        run: (): void => { throw new Error('unexpected run seam'); },
        capture: (_file, args): string => {
          calls.push(args);
          // The absent path's probe exits non-zero (see SHAPE_SCRIPT), which
          // execContainerCommandOutput surfaces as a throw.
          if (args.includes('/home/dev/.local/share/zoxide')) {
            throw new Error("'container' exited with status 3");
          }
          return 'file\n';
        },
        copy: (_file, args): Promise<void> => { calls.push(args); return Promise.resolve(); },
      },
    );

    expect(calls).toEqual([
      shapeProbeArgs('/home/dev/.local/share/zoxide'),
      shapeProbeArgs('/home/dev/.zsh_history'),
      ['cp', 'pi-tin-demo:/home/dev/.zsh_history', path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo', '.zsh_history.pi-tin-tmp')],
    ]);
  });

  test('warns and aborts the rest of the sync when the existence probe times out', async () => {
    const calls: string[][] = [];
    const warnings: string[] = [];

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        paths: ['.zsh_history', '.local/share/zoxide'],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        // A tool-state copy-out recipe never uses the run seam; a future op
        // added on it should fail loudly here rather than silently spawning
        // a real `container`.
        run: (): void => { throw new Error('unexpected run seam'); },
        capture: (_file, args): string => {
          calls.push(args);
          throw timeoutError();
        },
        warn: (message): void => {
          warnings.push(message);
        },
      },
    );

    expect(calls).toEqual([
      shapeProbeArgs('/home/dev/.zsh_history'),
    ]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-out timed out after 5s for '/home/dev/.zsh_history' in workspace 'demo' — container runtime unresponsive; skipping the rest of this sync.",
    ]);
  });

  test('copy-out: a timed-out copy skips only that path — later entries still sync', async () => {
    const calls: string[][] = [];
    const warnings: string[] = [];

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        paths: ['.nuget/packages', '.zsh_history'],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        // A tool-state copy-out recipe never uses the run seam; a future op
        // added on it should fail loudly here rather than silently spawning
        // a real `container`.
        run: (): void => { throw new Error('unexpected run seam'); },
        // Forced to 'file' regardless of what .nuget/packages would really be
        // (a directory) — this test is about timeout handling, not shape
        // selection, and the pinned `['cp', …]` assertion below needs the
        // container cp path. Do not "correct" this to 'dir'.
        capture: (_file, args): string => {
          calls.push(args);
          return 'file\n';
        },
        copy: (_file, args): Promise<void> => {
          calls.push(args);
          const oversizedCopy = args[0] === 'cp' && args[1] === 'pi-tin-demo:/home/dev/.nuget/packages';
          return oversizedCopy ? Promise.reject(timeoutError()) : Promise.resolve();
        },
        warn: (message): void => {
          warnings.push(message);
        },
      },
    );

    expect(calls).toEqual([
      shapeProbeArgs('/home/dev/.nuget/packages'),
      ['cp', 'pi-tin-demo:/home/dev/.nuget/packages', path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo', '.nuget/packages.pi-tin-tmp')],
      shapeProbeArgs('/home/dev/.zsh_history'),
      ['cp', 'pi-tin-demo:/home/dev/.zsh_history', path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo', '.zsh_history.pi-tin-tmp')],
    ]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-out timed out after 5s for '/home/dev/.nuget/packages' in workspace 'demo' — skipping this path. It is likely too large to snapshot; workspace_state suits small tool state — persist large paths with a host.mounts entry instead (README → Workspace state).",
    ]);
  });

  test('copy-in: a failed stream warns — the remove already cleared the container copy', async () => {
    const stateDir = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.zsh_history'), 'snapshot');
    const calls: string[][] = [];
    const warnings: string[] = [];

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        paths: ['.zsh_history', '.local/share/zoxide'],
        user: 'dev',
        direction: 'copy-in',
      },
      {
        run: (_file, args): void => {
          calls.push(args);
        },
        copy: (_file, args): Promise<void> => {
          calls.push(args);
          return args.includes(STREAM_SCRIPT) ? Promise.reject(new Error('tar exited with code 1')) : Promise.resolve();
        },
        warn: (message): void => {
          warnings.push(message);
        },
      },
    );

    // Best-effort: the failure is warned but later entries still sync (the
    // second entry has no host snapshot, so only its remove runs).
    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.zsh_history'],
      streamInArgs(stateDir, '.zsh_history', 'dev', '/home/dev'),
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.local/share/zoxide'],
    ]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-in failed for '/home/dev/.zsh_history' in workspace 'demo' — starting without it (the container-side copy was already cleared). Common causes: a file of 8 GiB or larger or a single path component over 100 characters (ustar limits), or a container image without tar.",
    ]);
  });

  test('copy-out: a failed stream warns — the snapshot silently stops advancing otherwise', async () => {
    const stateDir = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
    fs.mkdirSync(path.join(stateDir, '.config'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.config', 'herdr'), 'previous snapshot');
    const warnings: string[] = [];
    const copyCalls: string[][] = [];

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        paths: ['.config/herdr', '.zsh_history'],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        capture: (_file, args): string =>
          (args.includes('/home/dev/.config/herdr') ? 'dir\n' : 'file\n'),
        copy: (_file, args): Promise<void> => {
          copyCalls.push(args);
          if (!args.includes(STREAM_OUT_SCRIPT)) return Promise.resolve();
          // Reproduce what a real failed stream leaves behind. The script
          // runs `mkdir -p "$2"` before the pipeline, so a directory
          // copy-out that fails ALWAYS leaves a temp holding however much
          // tar had extracted. Without writing it here the assertion below
          // would pass on promote-temp's existsSync no-op instead of on the
          // guard it names.
          const temp = path.join(stateDir, '.config', 'herdr.pi-tin-tmp');
          fs.mkdirSync(temp, { recursive: true });
          fs.writeFileSync(path.join(temp, 'torn'), 'half an archive');
          // GNU tar's "file changed as we read it" is exit 1, and pipefail
          // fails the whole entry on it.
          return Promise.reject(new Error('tar exited with status 1'));
        },
        warn: (message): void => { warnings.push(message); },
      },
    );

    // The previous snapshot survives (promote-temp never ran) and later
    // entries still sync. Promoting the torn tree would silently replace good
    // state with half an archive, and the next copy-in would restore that.
    expect(fs.readFileSync(path.join(stateDir, '.config', 'herdr'), 'utf-8')).toBe('previous snapshot');
    expect(fs.existsSync(path.join(stateDir, '.config', 'herdr', 'torn'))).toBe(false);
    expect(copyCalls).toHaveLength(2);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-out failed for '/home/dev/.config/herdr' in workspace 'demo' — the previous snapshot was left intact, so this session's changes to that path are not saved. Common causes: the path vanishing mid-sync, or, for directory copies (streamed through tar), a container image without tar or a file changing while the tree was being archived.",
    ]);
  });

  test('copy-out: a wedged runtime stops the sync at the next probe after a timed-out copy', async () => {
    const calls: string[][] = [];
    const warnings: string[] = [];

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        paths: ['.nuget/packages', '.zsh_history', '.local/share/zoxide'],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        // A tool-state copy-out recipe never uses the run seam; a future op
        // added on it should fail loudly here rather than silently spawning
        // a real `container`.
        run: (): void => { throw new Error('unexpected run seam'); },
        // First call across either runner answers before the runtime wedges;
        // everything after (the big copy, then the next entry's probe) hits
        // the deadline. Both runners share the same `calls` array, so the
        // count is a single sequential counter across capture and cp calls —
        // exactly as when one runner served both, pre-split.
        // Forced to 'file' regardless of what .nuget/packages would really be
        // (a directory) — this test is about timeout handling, not shape
        // selection, and the pinned `['cp', …]` assertion below needs the
        // container cp path. Do not "correct" this to 'dir'.
        capture: (_file, args): string => {
          calls.push(args);
          if (calls.length !== 1) throw timeoutError();
          return 'file\n';
        },
        copy: (_file, args): Promise<void> => {
          calls.push(args);
          return calls.length === 1 ? Promise.resolve() : Promise.reject(timeoutError());
        },
        warn: (message): void => {
          warnings.push(message);
        },
      },
    );

    expect(calls).toEqual([
      shapeProbeArgs('/home/dev/.nuget/packages'),
      ['cp', 'pi-tin-demo:/home/dev/.nuget/packages', path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo', '.nuget/packages.pi-tin-tmp')],
      shapeProbeArgs('/home/dev/.zsh_history'),
    ]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-out timed out after 5s for '/home/dev/.nuget/packages' in workspace 'demo' — skipping this path. It is likely too large to snapshot; workspace_state suits small tool state — persist large paths with a host.mounts entry instead (README → Workspace state).",
      "Warning: workspace_state copy-out timed out after 5s for '/home/dev/.zsh_history' in workspace 'demo' — container runtime unresponsive; skipping the rest of this sync.",
    ]);
  });

  test('copy-in: a timed-out copy skips only that path — later entries still sync', async () => {
    const stateDir = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.zsh_history'), 'snapshot');

    const calls: string[][] = [];
    const warnings: string[] = [];

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        paths: ['.zsh_history', '.local/share/zoxide'],
        user: 'dev',
        direction: 'copy-in',
      },
      {
        run: (_file, args): void => {
          calls.push(args);
        },
        copy: (_file, args): Promise<void> => {
          calls.push(args);
          return args.includes(STREAM_SCRIPT) ? Promise.reject(timeoutError()) : Promise.resolve();
        },
        warn: (message): void => {
          warnings.push(message);
        },
      },
    );

    // The second entry still syncs (it has no host snapshot, so only its
    // remove runs).
    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.zsh_history'],
      streamInArgs(stateDir, '.zsh_history', 'dev', '/home/dev'),
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.local/share/zoxide'],
    ]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-in timed out after 5s for '/home/dev/.zsh_history' in workspace 'demo' — skipping this path. It is likely too large to snapshot; workspace_state suits small tool state — persist large paths with a host.mounts entry instead (README → Workspace state).",
    ]);
  });

  test('copy-in: a timed-out remove skips the rest of the entry and the sync', async () => {
    const stateDir = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.zsh_history'), 'snapshot');

    const calls: string[][] = [];
    const warnings: string[] = [];

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        paths: ['.zsh_history', '.local/share/zoxide'],
        user: 'dev',
        direction: 'copy-in',
      },
      {
        run: (_file, args): void => {
          calls.push(args);
          if (args.includes('rm')) {
            throw timeoutError();
          }
        },
        warn: (message): void => {
          warnings.push(message);
        },
      },
    );

    // A timed-out `rm` (near-instant when the runtime is healthy) means the
    // runtime is wedged: the copy is not attempted and the rest of the sync
    // is abandoned.
    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.zsh_history'],
    ]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-in timed out after 5s for '/home/dev/.zsh_history' in workspace 'demo' — container runtime unresponsive; skipping the rest of this sync.",
    ]);
  });

  test('copy-out: a partial temp left by a timed-out copy is never promoted over the previous snapshot', async () => {
    const stateDir = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
    fs.mkdirSync(stateDir, { recursive: true });
    const snapshotPath = path.join(stateDir, '.zsh_history');
    fs.writeFileSync(snapshotPath, 'previous snapshot');
    let copyCalls = 0;

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        paths: ['.zsh_history'],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        // A tool-state copy-out recipe never uses the run seam; a future op
        // added on it should fail loudly here rather than silently spawning
        // a real `container`.
        run: (): void => { throw new Error('unexpected run seam'); },
        capture: (): string => 'file\n',
        copy: (): Promise<void> => {
          copyCalls += 1;
          // Simulate a copy SIGKILLed mid-write: a partial temp exists.
          fs.writeFileSync(`${snapshotPath}.pi-tin-tmp`, 'partial');
          return Promise.reject(timeoutError());
        },
        warn: (): void => {},
      },
    );

    // Pins the test to the copy-then-timeout path it names — without this,
    // a future change that skipped the entry before the copy fake ran would
    // pass vacuously, since an untouched snapshot also satisfies the
    // assertion below.
    expect(copyCalls).toBe(1);
    expect(fs.readFileSync(snapshotPath, 'utf-8')).toBe('previous snapshot');
  });
});

function createReporterCapture(): { events: string[]; report: SyncProgressReporter } {
  const events: string[] = [];
  return {
    events,
    report: {
      startEntry: (entryPath): void => { events.push(`start ${entryPath}`); },
      copyStarted: (progress): void => {
        events.push(`copy total=${progress.totalBytes === null ? 'null' : progress.totalBytes} live=${progress.currentBytes === null ? 'no' : 'yes'}`);
      },
      finishEntry: (outcome): void => { events.push(`finish ${outcome.kind}`); },
    },
  };
}

describe('syncWorkspaceState progress reporting', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    stateDir = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  test('copy-out reports done with a live byte poll', async () => {
    const { events, report } = createReporterCapture();
    const tempPath = path.join(stateDir, '.zsh_history.pi-tin-tmp');

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', paths: ['.zsh_history'], user: 'dev', direction: 'copy-out' },
      {
        // A tool-state copy-out recipe never uses the run seam; a future op
        // added on it should fail loudly here rather than silently spawning
        // a real `container`.
        run: (): void => { throw new Error('unexpected run seam'); },
        capture: (): string => 'file\n',
        // Simulate `container cp` producing the temp path mid-copy: the live
        // poll (hostSnapshotBytes on the temp) reads it back.
        copy: (): Promise<void> => {
          fs.mkdirSync(path.dirname(tempPath), { recursive: true });
          fs.writeFileSync(tempPath, 'snapshot');
          return Promise.resolve();
        },
        report,
      },
    );

    expect(events).toEqual(['start .zsh_history', 'copy total=null live=yes', 'finish done']);
  });

  test('absent copy-out source reports skipped', async () => {
    const { events, report } = createReporterCapture();

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', paths: ['.zsh_history'], user: 'dev', direction: 'copy-out' },
      {
        // A tool-state copy-out recipe never uses the run seam; a future op
        // added on it should fail loudly here rather than silently spawning
        // a real `container`.
        run: (): void => { throw new Error('unexpected run seam'); },
        capture: (): string => { throw new Error('missing'); },
        report,
      },
    );

    expect(events.at(-1)).toBe('finish skipped');
  });

  test('copy-in missing host snapshot reports skipped', async () => {
    const { events, report } = createReporterCapture();
    const calls: string[][] = [];

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', paths: ['.zsh_history'], user: 'dev', direction: 'copy-in' },
      {
        run: (_file, args): void => { calls.push(args); },
        // Nothing to send means nothing to copy; without the guard a regression
        // that copied anyway would spawn a real `container` from the suite.
        copy: (): Promise<void> => { throw new Error('unexpected copy seam'); },
        report,
      },
    );

    expect(events.at(-1)).toBe('finish skipped');
    // The container-side clear still ran even though the host has nothing to
    // send.
    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.zsh_history'],
    ]);
  });

  test('copy timeout reports timed out and still warns', async () => {
    const { events, report } = createReporterCapture();
    const warnings: string[] = [];

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', paths: ['.zsh_history'], user: 'dev', direction: 'copy-out' },
      {
        // A tool-state copy-out recipe never uses the run seam; a future op
        // added on it should fail loudly here rather than silently spawning
        // a real `container`.
        run: (): void => { throw new Error('unexpected run seam'); },
        capture: (): string => 'file\n',
        copy: (): Promise<void> => Promise.reject(timeoutError()),
        warn: (message): void => { warnings.push(message); },
        report,
      },
    );

    expect(events.at(-1)).toBe('finish timed-out');
    // The warning text itself is pinned once, in the timeout-handling block —
    // what this test adds is that the reporter closes the entry as well.
    expect(warnings).toHaveLength(1);
  });

  // The 'failed' outcome closes the entry line before the deferred warning
  // prints; nothing asserted it, so a reporter that silently dropped failures
  // would leave the entry hanging mid-render with no failing test.
  test('a failed copy reports failed and still warns', async () => {
    const { events, report } = createReporterCapture();
    const warnings: string[] = [];
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.zsh_history'), 'snapshot');

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', paths: ['.zsh_history'], user: 'dev', direction: 'copy-in' },
      {
        run: (): void => {},
        copy: (): Promise<void> => Promise.reject(new Error('tar exited with code 1')),
        warn: (message): void => { warnings.push(message); },
        report,
      },
    );

    expect(events.at(-1)).toBe('finish failed');
    expect(warnings).toHaveLength(1);
  });

  test('no reporter injected is silent and still syncs', async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.zsh_history'), 'snapshot');
    const calls: string[][] = [];

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', paths: ['.zsh_history'], user: 'dev', direction: 'copy-in' },
      {
        run: (_file, args): void => { calls.push(args); },
        copy: (_file, args): Promise<void> => { calls.push(args); return Promise.resolve(); },
      },
    );

    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.zsh_history'],
      streamInArgs(stateDir, '.zsh_history', 'dev', '/home/dev'),
    ]);
  });
});


// Regression: `pi-tin delete` removed the workspace, container and image but
// left ~/.config/pi-tin/workspace-state/<name>/ behind — routinely the largest
// artifact a workspace creates (259 MB observed). XDG_CONFIG_HOME points at a
// temp dir so nothing here touches the real config dir.
describe('workspace state snapshot removal', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  function seedSnapshot(workspaceName: string): string {
    const dir = path.join(tmpDir, 'pi-tin', 'workspace-state', workspaceName);
    fs.mkdirSync(path.join(dir, '.config', 'herdr'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.zsh_history'), 'a'.repeat(100));
    fs.writeFileSync(path.join(dir, '.config', 'herdr', 'config.toml'), 'b'.repeat(50));
    return dir;
  }

  test('measures the snapshot directory and its nested contents', () => {
    const dir = seedSnapshot('demo');

    expect(measureWorkspaceStateSnapshot('demo')).toEqual({ path: dir, bytes: 150 });
  });

  // A dangling target also proves the walk lstats the link itself — stat
  // would throw ENOENT here — so the measurement can never pull in a target
  // that lives outside the snapshot.
  test('counts a symlink as its own lstat size, never its target', () => {
    const dir = seedSnapshot('demo');
    fs.symlinkSync('dangling-target', path.join(dir, 'link'));

    expect(measureWorkspaceStateSnapshot('demo')).toEqual({
      path: dir,
      bytes: 150 + 'dangling-target'.length,
    });
  });

  // Root ignores directory permissions, so the unreadable subtree would be
  // counted and the test would fail for the wrong reason.
  test.skipIf(process.getuid?.() === 0)(
    'skips unreadable subtrees instead of aborting the measurement',
    () => {
      const dir = seedSnapshot('demo');
      const locked = path.join(dir, 'locked');
      fs.mkdirSync(locked);
      fs.writeFileSync(path.join(locked, 'hidden'), 'c'.repeat(25));
      fs.chmodSync(locked, 0o000);
      try {
        expect(measureWorkspaceStateSnapshot('demo')).toEqual({ path: dir, bytes: 150 });
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    },
  );

  test('measures nothing for a workspace that never persisted state', () => {
    expect(measureWorkspaceStateSnapshot('demo')).toBeNull();
  });

  test('removes the whole snapshot tree from the host', () => {
    const dir = seedSnapshot('demo');

    expect(removeWorkspaceStateSnapshot(measureWorkspaceStateSnapshot('demo'))).toBe('removed');
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('reports absent (and removes nothing) when there is no snapshot', () => {
    const removed: string[] = [];

    const outcome = removeWorkspaceStateSnapshot(measureWorkspaceStateSnapshot('demo'), {
      remove: (dir): void => { removed.push(dir); },
    });

    expect(outcome).toBe('absent');
    expect(removed).toEqual([]);
  });

  // The container and image are already gone by the time this runs, so a
  // failure must warn and report — never throw and leave a half-deleted
  // workspace behind.
  test('warns and reports failure instead of throwing when removal fails', () => {
    const dir = seedSnapshot('demo');
    const warnings: string[] = [];

    const outcome = removeWorkspaceStateSnapshot(measureWorkspaceStateSnapshot('demo'), {
      remove: (): void => { throw new Error('Permission denied'); },
      warn: (message): void => { warnings.push(message); },
    });

    expect(outcome).toBe('failed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(dir);
    expect(warnings[0]).toContain('Permission denied');
  });
});
