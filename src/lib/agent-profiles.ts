import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { getAgentProfilesDir, isSafePathSegment, SAFE_PATH_SEGMENT_RULE } from './paths.js';
import { atomicWriteFile } from './atomic-write.js';
import { parseYaml } from './yaml.js';
import { KNOWN_AGENTS } from './agents.js';
import { validateAgentProfileMeta, type AgentProfileMeta } from './validators.js';

export type AgentProfileMode = AgentProfileMeta['mode'];

export type { AgentProfileMeta };

export type AgentProfileEntry = AgentProfileMeta & { name: string };

// Guard for every create/load/delete path: names come from argv and must not
// escape the agent-profiles dir (delete is recursive).
function getProfileDir(name: string): string {
  if (!isSafePathSegment(name)) {
    throw new Error(`Invalid agent profile name '${name}'. ${SAFE_PATH_SEGMENT_RULE}`);
  }
  return path.join(getAgentProfilesDir(), name);
}

export function createAgentProfile(
  name: string,
  agentName: string,
  mode: AgentProfileMode = 'isolated',
): string {
  const agent = KNOWN_AGENTS.find((a) => a.name === agentName);
  if (!agent || agent.dotDirs.length === 0) {
    throw new Error(
      `Unknown agent: '${agentName}'. Known agents: ${KNOWN_AGENTS.map((a) => a.name).join(', ')}`,
    );
  }

  if (mode === 'host' && !agent.hostModeSupported) {
    throw new Error(
      `${agentName} does not support host mode. Its auth depends on macOS Keychain, which is unavailable in containers.`,
    );
  }

  const profileDir = getProfileDir(name);
  // profile.yaml is the completion marker (written atomically, last). A dir
  // without it is a creation that died mid-way, so retrying may proceed.
  if (fs.existsSync(path.join(profileDir, 'profile.yaml'))) {
    throw new Error(`Agent profile '${name}' already exists at ${profileDir}`);
  }

  fs.mkdirSync(profileDir, { recursive: true });

  if (mode === 'isolated') {
    for (const mount of agent.dotDirs) {
      fs.mkdirSync(path.join(profileDir, mount), { recursive: true });
    }
  }

  const meta: AgentProfileMeta = { agent: agentName, mode, mounts: [...agent.dotDirs] };
  atomicWriteFile(path.join(profileDir, 'profile.yaml'), YAML.stringify(meta));

  return profileDir;
}

export function loadAgentProfile(name: string): AgentProfileMeta & { path: string } {
  const profileDir = getProfileDir(name);
  const metaPath = path.join(profileDir, 'profile.yaml');

  if (!fs.existsSync(metaPath)) {
    throw new Error(
      `Agent profile '${name}' not found. Run 'pi-tin agent-profile list' to see available profiles.`,
    );
  }

  const parsed: unknown = parseYaml(fs.readFileSync(metaPath, 'utf-8'), metaPath);
  const meta = validateAgentProfileMeta(parsed);

  return { ...meta, path: profileDir };
}

export function listAgentProfiles(): AgentProfileEntry[] {
  const dir = getAgentProfilesDir();
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      try {
        const meta = loadAgentProfile(d.name);
        return { name: d.name, agent: meta.agent, mode: meta.mode, mounts: meta.mounts };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: skipping invalid agent profile '${d.name}': ${message}`);
        return undefined;
      }
    })
    .filter((entry): entry is AgentProfileEntry => entry !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteAgentProfile(name: string): void {
  const profileDir = getProfileDir(name);
  if (!fs.existsSync(profileDir)) {
    throw new Error(`Agent profile '${name}' not found.`);
  }
  fs.rmSync(profileDir, { recursive: true, force: true });
}

export interface AgentProfileDeleteImpact {
  action: 'delete';
  profile: string;
  referencedBy: string[];
  removes: string;
}

// Pure impact report for an agent-profile delete: which workspaces reference it
// and what is lost. Drives the --dry-run preview so an agent can surface the
// blast radius to the user before deleting.
export function planAgentProfileDelete(input: {
  name: string;
  workspaces: Array<{ name: string; agentProfiles: string[] }>;
}): AgentProfileDeleteImpact {
  const referencedBy = input.workspaces
    .filter((w) => w.agentProfiles.includes(input.name))
    .map((w) => w.name)
    .sort((a, b) => a.localeCompare(b));

  return {
    action: 'delete',
    profile: input.name,
    referencedBy,
    removes: 'stored credentials and config',
  };
}

export function validateAgentProfilesForWorkspace(
  profileNames: string[],
): Array<{ name: string; mount: string; hostPath: string }> {
  const resolved: Array<{ name: string; mount: string; hostPath: string }> = [];

  for (const name of profileNames) {
    const profile = loadAgentProfile(name);

    for (const mount of profile.mounts) {
      const hostPath =
        profile.mode === 'host'
          ? path.join(os.homedir(), mount)
          : path.join(profile.path, mount);

      resolved.push({ name, mount, hostPath });
    }
  }

  const mountMap = new Map<string, string[]>();
  for (const entry of resolved) {
    const existing = mountMap.get(entry.mount) ?? [];
    existing.push(entry.name);
    mountMap.set(entry.mount, existing);
  }

  for (const [mount, names] of mountMap) {
    if (names.length > 1) {
      throw new Error(
        `Workspace has multiple profiles for ${mount}: ${names.join(', ')}. Only one profile per mount path is allowed.`,
      );
    }
  }

  return resolved;
}
