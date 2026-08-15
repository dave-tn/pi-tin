import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgentDeleteCommand } from './agent-delete.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

// Delete is existence-first: a file in ~/.config/pi-tin/agents is a custom
// definition by construction, so it stays deletable even when its name shadows
// a built-in or its YAML is corrupt. Only when nothing is on disk does a
// built-in name explain the refusal. XDG_CONFIG_HOME points at a temp dir for
// every case so the real config dir is never touched, and both TTY flags are
// pinned so JSON mode and the confirmation gate never depend on how the suite
// was launched.

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-agent-delete-test-'));
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

const CUSTOM_DEFINITION =
  'package: oh-my-pi@latest\nbinary: omp\ndot_dirs:\n  - .oh-my-pi\nskip_permissions_flag: --yolo\n';

function definitionPath(name: string): string {
  return path.join(tmpDir, 'pi-tin', 'agents', `${name}.yaml`);
}

function writeDefinition(name: string, contents: string): void {
  fs.mkdirSync(path.join(tmpDir, 'pi-tin', 'agents'), { recursive: true });
  fs.writeFileSync(definitionPath(name), contents, 'utf-8');
}

function writeWorkspace(name: string, toolPackage: string): void {
  const dir = path.join(tmpDir, 'pi-tin', 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.yaml`),
    `profile: node-dev\nprojects: []\ntools:\n  - name: Oh My Pi\n    package: ${toolPackage}\n`,
    'utf-8',
  );
}

function writeAgentProfile(name: string, agent: string): void {
  const dir = path.join(tmpDir, 'pi-tin', 'agent-profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'profile.yaml'),
    `agent: ${agent}\nmode: isolated\nmounts:\n  - .oh-my-pi\n`,
    'utf-8',
  );
}

interface DeleteRun {
  err: unknown;
  stdout: string;
  logs: string[];
  warnings: string[];
}

// isTty drives both JSON-mode detection and the confirmation gate: false is the
// agent/CI shape (JSON envelope, exit 4 without --force), true is the human
// shape (text output, prompt unless --force).
async function run(argv: string[], isTty = false): Promise<DeleteRun> {
  const program = new Command();
  program.exitOverride();
  registerAgentDeleteCommand(program);

  const originalStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: isTty, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: isTty, configurable: true });

  const writes: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  const warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });

  try {
    let err: unknown;
    try {
      await program.parseAsync(['node', 'pi-tin', ...argv]);
    } catch (thrown) {
      err = thrown;
    }
    return { err, stdout: writes.join(''), logs, warnings };
  } finally {
    warn.mockRestore();
    log.mockRestore();
    write.mockRestore();
    Object.defineProperty(
      process.stdout,
      'isTTY',
      originalStdoutTty ?? { value: undefined, configurable: true },
    );
    Object.defineProperty(
      process.stdin,
      'isTTY',
      originalStdinTty ?? { value: undefined, configurable: true },
    );
  }
}

function expectCliError(err: unknown): CliError {
  expect(err).toBeInstanceOf(CliError);
  if (!(err instanceof CliError)) throw new Error('unreachable');
  return err;
}

describe('agent delete', () => {
  test('refuses a built-in agent name that has no definition file', async () => {
    const { err, stdout } = await run(['delete', 'Claude Code', '--force', '--json']);

    expect(stdout).toBe('');
    const cliErr = expectCliError(err);
    expect(cliErr.exitCode).toBe(EXIT.VALIDATION);
    expect(cliErr.detail.code).toBe('validation');
    expect(cliErr.message).toBe(
      "Built-in agent 'Claude Code' cannot be deleted; it is part of pi-tin.",
    );
  });

  test('reports an unknown name as not found', async () => {
    const { err, stdout } = await run(['delete', 'missing', '--force', '--json']);

    expect(stdout).toBe('');
    const cliErr = expectCliError(err);
    expect(cliErr.exitCode).toBe(EXIT.NOT_FOUND);
    expect(cliErr.detail.code).toBe('not_found');
    expect(cliErr.message).toBe("Agent definition 'missing' not found.");
  });

  test('deletes a custom definition whose name matches a built-in', async () => {
    // apply refuses to write this, but the file is hand-editable YAML — the
    // user can create it, so delete must be able to remove it again.
    writeDefinition('Claude Code', CUSTOM_DEFINITION);

    const { err, stdout } = await run(['delete', 'Claude Code', '--force', '--json']);

    expect(err).toBeUndefined();
    expect(fs.existsSync(definitionPath('Claude Code'))).toBe(false);
    expect(JSON.parse(stdout)).toEqual({ action: 'deleted', definition: 'Claude Code' });
  });

  test('--dry-run --json reports the workspace and agent-profile impact', async () => {
    writeDefinition('oh-my-pi', CUSTOM_DEFINITION);
    writeWorkspace('ws-a', 'oh-my-pi@1.2.3');
    writeWorkspace('ws-b', 'something-else@latest');
    writeAgentProfile('omp', 'OH-MY-PI');

    const { err, stdout } = await run(['delete', 'oh-my-pi', '--dry-run', '--json']);

    expect(err).toBeUndefined();
    expect(fs.existsSync(definitionPath('oh-my-pi'))).toBe(true);
    const parsed: Record<string, unknown> = JSON.parse(stdout);
    expect(parsed).toEqual({
      name: 'oh-my-pi',
      referencedBy: ['ws-a'],
      agentProfiles: ['omp'],
      dryRun: true,
    });
    // The impact is not a built-in verdict: that is a pre-check, so no such
    // key may leak into the envelope agents parse.
    expect('builtIn' in parsed).toBe(false);
  });

  test('--dry-run text names the workspaces and profiles', async () => {
    writeDefinition('oh-my-pi', CUSTOM_DEFINITION);
    writeWorkspace('ws-a', 'oh-my-pi@latest');
    writeAgentProfile('omp', 'oh-my-pi');

    const { err, logs } = await run(['delete', 'oh-my-pi', '--dry-run'], true);

    expect(err).toBeUndefined();
    const printed = logs.join('\n');
    expect(printed).toContain("Would delete agent definition 'oh-my-pi'.");
    expect(printed).toContain('  Referenced by workspace(s): ws-a');
    expect(printed).toContain('  Agent profile(s): omp');
    expect(printed).not.toContain('workspace references not checked');
  });

  test('an unreadable definition still reports the profile half of the impact', async () => {
    writeDefinition('oh-my-pi', '{ not: [valid yaml\n');
    writeWorkspace('ws-a', 'oh-my-pi@latest');
    writeAgentProfile('omp', 'oh-my-pi');

    const { err, stdout } = await run(['delete', 'oh-my-pi', '--dry-run', '--json']);

    expect(err).toBeUndefined();
    // The package is unknowable, so workspace references cannot be checked —
    // reported as empty rather than guessed.
    expect(JSON.parse(stdout)).toEqual({
      name: 'oh-my-pi',
      referencedBy: [],
      agentProfiles: ['omp'],
      dryRun: true,
    });
  });

  test('--dry-run text caveats an unreadable definition', async () => {
    writeDefinition('oh-my-pi', 'package: 123\n');
    writeAgentProfile('omp', 'oh-my-pi');

    const { err, logs } = await run(['delete', 'oh-my-pi', '--dry-run'], true);

    expect(err).toBeUndefined();
    const printed = logs.join('\n');
    expect(printed).toContain("Would delete agent definition 'oh-my-pi'.");
    expect(printed).toContain('  Agent profile(s): omp');
    expect(printed).toContain(
      '  Warning: definition unreadable; workspace references not checked.',
    );
    expect(printed).not.toContain('Referenced by workspace(s)');
  });

  test('deletes an unreadable definition, warning that references were not checked', async () => {
    writeDefinition('oh-my-pi', '{ not: [valid yaml\n');

    const { err, logs, warnings } = await run(['delete', 'oh-my-pi', '--force'], true);

    expect(err).toBeUndefined();
    expect(fs.existsSync(definitionPath('oh-my-pi'))).toBe(false);
    expect(warnings.join('\n')).toContain(
      'Warning: definition unreadable; workspace references not checked.',
    );
    expect(logs.join('\n')).toContain("✔ Deleted agent definition 'oh-my-pi'");
  });

  test('warns about referencing workspaces before deleting', async () => {
    writeDefinition('oh-my-pi', CUSTOM_DEFINITION);
    writeWorkspace('ws-a', 'oh-my-pi@latest');

    const { err, warnings } = await run(['delete', 'oh-my-pi', '--force'], true);

    expect(err).toBeUndefined();
    expect(fs.existsSync(definitionPath('oh-my-pi'))).toBe(false);
    expect(warnings.join('\n')).toContain(
      "Warning: agent definition 'oh-my-pi' is referenced by workspace(s): ws-a",
    );
  });

  test('--force deletes without prompting when no human is attached', async () => {
    writeDefinition('oh-my-pi', CUSTOM_DEFINITION);

    const { err, stdout } = await run(['delete', 'oh-my-pi', '--force', '--json']);

    expect(err).toBeUndefined();
    expect(fs.existsSync(definitionPath('oh-my-pi'))).toBe(false);
    expect(JSON.parse(stdout)).toEqual({ action: 'deleted', definition: 'oh-my-pi' });
  });

  test('refuses non-interactively without --force', async () => {
    writeDefinition('oh-my-pi', CUSTOM_DEFINITION);

    const { err, stdout } = await run(['delete', 'oh-my-pi', '--json']);

    expect(stdout).toBe('');
    expect(fs.existsSync(definitionPath('oh-my-pi'))).toBe(true);
    const cliErr = expectCliError(err);
    expect(cliErr.exitCode).toBe(EXIT.CONFIRMATION_REQUIRED);
    expect(cliErr.detail.code).toBe('confirmation_required');
  });
});
