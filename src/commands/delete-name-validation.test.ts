import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerContainerProfileDeleteCommand } from './container-profile-delete.js';
import { registerAgentProfileDeleteCommand } from './agent-profile-delete.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

// The delete actions validate <name> up front so an unsafe name surfaces as a
// CliError(VALIDATION) on the documented structured-error path (exit 2, JSON
// envelope) — consistent with the apply commands — instead of rethrowing the
// loader's plain Error, which the top-level handler treats as GENERAL (exit 1,
// plaintext). The throw fires before the confirmation gate, so no stdin or TTY
// is needed. XDG_CONFIG_HOME points at a temp dir so ensureInitialised never
// touches the real ~/.config/pi-tin.

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-delete-test-'));
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

async function runAndCatch(program: Command, argv: string[]): Promise<unknown> {
  program.exitOverride();
  try {
    await program.parseAsync(['node', 'pi-tin', ...argv]);
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('container-profile delete name validation', () => {
  test('throws CliError(VALIDATION) for an unsafe path-segment name', async () => {
    const program = new Command();
    registerContainerProfileDeleteCommand(program);

    const err = await runAndCatch(program, ['delete', '../escape']);

    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('../escape');
    expect(err.message).toContain('../escape');
  });
});

describe('agent-profile delete name validation', () => {
  test('throws CliError(VALIDATION) for an unsafe path-segment name', async () => {
    const program = new Command();
    registerAgentProfileDeleteCommand(program);

    const err = await runAndCatch(program, ['delete', '../escape']);

    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('../escape');
    expect(err.message).toContain('../escape');
  });
});
