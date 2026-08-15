import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  agentDefinitionExists,
  allAgents,
  deleteAgentDefinition,
  loadAgentDefinition,
  loadAgentDefinitions,
  planAgentDelete,
  writeAgentDefinition,
} from './agent-definitions.js';
import { KNOWN_AGENTS } from './agents.js';
import type { AgentDefinitionFile } from './validators.js';

const MINIMAL_YAML = 'package: oh-my-pi@latest\nbinary: omp\n';

// Warnings are the observable half of every skip, so each case asserts them
// alongside the returned table.
function captureWarnings<T>(run: () => T): { result: T; warnings: string[] } {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = run();
    return { result, warnings: warn.mock.calls.map((call) => String(call[0])) };
  } finally {
    warn.mockRestore();
  }
}

describe('loadAgentDefinitions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-agent-defs-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeDefinition(fileName: string, body: string): void {
    fs.writeFileSync(path.join(tmpDir, fileName), body);
  }

  test('a valid definition joins the table after the built-ins, named for its file', () => {
    writeDefinition('oh-my-pi.yaml', MINIMAL_YAML);

    const { result, warnings } = captureWarnings(() => allAgents(tmpDir));

    expect(warnings).toEqual([]);
    expect(result.length).toBe(KNOWN_AGENTS.length + 1);
    expect(result.slice(0, KNOWN_AGENTS.length)).toEqual([...KNOWN_AGENTS]);
    expect(result[KNOWN_AGENTS.length]).toEqual({
      name: 'oh-my-pi',
      package: 'oh-my-pi@latest',
      binary: 'omp',
      dot_dirs: [],
      host_mode_supported: true,
      install: { method: 'npm' },
      container_env: {},
      isolated_seed_files: [],
    });
  });

  test('skips a schema-invalid definition, naming the file and the real parse error', () => {
    writeDefinition('bad.yaml', 'binary: [1]\n');

    const { result, warnings } = captureWarnings(() => loadAgentDefinitions(tmpDir));

    expect(result).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toStartWith("Warning: skipping invalid agent definition 'bad': ");
    expect(warnings[0]).toContain('binary');
  });

  test('drops a definition whose package is a built-in agent, keeping the built-in', () => {
    writeDefinition('shadow.yaml', "package: '@anthropic-ai/claude-code@latest'\nbinary: shadow\n");

    const { result, warnings } = captureWarnings(() => allAgents(tmpDir));

    expect(warnings).toEqual([
      "Warning: skipping agent definition 'shadow': package '@anthropic-ai/claude-code@latest' is provided by a built-in agent",
    ]);
    expect(result.map((agent) => agent.name)).not.toContain('shadow');
    expect(result.filter((agent) => agent.package === '@anthropic-ai/claude-code@latest').length).toBe(1);
  });

  test('drops the later definition when two customs share a package', () => {
    writeDefinition('aaa.yaml', 'package: dup-pkg@latest\nbinary: aaa\n');
    writeDefinition('bbb.yaml', 'package: dup-pkg@latest\nbinary: bbb\n');

    const { result, warnings } = captureWarnings(() => loadAgentDefinitions(tmpDir));

    expect(result.map((agent) => agent.name)).toEqual(['aaa']);
    expect(warnings).toEqual([
      "Warning: skipping agent definition 'bbb': package 'dup-pkg@latest' already defined by 'aaa'",
    ]);
  });

  test('duplicate-package detection ignores version suffix and case', () => {
    writeDefinition('aaa.yaml', 'package: dup-pkg@latest\nbinary: aaa\n');
    writeDefinition('bbb.yaml', 'package: DUP-PKG@2.0.0\nbinary: bbb\n');

    const { result, warnings } = captureWarnings(() => loadAgentDefinitions(tmpDir));

    expect(result.map((agent) => agent.name)).toEqual(['aaa']);
    expect(warnings).toEqual([
      "Warning: skipping agent definition 'bbb': package 'DUP-PKG@2.0.0' already defined by 'aaa'",
    ]);
  });

  test('drops a definition whose name collides with a built-in, case-insensitively', () => {
    writeDefinition('CLAUDE CODE.yaml', 'package: not-claude@latest\nbinary: notclaude\n');

    const { result, warnings } = captureWarnings(() => loadAgentDefinitions(tmpDir));

    expect(result).toEqual([]);
    expect(warnings).toEqual([
      "Warning: skipping agent definition 'CLAUDE CODE': name collides with built-in agent 'Claude Code'",
    ]);
  });

  // Filenames are unique, so the name-vs-earlier-custom axis is only reachable
  // case-insensitively. This filesystem is case-sensitive; the check must not
  // assume that of every host.
  test('drops the later definition when two custom names differ only by case', () => {
    writeDefinition('omp.yaml', 'package: omp-a@latest\nbinary: ompa\n');
    writeDefinition('OMP.yaml', 'package: omp-b@latest\nbinary: ompb\n');

    const { result, warnings } = captureWarnings(() => loadAgentDefinitions(tmpDir));

    expect(result.map((agent) => agent.name)).toEqual(['omp']);
    expect(warnings).toEqual(["Warning: skipping agent definition 'OMP': name collides with 'omp'"]);
  });

  test('skips a file whose stem is not a safe path segment', () => {
    writeDefinition('...yaml', MINIMAL_YAML);

    const { result, warnings } = captureWarnings(() => loadAgentDefinitions(tmpDir));

    expect(result).toEqual([]);
    expect(warnings).toEqual([
      "Warning: skipping agent definition file '...yaml': Names must not be '.' or '..', and must not contain '/' or '\\'.",
    ]);
  });

  test('ignores non-YAML files and directories silently', () => {
    writeDefinition('README.md', 'not a definition\n');
    fs.mkdirSync(path.join(tmpDir, 'nested.yaml'));
    writeDefinition('oh-my-pi.yaml', MINIMAL_YAML);

    const { result, warnings } = captureWarnings(() => loadAgentDefinitions(tmpDir));

    expect(result.map((agent) => agent.name)).toEqual(['oh-my-pi']);
    expect(warnings).toEqual([]);
  });

  test('returns an empty table when the definitions dir is missing', () => {
    const { result, warnings } = captureWarnings(() =>
      loadAgentDefinitions(path.join(tmpDir, 'nonexistent')),
    );

    expect(result).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

const DEFINITION: AgentDefinitionFile = {
  package: 'oh-my-pi@latest',
  binary: 'omp',
  dot_dirs: ['.oh-my-pi'],
  host_mode_supported: true,
  install: { method: 'npm' },
  container_env: {},
  isolated_seed_files: [],
};

describe('agent definition CRUD', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-agent-defs-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('round-trips a definition through write, load and delete', () => {
    const definitionsDir = path.join(tmpDir, 'agents');

    writeAgentDefinition('oh-my-pi', DEFINITION, definitionsDir);

    expect(agentDefinitionExists('oh-my-pi', definitionsDir)).toBe(true);
    expect(loadAgentDefinition('oh-my-pi', definitionsDir)).toEqual(DEFINITION);

    deleteAgentDefinition('oh-my-pi', definitionsDir);

    expect(agentDefinitionExists('oh-my-pi', definitionsDir)).toBe(false);
  });

  // Existence, not parseability: a corrupt definition must stay deletable.
  test('reports an unparseable definition as existing', () => {
    fs.writeFileSync(path.join(tmpDir, 'corrupt.yaml'), 'binary: [unclosed\n');

    expect(agentDefinitionExists('corrupt', tmpDir)).toBe(true);
    expect(() => loadAgentDefinition('corrupt', tmpDir)).toThrow('Failed to parse YAML');
  });

  test('throws a not-found error for a missing definition', () => {
    expect(() => loadAgentDefinition('nope', tmpDir)).toThrow("Agent definition 'nope' not found.");
    expect(() => deleteAgentDefinition('nope', tmpDir)).toThrow(
      "Agent definition 'nope' not found.",
    );
  });

  // The guard is what keeps a name from resolving outside the definitions dir.
  test.each(['../x', 'a/b', 'a\\b', '.', '..', ''])("rejects path-unsafe name '%s'", (name) => {
    expect(() => loadAgentDefinition(name, tmpDir)).toThrow(
      `Invalid agent definition name '${name}'`,
    );
    expect(() => agentDefinitionExists(name, tmpDir)).toThrow(
      `Invalid agent definition name '${name}'`,
    );
    expect(() => writeAgentDefinition(name, DEFINITION, tmpDir)).toThrow(
      `Invalid agent definition name '${name}'`,
    );
    expect(() => deleteAgentDefinition(name, tmpDir)).toThrow(
      `Invalid agent definition name '${name}'`,
    );
  });
});

describe('planAgentDelete', () => {
  test('reports workspaces whose tools install the definition package', () => {
    const impact = planAgentDelete({
      name: 'oh-my-pi',
      package: 'oh-my-pi@latest',
      workspaces: [
        { name: 'zeta', tools: [{ package: 'oh-my-pi@1.0.0' }] },
        { name: 'alpha', tools: [{ package: 'OH-MY-PI' }, { package: 'other@latest' }] },
        { name: 'unrelated', tools: [{ package: 'oh-my-pi-extras@latest' }] },
      ],
      allAgentProfiles: [],
    });

    expect(impact).toEqual({
      name: 'oh-my-pi',
      referencedBy: ['alpha', 'zeta'],
      agentProfiles: [],
    });
  });

  test('reports no workspace references when the definition package is unknown', () => {
    const impact = planAgentDelete({
      name: 'oh-my-pi',
      workspaces: [{ name: 'zeta', tools: [{ package: 'oh-my-pi@latest' }] }],
      allAgentProfiles: [{ name: 'omp-work', agent: 'oh-my-pi' }],
    });

    expect(impact).toEqual({
      name: 'oh-my-pi',
      referencedBy: [],
      agentProfiles: ['omp-work'],
    });
  });

  test('matches agent profiles on the agent handle case-insensitively, sorted', () => {
    const impact = planAgentDelete({
      name: 'oh-my-pi',
      package: 'oh-my-pi@latest',
      workspaces: [],
      allAgentProfiles: [
        { name: 'omp-two', agent: 'OH-MY-PI' },
        { name: 'claude', agent: 'Claude Code' },
        { name: 'omp-one', agent: 'oh-my-pi' },
      ],
    });

    expect(impact).toEqual({
      name: 'oh-my-pi',
      referencedBy: [],
      agentProfiles: ['omp-one', 'omp-two'],
    });
  });
});
