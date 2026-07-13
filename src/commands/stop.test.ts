import { describe, expect, test } from 'bun:test';
import { planStopWorkspace } from '../lib/workspace-plans.js';
import { buildStopPreview } from './stop.js';

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

  test('refuses when the container state is unknown, even when forced', () => {
    const expected = {
      action: 'refuse' as const,
      message: [
        "Could not determine the state of workspace 'demo' — listing containers failed.",
        "Check the container system is running ('container system start'), then retry.",
      ].join('\n'),
    };
    expect(planStopWorkspace({
      workspaceName: 'demo',
      containerState: 'unknown',
      runtimeState: 'missing',
      activeSessions: 0,
      force: false,
    })).toEqual(expected);
    expect(planStopWorkspace({
      workspaceName: 'demo',
      containerState: 'unknown',
      runtimeState: 'missing',
      activeSessions: 0,
      force: true,
    })).toEqual(expected);
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

describe('buildStopPreview', () => {
  test('noop plan previews as not-running', () => {
    expect(buildStopPreview({ action: 'noop' }, 'ws')).toEqual({
      action: 'noop',
      workspace: 'ws',
      reason: 'not-running',
    });
  });

  test('stop plan previews without confirmation', () => {
    expect(buildStopPreview({ action: 'stop', warnAboutInconsistentRuntime: false }, 'ws')).toEqual({
      action: 'stop',
      workspace: 'ws',
      requiresConfirmation: false,
    });
  });

  test('confirm plan previews with confirmation required', () => {
    expect(buildStopPreview({ action: 'confirm', message: 'x' }, 'ws')).toEqual({
      action: 'stop',
      workspace: 'ws',
      requiresConfirmation: true,
    });
  });
});
