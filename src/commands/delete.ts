import fs from 'node:fs';
import chalk from 'chalk';
import { confirmDestructive } from '../lib/confirmation.js';
import { ensureInitialised } from '../lib/init-guard.js';
import { getBuildHashPath } from '../lib/paths.js';
import { workspaceExists, deleteWorkspace, listWorkspaces, assertValidWorkspaceName } from '../lib/workspaces.js';
import { notFoundWorkspaceError } from '../lib/workspace-errors.js';
import {
  containerNameFor,
  imageTagFor,
  getContainerState,
  deleteImage,
  imageExists,
} from '../lib/container.js';
import { stopAndRemoveContainer } from '../lib/container-lifecycle.js';
import {
  withWorkspaceLock,
  readRuntimeDecisionState,
  clearWorkspaceRuntimeState,
} from '../lib/runtime-state.js';
import { withExitHandling } from '../lib/exit-handling.js';
import { planDeleteWorkspace } from '../lib/workspace-plans.js';
import { removeWorkspaceSshArtifacts } from '../lib/ssh-endpoint.js';
import { formatBytes, printJson, shouldEmitJson } from '../lib/cli-output.js';
import type { WorkspaceStateSnapshot } from '../lib/workspace-state.js';
import {
  measureWorkspaceStateSnapshot,
  removeWorkspaceStateSnapshot,
} from '../lib/workspace-state.js';

export interface DeleteImpact {
  action: 'delete';
  workspace: string;
  stopRunningContainer: boolean;
  image: string | null;
  workspaceState: WorkspaceStateSnapshot | null;
}

export function formatDeleteImpact(impact: DeleteImpact): string[] {
  const runningNote = impact.stopRunningContainer ? ' (currently running — will be stopped)' : '';
  const lines = [`Would delete workspace '${impact.workspace}'${runningNote}.`];
  if (impact.image !== null) {
    lines.push(`  Would remove image: ${impact.image}`);
  }
  if (impact.workspaceState !== null) {
    lines.push(
      `  Would remove saved workspace state: ${impact.workspaceState.path} (${formatBytes(impact.workspaceState.bytes)})`,
    );
  }
  return lines;
}

// Losing the container is the expected cost of a delete; losing the host
// snapshot of saved state is not, and it is routinely the largest artifact a
// workspace leaves behind — so it leads the prompt instead of trailing the
// question, where it would be easy to confirm past.
export function deleteConfirmationMessage(input: {
  workspace: string;
  stopRunningContainer: boolean;
  workspaceState: WorkspaceStateSnapshot | null;
}): string {
  const question = input.stopRunningContainer
    ? `Workspace '${input.workspace}' is running. Delete it anyway?`
    : `Delete workspace '${input.workspace}'?`;
  if (input.workspaceState === null) {
    return question;
  }
  return `${formatBytes(input.workspaceState.bytes)} of saved workspace state (${input.workspaceState.path}) will be permanently removed. ${question}`;
}

export function registerDeleteCommand(
  program: import('commander').Command,
): void {
  program
    .command('delete <workspace>')
    .description('Delete a workspace')
    .option('-f, --force', 'Skip confirmation prompt')
    .option('--dry-run', 'Preview what would be deleted without deleting')
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string, opts: { force?: boolean; dryRun?: boolean; json?: boolean }) => {
      ensureInitialised();

      // delete never goes through loadWorkspace, so validate the raw argv
      // name before it reaches workspaceExists and runtime-state paths.
      assertValidWorkspaceName(name);
      const json = shouldEmitJson(opts.json);

      if (!workspaceExists(name)) {
        throw notFoundWorkspaceError(name, listWorkspaces().map((w) => w.name));
      }

      await withExitHandling(async () => {
        await withWorkspaceLock(name, async () => {
          const containerName = containerNameFor(name);
          const containerState = getContainerState(containerName);
          const runtime = readRuntimeDecisionState(name, containerState);
          const plan = planDeleteWorkspace({
            workspaceName: name,
            containerState,
            runtimeState: runtime.runtimeState,
            activeSessions: runtime.activeSessions,
          });

          if (plan.action === 'refuse') {
            throw new Error(plan.message);
          }

          const imageTag = imageTagFor(name);
          // Measured before anything is removed: both the preview and the
          // prompt have to name the snapshot while it still exists.
          const workspaceState = measureWorkspaceStateSnapshot(name);

          if (opts.dryRun === true) {
            const impact: DeleteImpact = {
              action: 'delete',
              workspace: name,
              stopRunningContainer: plan.stopRunningContainer,
              image: imageExists(imageTag) ? imageTag : null,
              workspaceState,
            };
            if (json) {
              printJson({ ...impact, dryRun: true });
            } else {
              for (const line of formatDeleteImpact(impact)) {
                console.log(line);
              }
            }
            return;
          }

          const proceed = await confirmDestructive({
            message: deleteConfirmationMessage({
              workspace: name,
              stopRunningContainer: plan.stopRunningContainer,
              workspaceState,
            }),
            action: `delete workspace '${name}'`,
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

          await stopAndRemoveContainer(containerName);

          clearWorkspaceRuntimeState(name);

          let imageRemoved = false;
          if (imageExists(imageTag)) {
            try {
              deleteImage(imageTag);
              imageRemoved = true;
              if (!json) {
                console.log(chalk.yellow(`Removed image: ${imageTag}`));
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(chalk.yellow(`Warning: failed to remove image '${imageTag}': ${msg}`));
            }
          }

          const hashPath = getBuildHashPath(name);
          if (fs.existsSync(hashPath)) {
            fs.unlinkSync(hashPath);
          }

          // Warns and reports on failure rather than throwing: the container
          // and image are already gone, so aborting here would leave the
          // workspace half-deleted.
          const stateRemoval = removeWorkspaceStateSnapshot(workspaceState);
          if (workspaceState !== null && stateRemoval === 'removed' && !json) {
            console.log(
              chalk.yellow(`Removed saved workspace state: ${workspaceState.path} (${formatBytes(workspaceState.bytes)})`),
            );
          }

          removeWorkspaceSshArtifacts(name, { clearKnownHosts: true });
          deleteWorkspace(name);
          if (json) {
            printJson({
              action: 'deleted',
              workspace: name,
              imageRemoved,
              workspaceStateRemoved: stateRemoval === 'removed',
            });
          } else {
            console.log(chalk.green(`✔ Deleted workspace '${name}'`));
          }
        });
      });
    });
}
