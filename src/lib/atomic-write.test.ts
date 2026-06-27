import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from './atomic-write.js';

describe('atomicWriteFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes the full content to a new file', () => {
    const filePath = path.join(tmpDir, 'profile.yaml');
    atomicWriteFile(filePath, 'hello: world\n');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello: world\n');
  });

  test('overwrites an existing file', () => {
    const filePath = path.join(tmpDir, 'profile.yaml');
    fs.writeFileSync(filePath, 'old\n', 'utf-8');
    atomicWriteFile(filePath, 'new\n');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new\n');
  });

  test('leaves no temporary files behind in the target directory', () => {
    const filePath = path.join(tmpDir, 'profile.yaml');
    atomicWriteFile(filePath, 'content\n');
    expect(fs.readdirSync(tmpDir)).toEqual(['profile.yaml']);
  });
});
