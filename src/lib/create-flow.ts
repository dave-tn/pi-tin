import path from 'node:path';
import { defaultProfileNameFor } from './agents.js';
import type { KnownAgent } from './agents.js';
import type { AgentProfileEntry } from './agent-profiles.js';
import type { HostMount, Tool, Workspace } from './validators.js';

/**
 * Pure decision-shaping for the interactive `create` flow. The inquirer
 * prompts live in src/commands/create.ts; everything here is plain data in,
 * plain data out, so it can be unit-tested without prompt mocking.
 */

export interface Choice<T> {
  name: string;
  value: T;
}

export type AgentProfileSummary = Pick<AgentProfileEntry, 'name' | 'mode' | 'mounts'>;

export type AgentProfileChoice =
  // existingProfileName is the host-mode profile hidden from the menu and
  // reused silently when set; otherwise picking 'use-host' creates one.
  | { kind: 'use-host'; existingProfileName: string | undefined }
  | { kind: 'create-new' }
  | { kind: 'existing'; profileName: string };

export type AgentProfilePlan =
  | { action: 'create-default' }
  | { action: 'choose'; choices: Choice<AgentProfileChoice>[] };

/** Name for the host-mode profile auto-created when the user picks 'use host config'. */
export function hostProfileNameFor(agent: Pick<KnownAgent, 'name'>): string {
  return `${defaultProfileNameFor(agent)}-host`;
}

export function planAgentProfileSelection(
  agent: Pick<KnownAgent, 'dotDirs'>,
  allProfiles: ReadonlyArray<AgentProfileSummary>,
  hostConfigExists: boolean,
): AgentProfilePlan {
  const agentProfiles = allProfiles.filter((p) =>
    p.mounts.some((m) => agent.dotDirs.includes(m)),
  );
  const hostProfile = agentProfiles.find((p) => p.mode === 'host');
  const visibleProfiles = agentProfiles.filter((p) => p.mode !== 'host');

  if (visibleProfiles.length === 0 && !hostConfigExists) {
    return { action: 'create-default' };
  }

  const choices: Choice<AgentProfileChoice>[] = [];

  if (hostConfigExists) {
    const dirs = agent.dotDirs.map((d) => `~/${d}`).join(', ');
    choices.push({
      name: `Use host config (${dirs}) [host]`,
      value: { kind: 'use-host', existingProfileName: hostProfile?.name },
    });
  }

  for (const p of visibleProfiles) {
    choices.push({ name: `${p.name} [${p.mode}]`, value: { kind: 'existing', profileName: p.name } });
  }

  choices.push({ name: 'Create new...', value: { kind: 'create-new' } });

  return { action: 'choose', choices };
}

export function gitIdentityLabel(gitName: string | undefined, gitEmail: string | undefined): string {
  return [gitName, gitEmail].filter(Boolean).join(', ');
}

export function gitIdentityEnv(gitName: string | undefined, gitEmail: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (gitName) {
    env['GIT_AUTHOR_NAME'] = gitName;
    env['GIT_COMMITTER_NAME'] = gitName;
  }
  if (gitEmail) {
    env['GIT_AUTHOR_EMAIL'] = gitEmail;
    env['GIT_COMMITTER_EMAIL'] = gitEmail;
  }
  return env;
}

const COMMON_API_KEY_VARS = [
  { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key' },
  { name: 'OPENAI_API_KEY', label: 'OpenAI API key' },
  { name: 'OPENROUTER_API_KEY', label: 'OpenRouter API key' },
] as const;

export function availableApiKeyVars(
  hostEnv: Record<string, string | undefined>,
): Array<{ name: string; label: string }> {
  return COMMON_API_KEY_VARS.filter((v) => hostEnv[v.name]);
}

/** Forward host env vars by reference (`${VAR}` syntax) so values stay on the host. */
export function forwardedEnv(varNames: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const varName of varNames) {
    env[varName] = `\${${varName}}`;
  }
  return env;
}

/**
 * Extract the IANA timezone name from a resolved `/etc/localtime` target.
 * The path points into the zoneinfo tree (e.g.
 * `/var/db/timezone/zoneinfo/America/New_York` on macOS,
 * `/usr/share/zoneinfo/Europe/London` on Linux); the name is everything after
 * the `zoneinfo` (or `zoneinfo.default`) directory. Returns undefined when the
 * path is not a zoneinfo path or the name has unexpected characters.
 */
export function parseTimezoneFromLocaltimePath(target: string): string | undefined {
  const match = /\/zoneinfo(?:\.default)?\/(.+)$/.exec(target);
  const zone = match?.[1];
  if (zone === undefined) {
    return undefined;
  }
  return /^[A-Za-z0-9._+/-]+$/.test(zone) ? zone : undefined;
}

/** Env fragment seeding the container timezone; empty when the zone is unknown. */
export function timezoneEnv(timezone: string | undefined): Record<string, string> {
  return timezone ? { TZ: timezone } : {};
}

export type TmuxModeValue = 'host' | 'isolated' | 'none';

export function tmuxModeChoices(
  hostConfigAvailable: boolean,
): Choice<TmuxModeValue>[] {
  const choices: Choice<TmuxModeValue>[] = [
    { name: 'Create isolated persistent tmux config for this workspace [isolated]', value: 'isolated' },
    { name: 'No tmux config', value: 'none' },
  ];

  if (hostConfigAvailable) {
    choices.unshift({
      name: 'Use host tmux config (~/.config/tmux) [host, read-only]',
      value: 'host',
    });
  }

  return choices;
}

export function commonMountChoices(
  homeContainer: string,
): Choice<HostMount>[] {
  return [
    { name: '~/.gnupg (GPG keys, read-only)', value: { host: '~/.gnupg', container: `${homeContainer}/.gnupg`, readonly: true } },
    { name: '~/.aws (AWS credentials, read-only)', value: { host: '~/.aws', container: `${homeContainer}/.aws`, readonly: true } },
  ];
}

/** Default container path for a custom mount, mirroring `~` onto the container home. */
export function defaultContainerPath(hostPath: string, homeContainer: string): string {
  if (hostPath.startsWith('~/')) {
    return `${homeContainer}/${hostPath.slice(2)}`;
  }
  if (hostPath === '~') {
    return homeContainer;
  }
  return hostPath;
}

export function buildWorkspace(options: {
  containerProfileName: string;
  parentDir: string;
  projectNames: string[];
  tools: Tool[];
  agentProfileNames: string[];
  githubCLI: boolean;
  hostMounts: HostMount[];
  env: Record<string, string>;
  tmux: Workspace['tmux'] | undefined;
}): Workspace {
  return {
    profile: options.containerProfileName,
    projects: options.projectNames.map((p) => path.join(options.parentDir, p)),
    tools: options.tools,
    agent: {
      skipPermissions: true,
      profiles: options.agentProfileNames,
    },
    host: {
      sshAgent: true,
      githubCLI: options.githubCLI,
      mounts: options.hostMounts,
      env: options.env,
    },
    sshd: false,
    attach: 'shell',
    stopAfterLastSession: '30s',
    ...(options.tmux ? { tmux: options.tmux } : {}),
  };
}
