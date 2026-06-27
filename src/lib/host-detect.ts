import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseTimezoneFromLocaltimePath, availableApiKeyVars } from './create-flow.js';
import { KNOWN_AGENTS } from './agents.js';

export interface HostInfo {
  gitIdentity: { name: string | null; email: string | null };
  tz: string | null;
  colorterm: string | null;
  apiKeys: string[];
  agents: Array<{ name: string; package: string }>;
}

export function getGitConfig(key: string): string | undefined {
  try {
    return execFileSync('git', ['config', '--global', key], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function detectHostTimezone(): string | undefined {
  try {
    const target = fs.realpathSync('/etc/localtime');
    return parseTimezoneFromLocaltimePath(target);
  } catch {
    return undefined;
  }
}

// Pure assembly so it can be unit-tested without touching git/fs/env.
export function buildHostInfo(input: {
  gitName: string | undefined;
  gitEmail: string | undefined;
  tz: string | undefined;
  colorterm: string | undefined;
  apiKeyVars: Array<{ name: string; label: string }>;
  agents: ReadonlyArray<{ name: string; package: string }>;
}): HostInfo {
  return {
    gitIdentity: { name: input.gitName ?? null, email: input.gitEmail ?? null },
    tz: input.tz ?? null,
    colorterm: input.colorterm ?? null,
    apiKeys: input.apiKeyVars.map((v) => v.name),
    agents: input.agents.map((a) => ({ name: a.name, package: a.package })),
  };
}

export function detectHost(): HostInfo {
  return buildHostInfo({
    gitName: getGitConfig('user.name'),
    gitEmail: getGitConfig('user.email'),
    tz: detectHostTimezone(),
    colorterm: process.env['COLORTERM'],
    apiKeyVars: availableApiKeyVars(process.env),
    agents: KNOWN_AGENTS,
  });
}
