import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { confirm, input, select } from '@inquirer/prompts';
import { ensureInitialised } from '../lib/init-guard.js';
import { isSafePathSegment, SAFE_PATH_SEGMENT_RULE } from '../lib/paths.js';
import { createAgentProfile, listAgentProfiles } from '../lib/agent-profiles.js';
import type { AgentProfileMode } from '../lib/agent-profiles.js';
import { withExitHandling } from '../lib/exit-handling.js';
import { KNOWN_AGENTS, defaultProfileNameFor } from '../lib/agents.js';

export async function runAgentProfileDiscover(): Promise<void> {
  const home = os.homedir();

  // Find agents with existing dot-directories on the host
  const foundAgents = KNOWN_AGENTS.filter((agent) => {
    return agent.dotDirs.some((dir) => {
      const dotPath = path.join(home, dir);
      return fs.existsSync(dotPath) && fs.statSync(dotPath).isDirectory();
    });
  });

  if (foundAgents.length === 0) {
    console.log('No known agent configurations found on your system.');
    console.log(`You can create profiles manually with ${chalk.cyan('pi-tin agent-profile add <name> --agent <agent>')}`);
    return;
  }

  console.log('Found agents on your system:\n');
  for (const agent of foundAgents) {
    const dirs = agent.dotDirs.map((d) => `~/${d}`).join(', ');
    console.log(`  ${agent.name} (${dirs})`);
  }
  console.log('');

  const existingProfiles = listAgentProfiles();

  for (const agent of foundAgents) {
    const shouldCreate = await confirm({
      message: `Create agent profile for ${agent.name}?`,
      default: true,
    });

    if (!shouldCreate) continue;

    // Determine mode
    let mode: AgentProfileMode = 'isolated';

    if (agent.hostModeSupported) {
      if (agent.hostModeWarning) {
        console.log('');
        console.log(chalk.yellow(`Note: ${agent.hostModeWarning}`));
      }

      console.log('');
      mode = await select({
        message: `How would you like to use this configuration?`,
        choices: [
          {
            name: `Host     — Mount your host config directly into containers.\n` +
              `             Host and container share the same config.\n` +
              `             Changes in the container affect your host.`,
            value: 'host' as const,
          },
          {
            name: `Isolated — Create a separate copy for containers.\n` +
              `             Starts empty, configured independently.\n` +
              `             Host config is not affected.`,
            value: 'isolated' as const,
          },
        ],
      });
    } else {
      console.log('');
      console.log(
        chalk.dim(
          `  ${agent.name} uses macOS Keychain for auth, which isn't available\n` +
          `  in containers. Creating as isolated profile.`,
        ),
      );
    }

    const defaultName = defaultProfileNameFor(agent);
    const nameTaken = existingProfiles.some((p) => p.name === defaultName);
    const suggestedName = nameTaken ? `${defaultName}-2` : defaultName;

    const name = await input({
      message: '  Name:',
      default: suggestedName,
      validate: (value) => {
        if (value.trim().length === 0) return 'Name is required';
        if (!isSafePathSegment(value.trim())) return SAFE_PATH_SEGMENT_RULE;
        if (existingProfiles.some((p) => p.name === value.trim())) {
          return `Agent profile '${value.trim()}' already exists`;
        }
        return true;
      },
    });

    try {
      const profileDir = createAgentProfile(name.trim(), agent.name, mode);
      existingProfiles.push({
        name: name.trim(),
        agent: agent.name,
        mode,
        mounts: [...agent.dotDirs],
      });
      console.log(chalk.green(`  \u2714 Created '${name.trim()}' (${mode}) at ${profileDir}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`  Failed to create profile: ${message}`));
    }
    console.log('');
  }
}

export function registerAgentProfileDiscoverCommand(
  agentProfileCmd: import('commander').Command,
): void {
  agentProfileCmd
    .command('discover')
    .description('Scan for agents on your system and create profiles')
    .action(async () => {
      ensureInitialised();
      await withExitHandling(async () => {
        await runAgentProfileDiscover();
      });
    });
}
