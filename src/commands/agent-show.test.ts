import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProgram } from '../cli-program.js';
import { findBuiltInByName } from '../lib/agents.js';
import { validateAgentDefinition } from '../lib/validators.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

// `agent show` merges built-ins with user definitions, so it must run against
// a temp XDG_CONFIG_HOME — never the real ~/.config/pi-tin.

const meta = { version: '0.0.0-test', homepage: 'https://example.invalid' };

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-agent-show-test-'));
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

function writeDefinition(name: string, contents: string): void {
  const dir = path.join(tmpDir, 'pi-tin', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), contents, 'utf-8');
}

// Output is always JSON, but --json is still passed to keep the invocation
// contract-shaped. console.warn is captured so definition-load warnings stay
// out of the test report and can be asserted on.
async function run(argv: string[]): Promise<{ stdout: string; warnings: string[]; error: unknown }> {
  const writes: string[] = [];
  const warnings: string[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  try {
    await buildProgram(meta).parseAsync(argv, { from: 'user' });
    return { stdout: writes.join(''), warnings, error: undefined };
  } catch (err) {
    return { stdout: writes.join(''), warnings, error: err };
  } finally {
    write.mockRestore();
    warn.mockRestore();
  }
}

describe('agent show', () => {
  test('emits a built-in in exactly the agent-definition file shape', async () => {
    const { stdout, warnings, error } = await run(['agent', 'show', 'Claude Code', '--json']);

    expect(error).toBeUndefined();
    expect(warnings).toEqual([]);
    const shown: unknown = JSON.parse(stdout);
    // Round-trip proof: the strict apply schema accepts the output verbatim.
    const definition = validateAgentDefinition(shown);
    const builtIn = findBuiltInByName('Claude Code');
    if (builtIn === undefined) throw new Error('unreachable');
    expect(definition.package).toBe(builtIn.package);
    expect(definition.binary).toBe(builtIn.binary);
    // Identity fields stay out of the payload: name is the apply argument,
    // source is a listing concern.
    expect(Object.keys(shown as Record<string, unknown>)).not.toContain('name');
    expect(Object.keys(shown as Record<string, unknown>)).not.toContain('source');
  });

  test('emits a custom definition with schema defaults applied', async () => {
    writeDefinition('oh-my-pi', [
      'package: oh-my-pi@latest',
      'binary: omp',
      'dot_dirs: [.oh-my-pi]',
    ].join('\n'));

    const { stdout, warnings, error } = await run(['agent', 'show', 'oh-my-pi', '--json']);

    expect(error).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(JSON.parse(stdout)).toEqual({
      package: 'oh-my-pi@latest',
      binary: 'omp',
      dot_dirs: ['.oh-my-pi'],
      host_mode_supported: true,
      install: { method: 'npm' },
      container_env: {},
      api_key_vars: [],
      isolated_seed_files: [],
    });
  });

  test('resolves the name case-insensitively', async () => {
    const { stdout, error } = await run(['agent', 'show', 'claude code', '--json']);

    expect(error).toBeUndefined();
    const definition = validateAgentDefinition(JSON.parse(stdout));
    expect(definition.package).toBe('@anthropic-ai/claude-code@latest');
  });

  test('unknown agent exits 3 with the not_found envelope listing every agent', async () => {
    writeDefinition('oh-my-pi', 'package: oh-my-pi@latest\nbinary: omp\n');

    const { error } = await run(['agent', 'show', 'Nonexistent', '--json']);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error('unreachable');
    expect(error.exitCode).toBe(EXIT.NOT_FOUND);
    expect(error.detail.code).toBe('not_found');
    expect(error.detail.badInput).toBe('Nonexistent');
    expect(error.detail.validValues).toEqual([
      'Claude Code', 'Pi', 'Codex', 'OpenCode', 'Amp', 'Copilot', 'Crush', 'Antigravity', 'oh-my-pi',
    ]);
    expect(error.message).toBe(
      "Agent 'Nonexistent' not found. Available: Claude Code, Pi, Codex, OpenCode, Amp, "
      + 'Copilot, Crush, Antigravity, oh-my-pi',
    );
  });

  test('an invalid definition file surfaces its real parse error, not not_found', async () => {
    writeDefinition('broken', 'package: oh-my-pi@latest\nbinary: "bad name!"\n');

    const { stdout, error } = await run(['agent', 'show', 'broken', '--json']);

    expect(stdout).toBe('');
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CliError);
    if (!(error instanceof Error)) throw new Error('unreachable');
    // Hand-written literal, not the imported message builder, so a regression
    // that collapses field errors into a generic sentence fails here.
    expect(error.message).toBe(
      'Invalid agent definition configuration:\n'
      + '  binary: Invalid format: Expected /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/ but received "bad name!"',
    );
  });

  test('a collision-skipped definition reports not_found with the skip warning on stderr', async () => {
    // Valid file, but its package belongs to a built-in, so the loader drops
    // it from the merged table with a warning.
    writeDefinition('shadow', 'package: "@anthropic-ai/claude-code@latest"\nbinary: shadow\n');

    const { warnings, error } = await run(['agent', 'show', 'shadow', '--json']);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error('unreachable');
    expect(error.detail.code).toBe('not_found');
    // The exact warning literal is pinned in agent-definitions.test.ts; here
    // the subject is that show does not swallow it.
    expect(warnings.join('\n')).toContain("skipping agent definition 'shadow'");
  });
});
