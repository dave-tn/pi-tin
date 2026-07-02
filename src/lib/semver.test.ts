import { describe, expect, test } from 'bun:test';
import { parseSemver } from './semver.js';

describe('parseSemver', () => {
  test('parses plain x.y.z', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('0.10.0')).toEqual({ major: 0, minor: 10, patch: 0 });
  });

  test('accepts a v prefix and surrounding whitespace', () => {
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver(' 1.2.3\n')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test('ignores prerelease and build suffixes', () => {
    expect(parseSemver('1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('1.2.3+build.5')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test('rejects non-versions', () => {
    expect(parseSemver('not-a-version')).toBeNull();
    expect(parseSemver('1.2')).toBeNull();
    expect(parseSemver('1.2.3.4')).toBeNull();
    expect(parseSemver('container CLI version 1.2.3')).toBeNull();
    expect(parseSemver('')).toBeNull();
  });
});
