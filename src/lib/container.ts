import { execFileSync, spawn, spawnSync } from 'node:child_process';
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

// Deadline for copies of persisted agent binaries, which are far too large for
// the flat 5s deadline. Measured on Apple container 1.1.0: copy-in now streams
// via tar at a stable ~275 MiB/s (256 MiB in ~0.9s); copy-out rides
// `container cp` (~330-410 MiB/s out, but a ~500MB dir took 6-12s). 60s keeps
// slow-machine headroom without masking a wedged runtime for long.
export const CONTAINER_BINARY_COPY_TIMEOUT_MS = 60_000;

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

// spawn-based equivalent of execFileSync + timeout + SIGKILL: the deadline
// kills only the direct child (for streamToContainer, the outer sh — its
// tar/`container exec` children are orphaned and finish on their own,
// exactly as under spawnSync; see streamToContainer). Settled on 'exit',
// not 'close': orphans inherit the stderr pipe, and waiting for it to close
// would block the timeout rejection until they finish. The rejection carries
// code ETIMEDOUT so isContainerSubprocessTimeout classifies it unchanged.
// Exported only as the default runner and for direct tests of its error
// shapes; production callers go through streamToContainer/copyFromContainer.
export const spawnContainerCopy: ContainerCopyRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill(options.killSignal);
    }, options.timeout);
    child.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(deadline);
      if (timedOut) {
        reject(Object.assign(new Error(`'${file}' timed out after ${options.timeout}ms`), { code: 'ETIMEDOUT' }));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
      // A signal death reports code null; name the signal instead of the
      // misleading 'status null'.
      const cause = code === null ? `was killed by ${String(signal)}` : `exited with status ${String(code)}`;
      reject(new Error(`'${file}' ${cause}${stderr === '' ? '' : `: ${stderr}`}`));
    });
  });

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

// Copy a host path into the running container by piping a host-side tar into
// `container exec`, extracted as the target user. Not `container cp`: its
// copy-in is slow and erratic (measured on container 1.1.0, 2026-07: 36-147
// MiB/s run-to-run for the same 256 MiB file, vs a stable ~275 MiB/s for the
// same bytes streamed through `container exec -i` — see
// CONTAINER_CP_COPYIN_BUG_REPORT.md), and extraction as the user makes
// ownership correct by construction where cp landed root-owned files. tar also
// carries modes and in-tree symlinks intact. COPYFILE_DISABLE plus the plain
// ustar format stop macOS bsdtar emitting AppleDouble/pax metadata entries,
// which busybox tar mishandles and which would poison the workspace-state
// changed-check fingerprint. A failed host tar truncates the stream, so the
// container-side tar exits nonzero and the failure surfaces without pipefail.
// On timeout Node SIGKILLs only the outer shell: tar and `container exec` are
// that shell's children joined by their own pipe, so the orphaned pipeline
// keeps extracting in the background until it finishes on its own. Callers
// must not touch the destination after a timeout (runOpGroup skips the
// entry's remaining ops); the next sync's probe reconciles whatever the
// orphan left. The extracted name is the tar member — basename(hostPath) —
// so containerPath contributes only its parent directory: both paths must
// share a basename, which the planner guarantees by deriving them from the
// same entry path. The `--` keeps a leading-dash basename from parsing as a
// tar option. The async conversion preserves the kill target (the outer
// sh) and therefore the documented orphan semantics above.
export async function streamToContainer(options: StreamToContainerOptions): Promise<void> {
  const script =
    'COPYFILE_DISABLE=1 tar -cf - --format ustar -C "$1" -- "$2" | ' +
    'container exec --interactive --user "$3" "$4" sh -c \'mkdir -p "$1" && tar -xf - -C "$1"\' sh "$5"';
  const run = options.run ?? spawnContainerCopy;
  await run(
    'sh',
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

const captureContainerSubprocess: ContainerOutputRunner = (file, args, options): string =>
  execFileSync(file, args, options);

// execContainerCommand for callers that need the command's stdout (e.g. the
// workspace-state fingerprint probe). Same deadline and kill semantics.
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
