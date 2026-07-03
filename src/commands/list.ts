import chalk from 'chalk';
import { ensureInitialised } from '../lib/init-guard.js';
import { listWorkspaces } from '../lib/workspaces.js';
import { containerNameFor, listContainers, type ContainerState } from '../lib/container.js';
import {
  tryWithWorkspaceLock,
  reconcileWorkspaceRuntimeState,
  readRuntimeSnapshot,
  type RuntimeStateSnapshot,
} from '../lib/runtime-state.js';
import { formatRemainingDuration, remainingDurationMs } from '../lib/duration.js';
import { printJson, shouldEmitJson } from '../lib/cli-output.js';

// Runtime activity for a workspace row: 'inactive' when the container is not
// running, 'unreadable' when its sessions cannot be known (runtime state
// could not be read, or the container state itself is unknown), 'active'
// with the parsed numbers otherwise.
type RowActivity =
  | { kind: 'inactive' }
  | { kind: 'unreadable' }
  | { kind: 'active'; sessions: number; shutdownDeadlineMs: number | null };

type Row = {
  workspace: string;
  profile: string;
  status: ContainerState;
  activity: RowActivity;
  projects: number;
};

export interface WorkspaceListEntry {
  workspace: string;
  profile: string;
  status: ContainerState;
  sessions: number | null;
  shutdownMs: number | null;
  projects: number;
}

// Project rows into the JSON shape: numeric counts, null where a value is
// unknown or not applicable. shutdownMs carries the same quantity as the
// table's SHUTDOWN countdown — milliseconds remaining, clamped at 0.
export function toWorkspaceListJson(rows: Row[], nowMs = Date.now()): WorkspaceListEntry[] {
  return rows.map((row) => ({
    workspace: row.workspace,
    profile: row.profile,
    status: row.status,
    sessions: row.activity.kind === 'active' ? row.activity.sessions : null,
    shutdownMs: row.activity.kind === 'active' && row.activity.shutdownDeadlineMs !== null
      ? remainingDurationMs(row.activity.shutdownDeadlineMs, nowMs)
      : null,
    projects: row.projects,
  }));
}

type WarningBlock = {
  summary: string;
  details: string[];
};

export function formatRuntimeStateWarning(
  workspaceName: string,
  runtime: RuntimeStateSnapshot,
): WarningBlock {
  return {
    summary: `Workspace '${workspaceName}' is running, but its runtime state could not be read.`,
    details: [
      'Sessions and shutdown status may be inaccurate.',
      ...runtime.warnings.map((warning) => `Detail: ${warning}`),
      `Optional cleanup: pi-tin stop ${workspaceName}`,
    ],
  };
}

function statusLabel(state: ContainerState): string {
  return state === 'not-found' ? '–' : state;
}

function sessionsLabel(activity: RowActivity): string {
  switch (activity.kind) {
    case 'inactive':
      return '–';
    case 'unreadable':
      return '?';
    case 'active':
      return String(activity.sessions);
  }
}

function shutdownLabel(activity: RowActivity): string {
  switch (activity.kind) {
    case 'inactive':
      return '–';
    case 'unreadable':
      return '?';
    case 'active':
      return activity.shutdownDeadlineMs === null
        ? '–'
        : formatRemainingDuration(activity.shutdownDeadlineMs);
  }
}

function renderStatus(value: string, state: ContainerState): string {
  switch (state) {
    case 'running':
      return chalk.green(value);
    case 'stopped':
      return chalk.yellow(value);
    case 'not-found':
      return chalk.dim(value);
    case 'unknown':
      return chalk.yellow(value);
  }
}

export function registerListCommand(
  program: import('commander').Command,
): void {
  program
    .command('list')
    .description('List all workspaces')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      ensureInitialised();

      const workspaces = listWorkspaces();
      if (workspaces.length === 0) {
        if (shouldEmitJson(opts.json)) {
          printJson([]);
        } else {
          console.log(
            `No workspaces configured. Create one with: ${chalk.cyan('pi-tin create <name>')}`,
          );
        }
        return;
      }

      // A null list means the containers could not be listed at all — report
      // every workspace as 'unknown' rather than falsely as not running.
      const containers = listContainers();
      const stateMap = new Map<string, ContainerState>();
      for (const container of containers ?? []) {
        stateMap.set(container.id, container.status === 'running' ? 'running' : 'stopped');
      }

      const warnings: WarningBlock[] = [];
      const rows: Row[] = [];

      for (const { name, workspace } of workspaces) {
        const containerName = containerNameFor(name);
        const containerState: ContainerState = containers === null
          ? 'unknown'
          : stateMap.get(containerName) ?? 'not-found';

        let activity: RowActivity = containerState === 'unknown'
          ? { kind: 'unreadable' }
          : { kind: 'inactive' };

        if (containerState === 'running') {
          const runtime = await tryWithWorkspaceLock(name, () => reconcileWorkspaceRuntimeState(name))
            ?? readRuntimeSnapshot(name);

          if (runtime.runtimeState === 'ok') {
            activity = {
              kind: 'active',
              sessions: runtime.activeSessions.length,
              shutdownDeadlineMs: runtime.shutdown ? runtime.shutdown.deadlineMs : null,
            };
          } else {
            activity = { kind: 'unreadable' };
            warnings.push(formatRuntimeStateWarning(name, runtime));
          }
        }

        rows.push({
          workspace: name,
          profile: workspace.profile,
          status: containerState,
          activity,
          projects: workspace.projects.length,
        });
      }

      if (shouldEmitJson(opts.json)) {
        printJson(toWorkspaceListJson(rows));
        return;
      }

      const cells = rows.map((row) => ({
        workspace: row.workspace,
        profile: row.profile,
        status: row.status,
        sessions: sessionsLabel(row.activity),
        shutdown: shutdownLabel(row.activity),
        projects: String(row.projects),
      }));

      const widths = {
        workspace: Math.max('WORKSPACE'.length, ...cells.map((cell) => cell.workspace.length)),
        profile: Math.max('PROFILE'.length, ...cells.map((cell) => cell.profile.length)),
        status: Math.max('STATUS'.length, ...cells.map((cell) => statusLabel(cell.status).length)),
        sessions: Math.max('SESSIONS'.length, ...cells.map((cell) => cell.sessions.length)),
        shutdown: Math.max('SHUTDOWN'.length, ...cells.map((cell) => cell.shutdown.length)),
        projects: Math.max('PROJECTS'.length, ...cells.map((cell) => cell.projects.length)),
      };

      const header = [
        'WORKSPACE'.padEnd(widths.workspace),
        'PROFILE'.padEnd(widths.profile),
        'STATUS'.padEnd(widths.status),
        'SESSIONS'.padEnd(widths.sessions),
        'SHUTDOWN'.padEnd(widths.shutdown),
        'PROJECTS'.padEnd(widths.projects),
      ].join('  ');

      console.log(chalk.bold(header));

      for (const cell of cells) {
        console.log([
          cell.workspace.padEnd(widths.workspace),
          cell.profile.padEnd(widths.profile),
          renderStatus(statusLabel(cell.status).padEnd(widths.status), cell.status),
          cell.sessions.padEnd(widths.sessions),
          cell.shutdown.padEnd(widths.shutdown),
          cell.projects.padEnd(widths.projects),
        ].join('  '));
      }

      if (warnings.length > 0) {
        console.log();
        for (const warning of warnings) {
          console.log(chalk.yellow(`Warning: ${warning.summary}`));
          for (const detail of warning.details) {
            console.log(chalk.yellow(`  ${detail}`));
          }
        }
      }
    });
}
