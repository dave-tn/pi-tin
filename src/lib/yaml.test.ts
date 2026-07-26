import { describe, test, expect } from 'bun:test';
import { parseYaml } from './yaml.js';

describe('parseYaml', () => {
  test('parses valid YAML', () => {
    expect(parseYaml('a: 1\nb: two', '/tmp/x.yaml')).toEqual({ a: 1, b: 'two' });
  });

  test('returns null for empty content', () => {
    expect(parseYaml('', '/tmp/x.yaml')).toBeNull();
  });

  test('throws a contextual error naming the source path and keeping the parser detail', () => {
    const err = (() => {
      try {
        parseYaml('a: [1, 2\nb: oops', '/tmp/broken.yaml');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) throw new Error('unreachable');
    expect(err.message).toStartWith('Failed to parse YAML at /tmp/broken.yaml:\n  ');
    // The wrapper must append the parser's own diagnostic, not replace it —
    // "failed to parse <path>" alone tells the user nothing about what to fix.
    // The diagnostic sentence itself is owned by the third-party `yaml` parser
    // and can be reworded by any dependency update, so it is deliberately not
    // pinned. The contract this module owns is: wrapper prefix + source path +
    // a preserved, non-empty parser detail + line/column.
    expect(err.message).toMatch(/^Failed to parse YAML at \/tmp\/broken\.yaml:\n {2}\S/);
    expect(err.message).toContain('at line 2, column 1');
  });
});
