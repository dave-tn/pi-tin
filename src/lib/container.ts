import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as v from 'valibot';
import {
  ContainerListSchema,
  ImageListSchema,
  type ListedContainer,
} from './validators.js';

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
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
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
    });
    return true;
  } catch {
    return false;
  }
}

export function buildImage(tag: string, contextDir: string): void {
  execFileSync('container', ['build', '--tag', tag, contextDir], {
    stdio: 'inherit',
  });
  try {
    execFileSync('container', ['builder', 'stop'], {
      stdio: ['pipe', 'pipe', 'pipe'],
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

export function stopContainer(name: string): void {
  execFileSync('container', ['stop', name], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function killContainer(name: string): void {
  execFileSync('container', ['kill', name], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function deleteContainer(name: string): void {
  execFileSync('container', ['delete', '--force', name], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function deleteImage(tag: string): void {
  execFileSync('container', ['image', 'delete', tag], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function listImageNames(): string[] {
  try {
    const output = execFileSync(
      'container',
      ['image', 'list', '--format', 'json'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return parseImageListOutput(output);
  } catch {
    console.error('Warning: failed to parse image list output');
    return [];
  }
}
