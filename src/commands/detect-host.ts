import { detectHost } from '../lib/host-detect.js';
import { printJson } from '../lib/cli-output.js';

export function registerDetectHostCommand(
  program: import('commander').Command,
): void {
  program
    .command('detect-host')
    .description('Print host facts (git identity, timezone, API keys, known agents) as JSON')
    .option('--json', 'Output machine-readable JSON (always JSON; accepted for consistency)')
    .action(() => {
      printJson(detectHost());
    });
}
