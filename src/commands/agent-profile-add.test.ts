import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgentProfileAddCommand } from './agent-profile-add.js';
import { createAgentProfile } from '../lib/agent-profiles.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

// The validation envelope (exit 2, validValues) is reserved for genuinely
// invalid input: an unknown agent or an unsafe profile name. Everything else
// createAgentProfile throws — already exists, host mode unsupported, I/O —
// must surface its real message via the general error path, not be relabeled
// "validation". Success emits a JSON envelope in JSON mode, like the sibling
// delete command. XDG_CONFIG_HOME points at a temp dir so the command never
// touches the real ~/.config/pi-tin.

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-agent-profile-add-test-'));
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

describe('agent-profile add', () => {
  test('rejects an unknown agent as a validation error listing known agents', async () => {
    const program = new Command();
    registerAgentProfileAddCommand(program);

    const err = await runAndCatch(program, ['add', 'mine', '--agent', 'Nonexistent']);

    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('Nonexistent');
    expect(err.detail.validValues).toContain('Claude Code');
    expect(err.message).toContain("Unknown agent: 'Nonexistent'");
  });

  test('rejects an unsafe profile name as a validation error', async () => {
    const program = new Command();
    registerAgentProfileAddCommand(program);

    const err = await runAndCatch(program, ['add', '../evil', '--agent', 'Pi']);

    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('../evil');
  });

  test('already-exists is not a validation error and keeps its real message', async () => {
    createAgentProfile('dupe', 'Pi', 'isolated');

    const program = new Command();
    registerAgentProfileAddCommand(program);

    const err = await runAndCatch(program, ['add', 'dupe', '--agent', 'Pi']);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CliError);
    if (!(err instanceof Error)) throw new Error('unreachable');
    expect(err.message).toContain("Agent profile 'dupe' already exists");
  });

  test('success with --json emits the created envelope on stdout', async () => {
    const program = new Command();
    registerAgentProfileAddCommand(program);

    const writes: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const err = await runAndCatch(program, ['add', 'fresh', '--agent', 'Pi', '--json']);
      expect(err).toBeUndefined();
    } finally {
      write.mockRestore();
    }

    const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'fresh');
    expect(JSON.parse(writes.join(''))).toEqual({
      action: 'created',
      profile: 'fresh',
      agent: 'Pi',
      mode: 'isolated',
      path: profileDir,
    });
    expect(fs.existsSync(path.join(profileDir, 'profile.yaml'))).toBe(true);
  });
});
