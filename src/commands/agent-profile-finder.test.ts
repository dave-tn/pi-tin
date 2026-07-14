import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgentProfileFinderCommand } from './agent-profile-finder.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

// finder gates on a TTY before any other work — headless it would otherwise
// exit 0 after silently opening a Finder window on the host. The refusal
// fires before config access or the `open` spawn, so the test never touches
// Finder. XDG_CONFIG_HOME still points at a temp dir as a backstop so a
// regression cannot read the real ~/.config/pi-tin.

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-finder-test-'));
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

async function runAndCatch(program: Command, argv: string[]): Promise<unknown> {
  program.exitOverride();
  try {
    await program.parseAsync(['node', 'pi-tin', ...argv]);
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('agent-profile finder — headless', () => {
  test('refuses without a TTY before touching Finder', async () => {
    const restoreTty = setSessionTty(false);
    try {
      const program = new Command();
      registerAgentProfileFinderCommand(program);

      const err = await runAndCatch(program, ['finder']);

      expect(err).toBeInstanceOf(CliError);
      if (!(err instanceof CliError)) throw new Error('unreachable');
      expect(err.exitCode).toBe(EXIT.GENERAL);
      expect(err.detail.code).toBe('interactive_only');
    } finally {
      restoreTty();
    }
  });
});
