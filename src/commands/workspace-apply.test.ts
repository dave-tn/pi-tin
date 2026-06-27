import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspaceApplyCommand } from './workspace-apply.js';
import { registerContainerProfileApplyCommand } from './container-profile-apply.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

// The apply actions validate <name> up front (before reading stdin) so a bad
// name surfaces as a CliError(VALIDATION) on the documented structured-error
// path, not a plain Error that the top-level handler would treat as GENERAL.
// We drive the real registered action via commander's parseAsync; the throw
// fires before readStdin, so no stdin is needed. XDG_CONFIG_HOME is pointed at
// a temp dir so ensureInitialised never touches the real ~/.config/pi-tin.

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-apply-test-'));
  originalXdg = process.env['XDG_CONFIG_HOME'];
  process.env['XDG_CONFIG_HOME'] = tmpDir;
});

afterEach(() => {
  if (originalXdg === undefined) {
    delete process.env['XDG_CONFIG_HOME'];
  } else {
    process.env['XDG_CONFIG_HOME'] = originalXdg;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runAndCatch(
  program: Command,
  argv: string[],
): Promise<unknown> {
  program.exitOverride();
  try {
    await program.parseAsync(['node', 'pi-tin', ...argv]);
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('workspace apply name validation', () => {
  test('throws CliError(VALIDATION) for an invalid workspace name', async () => {
    const program = new Command();
    registerWorkspaceApplyCommand(program);

    const err = await runAndCatch(program, ['apply', 'Bad Name']);

    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('Bad Name');
    expect(err.message).toContain('Bad Name');
  });
});

describe('container-profile apply name validation', () => {
  test('throws CliError(VALIDATION) for an unsafe path-segment name', async () => {
    const program = new Command();
    registerContainerProfileApplyCommand(program);

    const err = await runAndCatch(program, ['apply', '../escape']);

    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('../escape');
    expect(err.message).toContain('../escape');
  });
});
