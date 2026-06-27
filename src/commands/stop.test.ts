import { describe, expect, test } from 'bun:test';
import { planStopWorkspace } from '../lib/workspace-plans.js';

describe('planStopWorkspace', () => {
  test('returns a no-op when the workspace is not running', () => {
    expect(planStopWorkspace({
      workspaceName: 'demo',
      containerState: 'not-found',
      runtimeState: 'missing',
      activeSessions: 0,
      force: false,
    })).toEqual({ action: 'noop' });
  });

  test('returns a no-op when the container is already stopped', () => {
    expect(planStopWorkspace({
      workspaceName: 'demo',
      containerState: 'stopped',
      runtimeState: 'missing',
      activeSessions: 0,
      force: false,
    })).toEqual({ action: 'noop' });
  });

  test('prompts before stopping active sessions when not forced', () => {
    expect(planStopWorkspace({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'ok',
      activeSessions: 2,
      force: false,
    })).toEqual({
      action: 'confirm',
      message: "Workspace 'demo' has 2 active sessions. Stop it anyway?",
    });
  });

  test('stops immediately when force is used', () => {
    expect(planStopWorkspace({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'ok',
      activeSessions: 2,
      force: true,
    })).toEqual({
      action: 'stop',
      warnAboutInconsistentRuntime: false,
    });
  });

  test('warns but still stops when runtime state is inconsistent', () => {
    expect(planStopWorkspace({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'corrupt',
      activeSessions: 0,
      force: false,
    })).toEqual({
      action: 'stop',
      warnAboutInconsistentRuntime: true,
    });
  });
});
