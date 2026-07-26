import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerContainerProfileDeleteCommand } from './container-profile-delete.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

// Deletion only needs existence, not a parseable profile: a corrupt or
// schema-invalid YAML file must not turn delete into "not found" (that would
// make the profile undeletable via the CLI). Genuinely missing profiles keep
// the NOT_FOUND envelope. XDG_CONFIG_HOME points at a temp dir so the command
// never touches the real ~/.config/pi-tin; --force skips the prompt.

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-container-profile-delete-test-'));
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

// `shouldEmitJson` turns JSON output on automatically without a TTY, so every
// run here emits an envelope. Capture stdout rather than letting it leak into
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

describe('container-profile delete', () => {
  test('deletes a profile whose YAML fails schema validation', async () => {
    const profilesDir = path.join(tmpDir, 'pi-tin', 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    const profilePath = path.join(profilesDir, 'broken.yaml');
    fs.writeFileSync(profilePath, 'description: 123\n', 'utf-8');

    const program = new Command();
    registerContainerProfileDeleteCommand(program);

    const { err, stdout } = await runAndCatch(program, ['delete', 'broken', '--force']);

    expect(err).toBeUndefined();
    expect(fs.existsSync(profilePath)).toBe(false);
    expect(JSON.parse(stdout)).toEqual({ action: 'deleted', profile: 'broken' });
  });

  test('deletes a profile whose YAML is unparseable', async () => {
    const profilesDir = path.join(tmpDir, 'pi-tin', 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    const profilePath = path.join(profilesDir, 'garbled.yaml');
    fs.writeFileSync(profilePath, '{ not: [valid yaml', 'utf-8');

    const program = new Command();
    registerContainerProfileDeleteCommand(program);

    const { err, stdout } = await runAndCatch(program, ['delete', 'garbled', '--force']);

    expect(err).toBeUndefined();
    expect(fs.existsSync(profilePath)).toBe(false);
    expect(JSON.parse(stdout)).toEqual({ action: 'deleted', profile: 'garbled' });
  });

  test('throws CliError(NOT_FOUND) for a missing profile', async () => {
    const program = new Command();
    registerContainerProfileDeleteCommand(program);

    const { err, stdout } = await runAndCatch(program, ['delete', 'missing', '--force']);

    // The failure envelope is the CliError itself — nothing is written to the
    // data channel, so an agent never sees a half-success on stdout.
    expect(stdout).toBe('');
    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.NOT_FOUND);
    expect(err.detail.code).toBe('not_found');
    expect(err.message).toBe("Container profile 'missing' not found.");
  });
});
