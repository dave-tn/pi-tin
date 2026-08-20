import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgentProfileAddCommand } from './agent-profile-add.js';
import { createAgentProfile } from '../lib/agent-profiles.js';
import { KNOWN_AGENTS } from '../lib/agents.js';
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

// A user-authored agent definition. The command reads the merged table itself,
// so the only way to inject a custom agent is a real file under the temp
// XDG_CONFIG_HOME.
const writeAgentDefinition = (name: string, body: string): void => {
  const dir = path.join(tmpDir, 'pi-tin', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), body, 'utf-8');
};

const OH_MY_PI_DEFINITION = [
  'package: oh-my-pi@latest',
  'binary: ohmypi',
  'dot_dirs:',
  '  - .oh-my-pi',
  '',
].join('\n');

describe('agent-profile add', () => {
  // Hand-written literal, not the imported message builder: the remediation
  // tail is the only route from "not in the list" to a custom agent.
  test('rejects an unknown agent as a validation error listing known agents', async () => {
    const program = new Command();
    registerAgentProfileAddCommand(program);

    const err = await runAndCatch(program, ['add', 'mine', '--agent', 'Nonexistent']);

    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('Nonexistent');
    expect(err.detail.validValues).toEqual([
      'Claude Code', 'Pi', 'Codex', 'OpenCode', 'Amp', 'Copilot', 'Crush', 'Antigravity',
    ]);
    expect(err.message).toBe(
      "Unknown agent: 'Nonexistent'. Known agents: Claude Code, Pi, Codex, OpenCode, Amp, Copilot, Crush, "
      + 'Antigravity. To add a custom agent, define it with `pi-tin agent apply <name>` — '
      + '`pi-tin agent show "Claude Code"` prints a template (README: Custom agents).',
    );
  });

  test('lists a custom agent definition among the known agents it rejects against', async () => {
    writeAgentDefinition('oh-my-pi', OH_MY_PI_DEFINITION);
    const program = new Command();
    registerAgentProfileAddCommand(program);

    const err = await runAndCatch(program, ['add', 'mine', '--agent', 'Nonexistent']);

    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.detail.validValues).toContain('oh-my-pi');
    expect(err.message).toContain('Amp, Copilot, Crush, Antigravity, oh-my-pi. To add a custom agent,');
  });

  test('creates a profile for a custom agent defined under the agents dir', async () => {
    writeAgentDefinition('oh-my-pi', OH_MY_PI_DEFINITION);
    const program = new Command();
    registerAgentProfileAddCommand(program);

    const writes: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect(await runAndCatch(program, ['add', 'mine', '--agent', 'oh-my-pi', '--json']))
        .toBeUndefined();
    } finally {
      write.mockRestore();
    }

    const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'mine');
    expect(JSON.parse(writes.join(''))).toEqual({
      action: 'created',
      profile: 'mine',
      agent: 'oh-my-pi',
      mode: 'isolated',
      path: profileDir,
    });
    expect(fs.statSync(path.join(profileDir, '.oh-my-pi')).isDirectory()).toBe(true);
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
    expect(err.message).toBe(
      "Invalid agent profile name '../evil'. "
      + "Names must not be '.' or '..', and must not contain '/' or '\\'.",
    );
    expect(err.detail.remediation).toBe(
      "Names must not be '.' or '..', and must not contain '/' or '\\'.",
    );
  });

  test('already-exists is not a validation error and keeps its real message', async () => {
    createAgentProfile('dupe', 'Pi', 'isolated', KNOWN_AGENTS);

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
