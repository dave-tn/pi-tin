import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import {
  ContainerListSchema,
  ContainerSystemVersionSchema,
  ImageListSchema,
  NpmDistTagsSchema,
  UpdateCheckCacheSchema,
  validateWorkspace,
  validateConfig,
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
    expect(v.parse(ContainerListSchema, [
      {
        id: 'pi-tin-demo',
        status: { state: 'running' },
      },
      {
        id: 'buildkit',
        status: { state: 'stopped' },
      },
    ])).toEqual([
      { id: 'pi-tin-demo', status: 'running' },
      { id: 'buildkit', status: 'stopped' },
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

describe('unknown-key rejection (typo detection)', () => {
  test('rejects unknown top-level config keys', () => {
    expect(() => validateConfig({ shell: 'bash', shel: 'zsh' })).toThrow();
  });

  test('rejects unknown top-level profile keys', () => {
    expect(() => validateContainerProfile({ ...baseProfile, packges: [] })).toThrow();
  });

  test('rejects unknown top-level workspace keys', () => {
    expect(() =>
      validateWorkspace({ profile: 'default', projects: ['/tmp/test'], stopAfterLastSesion: '5m' }),
    ).toThrow();
  });

  test('rejects unknown nested host keys', () => {
    expect(() =>
      validateWorkspace({ profile: 'default', projects: ['/tmp/test'], host: { sshAgnt: true } }),
    ).toThrow();
  });
});

describe('root-level validation errors', () => {
  test('null workspace input produces a message naming the problem', () => {
    expect(() => validateWorkspace(null)).toThrow(/Expected Object but received null/);
  });

  test('non-object workspace input produces a message naming the problem', () => {
    expect(() => validateWorkspace('hello')).toThrow(/Expected Object but received "hello"/);
  });

  test('null config input produces a message naming the problem', () => {
    expect(() => validateConfig(null)).toThrow(/Expected Object but received null/);
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

  test('still enforces element rules when the fields are supplied', () => {
    expect(() => validateContainerProfile({ ...minimal, packages: ['bad name'] })).toThrow();
    expect(() => validateContainerProfile({ ...minimal, env: { 'BAD-KEY': 'x' } })).toThrow();
  });
});

describe('ContainerProfileSchema cpus', () => {
  test('accepts a positive integer', () => {
    expect(validateContainerProfile({ ...baseProfile, cpus: 4 }).cpus).toBe(4);
  });

  test('accepts an omitted cpus', () => {
    expect(validateContainerProfile(baseProfile).cpus).toBeUndefined();
  });

  test('rejects zero, negative, fractional, and non-finite cpus', () => {
    expect(() => validateContainerProfile({ ...baseProfile, cpus: 0 })).toThrow();
    expect(() => validateContainerProfile({ ...baseProfile, cpus: -2 })).toThrow();
    expect(() => validateContainerProfile({ ...baseProfile, cpus: 1.5 })).toThrow();
    expect(() => validateContainerProfile({ ...baseProfile, cpus: Infinity })).toThrow();
    expect(() => validateContainerProfile({ ...baseProfile, cpus: NaN })).toThrow();
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

  test('rejects nonsense and malformed memory values', () => {
    expect(() => validateContainerProfile({ ...baseProfile, memory: 'banana' })).toThrow();
    expect(() => validateContainerProfile({ ...baseProfile, memory: '8 g' })).toThrow();
    expect(() => validateContainerProfile({ ...baseProfile, memory: '' })).toThrow();
  });

  test('rejects zero-valued memory sizes', () => {
    for (const mem of ['0', '0g', '0.0m', '00', '0b', '0.0']) {
      expect(() => validateContainerProfile({ ...baseProfile, memory: mem })).toThrow();
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

  test('rejects malformed host.env keys', () => {
    const invalidKeys = ['FOO=BAR', 'FOO\nBAR', '1FOO', 'FOO BAR', ''];
    for (const key of invalidKeys) {
      expect(() =>
        validateWorkspace({
          ...baseWorkspace,
          host: { env: { [key]: 'value' } },
        }),
      ).toThrow();
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
    const invalidTools = [
      {
        name: 'Claude Code',
        package: '@anthropic-ai/claude-code@latest',
        dotDirs: ['.claude'],
      },
      {
        name: 'Claude Code',
        package: '@anthropic-ai/claude-code@latest',
        hostModeSupported: false,
      },
      {
        name: 'Codex',
        package: '@openai/codex@latest',
        hostModeWarning: 'warning',
      },
      {
        name: 'Claude Code',
        package: '@anthropic-ai/claude-code@latest',
        binary: 'claude',
      },
      {
        name: 'Claude Code',
        package: '@anthropic-ai/claude-code@latest',
        skipPermissionsFlag: '--dangerously-skip-permissions',
      },
      {
        name: 'Claude Code',
        package: '@anthropic-ai/claude-code@latest',
        containerEnv: { CLAUDE_CODE_SANDBOXED: '1' },
      },
    ];

    for (const tool of invalidTools) {
      expect(() =>
        validateWorkspace({
          ...baseWorkspace,
          tools: [tool],
        }),
      ).toThrow();
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

  test('rejects invalid stopAfterLastSession values', () => {
    expect(() => validateWorkspace({
      ...baseWorkspace,
      stopAfterLastSession: '0s',
    })).toThrow();

    expect(() => validateWorkspace({
      ...baseWorkspace,
      stopAfterLastSession: '30',
    })).toThrow();

    expect(() => validateWorkspace({
      ...baseWorkspace,
      stopAfterLastSession: '1d',
    })).toThrow();
  });
});

describe('ConfigSchema shell', () => {
  test('accepts valid shell names', () => {
    expect(() => validateConfig({ shell: 'bash' })).not.toThrow();
    expect(() => validateConfig({ shell: 'zsh' })).not.toThrow();
    expect(() => validateConfig({ shell: 'fish' })).not.toThrow();
    expect(() => validateConfig({ shell: 'sh' })).not.toThrow();
    expect(() => validateConfig({ shell: 'dash' })).not.toThrow();
  });

  test('rejects shell with newline (injection)', () => {
    expect(() => validateConfig({ shell: 'bash\nRUN malicious' })).toThrow();
  });

  test('rejects shell with spaces', () => {
    expect(() => validateConfig({ shell: 'ba sh' })).toThrow();
  });

  test('rejects shell with slashes', () => {
    expect(() => validateConfig({ shell: '/bin/bash' })).toThrow();
  });

  test('rejects empty string', () => {
    expect(() => validateConfig({ shell: '' })).toThrow();
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
