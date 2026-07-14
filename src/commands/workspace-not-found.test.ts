import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerOpenCommand } from './open.js';
import { registerDeleteCommand } from './delete.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

// open and delete map a missing workspace onto the documented structured-error
// path (exit 3, NOT_FOUND envelope) — the same contract as `show` — instead of
// flattening to prose exit 1. The throw fires before any container
// interaction, so no container CLI is needed. XDG_CONFIG_HOME points at a temp
// dir so nothing touches the real ~/.config/pi-tin.

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-not-found-test-'));
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

// open gates on a TTY before any other work, so its tests must pin isTTY on
// both sides: faked true to reach the not-found path, forced false so the
// headless refusal test doesn't depend on how the test runner was invoked.
function setIsTty(stream: typeof process.stdin | typeof process.stdout, value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(stream, 'isTTY');
  Object.defineProperty(stream, 'isTTY', { value, configurable: true });
  return () => {
    Object.defineProperty(stream, 'isTTY', original ?? { value: undefined, configurable: true });
  };
}

function setSessionTty(value: boolean): () => void {
  const restores = [setIsTty(process.stdin, value), setIsTty(process.stdout, value)];
  return () => restores.forEach((restore) => restore());
}

function expectNotFound(err: unknown, name: string): void {
  expect(err).toBeInstanceOf(CliError);
  if (!(err instanceof CliError)) throw new Error('unreachable');
  expect(err.exitCode).toBe(EXIT.NOT_FOUND);
  expect(err.detail.code).toBe('not_found');
  expect(err.detail.badInput).toBe(name);
  expect(err.message).toContain(`Workspace '${name}' not found`);
}

describe('open — missing workspace', () => {
  test('throws CliError(NOT_FOUND)', async () => {
    const restoreTty = setSessionTty(true);
    try {
      const program = new Command();
      registerOpenCommand(program);

      const err = await runAndCatch(program, ['open', 'ghost']);

      expectNotFound(err, 'ghost');
    } finally {
      restoreTty();
    }
  });
});

describe('open — headless', () => {
  test('refuses without a TTY before any workspace lookup', async () => {
    const restoreTty = setSessionTty(false);
    try {
      const program = new Command();
      registerOpenCommand(program);

      const err = await runAndCatch(program, ['open', 'ghost']);

      expect(err).toBeInstanceOf(CliError);
      if (!(err instanceof CliError)) throw new Error('unreachable');
      expect(err.exitCode).toBe(EXIT.GENERAL);
      expect(err.detail.code).toBe('interactive_only');
    } finally {
      restoreTty();
    }
  });
});

describe('delete — missing workspace', () => {
  test('throws CliError(NOT_FOUND)', async () => {
    const program = new Command();
    registerDeleteCommand(program);

    const err = await runAndCatch(program, ['delete', 'ghost']);

    expectNotFound(err, 'ghost');
  });
});
