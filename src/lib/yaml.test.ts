import { describe, test, expect } from 'bun:test';
import { parseYaml } from './yaml.js';

describe('parseYaml', () => {
  test('parses valid YAML', () => {
    expect(parseYaml('a: 1\nb: two', '/tmp/x.yaml')).toEqual({ a: 1, b: 'two' });
  });

  test('returns null for empty content', () => {
    expect(parseYaml('', '/tmp/x.yaml')).toBeNull();
  });

  test('throws a contextual error naming the source path on malformed YAML', () => {
    expect(() => parseYaml('a: [1, 2\nb: oops', '/tmp/broken.yaml')).toThrow('/tmp/broken.yaml');
  });
});
