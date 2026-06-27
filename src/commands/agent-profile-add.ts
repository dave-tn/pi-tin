import chalk from 'chalk';
import { ensureInitialised } from '../lib/init-guard.js';
import { createAgentProfile } from '../lib/agent-profiles.js';
import { KNOWN_AGENTS } from '../lib/agents.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

export function registerAgentProfileAddCommand(
  agentProfileCmd: import('commander').Command,
): void {
  agentProfileCmd
    .command('add <name>')
    .description('Create a new agent profile')
    .requiredOption('--agent <agent>', `Agent name (${KNOWN_AGENTS.map((a) => a.name).join(', ')})`)
    .option('--host', 'Mount host config directly instead of creating an isolated copy')
    .action((name: string, opts: { agent: string; host?: boolean }) => {
      ensureInitialised();

      const mode = opts.host ? 'host' : 'isolated';

      try {
        const profileDir = createAgentProfile(name, opts.agent, mode);
        console.log(chalk.green(`\u2714 Created agent profile '${name}' for ${opts.agent} (${mode})`));
        console.log('');
        console.log(`  Agent profile directory: ${chalk.dim(profileDir)}`);
        console.log('');

        if (mode === 'host') {
          console.log(`  This profile mounts your host config directly into containers.`);
          console.log(`  Changes inside the container will affect your host configuration.`);
        } else {
          console.log(
            `  You'll need to log in the first time you open a workspace using this profile.`,
          );
          console.log(`  After that, your session persists across workspace restarts.`);
          console.log('');
          console.log(
            `  To add custom config (skills, MCP servers, etc.), copy files into the profile directory.`,
          );
          console.log(`  Run ${chalk.cyan(`pi-tin agent-profile finder ${name}`)} to open it in Finder.`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // createAgentProfile enumerates known agents in its unknown-agent
        // message; surface as a validation error so JSON callers get a code.
        throw new CliError(message, EXIT.VALIDATION, {
          code: 'validation',
          validValues: KNOWN_AGENTS.map((a) => a.name),
        });
      }
    });
}
