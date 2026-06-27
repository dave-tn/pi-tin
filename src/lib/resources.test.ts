import { describe, test, expect } from 'bun:test';
import os from 'node:os';
import { resolveResources } from './resources.js';

describe('resolveResources', () => {
  test('uses profile values when provided', () => {
    const result = resolveResources({ cpus: 6, memory: '16g' });
    expect(result).toEqual({ cpus: 6, memory: '16g' });
  });

  test('uses defaults when profile values are undefined', () => {
    const result = resolveResources({});
    expect(result.memory).toBe('8g');
    expect(result.cpus).toBeGreaterThanOrEqual(2);
  });

  test('default cpus is system cores minus 2', () => {
    const expected = Math.max(os.cpus().length - 2, 2);
    const result = resolveResources({});
    expect(result.cpus).toBe(expected);
  });

  test('uses default memory when only cpus provided', () => {
    const result = resolveResources({ cpus: 4 });
    expect(result.memory).toBe('8g');
  });

  test('uses default cpus when only memory provided', () => {
    const expected = Math.max(os.cpus().length - 2, 2);
    const result = resolveResources({ memory: '4g' });
    expect(result.cpus).toBe(expected);
  });
});
