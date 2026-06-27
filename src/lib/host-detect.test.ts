import { describe, expect, test } from 'bun:test';
import { buildHostInfo } from './host-detect.js';

describe('buildHostInfo', () => {
  test('assembles host info, mapping undefined to null', () => {
    const info = buildHostInfo({
      gitName: 'Ada',
      gitEmail: undefined,
      tz: 'Europe/London',
      colorterm: 'truecolor',
      apiKeyVars: [{ name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key' }],
      agents: [{ name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' }],
    });
    expect(info).toEqual({
      gitIdentity: { name: 'Ada', email: null },
      tz: 'Europe/London',
      colorterm: 'truecolor',
      apiKeys: ['ANTHROPIC_API_KEY'],
      agents: [{ name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' }],
    });
  });

  test('empty inputs produce nulls and empty arrays', () => {
    const info = buildHostInfo({
      gitName: undefined, gitEmail: undefined, tz: undefined,
      colorterm: undefined, apiKeyVars: [], agents: [],
    });
    expect(info.gitIdentity).toEqual({ name: null, email: null });
    expect(info.tz).toBeNull();
    expect(info.apiKeys).toEqual([]);
    expect(info.agents).toEqual([]);
  });
});
