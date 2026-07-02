import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import * as v from 'valibot';
import { getStateDir } from './paths.js';
import { isRecord } from './guards.js';
import {
  LockRecordSchema,
  RuntimeMetaSchema,
  SessionRecordSchema,
  ShutdownRecordSchema,
} from './validators.js';
import type { LockRecord, RuntimeMeta, SessionRecord, ShutdownRecord } from './validators.js';
import type { ContainerState } from './container.js';

export type { RuntimeMeta, SessionRecord, ShutdownRecord } from './validators.js';

export type RuntimeStateStatus = 'missing' | 'ok' | 'corrupt';

export interface RuntimeStateSnapshot {
  runtimeState: RuntimeStateStatus;
  activeSessions: SessionRecord[];
  shutdown: ShutdownRecord | null;
  meta: RuntimeMeta | null;
  warnings: string[];
}

export interface RuntimeDecisionState {
  runtimeState: RuntimeStateStatus;
  activeSessions: number;
}

export interface RuntimeStateDeps {
  getStateDir: () => string;
  now: () => number;
  currentPid: () => number;
  sleep: (ms: number) => Promise<void>;
  isPidAlive: (pid: number) => boolean;
  // Returns a stable token identifying the *specific* process at `pid`, or null
  // if no such process exists. Used to detect PID reuse: if the token changes,
  // the original process is gone and a different one inherited the pid.
  getProcessToken: (pid: number) => string | null;
  killProcess: (pid: number) => void;
}

export interface RuntimeStateApi {
  withWorkspaceLock: <T>(workspaceName: string, fn: () => Promise<T> | T) => Promise<T>;
  tryWithWorkspaceLock: <T>(workspaceName: string, fn: () => Promise<T> | T) => Promise<T | null>;
  readRuntimeMeta: (workspaceName: string) => RuntimeMeta | null;
  writeRuntimeMeta: (workspaceName: string, meta: RuntimeMeta) => void;
  clearWorkspaceRuntimeState: (workspaceName: string) => void;
  listSessionRecords: (workspaceName: string) => SessionRecord[];
  registerSession: (workspaceName: string, record: SessionRecord) => void;
  unregisterSession: (workspaceName: string, sessionId: string) => void;
  reconcileWorkspaceRuntimeState: (workspaceName: string) => RuntimeStateSnapshot;
  readRuntimeSnapshot: (workspaceName: string) => RuntimeStateSnapshot;
  readRuntimeDecisionState: (
    workspaceName: string,
    containerState: ContainerState,
  ) => RuntimeDecisionState;
  readShutdown: (workspaceName: string) => ShutdownRecord | null;
  armShutdown: (workspaceName: string, shutdown: ShutdownRecord) => void;
  cancelShutdown: (workspaceName: string) => void;
}

const defaultDeps: RuntimeStateDeps = {
  getStateDir,
  now: () => Date.now(),
  currentPid: () => process.pid,
  sleep: async (ms: number) => {
    await sleep(ms);
  },
  isPidAlive: (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  getProcessToken: (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }

    // The (pid, start-time) pair uniquely identifies a process instance: a
    // reused pid will report a different start time. `ps -o lstart` is the
    // portable way to read it on macOS, which is the only platform pi-tin runs on.
    try {
      const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return output === '' ? null : output;
    } catch {
      return null;
    }
  },
  killProcess: (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return;
    }

    try {
      process.kill(pid);
    } catch {
      // Best effort only.
    }
  },
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isFileExistsError(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'EEXIST';
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

export function createRuntimeStateApi(
  overrides: Partial<RuntimeStateDeps> = {},
): RuntimeStateApi {
  const deps: RuntimeStateDeps = {
    ...defaultDeps,
    ...overrides,
  };

  const getRuntimeRootDir = (): string => path.join(deps.getStateDir(), 'runtime');
  const getWorkspaceRuntimeDir = (workspaceName: string): string =>
    path.join(getRuntimeRootDir(), workspaceName);
  const getLockPath = (workspaceName: string): string =>
    path.join(getWorkspaceRuntimeDir(workspaceName), 'lock.json');
  const getMetaPath = (workspaceName: string): string =>
    path.join(getWorkspaceRuntimeDir(workspaceName), 'meta.json');
  const getSessionsDir = (workspaceName: string): string =>
    path.join(getWorkspaceRuntimeDir(workspaceName), 'sessions');
  const getShutdownPath = (workspaceName: string): string =>
    path.join(getWorkspaceRuntimeDir(workspaceName), 'shutdown.json');

  const ensureWorkspaceRuntimeDir = (workspaceName: string): void => {
    fs.mkdirSync(getWorkspaceRuntimeDir(workspaceName), { recursive: true });
  };

  // A process is "alive" only if it is both running and still the same process
  // instance we recorded. When no token was captured (older records, or the
  // process was already gone at capture time) fall back to a bare pid check.
  const isProcessAlive = (pid: number, token?: string): boolean => {
    if (token !== undefined) {
      return deps.getProcessToken(pid) === token;
    }
    return deps.isPidAlive(pid);
  };

  const terminateHelperPid = (pid: number | undefined, token?: string): void => {
    if (!isPositiveInteger(pid) || pid === deps.currentPid()) {
      return;
    }
    // If we captured the helper's identity, only kill when it still matches —
    // never kill an unrelated process that inherited a reused pid.
    if (token !== undefined && deps.getProcessToken(pid) !== token) {
      return;
    }
    deps.killProcess(pid);
  };

  // A missing file is a normal state, not corruption; an unreadable or invalid
  // file is reported as corrupt and its contents are ignored.
  const readStateFile = <T>(
    filePath: string,
    schema: v.GenericSchema<unknown, T>,
  ): { value: T | null; corrupt: boolean } => {
    if (!fs.existsSync(filePath)) {
      return { value: null, corrupt: false };
    }

    try {
      const result = v.safeParse(schema, readJsonFile(filePath));
      return result.success
        ? { value: result.output, corrupt: false }
        : { value: null, corrupt: true };
    } catch {
      return { value: null, corrupt: true };
    }
  };

  const readLockRecord = (workspaceName: string): LockRecord | null => {
    return readStateFile(getLockPath(workspaceName), LockRecordSchema).value;
  };

  const readSessionFiles = (
    workspaceName: string,
    reapStaleSessions: boolean,
  ): { activeSessions: SessionRecord[]; corrupt: boolean } => {
    const sessionsDir = getSessionsDir(workspaceName);
    if (!fs.existsSync(sessionsDir)) {
      return { activeSessions: [], corrupt: false };
    }

    const fileNames = fs
      .readdirSync(sessionsDir)
      .filter((entry) => entry.endsWith('.json'))
      .sort();

    const activeSessions: SessionRecord[] = [];
    let corrupt = false;

    for (const fileName of fileNames) {
      const filePath = path.join(sessionsDir, fileName);
      try {
        const result = v.safeParse(SessionRecordSchema, readJsonFile(filePath));
        if (!result.success) {
          corrupt = true;
          continue;
        }

        const session = result.output;
        if (reapStaleSessions && !isProcessAlive(session.hostPid, session.hostToken)) {
          fs.rmSync(filePath, { force: true });
          continue;
        }

        activeSessions.push(session);
      } catch {
        corrupt = true;
      }
    }

    return { activeSessions, corrupt };
  };

  const buildSnapshot = (
    workspaceName: string,
    reapStaleSessions: boolean,
  ): RuntimeStateSnapshot => {
    const warnings: string[] = [];
    const workspaceDir = getWorkspaceRuntimeDir(workspaceName);
    const hasWorkspaceDir = fs.existsSync(workspaceDir);

    const { value: meta, corrupt: metaCorrupt } = readStateFile(getMetaPath(workspaceName), RuntimeMetaSchema);
    const { value: shutdown, corrupt: shutdownCorrupt } = readStateFile(getShutdownPath(workspaceName), ShutdownRecordSchema);
    const {
      activeSessions,
      corrupt: sessionsCorrupt,
    } = readSessionFiles(workspaceName, reapStaleSessions);

    // Deliberately recounted after readSessionFiles: reaped stale sessions
    // must not count as runtime files, while invalid (corrupt) records must.
    const sessionFileCount = fs.existsSync(getSessionsDir(workspaceName))
      ? fs.readdirSync(getSessionsDir(workspaceName)).filter((entry) => entry.endsWith('.json')).length
      : 0;

    if (metaCorrupt) {
      warnings.push(`Runtime metadata is invalid for workspace '${workspaceName}'.`);
    }
    if (shutdownCorrupt) {
      warnings.push(`Shutdown metadata is invalid for workspace '${workspaceName}'.`);
    }
    if (sessionsCorrupt) {
      warnings.push(`One or more session records are invalid for workspace '${workspaceName}'.`);
    }

    const hasRuntimeFiles = hasWorkspaceDir && (
      fs.existsSync(getMetaPath(workspaceName))
      || fs.existsSync(getShutdownPath(workspaceName))
      || sessionFileCount > 0
    );

    if (!metaCorrupt && meta === null && (shutdown !== null || sessionFileCount > 0)) {
      warnings.push(`Runtime metadata is missing for workspace '${workspaceName}'.`);
    }

    const runtimeState: RuntimeStateStatus =
      warnings.length > 0 ? 'corrupt'
        : !hasRuntimeFiles && meta === null && shutdown === null && activeSessions.length === 0 ? 'missing'
          : meta === null ? 'corrupt'
            : 'ok';

    return {
      runtimeState,
      activeSessions,
      shutdown,
      meta,
      warnings,
    };
  };

  const acquireLock = async (
    workspaceName: string,
    wait: boolean,
  ): Promise<(() => void) | null> => {
    const lockPath = getLockPath(workspaceName);

    while (true) {
      ensureWorkspaceRuntimeDir(workspaceName);

      try {
        const fd = fs.openSync(lockPath, 'wx');
        try {
          const ownerPid = deps.currentPid();
          const ownerToken = deps.getProcessToken(ownerPid);
          const lockRecord: LockRecord = {
            ownerPid,
            acquiredAt: new Date(deps.now()).toISOString(),
            ...(ownerToken === null ? {} : { ownerToken }),
          };
          fs.writeFileSync(fd, JSON.stringify(lockRecord, null, 2), 'utf-8');
        } finally {
          fs.closeSync(fd);
        }

        return () => {
          try {
            fs.rmSync(lockPath, { force: true });
          } catch {
            // Best effort only.
          }

          const workspaceDir = getWorkspaceRuntimeDir(workspaceName);
          try {
            if (fs.existsSync(workspaceDir) && fs.readdirSync(workspaceDir).length === 0) {
              fs.rmSync(workspaceDir, { recursive: true, force: true });
            }
          } catch {
            // Best effort only.
          }

          const runtimeRootDir = getRuntimeRootDir();
          try {
            if (fs.existsSync(runtimeRootDir) && fs.readdirSync(runtimeRootDir).length === 0) {
              fs.rmSync(runtimeRootDir, { recursive: true, force: true });
            }
          } catch {
            // Best effort only.
          }
        };
      } catch (error) {
        if (!isFileExistsError(error)) {
          throw error;
        }
      }

      const existing = readLockRecord(workspaceName);
      if (existing === null || !isProcessAlive(existing.ownerPid, existing.ownerToken)) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Another process may have won the race; retry.
        }
        continue;
      }

      if (!wait) {
        return null;
      }

      await deps.sleep(100);
    }
  };

  const withWorkspaceLock = async <T>(
    workspaceName: string,
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    const release = await acquireLock(workspaceName, true);
    if (release === null) {
      throw new Error(`Failed to acquire lock for workspace '${workspaceName}'.`);
    }

    try {
      return await fn();
    } finally {
      release();
    }
  };

  const tryWithWorkspaceLock = async <T>(
    workspaceName: string,
    fn: () => Promise<T> | T,
  ): Promise<T | null> => {
    const release = await acquireLock(workspaceName, false);
    if (release === null) {
      return null;
    }

    try {
      return await fn();
    } finally {
      release();
    }
  };

  const readRuntimeMeta = (workspaceName: string): RuntimeMeta | null => {
    return readStateFile(getMetaPath(workspaceName), RuntimeMetaSchema).value;
  };

  const writeRuntimeMeta = (workspaceName: string, meta: RuntimeMeta): void => {
    writeJsonFile(getMetaPath(workspaceName), meta);
  };

  const listSessionRecords = (workspaceName: string): SessionRecord[] => {
    return readSessionFiles(workspaceName, false).activeSessions;
  };

  const registerSession = (workspaceName: string, record: SessionRecord): void => {
    ensureWorkspaceRuntimeDir(workspaceName);
    const token = deps.getProcessToken(record.hostPid);
    const stamped: SessionRecord = token === null ? record : { ...record, hostToken: token };
    writeJsonFile(path.join(getSessionsDir(workspaceName), `${record.sessionId}.json`), stamped);
  };

  const unregisterSession = (workspaceName: string, sessionId: string): void => {
    fs.rmSync(path.join(getSessionsDir(workspaceName), `${sessionId}.json`), { force: true });
  };

  const readShutdown = (workspaceName: string): ShutdownRecord | null => {
    return readStateFile(getShutdownPath(workspaceName), ShutdownRecordSchema).value;
  };

  const cancelShutdown = (workspaceName: string): void => {
    const shutdown = readShutdown(workspaceName);
    terminateHelperPid(shutdown?.helperPid, shutdown?.helperToken);
    fs.rmSync(getShutdownPath(workspaceName), { force: true });
  };

  const armShutdown = (workspaceName: string, shutdown: ShutdownRecord): void => {
    const previous = readShutdown(workspaceName);
    if (previous?.helperPid !== shutdown.helperPid) {
      terminateHelperPid(previous?.helperPid, previous?.helperToken);
    }
    const helperToken = shutdown.helperPid === undefined
      ? undefined
      : deps.getProcessToken(shutdown.helperPid) ?? undefined;
    writeJsonFile(getShutdownPath(workspaceName), { ...shutdown, helperToken });
  };

  const clearWorkspaceRuntimeState = (workspaceName: string): void => {
    cancelShutdown(workspaceName);
    fs.rmSync(getMetaPath(workspaceName), { force: true });
    fs.rmSync(getSessionsDir(workspaceName), { recursive: true, force: true });

    const workspaceDir = getWorkspaceRuntimeDir(workspaceName);
    if (!fs.existsSync(workspaceDir)) {
      return;
    }

    if (fs.readdirSync(workspaceDir).length === 0) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  };

  const reconcileWorkspaceRuntimeState = (workspaceName: string): RuntimeStateSnapshot => {
    return buildSnapshot(workspaceName, true);
  };

  const readRuntimeSnapshot = (workspaceName: string): RuntimeStateSnapshot => {
    return buildSnapshot(workspaceName, false);
  };

  /**
   * Runtime-state inputs the stop/delete planners decide on. When the container
   * is not confirmed running ('stopped', 'not-found', or 'unknown') the runtime
   * state is irrelevant — the planners no-op or refuse on the container state
   * alone — so report it as missing without touching (and reaping) the state
   * files.
   */
  const readRuntimeDecisionState = (
    workspaceName: string,
    containerState: ContainerState,
  ): RuntimeDecisionState => {
    if (containerState !== 'running') {
      return {
        runtimeState: 'missing',
        activeSessions: 0,
      };
    }

    const runtime = reconcileWorkspaceRuntimeState(workspaceName);
    return {
      runtimeState: runtime.runtimeState,
      activeSessions: runtime.activeSessions.length,
    };
  };

  return {
    withWorkspaceLock,
    tryWithWorkspaceLock,
    readRuntimeMeta,
    writeRuntimeMeta,
    clearWorkspaceRuntimeState,
    listSessionRecords,
    registerSession,
    unregisterSession,
    reconcileWorkspaceRuntimeState,
    readRuntimeSnapshot,
    readRuntimeDecisionState,
    readShutdown,
    armShutdown,
    cancelShutdown,
  };
}

const defaultApi = createRuntimeStateApi();

export const withWorkspaceLock = defaultApi.withWorkspaceLock;
export const tryWithWorkspaceLock = defaultApi.tryWithWorkspaceLock;
export const readRuntimeMeta = defaultApi.readRuntimeMeta;
export const writeRuntimeMeta = defaultApi.writeRuntimeMeta;
export const clearWorkspaceRuntimeState = defaultApi.clearWorkspaceRuntimeState;
export const listSessionRecords = defaultApi.listSessionRecords;
export const registerSession = defaultApi.registerSession;
export const unregisterSession = defaultApi.unregisterSession;
export const reconcileWorkspaceRuntimeState = defaultApi.reconcileWorkspaceRuntimeState;
export const readRuntimeSnapshot = defaultApi.readRuntimeSnapshot;
export const readRuntimeDecisionState = defaultApi.readRuntimeDecisionState;
export const readShutdown = defaultApi.readShutdown;
export const armShutdown = defaultApi.armShutdown;
export const cancelShutdown = defaultApi.cancelShutdown;
