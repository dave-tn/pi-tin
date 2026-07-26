import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  combinedWorkspaceStateEntries,
  hostFingerprint,
  measureWorkspaceStateSnapshot,
  parseContainerFingerprint,
  planWorkspaceStateSync,
  removeWorkspaceStateSnapshot,
  syncWorkspaceState,
  type WorkspaceStateEntry,
} from './workspace-state.js';
import type { SyncProgressReporter } from './sync-progress.js';

const hostStateDir = '/host/workspace-state/myws';

// Pinned copy of streamToContainer's pipeline (see src/lib/container.ts): a
// host tar streamed into `container exec`, extracted as the container user.
const STREAM_SCRIPT =
  'COPYFILE_DISABLE=1 tar -cf - --format ustar -C "$1" -- "$2" | ' +
  'container exec --interactive --user "$3" "$4" sh -c \'mkdir -p "$1" && tar -xf - -C "$1"\' sh "$5"';

const streamInArgs = (hostParent: string, basename: string, user: string, destParent: string): string[] =>
  ['-c', STREAM_SCRIPT, 'sh', hostParent, basename, user, 'pi-tin-demo', destParent];

const toolState = (statePath: string): WorkspaceStateEntry => ({ kind: 'tool-state', path: statePath });

const CLAUDE_TOOL = { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' };
const OPENCODE_TOOL = { name: 'OpenCode', package: 'opencode-ai@latest' };
const CODEX_TOOL = { name: 'Codex', package: '@openai/codex@latest' };

describe('combinedWorkspaceStateEntries', () => {
  const containerProfile = { workspace_state: ['.zsh_history'] };

  test('herdr workspaces add the herdr state dir and the auto-installed server binary', () => {
    expect(combinedWorkspaceStateEntries(containerProfile, { attach: 'herdr', tools: [] }))
      .toEqual([
        { kind: 'tool-state', path: '.zsh_history' },
        { kind: 'tool-state', path: '.config/herdr' },
        { kind: 'binary', path: '.local/bin/herdr', executable: true },
      ]);
  });

  test('shell workspaces without native agents keep only the profile entries', () => {
    expect(combinedWorkspaceStateEntries(containerProfile, { attach: 'shell', tools: [CODEX_TOOL] }))
      .toEqual([{ kind: 'tool-state', path: '.zsh_history' }]);
  });

  test('Claude Code adds its versions dir with the managed launcher metadata', () => {
    expect(combinedWorkspaceStateEntries(containerProfile, { attach: 'shell', tools: [CLAUDE_TOOL] }))
      .toEqual([
        { kind: 'tool-state', path: '.zsh_history' },
        {
          kind: 'binary',
          path: '.local/share/claude',
          executable: false,
          launcher: { link: '.local/bin/claude', versionsDir: '.local/share/claude/versions' },
        },
      ]);
  });

  test('OpenCode adds its flat binary; npm agents add nothing', () => {
    expect(combinedWorkspaceStateEntries(containerProfile, { attach: 'shell', tools: [CODEX_TOOL, OPENCODE_TOOL] }))
      .toEqual([
        { kind: 'tool-state', path: '.zsh_history' },
        { kind: 'binary', path: '.opencode/bin/opencode', executable: true },
      ]);
  });
});

describe('planWorkspaceStateSync copy-in', () => {
  test('per tool-state entry: remove stale destination, then copy in as the container user', () => {
    const groups = planWorkspaceStateSync({
      entries: [toolState('.zsh_history')],
      user: 'dev',
      hostStateDir,
      direction: 'copy-in',
    });

    expect(groups).toEqual([[
      { kind: 'remove-container-path', containerPath: '/home/dev/.zsh_history' },
      { kind: 'copy-in', hostPath: '/host/workspace-state/myws/.zsh_history', containerPath: '/home/dev/.zsh_history', user: 'dev', timeoutMs: 5_000 },
    ]]);
  });

  test('binary entries probe for unchanged content first and carry the binary copy deadline', () => {
    const groups = planWorkspaceStateSync({
      entries: [{ kind: 'binary', path: '.local/bin/herdr', executable: true }],
      user: 'dev',
      hostStateDir,
      direction: 'copy-in',
    });

    expect(groups).toEqual([[
      // Before remove-container-path: with no host snapshot (or matching
      // content) the entry is skipped, so the image-baked binary survives.
      { kind: 'probe-unchanged', containerPath: '/home/dev/.local/bin/herdr', hostPath: '/host/workspace-state/myws/.local/bin/herdr', whenHostMissing: 'skip-entry' },
      { kind: 'remove-container-path', containerPath: '/home/dev/.local/bin/herdr' },
      { kind: 'copy-in', hostPath: '/host/workspace-state/myws/.local/bin/herdr', containerPath: '/home/dev/.local/bin/herdr', user: 'dev', timeoutMs: 60_000 },
      { kind: 'restore-executable', containerPath: '/home/dev/.local/bin/herdr' },
    ]]);
  });

  test('launcher-managed entries restore the symlink after the copy, without a chmod', () => {
    const groups = planWorkspaceStateSync({
      entries: [{
        kind: 'binary',
        path: '.local/share/claude',
        executable: false,
        launcher: { link: '.local/bin/claude', versionsDir: '.local/share/claude/versions' },
      }],
      user: 'dev',
      hostStateDir,
      direction: 'copy-in',
    });

    expect(groups).toEqual([[
      { kind: 'probe-unchanged', containerPath: '/home/dev/.local/share/claude', hostPath: '/host/workspace-state/myws/.local/share/claude', whenHostMissing: 'skip-entry' },
      { kind: 'remove-container-path', containerPath: '/home/dev/.local/share/claude' },
      { kind: 'copy-in', hostPath: '/host/workspace-state/myws/.local/share/claude', containerPath: '/home/dev/.local/share/claude', user: 'dev', timeoutMs: 60_000 },
      {
        kind: 'restore-launcher',
        linkContainerPath: '/home/dev/.local/bin/claude',
        versionsDirContainerPath: '/home/dev/.local/share/claude/versions',
        versionsDirHostPath: '/host/workspace-state/myws/.local/share/claude/versions',
        recordHostPath: '/host/workspace-state/myws/.local/share/claude.pi-tin-launcher',
        user: 'dev',
      },
    ]]);
  });

  test('uses /root as home for the root user', () => {
    const groups = planWorkspaceStateSync({
      entries: [toolState('.zsh_history')],
      user: 'root',
      hostStateDir,
      direction: 'copy-in',
    });

    expect(groups[0]?.[0]).toEqual({ kind: 'remove-container-path', containerPath: '/root/.zsh_history' });
  });
});

describe('planWorkspaceStateSync copy-out', () => {
  test('per tool-state entry: copy into a temp sibling, then swap it into place', () => {
    const groups = planWorkspaceStateSync({
      entries: [toolState('.zsh_history')],
      user: 'dev',
      hostStateDir,
      direction: 'copy-out',
    });

    expect(groups).toEqual([[
      { kind: 'ensure-host-parent', hostPath: '/host/workspace-state/myws/.zsh_history' },
      { kind: 'remove-host-path', hostPath: '/host/workspace-state/myws/.zsh_history.pi-tin-tmp' },
      { kind: 'probe-container-path', containerPath: '/home/dev/.zsh_history' },
      { kind: 'copy-out', containerPath: '/home/dev/.zsh_history', hostPath: '/host/workspace-state/myws/.zsh_history.pi-tin-tmp', timeoutMs: 5_000 },
      { kind: 'promote-temp', tempPath: '/host/workspace-state/myws/.zsh_history.pi-tin-tmp', hostPath: '/host/workspace-state/myws/.zsh_history' },
    ]]);
  });

  test('launcher-managed entries record the launcher target, then skip unchanged content', () => {
    const groups = planWorkspaceStateSync({
      entries: [{
        kind: 'binary',
        path: '.local/share/claude',
        executable: false,
        launcher: { link: '.local/bin/claude', versionsDir: '.local/share/claude/versions' },
      }],
      user: 'dev',
      hostStateDir,
      direction: 'copy-out',
    });

    expect(groups).toEqual([[
      { kind: 'ensure-host-parent', hostPath: '/host/workspace-state/myws/.local/share/claude' },
      { kind: 'remove-host-path', hostPath: '/host/workspace-state/myws/.local/share/claude.pi-tin-tmp' },
      { kind: 'probe-container-path', containerPath: '/home/dev/.local/share/claude' },
      // The record refreshes even when the content copy is skipped as unchanged.
      { kind: 'record-launcher', linkContainerPath: '/home/dev/.local/bin/claude', recordHostPath: '/host/workspace-state/myws/.local/share/claude.pi-tin-launcher' },
      { kind: 'probe-unchanged', containerPath: '/home/dev/.local/share/claude', hostPath: '/host/workspace-state/myws/.local/share/claude', whenHostMissing: 'continue' },
      { kind: 'copy-out', containerPath: '/home/dev/.local/share/claude', hostPath: '/host/workspace-state/myws/.local/share/claude.pi-tin-tmp', timeoutMs: 60_000 },
      { kind: 'promote-temp', tempPath: '/host/workspace-state/myws/.local/share/claude.pi-tin-tmp', hostPath: '/host/workspace-state/myws/.local/share/claude' },
    ]]);
  });

  test('copies out before removing the previous snapshot, so a failed copy cannot destroy it', () => {
    const ops = planWorkspaceStateSync({
      entries: [toolState('.zsh_history')],
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
  test('preserves entry order across the op groups', () => {
    const ops = planWorkspaceStateSync({
      entries: [toolState('.zsh_history'), toolState('.local/share/zoxide')],
      user: 'dev',
      hostStateDir,
      direction: 'copy-in',
    }).flat();

    const containerPaths = ops.flatMap((op) =>
      op.kind === 'copy-in' ? [op.containerPath] : [],
    );
    expect(containerPaths).toEqual(['/home/dev/.zsh_history', '/home/dev/.local/share/zoxide']);
  });

  test('no entries produces no operations', () => {
    expect(planWorkspaceStateSync({ entries: [], user: 'dev', hostStateDir, direction: 'copy-in' })).toEqual([]);
    expect(planWorkspaceStateSync({ entries: [], user: 'dev', hostStateDir, direction: 'copy-out' })).toEqual([]);
  });
});

describe('fingerprints', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('hostFingerprint of a missing path is null', () => {
    expect(hostFingerprint(path.join(tmpDir, 'absent'))).toBeNull();
  });

  test('hostFingerprint of a single file uses "." as its path', () => {
    const filePath = path.join(tmpDir, 'binary');
    fs.writeFileSync(filePath, 'abcd');
    expect(hostFingerprint(filePath)).toBe('4 .');
  });

  test('hostFingerprint of a dir lists regular files sorted, excluding symlinks', () => {
    fs.mkdirSync(path.join(tmpDir, 'versions'));
    fs.writeFileSync(path.join(tmpDir, 'versions', '2.1.218'), '12345');
    fs.writeFileSync(path.join(tmpDir, 'versions', '2.1.200'), '123');
    fs.symlinkSync(path.join(tmpDir, 'versions', '2.1.218'), path.join(tmpDir, 'launcher'));

    expect(hostFingerprint(tmpDir)).toBe('3 ./versions/2.1.200\n5 ./versions/2.1.218');
  });

  test('parseContainerFingerprint matches the host form for dir listings', () => {
    expect(parseContainerFingerprint('5 ./versions/2.1.218\n     3 ./versions/2.1.200\n'))
      .toEqual({ canonical: '3 ./versions/2.1.200\n5 ./versions/2.1.218', totalBytes: 8 });
  });

  test("parseContainerFingerprint matches the host form for a bare stat -c '%s' count", () => {
    expect(parseContainerFingerprint('       4\n')).toEqual({ canonical: '4 .', totalBytes: 4 });
  });

  test('parseContainerFingerprint rejects unexpected output', () => {
    expect(parseContainerFingerprint('sh: find: not found')).toBeNull();
    expect(parseContainerFingerprint('12 /etc/absolute')).toBeNull();
  });
});

function timeoutError(): Error {
  const error = new Error('spawnSync container ETIMEDOUT');
  Object.assign(error, { code: 'ETIMEDOUT' });
  return error;
}

describe('binary entry sync behaviour', () => {
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

  const HERDR_ENTRY: WorkspaceStateEntry = { kind: 'binary', path: '.local/bin/herdr', executable: true };
  const CLAUDE_ENTRY: WorkspaceStateEntry = {
    kind: 'binary',
    path: '.local/share/claude',
    executable: false,
    launcher: { link: '.local/bin/claude', versionsDir: '.local/share/claude/versions' },
  };

  test('copy-in with no host snapshot skips the entry — the image-baked binary survives', async () => {
    const calls: string[][] = [];

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', entries: [HERDR_ENTRY], user: 'dev', direction: 'copy-in' },
      { run: (_file, args): void => { calls.push(args); } },
    );

    expect(calls).toEqual([]);
  });

  test('copy-in with a matching fingerprint skips the copy', async () => {
    fs.mkdirSync(path.join(stateDir, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.local', 'bin', 'herdr'), 'bin!');
    const calls: string[][] = [];

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', entries: [HERDR_ENTRY], user: 'dev', direction: 'copy-in' },
      {
        run: (_file, args): void => { calls.push(args); },
        capture: (): string => '4\n',
      },
    );

    expect(calls).toEqual([]);
  });

  test('copy-in with a differing fingerprint streams the copy in as the user and restores +x', async () => {
    fs.mkdirSync(path.join(stateDir, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.local', 'bin', 'herdr'), 'new binary');
    const calls: string[][] = [];

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', entries: [HERDR_ENTRY], user: 'dev', direction: 'copy-in' },
      {
        run: (_file, args): void => { calls.push(args); },
        copy: (_file, args): Promise<void> => { calls.push(args); return Promise.resolve(); },
        capture: (): string => '4\n',
      },
    );

    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.local/bin/herdr'],
      streamInArgs(path.join(stateDir, '.local', 'bin'), 'herdr', 'dev', '/home/dev/.local/bin'),
      ['exec', '--user', 'root', 'pi-tin-demo', 'chmod', '+x', '/home/dev/.local/bin/herdr'],
    ]);
  });

  test('copy-in with an unreadable container fingerprint still copies', async () => {
    fs.mkdirSync(path.join(stateDir, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.local', 'bin', 'herdr'), 'new binary');
    const calls: string[][] = [];

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', entries: [HERDR_ENTRY], user: 'dev', direction: 'copy-in' },
      {
        run: (_file, args): void => { calls.push(args); },
        copy: (_file, args): Promise<void> => { calls.push(args); return Promise.resolve(); },
        capture: (): string => { throw new Error('exec failed'); },
      },
    );

    expect(calls.some((args) => args.includes(STREAM_SCRIPT))).toBe(true);
  });

  test('copy-out records the launcher target before skipping unchanged content', async () => {
    fs.mkdirSync(path.join(stateDir, '.local', 'share', 'claude', 'versions'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.local', 'share', 'claude', 'versions', '2.1.218'), '12345');
    const calls: string[][] = [];
    const captured: string[][] = [];

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', entries: [CLAUDE_ENTRY], user: 'dev', direction: 'copy-out' },
      {
        run: (_file, args): void => { calls.push(args); },
        capture: (_file, args): string => {
          captured.push(args);
          return args.includes('readlink')
            ? '/home/dev/.local/share/claude/versions/2.1.218\n'
            : '5 ./versions/2.1.218\n';
        },
      },
    );

    // readlink recorded, fingerprints matched → no cp ran.
    expect(captured.filter((args) => args.includes('readlink'))).toHaveLength(1);
    expect(calls.some((args) => args[0] === 'cp')).toBe(false);
    expect(fs.readFileSync(path.join(stateDir, '.local', 'share', 'claude.pi-tin-launcher'), 'utf-8'))
      .toBe('/home/dev/.local/share/claude/versions/2.1.218\n');
  });

  test('copy-out drops a stale launcher record when readlink fails', async () => {
    fs.mkdirSync(path.join(stateDir, '.local', 'share'), { recursive: true });
    const recordPath = path.join(stateDir, '.local', 'share', 'claude.pi-tin-launcher');
    fs.writeFileSync(recordPath, '/home/dev/.local/share/claude/versions/2.1.200\n');
    const calls: string[][] = [];

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', entries: [CLAUDE_ENTRY], user: 'dev', direction: 'copy-out' },
      {
        run: (_file, args): void => { calls.push(args); },
        // No host 'claude' dir exists yet, so probe-unchanged continues past
        // (host missing) and the entry proceeds to a real copy-out attempt —
        // stub it out so no real subprocess is spawned.
        copy: (): Promise<void> => Promise.resolve(),
        capture: (_file, args): string => {
          if (args.includes('readlink')) throw new Error('no launcher');
          return '5 ./versions/2.1.218\n';
        },
      },
    );

    expect(fs.existsSync(recordPath)).toBe(false);
  });

  const RESTORE_SCRIPT =
    'ln -sfn "$1" "$2" && chown -h "$4:$4" "$2" && find "$3" -maxdepth 1 -type f ! -name "$5" -delete';

  const runClaudeCopyIn = (calls: string[][]): Promise<void> =>
    syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', entries: [CLAUDE_ENTRY], user: 'dev', direction: 'copy-in' },
      {
        run: (_file, args): void => { calls.push(args); },
        copy: (_file, args): Promise<void> => { calls.push(args); return Promise.resolve(); },
        // Always mismatches the host fingerprint, so the copy proceeds.
        capture: (): string => '1 ./versions/other\n',
      },
    );

  const restoreArgs = (basename: string): string[] => [
    'exec', '--user', 'root', 'pi-tin-demo', 'sh', '-c',
    RESTORE_SCRIPT,
    'sh',
    `/home/dev/.local/share/claude/versions/${basename}`,
    '/home/dev/.local/bin/claude',
    '/home/dev/.local/share/claude/versions',
    'dev',
    basename,
  ];

  const versionsDir = (): string => path.join(stateDir, '.local', 'share', 'claude', 'versions');
  const recordPath = (): string => path.join(stateDir, '.local', 'share', 'claude.pi-tin-launcher');

  test('copy-in recreates the launcher at the recorded version and prunes the others', async () => {
    fs.mkdirSync(versionsDir(), { recursive: true });
    fs.writeFileSync(path.join(versionsDir(), '2.1.200'), '123');
    fs.writeFileSync(path.join(versionsDir(), '2.1.218'), '12345');
    fs.writeFileSync(recordPath(), '/home/dev/.local/share/claude/versions/2.1.218\n');
    const calls: string[][] = [];

    await runClaudeCopyIn(calls);

    expect(calls.at(-1)).toEqual(restoreArgs('2.1.218'));
  });

  test('copy-in with a record ahead of the snapshot falls back to a version the snapshot holds', async () => {
    // A copy-out that failed after record-launcher leaves the record pointing
    // at a version the snapshot never captured; a blind restore would dangle
    // the launcher and prune the only real binary.
    fs.mkdirSync(versionsDir(), { recursive: true });
    fs.writeFileSync(path.join(versionsDir(), '2.1.200'), '123');
    fs.writeFileSync(recordPath(), '/home/dev/.local/share/claude/versions/2.1.218\n');
    const calls: string[][] = [];

    await runClaudeCopyIn(calls);

    expect(calls.at(-1)).toEqual(restoreArgs('2.1.200'));
  });

  test('copy-in without a record links the newest snapshot version, numerically aware', async () => {
    fs.mkdirSync(versionsDir(), { recursive: true });
    fs.writeFileSync(path.join(versionsDir(), '2.1.9'), '123');
    fs.writeFileSync(path.join(versionsDir(), '2.1.218'), '12345');
    const calls: string[][] = [];

    await runClaudeCopyIn(calls);

    expect(calls.at(-1)).toEqual(restoreArgs('2.1.218'));
  });

  test('copy-in never passes a record pointing outside the versions dir to the shell', async () => {
    fs.mkdirSync(versionsDir(), { recursive: true });
    fs.writeFileSync(path.join(versionsDir(), '2.1.218'), '12345');
    fs.writeFileSync(recordPath(), '/etc/passwd\n');
    const calls: string[][] = [];

    await runClaudeCopyIn(calls);

    expect(calls.some((args) => args.includes('/etc/passwd'))).toBe(false);
    expect(calls.at(-1)).toEqual(restoreArgs('2.1.218'));
  });

  test('copy-in skips the launcher restore when the snapshot holds no complete version', async () => {
    // A zero-byte version is a mid-download staging capture — never a link
    // target; with nothing complete, neither the link nor the prune runs.
    fs.mkdirSync(versionsDir(), { recursive: true });
    fs.writeFileSync(path.join(versionsDir(), '2.1.218'), '');
    fs.writeFileSync(recordPath(), '/home/dev/.local/share/claude/versions/2.1.218\n');
    const calls: string[][] = [];

    await runClaudeCopyIn(calls);

    expect(calls.some((args) => args.includes(RESTORE_SCRIPT))).toBe(false);
  });

  test('copy-in stops the entry after a failed stream — no launcher restore against the cleared destination', async () => {
    // The snapshot holds a complete version, so only the early return keeps
    // restore-launcher from retargeting the link at a version that never
    // arrived and pruning whatever a partial extraction left behind.
    fs.mkdirSync(versionsDir(), { recursive: true });
    fs.writeFileSync(path.join(versionsDir(), '2.1.218'), '12345');
    fs.writeFileSync(recordPath(), '/home/dev/.local/share/claude/versions/2.1.218\n');
    fs.mkdirSync(path.join(stateDir, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.local', 'bin', 'herdr'), 'bin!');
    const calls: string[][] = [];
    const warnings: string[] = [];

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', entries: [CLAUDE_ENTRY, HERDR_ENTRY], user: 'dev', direction: 'copy-in' },
      {
        run: (_file, args): void => { calls.push(args); },
        copy: (_file, args): Promise<void> => {
          calls.push(args);
          return args.includes('claude')
            ? Promise.reject(new Error('tar exited with code 1'))
            : Promise.resolve();
        },
        // Always mismatches both host fingerprints, so both copies proceed.
        capture: (): string => '1 ./other\n',
        warn: (message): void => { warnings.push(message); },
      },
    );

    // The failed entry ends at the copy; the herdr entry still syncs in full.
    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.local/share/claude'],
      streamInArgs(path.join(stateDir, '.local', 'share'), 'claude', 'dev', '/home/dev/.local/share'),
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.local/bin/herdr'],
      streamInArgs(path.join(stateDir, '.local', 'bin'), 'herdr', 'dev', '/home/dev/.local/bin'),
      ['exec', '--user', 'root', 'pi-tin-demo', 'chmod', '+x', '/home/dev/.local/bin/herdr'],
    ]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-in failed for '/home/dev/.local/share/claude' in workspace 'demo' — starting without it (the container-side copy was already cleared). Common causes: a file of 8 GiB or larger or a single path component over 100 characters (ustar limits), or a container image without tar.",
    ]);
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
        entries: [toolState('.local/share/zoxide'), toolState('.zsh_history')],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        run: (_file, args): void => {
          calls.push(args);
          const missingProbe = args[0] === 'exec' && args.at(-1) === '/home/dev/.local/share/zoxide';
          if (missingProbe) {
            throw new Error('missing');
          }
        },
        copy: (_file, args): Promise<void> => { calls.push(args); return Promise.resolve(); },
      },
    );

    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.local/share/zoxide'],
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.zsh_history'],
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
        entries: [toolState('.zsh_history'), toolState('.local/share/zoxide')],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        run: (_file, args): void => {
          calls.push(args);
          throw timeoutError();
        },
        warn: (message): void => {
          warnings.push(message);
        },
      },
    );

    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.zsh_history'],
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
        entries: [toolState('.nuget/packages'), toolState('.zsh_history')],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        run: (_file, args): void => {
          calls.push(args);
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
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.nuget/packages'],
      ['cp', 'pi-tin-demo:/home/dev/.nuget/packages', path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo', '.nuget/packages.pi-tin-tmp')],
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.zsh_history'],
      ['cp', 'pi-tin-demo:/home/dev/.zsh_history', path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo', '.zsh_history.pi-tin-tmp')],
    ]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-out timed out after 5s for '/home/dev/.nuget/packages' in workspace 'demo' — skipping this path. It is likely too large to snapshot; workspace_state suits small tool state — persist large paths with a host.mounts entry instead (README → Workspace state).",
    ]);
  });

  test('a timed-out binary copy warns with the binary deadline and skips the entry\'s restore ops', async () => {
    const stateDir = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
    fs.mkdirSync(path.join(stateDir, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.local', 'bin', 'herdr'), 'new binary');
    const calls: string[][] = [];
    const warnings: string[] = [];

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        entries: [{ kind: 'binary', path: '.local/bin/herdr', executable: true }],
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
        capture: (): string => { throw new Error('probe fails, copy proceeds'); },
        warn: (message): void => {
          warnings.push(message);
        },
      },
    );

    // The timeout SIGKILLs only the stream's outer shell — the orphaned
    // pipeline may still be extracting in the background, so the entry's
    // restore-executable chmod must not run against it.
    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.local/bin/herdr'],
      streamInArgs(path.join(stateDir, '.local', 'bin'), 'herdr', 'dev', '/home/dev/.local/bin'),
    ]);
    // No host.mounts advice here: the entry is pi-tin-owned, not something the
    // user can relocate.
    expect(warnings).toEqual([
      "Warning: workspace_state copy-in timed out after 1m for '/home/dev/.local/bin/herdr' in workspace 'demo' — skipping this path for now; pi-tin retries this agent-binary snapshot on the next open or close.",
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
        entries: [toolState('.zsh_history'), toolState('.local/share/zoxide')],
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

  test('a timed-out fingerprint probe is runtime-scoped and aborts the sync', async () => {
    const stateDir = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
    fs.mkdirSync(path.join(stateDir, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.local', 'bin', 'herdr'), 'bin!');
    const calls: string[][] = [];
    const warnings: string[] = [];

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        entries: [{ kind: 'binary', path: '.local/bin/herdr', executable: true }, toolState('.zsh_history')],
        user: 'dev',
        direction: 'copy-in',
      },
      {
        run: (_file, args): void => { calls.push(args); },
        capture: (): string => { throw timeoutError(); },
        warn: (message): void => { warnings.push(message); },
      },
    );

    // The probe is a near-instant exec, so its timeout means the runtime is
    // wedged: nothing else runs, not even the second entry.
    expect(calls).toEqual([]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-in timed out after 5s for '/home/dev/.local/bin/herdr' in workspace 'demo' — container runtime unresponsive; skipping the rest of this sync.",
    ]);
  });

  test('copy-out: a wedged runtime stops the sync at the next probe after a timed-out copy', async () => {
    const calls: string[][] = [];
    const warnings: string[] = [];

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        entries: [toolState('.nuget/packages'), toolState('.zsh_history'), toolState('.local/share/zoxide')],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        // First call across either runner answers before the runtime wedges;
        // everything after (the big copy, then the next entry's probe) hits
        // the deadline. Both runners share the same `calls` array, so the
        // count is a single sequential counter across exec and cp calls —
        // exactly as when one runner served both, pre-split.
        run: (_file, args): void => {
          calls.push(args);
          if (calls.length !== 1) throw timeoutError();
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
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.nuget/packages'],
      ['cp', 'pi-tin-demo:/home/dev/.nuget/packages', path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo', '.nuget/packages.pi-tin-tmp')],
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.zsh_history'],
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
        entries: [toolState('.zsh_history'), toolState('.local/share/zoxide')],
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
        entries: [toolState('.zsh_history'), toolState('.local/share/zoxide')],
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

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        entries: [toolState('.zsh_history')],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        run: (): void => {},
        copy: (): Promise<void> => {
          // Simulate a copy SIGKILLed mid-write: a partial temp exists.
          fs.writeFileSync(`${snapshotPath}.pi-tin-tmp`, 'partial');
          return Promise.reject(timeoutError());
        },
        warn: (): void => {},
      },
    );

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
      { containerName: 'pi-tin-demo', workspaceName: 'demo', entries: [toolState('.zsh_history')], user: 'dev', direction: 'copy-out' },
      {
        run: (): void => {},
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

  test('copy-out binary entry threads the probed total', async () => {
    const { events, report } = createReporterCapture();
    fs.mkdirSync(path.join(stateDir, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.local', 'bin', 'herdr'), 'x');

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        entries: [{ kind: 'binary', path: '.local/bin/herdr', executable: true }],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        run: (): void => {},
        // Container fingerprint (10 + 7 = 17 bytes) mismatches the 1-byte
        // host file, so the probe reports 'changed' and hands the copy its
        // total.
        capture: (): string => '10 ./a\n7 ./b\n',
        copy: (): Promise<void> => Promise.resolve(),
        report,
      },
    );

    expect(events).toEqual(['start .local/bin/herdr', 'copy total=17 live=yes', 'finish done']);
  });

  test('unchanged binary entry reports unchanged and never copies', async () => {
    const { events, report } = createReporterCapture();
    fs.mkdirSync(path.join(stateDir, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.local', 'bin', 'herdr'), 'bin!');
    const calls: string[][] = [];

    await syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        entries: [{ kind: 'binary', path: '.local/bin/herdr', executable: true }],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        run: (_file, args): void => { calls.push(args); },
        capture: (): string => '4\n',
        copy: (_file, args): Promise<void> => { calls.push(args); return Promise.resolve(); },
        report,
      },
    );

    expect(events.at(-1)).toBe('finish unchanged');
    expect(calls.some((args) => args[0] === 'cp')).toBe(false);
  });

  test('absent copy-out source reports skipped', async () => {
    const { events, report } = createReporterCapture();

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', entries: [toolState('.zsh_history')], user: 'dev', direction: 'copy-out' },
      {
        run: (): void => { throw new Error('missing'); },
        report,
      },
    );

    expect(events.at(-1)).toBe('finish skipped');
  });

  test('copy-in missing host snapshot reports skipped', async () => {
    const { events, report } = createReporterCapture();
    const calls: string[][] = [];

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', entries: [toolState('.zsh_history')], user: 'dev', direction: 'copy-in' },
      {
        run: (_file, args): void => { calls.push(args); },
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
      { containerName: 'pi-tin-demo', workspaceName: 'demo', entries: [toolState('.zsh_history')], user: 'dev', direction: 'copy-out' },
      {
        run: (): void => {},
        copy: (): Promise<void> => Promise.reject(timeoutError()),
        warn: (message): void => { warnings.push(message); },
        report,
      },
    );

    expect(events.at(-1)).toBe('finish timed-out');
    expect(warnings).toEqual([
      "Warning: workspace_state copy-out timed out after 5s for '/home/dev/.zsh_history' in workspace 'demo' — skipping this path. It is likely too large to snapshot; workspace_state suits small tool state — persist large paths with a host.mounts entry instead (README → Workspace state).",
    ]);
  });

  test('no reporter injected is silent and still syncs', async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.zsh_history'), 'snapshot');
    const calls: string[][] = [];

    await syncWorkspaceState(
      { containerName: 'pi-tin-demo', workspaceName: 'demo', entries: [toolState('.zsh_history')], user: 'dev', direction: 'copy-in' },
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
