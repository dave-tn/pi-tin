export type Semver = { major: number; minor: number; patch: number };

// Dependency-free parse of `x.y.z` with an optional `v` prefix. Any prerelease
// (`-…`) or build (`+…`) suffix is ignored for comparison. Returns null when
// the string is not a plain three-part numeric version.
export function parseSemver(input: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(input.trim());
  if (!match) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}
