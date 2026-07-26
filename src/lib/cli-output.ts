import chalk from 'chalk';
import type { AgentProfileDeleteImpact } from './agent-profiles.js';
import type { ContainerProfileDeleteImpact } from './profiles.js';

// Output is machine-readable JSON when the caller asked for it explicitly, or
// when stdout is not a TTY (piped / captured by an agent or CI). This is the
// honest "is a machine consuming this?" proxy — see the agent-CLI spec.
export function resolveJsonMode(jsonFlag: boolean | undefined, isTty: boolean): boolean {
  return jsonFlag === true || !isTty;
}

export function shouldEmitJson(jsonFlag: boolean | undefined): boolean {
  return resolveJsonMode(jsonFlag, Boolean(process.stdout.isTTY));
}

// Results go to stdout (the data channel). Pretty-printed for human-readable
// diffs; agents parse it the same either way.
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

// Decimal units, matching what Finder and `container` report — a size shown
// next to a destructive action has to agree with what the user sees elsewhere.
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const LARGEST_BYTE_UNIT_INDEX = BYTE_UNITS.length - 1;

// Which unit a count displays in, as an index into BYTE_UNITS. Rounding to one
// decimal can land back on the threshold (999_950 B → 999.95 KB →
// "1000.0 KB"); step up once more so the display never shows a four-digit
// mantissa below the TB cap.
function byteUnitIndex(bytes: number): number {
  let value = bytes;
  let index = 0;
  while (value >= 1000 && index < LARGEST_BYTE_UNIT_INDEX) {
    value /= 1000;
    index += 1;
  }
  return index < LARGEST_BYTE_UNIT_INDEX && Number(value.toFixed(1)) >= 1000 ? index + 1 : index;
}

// Mantissa only, in the given unit: whole numbers at the base unit (a byte is
// not divisible), one decimal above it.
function scaleToByteUnit(bytes: number, index: number): string {
  const value = bytes / 1000 ** index;
  return index === 0 ? `${value}` : value.toFixed(1);
}

export function formatBytes(bytes: number): string {
  const index = byteUnitIndex(bytes);
  return `${scaleToByteUnit(bytes, index)} ${BYTE_UNITS[index] ?? 'B'}`;
}

// Two related counts sharing one unit, e.g. "148.0/312.0 MB". A progress line
// reads better when both sides scale together, so the unit comes from the
// total and the left side stays directly comparable as it climbs.
export function formatByteProgress(current: number, total: number): string {
  const index = byteUnitIndex(total);
  return `${scaleToByteUnit(current, index)}/${scaleToByteUnit(total, index)} ${BYTE_UNITS[index] ?? 'B'}`;
}

// Human-readable --dry-run preview shared by the agent-profile and
// container-profile delete commands. The impact type is derived from both
// planners' impact shapes so drift in either breaks the build here, not at
// runtime.
type ProfileDeleteImpactView = Pick<
  AgentProfileDeleteImpact & ContainerProfileDeleteImpact,
  'profile' | 'referencedBy' | 'removes'
>;

export function printProfileDeleteDryRun(
  kind: 'agent profile' | 'container profile',
  impact: ProfileDeleteImpactView,
): void {
  console.log(`Would delete ${kind} '${impact.profile}' (${impact.removes}).`);
  if (impact.referencedBy.length > 0) {
    console.log(chalk.yellow(`  Referenced by workspace(s): ${impact.referencedBy.join(', ')}`));
  }
}
