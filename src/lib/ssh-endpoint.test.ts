import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  isSshdEnabled,
  ensureSshKeypair,
  renderWorkspaceHostBlock,
  upsertWorkspaceHostBlock,
  removeWorkspaceHostBlock,
  planSshInclude,
  appendSshInclude,
  sshIncludeLine,
  writeWorkspaceSshHostEntry,
  removeWorkspaceSshArtifacts,
  clearWorkspaceKnownHosts,
  probeSshEndpoint,
} from './ssh-endpoint.js';
import { getSshConfigPath, getSshKeyPath, getSshKnownHostsPath } from './paths.js';

let tmpDir: string;
let originalXdg: string | undefined;

// appendSshInclude takes an explicit path in tests (os.homedir() may be
// cached, so $HOME overrides are unreliable) — the real ~/.ssh is never
// touched.
const userConfigPathIn = (dir: string): string => path.join(dir, 'home', '.ssh', 'config');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
  originalXdg = process.env['XDG_CONFIG_HOME'];
  process.env['XDG_CONFIG_HOME'] = path.join(tmpDir, 'config');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalXdg === undefined) {
    delete process.env['XDG_CONFIG_HOME'];
  } else {
    process.env['XDG_CONFIG_HOME'] = originalXdg;
  }
});

describe('isSshdEnabled', () => {
  test('follows sshd and is implied by herdr attach', () => {
    expect(isSshdEnabled({ sshd: false, attach: 'shell' })).toBe(false);
    expect(isSshdEnabled({ sshd: true, attach: 'shell' })).toBe(true);
    expect(isSshdEnabled({ sshd: false, attach: 'herdr' })).toBe(true);
  });
});

describe('ensureSshKeypair', () => {
  const fakeKeygen = (args: string[]): void => {
    const keyPath = args[args.length - 1] ?? '';
    fs.writeFileSync(keyPath, 'PRIVATE', 'utf-8');
    fs.writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAAFAKE pi-tin\n', 'utf-8');
  };

  test('creates a 0700 ssh dir and returns the trimmed public key', () => {
    const { publicKey } = ensureSshKeypair(fakeKeygen);
    expect(publicKey).toBe('ssh-ed25519 AAAAFAKE pi-tin');
    const mode = fs.statSync(path.dirname(getSshKeyPath())).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test('does not regenerate an existing key', () => {
    ensureSshKeypair(fakeKeygen);
    let called = false;
    const failingKeygen = (): void => {
      called = true;
      throw new Error('should not run');
    };
    expect(ensureSshKeypair(failingKeygen).publicKey).toBe('ssh-ed25519 AAAAFAKE pi-tin');
    expect(called).toBe(false);
  });

  test('surfaces keygen failure with remediation', () => {
    const failingKeygen = (): void => {
      throw new Error('no ssh-keygen');
    };
    expect(() => ensureSshKeypair(failingKeygen)).toThrow(/ssh keypair/);
  });
});

describe('host block upsert/remove', () => {
  const block = (ws: string): string =>
    renderWorkspaceHostBlock({ workspaceName: ws, ipv4Address: '192.168.64.5', user: 'dev' });

  test('renders a complete managed block', () => {
    const rendered = block('demo');
    expect(rendered).toContain('Host pi-tin-demo');
    expect(rendered).toContain('HostName 192.168.64.5');
    expect(rendered).toContain('Port 2222');
    expect(rendered).toContain('User dev');
    expect(rendered).toContain(`IdentityFile ${getSshKeyPath()}`);
    expect(rendered).toContain(`UserKnownHostsFile ${getSshKnownHostsPath('demo')}`);
    expect(rendered).toContain('StrictHostKeyChecking accept-new');
  });

  test('upserts into empty content and is idempotent', () => {
    const once = upsertWorkspaceHostBlock(null, 'demo', block('demo'));
    const twice = upsertWorkspaceHostBlock(once, 'demo', block('demo'));
    expect(once).toBe(`${block('demo')}\n`);
    expect(twice).toBe(once);
  });

  test('replaces an existing block without touching neighbours', () => {
    const both = upsertWorkspaceHostBlock(
      upsertWorkspaceHostBlock(null, 'alpha', block('alpha')),
      'beta',
      block('beta'),
    );
    const updated = upsertWorkspaceHostBlock(
      both,
      'alpha',
      renderWorkspaceHostBlock({ workspaceName: 'alpha', ipv4Address: '192.168.64.9', user: 'dev' }),
    );
    expect(updated).toContain('192.168.64.9');
    expect(updated).toContain('Host pi-tin-beta');
    expect(updated.match(/Host pi-tin-alpha/g)).toHaveLength(1);
  });

  test('remove returns null when the block is absent and strips it when present', () => {
    expect(removeWorkspaceHostBlock(null, 'demo')).toBeNull();
    expect(removeWorkspaceHostBlock('# unrelated\n', 'demo')).toBeNull();

    const both = upsertWorkspaceHostBlock(
      upsertWorkspaceHostBlock(null, 'alpha', block('alpha')),
      'beta',
      block('beta'),
    );
    const removed = removeWorkspaceHostBlock(both, 'alpha');
    expect(removed).not.toBeNull();
    expect(removed).not.toContain('pi-tin-alpha');
    expect(removed).toContain('Host pi-tin-beta');
  });
});

describe('planSshInclude', () => {
  test('none when the config already references the include path', () => {
    expect(planSshInclude({
      userSshConfigContent: `Include ${getSshConfigPath()}\n`,
      includePath: getSshConfigPath(),
      isInteractive: true,
    })).toBe('none');
  });

  test('offers interactively, hints otherwise', () => {
    expect(planSshInclude({
      userSshConfigContent: null,
      includePath: getSshConfigPath(),
      isInteractive: true,
    })).toBe('offer-append');
    expect(planSshInclude({
      userSshConfigContent: 'Host other\n',
      includePath: getSshConfigPath(),
      isInteractive: false,
    })).toBe('hint');
  });
});

describe('appendSshInclude', () => {
  test('creates the ssh config with the include line and 0600 mode', () => {
    const configPath = userConfigPathIn(tmpDir);
    appendSshInclude(configPath);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(`${sshIncludeLine()}\n`);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test('prepends before existing content and backs the file up once', () => {
    const configPath = userConfigPathIn(tmpDir);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'Host existing\n  User me\n', 'utf-8');

    appendSshInclude(configPath);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content.startsWith(`${sshIncludeLine()}\n`)).toBe(true);
    expect(content).toContain('Host existing');
    expect(fs.readFileSync(`${configPath}.pi-tin.bak`, 'utf-8')).toBe('Host existing\n  User me\n');
  });
});

describe('workspace ssh artifacts round-trip', () => {
  test('write, then remove with known_hosts clearing', () => {
    writeWorkspaceSshHostEntry({ workspaceName: 'demo', ipv4Address: '192.168.64.5', user: 'dev' });
    fs.writeFileSync(getSshKnownHostsPath('demo'), 'pinned\n', 'utf-8');

    expect(fs.readFileSync(getSshConfigPath(), 'utf-8')).toContain('Host pi-tin-demo');

    removeWorkspaceSshArtifacts('demo', { clearKnownHosts: true });
    expect(fs.readFileSync(getSshConfigPath(), 'utf-8')).not.toContain('pi-tin-demo');
    expect(fs.existsSync(getSshKnownHostsPath('demo'))).toBe(false);
  });

  test('clearWorkspaceKnownHosts is a no-op when absent', () => {
    expect(() => clearWorkspaceKnownHosts('missing')).not.toThrow();
  });
});

describe('probeSshEndpoint', () => {
  test('resolves true against a listening socket and false against a closed port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a bound tcp address');
    }

    try {
      expect(await probeSshEndpoint('127.0.0.1', address.port, { attempts: 1 })).toBe(true);
    } finally {
      server.close();
    }

    expect(await probeSshEndpoint('127.0.0.1', address.port, {
      attempts: 2,
      retryDelayMs: 10,
      connectTimeoutMs: 100,
    })).toBe(false);
  });
});
