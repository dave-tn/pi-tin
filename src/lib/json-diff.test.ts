import { describe, expect, test } from 'bun:test';
import { diffJson } from './json-diff.js';

describe('diffJson', () => {
  test('reports a changed scalar with before/after', () => {
    expect(diffJson({ memory: '8g' }, { memory: '16g' })).toEqual([
      { path: 'memory', kind: 'changed', before: '8g', after: '16g' },
    ]);
  });

  test('reports added and removed keys', () => {
    const changes = diffJson({ a: 1 }, { b: 2 });
    expect(changes).toContainEqual({ path: 'a', kind: 'removed', before: 1 });
    expect(changes).toContainEqual({ path: 'b', kind: 'added', after: 2 });
  });

  test('recurses into nested objects with dotted paths', () => {
    expect(diffJson({ host: { githubCLI: false } }, { host: { githubCLI: true } })).toEqual([
      { path: 'host.githubCLI', kind: 'changed', before: false, after: true },
    ]);
  });

  test('treats arrays as whole values', () => {
    expect(diffJson({ packages: ['git'] }, { packages: ['git', 'curl'] })).toEqual([
      { path: 'packages', kind: 'changed', before: ['git'], after: ['git', 'curl'] },
    ]);
  });

  test('no changes yields an empty array', () => {
    expect(diffJson({ a: 1, nested: { x: ['y'] } }, { a: 1, nested: { x: ['y'] } })).toEqual([]);
  });
});
