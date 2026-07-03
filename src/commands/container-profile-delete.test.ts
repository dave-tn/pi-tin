import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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

async function runAndCatch(program: Command, argv: string[]): Promise<unknown> {
  program.exitOverride();
  try {
    await program.parseAsync(['node', 'pi-tin', ...argv]);
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('container-profile delete', () => {
  test('deletes a profile whose YAML fails schema validation', async () => {
    const profilesDir = path.join(tmpDir, 'pi-tin', 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    const profilePath = path.join(profilesDir, 'broken.yaml');
    fs.writeFileSync(profilePath, 'description: 123\n', 'utf-8');

    const program = new Command();
    registerContainerProfileDeleteCommand(program);

    const err = await runAndCatch(program, ['delete', 'broken', '--force']);

    expect(err).toBeUndefined();
    expect(fs.existsSync(profilePath)).toBe(false);
  });

  test('deletes a profile whose YAML is unparseable', async () => {
    const profilesDir = path.join(tmpDir, 'pi-tin', 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    const profilePath = path.join(profilesDir, 'garbled.yaml');
    fs.writeFileSync(profilePath, '{ not: [valid yaml', 'utf-8');

    const program = new Command();
    registerContainerProfileDeleteCommand(program);

    const err = await runAndCatch(program, ['delete', 'garbled', '--force']);

    expect(err).toBeUndefined();
    expect(fs.existsSync(profilePath)).toBe(false);
  });

  test('throws CliError(NOT_FOUND) for a missing profile', async () => {
    const program = new Command();
    registerContainerProfileDeleteCommand(program);

    const err = await runAndCatch(program, ['delete', 'missing', '--force']);

    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.NOT_FOUND);
    expect(err.detail.code).toBe('not_found');
  });
});
