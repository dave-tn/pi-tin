import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as v from 'valibot';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import {
  ContainerSystemStatusSchema,
  ContainerSystemVersionSchema,
  GitHubReleaseSchema,
} from './validators.js';
import { withExitHandling } from './exit-handling.js';
import { parseSemver } from './semver.js';
import { CliError, EXIT } from './cli-errors.js';
import { isInteractiveSession } from './confirmation.js';

const RELEASES_URL = 'https://github.com/apple/container/releases';
const MIN_CONTAINER_VERSION = '1.0.0';

function isContainerInstalled(): boolean {
  try {
    execFileSync('which', ['container'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function isHomebrewInstalled(): boolean {
  try {
    execFileSync('which', ['brew'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// The reported version may wrap the number in surrounding text, so extract
// the first `x.y.z` token before the strict parse.
export function isSupportedContainerVersion(version: string): boolean {
  const token = version.match(/\d+\.\d+\.\d+/)?.[0];
  const parsed = token === undefined ? null : parseSemver(token);
  return parsed !== null && parsed.major >= 1;
}

function readContainerCliVersionFromSystem(): string | null {
  try {
    const response = execFileSync(
      'container',
      ['system', 'version', '--format', 'json'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const versions = v.parse(ContainerSystemVersionSchema, JSON.parse(response));
    return versions.find((entry) => entry.appName === 'container')?.version ?? null;
  } catch {
    return null;
  }
}

function readContainerCliVersionFromText(): string | null {
  try {
    const response = execFileSync('container', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const match = response.match(/(\d+\.\d+\.\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function readContainerCliVersion(): string | null {
  return readContainerCliVersionFromSystem() ?? readContainerCliVersionFromText();
}

function ensureSupportedContainerVersion(): void {
  const version = readContainerCliVersion();
  if (version !== null && isSupportedContainerVersion(version)) {
    return;
  }

  const detail = version === null
    ? 'Installed version could not be determined.'
    : `Found ${version}.`;
  const upgradeHint = isHomebrewInstalled()
    ? `Upgrade with 'brew upgrade container', or install the latest release from ${RELEASES_URL}.`
    : `Install the latest release from ${RELEASES_URL}.`;

  throw new CliError(
    `pi-tin requires Apple container CLI ${MIN_CONTAINER_VERSION} or newer. ${detail}`,
    EXIT.GENERAL,
    { code: 'container_version_unsupported', remediation: upgradeHint },
  );
}

export type ContainerSystemProbe =
  | { kind: 'running' }
  | { kind: 'not-running' }
  | { kind: 'probe-failed'; detail: string };

export type ContainerSystemGatePlan =
  | { kind: 'proceed' }
  | { kind: 'prompt-start' }
  | { kind: 'fail'; error: CliError };

// A stopped service is reported on stdout ({ "status": "not running" |
// "unregistered" }, exit 1). The status command's own source swallows every
// service-connection failure — including a sandbox-denied lookup — into that
// same verdict, so 'not-running' means "the CLI reports not running", not
// proof the service is down. Anything without a parseable status means the
// probe itself failed (spawn error, timeout, unexpected output).
export function classifyContainerSystemStatus(result: {
  status: number | null;
  stdout: string;
  stderr: string;
}): ContainerSystemProbe {
  if (result.status === 0) {
    return { kind: 'running' };
  }

  const reported = parseReportedSystemStatus(result.stdout);
  if (reported === 'not running' || reported === 'unregistered') {
    return { kind: 'not-running' };
  }

  const detail =
    result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
  return { kind: 'probe-failed', detail };
}

function parseReportedSystemStatus(stdout: string): string | null {
  try {
    return v.parse(ContainerSystemStatusSchema, JSON.parse(stdout)).status;
  } catch {
    return null;
  }
}

export function planContainerSystemGate(
  probe: ContainerSystemProbe,
  isInteractive: boolean,
): ContainerSystemGatePlan {
  switch (probe.kind) {
    case 'running':
      return { kind: 'proceed' };
    case 'not-running':
      if (isInteractive) {
        return { kind: 'prompt-start' };
      }
      return {
        kind: 'fail',
        error: new CliError(
          "The container system service reports 'not running'.",
          EXIT.GENERAL,
          {
            code: 'container_system_not_running',
            remediation:
              "Start it with 'container system start'. Some sandboxed shells "
              + 'block access to the service, making a running service report '
              + "as not running — if this ran in a sandbox, check 'container "
              + "system status' from an unsandboxed shell before starting it.",
          },
        ),
      };
    case 'probe-failed':
      return {
        kind: 'fail',
        error: new CliError(
          `Could not determine container system status: ${probe.detail}`,
          EXIT.GENERAL,
          {
            code: 'container_system_probe_failed',
            remediation: "Run 'container system status' directly to inspect the failure.",
          },
        ),
      };
  }
}

// Outlives the status command's internal 10s health-check timeout so the CLI
// reaches its own verdict; the outer bound only fires if the process wedges.
const STATUS_PROBE_TIMEOUT_MS = 15_000;

function probeContainerSystem(): ContainerSystemProbe {
  const result = spawnSync('container', ['system', 'status', '--format', 'json'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: STATUS_PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (result.error) {
    return { kind: 'probe-failed', detail: result.error.message };
  }
  return classifyContainerSystemStatus({
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  });
}

async function installViaBrew(): Promise<boolean> {
  const install = await confirm({
    message: 'Install via Homebrew? (brew install container)',
    default: true,
  });

  if (!install) return false;

  try {
    console.log(chalk.blue('\nInstalling container via Homebrew...\n'));
    execFileSync('brew', ['install', 'container'], { stdio: 'inherit' });
    return isContainerInstalled();
  } catch {
    console.error(chalk.red('\nHomebrew install failed.'));
    return false;
  }
}

async function installViaPkg(): Promise<boolean> {
  const install = await confirm({
    message: 'Download and install the .pkg from GitHub?',
    default: true,
  });

  if (!install) return false;

  try {
    console.log(chalk.blue('\nFetching latest release...'));

    const response = execFileSync('curl', [
      '-sL',
      'https://api.github.com/repos/apple/container/releases/latest',
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

    const release = v.parse(GitHubReleaseSchema, JSON.parse(response));
    const pkg = release.assets?.find((a) => a.name?.endsWith('.pkg'));

    if (!pkg?.browser_download_url) {
      console.error(chalk.red('Could not find installer package in latest release.'));
      return false;
    }

    const tmpPath = path.join(os.tmpdir(), 'container-installer.pkg');
    console.log(chalk.blue(`Downloading ${pkg.name}...`));
    execFileSync('curl', ['-L', '-o', tmpPath, pkg.browser_download_url], {
      stdio: 'inherit',
    });

    console.log(chalk.blue('\nOpening installer (you will need to enter your admin password)...'));
    execFileSync('open', ['-W', tmpPath], { stdio: 'inherit' });

    return isContainerInstalled();
  } catch {
    console.error(chalk.red('\nFailed to download or install the package.'));
    return false;
  }
}

async function promptInstall(): Promise<void> {
  console.log(chalk.yellow("Apple's container CLI is not installed.\n"));
  console.log('pi-tin requires Apple\'s container CLI to run.');

  let installed = false;

  if (isHomebrewInstalled()) {
    installed = await installViaBrew();
  }

  if (!installed) {
    console.log(`\nYou can install it from: ${chalk.cyan(RELEASES_URL)}\n`);
    installed = await installViaPkg();
  }

  if (!installed) {
    console.log(`\nInstall manually from ${chalk.cyan(RELEASES_URL)} and try again.`);
    process.exit(1);
  }

  console.log(chalk.green('\n✔ Apple container CLI installed.'));
}

async function promptStartSystem(): Promise<void> {
  console.log(chalk.yellow('The container system service is not running.\n'));

  const start = await confirm({
    message: 'Would you like to start it now?',
    default: true,
  });

  if (!start) {
    console.log(`\nStart it manually with: ${chalk.cyan('container system start')}`);
    process.exit(1);
  }

  try {
    console.log(chalk.blue('Starting container system (this may download a kernel on first run)...\n'));
    execFileSync('container', ['system', 'start'], { stdio: 'inherit' });
    console.log(chalk.green('\n✔ Container system started.'));
  } catch {
    console.error(chalk.red('\nFailed to start container system.'));
    console.log(`Try manually: ${chalk.cyan('container system start')}`);
    process.exit(1);
  }
}

// Prompts are for humans only. A non-interactive caller (agent/CI) must get a
// CliError — rendered as the structured envelope in JSON mode — never a prompt
// it can't answer (which used to die and exit 0, reading as success).
export async function ensurePrerequisites(): Promise<void> {
  const interactive = isInteractiveSession();

  if (!isContainerInstalled()) {
    if (!interactive) {
      throw new CliError(
        "Apple's container CLI is not installed.",
        EXIT.GENERAL,
        {
          code: 'container_not_installed',
          remediation: `Install it with 'brew install container', or from ${RELEASES_URL}.`,
        },
      );
    }
    await withExitHandling(() => promptInstall());
  }

  ensureSupportedContainerVersion();

  const plan = planContainerSystemGate(probeContainerSystem(), interactive);
  switch (plan.kind) {
    case 'proceed':
      return;
    case 'prompt-start':
      await withExitHandling(() => promptStartSystem());
      return;
    case 'fail':
      throw plan.error;
  }
}
