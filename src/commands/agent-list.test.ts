import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProgram } from '../cli-program.js';
import { KNOWN_AGENTS } from '../lib/agents.js';

// The listing merges the built-in table with user definitions, so it must run
// against a temp XDG_CONFIG_HOME — never the real ~/.config/pi-tin.

const meta = { version: '0.0.0-test', homepage: 'https://example.invalid' };

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-agent-list-test-'));
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

// JSON mode otherwise falls back to TTY detection, so --json is passed
// explicitly. stdout is captured rather than left to leak into the test report,
// and console.warn is captured to prove load warnings never reach the data
// channel.
async function run(argv: string[], isTty = false): Promise<{ stdout: string; warnings: string[]; logs: string[] }> {
  const writes: string[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  const originalTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: isTty, configurable: true });
  const write = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  try {
    await buildProgram(meta).parseAsync(argv, { from: 'user' });
    return { stdout: writes.join(''), warnings, logs };
  } finally {
    log.mockRestore();
    warn.mockRestore();
    write.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', originalTty ?? { value: undefined, configurable: true });
  }
}

describe('agent list', () => {
  test('--json lists built-ins then customs, tagged by source', async () => {
    writeDefinition('oh-my-pi', 'package: oh-my-pi@latest\nbinary: omp\ndot_dirs:\n  - .oh-my-pi\nskip_permissions_flag: --yolo\n');
    // A sibling that cannot be used must not take the listing down, nor pollute
    // the data channel with its warning.
    writeDefinition('broken', '{ not: [valid yaml\n');

    const { stdout, warnings } = await run(['agent', 'list', '--json']);

    const entries: Array<Record<string, unknown>> = JSON.parse(stdout);
    expect(
      entries.filter((entry) => entry['source'] === 'builtin').map((entry) => entry['name']),
    ).toEqual(KNOWN_AGENTS.map((agent) => agent.name));
    expect(entries.at(-1)).toEqual({
      name: 'oh-my-pi',
      source: 'custom',
      package: 'oh-my-pi@latest',
      binary: 'omp',
      dot_dirs: ['.oh-my-pi'],
      install: { method: 'npm' },
      skip_permissions_flag: '--yolo',
      host_mode_supported: true,
    });
    expect(warnings.join('\n')).toContain('broken');
    expect(stdout).not.toContain('broken');
  });

  test('--json omits skip_permissions_flag for an agent that has none', async () => {
    writeDefinition('zz-agent', 'package: zz-agent@latest\nbinary: zz\n');

    const { stdout } = await run(['agent', 'list', '--json']);

    const entries: Array<Record<string, unknown>> = JSON.parse(stdout);
    expect(entries.at(-1)).toEqual({
      name: 'zz-agent',
      source: 'custom',
      package: 'zz-agent@latest',
      binary: 'zz',
      dot_dirs: [],
      install: { method: 'npm' },
      host_mode_supported: true,
    });
  });

  test('prints an aligned table with a source column on a TTY', async () => {
    writeDefinition('oh-my-pi', 'package: oh-my-pi@latest\nbinary: omp\n');

    const { logs } = await run(['agent', 'list'], true);

    const output = logs.join('\n');
    expect(logs[0]).toContain('NAME');
    expect(logs[0]).toContain('SOURCE');
    expect(logs[0]).toContain('PACKAGE');
    expect(output).toContain('Claude Code');
    expect(output).toContain('builtin');
    expect(output).toContain('oh-my-pi');
    expect(output).toContain('custom');
  });
});
