import { describe, expect, test } from 'bun:test';
import {
  classifyContainerSystemStatus,
  isSupportedContainerVersion,
  planContainerInstallGate,
  planContainerSystemGate,
  planContainerVersionGate,
} from './prereqs.js';
import { EXIT } from './cli-errors.js';

describe('isSupportedContainerVersion', () => {
  test('accepts 1.0.0 and newer', () => {
    expect(isSupportedContainerVersion('1.0.0')).toBe(true);
    expect(isSupportedContainerVersion('1.2.3')).toBe(true);
    expect(isSupportedContainerVersion('2.0.0')).toBe(true);
  });

  test('rejects pre-1.0 versions', () => {
    expect(isSupportedContainerVersion('0.5.0')).toBe(false);
    expect(isSupportedContainerVersion('0.9.9')).toBe(false);
  });

  test('extracts the version from surrounding text', () => {
    expect(isSupportedContainerVersion('container CLI version 1.0.0 (build: release)')).toBe(true);
    expect(isSupportedContainerVersion('container CLI version 0.4.1')).toBe(false);
  });

  test('rejects undeterminable versions', () => {
    expect(isSupportedContainerVersion('unknown')).toBe(false);
    expect(isSupportedContainerVersion('')).toBe(false);
  });
});

// Fixtures pin the `container system status --format json` contract
// (apple/container ≥ 1.0.0): stopped is reported on stdout as
// { "status": "not running" | "unregistered" } with exit 1.
describe('classifyContainerSystemStatus', () => {
  test('exit 0 → running', () => {
    expect(
      classifyContainerSystemStatus({ status: 0, stdout: '{"status":"running"}\n', stderr: '' }),
    ).toEqual({ kind: 'running' });
  });

  test('reported "not running" / "unregistered" → not-running', () => {
    expect(
      classifyContainerSystemStatus({ status: 1, stdout: '{"status":"not running"}\n', stderr: '' }),
    ).toEqual({ kind: 'not-running' });
    expect(
      classifyContainerSystemStatus({ status: 1, stdout: '{"status":"unregistered"}\n', stderr: '' }),
    ).toEqual({ kind: 'not-running' });
  });

  test('no parseable status → probe-failed with stderr detail', () => {
    expect(
      classifyContainerSystemStatus({
        status: 1,
        stdout: '',
        stderr: 'Error: failed to spawn launchctl\n',
      }),
    ).toEqual({ kind: 'probe-failed', detail: 'Error: failed to spawn launchctl' });
  });

  test('probe-failed falls back to stdout, then exit code, for detail', () => {
    expect(
      classifyContainerSystemStatus({ status: 64, stdout: 'Unknown option', stderr: '' }),
    ).toEqual({ kind: 'probe-failed', detail: 'Unknown option' });
    expect(
      classifyContainerSystemStatus({ status: null, stdout: '', stderr: '' }),
    ).toEqual({ kind: 'probe-failed', detail: 'exit code null' });
  });

  test('an unknown reported status is a probe failure, not "stopped"', () => {
    expect(
      classifyContainerSystemStatus({ status: 1, stdout: '{"status":"degraded"}', stderr: '' }),
    ).toEqual({ kind: 'probe-failed', detail: '{"status":"degraded"}' });
  });
});

describe('planContainerSystemGate', () => {
  test('running → proceed regardless of interactivity', () => {
    expect(planContainerSystemGate({ kind: 'running' }, true)).toEqual({ kind: 'proceed' });
    expect(planContainerSystemGate({ kind: 'running' }, false)).toEqual({ kind: 'proceed' });
  });

  test('not-running + interactive → prompt to start', () => {
    expect(planContainerSystemGate({ kind: 'not-running' }, true)).toEqual({ kind: 'prompt-start' });
  });

  test('not-running + non-interactive → structured failure with sandbox caveat', () => {
    const plan = planContainerSystemGate({ kind: 'not-running' }, false);
    if (plan.kind !== 'fail') throw new Error(`expected fail, got ${plan.kind}`);
    expect(plan.error.exitCode).toBe(EXIT.GENERAL);
    expect(plan.error.detail.code).toBe('container_system_not_running');
    expect(plan.error.detail.remediation).toContain('container system start');
    expect(plan.error.detail.remediation).toContain('sandbox');
  });

  test('probe-failed → structured failure carrying the probe detail', () => {
    const plan = planContainerSystemGate(
      { kind: 'probe-failed', detail: 'spawn container ENOENT' },
      true,
    );
    if (plan.kind !== 'fail') throw new Error(`expected fail, got ${plan.kind}`);
    expect(plan.error.exitCode).toBe(EXIT.GENERAL);
    expect(plan.error.detail.code).toBe('container_system_probe_failed');
    expect(plan.error.message).toContain('spawn container ENOENT');
  });
});

describe('planContainerInstallGate', () => {
  test('installed → proceed regardless of interactivity', () => {
    expect(planContainerInstallGate(true, true)).toEqual({ kind: 'proceed' });
    expect(planContainerInstallGate(true, false)).toEqual({ kind: 'proceed' });
  });

  test('not installed + interactive → prompt to install', () => {
    expect(planContainerInstallGate(false, true)).toEqual({ kind: 'prompt-install' });
  });

  test('not installed + non-interactive → structured failure with install remediation', () => {
    const plan = planContainerInstallGate(false, false);
    if (plan.kind !== 'fail') throw new Error(`expected fail, got ${plan.kind}`);
    expect(plan.error.exitCode).toBe(EXIT.GENERAL);
    expect(plan.error.detail.code).toBe('container_not_installed');
    expect(plan.error.detail.remediation).toContain('brew install container');
  });
});

describe('planContainerVersionGate', () => {
  test('supported version → proceed', () => {
    expect(planContainerVersionGate({ version: '1.0.0', isHomebrewInstalled: () => true }))
      .toEqual({ kind: 'proceed' });
  });

  test('unsupported version → structured failure naming the found version', () => {
    const plan = planContainerVersionGate({ version: '0.4.1', isHomebrewInstalled: () => true });
    if (plan.kind !== 'fail') throw new Error(`expected fail, got ${plan.kind}`);
    expect(plan.error.exitCode).toBe(EXIT.GENERAL);
    expect(plan.error.detail.code).toBe('container_version_unsupported');
    expect(plan.error.message).toContain('Found 0.4.1');
    expect(plan.error.detail.remediation).toContain('brew upgrade container');
  });

  test('undeterminable version → structured failure; remediation skips brew without Homebrew', () => {
    const plan = planContainerVersionGate({ version: null, isHomebrewInstalled: () => false });
    if (plan.kind !== 'fail') throw new Error(`expected fail, got ${plan.kind}`);
    expect(plan.error.detail.code).toBe('container_version_unsupported');
    expect(plan.error.message).toContain('could not be determined');
    expect(plan.error.detail.remediation).not.toContain('brew');
    expect(plan.error.detail.remediation).toContain('github.com/apple/container/releases');
  });
});
