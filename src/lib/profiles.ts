import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { getContainerProfilesDir, isSafePathSegment, SAFE_PATH_SEGMENT_RULE } from './paths.js';
import { atomicWriteFile } from './atomic-write.js';
import { parseYaml } from './yaml.js';
import { validateContainerProfile } from './validators.js';
import type { ContainerProfile } from './validators.js';

export function loadContainerProfile(name: string): ContainerProfile {
  if (!isSafePathSegment(name)) {
    throw new Error(`Invalid container profile name '${name}'. ${SAFE_PATH_SEGMENT_RULE}`);
  }
  const profilePath = path.join(getContainerProfilesDir(), `${name}.yaml`);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Container profile '${name}' not found at ${profilePath}`);
  }
  const raw: unknown = parseYaml(fs.readFileSync(profilePath, 'utf-8'), profilePath);
  return validateContainerProfile(raw);
}

// Existence probe for paths that don't need a parsed profile (e.g. delete):
// checks the file only, so a corrupt or schema-invalid profile still counts
// as existing rather than being rewritten into "not found".
export function containerProfileExists(name: string): boolean {
  if (!isSafePathSegment(name)) {
    throw new Error(`Invalid container profile name '${name}'. ${SAFE_PATH_SEGMENT_RULE}`);
  }
  return fs.existsSync(path.join(getContainerProfilesDir(), `${name}.yaml`));
}

// Full-replace write of a container profile. No managed header is emitted, so
// an applied profile is user-managed (pi-tin's default sync will not overwrite
// it) — matching the documented "remove the managed header to customize" rule.
export function writeContainerProfile(name: string, profile: ContainerProfile): void {
  if (!isSafePathSegment(name)) {
    throw new Error(`Invalid container profile name '${name}'. ${SAFE_PATH_SEGMENT_RULE}`);
  }
  const dir = getContainerProfilesDir();
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFile(path.join(dir, `${name}.yaml`), YAML.stringify(profile));
}

export function listContainerProfiles(): string[] {
  const dir = getContainerProfilesDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();
}

export interface ContainerProfileSummary {
  name: string;
  description: string;
  base_image: string;
  valid: boolean;
}

// Structured projection for `container-profile list` (human table and --json
// both render from this). An unparseable profile is reported, not thrown.
export function listContainerProfileSummaries(): ContainerProfileSummary[] {
  return listContainerProfiles().map((name) => {
    try {
      const profile = loadContainerProfile(name);
      return { name, description: profile.description, base_image: profile.base_image, valid: true };
    } catch {
      return { name, description: '(invalid)', base_image: '', valid: false };
    }
  });
}

export interface ContainerProfileDeleteImpact {
  action: 'delete';
  profile: string;
  referencedBy: string[];
  removes: string;
}

// Pure impact report for a container-profile delete: which workspaces reference
// it (a workspace points at exactly one container profile via `profile`) and
// what is lost. Drives the --dry-run preview so an agent can surface the blast
// radius before deleting.
export function planContainerProfileDelete(input: {
  name: string;
  workspaces: Array<{ name: string; profile: string }>;
}): ContainerProfileDeleteImpact {
  const referencedBy = input.workspaces
    .filter((w) => w.profile === input.name)
    .map((w) => w.name)
    .sort((a, b) => a.localeCompare(b));

  return {
    action: 'delete',
    profile: input.name,
    referencedBy,
    removes: 'the container profile definition',
  };
}

// Unlink a container profile. A managed default deleted here is recreated by
// the startup default-sync on next run (by design — no special handling).
export function deleteContainerProfile(name: string): void {
  if (!isSafePathSegment(name)) {
    throw new Error(`Invalid container profile name '${name}'. ${SAFE_PATH_SEGMENT_RULE}`);
  }
  const profilePath = path.join(getContainerProfilesDir(), `${name}.yaml`);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Container profile '${name}' not found at ${profilePath}`);
  }
  fs.rmSync(profilePath, { force: true });
}
