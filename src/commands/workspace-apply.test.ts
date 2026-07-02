import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import YAML from 'yaml';
import { registerWorkspaceApplyCommand } from './workspace-apply.js';
import { registerContainerProfileApplyCommand } from './container-profile-apply.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

// The apply actions validate <name> up front (before reading stdin) so a bad
// name surfaces as a CliError(VALIDATION) on the documented structured-error
// path, not a plain Error that the top-level handler would treat as GENERAL.
// We drive the real registered action via commander's parseAsync; the throw
// fires before readStdin, so no stdin is needed. XDG_CONFIG_HOME is pointed at
// a temp dir so ensureInitialised never touches the real ~/.config/pi-tin.

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-apply-test-'));
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

describe('workspace apply name validation', () => {
  test('throws CliError(VALIDATION) for an invalid workspace name', async () => {
    const program = new Command();
    registerWorkspaceApplyCommand(program);

    const err = await runAndCatch(program, ['apply', 'Bad Name']);

    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('Bad Name');
    expect(err.message).toContain('Bad Name');
  });
});

describe('container-profile apply name validation', () => {
  test('throws CliError(VALIDATION) for an unsafe path-segment name', async () => {
    const program = new Command();
    registerContainerProfileApplyCommand(program);

    const err = await runAndCatch(program, ['apply', '../escape']);

    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('../escape');
    expect(err.message).toContain('../escape');
  });
});

// apply is a full replace, so a corrupt existing file must not block the
// write — that is exactly when a full replace is the repair. The diff base
// degrades to {} (everything reads as added, like a create) and the real
// parse error surfaces as a warning on stderr; stdout stays pure JSON.

interface ApplyRun {
  err: unknown;
  envelope: unknown;
  warnings: string[];
}

async function runApplyWithStdin(
  program: Command,
  argv: string[],
  stdinText: string,
): Promise<ApplyRun> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', {
    value: Readable.from([stdinText]),
    configurable: true,
  });
  const writes: string[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const warnings: string[] = [];
  const warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  try {
    const err = await runAndCatch(program, argv);
    return { err, envelope: writes.length > 0 ? JSON.parse(writes.join('')) : undefined, warnings };
  } finally {
    write.mockRestore();
    warn.mockRestore();
    if (stdinDescriptor !== undefined) {
      Object.defineProperty(process, 'stdin', stdinDescriptor);
    }
  }
}

const workspaceJson = JSON.stringify({ profile: 'node-dev', projects: ['/tmp/proj'] });

describe('workspace apply on a corrupt existing file', () => {
  test('replaces the file, degrades the diff, and warns with the real parse error', async () => {
    const workspacesDir = path.join(tmpDir, 'pi-tin', 'workspaces');
    fs.mkdirSync(workspacesDir, { recursive: true });
    const wsPath = path.join(workspacesDir, 'broken.yaml');
    fs.writeFileSync(wsPath, '{ unclosed', 'utf-8');

    const program = new Command();
    registerWorkspaceApplyCommand(program);
    const run = await runApplyWithStdin(program, ['apply', 'broken'], workspaceJson);

    expect(run.err).toBeUndefined();
    const envelope = run.envelope as { action: string; name: string; changes: Array<{ kind: string }> };
    expect(envelope.action).toBe('updated');
    expect(envelope.name).toBe('broken');
    expect(envelope.changes.length).toBeGreaterThan(0);
    expect(envelope.changes.every((change) => change.kind === 'added')).toBe(true);

    const written = YAML.parse(fs.readFileSync(wsPath, 'utf-8')) as { profile: string };
    expect(written.profile).toBe('node-dev');

    expect(run.warnings.length).toBe(1);
    expect(run.warnings[0]).toContain("workspace 'broken'");
    expect(run.warnings[0]).toContain('Failed to parse YAML');
  });

  test('a nonexistent file is still a create with no warning', async () => {
    const program = new Command();
    registerWorkspaceApplyCommand(program);
    const run = await runApplyWithStdin(program, ['apply', 'fresh'], workspaceJson);

    expect(run.err).toBeUndefined();
    const envelope = run.envelope as { action: string; name: string };
    expect(envelope.action).toBe('created');
    expect(envelope.name).toBe('fresh');
    expect(run.warnings).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'pi-tin', 'workspaces', 'fresh.yaml'))).toBe(true);
  });
});

describe('container-profile apply on a corrupt existing file', () => {
  test('replaces the file, degrades the diff, and warns with the real parse error', async () => {
    const profilesDir = path.join(tmpDir, 'pi-tin', 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    const profilePath = path.join(profilesDir, 'broken.yaml');
    fs.writeFileSync(profilePath, '{ unclosed', 'utf-8');

    const profileJson = JSON.stringify({
      description: 'repaired',
      base_image: 'debian:trixie-slim',
      user: 'dev',
    });
    const program = new Command();
    registerContainerProfileApplyCommand(program);
    const run = await runApplyWithStdin(program, ['apply', 'broken'], profileJson);

    expect(run.err).toBeUndefined();
    const envelope = run.envelope as { action: string; name: string; changes: Array<{ kind: string }> };
    expect(envelope.action).toBe('updated');
    expect(envelope.name).toBe('broken');
    expect(envelope.changes.length).toBeGreaterThan(0);
    expect(envelope.changes.every((change) => change.kind === 'added')).toBe(true);

    const written = YAML.parse(fs.readFileSync(profilePath, 'utf-8')) as { description: string };
    expect(written.description).toBe('repaired');

    expect(run.warnings.length).toBe(1);
    expect(run.warnings[0]).toContain("container profile 'broken'");
    expect(run.warnings[0]).toContain('Failed to parse YAML');
  });
});
