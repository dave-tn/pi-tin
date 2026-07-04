import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import chalk from 'chalk';
import { containerHomeDir, expandTilde, getBuildHashPath, getHostGhConfigDir } from './paths.js';
import { ensureInitialised } from './init-guard.js';
import { loadContainerProfile } from './profiles.js';
import { loadWorkspace, listWorkspaces, workspaceExists, isValidWorkspaceName } from './workspaces.js';
import { notFoundWorkspaceError } from './workspace-errors.js';
import { generateDockerfile } from './dockerfile.js';
import {
  containerNameFor,
  imageTagFor,
  imageExists,
  buildImage,
  runContainerDetached,
  execContainer,
  getContainerState,
  deleteContainer,
  type VolumeMount,
  type ExecResult,
} from './container.js';
import { stopAndRemoveContainer } from './container-lifecycle.js';
import { isRecord } from './guards.js';
import { AUTO_STOP_COMMAND } from './auto-stop.js';
import { resolveResources, type ResolvedResources } from './resources.js';
import { resolveEnv } from './env.js';
import { agentsWithSkipPermissions, agentContainerEnv, claudeManagedSettingsJson, claudeConfigJson } from './agents.js';
import { validateAgentProfilesForWorkspace } from './agent-profiles.js';
import {
  ensureWorkspaceTmuxDir,
  getHostTmuxConfigDir,
  getHostTmuxPluginsDir,
} from './tmux.js';
import type { ContainerProfile, Workspace } from './validators.js';
import {
  withWorkspaceLock,
  reconcileWorkspaceRuntimeState,
  registerSession,
  unregisterSession,
  writeRuntimeMeta,
  clearWorkspaceRuntimeState,
  cancelShutdown,
  armShutdown,
} from './runtime-state.js';
import { parseDurationMs, formatDurationMs } from './duration.js';
import {
  MAX_SHARED_DIRECTORIES,
  countUniqueVolumeSources,
  resolveProjectVolumes,
  sharedDirectoryLimitMessage,
  basenameCollisionMessage,
} from './project-mounts.js';
import { planWorkspaceOpen, planImageBuild, planBuildFailureFallback } from './workspace-plans.js';
import { isInteractiveSession, promptConfirm } from './confirmation.js';
import { CliError, EXIT } from './cli-errors.js';

const KEEPALIVE_COMMAND = [
  '/bin/sh',
  '-lc',
  'trap "exit 0" TERM INT; while :; do sleep 86400; done',
];

// `container exec` runs a literal command and never consults the login shell,
// so resolve it here (field 7 of /etc/passwd), falling back to /bin/sh. `user`
// is posixUserPattern-validated, so it is safe to interpolate.
export function loginShellCommand(user: string): string[] {
  return [
    '/bin/sh',
    '-c',
    `s=$(grep "^${user}:" /etc/passwd | cut -d: -f7); [ -x "$s" ] || s=/bin/sh; exec "$s"`,
  ];
}

interface WorkspaceContext {
  wsName: string;
  containerName: string;
  imageTag: string;
  workspace: Workspace;
  containerProfile: ContainerProfile;
  resources: ResolvedResources;
}

interface BuildPlan {
  dockerfile: string;
  extras: Array<{ name: string; content: string }>;
  buildHash: string;
  hashPath: string;
}

interface MountNotice {
  kind: 'info' | 'warning';
  text: string;
}

interface RuntimeStartPlan {
  volumes: VolumeMount[];
  notices: MountNotice[];
  runtimeHash: string;
  ssh: boolean;
  command: string[];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function hashContent(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readBuildHash(hashPath: string): string | null {
  return fs.existsSync(hashPath)
    ? fs.readFileSync(hashPath, 'utf-8').trim()
    : null;
}

function writeBuildHash(hashPath: string, buildHash: string): void {
  fs.mkdirSync(path.dirname(hashPath), { recursive: true });
  fs.writeFileSync(hashPath, buildHash, 'utf-8');
}

function loadWorkspaceContext(wsName: string): WorkspaceContext {
  ensureInitialised();

  let workspace: Workspace;
  try {
    workspace = loadWorkspace(wsName);
  } catch (error) {
    // Invalid-name, parse, and schema errors carry instructive detail and
    // must surface as-is; only a genuinely missing file gets the "not found"
    // rewrite.
    if (!isValidWorkspaceName(wsName) || workspaceExists(wsName)) {
      throw error;
    }
    throw notFoundWorkspaceError(wsName, listWorkspaces().map((entry) => entry.name));
  }

  const containerProfile = loadContainerProfile(workspace.profile);
  const resources = resolveResources(containerProfile);

  return {
    wsName,
    containerName: containerNameFor(wsName),
    imageTag: imageTagFor(wsName),
    workspace,
    containerProfile,
    resources,
  };
}

function computeBuildPlan(context: WorkspaceContext): BuildPlan {
  const tools = context.workspace.tools ?? [];
  const skipPermissions = context.workspace.agent?.skipPermissions ?? true;
  const agentWraps = skipPermissions ? agentsWithSkipPermissions(tools) : [];
  const agentEnv = agentContainerEnv(tools);
  const claudeManagedSettings = claudeManagedSettingsJson(tools, skipPermissions);
  const projectContainerPaths = resolveProjectVolumes(context.workspace.projects).map((volume) => volume.container);
  const claudeConfig = claudeConfigJson(tools, projectContainerPaths);
  const { dockerfile, extras } = generateDockerfile(context.containerProfile, tools, {
    agentWraps,
    agentEnv,
    claudeManagedSettings,
    claudeConfig,
  });

  const hashInput = dockerfile + extras.map((file) => file.name + file.content).join('');

  return {
    dockerfile,
    extras,
    buildHash: hashContent(hashInput),
    hashPath: getBuildHashPath(context.wsName),
  };
}

function validateProjects(projects: string[]): void {
  for (const projectPath of projects) {
    if (!path.isAbsolute(projectPath)) {
      throw new Error(`Project path must be absolute: ${projectPath}`);
    }
    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }
  }

  const basenames = projects.map((projectPath) => path.basename(projectPath));
  const seen = new Set<string>();
  for (const basename of basenames) {
    if (seen.has(basename)) {
      const colliding = projects.filter((projectPath) => path.basename(projectPath) === basename);
      throw new Error(basenameCollisionMessage(basename, colliding));
    }
    seen.add(basename);
  }
}

function resolveWorkspaceVolumes(
  context: WorkspaceContext,
): { volumes: VolumeMount[]; notices: MountNotice[] } {
  const { workspace, containerProfile, wsName } = context;
  const homeContainer = containerHomeDir(containerProfile.user);
  const volumes = resolveProjectVolumes(workspace.projects);
  const notices: MountNotice[] = [];

  const hostMounts = workspace.host?.mounts ?? [];
  for (const mount of hostMounts) {
    const hostPath = expandTilde(mount.host);
    if (!fs.existsSync(hostPath)) {
      notices.push({ kind: 'warning', text: `Skipping host mount (path does not exist): ${hostPath}` });
      continue;
    }
    if (!fs.statSync(hostPath).isDirectory()) {
      throw new Error(
        `Host mount is a file, not a directory: ${hostPath}\nOnly directory mounts are supported. Edit the workspace config to fix this.`,
      );
    }
    volumes.push({
      host: hostPath,
      container: mount.container,
      readonly: mount.readonly,
    });
  }

  if (workspace.tmux) {
    const tmuxConfigContainer = `${homeContainer}/.config/tmux`;
    const tmuxPluginsContainer = `${homeContainer}/.tmux`;

    const conflictingTmuxConfig = hostMounts.find((mount) => mount.container === tmuxConfigContainer);
    if (conflictingTmuxConfig) {
      notices.push({
        kind: 'warning',
        text: `Warning: workspace.tmux provides ${tmuxConfigContainer}, but host.mounts also mounts ${conflictingTmuxConfig.host} there. workspace.tmux will take precedence.`,
      });
    }
    const conflictingTmuxPlugins = hostMounts.find((mount) => mount.container === tmuxPluginsContainer);
    if (conflictingTmuxPlugins) {
      notices.push({
        kind: 'warning',
        text: `Warning: workspace.tmux provides ${tmuxPluginsContainer}, but host.mounts also mounts ${conflictingTmuxPlugins.host} there. workspace.tmux will take precedence.`,
      });
    }

    if (workspace.tmux.mode === 'host') {
      const hostConfigDir = getHostTmuxConfigDir();
      if (fs.existsSync(hostConfigDir) && fs.statSync(hostConfigDir).isDirectory()) {
        volumes.push({
          host: hostConfigDir,
          container: tmuxConfigContainer,
          readonly: true,
        });
        notices.push({ kind: 'info', text: `tmux host config mounted as ${tmuxConfigContainer}` });
      } else {
        notices.push({ kind: 'warning', text: `Warning: tmux host mode is enabled but ${hostConfigDir} does not exist.` });
      }

      if (workspace.tmux.mountPlugins) {
        const hostPluginsDir = getHostTmuxPluginsDir();
        if (fs.existsSync(hostPluginsDir) && fs.statSync(hostPluginsDir).isDirectory()) {
          volumes.push({
            host: hostPluginsDir,
            container: tmuxPluginsContainer,
            readonly: true,
          });
          notices.push({ kind: 'info', text: `tmux host plugins mounted as ${tmuxPluginsContainer}` });
        } else {
          notices.push({ kind: 'warning', text: `Warning: tmux plugin mount is enabled but ${hostPluginsDir} does not exist.` });
        }
      }
    } else {
      const tmuxDir = ensureWorkspaceTmuxDir(wsName);
      volumes.push({
        host: path.join(tmuxDir, '.config', 'tmux'),
        container: tmuxConfigContainer,
      });
      volumes.push({
        host: path.join(tmuxDir, '.tmux'),
        container: tmuxPluginsContainer,
      });
      notices.push({ kind: 'info', text: `tmux workspace config mounted from ${tmuxDir}` });
    }
  }

  const agentProfiles = workspace.agent?.profiles ?? [];
  if (agentProfiles.length > 0) {
    const resolvedProfiles = validateAgentProfilesForWorkspace(agentProfiles);
    for (const agentProfile of resolvedProfiles) {
      const conflicting = hostMounts.find((mount) => mount.container.endsWith(`/${agentProfile.mount}`));
      if (conflicting) {
        notices.push({
          kind: 'warning',
          text: `Warning: agent profile '${agentProfile.name}' provides ${agentProfile.mount}, but host.mounts also mounts ${conflicting.host} to ${conflicting.container}. The agent profile mount will take precedence.`,
        });
      }

      volumes.push({
        host: agentProfile.hostPath,
        container: `${homeContainer}/${agentProfile.mount}`,
      });
      notices.push({ kind: 'info', text: `Agent profile '${agentProfile.name}' mounted as ~/${agentProfile.mount}` });
    }
  }

  if (workspace.host?.githubCLI) {
    const ghConfigHost = getHostGhConfigDir();
    if (fs.existsSync(ghConfigHost)) {
      volumes.push({
        host: ghConfigHost,
        container: `${homeContainer}/.config/gh`,
        readonly: true,
      });
    }
  }

  return { volumes, notices };
}

export function countSharedDirectories(wsName: string, projects: string[]): number {
  const context = loadWorkspaceContext(wsName);
  const candidate: WorkspaceContext = {
    ...context,
    workspace: { ...context.workspace, projects },
  };
  return countUniqueVolumeSources(resolveWorkspaceVolumes(candidate).volumes);
}

function resolveRuntimeEnv(context: WorkspaceContext): Record<string, string> {
  const resolvedEnv = resolveEnv(context.workspace.host?.env ?? {});
  const githubCLI = context.workspace.host?.githubCLI ?? false;

  if (!githubCLI) {
    return resolvedEnv;
  }

  const ghConfigHost = getHostGhConfigDir();
  if (!fs.existsSync(ghConfigHost)) {
    console.warn(chalk.yellow('Warning: host.githubCLI is enabled but ~/.config/gh does not exist. Run `gh auth login` on the host first.'));
  }

  if (!resolvedEnv['GH_TOKEN']) {
    try {
      const token = execFileSync('gh', ['auth', 'token'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (token) {
        resolvedEnv['GH_TOKEN'] = token;
      }
    } catch {
      // gh not installed on host or not logged in — skip silently
    }
  }

  return resolvedEnv;
}

function computeRuntimeHash(
  context: WorkspaceContext,
  volumes: VolumeMount[],
): string {
  const sortedVolumes = [...volumes]
    .map((volume) => ({
      host: volume.host,
      container: volume.container,
      readonly: volume.readonly === true,
    }))
    .sort((left, right) => {
      const leftKey = `${left.container}\0${left.host}\0${left.readonly}`;
      const rightKey = `${right.container}\0${right.host}\0${right.readonly}`;
      return leftKey.localeCompare(rightKey);
    });

  const hostEnvEntries = Object.entries(context.workspace.host?.env ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }));

  return hashContent(stableStringify({
    volumes: sortedVolumes,
    resources: context.resources,
    sshAgent: context.workspace.host?.sshAgent ?? true,
    githubCLI: context.workspace.host?.githubCLI ?? false,
    hostEnv: hostEnvEntries,
  }));
}

// Deliberately free of logging and subprocess calls: join/refuse paths need
// only the runtime hash for drift detection. Mount notices are emitted — and
// the gh token resolved — only when a start/restart actually uses the plan.
export function computeRuntimeStartPlan(context: WorkspaceContext): RuntimeStartPlan {
  validateProjects(context.workspace.projects);

  const { volumes, notices } = resolveWorkspaceVolumes(context);
  const sharedDirectoryCount = countUniqueVolumeSources(volumes);
  if (sharedDirectoryCount > MAX_SHARED_DIRECTORIES) {
    throw new Error(sharedDirectoryLimitMessage(context.wsName, sharedDirectoryCount));
  }

  return {
    volumes,
    notices,
    runtimeHash: computeRuntimeHash(context, volumes),
    ssh: context.workspace.host?.sshAgent ?? true,
    command: KEEPALIVE_COMMAND,
  };
}

function emitMountNotices(notices: MountNotice[]): void {
  for (const notice of notices) {
    if (notice.kind === 'warning') {
      console.warn(chalk.yellow(notice.text));
    } else {
      console.log(chalk.dim(notice.text));
    }
  }
}

function buildImageFromPlan(context: WorkspaceContext, buildPlan: BuildPlan): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-build-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), buildPlan.dockerfile);
    for (const extra of buildPlan.extras) {
      fs.writeFileSync(path.join(tmpDir, extra.name), extra.content);
    }

    console.log(chalk.blue(`Building image ${context.imageTag}...`));
    buildImage(context.imageTag, tmpDir);
    writeBuildHash(buildPlan.hashPath, buildPlan.buildHash);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// A failed `container build` never retags, so any previous image survives and
// can still run — just with stale config. The real build error already streamed
// to the terminal (buildImage inherits stdio), so we point back to it rather
// than swallow it and re-print a rewritten version.
async function handleBuildFailure(context: WorkspaceContext): Promise<void> {
  const fallback = planBuildFailureFallback({
    imagePresent: imageExists(context.imageTag),
    isInteractive: isInteractiveSession(),
  });

  if (fallback.action === 'abort') {
    const remediation = fallback.reason === 'no-image'
      ? 'There is no previous image to fall back to — fix the build error above and retry.'
      : `Re-run 'pi-tin open ${context.wsName}' interactively to choose whether to use the previous image.`;
    throw new CliError('Image build failed — see the build output above.', EXIT.GENERAL, {
      code: 'build_failed',
      remediation,
    });
  }

  const useExisting = await promptConfirm(
    `Image rebuild failed. Open '${context.wsName}' using the previous image instead?`,
  );
  if (!useExisting) {
    throw new CliError('Image build failed — see the build output above.', EXIT.GENERAL, {
      code: 'build_failed',
    });
  }

  console.warn(chalk.yellow('Warning: running the previous image — your config changes are not applied until the next successful rebuild.'));
}

async function ensureImageBuiltIfNeeded(
  context: WorkspaceContext,
  buildPlan: BuildPlan,
  reasons: { forceBuild: boolean; driftDetected: boolean },
): Promise<void> {
  const plan = planImageBuild({
    forceBuild: reasons.forceBuild,
    driftDetected: reasons.driftDetected,
    previousBuildHash: readBuildHash(buildPlan.hashPath),
    newBuildHash: buildPlan.buildHash,
    imagePresent: imageExists(context.imageTag),
  });

  if (!plan.build) {
    return;
  }

  if (plan.announceConfigChange) {
    console.log(chalk.yellow('⚠ Container profile or workspace config has changed since last build.'));
    console.log(chalk.yellow('  Rebuilding image to apply changes...'));
  }

  try {
    buildImageFromPlan(context, buildPlan);
  } catch {
    await handleBuildFailure(context);
  }
}

function startWorkspaceContainer(options: {
  context: WorkspaceContext;
  runtimePlan: RuntimeStartPlan;
  buildPlan: BuildPlan;
  runtimeEnv: Record<string, string>;
}): void {
  const { context, runtimePlan, buildPlan, runtimeEnv } = options;
  runContainerDetached({
    image: context.imageTag,
    volumes: runtimePlan.volumes,
    name: context.containerName,
    cpus: context.resources.cpus,
    memory: context.resources.memory,
    ssh: runtimePlan.ssh,
    env: runtimeEnv,
    command: runtimePlan.command,
  });

  writeRuntimeMeta(context.wsName, {
    startedAt: new Date().toISOString(),
    buildHash: buildPlan.buildHash,
    runtimeHash: runtimePlan.runtimeHash,
  });
}

function spawnAutoStopHelper(workspaceName: string, deadlineMs: number): number | undefined {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return undefined;
  }

  try {
    const child = spawn(process.execPath, [
      scriptPath,
      AUTO_STOP_COMMAND,
      workspaceName,
      String(deadlineMs),
    ], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });

    child.unref();
    return child.pid ?? undefined;
  } catch {
    return undefined;
  }
}

function readStopTimeout(workspaceName: string, fallback: string): string {
  try {
    return loadWorkspace(workspaceName).stopAfterLastSession;
  } catch {
    return fallback;
  }
}

function setProcessExitCode(result: ExecResult): void {
  if (result.status !== null) {
    process.exitCode = result.status;
    return;
  }

  if (result.signal !== null) {
    const signalNumber = os.constants.signals[result.signal];
    process.exitCode = signalNumber ? 128 + signalNumber : 1;
  }
}

async function finishWorkspaceSession(
  context: WorkspaceContext,
  sessionId: string,
): Promise<string> {
  return await withWorkspaceLock(context.wsName, () => {
    unregisterSession(context.wsName, sessionId);

    const containerState = getContainerState(context.containerName);
    // 'unknown' must never clear runtime state: it may just be a transient
    // `container list` failure while other sessions are still live. Leave
    // everything in place for the next successful invocation to reconcile.
    if (containerState === 'unknown') {
      console.warn(chalk.yellow(`Warning: could not determine the state of workspace '${context.wsName}' — leaving its runtime state in place.`));
      return 'Session closed.';
    }

    if (containerState !== 'running') {
      clearWorkspaceRuntimeState(context.wsName);
      return 'Session closed.';
    }

    const runtime = reconcileWorkspaceRuntimeState(context.wsName);
    if (runtime.runtimeState !== 'ok') {
      return 'Session closed.';
    }

    if (runtime.activeSessions.length > 0) {
      return `Session closed. Active sessions remaining: ${runtime.activeSessions.length}`;
    }

    const timeoutValue = readStopTimeout(context.wsName, context.workspace.stopAfterLastSession);
    const timeoutMs = parseDurationMs(timeoutValue);
    const deadlineMs = Date.now() + timeoutMs;
    const helperPid = spawnAutoStopHelper(context.wsName, deadlineMs);

    armShutdown(context.wsName, {
      armedAt: new Date().toISOString(),
      deadlineMs,
      helperPid,
    });

    if (helperPid === undefined) {
      return `Last session closed. Failed to schedule auto-stop. Stop it manually with 'pi-tin stop ${context.wsName}'.`;
    }

    return `Last session closed. Workspace will stop in ${formatDurationMs(timeoutMs)}.`;
  });
}

export async function openWorkspace(
  wsName: string,
  opts: { build?: boolean; workdir?: string | undefined },
): Promise<void> {
  const context = loadWorkspaceContext(wsName);
  console.log(chalk.green(`Opening workspace: ${wsName}`));

  const buildPlan = computeBuildPlan(context);
  const runtimePlan = computeRuntimeStartPlan(context);
  const sessionId = crypto.randomUUID();

  const opened = await withWorkspaceLock(context.wsName, async () => {
    const runtime = reconcileWorkspaceRuntimeState(context.wsName);
    const containerState = getContainerState(context.containerName);
    const sessionRecord = {
      sessionId,
      startedAt: new Date().toISOString(),
      hostPid: process.pid,
      state: 'active' as const,
    };

    const hasBuildDrift = runtime.meta?.buildHash !== undefined
      ? runtime.meta.buildHash !== buildPlan.buildHash
      : false;
    const hasRuntimeDrift = runtime.meta?.runtimeHash !== undefined
      ? runtime.meta.runtimeHash !== runtimePlan.runtimeHash
      : false;
    const plan = planWorkspaceOpen({
      workspaceName: context.wsName,
      containerState,
      runtimeState: runtime.runtimeState,
      hasRuntimeMeta: runtime.meta !== null,
      activeSessions: runtime.activeSessions.length,
      buildRequested: opts.build === true,
      hasDrift: hasBuildDrift || hasRuntimeDrift,
    });

    switch (plan.action) {
      case 'refuse':
        throw new Error(plan.message);
      case 'start': {
        emitMountNotices(runtimePlan.notices);
        const runtimeEnv = resolveRuntimeEnv(context);
        if (plan.clearStaleRuntimeState) {
          console.warn(chalk.yellow(`Warning: stale runtime state found for workspace '${context.wsName}'. Starting fresh.`));
          clearWorkspaceRuntimeState(context.wsName);
        }
        if (plan.deleteStoppedContainer) {
          try {
            deleteContainer(context.containerName);
          } catch {
            // Best effort only.
          }
        }

        await ensureImageBuiltIfNeeded(context, buildPlan, {
          forceBuild: opts.build === true,
          driftDetected: hasBuildDrift,
        });
        startWorkspaceContainer({ context, runtimePlan, buildPlan, runtimeEnv });
        registerSession(context.wsName, sessionRecord);
        cancelShutdown(context.wsName);
        return { mode: 'started' as const, activeSessions: plan.activeSessionsAfterOpen };
      }
      case 'join':
        if (plan.warnAboutDeferredRestart) {
          console.warn(chalk.yellow(`Warning: workspace changes will apply on the next restart of '${context.wsName}'.`));
        }
        registerSession(context.wsName, sessionRecord);
        cancelShutdown(context.wsName);
        return { mode: 'joined' as const, activeSessions: plan.activeSessionsAfterOpen };
      case 'restart': {
        emitMountNotices(runtimePlan.notices);
        const runtimeEnv = resolveRuntimeEnv(context);
        await stopAndRemoveContainer(context.containerName);
        clearWorkspaceRuntimeState(context.wsName);
        await ensureImageBuiltIfNeeded(context, buildPlan, {
          forceBuild: opts.build === true,
          driftDetected: hasBuildDrift,
        });
        startWorkspaceContainer({ context, runtimePlan, buildPlan, runtimeEnv });
        registerSession(context.wsName, sessionRecord);
        cancelShutdown(context.wsName);
        return { mode: 'started' as const, activeSessions: plan.activeSessionsAfterOpen };
      }
    }
  });

  if (opened.mode === 'started') {
    console.log(chalk.green(`Started workspace '${context.wsName}'`));
  } else {
    console.log(chalk.green(`Joining existing workspace '${context.wsName}'`));
  }
  console.log(`Active sessions: ${opened.activeSessions}`);

  let execResult: ExecResult | null = null;
  try {
    execResult = execContainer({
      name: context.containerName,
      command: loginShellCommand(context.containerProfile.user),
      workdir: opts.workdir,
      user: context.containerProfile.user,
    });
  } finally {
    const exitMessage = await finishWorkspaceSession(context, sessionId);
    console.log(exitMessage);
  }

  if (execResult !== null) {
    setProcessExitCode(execResult);
  }
}
