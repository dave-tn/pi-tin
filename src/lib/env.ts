/**
 * Resolve env var references in workspace env values.
 * Values that are exactly ${VAR} are replaced with the host env var value.
 * If the host var is unset, the entry is omitted entirely.
 * Literal values (no ${...}) are passed through as-is. Partial interpolation
 * (e.g. "${HOME}/bin") is NOT supported: the value is passed through verbatim
 * and a warning is emitted, since the literal "${...}" is rarely intended.
 */
export function resolveEnv(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = /^\$\{(?<name>[^}]+)\}$/.exec(value);
    const varName = match?.groups?.['name'];
    if (varName !== undefined) {
      const hostValue = process.env[varName];
      if (hostValue !== undefined) {
        resolved[key] = hostValue;
      }
    } else {
      if (/\$\{[^}]+\}/.test(value)) {
        console.warn(
          `Warning: env value for '${key}' contains '\${...}' but is passed through literally. ` +
          `Only values that are exactly '\${VAR}' are resolved from the host environment.`,
        );
      }
      resolved[key] = value;
    }
  }
  return resolved;
}
