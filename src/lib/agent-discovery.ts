import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultProfileNameFor } from './agents.js';
import type { KnownAgent } from './agents.js';
import { isSafePathSegment, SAFE_PATH_SEGMENT_RULE } from './paths.js';

/**
 * Decision logic for `agent-profile discover`. The prompts, chalk and profile
 * creation live in src/commands/agent-profile-discover.ts; everything here is
 * plain data in, plain data out — except the host scan, which takes an
 * injectable home so it is testable against a temp dir.
 */

/** Agents from `agents` with at least one of their dot-directories under `home`. */
export function findConfiguredAgents(
  agents: readonly KnownAgent[],
  home: string = os.homedir(),
): KnownAgent[] {
  // `some`, not `every`: any dot-dir is enough signal that the agent is
  // configured here. Host-mode mounting asks a different question — it needs
  // every dir to exist — and answers it separately in create.ts.
  return agents.filter((agent) =>
    agent.dot_dirs.some((dir) => isExistingDirectory(path.join(home, dir))),
  );
}

// One stat rather than existsSync + statSync: the path can vanish between the
// two calls, and an unreadable parent throws EACCES either way. A stat that
// fails tells us nothing about the agent, so it counts as not-configured — a
// throw here would abort the whole scan over one unreadable dot-dir.
function isExistingDirectory(dotPath: string): boolean {
  try {
    return fs.statSync(dotPath).isDirectory();
  } catch {
    return false;
  }
}

export type DiscoveredAgentPlan =
  | {
    mode: 'select';
    suggestedName: string;
    // Caveat about the agent's host-mode credential storage, when it has one.
    hostModeNote: string | undefined;
  }
  | {
    mode: 'isolated';
    suggestedName: string;
    isolatedOnlyNote: string;
  };

/** Whether the user is offered a host/isolated choice, and the name to pre-fill. */
export function planDiscoveredAgentProfile(options: {
  agent: Pick<KnownAgent, 'name' | 'host_mode_supported' | 'host_mode_warning'>;
  existingProfileNames: readonly string[];
}): DiscoveredAgentPlan {
  const { agent, existingProfileNames } = options;
  const suggestedName = suggestAgentProfileName(defaultProfileNameFor(agent), existingProfileNames);

  if (agent.host_mode_supported) {
    return {
      mode: 'select',
      suggestedName,
      hostModeNote: agent.host_mode_warning ? `Note: ${agent.host_mode_warning}` : undefined,
    };
  }

  return {
    mode: 'isolated',
    suggestedName,
    // States the refusal, not a rationale: a custom definition may set
    // host_mode_supported: false for reasons of its own.
    isolatedOnlyNote:
      `  ${agent.name} does not support host mode. Creating as isolated\n` +
      `  agent profile.`,
  };
}

/** Rejection message for a proposed agent-profile name, or undefined when it is valid. */
export function agentProfileNameError(options: {
  value: string;
  existingProfileNames: readonly string[];
}): string | undefined {
  const name = options.value.trim();
  if (name.length === 0) return 'Name is required';
  if (!isSafePathSegment(name)) return SAFE_PATH_SEGMENT_RULE;
  if (options.existingProfileNames.includes(name)) {
    return `Agent profile '${name}' already exists`;
  }
  return undefined;
}

function suggestAgentProfileName(defaultName: string, taken: readonly string[]): string {
  if (!taken.includes(defaultName)) return defaultName;
  // Count up rather than stopping at -2: a single-shot suffix pre-fills the
  // prompt with a name its own validator then rejects, once -2 is taken too.
  let suffix = 2;
  while (taken.includes(`${defaultName}-${suffix}`)) suffix += 1;
  return `${defaultName}-${suffix}`;
}
