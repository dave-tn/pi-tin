import chalk from 'chalk';
import { confirmDestructive } from '../lib/confirmation.js';
import {
  containerNameFor,
  getContainerState,
} from '../lib/container.js';
import { stopAndRemoveContainer } from '../lib/container-lifecycle.js';
import { ensureInitialised } from '../lib/init-guard.js';
import {
  withWorkspaceLock,
  readRuntimeDecisionState,
  clearWorkspaceRuntimeState,
} from '../lib/runtime-state.js';
import { withExitHandling } from '../lib/exit-handling.js';
import { planStopWorkspace, type StopWorkspacePlan } from '../lib/workspace-plans.js';
import { removeWorkspaceSshArtifacts } from '../lib/ssh-endpoint.js';
import { assertValidWorkspaceName } from '../lib/workspaces.js';
import { printJson, shouldEmitJson } from '../lib/cli-output.js';

export type StopPreview =
  | { action: 'noop'; workspace: string; reason: 'not-running' }
  | { action: 'stop'; workspace: string; requiresConfirmation: boolean };

export function buildStopPreview(
  plan: Exclude<StopWorkspacePlan, { action: 'refuse' }>,
  workspace: string,
): StopPreview {
  if (plan.action === 'noop') {
    return { action: 'noop', workspace, reason: 'not-running' };
  }
  return { action: 'stop', workspace, requiresConfirmation: plan.action === 'confirm' };
}

export function registerStopCommand(
  program: import('commander').Command,
): void {
  program
    .command('stop <workspace>')
    .description('Stop a running workspace')
    .option('-f, --force', 'Skip confirmation prompt and kill if needed')
    .option('--dry-run', 'Preview what would be stopped without stopping')
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string, opts: { force?: boolean; dryRun?: boolean; json?: boolean }) => {
      ensureInitialised();

      // stop never goes through loadWorkspace, so validate the raw argv name
      // before deriving container names and runtime-state paths from it.
      assertValidWorkspaceName(name);
      const json = shouldEmitJson(opts.json);

      await withExitHandling(async () => {
        const containerName = containerNameFor(name);

        await withWorkspaceLock(name, async () => {
          const state = getContainerState(containerName);
          const runtime = readRuntimeDecisionState(name, state);
          const plan = planStopWorkspace({
            workspaceName: name,
            containerState: state,
            runtimeState: runtime.runtimeState,
            activeSessions: runtime.activeSessions,
            force: opts.force === true,
          });

          if (plan.action === 'refuse') {
            throw new Error(plan.message);
          }

          if (opts.dryRun === true) {
            const preview = buildStopPreview(plan, name);
            if (json) {
              printJson({ ...preview, dryRun: true });
            } else if (preview.action === 'noop') {
              console.log(chalk.dim(`Workspace '${name}' is not running; nothing to stop.`));
            } else {
              console.log(`Would stop workspace '${name}'.`);
            }
            return;
          }

          if (plan.action === 'noop') {
            await stopAndRemoveContainer(containerName);
            clearWorkspaceRuntimeState(name);
            if (json) {
              printJson({ action: 'noop', workspace: name, reason: 'not-running' });
            } else {
              console.log(chalk.dim(`Workspace '${name}' is not running.`));
            }
            return;
          }

          const warnAboutInconsistentRuntime = plan.action === 'stop'
            ? plan.warnAboutInconsistentRuntime
            : false;

          if (plan.action === 'confirm') {
            const proceed = await confirmDestructive({
              message: plan.message,
              action: `stop workspace '${name}'`,
              force: opts.force === true,
            });
            if (!proceed) {
              if (json) {
                printJson({ action: 'cancelled', workspace: name });
              } else {
                console.log('Cancelled.');
              }
              return;
            }
          }

          if (warnAboutInconsistentRuntime) {
            console.warn(chalk.yellow(`Warning: runtime state is inconsistent for workspace '${name}'. Stopping it anyway.`));
          }

          await stopAndRemoveContainer(containerName, { force: opts.force === true });
          clearWorkspaceRuntimeState(name);
          // The Host block points at an IP the container just released; the
          // per-workspace known_hosts stays — the image (and its host keys)
          // survives a stop.
          removeWorkspaceSshArtifacts(name, { clearKnownHosts: false });
          if (json) {
            printJson({ action: 'stopped', workspace: name });
          } else {
            console.log(chalk.green(`Stopped workspace '${name}'`));
          }
        });
      });
    });
}
