import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicWriteFile } from './atomic-write.js';
import { containerNameFor, type ExecResult } from './container.js';
import { WORKSPACE_SSHD_PORT } from './dockerfile.js';
import {
  getSshDir,
  getSshKeyPath,
  getSshPublicKeyPath,
  getSshConfigPath,
  getSshKnownHostsPath,
  getUserSshConfigPath,
} from './paths.js';
import { CliError, EXIT } from './cli-errors.js';
import type { Workspace } from './validators.js';

// attach: herdr needs the endpoint, so it wins over an absent (or false) sshd.
export function isSshdEnabled(workspace: Pick<Workspace, 'sshd' | 'attach'>): boolean {
  return workspace.sshd || workspace.attach === 'herdr';
}

type KeygenRun = (args: string[]) => void;

const runKeygen: KeygenRun = (args) => {
  execFileSync('ssh-keygen', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
};

/** Idempotently create pi-tin's ssh keypair; returns the public key line. */
export function ensureSshKeypair(run: KeygenRun = runKeygen): { publicKey: string } {
  fs.mkdirSync(getSshDir(), { recursive: true, mode: 0o700 });

  const keyPath = getSshKeyPath();
  if (!fs.existsSync(keyPath)) {
    try {
      run(['-q', '-t', 'ed25519', '-N', '', '-C', 'pi-tin', '-f', keyPath]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError(`Failed to generate the pi-tin ssh keypair: ${message}`, EXIT.GENERAL, {
        code: 'ssh_keygen_failed',
        remediation: 'Ensure `ssh-keygen` is on PATH (it ships with macOS), then retry.',
      });
    }
  }

  const publicKeyPath = getSshPublicKeyPath();
  if (!fs.existsSync(publicKeyPath)) {
    throw new CliError(`ssh public key missing: ${publicKeyPath}`, EXIT.GENERAL, {
      code: 'ssh_keygen_failed',
      remediation: `Delete ${getSshKeyPath()} and retry to regenerate the pair.`,
    });
  }

  return { publicKey: fs.readFileSync(publicKeyPath, 'utf-8').trim() };
}

function startMarker(workspaceName: string): string {
  return `# >>> pi-tin workspace '${workspaceName}' — managed, do not edit >>>`;
}

function endMarker(workspaceName: string): string {
  return `# <<< pi-tin workspace '${workspaceName}' <<<`;
}

export function renderWorkspaceHostBlock(input: {
  workspaceName: string;
  ipv4Address: string;
  user: string;
}): string {
  return [
    startMarker(input.workspaceName),
    `Host ${containerNameFor(input.workspaceName)}`,
    `  HostName ${input.ipv4Address}`,
    `  Port ${WORKSPACE_SSHD_PORT}`,
    `  User ${input.user}`,
    `  IdentityFile ${getSshKeyPath()}`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${getSshKnownHostsPath(input.workspaceName)}`,
    '  StrictHostKeyChecking accept-new',
    endMarker(input.workspaceName),
  ].join('\n');
}

export function upsertWorkspaceHostBlock(
  existingContent: string | null,
  workspaceName: string,
  block: string,
): string {
  const withoutBlock = removeWorkspaceHostBlock(existingContent, workspaceName) ?? existingContent ?? '';
  const separator = withoutBlock === '' ? '' : withoutBlock.endsWith('\n') ? '\n' : '\n\n';
  return `${withoutBlock}${separator}${block}\n`;
}

/** Content with the workspace's block removed, or null when nothing changed. */
export function removeWorkspaceHostBlock(
  existingContent: string | null,
  workspaceName: string,
): string | null {
  if (existingContent === null) {
    return null;
  }

  const lines = existingContent.split('\n');
  const start = lines.indexOf(startMarker(workspaceName));
  const end = lines.indexOf(endMarker(workspaceName));
  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  // Also swallow the single blank separator line upsert leaves behind.
  const afterEnd = lines[end + 1] === '' ? end + 2 : end + 1;
  return [...lines.slice(0, start), ...lines.slice(afterEnd)].join('\n');
}

export type SshIncludePlan = 'none' | 'offer-append' | 'hint';

// The generated config only takes effect once ~/.ssh/config Includes it; a
// path mention anywhere counts as done (commented-out lines are the user's
// deliberate choice — do not fight it).
export function planSshInclude(options: {
  userSshConfigContent: string | null;
  includePath: string;
  isInteractive: boolean;
}): SshIncludePlan {
  if (options.userSshConfigContent?.includes(options.includePath) === true) {
    return 'none';
  }
  return options.isInteractive ? 'offer-append' : 'hint';
}

export function sshIncludeLine(): string {
  return `Include ${getSshConfigPath()}`;
}

// Prepended, not appended: an Include after a Host block would nest inside it.
export function appendSshInclude(userConfigPath: string = getUserSshConfigPath()): void {
  fs.mkdirSync(path.dirname(userConfigPath), { recursive: true, mode: 0o700 });

  const existing = fs.existsSync(userConfigPath)
    ? fs.readFileSync(userConfigPath, 'utf-8')
    : null;

  if (existing !== null) {
    const backupPath = `${userConfigPath}.pi-tin.bak`;
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(userConfigPath, backupPath);
    }
  }

  atomicWriteFile(userConfigPath, `${sshIncludeLine()}\n${existing === null ? '' : `\n${existing}`}`);
  fs.chmodSync(userConfigPath, 0o600);
}

export function writeWorkspaceSshHostEntry(input: {
  workspaceName: string;
  ipv4Address: string;
  user: string;
}): void {
  const configPath = getSshConfigPath();
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  const block = renderWorkspaceHostBlock(input);
  atomicWriteFile(configPath, upsertWorkspaceHostBlock(existing, input.workspaceName, block));
}

export function clearWorkspaceKnownHosts(workspaceName: string): void {
  fs.rmSync(getSshKnownHostsPath(workspaceName), { force: true });
}

// Best effort: a stale Host block only fails closed (key mismatch on a reused
// IP) and is rewritten on the next open, so cleanup must never block a
// stop/delete.
export function removeWorkspaceSshArtifacts(
  workspaceName: string,
  options: { clearKnownHosts: boolean },
): void {
  try {
    const configPath = getSshConfigPath();
    if (fs.existsSync(configPath)) {
      const removed = removeWorkspaceHostBlock(fs.readFileSync(configPath, 'utf-8'), workspaceName);
      if (removed !== null) {
        atomicWriteFile(configPath, removed);
      }
    }
    if (options.clearKnownHosts) {
      clearWorkspaceKnownHosts(workspaceName);
    }
  } catch {
    // Best effort only.
  }
}

function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (connected: boolean): void => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

// A container accepts exec before its sshd finishes starting, so the attach
// probe alone is not enough for an ssh-based client.
export async function probeSshEndpoint(
  ipv4Address: string,
  port: number,
  options: { attempts?: number; connectTimeoutMs?: number; retryDelayMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 10;
  const connectTimeoutMs = options.connectTimeoutMs ?? 500;
  const retryDelayMs = options.retryDelayMs ?? 500;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(retryDelayMs);
    }
    if (await tryConnect(ipv4Address, port, connectTimeoutMs)) {
      return true;
    }
  }
  return false;
}

export function herdrOnPath(): boolean {
  try {
    execFileSync('which', ['herdr'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Interactive local herdr client attach; same result shape as execContainer. */
export function attachHerdr(hostAlias: string): ExecResult {
  const result = spawnSync('herdr', ['--remote', hostAlias], {
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
