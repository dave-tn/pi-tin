import { describe, expect, test } from 'bun:test';
import { planDeleteWorkspace } from '../lib/workspace-plans.js';

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
