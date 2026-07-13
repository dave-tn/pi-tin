import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { confirmDestructive } from '../lib/confirmation.js';
import { listWorkspaces } from '../lib/workspaces.js';
import {
  listContainers,
  listImageNames,
  deleteImage,
  isPiTinImageTag,
} from '../lib/container.js';
import { getConfigDir } from '../lib/paths.js';
import { CliError, EXIT } from '../lib/cli-errors.js';
import { printJson, shouldEmitJson } from '../lib/cli-output.js';
import { withExitHandling } from '../lib/exit-handling.js';
import { isRecord } from '../lib/guards.js';
import { planCleanup, selectOrphanedImages } from '../lib/workspace-plans.js';

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

function run(args: string[], label: string, quiet: boolean): PruneOutcome {
  const outcome = prunePass(args, (a) =>
    execFileSync('container', a, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
  if (outcome.status === 'failed') {
    console.warn(chalk.yellow(`Warning: ${label} failed: ${outcome.message}`));
  } else if (!quiet) {
    if (outcome.status === 'removed') {
      console.log(outcome.output);
      console.log(chalk.green(`✔ ${label}`));
    } else {
      console.log(chalk.dim(`  ${label}: nothing to clean`));
    }
  }
  return outcome;
}

/**
 * Confirmation gate for the entire destructive phase of `cleanup` (orphaned
 * pi-tin image removal plus the global container/image/volume prunes). Must
 * run regardless of stopped-workspace count — the prunes touch non-pi-tin
 * resources and the documented contract is prompt-or-exit-4 without --force.
 */
export async function confirmCleanup(input: {
  stopped: string[];
  force: boolean;
  isInteractive?: boolean;
  quiet?: boolean;
}): Promise<boolean> {
  if (input.quiet !== true) {
    if (input.stopped.length > 0) {
      const names = input.stopped.map((n) => chalk.cyan(n)).join(', ');
      console.log(
        chalk.yellow(
          `⚠ ${input.stopped.length} stopped pi-tin workspace${input.stopped.length === 1 ? '' : 's'} will be removed: ${names}`,
        ),
      );
      console.log(
        chalk.dim(
          '  Any in-container state (installed packages, files outside mounted volumes) will be lost.',
        ),
      );
    }
    console.log(
      chalk.dim(
        'This removes stopped containers, dangling images, and unused volumes — not limited to pi-tin.',
      ),
    );
  }
  return confirmDestructive({
    message: 'Continue with cleanup?',
    action: 'clean up containers, images, and volumes',
    force: input.force,
    promptDefault: true,
    ...(input.isInteractive === undefined ? {} : { isInteractive: input.isInteractive }),
  });
}

export async function fullWipe(running: string[], force: boolean, json: boolean): Promise<void> {
  if (running.length > 0) {
    throw new CliError(
      `Cannot perform full wipe while ${running.length} workspace${running.length === 1 ? ' is' : 's are'} running: ${running.join(', ')}`,
      EXIT.GENERAL,
      {
        code: 'workspaces_running',
        remediation: `Stop them first: ${running.map((n) => `pi-tin stop ${n}`).join(', ')}.`,
      },
    );
  }

  const allImages = listImageNames().filter(isPiTinImageTag);
  const configDir = getConfigDir();
  const configDirExists = fs.existsSync(configDir);

  if (!json) {
    console.log(chalk.red.bold('⚠ This will permanently delete ALL pi-tin data:\n'));
    if (allImages.length > 0) {
      console.log(chalk.red(`  • ${allImages.length} container image${allImages.length === 1 ? '' : 's'} (${allImages.join(', ')})`));
    }
    if (configDirExists) {
      console.log(chalk.red(`  • All container profiles, workspaces, agent profiles, and configuration`));
      console.log(chalk.red(`  • Config directory: ${configDir}`));
    }
  }
  if (allImages.length === 0 && !configDirExists) {
    if (json) {
      printJson({ action: 'wiped', imagesRemoved: [], imagesFailed: [], configDirRemoved: false, prunes: null });
    } else {
      console.log(chalk.dim('  Nothing to remove.'));
    }
    return;
  }
  if (!json) {
    console.log();
    console.log(chalk.yellow('  All other stopped containers, dangling images, and unused volumes'));
    console.log(chalk.yellow('  will also be removed (not limited to pi-tin).'));
    console.log();
    console.log(chalk.dim('  Your project files and mounted directories are not affected.'));
    console.log();
    console.log(chalk.red('  This cannot be undone.'));
    console.log();
  }

  const proceed = await confirmDestructive({
    message: 'Continue with full wipe?',
    action: 'perform a full wipe',
    force,
  });
  if (!proceed) {
    if (json) {
      printJson({ action: 'cancelled' });
    } else {
      console.log('Cancelled.');
    }
    return;
  }

  if (!json) {
    console.log();
  }

  // Remove all pi-tin images
  const imagesRemoved: string[] = [];
  const imagesFailed: string[] = [];
  for (const img of allImages) {
    try {
      deleteImage(img);
      imagesRemoved.push(img);
      if (!json) {
        console.log(chalk.yellow(`Removed image: ${img}`));
      }
    } catch (err) {
      imagesFailed.push(img);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(chalk.yellow(`Warning: failed to remove image '${img}': ${msg}`));
    }
  }

  // Remove stopped containers, dangling images, unused volumes
  const containersOutcome = run(['prune'], 'Removed stopped containers', json);
  const imagesOutcome = run(['image', 'prune'], 'Removed dangling images', json);
  const volumesOutcome = run(['volume', 'prune'], 'Removed unused volumes', json);

  // Remove config directory
  if (configDirExists) {
    fs.rmSync(configDir, { recursive: true, force: true });
    if (!json) {
      console.log(chalk.yellow(`Removed config directory: ${configDir}`));
    }
  }

  if (json) {
    printJson({
      action: 'wiped',
      imagesRemoved,
      imagesFailed,
      configDirRemoved: configDirExists,
      prunes: {
        containers: containersOutcome.status,
        images: imagesOutcome.status,
        volumes: volumesOutcome.status,
      },
    });
  } else {
    console.log(chalk.bold('\nAll pi-tin data has been removed.'));
  }
}

export function registerCleanupCommand(
  program: import('commander').Command,
): void {
  program
    .command('cleanup')
    .description('Remove stopped containers, dangling images, and unused volumes')
    .option('--all', 'Full wipe: remove all pi-tin images, config, and data')
    .option('-f, --force', 'Skip confirmation prompt')
    .option('--dry-run', 'Preview what would be removed without removing anything')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { all?: boolean; force?: boolean; dryRun?: boolean; json?: boolean }) => {
      const json = shouldEmitJson(opts.json);
      await withExitHandling(async () => {
        const plan = planCleanup(listContainers());
        if (plan.action === 'refuse') {
          throw new Error(plan.message);
        }
        const running = plan.runningWorkspaces;

        if (opts.all) {
          if (opts.dryRun === true) {
            if (running.length > 0) {
              throw new CliError(
                `Cannot perform full wipe while ${running.length} workspace${running.length === 1 ? ' is' : 's are'} running: ${running.join(', ')}`,
                EXIT.GENERAL,
                { code: 'workspaces_running', remediation: `Stop them first: ${running.map((n) => `pi-tin stop ${n}`).join(', ')}.` },
              );
            }
            const images = listImageNames().filter(isPiTinImageTag);
            const configDir = getConfigDir();
            const preview = {
              action: 'full-wipe',
              images,
              configDir: fs.existsSync(configDir) ? configDir : null,
              prunes: ['containers', 'images', 'volumes'],
            };
            if (json) {
              printJson({ ...preview, dryRun: true });
            } else {
              console.log(`Would remove ${images.length} pi-tin image${images.length === 1 ? '' : 's'}, the config directory, and run all prunes.`);
            }
            return;
          }
          await fullWipe(running, opts.force === true, json);
          return;
        }

        const workspaceNames = listWorkspaces().map((w) => w.name);
        const orphanedImages = selectOrphanedImages({
          imageNames: listImageNames(),
          workspaceNames,
        });

        if (opts.dryRun === true) {
          const preview = {
            action: 'cleanup',
            runningWorkspaces: running,
            stoppedWorkspaces: plan.stoppedWorkspaces,
            orphanedImages,
            prunes: ['containers', 'images', 'volumes'],
          };
          if (json) {
            printJson({ ...preview, dryRun: true });
          } else {
            if (running.length > 0) {
              console.log(chalk.yellow(`Running (skipped): ${running.join(', ')}`));
            }
            if (plan.stoppedWorkspaces.length > 0) {
              console.log(`Would remove stopped workspace container${plan.stoppedWorkspaces.length === 1 ? '' : 's'}: ${plan.stoppedWorkspaces.join(', ')}`);
            }
            if (orphanedImages.length > 0) {
              console.log(`Would remove orphaned image${orphanedImages.length === 1 ? '' : 's'}: ${orphanedImages.join(', ')}`);
            }
            console.log('Would prune stopped containers, dangling images, and unused volumes (not limited to pi-tin).');
          }
          return;
        }

        if (!json && running.length > 0) {
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

        const proceed = await confirmCleanup({
          stopped: plan.stoppedWorkspaces,
          force: opts.force === true,
          quiet: json,
        });
        if (!proceed) {
          if (json) {
            printJson({ action: 'cancelled' });
          } else {
            console.log('Cancelled.');
          }
          return;
        }
        if (!json) {
          console.log();
          console.log(chalk.bold('Cleaning up...\n'));
        }

        // Remove orphaned pi-tin images (no matching workspace)
        const orphanedImagesRemoved: string[] = [];
        const orphanedImagesFailed: string[] = [];
        for (const img of orphanedImages) {
          try {
            deleteImage(img);
            orphanedImagesRemoved.push(img);
            if (!json) {
              console.log(chalk.yellow(`Removed orphaned image: ${img}`));
            }
          } catch (err) {
            orphanedImagesFailed.push(img);
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(chalk.yellow(`Warning: failed to remove image '${img}': ${msg}`));
          }
        }

        const containersOutcome = run(['prune'], 'Removed stopped containers', json);
        const imagesOutcome = run(['image', 'prune'], 'Removed dangling images', json);
        const volumesOutcome = run(['volume', 'prune'], 'Removed unused volumes', json);

        if (json) {
          printJson({
            action: 'cleaned',
            orphanedImagesRemoved,
            orphanedImagesFailed,
            prunes: {
              containers: containersOutcome.status,
              images: imagesOutcome.status,
              volumes: volumesOutcome.status,
            },
          });
        } else {
          console.log(chalk.bold('\nDone.'));
        }
      });
    });
}
