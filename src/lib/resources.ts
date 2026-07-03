import os from 'node:os';
import type { ContainerProfile } from './validators.js';

const DEFAULT_MEMORY = '8g';

export interface ResolvedResources {
  cpus: number;
  memory: string;
}

function defaultCpus(): number {
  return Math.max(os.cpus().length - 2, 2);
}

export function resolveResources(
  containerProfile: Pick<ContainerProfile, 'cpus' | 'memory'>,
): ResolvedResources {
  return {
    cpus: containerProfile.cpus ?? defaultCpus(),
    memory: containerProfile.memory ?? DEFAULT_MEMORY,
  };
}
