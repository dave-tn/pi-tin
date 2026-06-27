export interface DiffEntry {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Deep equality via canonical stringify. Only used on arrays/scalars (objects
// are recursed, never stringified), so key-order sensitivity does not apply.
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function join(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function walk(before: unknown, after: unknown, prefix: string, out: DiffEntry[]): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const inBefore = key in before;
      const inAfter = key in after;
      if (inBefore && !inAfter) {
        out.push({ path: join(prefix, key), kind: 'removed', before: before[key] });
      } else if (!inBefore && inAfter) {
        out.push({ path: join(prefix, key), kind: 'added', after: after[key] });
      } else {
        walk(before[key], after[key], join(prefix, key), out);
      }
    }
    return;
  }
  if (!deepEqual(before, after)) {
    out.push({ path: prefix, kind: 'changed', before, after });
  }
}

export function diffJson(before: unknown, after: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk(before, after, '', out);
  return out;
}
