import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as v from 'valibot';
import {
  ContainerListSchema,
  ImageListSchema,
  type ListedContainer,
} from './validators.js';
import { isRecord } from './guards.js';

export interface VolumeMount {
  host: string;
  container: string;
  readonly?: boolean | undefined;
}

export interface DetachedRunOptions {
  image: string;
  volumes: VolumeMount[];
  name: string;
  cpus: number;
  memory: string;
  ssh?: boolean | undefined;
  env?: Record<string, string> | undefined;
  command: string[];
}

export interface ExecOptions {
  name: string;
  command: string[];
  workdir?: string | undefined;
  env?: Record<string, string> | undefined;
  user?: string | undefined;
}

export interface ContainerExecFileOptions {
  encoding: 'utf-8';
  stdio: ['pipe', 'pipe', 'pipe'];
  timeout: number;
  killSignal: 'SIGKILL';
}

export type ContainerSubprocessRunner = (
  file: string,
  args: string[],
  options: ContainerExecFileOptions,
) => void;

/**
 * Async sibling of ContainerSubprocessRunner for the two data-moving copy
 * operations: awaiting instead of blocking keeps the event loop free for
 * live progress rendering. Same options contract; the runner enforces the
 * deadline itself.
 */
export type ContainerCopyRunner = (
  file: string,
  args: string[],
  options: ContainerExecFileOptions,
) => Promise<void>;

interface StreamToContainerOptions {
  name: string;
  hostPath: string;
  containerPath: string;
  user: string;
  timeoutMs?: number | undefined;
  run?: ContainerCopyRunner | undefined;
}

interface CopyFromContainerOptions {
  name: string;
  containerPath: string;
  hostPath: string;
  timeoutMs?: number | undefined;
  run?: ContainerCopyRunner | undefined;
}

interface StreamFromContainerOptions {
  name: string;
  containerPath: string;
  hostPath: string;
  timeoutMs?: number | undefined;
  run?: ContainerCopyRunner | undefined;
}

interface ExecContainerCommandOptions extends Pick<ExecOptions, 'name' | 'command' | 'user'> {
  run?: ContainerSubprocessRunner | undefined;
}

/** Output-capturing sibling of ContainerSubprocessRunner. */
export type ContainerOutputRunner = (
  file: string,
  args: string[],
  options: ContainerExecFileOptions,
) => string;

interface ExecContainerCommandOutputOptions extends Pick<ExecOptions, 'name' | 'command' | 'user'> {
  capture?: ContainerOutputRunner | undefined;
}

// Apple `container` subcommands can wedge indefinitely when the runtime is
// poisoned, so every non-interactive invocation in this module carries a
// deadline. The deliberate exceptions are the interactive attach
// (execContainer) and the streaming `container build` — both are user-visible
// and interruptible with Ctrl-C.
export const CONTAINER_SUBPROCESS_TIMEOUT_MS = 5_000;

// `container run` boots a VM for the container; give a cold start more
// headroom than the flat deadline before declaring the runtime wedged.
export const CONTAINER_RUN_TIMEOUT_MS = 15_000;

/** Recovery steps for a wedged container runtime, shared by every timeout message. */
export function containerSystemRecoveryHint(): string {
  return "Restart the container system with 'container system stop' and then 'container system start'. If those commands hang too, restart the launchd service with 'launchctl kickstart -k gui/$(id -u)/com.apple.container.apiserver', or log out and back in.";
}

export interface ExecResult {
  status: number | null;
  signal: NodeJS.Signals | null;
}

export type ContainerState = 'running' | 'stopped' | 'not-found' | 'unknown';

// All pi-tin containers and images share this name prefix so they can be
// recognised among unrelated resources on the host.
const PI_TIN_PREFIX = 'pi-tin-';

// Container name and image tag are currently the same string, but they are
// different concepts — keep distinct named functions for each.

/** Name of the container backing `workspaceName`. */
export function containerNameFor(workspaceName: string): string {
  return `${PI_TIN_PREFIX}${workspaceName}`;
}

/** Image tag built for `workspaceName`. */
export function imageTagFor(workspaceName: string): string {
  return `${PI_TIN_PREFIX}${workspaceName}`;
}

export function isPiTinContainerId(id: string): boolean {
  return id.startsWith(PI_TIN_PREFIX);
}

/** Workspace name for a pi-tin container id; non-pi-tin ids pass through unchanged. */
export function workspaceNameFromContainerId(id: string): string {
  return isPiTinContainerId(id) ? id.slice(PI_TIN_PREFIX.length) : id;
}

export function isPiTinImageTag(tag: string): boolean {
  return tag.startsWith(PI_TIN_PREFIX);
}

/** Workspace name for a pi-tin image tag; non-pi-tin tags pass through unchanged. */
export function workspaceNameFromImageTag(tag: string): string {
  return isPiTinImageTag(tag) ? tag.slice(PI_TIN_PREFIX.length) : tag;
}

function volumeArgs(volumes: VolumeMount[]): string[] {
  return volumes.flatMap((volume) => [
    '--volume',
    `${volume.host}:${volume.container}${volume.readonly ? ':ro' : ''}`,
  ]);
}

function envArgs(env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).flatMap(([key, value]) => [
    '--env',
    `${key}=${value}`,
  ]);
}

function formatSpawnFailure(
  action: string,
  name: string,
  result: ReturnType<typeof spawnSync>,
): string {
  const stderr = result.stderr ? String(result.stderr).trim() : '';
  const stdout = result.stdout ? String(result.stdout).trim() : '';
  return stderr || stdout || `Failed to ${action} container '${name}'.`;
}

export function parseContainerListOutput(output: string): ListedContainer[] {
  return v.parse(ContainerListSchema, JSON.parse(output));
}

function stripLatestTag(name: string): string {
  return name.endsWith(':latest') ? name.slice(0, -':latest'.length) : name;
}

export function parseImageListOutput(output: string): string[] {
  return v.parse(ImageListSchema, JSON.parse(output)).map(stripLatestTag);
}

type ContainerListExec = () => string;

const execContainerList: ContainerListExec = () =>
  execFileSync(
    'container',
    ['list', '--all', '--format', 'json'],
    {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CONTAINER_SUBPROCESS_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  );

/**
 * All containers on the host, or null when they could not be listed (exec or
 * parse failure). Null is not "no containers": callers deciding anything
 * destructive must treat it as unknown state, never as an empty host.
 */
export function listContainers(
  exec: ContainerListExec = execContainerList,
): ListedContainer[] | null {
  let output: string;
  try {
    output = exec();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to list containers: ${message}`);
    return null;
  }

  try {
    return parseContainerListOutput(output);
  } catch {
    console.error('Warning: failed to parse container list output');
    return null;
  }
}

export function imageExists(tag: string): boolean {
  try {
    execFileSync('container', ['image', 'inspect', tag], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CONTAINER_SUBPROCESS_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return true;
  } catch {
    return false;
  }
}

export function buildImage(tag: string, contextDir: string): void {
  // Deliberately unbounded: builds legitimately run for minutes, stream to the
  // terminal (stdio inherit), and are interruptible with Ctrl-C.
  execFileSync('container', ['build', '--tag', tag, contextDir], {
    stdio: 'inherit',
  });
  try {
    execFileSync('container', ['builder', 'stop'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CONTAINER_SUBPROCESS_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  } catch {
    console.warn('Warning: failed to stop builder VM after build — it may have already exited unexpectedly');
  }
}

/** State of the named container, or 'unknown' when containers could not be listed. */
export function getContainerState(
  name: string,
  exec: ContainerListExec = execContainerList,
): ContainerState {
  const containers = listContainers(exec);
  if (containers === null) {
    return 'unknown';
  }
  const match = containers.find((container) => container.id === name);
  if (!match) {
    return 'not-found';
  }
  return match.status === 'running' ? 'running' : 'stopped';
}

/** IPv4 address of the named container, or null when unlisted or unaddressed. */
export function getContainerIpv4(
  name: string,
  exec: ContainerListExec = execContainerList,
): string | null {
  const containers = listContainers(exec);
  return containers?.find((container) => container.id === name)?.ipv4Address ?? null;
}

// Apple `container`'s --env-file parser (a port of Moby's kvfile parser) is
// line-based with no quoting or escaping: any line separator terminates the
// value, so a value spanning lines cannot be represented. This matches the
// character set Swift's `.newlines` splits on — a stray separator anywhere in
// these would otherwise corrupt or inject later entries.
const ENV_FILE_NEWLINE = /[\n\v\f\r\u0085\u2028\u2029]/;

// Drop env entries whose values contain a line separator, returning the safe
// subset plus the names of any skipped entries (so the caller can warn).
export function partitionEnvForFile(env: Record<string, string>): {
  safe: Record<string, string>;
  skipped: string[];
} {
  const safe: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (ENV_FILE_NEWLINE.test(value)) {
      skipped.push(key);
    } else {
      safe[key] = value;
    }
  }
  return { safe, skipped };
}

// Serialise env into Apple `container`'s --env-file format (key=value per line).
function envFileContents(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n';
}

export function runContainerDetached(options: DetachedRunOptions): void {
  const { safe: env, skipped } = partitionEnvForFile(options.env ?? {});
  if (skipped.length > 0) {
    console.warn(
      `Warning: skipping environment ${skipped.length === 1 ? 'variable' : 'variables'} ` +
      `with multi-line values, which cannot be passed to the container: ${skipped.join(', ')}`,
    );
  }

  // Pass environment via an --env-file rather than --env on the command line:
  // argv values are visible to other processes on the host (e.g. `ps`), which
  // would expose secrets like GH_TOKEN and API keys. A 0600 temp file keeps the
  // values out of the process listing. The file only needs to live for the
  // duration of the `container run` call — values are injected into the VM at
  // start — so we remove it immediately afterwards.
  let envFileDir: string | undefined;
  const envFileArgs: string[] = [];
  if (Object.keys(env).length > 0) {
    envFileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-env-'));
    const envFilePath = path.join(envFileDir, 'env');
    fs.writeFileSync(envFilePath, envFileContents(env), { mode: 0o600 });
    envFileArgs.push('--env-file', envFilePath);
  }

  try {
    const args = [
      'run',
      '--detach',
      '--rm',
      '--init',
      '--name',
      options.name,
      '--cpus',
      String(options.cpus),
      '--memory',
      options.memory,
      ...(options.ssh ? ['--ssh'] : []),
      ...envFileArgs,
      ...volumeArgs(options.volumes),
      options.image,
      ...options.command,
    ];

    const result = spawnSync('container', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CONTAINER_RUN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(formatSpawnFailure('start', options.name, result));
    }
  } finally {
    if (envFileDir !== undefined) {
      try {
        fs.rmSync(envFileDir, { recursive: true, force: true });
      } catch {
        // Best effort only.
      }
    }
  }
}

export function execContainer(options: ExecOptions): ExecResult {
  // Deliberately unbounded: this is the interactive attach — a shell session
  // has no meaningful deadline. Callers probe exec-readiness with a bounded
  // call first, so a wedged runtime fails fast instead of hanging here.
  const args = [
    'exec',
    '--interactive',
    '--tty',
    ...(options.user ? ['--user', options.user] : []),
    ...(options.workdir ? ['--workdir', options.workdir] : []),
    ...envArgs(options.env),
    options.name,
    ...options.command,
  ];

  const result = spawnSync('container', args, {
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    signal: result.signal,
  };
}

function containerExecFileOptions(timeoutMs: number): ContainerExecFileOptions {
  // Node's sync child-process timeout defaults to SIGTERM; use SIGKILL so a
  // wedged Apple `container` subcommand cannot intercept the signal and keep
  // the caller blocked after the deadline.
  return {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  };
}

const execContainerSubprocess: ContainerSubprocessRunner = (file, args, options): void => {
  execFileSync(file, args, options);
};

// Signal a detached child's whole process group. `child.pid` is undefined when
// the spawn itself failed, and the negative-pid kill throws once the group has
// already exited — both fall back to signalling the child handle, which is a
// no-op in exactly those cases.
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Group already gone, or not a group leader — fall through.
    }
  }
  child.kill(signal);
}

// SIGQUIT belongs here with the obvious three: `detached` takes the child
// out of the terminal's foreground process group, so the terminal stops
// delivering *every* terminal-generated signal to it. Ctrl-\ kills pi-tin by
// default disposition and would leave the child's workers running — measured
// with the copy pipelines: without forwarding, the host tar kept growing the
// destination file after the parent died at exit 131, while a forwarded
// SIGINT left nothing behind.
const SPAWN_INTERRUPTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

export interface SpawnDeadlineOptions {
  timeoutMs: number;
  // Disposition when the terminal interrupts pi-tin mid-run: 'die' forwards
  // a SIGKILL to the child's group and re-raises the signal against pi-tin —
  // a ^C mid-copy must kill the CLI, or a killed copy could look completed.
  // 'abort' answers SIGINT by killing the group and rejecting with code
  // EABORTED so the caller can continue (the agent-install step treats ^C as
  // "skip the install", not "kill the open"); the deliberate-termination
  // signals (SIGTERM/SIGHUP/SIGQUIT) still die.
  onInterrupt: 'die' | 'abort';
}

// spawn-based equivalent of execFileSync + timeout + SIGKILL, with one
// deliberate difference: `detached` makes the child a process-group leader so
// the deadline can signal the whole group (`kill(-pid)`) rather than just the
// direct child. The copy pipelines are `sh -c '… | …'`, so the processes
// doing the real work — host tar and `container exec` — are grandchildren;
// killing only the shell would orphan a host-side tar that keeps writing into
// the destination long after the caller has given up on it. Group kill stops
// the workers with the shell. It is best-effort: the group may already be
// gone (ESRCH), in which case fall back to signalling the child directly.
// Settled on 'exit', not 'close': anything that did survive inherits the
// stderr pipe, and waiting for it to close would block the timeout rejection.
// The timeout rejection carries code ETIMEDOUT so
// isContainerSubprocessTimeout classifies it unchanged.
//
// Its own process group also means the terminal no longer delivers Ctrl-C to
// the child, so interrupts are forwarded by hand per onInterrupt above.
// Exported only as the default runner for the two wrappers below and for
// direct tests of its error shapes; production callers go through
// streamToContainer/copyFromContainer/execContainerCommandWithDeadline.
export function spawnProcessGroupWithDeadline(
  file: string,
  args: string[],
  options: SpawnDeadlineOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });
    let timedOut = false;
    let aborted = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, 'SIGKILL');
    }, options.timeoutMs);
    const listeners = new Map<NodeJS.Signals, () => void>();
    const settle = (): void => {
      clearTimeout(deadline);
      for (const [signal, listener] of listeners) process.removeListener(signal, listener);
      listeners.clear();
    };
    for (const signal of SPAWN_INTERRUPTS) {
      const listener = (): void => {
        killProcessGroup(child, 'SIGKILL');
        if (options.onInterrupt === 'abort' && signal === 'SIGINT') {
          aborted = true;
          // Drop only this listener, so a second ^C reaches the default
          // disposition and still quits pi-tin — the caller is meant to keep
          // going after the first one, not to swallow every interrupt until
          // the child's exit arrives.
          const self = listeners.get(signal);
          if (self !== undefined) {
            process.removeListener(signal, self);
            listeners.delete(signal);
          }
          return;
        }
        // Removing our listeners first restores the default disposition, so
        // the re-raise terminates pi-tin exactly as an unhandled signal would.
        settle();
        process.kill(process.pid, signal);
      };
      listeners.set(signal, listener);
      process.on(signal, listener);
    }
    child.on('error', (error) => {
      settle();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      settle();
      // `code === 0` first guards a real race: the deadline fires in the
      // timers phase, a queued-but-undelivered exit is read in the poll phase
      // after it, so a run that genuinely succeeded can arrive here with
      // timedOut (or aborted) already set. Reporting that as a failure would
      // discard a run that completed.
      if (code === 0) {
        resolve();
        return;
      }
      if (aborted) {
        reject(Object.assign(new Error(`'${file}' was interrupted`), { code: 'EABORTED' }));
        return;
      }
      if (timedOut) {
        reject(Object.assign(new Error(`'${file}' timed out after ${options.timeoutMs}ms`), { code: 'ETIMEDOUT' }));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
      // A signal death reports code null; name the signal instead of the
      // misleading 'status null'.
      const cause = code === null ? `was killed by ${String(signal)}` : `exited with status ${String(code)}`;
      reject(new Error(`'${file}' ${cause}${stderr === '' ? '' : `: ${stderr}`}`));
    });
  });
}

// Exported only as the default runner and for direct tests of its error
// shapes; production callers go through streamToContainer/copyFromContainer.
export const spawnContainerCopy: ContainerCopyRunner = (file, args, options) =>
  spawnProcessGroupWithDeadline(file, args, { timeoutMs: options.timeout, onInterrupt: 'die' });

function runContainerSubprocess(
  args: string[],
  run: ContainerSubprocessRunner = execContainerSubprocess,
  timeoutMs: number = CONTAINER_SUBPROCESS_TIMEOUT_MS,
): void {
  run('container', args, containerExecFileOptions(timeoutMs));
}

export function isContainerSubprocessTimeout(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ETIMEDOUT';
}

/** True when a deadline-bounded subprocess was aborted by ^C (onInterrupt: 'abort'). */
export function isContainerSubprocessAborted(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'EABORTED';
}

// Copy a host path into the running container by piping a host-side tar into
// `container exec`, extracted as the target user. Not `container cp`: its
// copy-in is slow and erratic (measured on container 1.1.0, 2026-07: 36-147
// MiB/s run-to-run for the same 256 MiB file, vs a stable ~275 MiB/s for the
// same bytes streamed through `container exec -i`), and extraction as the
// user makes
// ownership correct by construction where cp landed root-owned files. tar also
// carries modes and in-tree symlinks intact. COPYFILE_DISABLE plus the plain
// ustar format stop macOS bsdtar emitting AppleDouble/pax metadata entries,
// which busybox tar mishandles — they would land as stray `._`-prefixed
// files in the restored tree. `set -o pipefail` is load-bearing here and must
// not be removed: measured, a host-side tar failure with a healthy
// `container exec` exits 0 without it, silently emptying this path on every
// start. Do not trust the intuition that truncating the stream makes the
// container-side tar fail — it does not reliably.
// On timeout the deadline SIGKILLs the whole process group, so the outer
// shell, the host tar and `container exec` all die together (see
// spawnContainerCopy). Callers still must not touch the destination after a
// timeout (runOpGroup skips the entry's remaining ops): the container-side
// tar is the runtime's process, not ours, and may still be flushing whatever
// bytes it already received. The next sync's probe reconciles whatever is
// left. The extracted name is the tar member — basename(hostPath) —
// so containerPath contributes only its parent directory: both paths must
// share a basename, which the planner guarantees by deriving them from the
// same entry path. The `--` keeps a leading-dash basename from parsing as a
// tar option.
export async function streamToContainer(options: StreamToContainerOptions): Promise<void> {
  const script =
    'set -o pipefail; COPYFILE_DISABLE=1 tar -cf - --format ustar -C "$1" -- "$2" | ' +
    'container exec --interactive --user "$3" "$4" sh -c \'mkdir -p "$1" && tar -xf - -C "$1"\' sh "$5"';
  const run = options.run ?? spawnContainerCopy;
  await run(
    '/bin/sh',
    [
      '-c',
      script,
      'sh',
      path.dirname(options.hostPath),
      path.basename(options.hostPath),
      options.user,
      options.name,
      path.posix.dirname(options.containerPath),
    ],
    containerExecFileOptions(options.timeoutMs ?? CONTAINER_SUBPROCESS_TIMEOUT_MS),
  );
}

// Copy a path out of the running container onto the host.
export async function copyFromContainer(options: CopyFromContainerOptions): Promise<void> {
  const run = options.run ?? spawnContainerCopy;
  await run(
    'container',
    ['cp', `${options.name}:${options.containerPath}`, options.hostPath],
    containerExecFileOptions(options.timeoutMs ?? CONTAINER_SUBPROCESS_TIMEOUT_MS),
  );
}

// Copy a directory out of the running container as a single tar stream.
// `container cp` carries a flat directory-path penalty — ~55 MiB/s whether the
// directory holds one file or two thousand, against ~341 MiB/s here — so
// directories stream and single files stay on cp (~474 MiB/s, which beats
// this). Taring the directory's *contents* (`cd … && tar -cf - .`) reproduces
// the destination layout `container cp` produces, with no path rewriting.
// Runs as root, not the workspace user: this matches the privilege
// `container cp` had (it is executed by the runtime with full privilege) and
// grants nothing new, since probeContainerPathShape and
// remove-container-path already operate as root against this same tree. A
// user-scoped tar would instead fail permanently against any root-owned file
// underneath, silently freezing that path's snapshot every session.
// pipefail is load-bearing: without it a guest failure that still emits a
// well-formed empty archive exits 0 and a bad copy looks like a good one.
export async function streamFromContainer(options: StreamFromContainerOptions): Promise<void> {
  const script =
    'set -o pipefail; mkdir -p "$2" && ' +
    'container exec --user root "$3" sh -c \'cd "$1" && tar -cf - .\' sh "$1" | ' +
    'tar -xf - -C "$2"';
  const run = options.run ?? spawnContainerCopy;
  await run(
    '/bin/sh',
    [
      '-c',
      script,
      'sh',
      options.containerPath,
      options.hostPath,
      options.name,
    ],
    containerExecFileOptions(options.timeoutMs ?? CONTAINER_SUBPROCESS_TIMEOUT_MS),
  );
}

// Run a non-interactive command in the running container (no TTY), optionally as
// a specific user. Distinct from execContainer, which attaches an interactive
// TTY for the login shell.
export function execContainerCommand(options: ExecContainerCommandOptions): void {
  const args = [
    'exec',
    ...(options.user ? ['--user', options.user] : []),
    options.name,
    ...options.command,
  ];
  runContainerSubprocess(args, options.run);
}

// execContainerCommand for legitimately long-running commands (the
// agent-install step's in-container installer): async, caller-chosen
// deadline, caller-chosen interrupt disposition. Not the 5s wedge-detection
// deadline — this bounds a command that is expected to take minutes.
export async function execContainerCommandWithDeadline(
  options: Pick<ExecOptions, 'name' | 'command' | 'user'> &
    SpawnDeadlineOptions & {
      run?: ((file: string, args: string[], spawnOptions: SpawnDeadlineOptions) => Promise<void>) | undefined;
    },
): Promise<void> {
  const run = options.run ?? spawnProcessGroupWithDeadline;
  const args = [
    'exec',
    ...(options.user ? ['--user', options.user] : []),
    options.name,
    ...options.command,
  ];
  await run('container', args, { timeoutMs: options.timeoutMs, onInterrupt: options.onInterrupt });
}

const captureContainerSubprocess: ContainerOutputRunner = (file, args, options): string =>
  execFileSync(file, args, options);

// execContainerCommand for callers that need the command's stdout (e.g. the
// workspace-state path-shape probe). Same deadline and kill semantics.
export function execContainerCommandOutput(options: ExecContainerCommandOutputOptions): string {
  const capture = options.capture ?? captureContainerSubprocess;
  const args = [
    'exec',
    ...(options.user ? ['--user', options.user] : []),
    options.name,
    ...options.command,
  ];
  return capture('container', args, containerExecFileOptions(CONTAINER_SUBPROCESS_TIMEOUT_MS));
}

export function stopContainer(name: string, run?: ContainerSubprocessRunner): void {
  runContainerSubprocess(['stop', name], run);
}

export function killContainer(name: string, run?: ContainerSubprocessRunner): void {
  runContainerSubprocess(['kill', name], run);
}

export function deleteContainer(name: string, run?: ContainerSubprocessRunner): void {
  runContainerSubprocess(['delete', '--force', name], run);
}

export function deleteImage(tag: string): void {
  execFileSync('container', ['image', 'delete', tag], {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: CONTAINER_SUBPROCESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
}

type ImageListExec = () => string;

const execImageList: ImageListExec = () =>
  execFileSync(
    'container',
    ['image', 'list', '--format', 'json'],
    {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CONTAINER_SUBPROCESS_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  );

/**
 * All image names on the host, or an empty list when they could not be
 * listed (exec or parse failure). Callers only ever narrow this list to
 * pi-tin images to delete, so the empty fallback fails safe.
 */
export function listImageNames(exec: ImageListExec = execImageList): string[] {
  let output: string;
  try {
    output = exec();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to list images: ${message}`);
    return [];
  }

  try {
    return parseImageListOutput(output);
  } catch {
    console.error('Warning: failed to parse image list output');
    return [];
  }
}
