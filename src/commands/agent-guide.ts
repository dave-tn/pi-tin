import { AGENT_GUIDE, AGENT_HELP_SCHEMA } from '../lib/agent-guide.js';
import { printJson } from '../lib/cli-output.js';

export function registerAgentGuideCommand(
  program: import('commander').Command,
): void {
  program
    .command('agent-guide')
    .description('Print the machine-oriented usage guide')
    .option('--json', 'Output the machine-readable command/flag schema instead of prose')
    .action((opts: { json?: boolean }) => {
      if (opts.json === true) {
        printJson(AGENT_HELP_SCHEMA);
        return;
      }
      process.stdout.write(AGENT_GUIDE + '\n');
    });
}
