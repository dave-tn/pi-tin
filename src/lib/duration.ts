const DURATION_PATTERN = /^([1-9]\d*)([smh])$/;

type DurationUnit = 's' | 'm' | 'h';

const UNIT_MS: Record<DurationUnit, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
};

function isDurationUnit(value: unknown): value is DurationUnit {
  return value === 's' || value === 'm' || value === 'h';
}

function parseDurationParts(value: string): { amount: number; unit: DurationUnit } {
  // The pattern guarantees a valid unit and a syntactically-positive-integer
  // amount, but a long enough digit run overflows Number() to Infinity (or
  // silently loses precision past 2^53), so re-check the parsed amount below.
  // The undefined/unit checks also narrow the indexed-access types for the compiler.
  const match = DURATION_PATTERN.exec(value.trim());
  const amount = match?.[1];
  const unit = match?.[2];

  const numericAmount = Number(amount);
  if (amount === undefined || !isDurationUnit(unit) || !Number.isSafeInteger(numericAmount)) {
    throw new Error(`Invalid duration '${value}'. Use values like 30s, 5m, or 1h.`);
  }

  return { amount: numericAmount, unit };
}

export function parseDurationMs(value: string): number {
  const { amount, unit } = parseDurationParts(value);
  return amount * UNIT_MS[unit];
}

export function isValidDuration(value: string): boolean {
  try {
    parseDurationMs(value);
    return true;
  } catch {
    return false;
  }
}

export function formatDurationMs(ms: number): string {
  if (ms <= 0) {
    return '0s';
  }

  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}

export function formatRemainingDuration(
  deadlineMs: number,
  nowMs = Date.now(),
): string {
  return formatDurationMs(Math.max(deadlineMs - nowMs, 0));
}
