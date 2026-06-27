import os from 'node:os';

const DEFAULT_MEMORY = '8g';

export interface ResourceOptions {
  cpus?: number | undefined;
  memory?: string | undefined;
}

export interface ResolvedResources {
  cpus: number;
  memory: string;
}

function defaultCpus(): number {
  return Math.max(os.cpus().length - 2, 2);
}

export function resolveResources(profile: ResourceOptions): ResolvedResources {
  return {
    cpus: profile.cpus ?? defaultCpus(),
    memory: profile.memory ?? DEFAULT_MEMORY,
  };
}
