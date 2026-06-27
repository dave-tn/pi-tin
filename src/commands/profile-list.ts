import chalk from 'chalk';
import { printJson, shouldEmitJson } from '../lib/cli-output.js';
import { ensureInitialised } from '../lib/init-guard.js';
import { listContainerProfileSummaries } from '../lib/profiles.js';

export function registerContainerProfileListCommand(
  profileCmd: import('commander').Command,
): void {
  profileCmd
    .command('list')
    .description('List all available container profiles')
    .option('--json', 'Output machine-readable JSON')
    .action((opts: { json?: boolean }) => {
      ensureInitialised();

      const summaries = listContainerProfileSummaries();

      if (shouldEmitJson(opts.json)) {
        printJson(summaries);
        return;
      }

      if (summaries.length === 0) {
        console.log('No container profiles configured.');
        return;
      }

      const nameWidth = Math.max('PROFILE'.length, ...summaries.map((s) => s.name.length));
      const descWidth = Math.max(
        'DESCRIPTION'.length,
        ...summaries.map((s) => s.description.length),
      );

      const header = [
        'PROFILE'.padEnd(nameWidth),
        'DESCRIPTION'.padEnd(descWidth),
        'IMAGE',
      ].join('  ');

      console.log(chalk.bold(header));

      for (const s of summaries) {
        console.log(
          [s.name.padEnd(nameWidth), s.description.padEnd(descWidth), s.base_image].join('  '),
        );
      }
    });
}
