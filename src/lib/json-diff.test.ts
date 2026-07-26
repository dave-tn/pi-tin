import { describe, expect, test } from 'bun:test';
import { diffJson } from './json-diff.js';

describe('diffJson', () => {
  test('reports a changed scalar with before/after', () => {
    expect(diffJson({ memory: '8g' }, { memory: '16g' })).toEqual([
      { path: 'memory', kind: 'changed', before: '8g', after: '16g' },
    ]);
  });

  test('reports added and removed keys, and nothing else', () => {
    const changes = diffJson({ a: 1 }, { b: 2 });
    expect(changes).toHaveLength(2);
    expect(changes).toContainEqual({ path: 'a', kind: 'removed', before: 1 });
    expect(changes).toContainEqual({ path: 'b', kind: 'added', after: 2 });
  });

  // A key whose value changes shape is a single 'changed' entry, not a
  // recursion into the object side — the walk only recurses when both sides
  // are plain objects.
  test('a value changing between object and scalar is one changed entry', () => {
    expect(diffJson({ host: { githubCLI: true } }, { host: 'yes' })).toEqual([
      { path: 'host', kind: 'changed', before: { githubCLI: true }, after: 'yes' },
    ]);
    expect(diffJson({ host: 'yes' }, { host: { githubCLI: true } })).toEqual([
      { path: 'host', kind: 'changed', before: 'yes', after: { githubCLI: true } },
    ]);
  });

  test('a removed nested subtree is reported at its root, not leaf by leaf', () => {
    const changes = diffJson(
      { host: { sshAgent: true, mounts: [] }, profile: 'node-dev' },
      { profile: 'node-dev' },
    );
    expect(changes).toEqual([
      { path: 'host', kind: 'removed', before: { sshAgent: true, mounts: [] } },
    ]);
  });

  test('reports only the changed leaf of a partially changed subtree', () => {
    const changes = diffJson(
      { host: { sshAgent: true, githubCLI: false } },
      { host: { sshAgent: true, githubCLI: true } },
    );
    expect(changes).toEqual([
      { path: 'host.githubCLI', kind: 'changed', before: false, after: true },
    ]);
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
