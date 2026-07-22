import path from 'node:path';
import {
  containerNameFor,
  isPiTinContainerId,
  workspaceNameFromContainerId,
  isPiTinImageTag,
  workspaceNameFromImageTag,
  type ContainerState,
} from './container.js';
import type { ListedContainer, Workspace } from './validators.js';
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

export interface PlanImageBuildOptions {
  // The user passed --build. Always rebuilds, but is not itself a config change.
  forceBuild: boolean;
  // The persisted runtime-meta build hash no longer matches the computed one.
  driftDetected: boolean;
  // Build hash recorded by the last successful build, or null if never built.
  previousBuildHash: string | null;
  newBuildHash: string;
  imagePresent: boolean;
}

export interface ImageBuildPlan {
  build: boolean;
  // Whether to tell the user the rebuild was caused by a config change. Only
  // set when an existing image is being rebuilt because config changed —
  // never on a first build or a bare --build with no changes.
  announceConfigChange: boolean;
}

export function planImageBuild(options: PlanImageBuildOptions): ImageBuildPlan {
  const configChanged =
    options.driftDetected
    || (options.previousBuildHash !== null && options.previousBuildHash !== options.newBuildHash);

  return {
    build: options.forceBuild || !options.imagePresent || configChanged,
    announceConfigChange: configChanged && options.imagePresent,
  };
}

export interface PlanBuildFailureFallbackOptions {
  // A previously built image survives a failed rebuild (`container build` only
  // retags on success), so it can still run — with stale config.
  imagePresent: boolean;
  // A human is attached and can answer a prompt.
  isInteractive: boolean;
}

export type BuildFailureFallbackPlan =
  | { action: 'offer' }
  | { action: 'abort'; reason: 'no-image' | 'non-interactive' };

// After a rebuild fails, decide whether we can offer to run the previous image.
// Only when one exists AND a human can answer — a non-interactive caller must
// not silently run stale config, nor hang on a prompt it can never answer.
export function planBuildFailureFallback(
  options: PlanBuildFailureFallbackOptions,
): BuildFailureFallbackPlan {
  if (!options.imagePresent) return { action: 'abort', reason: 'no-image' };
  if (!options.isInteractive) return { action: 'abort', reason: 'non-interactive' };
  return { action: 'offer' };
}

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
const CONTAINER_SYSTEM_RETRY_HINT =
  "Check the container system is running ('container system start'), then retry.";

function unknownContainerStateMessage(workspaceName: string): string {
  return [
    `Could not determine the state of workspace '${workspaceName}' — listing containers failed.`,
    CONTAINER_SYSTEM_RETRY_HINT,
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
  // A human is attached and can land in the opened tmux session.
  isInteractive: boolean;
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

function addedHeadlessMessage(projectPath: string, workspaceName: string): string {
  const project = path.basename(projectPath);
  return [
    `Added ${project} to workspace '${workspaceName}'.`,
    `Run 'pi-tin open ${workspaceName}' from a terminal to start it with the project mounted.`,
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

  // add-and-open ends in a tmux attach, which a headless caller cannot
  // survive — plan the message outcome instead of starting a container it
  // can never attach to.
  if (!options.isInteractive) {
    return {
      action: 'add-and-message',
      message: addedHeadlessMessage(options.projectPath, options.workspaceName),
    };
  }

  return { action: 'add-and-open' };
}

export interface PlanAttachPreflightOptions {
  workspaceName: string;
  configuredAttach: Workspace['attach'];
  attachOverride: Workspace['attach'] | undefined;
  sshdEnabled: boolean;
  herdrPresent: boolean;
}

export type AttachPreflightPlan =
  | { mode: 'shell' }
  | { mode: 'herdr' }
  | { mode: 'refuse'; message: string };

// Runs before any build/start side effect: a herdr attach that can never
// succeed (no sshd in the image, no herdr on the Mac) must not cost an image
// build or leave a started container behind.
export function planAttachPreflight(options: PlanAttachPreflightOptions): AttachPreflightPlan {
  const attach = options.attachOverride ?? options.configuredAttach;
  if (attach === 'shell') {
    return { mode: 'shell' };
  }

  if (!options.sshdEnabled) {
    return {
      mode: 'refuse',
      message:
        `Workspace '${options.workspaceName}' is not built with sshd, which herdr attach requires.\n`
        + `Set 'attach: herdr' or 'sshd: true' in the workspace YAML, then reopen to rebuild.`,
    };
  }

  if (!options.herdrPresent) {
    return {
      mode: 'refuse',
      message:
        'herdr is not installed on this Mac.\n'
        + 'Install it (https://herdr.dev) or reopen with `--attach shell`.',
    };
  }

  return { mode: 'herdr' };
}

export type HerdrAttachPlan =
  | { mode: 'herdr'; hostAlias: string; ipv4Address: string }
  | { mode: 'refuse'; message: string };

// Post-start companion to planAttachPreflight: the container IP only exists
// once the container runs, and without it there is nothing to ssh into.
export function planHerdrAttach(options: {
  workspaceName: string;
  ipv4Address: string | null;
}): HerdrAttachPlan {
  if (options.ipv4Address === null) {
    return {
      mode: 'refuse',
      message:
        `Workspace '${options.workspaceName}' is running but its container reports no IP address, so herdr cannot connect.\n`
        + CONTAINER_SYSTEM_RETRY_HINT,
    };
  }

  return {
    mode: 'herdr',
    hostAlias: containerNameFor(options.workspaceName),
    ipv4Address: options.ipv4Address,
  };
}

export type HerdrAgentStates =
  | { kind: 'not-applicable' }
  | { kind: 'unavailable' }
  | { kind: 'states'; working: number };

export interface PlanAutoStopOptions {
  containerState: ContainerState;
  runtimeState: RuntimeStateStatus;
  activeSessions: number;
  // The armed shutdown record still names this helper's deadline; a mismatch
  // means a newer arm/cancel superseded it.
  deadlineMatches: boolean;
  agentStates: HerdrAgentStates;
}

export type AutoStopPlan =
  | { action: 'stop' }
  | { action: 'defer' }
  | { action: 'bail' };

// 'unavailable' deliberately stops rather than defers: a herdr query that
// never succeeds must not keep a container alive forever, and a stop is
// recoverable — herdr restores the session and resumes agents on next open.
export function planAutoStopDecision(options: PlanAutoStopOptions): AutoStopPlan {
  if (options.containerState !== 'running') {
    return { action: 'bail' };
  }
  if (options.runtimeState !== 'ok') {
    return { action: 'bail' };
  }
  if (options.activeSessions > 0) {
    return { action: 'bail' };
  }
  if (!options.deadlineMatches) {
    return { action: 'bail' };
  }
  if (options.agentStates.kind === 'states' && options.agentStates.working > 0) {
    return { action: 'defer' };
  }
  return { action: 'stop' };
}

export type CleanupPlan =
  | {
    action: 'refuse';
    message: string;
  }
  | {
    action: 'clean';
    runningWorkspaces: string[];
    stoppedWorkspaces: string[];
  };

// `containers` is null when `container list` itself failed — cleanup cannot
// tell which workspaces are running, so nothing destructive may proceed.
export function planCleanup(containers: ListedContainer[] | null): CleanupPlan {
  if (containers === null) {
    return {
      action: 'refuse',
      message:
        'Could not list containers, so cleanup cannot tell which workspaces are running.\n'
        + CONTAINER_SYSTEM_RETRY_HINT,
    };
  }
  const piTinContainers = containers.filter((container) => isPiTinContainerId(container.id));
  return {
    action: 'clean',
    runningWorkspaces: piTinContainers
      .filter((container) => container.status === 'running')
      .map((container) => workspaceNameFromContainerId(container.id)),
    stoppedWorkspaces: piTinContainers
      .filter((container) => container.status !== 'running')
      .map((container) => workspaceNameFromContainerId(container.id)),
  };
}

/** pi-tin image tags with no matching workspace — what cleanup may delete. */
export function selectOrphanedImages(options: {
  imageNames: string[];
  workspaceNames: string[];
}): string[] {
  const knownWorkspaces = new Set(options.workspaceNames);
  return options.imageNames.filter(
    (imageName) =>
      isPiTinImageTag(imageName) && !knownWorkspaces.has(workspaceNameFromImageTag(imageName)),
  );
}
