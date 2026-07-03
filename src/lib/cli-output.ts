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
