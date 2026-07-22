import { describe, expect, test } from 'bun:test';
import {
  availableApiKeyVars,
  buildWorkspace,
  commonMountChoices,
  defaultContainerPath,
  forwardedEnv,
  gitIdentityEnv,
  gitIdentityLabel,
  hostProfileNameFor,
  parseTimezoneFromLocaltimePath,
  planAgentProfileSelection,
  timezoneEnv,
  tmuxModeChoices,
} from '../lib/create-flow.js';

describe('planAgentProfileSelection', () => {
  const agent = { dotDirs: ['.claude'] };

  test('creates a default profile when no profiles or host config exist', () => {
    expect(planAgentProfileSelection(agent, [], false)).toEqual({
      action: 'create-default',
    });
  });

  test('ignores profiles whose mounts belong to other agents', () => {
    const profiles = [
      { name: 'codex', mode: 'isolated' as const, mounts: ['.codex'] },
    ];
    expect(planAgentProfileSelection(agent, profiles, false)).toEqual({
      action: 'create-default',
    });
  });

  test('offers existing isolated profiles plus Create new', () => {
    const profiles = [
      { name: 'claude-work', mode: 'isolated' as const, mounts: ['.claude'] },
    ];
    expect(planAgentProfileSelection(agent, profiles, false)).toEqual({
      action: 'choose',
      choices: [
        { name: 'claude-work [isolated]', value: { kind: 'existing', profileName: 'claude-work' } },
        { name: 'Create new...', value: { kind: 'create-new' } },
      ],
    });
  });

  test('puts the host config option first when host config exists', () => {
    const plan = planAgentProfileSelection(
      { dotDirs: ['.local/share/opencode', '.config/opencode'] },
      [{ name: 'oc', mode: 'isolated', mounts: ['.local/share/opencode', '.config/opencode'] }],
      true,
    );
    expect(plan).toEqual({
      action: 'choose',
      choices: [
        { name: 'Use host config (~/.local/share/opencode, ~/.config/opencode) [host]', value: { kind: 'use-host', existingProfileName: undefined } },
        { name: 'oc [isolated]', value: { kind: 'existing', profileName: 'oc' } },
        { name: 'Create new...', value: { kind: 'create-new' } },
      ],
    });
  });

  test('hides host-mode profiles from the menu but carries them on the host choice for silent reuse', () => {
    const profiles = [
      { name: 'claude-host', mode: 'host' as const, mounts: ['.claude'] },
    ];
    expect(planAgentProfileSelection(agent, profiles, true)).toEqual({
      action: 'choose',
      choices: [
        { name: 'Use host config (~/.claude) [host]', value: { kind: 'use-host', existingProfileName: 'claude-host' } },
        { name: 'Create new...', value: { kind: 'create-new' } },
      ],
    });
  });

  test('falls back to creating a default profile when only a hidden host profile exists and host config is gone', () => {
    // Host-mode profiles never appear in the menu, so with no host config
    // there is nothing left to choose from.
    const profiles = [
      { name: 'claude-host', mode: 'host' as const, mounts: ['.claude'] },
    ];
    expect(planAgentProfileSelection(agent, profiles, false)).toEqual({
      action: 'create-default',
    });
  });
});

describe('hostProfileNameFor', () => {
  test('appends -host to the slugified agent name', () => {
    expect(hostProfileNameFor({ name: 'Codex' })).toBe('codex-host');
    expect(hostProfileNameFor({ name: 'Gemini CLI' })).toBe('gemini-cli-host');
  });
});

describe('gitIdentityLabel', () => {
  test('joins name and email with a comma', () => {
    expect(gitIdentityLabel('Ada', 'ada@example.com')).toBe('Ada, ada@example.com');
  });

  test('omits missing parts', () => {
    expect(gitIdentityLabel('Ada', undefined)).toBe('Ada');
    expect(gitIdentityLabel(undefined, 'ada@example.com')).toBe('ada@example.com');
  });
});

describe('gitIdentityEnv', () => {
  test('sets author and committer vars for name and email', () => {
    expect(gitIdentityEnv('Ada', 'ada@example.com')).toEqual({
      GIT_AUTHOR_NAME: 'Ada',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    });
  });

  test('only sets vars for the parts that exist', () => {
    expect(gitIdentityEnv(undefined, 'ada@example.com')).toEqual({
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    });
    expect(gitIdentityEnv('Ada', undefined)).toEqual({
      GIT_AUTHOR_NAME: 'Ada',
      GIT_COMMITTER_NAME: 'Ada',
    });
    expect(gitIdentityEnv(undefined, undefined)).toEqual({});
  });
});

describe('availableApiKeyVars', () => {
  test('returns only the vars set on the host, in canonical order', () => {
    expect(availableApiKeyVars({
      OPENROUTER_API_KEY: 'sk-or',
      ANTHROPIC_API_KEY: 'sk-ant',
      UNRELATED: 'x',
    })).toEqual([
      { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key' },
      { name: 'OPENROUTER_API_KEY', label: 'OpenRouter API key' },
    ]);
  });

  test('treats empty values as unset', () => {
    expect(availableApiKeyVars({ OPENAI_API_KEY: '' })).toEqual([]);
  });
});

describe('forwardedEnv', () => {
  test('forwards vars by reference so values stay on the host', () => {
    expect(forwardedEnv(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])).toEqual({
      ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}',
      OPENAI_API_KEY: '${OPENAI_API_KEY}',
    });
  });

  test('returns an empty record for no selection', () => {
    expect(forwardedEnv([])).toEqual({});
  });
});

describe('tmuxModeChoices', () => {
  test('offers isolated and none when no host config is available', () => {
    expect(tmuxModeChoices(false)).toEqual([
      { name: 'Create isolated persistent tmux config for this workspace [isolated]', value: 'isolated' },
      { name: 'No tmux config', value: 'none' },
    ]);
  });

  test('puts the host option first when a host config is available', () => {
    expect(tmuxModeChoices(true)).toEqual([
      { name: 'Use host tmux config (~/.config/tmux) [host, read-only]', value: 'host' },
      { name: 'Create isolated persistent tmux config for this workspace [isolated]', value: 'isolated' },
      { name: 'No tmux config', value: 'none' },
    ]);
  });
});

describe('commonMountChoices', () => {
  test('maps the common mounts onto the container home, read-only', () => {
    expect(commonMountChoices('/home/dev')).toEqual([
      { name: '~/.gnupg (GPG keys, read-only)', value: { host: '~/.gnupg', container: '/home/dev/.gnupg', readonly: true } },
      { name: '~/.aws (AWS credentials, read-only)', value: { host: '~/.aws', container: '/home/dev/.aws', readonly: true } },
    ]);
  });
});

describe('defaultContainerPath', () => {
  test('maps ~/ paths onto the container home', () => {
    expect(defaultContainerPath('~/projects/site', '/home/dev')).toBe('/home/dev/projects/site');
  });

  test('maps a bare ~ onto the container home', () => {
    expect(defaultContainerPath('~', '/home/dev')).toBe('/home/dev');
  });

  test('leaves absolute and relative paths unchanged', () => {
    expect(defaultContainerPath('/opt/data', '/home/dev')).toBe('/opt/data');
    expect(defaultContainerPath('data', '/home/dev')).toBe('data');
  });
});

describe('buildWorkspace', () => {
  const base = {
    containerProfileName: 'default',
    parentDir: '/Users/ada/code',
    projectNames: ['site', 'api'],
    tools: [{ name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' }],
    agentProfileNames: ['claude-code'],
    githubCLI: true,
    hostMounts: [{ host: '~/.aws', container: '/home/dev/.aws', readonly: true }],
    env: { COLORTERM: '${COLORTERM}' },
    tmux: undefined,
  };

  test('assembles the workspace with fixed defaults and resolved project paths', () => {
    expect(buildWorkspace(base)).toEqual({
      profile: 'default',
      projects: ['/Users/ada/code/site', '/Users/ada/code/api'],
      tools: [{ name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' }],
      agent: {
        skipPermissions: true,
        profiles: ['claude-code'],
      },
      host: {
        sshAgent: true,
        githubCLI: true,
        mounts: [{ host: '~/.aws', container: '/home/dev/.aws', readonly: true }],
        env: { COLORTERM: '${COLORTERM}' },
      },
      sshd: false,
      attach: 'shell',
      stopAfterLastSession: '30s',
    });
  });

  test('omits the tmux key entirely when no tmux config was chosen', () => {
    expect('tmux' in buildWorkspace(base)).toBe(false);
  });

  test('includes the tmux section when one was chosen', () => {
    const workspace = buildWorkspace({ ...base, tmux: { mode: 'host', mountPlugins: true } });
    expect(workspace.tmux).toEqual({ mode: 'host', mountPlugins: true });
  });
});

describe('parseTimezoneFromLocaltimePath', () => {
  test('extracts the IANA name from a macOS localtime target', () => {
    expect(
      parseTimezoneFromLocaltimePath('/var/db/timezone/zoneinfo/America/New_York'),
    ).toBe('America/New_York');
  });

  test('extracts from a Linux localtime target', () => {
    expect(
      parseTimezoneFromLocaltimePath('/usr/share/zoneinfo/Europe/London'),
    ).toBe('Europe/London');
  });

  test('handles the zoneinfo.default variant', () => {
    expect(
      parseTimezoneFromLocaltimePath('/var/db/timezone/zoneinfo.default/Asia/Tokyo'),
    ).toBe('Asia/Tokyo');
  });

  test('handles single-segment zones like Etc/UTC', () => {
    expect(
      parseTimezoneFromLocaltimePath('/usr/share/zoneinfo/Etc/UTC'),
    ).toBe('Etc/UTC');
  });

  test('returns undefined when the path has no zoneinfo segment', () => {
    expect(parseTimezoneFromLocaltimePath('/etc/localtime')).toBeUndefined();
  });

  test('returns undefined for a zone containing unexpected characters', () => {
    expect(
      parseTimezoneFromLocaltimePath('/usr/share/zoneinfo/Bad\nName'),
    ).toBeUndefined();
  });
});

describe('timezoneEnv', () => {
  test('returns a TZ entry when a zone is provided', () => {
    expect(timezoneEnv('America/New_York')).toEqual({ TZ: 'America/New_York' });
  });

  test('returns an empty object when the zone is undefined', () => {
    expect(timezoneEnv(undefined)).toEqual({});
  });
});
