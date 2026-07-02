import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as v from 'valibot';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import {
  ContainerSystemVersionSchema,
  GitHubReleaseSchema,
} from './validators.js';
import { withExitHandling } from './exit-handling.js';
import { parseSemver } from './semver.js';

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

  console.error(chalk.red(
    `pi-tin requires Apple container CLI ${MIN_CONTAINER_VERSION} or newer. ${detail}`,
  ));

  if (isHomebrewInstalled()) {
    console.log(`If you installed via Homebrew, upgrade with: ${chalk.cyan('brew upgrade container')}`);
  }
  console.log(`Latest releases: ${chalk.cyan(RELEASES_URL)}`);
  process.exit(1);
}

function isContainerSystemRunning(): boolean {
  try {
    execFileSync('container', ['system', 'status'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
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

export async function ensurePrerequisites(): Promise<void> {
  if (!isContainerInstalled()) {
    await withExitHandling(() => promptInstall());
  }

  ensureSupportedContainerVersion();

  if (!isContainerSystemRunning()) {
    await withExitHandling(() => promptStartSystem());
  }
}
