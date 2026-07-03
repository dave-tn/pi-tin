import { describe, expect, test } from 'bun:test';
import { isSupportedContainerVersion } from './prereqs.js';

describe('isSupportedContainerVersion', () => {
  test('accepts 1.0.0 and newer', () => {
    expect(isSupportedContainerVersion('1.0.0')).toBe(true);
    expect(isSupportedContainerVersion('1.2.3')).toBe(true);
    expect(isSupportedContainerVersion('2.0.0')).toBe(true);
  });

  test('rejects pre-1.0 versions', () => {
    expect(isSupportedContainerVersion('0.5.0')).toBe(false);
    expect(isSupportedContainerVersion('0.9.9')).toBe(false);
  });

  test('extracts the version from surrounding text', () => {
    expect(isSupportedContainerVersion('container CLI version 1.0.0 (build: release)')).toBe(true);
    expect(isSupportedContainerVersion('container CLI version 0.4.1')).toBe(false);
  });

  test('rejects undeterminable versions', () => {
    expect(isSupportedContainerVersion('unknown')).toBe(false);
    expect(isSupportedContainerVersion('')).toBe(false);
  });
});
