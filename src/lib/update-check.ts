import { spawn } from 'node:child_process';
import fs from 'node:fs';
import * as v from 'valibot';
import { atomicWriteFile } from './atomic-write.js';
import { getUpdateCheckPath } from './paths.js';
import { NpmDistTagsSchema, UpdateCheckCacheSchema, type UpdateCheckCache } from './validators.js';
import { formatUpdateNotice, planUpdateNotice } from './update-plan.js';

// Hidden CLI sentinel used to re-invoke pi-tin as a detached update checker.
export const CHECK_FOR_UPDATE_COMMAND = '__check-for-update';

const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/pi-tin/dist-tags';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

// An env var opts out when it is set to any non-empty value — matching the
// common `if (process.env.X)` idiom (so `X=` / unset does not opt out).
function isEnvFlagSet(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

// Read the on-disk cache; any problem (missing, unreadable, corrupt, or schema
// mismatch) resolves to null, which the planner treats as stale. Never throws.
export function readUpdateCache(): UpdateCheckCache | null {
  try {
    const raw = fs.readFileSync(getUpdateCheckPath(), 'utf-8');
    const parsed = v.safeParse(UpdateCheckCacheSchema, JSON.parse(raw));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

export function writeUpdateCache(cache: UpdateCheckCache): void {
  atomicWriteFile(getUpdateCheckPath(), JSON.stringify(cache));
}

// Pure gate: notices are for interactive humans only. Suppressed for non-TTY /
// piped / JSON output, on CI, and via either opt-out env var.
// Note: always-JSON commands (show, *-apply, detect-host) can pass this gate on
// a bare TTY invocation — that is intentional. The notice writes to stderr while
// their JSON goes to stdout, so the machine-readable channel is never corrupted,
// and any real capture (`> out.json`) makes stdout non-TTY and trips !isTty here.
export function computeUpdateNoticeEnabled(input: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  isTty: boolean;
}): boolean {
  const { argv, env, isTty } = input;
  if (!isTty) {
    return false;
  }
  if (argv.includes('--json')) {
    return false;
  }
  return !(
    isEnvFlagSet(env['CI']) ||
    isEnvFlagSet(env['PI_TIN_NO_UPDATE_NOTIFIER']) ||
    isEnvFlagSet(env['NO_UPDATE_NOTIFIER'])
  );
}

// The detached helper body: fetch the latest version and refresh the cache.
// Any failure (non-ok status, parse error, network, timeout) is a silent no-op
// — the cache simply isn't updated and we retry on the next stale run.
export async function runUpdateCheckHelper(): Promise<void> {
  try {
    const res = await fetch(DIST_TAGS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': `pi-tin/${PKG_VERSION}` },
    });
    if (!res.ok) {
      return;
    }
    const parsed = v.safeParse(NpmDistTagsSchema, await res.json());
    if (!parsed.success) {
      return;
    }
    writeUpdateCache({ lastCheckMs: Date.now(), latestVersion: parsed.output.latest });
  } catch {
    // Silent: a failed check just leaves the cache untouched.
  }
}

// Re-invoke this same CLI as a detached, unref'd background checker so its
// network latency never touches the user's command. Mirrors spawnAutoStopHelper.
export function spawnUpdateCheck(): void {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return;
  }
  try {
    spawn(process.execPath, [scriptPath, CHECK_FOR_UPDATE_COMMAND], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    }).unref();
  } catch {
    // Best effort only.
  }
}

// Orchestrator: if notices are enabled, read the cache, plan, and for each
// action either register the exit-time notice or spawn a background refresh.
export function scheduleUpdateNotice(input: {
  currentVersion: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  isTty: boolean;
}): void {
  if (!computeUpdateNoticeEnabled(input)) {
    return;
  }

  const actions = planUpdateNotice({
    currentVersion: input.currentVersion,
    cache: readUpdateCache(),
    nowMs: Date.now(),
    intervalMs: CHECK_INTERVAL_MS,
  });

  for (const action of actions) {
    if (action.kind === 'notify') {
      const notice = formatUpdateNotice(action.latest, input.currentVersion);
      // Print when control returns to the host shell (e.g. after an `open`
      // session ends). Exit handlers must be synchronous.
      process.on('exit', () => {
        try {
          process.stderr.write(notice + '\n');
        } catch {
          // Best effort in an exit handler.
        }
      });
    } else {
      spawnUpdateCheck();
    }
  }
}
