import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import {
  ContainerListSchema,
  ContainerSystemStatusSchema,
  ContainerSystemVersionSchema,
  HerdrAgentListSchema,
  ImageListSchema,
  NpmDistTagsSchema,
  UpdateCheckCacheSchema,
  parseAttachMode,
  validateWorkspace,
  validateContainerProfile,
} from './validators.js';

const baseProfile = {
  description: 'test',
  base_image: 'node:trixie-slim',
  user: 'dev',
  packages: [],
  extra_packages: [],
  global_tools: [],
  post_install: [],
  env: {},
};

describe('container CLI JSON schemas', () => {
  test('parses Apple container 1.0 container list output', () => {
    // Running entries carry status.networks with a CIDR ipv4Address; stopped
    // entries have no networks key at all (verified against the 1.0.0 source:
    // ManagedContainer → ContainerStatus → Attachment).
    expect(v.parse(ContainerListSchema, [
      {
        id: 'pi-tin-demo',
        status: {
          state: 'running',
          networks: [{
            network: 'default',
            hostname: 'pi-tin-demo',
            ipv4Address: '192.168.64.5/24',
            ipv4Gateway: '192.168.64.1',
          }],
        },
      },
      {
        id: 'buildkit',
        status: { state: 'stopped' },
      },
    ])).toEqual([
      { id: 'pi-tin-demo', status: 'running', ipv4Address: '192.168.64.5' },
      { id: 'buildkit', status: 'stopped', ipv4Address: null },
    ]);
  });

  test('container list entries with empty or addressless networks parse to a null address', () => {
    expect(v.parse(ContainerListSchema, [
      { id: 'a', status: { state: 'running', networks: [] } },
      { id: 'b', status: { state: 'running', networks: [{ network: 'default' }] } },
    ])).toEqual([
      { id: 'a', status: 'running', ipv4Address: null },
      { id: 'b', status: 'running', ipv4Address: null },
    ]);
  });

  test('parses Apple container 1.0 image list output', () => {
    expect(v.parse(ImageListSchema, [
      {
        configuration: { name: 'pi-tin-demo:latest' },
      },
      {
        configuration: { name: 'ghcr.io/apple/container-builder-shim/builder:1.0.0' },
      },
    ])).toEqual([
      'pi-tin-demo:latest',
      'ghcr.io/apple/container-builder-shim/builder:1.0.0',
    ]);
  });

  test('parses Apple container 1.0 system status output', () => {
    // Verified sample from container 1.0.0 on macOS; extra fields are ignored.
    expect(v.parse(ContainerSystemStatusSchema, {
      apiServerAppName: 'container-apiserver',
      apiServerBuild: 'release',
      apiServerCommit: 'unspecified',
      apiServerVersion: 'container-apiserver version 1.0.0 (build: release, commit: unspeci)',
      appRoot: '/Users/dev/Library/Application Support/com.apple.container/',
      installRoot: '/opt/homebrew/Cellar/container/1.0.0_1/',
      status: 'running',
    })).toEqual({ status: 'running' });
    expect(v.parse(ContainerSystemStatusSchema, { status: 'not running' }))
      .toEqual({ status: 'not running' });
    expect(v.parse(ContainerSystemStatusSchema, { status: 'unregistered' }))
      .toEqual({ status: 'unregistered' });
    expect(() => v.parse(ContainerSystemStatusSchema, {})).toThrow();
  });

  test('parses Apple container 1.0 system version output', () => {
    expect(v.parse(ContainerSystemVersionSchema, [
      {
        appName: 'container',
        buildType: 'release',
        commit: 'unspecified',
        version: '1.0.0',
      },
    ])).toEqual([
      {
        appName: 'container',
        version: '1.0.0',
      },
    ]);
  });
});

// Hand-written copy of the user-facing rule text in validators.ts. Deliberately
// not imported: an expectation derived from the module under test cannot detect
// the message changing, because both sides move together.
const WORKSPACE_STATE_RULE =
  'Workspace state paths must be home-relative (e.g. ".zsh_history" or ".local/share/zoxide"): '
  + 'no leading "/", no "." or ".." segments, and only letters, digits, ".", "_", "-".';

describe('unknown-key rejection (typo detection)', () => {
  test('rejects unknown top-level profile keys, naming the offending key', () => {
    expect(() => validateContainerProfile({ ...baseProfile, packges: [] })).toThrow(
      'Invalid container profile configuration:\n  packges: Invalid key: Expected never but received "packges"',
    );
  });

  test('rejects unknown top-level workspace keys, naming the offending key', () => {
    expect(() =>
      validateWorkspace({ profile: 'default', projects: ['/tmp/test'], stopAfterLastSesion: '5m' }),
    ).toThrow(
      'Invalid workspace configuration:\n  stopAfterLastSesion: Invalid key: Expected never but received "stopAfterLastSesion"',
    );
  });

  test('rejects unknown nested host keys with the dotted field path', () => {
    expect(() =>
      validateWorkspace({ profile: 'default', projects: ['/tmp/test'], host: { sshAgnt: true } }),
    ).toThrow(
      'Invalid workspace configuration:\n  host.sshAgnt: Invalid key: Expected never but received "sshAgnt"',
    );
  });
});

describe('root-level validation errors', () => {
  test('null workspace input produces a message naming the problem', () => {
    expect(() => validateWorkspace(null)).toThrow(
      'Invalid workspace configuration:\n  Invalid type: Expected Object but received null',
    );
  });

  test('non-object workspace input produces a message naming the problem', () => {
    expect(() => validateWorkspace('hello')).toThrow(
      'Invalid workspace configuration:\n  Invalid type: Expected Object but received "hello"',
    );
  });
});

describe('ContainerProfileSchema optional collection fields', () => {
  const minimal = {
    description: 'minimal',
    base_image: 'debian:trixie-slim',
    user: 'dev',
  };

  test('collection fields default to empty when omitted', () => {
    const profile = validateContainerProfile(minimal);
    expect(profile.packages).toEqual([]);
    expect(profile.extra_packages).toEqual([]);
    expect(profile.global_tools).toEqual([]);
    expect(profile.post_install).toEqual([]);
    expect(profile.post_setup).toEqual([]);
    expect(profile.env).toEqual({});
  });

  test('still enforces element rules when the fields are supplied, naming the element', () => {
    expect(() => validateContainerProfile({ ...minimal, packages: ['bad name'] })).toThrow(
      'Invalid container profile configuration:\n'
      + '  packages.0: Invalid format: Expected /^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/ but received "bad name"',
    );
    expect(() => validateContainerProfile({ ...minimal, env: { 'BAD-KEY': 'x' } })).toThrow(
      'Invalid container profile configuration:\n'
      + '  env.BAD-KEY: Invalid format: Expected /^[A-Za-z_][A-Za-z0-9_]*$/ but received "BAD-KEY"',
    );
  });

  test('workspace_state defaults to empty when omitted', () => {
    expect(validateContainerProfile(minimal).workspace_state).toEqual([]);
  });
});

describe('ContainerProfileSchema workspace_state', () => {
  test('accepts home-relative file and directory paths', () => {
    const profile = validateContainerProfile({
      ...baseProfile,
      workspace_state: ['.zsh_history', '.local/share/zoxide'],
    });
    expect(profile.workspace_state).toEqual(['.zsh_history', '.local/share/zoxide']);
  });

  // Every rejection must name the offending array element and restate the rule
  // — a regression that collapsed these into a bare "invalid profile" would
  // leave the user with no idea which entry to fix.
  const expectedRejection = `Invalid container profile configuration:\n  workspace_state.0: ${WORKSPACE_STATE_RULE}`;

  test('rejects absolute paths', () => {
    expect(() => validateContainerProfile({ ...baseProfile, workspace_state: ['/etc/passwd'] }))
      .toThrow(expectedRejection);
  });

  test('rejects paths that escape home via .. segments', () => {
    expect(() => validateContainerProfile({ ...baseProfile, workspace_state: ['../secrets'] }))
      .toThrow(expectedRejection);
    expect(() => validateContainerProfile({ ...baseProfile, workspace_state: ['.local/../../x'] }))
      .toThrow(expectedRejection);
  });

  test('rejects bare . or .. segments', () => {
    expect(() => validateContainerProfile({ ...baseProfile, workspace_state: ['.'] }))
      .toThrow(expectedRejection);
    expect(() => validateContainerProfile({ ...baseProfile, workspace_state: ['..'] }))
      .toThrow(expectedRejection);
    expect(() => validateContainerProfile({ ...baseProfile, workspace_state: ['a/./b'] }))
      .toThrow(expectedRejection);
  });

  test('rejects paths with shell metacharacters or whitespace', () => {
    expect(() => validateContainerProfile({ ...baseProfile, workspace_state: ['.config/$(whoami)'] }))
      .toThrow(expectedRejection);
    expect(() => validateContainerProfile({ ...baseProfile, workspace_state: ['.config/a b'] }))
      .toThrow(expectedRejection);
    expect(() => validateContainerProfile({ ...baseProfile, workspace_state: ['.config/a\nb'] }))
      .toThrow(expectedRejection);
  });

  test('rejects an empty path', () => {
    expect(() => validateContainerProfile({ ...baseProfile, workspace_state: [''] }))
      .toThrow(expectedRejection);
  });

  test('names the failing element by index, not just the field', () => {
    expect(() => validateContainerProfile({
      ...baseProfile,
      workspace_state: ['.zsh_history', '.config/a b'],
    })).toThrow(`Invalid container profile configuration:\n  workspace_state.1: ${WORKSPACE_STATE_RULE}`);
  });
});

describe('ContainerProfileSchema cpus', () => {
  test('accepts a positive integer', () => {
    expect(validateContainerProfile({ ...baseProfile, cpus: 4 }).cpus).toBe(4);
  });

  test('accepts an omitted cpus', () => {
    expect(validateContainerProfile(baseProfile).cpus).toBeUndefined();
  });

  test('rejects zero, negative, fractional, and non-finite cpus, naming the field and value', () => {
    expect(() => validateContainerProfile({ ...baseProfile, cpus: 0 }))
      .toThrow('Invalid container profile configuration:\n  cpus: Invalid value: Expected >=1 but received 0');
    expect(() => validateContainerProfile({ ...baseProfile, cpus: -2 }))
      .toThrow('Invalid container profile configuration:\n  cpus: Invalid value: Expected >=1 but received -2');
    expect(() => validateContainerProfile({ ...baseProfile, cpus: 1.5 }))
      .toThrow('Invalid container profile configuration:\n  cpus: Invalid integer: Received 1.5');
    expect(() => validateContainerProfile({ ...baseProfile, cpus: Infinity }))
      .toThrow('Invalid container profile configuration:\n  cpus: Invalid integer: Received Infinity');
    expect(() => validateContainerProfile({ ...baseProfile, cpus: NaN }))
      .toThrow('Invalid container profile configuration:\n  cpus: Invalid type: Expected number but received NaN');
  });
});

describe('ContainerProfileSchema memory', () => {
  test('accepts sizes with and without units', () => {
    expect(validateContainerProfile({ ...baseProfile, memory: '8g' }).memory).toBe('8g');
    expect(validateContainerProfile({ ...baseProfile, memory: '512m' }).memory).toBe('512m');
    expect(validateContainerProfile({ ...baseProfile, memory: '2gb' }).memory).toBe('2gb');
    expect(validateContainerProfile({ ...baseProfile, memory: '1024' }).memory).toBe('1024');
  });

  test('accepts the K/M/G/T/P suffixes documented in the README', () => {
    for (const mem of ['16k', '16m', '16g', '16t', '16p', '16tb']) {
      expect(validateContainerProfile({ ...baseProfile, memory: mem }).memory).toBe(mem);
    }
  });

  // The size pattern itself is long and is already pinned by the accept tests
  // above, so the wildcard covers it — what must not regress is the message
  // naming the `memory` field and echoing the value the user actually wrote.
  test('rejects nonsense and malformed memory values, naming the field and value', () => {
    expect(() => validateContainerProfile({ ...baseProfile, memory: 'banana' }))
      .toThrow(/^Invalid container profile configuration:\n {2}memory: Invalid format: .* but received "banana"$/);
    expect(() => validateContainerProfile({ ...baseProfile, memory: '8 g' }))
      .toThrow(/^Invalid container profile configuration:\n {2}memory: Invalid format: .* but received "8 g"$/);
    expect(() => validateContainerProfile({ ...baseProfile, memory: '' }))
      .toThrow(/^Invalid container profile configuration:\n {2}memory: Invalid format: .* but received ""$/);
  });

  test('rejects zero-valued memory sizes, echoing the rejected value', () => {
    const zeroSizes = ['0', '0g', '0.0m', '00', '0b', '0.0'] as const;
    for (const mem of zeroSizes) {
      expect(() => validateContainerProfile({ ...baseProfile, memory: mem }))
        .toThrow('Invalid container profile configuration:\n  memory: Invalid format:');
      expect(() => validateContainerProfile({ ...baseProfile, memory: mem }))
        .toThrow(`but received "${mem}"`);
    }
  });

  test('accepts positive fractional memory sizes', () => {
    expect(validateContainerProfile({ ...baseProfile, memory: '0.5g' }).memory).toBe('0.5g');
    expect(validateContainerProfile({ ...baseProfile, memory: '8g' }).memory).toBe('8g');
    expect(validateContainerProfile({ ...baseProfile, memory: '512m' }).memory).toBe('512m');
  });
});

describe('WorkspaceSchema agent.profiles', () => {
  const baseWorkspace = {
    profile: 'default',
    projects: ['/tmp/test'],
  };

  test('validates workspace without agent section', () => {
    const result = validateWorkspace(baseWorkspace);
    expect(result.agent).toBeUndefined();
  });

  test('validates workspace with agent.profiles', () => {
    const result = validateWorkspace({
      ...baseWorkspace,
      agent: { profiles: ['personal', 'work-codex'] },
    });
    expect(result.agent?.profiles).toEqual(['personal', 'work-codex']);
  });

  test('defaults agent.profiles to empty array when agent is provided', () => {
    const result = validateWorkspace({
      ...baseWorkspace,
      agent: {},
    });
    expect(result.agent?.profiles).toEqual([]);
  });

  test('defaults agent.skipPermissions to true', () => {
    const result = validateWorkspace({
      ...baseWorkspace,
      agent: {},
    });
    expect(result.agent?.skipPermissions).toBe(true);
  });
});

describe('WorkspaceSchema host', () => {
  const baseWorkspace = {
    profile: 'default',
    projects: ['/tmp/test'],
  };

  test('validates workspace without host section', () => {
    const result = validateWorkspace(baseWorkspace);
    expect(result.host).toBeUndefined();
  });

  test('defaults host.sshAgent to true', () => {
    const result = validateWorkspace({
      ...baseWorkspace,
      host: {},
    });
    expect(result.host?.sshAgent).toBe(true);
  });

  test('defaults host.githubCLI to false', () => {
    const result = validateWorkspace({
      ...baseWorkspace,
      host: {},
    });
    expect(result.host?.githubCLI).toBe(false);
  });

  test('validates host.mounts', () => {
    const result = validateWorkspace({
      ...baseWorkspace,
      host: {
        mounts: [{ host: '~/.aws', container: '/home/dev/.aws', readonly: true }],
      },
    });
    expect(result.host?.mounts).toHaveLength(1);
  });

  test('validates host.env', () => {
    const result = validateWorkspace({
      ...baseWorkspace,
      host: {
        env: { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}' },
      },
    });
    expect(result.host?.env).toEqual({ ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}' });
  });

  test('rejects malformed host.env keys, naming the offending key', () => {
    // Hand-written expectations: the value of these tests is that the message
    // still points at `host.env.<key>` rather than a generic rejection.
    const invalidKeys: ReadonlyArray<{ key: string; message: string }> = [
      {
        key: 'FOO=BAR',
        message: 'Invalid workspace configuration:\n'
          + '  host.env.FOO=BAR: Invalid format: Expected /^[A-Za-z_][A-Za-z0-9_]*$/ but received "FOO=BAR"',
      },
      {
        key: 'FOO\nBAR',
        message: 'Invalid workspace configuration:\n'
          + '  host.env.FOO\nBAR: Invalid format: Expected /^[A-Za-z_][A-Za-z0-9_]*$/ but received "FOO\nBAR"',
      },
      {
        key: '1FOO',
        message: 'Invalid workspace configuration:\n'
          + '  host.env.1FOO: Invalid format: Expected /^[A-Za-z_][A-Za-z0-9_]*$/ but received "1FOO"',
      },
      {
        key: 'FOO BAR',
        message: 'Invalid workspace configuration:\n'
          + '  host.env.FOO BAR: Invalid format: Expected /^[A-Za-z_][A-Za-z0-9_]*$/ but received "FOO BAR"',
      },
      {
        key: '',
        message: 'Invalid workspace configuration:\n'
          + '  host.env.: Invalid format: Expected /^[A-Za-z_][A-Za-z0-9_]*$/ but received ""',
      },
    ];
    for (const { key, message } of invalidKeys) {
      expect(() =>
        validateWorkspace({
          ...baseWorkspace,
          host: { env: { [key]: 'value' } },
        }),
      ).toThrow(message);
    }
  });
});

describe('WorkspaceSchema tools', () => {
  const baseWorkspace = {
    profile: 'default',
    projects: ['/tmp/test'],
  };

  test('defaults tools to empty array', () => {
    const result = validateWorkspace(baseWorkspace);
    expect(result.tools).toEqual([]);
  });

  test('validates tools with name and package', () => {
    const result = validateWorkspace({
      ...baseWorkspace,
      tools: [{ name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' }],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe('Claude Code');
  });

  test('rejects internal agent metadata fields (workspaces must persist only name/package)', () => {
    // `pi-tin create` writes a minimal {name, package} tool. Internal agent
    // metadata must not be persisted; a workspace carrying it is rejected so
    // the mismatch is surfaced rather than silently ignored.
    const invalidTools: ReadonlyArray<{ tool: Record<string, unknown>; message: string }> = [
      {
        tool: {
          name: 'Claude Code',
          package: '@anthropic-ai/claude-code@latest',
          dotDirs: ['.claude'],
        },
        message: 'Invalid workspace configuration:\n'
          + '  tools.0.dotDirs: Invalid key: Expected never but received "dotDirs"',
      },
      {
        tool: {
          name: 'Claude Code',
          package: '@anthropic-ai/claude-code@latest',
          hostModeSupported: false,
        },
        message: 'Invalid workspace configuration:\n'
          + '  tools.0.hostModeSupported: Invalid key: Expected never but received "hostModeSupported"',
      },
      {
        tool: {
          name: 'Codex',
          package: '@openai/codex@latest',
          hostModeWarning: 'warning',
        },
        message: 'Invalid workspace configuration:\n'
          + '  tools.0.hostModeWarning: Invalid key: Expected never but received "hostModeWarning"',
      },
      {
        tool: {
          name: 'Claude Code',
          package: '@anthropic-ai/claude-code@latest',
          binary: 'claude',
        },
        message: 'Invalid workspace configuration:\n'
          + '  tools.0.binary: Invalid key: Expected never but received "binary"',
      },
      {
        tool: {
          name: 'Claude Code',
          package: '@anthropic-ai/claude-code@latest',
          skipPermissionsFlag: '--dangerously-skip-permissions',
        },
        message: 'Invalid workspace configuration:\n'
          + '  tools.0.skipPermissionsFlag: Invalid key: Expected never but received "skipPermissionsFlag"',
      },
      {
        tool: {
          name: 'Claude Code',
          package: '@anthropic-ai/claude-code@latest',
          containerEnv: { CLAUDE_CODE_SANDBOXED: '1' },
        },
        message: 'Invalid workspace configuration:\n'
          + '  tools.0.containerEnv: Invalid key: Expected never but received "containerEnv"',
      },
    ];

    for (const { tool, message } of invalidTools) {
      expect(() =>
        validateWorkspace({
          ...baseWorkspace,
          tools: [tool],
        }),
      ).toThrow(message);
    }
  });
});

describe('WorkspaceSchema tmux', () => {
  const baseWorkspace = {
    profile: 'default',
    projects: ['/tmp/test'],
  };

  test('validates host tmux mode', () => {
    const result = validateWorkspace({
      ...baseWorkspace,
      tmux: { mode: 'host', mountPlugins: true },
    });
    expect(result.tmux?.mode).toBe('host');
    expect(result.tmux?.mountPlugins).toBe(true);
  });

  test('defaults mountPlugins to false', () => {
    const result = validateWorkspace({
      ...baseWorkspace,
      tmux: { mode: 'host' },
    });
    expect(result.tmux?.mountPlugins).toBe(false);
  });

  test('validates isolated tmux mode', () => {
    const result = validateWorkspace({
      ...baseWorkspace,
      tmux: { mode: 'isolated' },
    });
    expect(result.tmux?.mode).toBe('isolated');
  });
});

describe('WorkspaceSchema sshd and attach', () => {
  const baseWorkspace = {
    profile: 'default',
    projects: ['/tmp/test'],
  };

  test('defaults to sshd off and shell attach', () => {
    const result = validateWorkspace(baseWorkspace);
    expect(result.sshd).toBe(false);
    expect(result.attach).toBe('shell');
  });

  test('accepts sshd true and herdr attach', () => {
    const result = validateWorkspace({ ...baseWorkspace, sshd: true, attach: 'herdr' });
    expect(result.sshd).toBe(true);
    expect(result.attach).toBe('herdr');
  });

  test('rejects an unknown attach mode, naming the field and listing the modes', () => {
    expect(() => validateWorkspace({ ...baseWorkspace, attach: 'tmux' })).toThrow(
      'Invalid workspace configuration:\n'
      + '  attach: Invalid type: Expected ("shell" | "herdr") but received "tmux"',
    );
  });
});

describe('parseAttachMode', () => {
  test('narrows valid modes', () => {
    expect(parseAttachMode('shell')).toBe('shell');
    expect(parseAttachMode('herdr')).toBe('herdr');
  });

  test('returns null for anything else', () => {
    expect(parseAttachMode('tmux')).toBeNull();
    expect(parseAttachMode('')).toBeNull();
  });
});

describe('HerdrAgentListSchema', () => {
  // Verified live output of `herdr agent list` (herdr 0.7.x).
  test('parses the real result.agents wire shape and normalises agent_status', () => {
    expect(v.parse(HerdrAgentListSchema, {
      id: 'cli:agent:list',
      result: {
        agents: [
          { agent: 'claude', agent_status: 'working', pane_id: 'w1:p1' },
          { agent: 'codex', agent_status: 'idle', pane_id: 'w1:p2' },
          { agent: 'pi' },
        ],
        type: 'agent_list',
      },
    })).toEqual([
      { status: 'working' },
      { status: 'idle' },
      { status: null },
    ]);
  });

  test('rejects a payload without result.agents', () => {
    expect(() => v.parse(HerdrAgentListSchema, { agents: [{ status: 'done' }] })).toThrow();
  });
});

describe('WorkspaceSchema stopAfterLastSession', () => {
  const baseWorkspace = {
    profile: 'default',
    projects: ['/tmp/test'],
  };

  test('defaults stopAfterLastSession to 30s', () => {
    const result = validateWorkspace(baseWorkspace);
    expect(result.stopAfterLastSession).toBe('30s');
  });

  test('accepts valid stopAfterLastSession values', () => {
    expect(validateWorkspace({
      ...baseWorkspace,
      stopAfterLastSession: '1s',
    }).stopAfterLastSession).toBe('1s');

    expect(validateWorkspace({
      ...baseWorkspace,
      stopAfterLastSession: '5m',
    }).stopAfterLastSession).toBe('5m');

    expect(validateWorkspace({
      ...baseWorkspace,
      stopAfterLastSession: '1h',
    }).stopAfterLastSession).toBe('1h');
  });

  test('rejects invalid stopAfterLastSession values, naming the field and value', () => {
    expect(() => validateWorkspace({
      ...baseWorkspace,
      stopAfterLastSession: '0s',
    })).toThrow(
      'Invalid workspace configuration:\n'
      + '  stopAfterLastSession: Invalid format: Expected /^[1-9]\\d*[smh]$/ but received "0s"',
    );

    expect(() => validateWorkspace({
      ...baseWorkspace,
      stopAfterLastSession: '30',
    })).toThrow(
      'Invalid workspace configuration:\n'
      + '  stopAfterLastSession: Invalid format: Expected /^[1-9]\\d*[smh]$/ but received "30"',
    );

    expect(() => validateWorkspace({
      ...baseWorkspace,
      stopAfterLastSession: '1d',
    })).toThrow(
      'Invalid workspace configuration:\n'
      + '  stopAfterLastSession: Invalid format: Expected /^[1-9]\\d*[smh]$/ but received "1d"',
    );
  });
});


describe('NpmDistTagsSchema', () => {
  test('accepts a dist-tags payload and ignores extra tags', () => {
    const parsed = v.safeParse(NpmDistTagsSchema, { latest: '0.2.0', beta: '0.3.0-beta.1' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.latest).toBe('0.2.0');
    }
  });

  test('rejects a payload missing latest', () => {
    expect(v.safeParse(NpmDistTagsSchema, { beta: '0.3.0' }).success).toBe(false);
  });

  test('rejects a non-string latest', () => {
    expect(v.safeParse(NpmDistTagsSchema, { latest: 2 }).success).toBe(false);
  });
});

describe('UpdateCheckCacheSchema', () => {
  test('accepts a well-formed cache', () => {
    const parsed = v.safeParse(UpdateCheckCacheSchema, { lastCheckMs: 1_700_000_000_000, latestVersion: '0.2.0' });
    expect(parsed.success).toBe(true);
  });

  test('rejects a cache with a non-numeric timestamp', () => {
    expect(v.safeParse(UpdateCheckCacheSchema, { lastCheckMs: 'soon', latestVersion: '0.2.0' }).success).toBe(false);
  });

  test('rejects a cache missing latestVersion', () => {
    expect(v.safeParse(UpdateCheckCacheSchema, { lastCheckMs: 1 }).success).toBe(false);
  });
});
