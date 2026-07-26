import chalk from 'chalk';
import { confirm, input, select } from '@inquirer/prompts';
import { dotDirsLabel } from '../lib/agents.js';
import { ensureInitialised } from '../lib/init-guard.js';
import { createAgentProfile, listAgentProfiles } from '../lib/agent-profiles.js';
import type { AgentProfileMode } from '../lib/agent-profiles.js';
import { withExitHandling } from '../lib/exit-handling.js';
import { ensureInteractive } from '../lib/confirmation.js';
import {
  agentProfileNameError,
  findConfiguredAgents,
  planDiscoveredAgentProfile,
} from '../lib/agent-discovery.js';
import type { DiscoveredAgentPlan } from '../lib/agent-discovery.js';

export async function runAgentProfileDiscover(): Promise<void> {
  ensureInteractive({
    action: "run 'agent-profile discover'",
    remediation: 'Create agent profiles directly: `pi-tin agent-profile add <name> --agent <agent>`.',
  });

  const foundAgents = findConfiguredAgents();

  if (foundAgents.length === 0) {
    console.log('No known agent configurations found on your system.');
    console.log(`You can create agent profiles manually with ${chalk.cyan('pi-tin agent-profile add <name> --agent <agent>')}`);
    return;
  }

  console.log('Found agents on your system:\n');
  for (const agent of foundAgents) {
    console.log(`  ${agent.name} (${dotDirsLabel(agent)})`);
  }
  console.log('');

  let takenNames: readonly string[] = listAgentProfiles().map((p) => p.name);

  for (const agent of foundAgents) {
    const shouldCreate = await confirm({
      message: `Create agent profile for ${agent.name}?`,
      default: true,
    });

    if (!shouldCreate) continue;

    // Planned per agent, not up front, so the suggested name accounts for
    // profiles created earlier in this same run.
    const plan = planDiscoveredAgentProfile({ agent, existingProfileNames: takenNames });
    const mode = await promptAgentProfileMode(plan);

    const name = await input({
      message: '  Name:',
      default: plan.suggestedName,
      validate: (value) => agentProfileNameError({ value, existingProfileNames: takenNames }) ?? true,
    });

    try {
      const profileDir = createAgentProfile(name.trim(), agent.name, mode);
      takenNames = [...takenNames, name.trim()];
      console.log(chalk.green(`  \u2714 Created '${name.trim()}' (${mode}) at ${profileDir}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`  Failed to create agent profile: ${message}`));
    }
    console.log('');
  }
}

async function promptAgentProfileMode(plan: DiscoveredAgentPlan): Promise<AgentProfileMode> {
  switch (plan.mode) {
    case 'isolated':
      console.log('');
      console.log(chalk.dim(plan.isolatedOnlyNote));
      return 'isolated';
    case 'select':
      if (plan.hostModeNote) {
        console.log('');
        console.log(chalk.yellow(plan.hostModeNote));
      }
      console.log('');
      return select({
        message: 'How would you like to use this configuration?',
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
  }
}

export function registerAgentProfileDiscoverCommand(
  agentProfileCmd: import('commander').Command,
): void {
  agentProfileCmd
    .command('discover')
    .description('Scan for agents on your system and create agent profiles')
    .action(async () => {
      ensureInitialised();
      await withExitHandling(async () => {
        await runAgentProfileDiscover();
      });
    });
}
