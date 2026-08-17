import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { atomicWriteFile } from './atomic-write.js';
import { getAgentDefinitionsDir, isSafePathSegment, SAFE_PATH_SEGMENT_RULE } from './paths.js';
import { parseYaml } from './yaml.js';
import { validateAgentDefinition } from './validators.js';
import type { AgentDefinitionFile } from './validators.js';
import { KNOWN_AGENTS, findBuiltInByName, findBuiltInByPackage, packagesCollide } from './agents.js';
import type { KnownAgent } from './agents.js';

const YAML_SUFFIX = '.yaml';

/**
 * The merged agent table: built-ins first, then valid user definitions. Every
 * dir read is injectable so tests never touch the real config dir.
 */
export function allAgents(dir: string = getAgentDefinitionsDir()): KnownAgent[] {
  return [...KNOWN_AGENTS, ...loadAgentDefinitions(dir)];
}

/**
 * User agent definitions from `dir`, filename stem as the agent name, in
 * alphabetical order. A file that cannot be used is skipped with a warning on
 * stderr rather than aborting: one bad file must not take the CLI down, and
 * `--json` stdout stays parseable. Built-ins always win a collision — a broken
 * user file must never shadow a tested built-in. The directory read is the only
 * effectful part; every rule lives in `selectAgentDefinitions`.
 */
export function loadAgentDefinitions(dir: string = getAgentDefinitionsDir()): KnownAgent[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const { agents, warnings } = selectAgentDefinitions(readCandidates(dir));
  warnings.forEach((warning) => console.warn(warning));
  return agents;
}

/**
 * A definition file as read from disk: `parsed` when it validated, `unreadable`
 * with the error otherwise. `stem` is the filename without `.yaml` — the agent
 * name, not yet checked against the name rules.
 */
export type AgentDefinitionCandidate =
  | { kind: 'parsed'; stem: string; definition: AgentDefinitionFile }
  | { kind: 'unreadable'; stem: string; error: string };

export interface AgentDefinitionSelection {
  agents: KnownAgent[];
  warnings: string[];
}

/**
 * Which candidates join the agent table, and the warning a user sees for each
 * one dropped. Pure, and it sorts its own input: "alphabetically earlier wins"
 * is one of the rules, not a property of the directory read. Kept separate from
 * that read because a case-insensitive volume — the macOS default — cannot hold
 * two files whose stems differ only by case, so the name-collision rule is only
 * reachable as data.
 */
export function selectAgentDefinitions(
  candidates: readonly AgentDefinitionCandidate[],
): AgentDefinitionSelection {
  const agents: KnownAgent[] = [];
  const warnings: string[] = [];

  for (const candidate of [...candidates].sort((a, b) => a.stem.localeCompare(b.stem))) {
    if (!isSafePathSegment(candidate.stem)) {
      warnings.push(
        `Warning: skipping agent definition file '${candidate.stem}${YAML_SUFFIX}': ${SAFE_PATH_SEGMENT_RULE}`,
      );
      continue;
    }

    if (candidate.kind === 'unreadable') {
      warnings.push(
        `Warning: skipping invalid agent definition '${candidate.stem}': ${candidate.error}`,
      );
      continue;
    }

    const collision = collisionReason(candidate.stem, candidate.definition, agents);
    if (collision !== undefined) {
      warnings.push(`Warning: skipping agent definition '${candidate.stem}': ${collision}`);
      continue;
    }

    agents.push({ name: candidate.stem, ...candidate.definition });
  }

  return { agents, warnings };
}

// Every `*.yaml` entry is read, name rules included: a readdir name carries no
// path separator, so joining one cannot escape `dir`. The name rule guards the
// agent *name*, which later interpolates into config paths, not this read.
function readCandidates(dir: string): AgentDefinitionCandidate[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(YAML_SUFFIX))
    .map((entry) =>
      readCandidate(path.join(dir, entry.name), entry.name.slice(0, -YAML_SUFFIX.length)),
    );
}

function readCandidate(filePath: string, stem: string): AgentDefinitionCandidate {
  try {
    const raw: unknown = parseYaml(fs.readFileSync(filePath, 'utf-8'), filePath);
    return { kind: 'parsed', stem, definition: validateAgentDefinition(raw) };
  } catch (err) {
    return { kind: 'unreadable', stem, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Why a definition must be dropped, or undefined when it is acceptable. Both
 * axes are compared case-insensitively: `package` is the install identity, so
 * two agents installing the same thing cannot coexist, and `name` is the CLI
 * handle, so a duplicate would leave first-match-wins lookups picking one
 * silently. `accepted` holds the earlier (alphabetical) definitions, which win.
 */
function collisionReason(
  name: string,
  definition: AgentDefinitionFile,
  accepted: readonly KnownAgent[],
): string | undefined {
  if (findBuiltInByPackage(definition.package) !== undefined) {
    return `package '${definition.package}' is provided by a built-in agent`;
  }

  const samePackage = accepted.find((agent) => packagesCollide(agent.package, definition.package));
  if (samePackage !== undefined) {
    return `package '${definition.package}' already defined by '${samePackage.name}'`;
  }

  const builtIn = findBuiltInByName(name);
  if (builtIn !== undefined) {
    return `name collides with built-in agent '${builtIn.name}'`;
  }

  const sameName = accepted.find((agent) => agent.name.toLowerCase() === name.toLowerCase());
  if (sameName !== undefined) {
    return `name collides with '${sameName.name}'`;
  }

  return undefined;
}

// A definition name is interpolated into a config path, so it must stay a
// single path segment — checked before any path is joined or read.
function definitionPath(name: string, dir: string): string {
  if (!isSafePathSegment(name)) {
    throw new Error(`Invalid agent definition name '${name}'. ${SAFE_PATH_SEGMENT_RULE}`);
  }
  return path.join(dir, `${name}${YAML_SUFFIX}`);
}

export function loadAgentDefinition(
  name: string,
  dir: string = getAgentDefinitionsDir(),
): AgentDefinitionFile {
  const filePath = definitionPath(name, dir);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Agent definition '${name}' not found.`);
  }
  const raw: unknown = parseYaml(fs.readFileSync(filePath, 'utf-8'), filePath);
  return validateAgentDefinition(raw);
}

// Existence probe for paths that don't need a parsed definition (e.g. delete):
// checks the file only, so a corrupt or schema-invalid definition still counts
// as existing rather than being rewritten into "not found".
export function agentDefinitionExists(
  name: string,
  dir: string = getAgentDefinitionsDir(),
): boolean {
  return fs.existsSync(definitionPath(name, dir));
}

// Full-replace write of an agent definition. Definitions stay hand-editable
// YAML, so nothing is stamped into the file beyond the definition itself.
export function writeAgentDefinition(
  name: string,
  definition: AgentDefinitionFile,
  dir: string = getAgentDefinitionsDir(),
): void {
  const filePath = definitionPath(name, dir);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFile(filePath, YAML.stringify(definition));
}

export function deleteAgentDefinition(name: string, dir: string = getAgentDefinitionsDir()): void {
  const filePath = definitionPath(name, dir);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Agent definition '${name}' not found.`);
  }
  fs.rmSync(filePath, { force: true });
}

export interface AgentDeleteImpact {
  name: string;
  referencedBy: string[];
  agentProfiles: string[];
}

/**
 * Pure impact report for an agent-definition delete: the workspaces installing
 * its package and the agent profiles claiming its name. `package` is absent
 * when the definition could not be parsed — the workspace half is then
 * unknowable and reported as empty, while the name-keyed profile half still
 * holds. Built-in and not-found are the command's pre-checks, so no verdict of
 * that kind is returned here.
 */
export function planAgentDelete(input: {
  name: string;
  package?: string;
  workspaces: Array<{ name: string; tools: Array<{ package: string }> }>;
  allAgentProfiles: Array<{ name: string; agent: string }>;
}): AgentDeleteImpact {
  const definitionPackage = input.package;
  const referencedBy =
    definitionPackage === undefined
      ? []
      : input.workspaces
          .filter((workspace) =>
            workspace.tools.some((tool) => packagesCollide(tool.package, definitionPackage)),
          )
          .map((workspace) => workspace.name)
          .sort((a, b) => a.localeCompare(b));

  const agentProfiles = input.allAgentProfiles
    .filter((profile) => profile.agent.toLowerCase() === input.name.toLowerCase())
    .map((profile) => profile.name)
    .sort((a, b) => a.localeCompare(b));

  return { name: input.name, referencedBy, agentProfiles };
}
