import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { select, checkbox, confirm, input } from '@inquirer/prompts';
import { containerHomeDir, expandTilde, getWorkspacesDir, findProjectRoot, isSafePathSegment, SAFE_PATH_SEGMENT_RULE } from '../lib/paths.js';
import { ensureInitialised } from '../lib/init-guard.js';
import { listContainerProfiles, loadContainerProfile } from '../lib/profiles.js';
import { workspaceExists, writeWorkspace, isValidWorkspaceName, invalidWorkspaceNameMessage, WORKSPACE_NAME_RULE } from '../lib/workspaces.js';
import type { HostMount, ContainerProfile, Tool, Workspace } from '../lib/validators.js';
import { KNOWN_AGENTS, defaultProfileNameFor, toolDisplayName, toWorkspaceTool } from '../lib/agents.js';
import type { KnownAgent } from '../lib/agents.js';
import { listAgentProfiles, createAgentProfile } from '../lib/agent-profiles.js';
import {
  ensureWorkspaceTmuxDir,
  getHostTmuxConfigPath,
  hostTmuxConfigExists,
  hostTmuxConfigUsesPluginsDir,
  hostTmuxPluginsDirExists,
  legacyHostTmuxConfigExists,
  moveLegacyHostTmuxConfig,
} from '../lib/tmux.js';
import { withExitHandling } from '../lib/exit-handling.js';
import {
  availableApiKeyVars,
  buildWorkspace,
  commonMountChoices,
  defaultContainerPath,
  forwardedEnv,
  gitIdentityEnv,
  gitIdentityLabel,
  hostProfileNameFor,
  planAgentProfileSelection,
  timezoneEnv,
  tmuxModeChoices,
} from '../lib/create-flow.js';
import { getGitConfig, detectHostTimezone } from '../lib/host-detect.js';

async function promptWorkspaceName(nameArg: string | undefined): Promise<string> {
  if (nameArg !== undefined) {
    if (!isValidWorkspaceName(nameArg)) {
      console.error(chalk.red(invalidWorkspaceNameMessage(nameArg)));
      process.exit(1);
    }
    if (workspaceExists(nameArg)) {
      console.error(
        chalk.red(`Workspace '${nameArg}' already exists.`),
      );
      process.exit(1);
    }
    return nameArg;
  }

  const name = await input({
    message: 'Workspace name:',
    validate: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return 'Name is required';
      if (!isValidWorkspaceName(trimmed)) return WORKSPACE_NAME_RULE;
      if (workspaceExists(trimmed)) return `Workspace '${trimmed}' already exists`;
      return true;
    },
  });
  return name.trim();
}

type ContainerProfileResult = { containerProfileName: string; containerProfile: ContainerProfile };

async function promptContainerProfile(): Promise<ContainerProfileResult> {
  const profiles = listContainerProfiles();
  if (profiles.length === 0) {
    console.error(
      chalk.red('No container profiles found. Add one to ~/.config/pi-tin/profiles/'),
    );
    process.exit(1);
  }

  let containerProfileName: string;
  if (profiles.length === 1) {
    const onlyProfile = profiles[0];
    if (!onlyProfile) {
      throw new Error('Expected one available container profile.');
    }
    containerProfileName = onlyProfile;
  } else {
    containerProfileName = await select({
      message: 'Select a container profile:',
      choices: profiles.map((p) => ({ name: p, value: p })),
    });
  }

  const containerProfile = loadContainerProfile(containerProfileName);
  const toolNames = containerProfile.global_tools.map(toolDisplayName);

  console.log('');
  console.log(`${chalk.bold('Container profile:')} ${containerProfileName}`);
  if (containerProfile.description) {
    console.log(`  ${chalk.dim(containerProfile.description)}`);
  }
  console.log(`  ${chalk.dim('Image:')}  ${containerProfile.base_image}`);
  if (toolNames.length > 0) {
    console.log(`  ${chalk.dim('Tools:')}  ${toolNames.join(', ')}`);
  }
  console.log('');

  const useProfile = await confirm({
    message: `Use container profile '${containerProfileName}'?`,
    default: true,
  });
  if (!useProfile) {
    console.log(
      chalk.dim(`To create a custom container profile, see ${PKG_HOMEPAGE}#profiles`),
    );
    process.exit(0);
  }

  return { containerProfileName, containerProfile };
}

async function promptProjects(): Promise<{ parentDir: string; projectNames: string[] }> {
  const projectRoot = findProjectRoot(process.cwd());
  const parentDir = path.dirname(projectRoot);

  const folders = fs
    .readdirSync(parentDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();

  if (folders.length === 0) {
    console.error(
      chalk.red(`No project folders found in ${parentDir}`),
    );
    process.exit(1);
  }

  const projectRootName = path.basename(projectRoot);

  const selectedProjects = await checkbox({
    message: `Select projects to include from ${parentDir} (space to toggle, enter to confirm):`,
    choices: folders.map((f) => ({
      name: f,
      value: f,
      checked: f === projectRootName,
    })),
    required: true,
  });

  if (selectedProjects.length === 0) {
    console.error(chalk.red('No projects selected.'));
    process.exit(1);
  }

  return { parentDir, projectNames: selectedProjects };
}

async function promptAndCreateAgentProfile(agent: KnownAgent): Promise<string> {
  const profileName = await input({
    message: `${agent.name} — agent profile name:`,
    default: defaultProfileNameFor(agent),
    validate: (value) => {
      if (value.trim().length === 0) return 'Name is required';
      if (!isSafePathSegment(value.trim())) return SAFE_PATH_SEGMENT_RULE;
      const existing = listAgentProfiles();
      if (existing.some((p) => p.name === value.trim())) {
        return `Agent profile '${value.trim()}' already exists`;
      }
      return true;
    },
  });

  const name = profileName.trim();
  createAgentProfile(name, agent.name, 'isolated');
  console.log(chalk.green(`  ✔ Created agent profile '${name}'`));
  return name;
}

// Check if host config exists for host-capable agents
function hostAgentConfigExists(agent: KnownAgent): boolean {
  return (
    agent.hostModeSupported &&
    agent.dotDirs.every((dir) => {
      const dotPath = path.join(os.homedir(), dir);
      return fs.existsSync(dotPath) && fs.statSync(dotPath).isDirectory();
    })
  );
}

async function promptAgentProfile(agent: KnownAgent): Promise<string> {
  const plan = planAgentProfileSelection(agent, listAgentProfiles(), hostAgentConfigExists(agent));

  if (plan.action === 'create-default') {
    return promptAndCreateAgentProfile(agent);
  }

  const chosen = await select({
    message: `${agent.name} — select agent profile:`,
    choices: plan.choices,
  });

  if (chosen.kind === 'use-host') {
    if (agent.hostModeWarning) {
      console.log(chalk.yellow(`  Note: ${agent.hostModeWarning}`));
    }
    if (chosen.existingProfileName !== undefined) {
      return chosen.existingProfileName;
    }
    const name = hostProfileNameFor(agent);
    createAgentProfile(name, agent.name, 'host');
    console.log(chalk.green(`  ✔ Created host agent profile '${name}'`));
    return name;
  }

  if (chosen.kind === 'create-new') {
    return promptAndCreateAgentProfile(agent);
  }

  return chosen.profileName;
}

async function promptAgents(): Promise<{ tools: Tool[]; agentProfileNames: string[] }> {
  const selectedAgents = await checkbox({
    message: 'Select coding agents (space to toggle, enter to confirm):',
    choices: KNOWN_AGENTS.map((agent) => ({
      name: `${agent.name} (${agent.package.replace(/@latest$/, '')})`,
      value: agent,
    })),
  });

  const tools: Tool[] = selectedAgents.map(toWorkspaceTool);
  const agentProfileNames: string[] = [];

  if (selectedAgents.length > 0) {
    console.log('');
    console.log(chalk.dim('Agent profiles store configuration and credentials across workspaces'));
    console.log('');

    for (const agent of selectedAgents) {
      agentProfileNames.push(await promptAgentProfile(agent));
    }
  }

  return { tools, agentProfileNames };
}

async function promptGitIdentityEnv(): Promise<Record<string, string>> {
  const gitName = getGitConfig('user.name');
  const gitEmail = getGitConfig('user.email');

  if (!gitName && !gitEmail) {
    return {};
  }

  const useGit = await confirm({
    message: `Use git config from host? (${gitIdentityLabel(gitName, gitEmail)})`,
    default: true,
  });

  return useGit ? gitIdentityEnv(gitName, gitEmail) : {};
}

// Offer to forward common API key env vars
async function promptApiKeyEnv(): Promise<Record<string, string>> {
  const commonEnvVars = availableApiKeyVars(process.env);
  if (commonEnvVars.length === 0) {
    return {};
  }

  const selectedVars = await checkbox({
    message: 'Forward API keys from host? (uses ${VAR} syntax — keys stay on host):',
    choices: commonEnvVars.map((v) => ({
      name: `${v.label} (${v.name})`,
      value: v.name,
      checked: true,
    })),
  });
  return forwardedEnv(selectedVars);
}

async function promptGithubCLI(): Promise<boolean> {
  return confirm({
    message: 'Enable GitHub CLI inside workspace? (mounts ~/.config/gh, forwards GH_TOKEN)',
    default: true,
  });
}

/**
 * Host mode needs ~/.config/tmux/tmux.conf. When only the legacy ~/.tmux.conf
 * exists, offer to move it. Returns false when the user declines (so the
 * caller re-prompts for a mode).
 */
async function ensureHostTmuxConfigReady(): Promise<boolean> {
  if (hostTmuxConfigExists()) {
    return true;
  }

  const legacyPath = path.join(os.homedir(), '.tmux.conf');
  const moveLegacyConfig = await confirm({
    message: `Move ${legacyPath} to ${getHostTmuxConfigPath()} now?`,
    default: true,
  });

  if (!moveLegacyConfig) {
    console.log(chalk.yellow('Host tmux config was not moved. Choose isolated mode instead, or move it later.'));
    console.log('');
    return false;
  }

  const destination = moveLegacyHostTmuxConfig();
  console.log(chalk.green(`  ✔ Moved tmux config to ${destination}`));
  return true;
}

async function promptHostTmuxPlugins(): Promise<boolean> {
  if (!(hostTmuxConfigUsesPluginsDir() && hostTmuxPluginsDirExists())) {
    return false;
  }
  return confirm({
    message: 'Mount ~/.tmux read-only too? Useful for TPM/plugins referenced by ~/.config/tmux/tmux.conf.',
    default: true,
  });
}

interface TmuxSelection {
  tmux: Workspace['tmux'] | undefined;
  tmuxProfileDir: string | undefined;
}

async function promptTmux(workspaceName: string): Promise<TmuxSelection> {
  const none: TmuxSelection = { tmux: undefined, tmuxProfileDir: undefined };

  // tmux support is not release-ready: keep it out of the interactive flow and
  // out of the README for now. Returning early hides the question and defaults
  // to no tmux config; the implementation below is intact for re-enabling.
  return none;

  const useTmux = await confirm({
    message: 'Configure tmux for this workspace?',
    default: false,
  });
  if (!useTmux) {
    return none;
  }

  console.log('');
  console.log(chalk.dim('tmux can use your host config read-only or an isolated persistent workspace config'));
  console.log('');

  for (;;) {
    const tmuxMode = await select({
      message: 'tmux config mode:',
      choices: tmuxModeChoices(hostTmuxConfigExists() || legacyHostTmuxConfigExists()),
    });

    if (tmuxMode === 'none') {
      return none;
    }

    if (tmuxMode === 'host') {
      if (!(await ensureHostTmuxConfigReady())) {
        continue;
      }
      const mountPlugins = await promptHostTmuxPlugins();
      return { tmux: { mode: 'host', mountPlugins }, tmuxProfileDir: undefined };
    }

    return {
      tmux: { mode: 'isolated', mountPlugins: false },
      tmuxProfileDir: ensureWorkspaceTmuxDir(workspaceName),
    };
  }
}

async function promptCustomMount(homeContainer: string): Promise<HostMount | undefined> {
  const hostPath = await input({ message: 'Host path (must be a directory):' });

  const expanded = expandTilde(hostPath);

  if (fs.existsSync(expanded) && !fs.statSync(expanded).isDirectory()) {
    console.log(chalk.red(`'${hostPath}' is a file. Only directory mounts are supported.`));
    return undefined;
  }

  const containerPath = await input({
    message: 'Container path:',
    default: defaultContainerPath(hostPath, homeContainer),
  });
  const readOnly = await confirm({
    message: 'Read-only?',
    default: false,
  });
  return { host: hostPath, container: containerPath, readonly: readOnly };
}

async function promptHostMounts(homeContainer: string): Promise<HostMount[]> {
  const hostMounts: HostMount[] = [];

  console.log(chalk.dim('Host mounts share directories from your Mac into the workspace.'));

  const selectedMounts = await checkbox({
    message: 'Select common host mounts (space to toggle):',
    choices: commonMountChoices(homeContainer),
  });

  hostMounts.push(...selectedMounts);

  // Custom mounts
  let addCustom = await confirm({
    message: 'Add a custom host mount?',
    default: false,
  });

  while (addCustom) {
    const mount = await promptCustomMount(homeContainer);

    if (mount === undefined) {
      addCustom = await confirm({
        message: 'Try another mount?',
        default: true,
      });
      continue;
    }

    hostMounts.push(mount);
    addCustom = await confirm({
      message: 'Add another custom mount?',
      default: false,
    });
  }

  return hostMounts;
}

function printSummary(name: string, tmuxProfileDir: string | undefined): void {
  const wsPath = path.join(getWorkspacesDir(), `${name}.yaml`);
  console.log('');
  console.log(chalk.green(`✔ Created workspace '${name}'`));
  console.log('');
  console.log(`  Open:    ${chalk.cyan('pi-tin')} (from a project directory) or ${chalk.cyan(`pi-tin open ${name}`)}`);
  console.log(`  Config:  ${chalk.dim(wsPath)}`);
  if (tmuxProfileDir) {
    console.log(`  tmux:    ${chalk.dim(tmuxProfileDir)}`);
  }
}

export async function runCreateFlow(nameArg?: string): Promise<void> {
  ensureInitialised();

  await withExitHandling(async () => {
    const name = await promptWorkspaceName(nameArg);
    const { containerProfileName, containerProfile } = await promptContainerProfile();
    const { parentDir, projectNames } = await promptProjects();
    const { tools, agentProfileNames } = await promptAgents();

    // Environment variables — seeded with host terminal color support and timezone
    const gitEnv = await promptGitIdentityEnv();
    const apiKeyEnv = await promptApiKeyEnv();
    const timezone = detectHostTimezone();
    if (timezone === undefined) {
      console.log(
        chalk.dim('Could not detect host timezone; workspace will use UTC. Set host.env.TZ to override.'),
      );
    }
    const env: Record<string, string> = {
      COLORTERM: '${COLORTERM}',
      ...timezoneEnv(timezone),
      ...gitEnv,
      ...apiKeyEnv,
    };

    // GitHub CLI integration
    const githubCLI = await promptGithubCLI();

    const { tmux, tmuxProfileDir } = await promptTmux(name);

    const homeContainer = containerHomeDir(containerProfile.user);
    const hostMounts = await promptHostMounts(homeContainer);

    const workspace = buildWorkspace({
      containerProfileName,
      parentDir,
      projectNames,
      tools,
      agentProfileNames,
      githubCLI,
      hostMounts,
      env,
      tmux,
    });

    writeWorkspace(name, workspace);
    printSummary(name, tmuxProfileDir);
  });
}

export function registerCreateCommand(
  program: import('commander').Command,
): void {
  program
    .command('create [name]')
    .description('Create a new workspace')
    .action(async (name: string | undefined) => {
      await runCreateFlow(name);
    });
}
