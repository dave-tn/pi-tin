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
  selectAgentDefinitions,
  writeAgentDefinition,
} from './agent-definitions.js';
import type { AgentDefinitionCandidate } from './agent-definitions.js';
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
      api_key_vars: [],
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

  // The collision rules themselves are pinned as data in the
  // selectAgentDefinitions suite below; what this layer owns is the read.
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

// The merge rules are tested as plain data because the filesystem cannot host
// every case: on a case-insensitive volume (the macOS default) two definition
// files whose stems differ only by case are the same file, so the
// name-collision rule is unreachable through a directory of real files.
describe('selectAgentDefinitions', () => {
  function candidate(stem: string, packageSpec: string): AgentDefinitionCandidate {
    return {
      kind: 'parsed',
      stem,
      definition: {
        package: packageSpec,
        binary: 'bin',
        dot_dirs: [],
        host_mode_supported: true,
        install: { method: 'npm' },
        container_env: {},
        api_key_vars: [],
        isolated_seed_files: [],
      },
    };
  }

  test('accepts candidates in stem order, whatever order they arrive in', () => {
    const selection = selectAgentDefinitions([
      candidate('zed', 'zed@latest'),
      candidate('alpha', 'alpha@latest'),
    ]);

    expect(selection.agents.map((agent) => agent.name)).toEqual(['alpha', 'zed']);
    expect(selection.warnings).toEqual([]);
  });

  test('drops the later definition when two stems differ only by case', () => {
    const selection = selectAgentDefinitions([
      candidate('OMP', 'omp-b@latest'),
      candidate('omp', 'omp-a@latest'),
    ]);

    expect(selection.agents.map((agent) => agent.name)).toEqual(['omp']);
    expect(selection.agents[0]?.package).toBe('omp-a@latest');
    expect(selection.warnings).toEqual([
      "Warning: skipping agent definition 'OMP': name collides with 'omp'",
    ]);
  });

  test('drops a definition whose name collides with a built-in, case-insensitively', () => {
    const selection = selectAgentDefinitions([candidate('CLAUDE CODE', 'not-claude@latest')]);

    expect(selection.agents).toEqual([]);
    expect(selection.warnings).toEqual([
      "Warning: skipping agent definition 'CLAUDE CODE': name collides with built-in agent 'Claude Code'",
    ]);
  });

  test('drops the later definition when two customs share a package', () => {
    const selection = selectAgentDefinitions([
      candidate('aaa', 'dup-pkg@latest'),
      candidate('bbb', 'dup-pkg@latest'),
    ]);

    expect(selection.agents.map((agent) => agent.name)).toEqual(['aaa']);
    expect(selection.warnings).toEqual([
      "Warning: skipping agent definition 'bbb': package 'dup-pkg@latest' already defined by 'aaa'",
    ]);
  });

  test('duplicate-package detection ignores version suffix and case', () => {
    const selection = selectAgentDefinitions([
      candidate('aaa', 'dup-pkg@latest'),
      candidate('bbb', 'DUP-PKG@2.0.0'),
    ]);

    expect(selection.agents.map((agent) => agent.name)).toEqual(['aaa']);
    expect(selection.warnings).toEqual([
      "Warning: skipping agent definition 'bbb': package 'DUP-PKG@2.0.0' already defined by 'aaa'",
    ]);
  });
});

const DEFINITION: AgentDefinitionFile = {
  package: 'oh-my-pi@latest',
  binary: 'omp',
  dot_dirs: ['.oh-my-pi'],
  host_mode_supported: true,
  install: { method: 'npm' },
  container_env: {},
  api_key_vars: [],
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

  // A macOS volume is case-insensitive by default, so the atomic write's rename
  // of 'OMP.yaml' lands on an existing 'omp.yaml' — replacing a different
  // definition while the on-disk name keeps the old spelling. Rejected on every
  // platform: the loader drops one of a folding pair anyway.
  test('refuses a write whose name differs from an existing one only by case', () => {
    fs.writeFileSync(path.join(tmpDir, 'omp.yaml'), MINIMAL_YAML);

    expect(() => writeAgentDefinition('OMP', DEFINITION, tmpDir)).toThrow(
      "Agent definition 'OMP' differs only by case from the existing 'omp'; delete 'omp' first, or choose another name.",
    );

    expect(fs.readdirSync(tmpDir)).toEqual(['omp.yaml']);
    expect(fs.readFileSync(path.join(tmpDir, 'omp.yaml'), 'utf-8')).toBe(MINIMAL_YAML);
  });

  test('writing the exact existing name is an ordinary update', () => {
    fs.writeFileSync(path.join(tmpDir, 'omp.yaml'), MINIMAL_YAML);

    writeAgentDefinition('omp', DEFINITION, tmpDir);

    expect(loadAgentDefinition('omp', tmpDir)).toEqual(DEFINITION);
    expect(fs.readdirSync(tmpDir)).toEqual(['omp.yaml']);
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
