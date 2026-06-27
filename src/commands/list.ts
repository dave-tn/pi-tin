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
import { formatRemainingDuration } from '../lib/duration.js';
import { printJson, shouldEmitJson } from '../lib/cli-output.js';

type Row = {
  workspace: string;
  profile: string;
  status: ContainerState;
  sessions: string;
  shutdown: string;
  projects: string;
};

export interface WorkspaceListEntry {
  workspace: string;
  profile: string;
  status: ContainerState;
  sessions: number | null;
  shutdownMs: number | null;
  projects: number;
}

// Project the display Row (which uses '–'/'?' sentinels) into a clean JSON
// shape: numeric counts, null where a value is unknown or not applicable.
// Row.shutdown is a formatted duration string, so shutdownMs reports null
// rather than emitting a lossy value.
export function toWorkspaceListJson(rows: Row[]): WorkspaceListEntry[] {
  return rows.map((row) => ({
    workspace: row.workspace,
    profile: row.profile,
    status: row.status,
    sessions: /^\d+$/.test(row.sessions) ? Number(row.sessions) : null,
    shutdownMs: null,
    projects: Number(row.projects),
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

function renderStatus(value: string, state: ContainerState): string {
  switch (state) {
    case 'running':
      return chalk.green(value);
    case 'stopped':
      return chalk.yellow(value);
    case 'not-found':
      return chalk.dim(value);
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

      const containers = listContainers();
      const stateMap = new Map<string, ContainerState>();
      for (const container of containers) {
        stateMap.set(container.id, container.status === 'running' ? 'running' : 'stopped');
      }

      const warnings: WarningBlock[] = [];
      const rows: Row[] = [];

      for (const { name, workspace } of workspaces) {
        const containerName = containerNameFor(name);
        const containerState = stateMap.get(containerName) ?? 'not-found';

        let sessions = '–';
        let shutdown = '–';

        if (containerState === 'running') {
          const runtime = await tryWithWorkspaceLock(name, () => reconcileWorkspaceRuntimeState(name))
            ?? readRuntimeSnapshot(name);

          if (runtime.runtimeState === 'ok') {
            sessions = String(runtime.activeSessions.length);
            shutdown = runtime.shutdown
              ? formatRemainingDuration(runtime.shutdown.deadlineMs)
              : '–';
          } else {
            sessions = '?';
            shutdown = '?';
            warnings.push(formatRuntimeStateWarning(name, runtime));
          }
        }

        rows.push({
          workspace: name,
          profile: workspace.profile,
          status: containerState,
          sessions,
          shutdown,
          projects: String(workspace.projects.length),
        });
      }

      if (shouldEmitJson(opts.json)) {
        printJson(toWorkspaceListJson(rows));
        return;
      }

      const widths = {
        workspace: Math.max('WORKSPACE'.length, ...rows.map((row) => row.workspace.length)),
        profile: Math.max('PROFILE'.length, ...rows.map((row) => row.profile.length)),
        status: Math.max('STATUS'.length, ...rows.map((row) => statusLabel(row.status).length)),
        sessions: Math.max('SESSIONS'.length, ...rows.map((row) => row.sessions.length)),
        shutdown: Math.max('SHUTDOWN'.length, ...rows.map((row) => row.shutdown.length)),
        projects: Math.max('PROJECTS'.length, ...rows.map((row) => row.projects.length)),
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

      for (const row of rows) {
        console.log([
          row.workspace.padEnd(widths.workspace),
          row.profile.padEnd(widths.profile),
          renderStatus(statusLabel(row.status).padEnd(widths.status), row.status),
          row.sessions.padEnd(widths.sessions),
          row.shutdown.padEnd(widths.shutdown),
          row.projects.padEnd(widths.projects),
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
