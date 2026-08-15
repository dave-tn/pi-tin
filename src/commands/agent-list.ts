import chalk from 'chalk';
import { ensureInitialised } from '../lib/init-guard.js';
import { loadAgentDefinitions } from '../lib/agent-definitions.js';
import { KNOWN_AGENTS } from '../lib/agents.js';
import type { KnownAgent } from '../lib/agents.js';
import { printJson, shouldEmitJson } from '../lib/cli-output.js';

type AgentSource = 'builtin' | 'custom';

/**
 * The listed view of an agent: identity, provenance, and the fields that decide
 * how it installs and how a profile for it behaves. Picked from KnownAgent so
 * the shape follows the definition schema; container_env and
 * isolated_seed_files are left out deliberately — image plumbing, not a
 * listing.
 */
type AgentListEntry = Pick<
  KnownAgent,
  'name' | 'package' | 'binary' | 'dot_dirs' | 'install' | 'skip_permissions_flag' | 'host_mode_supported'
> & { source: AgentSource };

function toEntry(agent: KnownAgent, source: AgentSource): AgentListEntry {
  return {
    name: agent.name,
    source,
    package: agent.package,
    binary: agent.binary,
    dot_dirs: agent.dot_dirs,
    install: agent.install,
    // Absent stays absent: an agent that needs no skip-permissions flag must
    // not report an empty one.
    ...(agent.skip_permissions_flag === undefined
      ? {}
      : { skip_permissions_flag: agent.skip_permissions_flag }),
    host_mode_supported: agent.host_mode_supported,
  };
}

/**
 * Built-ins then user definitions, each tagged with where it came from. Source
 * is derived by position rather than re-derived from the merged table: the
 * merge is what knows the provenance, and a name-based guess would be wrong the
 * moment the two tables agree on a name.
 */
function listAgentEntries(): AgentListEntry[] {
  return [
    ...KNOWN_AGENTS.map((agent) => toEntry(agent, 'builtin')),
    ...loadAgentDefinitions().map((agent) => toEntry(agent, 'custom')),
  ];
}

export function registerAgentListCommand(agentCmd: import('commander').Command): void {
  agentCmd
    .command('list')
    .description('List agents (built-in and custom)')
    .option('--json', 'Output machine-readable JSON')
    .action((opts: { json?: boolean }) => {
      ensureInitialised();

      // Unusable definition files are skipped with a warning on stderr during
      // the load, so stdout stays parseable JSON.
      const entries = listAgentEntries();

      if (shouldEmitJson(opts.json)) {
        printJson(entries);
        return;
      }

      const nameWidth = Math.max('NAME'.length, ...entries.map((e) => e.name.length));
      const sourceWidth = Math.max('SOURCE'.length, ...entries.map((e) => e.source.length));

      const header = [
        'NAME'.padEnd(nameWidth),
        'SOURCE'.padEnd(sourceWidth),
        'PACKAGE',
      ].join('  ');

      console.log(chalk.bold(header));

      for (const entry of entries) {
        console.log(
          [entry.name.padEnd(nameWidth), entry.source.padEnd(sourceWidth), entry.package].join('  '),
        );
      }
    });
}
