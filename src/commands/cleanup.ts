import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { confirmDestructive } from '../lib/confirmation.js';
import { listWorkspaces } from '../lib/workspaces.js';
import {
  listContainers,
  listImageNames,
  deleteImage,
  isPiTinContainerId,
  workspaceNameFromContainerId,
  isPiTinImageTag,
  workspaceNameFromImageTag,
} from '../lib/container.js';
import { getConfigDir } from '../lib/paths.js';
import { withExitHandling } from '../lib/exit-handling.js';
import { isRecord } from '../lib/guards.js';

export type PruneOutcome =
  | { status: 'removed'; output: string }
  | { status: 'empty' }
  | { status: 'failed'; message: string };

function getStderr(err: unknown): Buffer | string | undefined {
  if (isRecord(err)) {
    const stderr = err['stderr'];
    if (typeof stderr === 'string' || Buffer.isBuffer(stderr)) {
      return stderr;
    }
  }
  return undefined;
}

/**
 * Run a `container` prune-style command and classify the result.
 * A real command failure is reported as 'failed' (surfaced as a warning),
 * never silently masked as "nothing to clean".
 */
export function prunePass(
  args: string[],
  exec: (args: string[]) => string,
): PruneOutcome {
  try {
    const output = exec(args).trim();
    return output ? { status: 'removed', output } : { status: 'empty' };
  } catch (err) {
    const stderr = getStderr(err);
    const message = stderr
      ? String(stderr).trim()
      : err instanceof Error ? err.message : String(err);
    return { status: 'failed', message };
  }
}

function run(args: string[], label: string): void {
  const outcome = prunePass(args, (a) =>
    execFileSync('container', a, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
  if (outcome.status === 'removed') {
    console.log(outcome.output);
    console.log(chalk.green(`✔ ${label}`));
  } else if (outcome.status === 'empty') {
    console.log(chalk.dim(`  ${label}: nothing to clean`));
  } else {
    console.warn(chalk.yellow(`Warning: ${label} failed: ${outcome.message}`));
  }
}

function getPiTinContainers(): { running: string[]; stopped: string[] } {
  const piTin = listContainers().filter((c) => isPiTinContainerId(c.id));
  return {
    running: piTin
      .filter((c) => c.status === 'running')
      .map((c) => workspaceNameFromContainerId(c.id)),
    stopped: piTin
      .filter((c) => c.status !== 'running')
      .map((c) => workspaceNameFromContainerId(c.id)),
  };
}

async function fullWipe(running: string[], force: boolean): Promise<void> {
  if (running.length > 0) {
    const names = running.map((n) => chalk.cyan(n)).join(', ');
    console.error(
      chalk.red(
        `Cannot perform full wipe while ${running.length} workspace${running.length === 1 ? ' is' : 's are'} running: ${names}`,
      ),
    );
    console.error(
      chalk.dim(
        `  Stop them first with: ${running.map((n) => `pi-tin stop ${n}`).join(', ')}`,
      ),
    );
    process.exit(1);
  }

  const allImages = listImageNames().filter(isPiTinImageTag);
  const configDir = getConfigDir();
  const configDirExists = fs.existsSync(configDir);

  console.log(chalk.red.bold('⚠ This will permanently delete ALL pi-tin data:\n'));
  if (allImages.length > 0) {
    console.log(chalk.red(`  • ${allImages.length} container image${allImages.length === 1 ? '' : 's'} (${allImages.join(', ')})`));
  }
  if (configDirExists) {
    console.log(chalk.red(`  • All container profiles, workspaces, agent profiles, and configuration`));
    console.log(chalk.red(`  • Config directory: ${configDir}`));
  }
  if (allImages.length === 0 && !configDirExists) {
    console.log(chalk.dim('  Nothing to remove.'));
    return;
  }
  console.log();
  console.log(chalk.yellow('  All other stopped containers, dangling images, and unused volumes'));
  console.log(chalk.yellow('  will also be removed (not limited to pi-tin).'));
  console.log();
  console.log(chalk.dim('  Your project files and mounted directories are not affected.'));
  console.log();
  console.log(chalk.red('  This cannot be undone.'));
  console.log();

  const proceed = await confirmDestructive({
    message: 'Continue with full wipe?',
    action: 'perform a full wipe',
    force,
  });
  if (!proceed) {
    console.log('Cancelled.');
    return;
  }

  console.log();

  // Remove all pi-tin images
  for (const img of allImages) {
    try {
      deleteImage(img);
      console.log(chalk.yellow(`Removed image: ${img}`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(chalk.yellow(`Warning: failed to remove image '${img}': ${msg}`));
    }
  }

  // Remove stopped containers, dangling images, unused volumes
  run(['prune'], 'Removed stopped containers');
  run(['image', 'prune'], 'Removed dangling images');
  run(['volume', 'prune'], 'Removed unused volumes');

  // Remove config directory
  if (configDirExists) {
    fs.rmSync(configDir, { recursive: true, force: true });
    console.log(chalk.yellow(`Removed config directory: ${configDir}`));
  }

  console.log(chalk.bold('\nAll pi-tin data has been removed.'));
}

export function registerCleanupCommand(
  program: import('commander').Command,
): void {
  program
    .command('cleanup')
    .description('Remove stopped containers, dangling images, and unused volumes')
    .option('--all', 'Full wipe: remove all pi-tin images, config, and data')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (opts: { all?: boolean; force?: boolean }) => {
      await withExitHandling(async () => {
        const { running, stopped } = getPiTinContainers();

        if (opts.all) {
          await fullWipe(running, opts.force === true);
          return;
        }

        if (running.length > 0) {
          const names = running.map((n) => chalk.cyan(n)).join(', ');
          console.log(
            chalk.yellow(
              `⚠ ${running.length} pi-tin workspace${running.length === 1 ? '' : 's'} still running (${names}) — ${running.length === 1 ? 'it' : 'they'} will not be cleaned up.`,
            ),
          );
          console.log(
            chalk.dim(
              `  Stop them first with: ${running.map((n) => `pi-tin stop ${n}`).join(', ')}`,
            ),
          );
          console.log();
        }

        if (stopped.length > 0) {
          const names = stopped.map((n) => chalk.cyan(n)).join(', ');
          console.log(
            chalk.yellow(
              `⚠ ${stopped.length} stopped pi-tin workspace${stopped.length === 1 ? '' : 's'} will be removed: ${names}`,
            ),
          );
          console.log(
            chalk.dim(
              '  Any in-container state (installed packages, files outside mounted volumes) will be lost.',
            ),
          );

          const proceed = await confirmDestructive({
            message: 'Continue with cleanup?',
            action: 'clean up stopped workspaces',
            force: opts.force === true,
            promptDefault: true,
          });
          if (!proceed) {
            console.log('Cancelled.');
            return;
          }
          console.log();
        }

        console.log(chalk.bold('Cleaning up...\n'));

        // Remove orphaned pi-tin images (no matching workspace)
        const workspaceNames = new Set(listWorkspaces().map((w) => w.name));
        const allImages = listImageNames();
        const orphanedImages = allImages.filter(
          (img) => isPiTinImageTag(img) && !workspaceNames.has(workspaceNameFromImageTag(img)),
        );
        for (const img of orphanedImages) {
          try {
            deleteImage(img);
            console.log(chalk.yellow(`Removed orphaned image: ${img}`));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(chalk.yellow(`Warning: failed to remove image '${img}': ${msg}`));
          }
        }

        run(['prune'], 'Removed stopped containers');
        run(['image', 'prune'], 'Removed dangling images');
        run(['volume', 'prune'], 'Removed unused volumes');

        console.log(chalk.bold('\nDone.'));
      });
    });
}
