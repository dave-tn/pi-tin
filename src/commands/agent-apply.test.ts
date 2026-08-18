import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import YAML from 'yaml';
import { registerAgentApplyCommand } from './agent-apply.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

// apply writes into ~/.config/pi-tin/agents, so XDG_CONFIG_HOME is pointed at a
// temp dir for every case — the real config dir is never touched. stdin is fed
// by swapping process.stdin for a Readable (the workspace-apply.test.ts
// technique) and stdout is captured so the JSON envelope never leaks into the
// test report.

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-agent-apply-test-'));
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

interface ApplyRun {
  err: unknown;
  envelope: unknown;
  warnings: string[];
}

async function runApply(argv: string[], stdinText: string): Promise<ApplyRun> {
  const program = new Command();
  program.exitOverride();
  registerAgentApplyCommand(program);

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
    let err: unknown;
    try {
      await program.parseAsync(['node', 'pi-tin', ...argv]);
    } catch (thrown) {
      err = thrown;
    }
    return { err, envelope: writes.length > 0 ? JSON.parse(writes.join('')) : undefined, warnings };
  } finally {
    write.mockRestore();
    warn.mockRestore();
    if (stdinDescriptor !== undefined) {
      Object.defineProperty(process, 'stdin', stdinDescriptor);
    }
  }
}

function definitionPath(name: string): string {
  return path.join(tmpDir, 'pi-tin', 'agents', `${name}.yaml`);
}

function writeDefinition(name: string, contents: string): void {
  fs.mkdirSync(path.join(tmpDir, 'pi-tin', 'agents'), { recursive: true });
  fs.writeFileSync(definitionPath(name), contents, 'utf-8');
}

const definitionJson = JSON.stringify({ package: 'oh-my-pi@latest', binary: 'omp' });

function asCliError(err: unknown): CliError {
  if (!(err instanceof CliError)) {
    throw new Error(`expected a CliError, got ${String(err)}`);
  }
  return err;
}

describe('agent apply', () => {
  test('creates a definition from JSON on stdin', async () => {
    const run = await runApply(['apply', 'oh-my-pi'], definitionJson);

    expect(run.err).toBeUndefined();
    expect(run.envelope).toMatchObject({ action: 'created', name: 'oh-my-pi' });
    const envelope = run.envelope as { changes: Array<{ kind: string }> };
    expect(envelope.changes.every((change) => change.kind === 'added')).toBe(true);

    const written: unknown = YAML.parse(fs.readFileSync(definitionPath('oh-my-pi'), 'utf-8'));
    expect(written).toEqual({
      package: 'oh-my-pi@latest',
      binary: 'omp',
      dot_dirs: [],
      host_mode_supported: true,
      install: { method: 'npm' },
      container_env: {},
      isolated_seed_files: [],
    });
    expect(run.warnings).toEqual([]);
  });

  test('updates an existing definition and reports only the real change', async () => {
    writeDefinition('oh-my-pi', 'package: oh-my-pi@latest\nbinary: omp\n');

    const run = await runApply(
      ['apply', 'oh-my-pi'],
      JSON.stringify({ package: 'oh-my-pi@latest', binary: 'omp2' }),
    );

    expect(run.err).toBeUndefined();
    expect(run.envelope).toEqual({
      action: 'updated',
      name: 'oh-my-pi',
      changes: [{ path: 'binary', kind: 'changed', before: 'omp', after: 'omp2' }],
    });

    const written = YAML.parse(fs.readFileSync(definitionPath('oh-my-pi'), 'utf-8')) as {
      binary: string;
    };
    expect(written.binary).toBe('omp2');
  });

  test('--dry-run prints the diff and writes nothing', async () => {
    const run = await runApply(['apply', 'oh-my-pi', '--dry-run'], definitionJson);

    expect(run.err).toBeUndefined();
    expect(run.envelope).toMatchObject({ action: 'create', name: 'oh-my-pi', dryRun: true });
    expect(fs.existsSync(definitionPath('oh-my-pi'))).toBe(false);
  });

  test('a corrupt existing definition degrades the diff base and warns', async () => {
    writeDefinition('broken', '{ unclosed');

    const run = await runApply(['apply', 'broken'], definitionJson);

    expect(run.err).toBeUndefined();
    const envelope = run.envelope as { action: string; changes: Array<{ kind: string }> };
    expect(envelope.action).toBe('updated');
    expect(envelope.changes.every((change) => change.kind === 'added')).toBe(true);
    // Two warnings: the collision check loads the whole definitions dir, which
    // skips the corrupt file with its own warning, then the diff base fails to
    // parse it. Both are about the pre-existing file, not this write.
    expect(run.warnings.length).toBe(2);
    expect(run.warnings[0]).toContain("skipping invalid agent definition 'broken'");
    expect(run.warnings[1]).toContain(
      "existing agent definition 'broken' could not be parsed; apply replaces it",
    );

    const written = YAML.parse(fs.readFileSync(definitionPath('broken'), 'utf-8')) as {
      binary: string;
    };
    expect(written.binary).toBe('omp');
  });

  test('rejects invalid JSON on stdin with exit 2', async () => {
    const run = await runApply(['apply', 'oh-my-pi'], '{ not json');

    const err = asCliError(run.err);
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('invalid_json');
    expect(err.message).toContain('Input on stdin is not valid JSON');
    expect(fs.existsSync(definitionPath('oh-my-pi'))).toBe(false);
  });

  test('rejects a schema-invalid definition and points at a built-in template', async () => {
    const run = await runApply(['apply', 'oh-my-pi'], JSON.stringify({ package: 'oh-my-pi@latest' }));

    const err = asCliError(run.err);
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.message).toContain('Invalid agent definition configuration');
    expect(err.detail.remediation).toBe(
      'Run `pi-tin agent show "Claude Code" --json` to see a valid example object.',
    );
    expect(fs.existsSync(definitionPath('oh-my-pi'))).toBe(false);
  });

  test('rejects an unsafe definition name with exit 2', async () => {
    const run = await runApply(['apply', '../escape'], definitionJson);

    const err = asCliError(run.err);
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('../escape');
    expect(err.message).toBe(
      "Invalid agent definition name '../escape'. Names must not be '.' or '..', and must not contain '/' or '\\'.",
    );
  });

  test('refuses to override a built-in agent by name', async () => {
    const run = await runApply(['apply', 'Claude Code'], definitionJson);

    const err = asCliError(run.err);
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('Claude Code');
    expect(err.message).toBe(
      "Built-in agent 'Claude Code' cannot be overridden; use a different agent name.",
    );
    expect(fs.existsSync(definitionPath('Claude Code'))).toBe(false);
  });

  test('matches built-in names case-insensitively', async () => {
    const run = await runApply(['apply', 'claude code'], definitionJson);

    const err = asCliError(run.err);
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.message).toContain('cannot be overridden');
    expect(fs.existsSync(definitionPath('claude code'))).toBe(false);
  });

  test('refuses to claim a built-in package under a different name', async () => {
    const run = await runApply(
      ['apply', 'claude-code'],
      JSON.stringify({ package: '@anthropic-ai/claude-code@latest', binary: 'claude' }),
    );

    const err = asCliError(run.err);
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.message).toBe(
      "Package '@anthropic-ai/claude-code@latest' belongs to the built-in agent 'Claude Code'.",
    );
    expect(fs.existsSync(definitionPath('claude-code'))).toBe(false);
  });

  // The loader drops one of two definitions sharing a package, so accepting the
  // write here would report success for a file that never takes effect.
  test('refuses a package already claimed by another custom definition', async () => {
    writeDefinition('oh-my-pi', 'package: oh-my-pi@latest\nbinary: omp\n');

    const run = await runApply(
      ['apply', 'oh-my-pi-fork'],
      JSON.stringify({ package: 'oh-my-pi@1.2.3', binary: 'ompf' }),
    );

    const err = asCliError(run.err);
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('oh-my-pi@1.2.3');
    expect(err.message).toBe(
      "Package 'oh-my-pi@1.2.3' is already defined by the agent definition 'oh-my-pi'.",
    );
    expect(fs.existsSync(definitionPath('oh-my-pi-fork'))).toBe(false);
  });

  // The name-collision guard in the loader filters this very variant out of the
  // package check, and `agentDefinitionExists` folds case, so before the write
  // guard existed this reported a clean 'updated' while replacing 'oh-my-pi'.
  test('refuses a name that differs from an existing definition only by case', async () => {
    writeDefinition('oh-my-pi', 'package: oh-my-pi@latest\nbinary: omp\n');

    const run = await runApply(['apply', 'Oh-My-Pi'], definitionJson);

    const err = asCliError(run.err);
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.detail.badInput).toBe('Oh-My-Pi');
    expect(err.message).toBe(
      "Agent definition 'Oh-My-Pi' differs only by case from the existing 'oh-my-pi'; delete 'oh-my-pi' first, or choose another name.",
    );
    // Not `existsSync(definitionPath('Oh-My-Pi'))`: on a case-insensitive
    // volume that folds onto the existing file and answers true. Compare the
    // stored stems, for the same reason the guard itself enumerates them.
    const stems = fs.readdirSync(path.join(tmpDir, 'pi-tin', 'agents'));
    expect(stems).toContain('oh-my-pi.yaml');
    expect(stems).not.toContain('Oh-My-Pi.yaml');
    expect(fs.readFileSync(definitionPath('oh-my-pi'), 'utf-8')).toBe(
      'package: oh-my-pi@latest\nbinary: omp\n',
    );
  });

  // The check precedes the exists/diff computation, so --dry-run refuses too
  // rather than printing a create diff against an empty baseline.
  test('refuses the case-variant under --dry-run as well', async () => {
    writeDefinition('oh-my-pi', 'package: oh-my-pi@latest\nbinary: omp\n');

    const run = await runApply(['apply', 'Oh-My-Pi', '--dry-run'], definitionJson);

    const err = asCliError(run.err);
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.message).toBe(
      "Agent definition 'Oh-My-Pi' differs only by case from the existing 'oh-my-pi'; delete 'oh-my-pi' first, or choose another name.",
    );
    expect(run.envelope).toBeUndefined();
  });

  test('matches built-in packages with a different version suffix', async () => {
    const run = await runApply(
      ['apply', 'claude-code'],
      JSON.stringify({ package: '@anthropic-ai/claude-code@2.0.0', binary: 'claude' }),
    );

    const err = asCliError(run.err);
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.message).toBe(
      "Package '@anthropic-ai/claude-code@2.0.0' belongs to the built-in agent 'Claude Code'.",
    );
  });
});
