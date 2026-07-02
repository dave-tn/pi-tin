import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspaceShowCommand } from './workspace-show.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

// show builds a filesystem path from the raw argv name (workspaceExists), so
// an invalid name like '../config' must be rejected up front as a
// CliError(VALIDATION) — the same documented structured-error path apply uses
// — instead of resolving outside the workspaces dir. XDG_CONFIG_HOME is
// pointed at a temp dir so ensureInitialised never touches the real
// ~/.config/pi-tin.

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-show-test-'));
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

describe('workspace show name validation', () => {
  test('throws CliError(VALIDATION) for a path-traversal name', async () => {
    const program = new Command();
    registerWorkspaceShowCommand(program);

    const err = await runAndCatch(program, ['show', '../config']);

    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('../config');
    expect(err.message).toContain('../config');
  });
});
