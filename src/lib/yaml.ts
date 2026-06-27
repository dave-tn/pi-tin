import YAML from 'yaml';

/**
 * Parse YAML, wrapping syntax errors so the failure names the source file.
 * Schema validation happens separately; this only handles malformed YAML.
 */
export function parseYaml(content: string, sourcePath: string): unknown {
  try {
    return YAML.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML at ${sourcePath}:\n  ${message}`);
  }
}
