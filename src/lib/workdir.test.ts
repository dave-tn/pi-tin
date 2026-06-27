import { describe, test, expect } from 'bun:test';
import { computeContainerWorkdir } from './workdir.js';

describe('computeContainerWorkdir', () => {
  test('returns project root when cwd is exact project path', () => {
    const result = computeContainerWorkdir('/Users/dave/Dev/my-app', [
      '/Users/dave/Dev/my-app',
    ]);
    expect(result).toBe('/workspace/my-app');
  });

  test('returns subdirectory when cwd is inside a project', () => {
    const result = computeContainerWorkdir('/Users/dave/Dev/my-app/src/components', [
      '/Users/dave/Dev/my-app',
    ]);
    expect(result).toBe('/workspace/my-app/src/components');
  });

  test('returns undefined when cwd is not inside any project', () => {
    const result = computeContainerWorkdir('/Users/dave/Downloads', [
      '/Users/dave/Dev/my-app',
    ]);
    expect(result).toBeUndefined();
  });

  test('matches correct project when multiple projects exist', () => {
    const result = computeContainerWorkdir('/Users/dave/Dev/my-lib/tests', [
      '/Users/dave/Dev/my-app',
      '/Users/dave/Dev/my-lib',
    ]);
    expect(result).toBe('/workspace/my-lib/tests');
  });

  test('does not match partial directory name prefix', () => {
    const result = computeContainerWorkdir('/Users/dave/Dev/my-app-extra', [
      '/Users/dave/Dev/my-app',
    ]);
    expect(result).toBeUndefined();
  });

  test('returns project root with no trailing slash for exact match', () => {
    const result = computeContainerWorkdir('/Users/dave/Dev/my-app', [
      '/Users/dave/Dev/my-app',
      '/Users/dave/Dev/other',
    ]);
    expect(result).toBe('/workspace/my-app');
  });
});
