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
 * user file must never shadow a tested built-in.
 */
export function loadAgentDefinitions(dir: string = getAgentDefinitionsDir()): KnownAgent[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const stems = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(YAML_SUFFIX))
    .map((entry) => entry.name.slice(0, -YAML_SUFFIX.length))
    .sort((a, b) => a.localeCompare(b));

  const accepted: KnownAgent[] = [];
  for (const stem of stems) {
    if (!isSafePathSegment(stem)) {
      console.warn(
        `Warning: skipping agent definition file '${stem}${YAML_SUFFIX}': ${SAFE_PATH_SEGMENT_RULE}`,
      );
      continue;
    }

    const definition = readDefinition(path.join(dir, `${stem}${YAML_SUFFIX}`), stem);
    if (definition === undefined) {
      continue;
    }

    const collision = collisionReason(stem, definition, accepted);
    if (collision !== undefined) {
      console.warn(`Warning: skipping agent definition '${stem}': ${collision}`);
      continue;
    }

    accepted.push({ name: stem, ...definition });
  }

  return accepted;
}

function readDefinition(filePath: string, name: string): AgentDefinitionFile | undefined {
  try {
    const raw: unknown = parseYaml(fs.readFileSync(filePath, 'utf-8'), filePath);
    return validateAgentDefinition(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: skipping invalid agent definition '${name}': ${message}`);
    return undefined;
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
