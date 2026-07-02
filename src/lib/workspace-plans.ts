import path from 'node:path';
import type { ContainerState } from './container.js';
import type { RuntimeStateStatus } from './runtime-state.js';
import { sharedDirectoryLimitMessage, basenameCollisionMessage } from './project-mounts.js';

export interface PlanWorkspaceOpenOptions {
  workspaceName: string;
  containerState: ContainerState;
  runtimeState: RuntimeStateStatus;
  hasRuntimeMeta: boolean;
  activeSessions: number;
  buildRequested: boolean;
  hasDrift: boolean;
}

export type WorkspaceOpenPlan =
  | {
    action: 'start';
    activeSessionsAfterOpen: 1;
    clearStaleRuntimeState: boolean;
    deleteStoppedContainer: boolean;
  }
  | {
    action: 'join';
    activeSessionsAfterOpen: number;
    warnAboutDeferredRestart: boolean;
  }
  | {
    action: 'restart';
    activeSessionsAfterOpen: 1;
  }
  | {
    action: 'refuse';
    message: string;
  };

export type StopWorkspacePlan =
  | {
    action: 'noop';
  }
  | {
    action: 'refuse';
    message: string;
  }
  | {
    action: 'confirm';
    message: string;
  }
  | {
    action: 'stop';
    warnAboutInconsistentRuntime: boolean;
  };

export type DeleteWorkspacePlan =
  | {
    action: 'refuse';
    message: string;
  }
  | {
    action: 'delete';
    stopRunningContainer: boolean;
  };

// An 'unknown' container state means `container list` itself failed. That is
// never a safe basis for starting, stopping, or destroying anything — every
// planner refuses and asks the user to retry once listing works again.
function unknownContainerStateMessage(workspaceName: string): string {
  return [
    `Could not determine the state of workspace '${workspaceName}' — listing containers failed.`,
    "Check the container system is running ('container system start'), then retry.",
  ].join('\n');
}

function runtimeInconsistencyMessage(workspaceName: string): string {
  return [
    `Workspace '${workspaceName}' is running, but its runtime state could not be read.`,
    'pi-tin cannot safely join or restart it in this state.',
    `To reset it: pi-tin stop ${workspaceName}`,
    `If needed: pi-tin stop ${workspaceName} --force`,
  ].join('\n');
}

export function planWorkspaceOpen(
  options: PlanWorkspaceOpenOptions,
): WorkspaceOpenPlan {
  if (options.containerState === 'unknown') {
    return {
      action: 'refuse',
      message: unknownContainerStateMessage(options.workspaceName),
    };
  }

  if (options.containerState !== 'running') {
    return {
      action: 'start',
      activeSessionsAfterOpen: 1,
      clearStaleRuntimeState: options.runtimeState !== 'missing',
      deleteStoppedContainer: options.containerState === 'stopped',
    };
  }

  if (options.runtimeState !== 'ok' || !options.hasRuntimeMeta) {
    return {
      action: 'refuse',
      message: runtimeInconsistencyMessage(options.workspaceName),
    };
  }

  if (options.activeSessions > 0 && options.buildRequested) {
    return {
      action: 'refuse',
      message:
        `Workspace '${options.workspaceName}' already has ${options.activeSessions} active session${options.activeSessions === 1 ? '' : 's'}.\n`
        + `Stop it first with 'pi-tin stop ${options.workspaceName}'.`,
    };
  }

  if (options.activeSessions > 0) {
    return {
      action: 'join',
      activeSessionsAfterOpen: options.activeSessions + 1,
      warnAboutDeferredRestart: options.hasDrift,
    };
  }

  if (options.buildRequested || options.hasDrift) {
    return {
      action: 'restart',
      activeSessionsAfterOpen: 1,
    };
  }

  return {
    action: 'join',
    activeSessionsAfterOpen: 1,
    warnAboutDeferredRestart: false,
  };
}

export function planStopWorkspace(options: {
  workspaceName: string;
  containerState: ContainerState;
  runtimeState: RuntimeStateStatus;
  activeSessions: number;
  force: boolean;
}): StopWorkspacePlan {
  if (options.containerState === 'unknown') {
    return {
      action: 'refuse',
      message: unknownContainerStateMessage(options.workspaceName),
    };
  }

  if (options.containerState !== 'running') {
    return { action: 'noop' };
  }

  if (options.runtimeState === 'ok' && options.activeSessions > 0 && !options.force) {
    return {
      action: 'confirm',
      message: `Workspace '${options.workspaceName}' has ${options.activeSessions} active session${options.activeSessions === 1 ? '' : 's'}. Stop it anyway?`,
    };
  }

  return {
    action: 'stop',
    warnAboutInconsistentRuntime: options.runtimeState !== 'ok',
  };
}

export function planDeleteWorkspace(options: {
  workspaceName: string;
  containerState: ContainerState;
  runtimeState: RuntimeStateStatus;
  activeSessions: number;
}): DeleteWorkspacePlan {
  if (options.containerState === 'unknown') {
    return {
      action: 'refuse',
      message: unknownContainerStateMessage(options.workspaceName),
    };
  }

  if (options.containerState !== 'running') {
    return {
      action: 'delete',
      stopRunningContainer: false,
    };
  }

  if (options.runtimeState !== 'ok') {
    return {
      action: 'refuse',
      message:
        `Workspace '${options.workspaceName}' is running but its runtime state is inconsistent.\n`
        + `Run 'pi-tin stop ${options.workspaceName}' first.`,
    };
  }

  if (options.activeSessions > 0) {
    return {
      action: 'refuse',
      message:
        `Workspace '${options.workspaceName}' has ${options.activeSessions} active session${options.activeSessions === 1 ? '' : 's'}.\n`
        + `Stop it first with 'pi-tin stop ${options.workspaceName}'.`,
    };
  }

  return {
    action: 'delete',
    stopRunningContainer: true,
  };
}

export interface PlanAddProjectOptions {
  projectPath: string;
  workspaceName: string;
  existingProjects: string[];
  projectedSharedDirectoryCount: number;
  maxSharedDirectories: number;
  containerState: ContainerState;
}

export type AddProjectPlan =
  | { action: 'reject'; message: string }
  | { action: 'add-and-open' }
  | { action: 'add-and-message'; message: string };

function addedToRunningMessage(projectPath: string, workspaceName: string): string {
  const project = path.basename(projectPath);
  return [
    `Added ${project} to workspace '${workspaceName}'.`,
    `'${workspaceName}' is running, so the project isn't mounted yet — that happens on its next restart.`,
    `Once you've finished and exited every open session in '${workspaceName}', the next 'pi-tin open ${workspaceName}' will restart it and mount the project.`,
    '(Reopening while a session is still active just rejoins it unchanged.)',
  ].join('\n');
}

export function planAddProject(options: PlanAddProjectOptions): AddProjectPlan {
  const target = path.resolve(options.projectPath);
  const alreadyPresent = options.existingProjects.some(
    (projectPath) => path.resolve(projectPath) === target,
  );
  if (alreadyPresent) {
    return {
      action: 'reject',
      message: `Project is already in workspace '${options.workspaceName}': ${options.projectPath}`,
    };
  }

  const newBasename = path.basename(target);
  const colliding = options.existingProjects.filter(
    (projectPath) => path.basename(projectPath) === newBasename,
  );
  if (colliding.length > 0) {
    return {
      action: 'reject',
      message: basenameCollisionMessage(newBasename, [options.projectPath, ...colliding]),
    };
  }

  if (options.projectedSharedDirectoryCount > options.maxSharedDirectories) {
    return {
      action: 'reject',
      message: sharedDirectoryLimitMessage(options.workspaceName, options.projectedSharedDirectoryCount),
    };
  }

  if (options.containerState === 'unknown') {
    return {
      action: 'reject',
      message: unknownContainerStateMessage(options.workspaceName),
    };
  }

  if (options.containerState === 'running') {
    return {
      action: 'add-and-message',
      message: addedToRunningMessage(options.projectPath, options.workspaceName),
    };
  }

  return { action: 'add-and-open' };
}
