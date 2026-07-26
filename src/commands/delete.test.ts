import { describe, expect, test } from 'bun:test';
import { planDeleteWorkspace } from '../lib/workspace-plans.js';
import { deleteConfirmationMessage, formatDeleteImpact } from './delete.js';

describe('planDeleteWorkspace', () => {
  test('allows delete when the container is not running', () => {
    expect(planDeleteWorkspace({
      workspaceName: 'demo',
      containerState: 'not-found',
      runtimeState: 'missing',
      activeSessions: 0,
    })).toEqual({
      action: 'delete',
      stopRunningContainer: false,
    });
  });

  test('refuses delete when runtime state is inconsistent', () => {
    expect(planDeleteWorkspace({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'corrupt',
      activeSessions: 0,
    })).toEqual({
      action: 'refuse',
      message: "Workspace 'demo' is running but its runtime state is inconsistent.\nRun 'pi-tin stop demo' first.",
    });
  });

  test('refuses delete when active sessions exist', () => {
    expect(planDeleteWorkspace({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'ok',
      activeSessions: 2,
    })).toEqual({
      action: 'refuse',
      message: "Workspace 'demo' has 2 active sessions.\nStop it first with 'pi-tin stop demo'.",
    });
  });

  test('refuses delete when the container state is unknown', () => {
    expect(planDeleteWorkspace({
      workspaceName: 'demo',
      containerState: 'unknown',
      runtimeState: 'missing',
      activeSessions: 0,
    })).toEqual({
      action: 'refuse',
      message: [
        "Could not determine the state of workspace 'demo' — listing containers failed.",
        "Check the container system is running ('container system start'), then retry.",
      ].join('\n'),
    });
  });

  test('allows delete after stopping an idle running workspace', () => {
    expect(planDeleteWorkspace({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'ok',
      activeSessions: 0,
    })).toEqual({
      action: 'delete',
      stopRunningContainer: true,
    });
  });
});

// The host snapshot under ~/.config/pi-tin/workspace-state/<name>/ goes with
// the workspace, and it is usually the biggest thing being destroyed — so the
// preview and the prompt must name it and its size before anything is removed.
describe('formatDeleteImpact', () => {
  test('previews the saved workspace state with its size', () => {
    expect(formatDeleteImpact({
      action: 'delete',
      workspace: 'cospeed',
      stopRunningContainer: false,
      image: 'pi-tin-cospeed',
      workspaceState: { path: '/cfg/pi-tin/workspace-state/cospeed', bytes: 259_400_000 },
    })).toEqual([
      "Would delete workspace 'cospeed'.",
      '  Would remove image: pi-tin-cospeed',
      '  Would remove saved workspace state: /cfg/pi-tin/workspace-state/cospeed (259.4 MB)',
    ]);
  });

  test('omits the state line for a workspace that never persisted state', () => {
    expect(formatDeleteImpact({
      action: 'delete',
      workspace: 'cospeed',
      stopRunningContainer: true,
      image: null,
      workspaceState: null,
    })).toEqual([
      "Would delete workspace 'cospeed' (currently running — will be stopped).",
    ]);
  });
});

describe('deleteConfirmationMessage', () => {
  test('leads with the saved state that is about to be destroyed', () => {
    const message = deleteConfirmationMessage({
      workspace: 'cospeed',
      stopRunningContainer: false,
      workspaceState: { path: '/cfg/pi-tin/workspace-state/cospeed', bytes: 259_400_000 },
    });

    expect(message).toBe(
      '259.4 MB of saved workspace state (/cfg/pi-tin/workspace-state/cospeed) '
      + "will be permanently removed. Delete workspace 'cospeed'?",
    );
  });

  test('still warns about the state when the workspace is running', () => {
    const message = deleteConfirmationMessage({
      workspace: 'cospeed',
      stopRunningContainer: true,
      workspaceState: { path: '/cfg/pi-tin/workspace-state/cospeed', bytes: 1_500 },
    });

    expect(message).toContain('1.5 KB of saved workspace state');
    expect(message).toContain("Workspace 'cospeed' is running. Delete it anyway?");
  });

  test('asks the plain question when there is no saved state', () => {
    expect(deleteConfirmationMessage({
      workspace: 'cospeed',
      stopRunningContainer: false,
      workspaceState: null,
    })).toBe("Delete workspace 'cospeed'?");
  });
});
