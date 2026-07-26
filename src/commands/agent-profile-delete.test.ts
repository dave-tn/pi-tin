import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgentProfileDeleteCommand } from './agent-profile-delete.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

// Deletion only needs existence, not a parseable profile: a corrupt
// profile.yaml must not turn delete into "not found" (that would make the
// profile undeletable via the CLI). Genuinely missing profiles keep the
// NOT_FOUND envelope. XDG_CONFIG_HOME points at a temp dir so the command
// never touches the real ~/.config/pi-tin; --force skips the prompt.

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-agent-profile-delete-test-'));
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

// JSON mode falls back to TTY detection, so an interactive `bun test` run
// would take the human-output path — pass --json explicitly to keep the
// envelope deterministic. Capture stdout rather than letting it leak into
// the test report, and assert the envelope while we hold it.
async function runAndCatch(
  program: Command,
  argv: string[],
): Promise<{ err: unknown; stdout: string }> {
  program.exitOverride();
  const writes: string[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    await program.parseAsync(['node', 'pi-tin', ...argv]);
    return { err: undefined, stdout: writes.join('') };
  } catch (err) {
    return { err, stdout: writes.join('') };
  } finally {
    write.mockRestore();
  }
}

describe('agent-profile delete', () => {
  test('deletes a profile whose profile.yaml is corrupt', async () => {
    const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'broken');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.yaml'), '{ not: [valid yaml', 'utf-8');

    const program = new Command();
    registerAgentProfileDeleteCommand(program);

    const { err, stdout } = await runAndCatch(program, ['delete', 'broken', '--force', '--json']);

    expect(err).toBeUndefined();
    expect(fs.existsSync(profileDir)).toBe(false);
    expect(JSON.parse(stdout)).toEqual({ action: 'deleted', profile: 'broken' });
  });

  test('throws CliError(NOT_FOUND) for a missing profile', async () => {
    const program = new Command();
    registerAgentProfileDeleteCommand(program);

    const { err, stdout } = await runAndCatch(program, ['delete', 'missing', '--force']);

    // The failure envelope is the CliError itself — nothing is written to the
    // data channel, so an agent never sees a half-success on stdout.
    expect(stdout).toBe('');
    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.NOT_FOUND);
    expect(err.detail.code).toBe('not_found');
    expect(err.message).toBe("Agent profile 'missing' not found.");
  });
});
