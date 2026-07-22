import { describe, test, expect } from 'bun:test';
import { queryHerdrAgentStates } from './auto-stop.js';

// Verified live output of `herdr agent list` (herdr 0.7.x).
const agentList = (statuses: string[]): string =>
  JSON.stringify({
    id: 'cli:agent:list',
    result: {
      agents: statuses.map((agent_status, index) => ({ agent: 'claude', agent_status, pane_id: `w1:p${index}` })),
      type: 'agent_list',
    },
  });

describe('queryHerdrAgentStates', () => {
  test('counts working agents from the real result.agents payload', () => {
    expect(queryHerdrAgentStates('pi-tin-demo', 'dev', () =>
      agentList(['working', 'idle', 'working', 'done']),
    )).toEqual({ kind: 'states', working: 2 });
  });

  test('counts zero when agents are idle/blocked', () => {
    expect(queryHerdrAgentStates('pi-tin-demo', 'dev', () =>
      agentList(['idle', 'blocked']),
    )).toEqual({ kind: 'states', working: 0 });
  });

  test('downgrades exec failure, non-JSON, and unexpected shapes to unavailable', () => {
    expect(queryHerdrAgentStates('pi-tin-demo', 'dev', () => {
      throw new Error('container exec timed out');
    })).toEqual({ kind: 'unavailable' });
    expect(queryHerdrAgentStates('pi-tin-demo', 'dev', () => 'herdr: no server running'))
      .toEqual({ kind: 'unavailable' });
    expect(queryHerdrAgentStates('pi-tin-demo', 'dev', () => JSON.stringify({ nope: true })))
      .toEqual({ kind: 'unavailable' });
  });
});
