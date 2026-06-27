import fs from 'node:fs';
import path from 'node:path';

let counter = 0;

/**
 * Write a file atomically by writing to a sibling temp file and renaming it
 * into place. rename(2) is atomic on a single filesystem, so a concurrent
 * reader sees either the old file or the complete new file — never a
 * half-written one.
 */
export function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Temp file lives in the same directory so the rename stays on one filesystem.
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${counter++}`);
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    throw err;
  }
}
