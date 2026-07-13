# Agent-Ready CLI Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every pi-tin invocation an agent can reach behave per the agent contract — structured refusals for wizards, a complete `--help --json` surface, Commander errors in the JSON envelope, and `--dry-run`/`--json` on the workspace destructive commands.

**Architecture:** Four independent behaviours, each following an existing house pattern: the prereq-gate shape (pure decision + `CliError`) for TTY refusals; the hand-maintained `AGENT_HELP_SCHEMA` plus a new drift test pinning it to the Commander program; `exitOverride()` + a pure Commander-error mapper feeding the existing top-level envelope handler; and the `agent-profile-delete.ts` template (`shouldEmitJson` → `printJson` impact/dry-run/result) applied to `stop`/`delete`/`cleanup`.

**Tech Stack:** TypeScript ESM, Commander ^14, valibot, `@inquirer/prompts`, bun:test. Build with `bun run build`.

**Spec:** `docs/superpowers/specs/2026-07-13-agent-ready-cli-design.md`

## Global Constraints

- No `any`, no `as` casting (`as const` fine; `as` allowed in test files only), no `!` non-null assertions.
- Plan/execute: decision logic is a pure function returning a discriminated union; command code switches on it.
- Keep `.js` extensions in relative imports from `.ts` files. Named exports. Single quotes, semicolons.
- Typecheck with `bun x tsc --noEmit` (never bare `tsc`); tests with `bun test`; full gate `bun run prepublishOnly`.
- Tests never touch `~/.config/pi-tin` and never run the real `container` CLI. `import { describe, expect, test } from 'bun:test'`.
- The stable exit-code table (0/1/2/3/4) must NOT change. New behaviours reuse existing codes; agents branch on envelope `code` strings.
- User-facing copy is British, terse, no "for you" narration. User-facing behavior changes must land in `README.md` in the same task.
- No new dependencies.
- Never write a bare "profile" in identifiers or copy — always `agent profile` / `container profile`.
- Commit after each task; commit messages never mention Claude or AI assistance, no Co-Authored-By lines.

---

### Task 1: `ensureInteractive` guard + wizard gating

The wizards (`create`, no-arg `add`, bare `pi-tin`, `agent-profile discover`) currently render inquirer prompts with no TTY; EOF becomes `ExitPromptError`, which `withExitHandling` converts to `Goodbye!` + exit 0 — a false success. Gate them up front with a structured refusal.

**Files:**
- Modify: `src/lib/confirmation.ts` (add `ensureInteractive` below `isInteractiveSession`)
- Modify: `src/lib/confirmation.test.ts`
- Modify: `src/commands/create.ts:446` (`runCreateFlow`)
- Modify: `src/commands/add.ts` (`AddCommandDeps`, `defaultDeps`, `runAddCommand`)
- Modify: `src/commands/add.test.ts` (deps factory + new test)
- Modify: `src/lib/default-action.ts` (`DefaultActionDeps`, `defaultDeps`, `runDefaultAction`)
- Modify: `src/lib/default-action.test.ts` (deps factory + new test)
- Modify: `src/commands/agent-profile-discover.ts` (`runAgentProfileDiscover`)
- Modify: `README.md` (command-table rows for `create`, `add`, bare `pi-tin`, `agent-profile discover`)

**Interfaces:**
- Consumes: `CliError`, `EXIT` from `src/lib/cli-errors.js`; `isInteractiveSession` from `src/lib/confirmation.js`.
- Produces: `ensureInteractive(input: { action: string; remediation: string; isInteractive?: boolean }): void` — throws `CliError` with `exitCode: EXIT.GENERAL` and `detail.code: 'interactive_only'` when the session is not interactive. Task 7's schema documents the same code string; Task 8's e2e probes rely on it.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/confirmation.test.ts` (it already imports `describe/expect/test` from `bun:test`, `CliError`, `EXIT` — extend the existing imports if any of these are missing):

```ts
describe('ensureInteractive', () => {
  test('does nothing when the session is interactive', () => {
    expect(() =>
      ensureInteractive({
        action: 'run the create wizard',
        remediation: 'Use `pi-tin apply`.',
        isInteractive: true,
      }),
    ).not.toThrow();
  });

  test('throws interactive_only CliError when not interactive', () => {
    const err = (() => {
      try {
        ensureInteractive({
          action: 'run the create wizard',
          remediation: 'Use `pi-tin apply <name>` with workspace JSON on stdin.',
          isInteractive: false,
        });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.GENERAL);
    expect(err.detail.code).toBe('interactive_only');
    expect(err.detail.remediation).toBe('Use `pi-tin apply <name>` with workspace JSON on stdin.');
    expect(err.message).toBe('Cannot run the create wizard non-interactively — it needs a terminal.');
  });
});
```

Add `ensureInteractive` to the import from `./confirmation.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/lib/confirmation.test.ts`
Expected: FAIL — `ensureInteractive` is not exported.

- [ ] **Step 3: Implement `ensureInteractive`**

In `src/lib/confirmation.ts`, directly below `isInteractiveSession` (line 20):

```ts
// Wizard commands must refuse headless invocations up front: with no TTY the
// first inquirer prompt EOFs into ExitPromptError, which withExitHandling
// treats as a graceful quit — a false exit-0 success for agents and CI.
export function ensureInteractive(input: {
  action: string;
  remediation: string;
  isInteractive?: boolean;
}): void {
  const interactive = input.isInteractive ?? isInteractiveSession();
  if (!interactive) {
    throw new CliError(
      `Cannot ${input.action} non-interactively — it needs a terminal.`,
      EXIT.GENERAL,
      { code: 'interactive_only', remediation: input.remediation },
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/confirmation.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate `runCreateFlow`**

In `src/commands/create.ts`, add to the existing `../lib/confirmation.js` import (or add the import if absent): `ensureInteractive`. Then make the guard the first statement of `runCreateFlow`:

```ts
export async function runCreateFlow(nameArg?: string): Promise<void> {
  ensureInteractive({
    action: 'run the create wizard',
    remediation:
      'Create or update workspaces headlessly with `pi-tin apply <name>` (workspace JSON on stdin); `pi-tin detect-host` reports host facts.',
  });
  ensureInitialised();
  // …existing body unchanged…
```

- [ ] **Step 6: Gate the no-arg `add` path (deps-injected)**

In `src/commands/add.ts`:

1. Import `ensureInteractive` from `../lib/confirmation.js`.
2. Add a module-level helper (below the imports) so the deps field keeps name exclusivity:

```ts
const ensureAddInteractive = (): void =>
  ensureInteractive({
    action: "run 'pi-tin add' without a workspace name",
    remediation:
      'Name the workspace: `pi-tin add <workspace>`, or edit headlessly with `pi-tin show <name> --json` → `pi-tin apply <name>`.',
  });
```

3. Add to `AddCommandDeps`: `ensureInteractive: () => void;` and to `defaultDeps`: `ensureInteractive: ensureAddInteractive,`.
4. In `runAddCommand`, call `deps.ensureInteractive();` immediately **after** the `if (workspaceArg !== undefined) { … return; }` block (i.e. only the pickers are gated). The explicit `pi-tin add <workspace>` path stays headless — it already works non-interactively and returns structured errors. (Its `add-and-open` outcome attempting a tmux attach headlessly is pre-existing behaviour, out of scope.)

In `src/commands/add.test.ts`, add `ensureInteractive: () => {},` to the `createDeps` factory, and add this test:

```ts
test('no-arg add propagates the interactive_only refusal', async () => {
  const deps = createDeps({
    ensureInteractive: () => {
      throw new CliError('Cannot run non-interactively.', EXIT.GENERAL, { code: 'interactive_only' });
    },
    listWorkspaces: () => [match('work', ['/a'])],
  });
  const err = await runAddCommand(undefined, deps).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  if (!(err instanceof CliError)) throw new Error('unreachable');
  expect(err.detail.code).toBe('interactive_only');
});
```

- [ ] **Step 7: Gate the default action (deps-injected)**

In `src/lib/default-action.ts`:

1. Import `ensureInteractive` from `./confirmation.js`.
2. Module-level helper:

```ts
const ensureDefaultActionInteractive = (): void =>
  ensureInteractive({
    action: 'choose a workspace interactively',
    remediation:
      'Run an explicit command instead: `pi-tin list`, `pi-tin open <workspace>`, or see `pi-tin agent-guide`.',
  });
```

3. Add to `DefaultActionDeps`: `ensureInteractive: () => void;` and to `defaultDeps`: `ensureInteractive: ensureDefaultActionInteractive,`.
4. Make `deps.ensureInteractive();` the first statement of `runDefaultAction` (before `deps.ensureInitialised()`). This deliberately refuses even the single-match auto-open case: `open` attaches a tmux session and cannot work headless anyway.

In `src/lib/default-action.test.ts`, add `ensureInteractive: () => {},` to its `createDeps` factory, plus:

```ts
test('refuses non-interactive sessions before doing anything', async () => {
  let initialised = false;
  const deps = createDeps({
    ensureInteractive: () => {
      throw new CliError('Cannot choose non-interactively.', EXIT.GENERAL, { code: 'interactive_only' });
    },
    ensureInitialised: () => { initialised = true; },
  });
  const err = await runDefaultAction({}, deps).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  if (!(err instanceof CliError)) throw new Error('unreachable');
  expect(err.detail.code).toBe('interactive_only');
  expect(initialised).toBe(false);
});
```

(Import `CliError`, `EXIT` from `./cli-errors.js` in both test files if not already imported.)

- [ ] **Step 8: Gate `agent-profile discover` (direct call)**

In `src/commands/agent-profile-discover.ts`, import `ensureInteractive` from `../lib/confirmation.js` and make it the first statement of `runAgentProfileDiscover`:

```ts
export async function runAgentProfileDiscover(): Promise<void> {
  ensureInteractive({
    action: "run 'agent-profile discover'",
    remediation: 'Create agent profiles directly: `pi-tin agent-profile add <name> --agent <agent>`.',
  });
  // …existing body unchanged…
```

- [ ] **Step 9: README rows**

In the `README.md` command table (lines ~299-322), append to these rows' descriptions:

- `pi-tin create [name]` row: `… (interactive; prompts for a name when omitted; without a TTY exits 1 with error code interactive_only — use apply instead)`
- `pi-tin [--build]` row: append `; without a TTY exits 1 with error code interactive_only`
- `pi-tin add [workspace]` row: append `; the no-argument picker needs a TTY (exit 1, error code interactive_only) — \`add <name>\` works headless`
- `pi-tin agent-profile discover` row: append ` (interactive; without a TTY exits 1 with error code interactive_only — use agent-profile add)`

- [ ] **Step 10: Typecheck, full test run, commit**

Run: `bun x tsc --noEmit && bun test`
Expected: PASS (all suites — the deps-factory additions keep existing tests green).

```bash
git add src/lib/confirmation.ts src/lib/confirmation.test.ts src/commands/create.ts src/commands/add.ts src/commands/add.test.ts src/lib/default-action.ts src/lib/default-action.test.ts src/commands/agent-profile-discover.ts README.md
git commit -m "fix: refuse wizard commands without a TTY instead of false-reporting success

create, no-arg add, bare pi-tin, and agent-profile discover rendered
inquirer prompts headless; EOF became ExitPromptError, which
withExitHandling turned into 'Goodbye!' and exit 0. Gate each wizard
entry point with a structured interactive_only error (exit 1) pointing
at the headless alternative."
```

---

### Task 2: Unknown-command classifier

`pi-tin bogus` currently reports Commander's `error: too many arguments` (exit 1, no envelope) because the root default action takes no positionals; `pi-tin bogus --help` prints root help and exits 0 — a false positive for agents probing command existence. Classify the first positional before parse.

**Files:**
- Modify: `src/lib/help-request.ts` (add `classifyInvocation`)
- Modify: `src/lib/help-request.test.ts`
- Modify: `src/cli.ts` (throw inside the existing `try`, before the prereq gate)
- Modify: `README.md` (Structured errors bullet mentions `unknown_command`)

**Interfaces:**
- Consumes: `CliError`, `EXIT` from `src/lib/cli-errors.js`; `buildProgram` already constructed in `src/cli.ts:43`.
- Produces: `classifyInvocation(args: string[], knownCommands: string[]): InvocationPlan` where `InvocationPlan = { kind: 'proceed' } | { kind: 'unknown-command'; badInput: string }`. The envelope `code` string `'unknown_command'` is documented in Task 7/8.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/help-request.test.ts`:

```ts
describe('classifyInvocation', () => {
  const known = ['list', 'show', 'stop', 'help'];

  test('bare invocation proceeds', () => {
    expect(classifyInvocation([], known)).toEqual({ kind: 'proceed' });
  });

  test('flag-only invocation proceeds', () => {
    expect(classifyInvocation(['--build'], known)).toEqual({ kind: 'proceed' });
  });

  test('known command proceeds', () => {
    expect(classifyInvocation(['list', '--json'], known)).toEqual({ kind: 'proceed' });
  });

  test('unknown command is refused', () => {
    expect(classifyInvocation(['bogus'], known)).toEqual({ kind: 'unknown-command', badInput: 'bogus' });
  });

  test('unknown command is refused even with --help', () => {
    expect(classifyInvocation(['bogus', '--help'], known)).toEqual({ kind: 'unknown-command', badInput: 'bogus' });
  });

  test('flags before the positional are skipped', () => {
    expect(classifyInvocation(['--build', 'bogus'], known)).toEqual({ kind: 'unknown-command', badInput: 'bogus' });
  });
});
```

Add `classifyInvocation` to the import from `./help-request.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/lib/help-request.test.ts`
Expected: FAIL — `classifyInvocation` is not exported.

- [ ] **Step 3: Implement `classifyInvocation`**

Append to `src/lib/help-request.ts`:

```ts
export type InvocationPlan =
  | { kind: 'proceed' }
  | { kind: 'unknown-command'; badInput: string };

// Commander's root default action reports an unknown first positional as
// "too many arguments" (exit 1, no envelope), and `<unknown> --help` falls
// back to root help with exit 0 — a false positive for agents probing
// whether a command exists. Decide both here, before parse and before any
// --help routing. All root options are boolean, so the first non-flag token
// is always the intended command.
export function classifyInvocation(args: string[], knownCommands: string[]): InvocationPlan {
  const firstPositional = args.find((a) => !a.startsWith('-'));
  if (firstPositional === undefined || knownCommands.includes(firstPositional)) {
    return { kind: 'proceed' };
  }
  return { kind: 'unknown-command', badInput: firstPositional };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/help-request.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/cli.ts`**

Add `classifyInvocation` to the existing import from `./lib/help-request.js`. Then insert at the top of the existing `try` block (before the `isPrereqExemptRequest` gate at line 49 — an unknown command must not waste a container-service probe or misreport in sandboxed shells):

```ts
  // program.commands does not include the implicit `help` command commander
  // registers via helpCommand(true), so add it by hand.
  const knownCommands = [...program.commands.map((c) => c.name()), 'help'];
  const invocation = classifyInvocation(args, knownCommands);
  if (invocation.kind === 'unknown-command') {
    throw new CliError(`Unknown command '${invocation.badInput}'.`, EXIT.VALIDATION, {
      code: 'unknown_command',
      badInput: invocation.badInput,
      validValues: knownCommands,
      remediation: 'Run `pi-tin agent-guide` (or `pi-tin --help`) for the command list.',
    });
  }
```

Verify during this step whether `program.commands` includes `help` (log it once or check with a quick script); if Commander 14 does include it, drop the manual `'help'` append and the comment.

- [ ] **Step 6: README**

In the **Structured errors** bullet of `README.md` (Machine-Readable Output section), append: `An unknown command is a validation failure: exit 2 with code \`unknown_command\` and the valid command list in \`validValues\` (this also applies when --help follows an unknown command).`

- [ ] **Step 7: Typecheck, test, build, probe, commit**

Run: `bun x tsc --noEmit && bun test && bun run build`
Then probe the built CLI (non-TTY):

```bash
node dist/cli.js totally-bogus; echo "exit=$?"
```
Expected: `{"error":{"message":"Unknown command 'totally-bogus'.","code":"unknown_command",...}}` on stderr, `exit=2`.

```bash
node dist/cli.js totally-bogus --help; echo "exit=$?"
```
Expected: same envelope, `exit=2` (no root help).

```bash
git add src/lib/help-request.ts src/lib/help-request.test.ts src/cli.ts README.md
git commit -m "fix: report unknown commands as structured validation errors

An unknown first positional previously surfaced as commander's 'too many
arguments' (exit 1, plain text), and '<unknown> --help' printed root help
with exit 0 — a false positive for agents probing command existence. Both
now exit 2 with an unknown_command envelope listing valid commands."
```

---

### Task 3: Commander usage errors through the envelope

Commander's own errors (unknown option, missing argument, excess arguments) print plain text and exit 1, bypassing the envelope and the exit-code contract. Override exit, map to `CliError` validation.

**Files:**
- Modify: `src/cli-program.ts` (`exitOverride`, `configureOutput`, new `usageErrorFrom`)
- Create: `src/cli-program.test.ts`
- Modify: `src/cli.ts` (catch handling)
- Modify: `README.md` (Structured errors bullet)

**Interfaces:**
- Consumes: `CommanderError` from `commander`; `CliError`, `EXIT` from `src/lib/cli-errors.js`.
- Produces: `usageErrorFrom(err: CommanderError): CliError | undefined` — `undefined` means Commander already completed a zero-exit flow (help/version were printed); otherwise a `CliError` with `exitCode: EXIT.VALIDATION`, `detail.code: 'usage'`.

- [ ] **Step 1: Write the failing tests**

Create `src/cli-program.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { CommanderError } from 'commander';
import { buildProgram, usageErrorFrom } from './cli-program.js';
import { CliError, EXIT } from './lib/cli-errors.js';

const meta = { version: '0.0.0-test', homepage: 'https://example.invalid' };

describe('usageErrorFrom', () => {
  test('maps a usage error to a validation CliError, stripping the error: prefix', () => {
    const err = new CommanderError(1, 'commander.unknownOption', "error: unknown option '--bogus'");
    const cli = usageErrorFrom(err);
    expect(cli).toBeInstanceOf(CliError);
    if (!(cli instanceof CliError)) throw new Error('unreachable');
    expect(cli.exitCode).toBe(EXIT.VALIDATION);
    expect(cli.detail.code).toBe('usage');
    expect(cli.message).toBe("unknown option '--bogus'");
  });

  test('returns undefined for zero-exit flows (help, version)', () => {
    expect(usageErrorFrom(new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)'))).toBeUndefined();
    expect(usageErrorFrom(new CommanderError(0, 'commander.version', '0.0.0'))).toBeUndefined();
  });
});

describe('buildProgram exitOverride', () => {
  test('an unknown option throws CommanderError instead of exiting', async () => {
    const program = buildProgram(meta);
    const err = await program
      .parseAsync(['node', 'pi-tin', 'list', '--bogus'])
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CommanderError);
    if (!(err instanceof CommanderError)) throw new Error('unreachable');
    expect(err.code).toBe('commander.unknownOption');
  });

  test('a missing required argument throws CommanderError', async () => {
    const program = buildProgram(meta);
    const err = await program
      .parseAsync(['node', 'pi-tin', 'show'])
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CommanderError);
    if (!(err instanceof CommanderError)) throw new Error('unreachable');
    expect(err.code).toBe('commander.missingArgument');
  });
});
```

(Both parse failures throw before any command action runs, so no container/config access happens.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/cli-program.test.ts`
Expected: FAIL — `usageErrorFrom` not exported; without `exitOverride`, Commander calls `process.exit` (the parse tests may kill the runner — that is the bug being fixed).

- [ ] **Step 3: Implement**

In `src/cli-program.ts`:

1. Add imports: `import { Command, CommanderError } from 'commander';` and `import { CliError, EXIT } from './lib/cli-errors.js';`
2. In the program setup chain (before any `register*` call, so subcommands created afterwards inherit both settings), add:

```ts
    // Throw CommanderError instead of process.exit so usage errors reach the
    // top-level envelope handler. Commander writes its own message to stderr
    // before throwing; suppress that channel — usageErrorFrom re-carries the
    // message through the CliError renderer.
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
```

3. Append the mapper at the bottom of the file:

```ts
// undefined = commander already completed a zero-exit flow (help/version
// printed via stdout); callers exit 0. Anything else is a usage mistake and
// becomes part of the validation contract (exit 2, envelope code 'usage').
export function usageErrorFrom(err: CommanderError): CliError | undefined {
  if (err.exitCode === 0) {
    return undefined;
  }
  return new CliError(err.message.replace(/^error: /, ''), EXIT.VALIDATION, {
    code: 'usage',
    remediation: 'Run `pi-tin <command> --help` for usage, or `pi-tin agent-guide` for the machine contract.',
  });
}
```

4. In `src/cli.ts`, import `usageErrorFrom` from `./cli-program.js` and `CommanderError` from `commander`, then replace the whole catch block with:

```ts
} catch (err) {
  const failure = err instanceof CommanderError ? usageErrorFrom(err) : err;
  if (failure === undefined) {
    process.exit(0);
  }
  if (failure instanceof CliError) {
    // Commander's parsed options aren't visible here, so detect --json from
    // raw argv (same approach as help-request.ts) — an explicit --json on a
    // TTY must still get the JSON error envelope.
    if (shouldEmitJson(args.includes('--json') ? true : undefined)) {
      process.stderr.write(JSON.stringify(errorEnvelope(failure)) + '\n');
    } else {
      console.error(chalk.red(failure.message));
      if (failure.detail.remediation) {
        console.error(chalk.yellow(failure.detail.remediation));
      }
    }
    process.exit(failure.exitCode);
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  console.error(chalk.red(message));
  process.exit(EXIT.GENERAL);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/cli-program.test.ts && bun test`
Expected: PASS, full suite green.

- [ ] **Step 5: Build and probe**

Run: `bun run build`, then:

```bash
node dist/cli.js list --bogus; echo "exit=$?"        # envelope code 'usage', exit=2
node dist/cli.js show; echo "exit=$?"                # envelope code 'usage' (missing argument), exit=2
node dist/cli.js stop --help; echo "exit=$?"         # normal help on stdout, exit=0
node dist/cli.js -v; echo "exit=$?"                  # version, exit=0
```

Also confirm no duplicated plain-text error line appears alongside the envelope (writeErr suppression working).

- [ ] **Step 6: README**

In the **Structured errors** bullet, append: `Usage mistakes (unknown option, missing argument) are validation failures too: exit 2 with code \`usage\`.`

- [ ] **Step 7: Commit**

```bash
git add src/cli-program.ts src/cli-program.test.ts src/cli.ts README.md
git commit -m "fix: route commander usage errors through the JSON error envelope

Unknown options and missing arguments previously printed plain text and
exited 1, bypassing the structured-error contract. exitOverride plus a
pure CommanderError→CliError mapper now emits the envelope with exit 2;
help and version flows still exit 0."
```

---

### Task 4: `stop --dry-run --json`

**Files:**
- Modify: `src/commands/stop.ts`
- Modify: `src/commands/stop.test.ts` (add `buildStopPreview` tests)
- Modify: `README.md` (stop row)

**Interfaces:**
- Consumes: `StopWorkspacePlan` from `src/lib/workspace-plans.js` (already exported at line 97); `shouldEmitJson`, `printJson` from `src/lib/cli-output.js`.
- Produces: `buildStopPreview(plan: Exclude<StopWorkspacePlan, { action: 'refuse' }>, workspace: string): StopPreview` where `StopPreview = { action: 'noop'; workspace: string; reason: 'not-running' } | { action: 'stop'; workspace: string; requiresConfirmation: boolean }`. JSON results: `{ action: 'stopped' | 'noop' | 'cancelled', workspace, … }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/commands/stop.test.ts` (add `buildStopPreview` to its import from `./stop.js`):

```ts
describe('buildStopPreview', () => {
  test('noop plan previews as not-running', () => {
    expect(buildStopPreview({ action: 'noop' }, 'ws')).toEqual({
      action: 'noop',
      workspace: 'ws',
      reason: 'not-running',
    });
  });

  test('stop plan previews without confirmation', () => {
    expect(buildStopPreview({ action: 'stop', warnAboutInconsistentRuntime: false }, 'ws')).toEqual({
      action: 'stop',
      workspace: 'ws',
      requiresConfirmation: false,
    });
  });

  test('confirm plan previews with confirmation required', () => {
    expect(buildStopPreview({ action: 'confirm', message: 'x' }, 'ws')).toEqual({
      action: 'stop',
      workspace: 'ws',
      requiresConfirmation: true,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/commands/stop.test.ts`
Expected: FAIL — `buildStopPreview` not exported.

- [ ] **Step 3: Implement**

Rewrite `src/commands/stop.ts` as:

```ts
import chalk from 'chalk';
import { confirmDestructive } from '../lib/confirmation.js';
import {
  containerNameFor,
  getContainerState,
} from '../lib/container.js';
import { stopAndRemoveContainer } from '../lib/container-lifecycle.js';
import { ensureInitialised } from '../lib/init-guard.js';
import {
  withWorkspaceLock,
  readRuntimeDecisionState,
  clearWorkspaceRuntimeState,
} from '../lib/runtime-state.js';
import { withExitHandling } from '../lib/exit-handling.js';
import { planStopWorkspace, type StopWorkspacePlan } from '../lib/workspace-plans.js';
import { assertValidWorkspaceName } from '../lib/workspaces.js';
import { printJson, shouldEmitJson } from '../lib/cli-output.js';

export type StopPreview =
  | { action: 'noop'; workspace: string; reason: 'not-running' }
  | { action: 'stop'; workspace: string; requiresConfirmation: boolean };

export function buildStopPreview(
  plan: Exclude<StopWorkspacePlan, { action: 'refuse' }>,
  workspace: string,
): StopPreview {
  if (plan.action === 'noop') {
    return { action: 'noop', workspace, reason: 'not-running' };
  }
  return { action: 'stop', workspace, requiresConfirmation: plan.action === 'confirm' };
}

export function registerStopCommand(
  program: import('commander').Command,
): void {
  program
    .command('stop <workspace>')
    .description('Stop a running workspace')
    .option('-f, --force', 'Skip confirmation prompt and kill if needed')
    .option('--dry-run', 'Preview what would be stopped without stopping')
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string, opts: { force?: boolean; dryRun?: boolean; json?: boolean }) => {
      ensureInitialised();

      // stop never goes through loadWorkspace, so validate the raw argv name
      // before deriving container names and runtime-state paths from it.
      assertValidWorkspaceName(name);
      const json = shouldEmitJson(opts.json);

      await withExitHandling(async () => {
        const containerName = containerNameFor(name);

        await withWorkspaceLock(name, async () => {
          const state = getContainerState(containerName);
          const runtime = readRuntimeDecisionState(name, state);
          const plan = planStopWorkspace({
            workspaceName: name,
            containerState: state,
            runtimeState: runtime.runtimeState,
            activeSessions: runtime.activeSessions,
            force: opts.force === true,
          });

          if (plan.action === 'refuse') {
            throw new Error(plan.message);
          }

          if (opts.dryRun === true) {
            const preview = buildStopPreview(plan, name);
            if (json) {
              printJson({ ...preview, dryRun: true });
            } else if (preview.action === 'noop') {
              console.log(chalk.dim(`Workspace '${name}' is not running; nothing to stop.`));
            } else {
              console.log(`Would stop workspace '${name}'.`);
            }
            return;
          }

          if (plan.action === 'noop') {
            await stopAndRemoveContainer(containerName);
            clearWorkspaceRuntimeState(name);
            if (json) {
              printJson({ action: 'noop', workspace: name, reason: 'not-running' });
            } else {
              console.log(chalk.dim(`Workspace '${name}' is not running.`));
            }
            return;
          }

          const warnAboutInconsistentRuntime = plan.action === 'stop'
            ? plan.warnAboutInconsistentRuntime
            : false;

          if (plan.action === 'confirm') {
            const proceed = await confirmDestructive({
              message: plan.message,
              action: `stop workspace '${name}'`,
              force: opts.force === true,
            });
            if (!proceed) {
              if (json) {
                printJson({ action: 'cancelled', workspace: name });
              } else {
                console.log('Cancelled.');
              }
              return;
            }
          }

          if (warnAboutInconsistentRuntime) {
            console.warn(chalk.yellow(`Warning: runtime state is inconsistent for workspace '${name}'. Stopping it anyway.`));
          }

          await stopAndRemoveContainer(containerName, { force: opts.force === true });
          clearWorkspaceRuntimeState(name);
          if (json) {
            printJson({ action: 'stopped', workspace: name });
          } else {
            console.log(chalk.green(`Stopped workspace '${name}'`));
          }
        });
      });
    });
}
```

(`console.warn` diagnostics stay unconditional — they go to stderr, the diagnostics channel.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/commands/stop.test.ts && bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: README**

Replace the `pi-tin stop <name> [--force]` row's command cell with `pi-tin stop <name> [--force] [--dry-run] [--json]` and append to its description: `; --dry-run previews the effect; --json (default when piped) emits a structured result`.

- [ ] **Step 6: Commit**

```bash
git add src/commands/stop.ts src/commands/stop.test.ts README.md
git commit -m "feat: add --dry-run and --json to stop

The not-running no-op previously printed prose to stdout even in JSON
mode, corrupting the data channel. All stop outcomes now emit structured
JSON when requested or piped, and --dry-run previews the effect."
```

---

### Task 5: `delete --dry-run --json`

**Files:**
- Modify: `src/commands/delete.ts`
- Modify: `README.md` (delete row)

**Interfaces:**
- Consumes: `shouldEmitJson`, `printJson` from `src/lib/cli-output.js`; existing `planDeleteWorkspace`.
- Produces: dry-run JSON `{ action: 'delete', workspace, stopRunningContainer, image: string | null, dryRun: true }`; result JSON `{ action: 'deleted', workspace, imageRemoved: boolean }`; cancel JSON `{ action: 'cancelled', workspace }`.

The impact object is inline data assembly around one effectful call (`imageExists`) — no new planner is warranted; the branching (`stopRunningContainer`) is already covered by `planDeleteWorkspace` tests. Behaviour is verified end-to-end in Task 8.

- [ ] **Step 1: Implement**

In `src/commands/delete.ts`:

1. Add import: `import { printJson, shouldEmitJson } from '../lib/cli-output.js';`
2. Add options after the existing `-f, --force`:

```ts
    .option('--dry-run', 'Preview what would be deleted without deleting')
    .option('--json', 'Output machine-readable JSON')
```

3. Widen the action signature to `(name: string, opts: { force?: boolean; dryRun?: boolean; json?: boolean })` and add `const json = shouldEmitJson(opts.json);` after `assertValidWorkspaceName(name)`.
4. Inside `withWorkspaceLock`, after the `refuse` check, insert the dry-run branch (moving the `imageTagFor` lookup up from the deletion section so both branches share it):

```ts
          const imageTag = imageTagFor(name);

          if (opts.dryRun === true) {
            const impact = {
              action: 'delete',
              workspace: name,
              stopRunningContainer: plan.stopRunningContainer,
              image: imageExists(imageTag) ? imageTag : null,
            };
            if (json) {
              printJson({ ...impact, dryRun: true });
            } else {
              const runningNote = impact.stopRunningContainer ? ' (currently running — will be stopped)' : '';
              console.log(`Would delete workspace '${name}'${runningNote}.`);
              if (impact.image !== null) {
                console.log(`  Would remove image: ${impact.image}`);
              }
            }
            return;
          }
```

5. In the cancel branch, replace `console.log('Cancelled.');` with:

```ts
            if (json) {
              printJson({ action: 'cancelled', workspace: name });
            } else {
              console.log('Cancelled.');
            }
```

6. In the deletion section, drop the now-duplicate `const imageTag = imageTagFor(name);`, track `let imageRemoved = false;` set to `true` after a successful `deleteImage(imageTag)`, and guard the two stdout prose lines:

```ts
          let imageRemoved = false;
          if (imageExists(imageTag)) {
            try {
              deleteImage(imageTag);
              imageRemoved = true;
              if (!json) {
                console.log(chalk.yellow(`Removed image: ${imageTag}`));
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(chalk.yellow(`Warning: failed to remove image '${imageTag}': ${msg}`));
            }
          }
```

and replace the final success line with:

```ts
          deleteWorkspace(name);
          if (json) {
            printJson({ action: 'deleted', workspace: name, imageRemoved });
          } else {
            console.log(chalk.green(`✔ Deleted workspace '${name}'`));
          }
```

- [ ] **Step 2: Typecheck and test**

Run: `bun x tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 3: README**

Replace the `pi-tin delete <name> [--force]` row's command cell with `pi-tin delete <name> [--force] [--dry-run] [--json]` and append to its description: `; --dry-run previews the blast radius (container, image); --json (default when piped) emits a structured result`.

- [ ] **Step 4: Commit**

```bash
git add src/commands/delete.ts README.md
git commit -m "feat: add --dry-run and --json to delete

--dry-run previews the blast radius (running container, image) without
deleting; JSON mode emits structured results on every outcome instead of
prose on the data channel."
```

---

### Task 6: `cleanup --dry-run --json` + structured full-wipe refusal

**Files:**
- Modify: `src/commands/cleanup.ts`
- Modify: `src/commands/cleanup.test.ts`
- Modify: `README.md` (cleanup row)

**Interfaces:**
- Consumes: `CliError`, `EXIT` from `src/lib/cli-errors.js`; `shouldEmitJson`, `printJson` from `src/lib/cli-output.js`; existing `planCleanup`, `selectOrphanedImages`.
- Produces: `fullWipe(running: string[], force: boolean, json: boolean)` now throws `CliError` (`EXIT.GENERAL`, code `'workspaces_running'`) instead of `process.exit(1)`. Dry-run JSON shapes: `{ action: 'cleanup', runningWorkspaces, stoppedWorkspaces, orphanedImages, prunes: ['containers','images','volumes'], dryRun: true }` and `{ action: 'full-wipe', images, configDir: string | null, prunes: […], dryRun: true }`. Result JSON: `{ action: 'cleaned', orphanedImagesRemoved, orphanedImagesFailed, prunes: { containers, images, volumes } }` (prune values are the `PruneOutcome.status` strings) and `{ action: 'wiped', imagesRemoved, imagesFailed, configDirRemoved, prunes: { … } }`.

- [ ] **Step 1: Write the failing test**

Append to `src/commands/cleanup.test.ts` (export `fullWipe` in the next step; the refusal throws before any `container` CLI call, so the test is safe):

```ts
describe('fullWipe', () => {
  test('refuses with a structured error while workspaces are running', async () => {
    const err = await fullWipe(['ctwo', 'blitz'], true, false).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.GENERAL);
    expect(err.detail.code).toBe('workspaces_running');
    expect(err.detail.remediation).toContain('pi-tin stop ctwo');
  });
});
```

Add imports to the test file: `fullWipe` from `./cleanup.js`; `CliError`, `EXIT` from `../lib/cli-errors.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/commands/cleanup.test.ts`
Expected: FAIL — `fullWipe` not exported.

- [ ] **Step 3: Implement**

In `src/commands/cleanup.ts`:

1. Add imports: `CliError`, `EXIT` from `../lib/cli-errors.js`; `printJson`, `shouldEmitJson` from `../lib/cli-output.js`.
2. Change `run` to return its outcome and accept a `quiet` flag (failures always warn on stderr):

```ts
function run(args: string[], label: string, quiet: boolean): PruneOutcome {
  const outcome = prunePass(args, (a) =>
    execFileSync('container', a, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
  if (outcome.status === 'failed') {
    console.warn(chalk.yellow(`Warning: ${label} failed: ${outcome.message}`));
  } else if (!quiet) {
    if (outcome.status === 'removed') {
      console.log(outcome.output);
      console.log(chalk.green(`✔ ${label}`));
    } else {
      console.log(chalk.dim(`  ${label}: nothing to clean`));
    }
  }
  return outcome;
}
```

3. Give `confirmCleanup` a `quiet` option that skips its stdout context prints (JSON callers get the same facts from `--dry-run`): add `quiet?: boolean` to its input type and wrap the two `console.log` context blocks in `if (input.quiet !== true) { … }`. The `confirmDestructive` call is unchanged.
4. Export `fullWipe` and rework it to `(running: string[], force: boolean, json: boolean)`:
   - Replace the `console.error` + `process.exit(1)` refusal with:

```ts
  if (running.length > 0) {
    throw new CliError(
      `Cannot perform full wipe while ${running.length} workspace${running.length === 1 ? ' is' : 's are'} running: ${running.join(', ')}`,
      EXIT.GENERAL,
      {
        code: 'workspaces_running',
        remediation: `Stop them first: ${running.map((n) => `pi-tin stop ${n}`).join(', ')}.`,
      },
    );
  }
```

   - Wrap every stdout `console.log` in the preamble and body with `if (!json) { … }` (the "Nothing to remove." early return emits `printJson({ action: 'wiped', imagesRemoved: [], imagesFailed: [], configDirRemoved: false, prunes: null })` in JSON mode).
   - Replace the cancel branch's `console.log('Cancelled.')` with the JSON/prose pair `printJson({ action: 'cancelled' })` / `console.log('Cancelled.')`.
   - Collect results: `const imagesRemoved: string[] = []; const imagesFailed: string[] = [];` pushed in the image loop; capture the three `run(...)` outcomes with `quiet: json`; delete config dir as now; finish with:

```ts
  if (json) {
    printJson({
      action: 'wiped',
      imagesRemoved,
      imagesFailed,
      configDirRemoved: configDirExists,
      prunes: {
        containers: containersOutcome.status,
        images: imagesOutcome.status,
        volumes: volumesOutcome.status,
      },
    });
  } else {
    console.log(chalk.bold('\nAll pi-tin data has been removed.'));
  }
```

5. Rework the command action: add options and compute the shared facts once —

```ts
    .option('--all', 'Full wipe: remove all pi-tin images, config, and data')
    .option('-f, --force', 'Skip confirmation prompt')
    .option('--dry-run', 'Preview what would be removed without removing anything')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { all?: boolean; force?: boolean; dryRun?: boolean; json?: boolean }) => {
      const json = shouldEmitJson(opts.json);
      await withExitHandling(async () => {
        const plan = planCleanup(listContainers());
        if (plan.action === 'refuse') {
          throw new Error(plan.message);
        }
        const running = plan.runningWorkspaces;

        if (opts.all) {
          if (opts.dryRun === true) {
            if (running.length > 0) {
              throw new CliError(
                `Cannot perform full wipe while ${running.length} workspace${running.length === 1 ? ' is' : 's are'} running: ${running.join(', ')}`,
                EXIT.GENERAL,
                { code: 'workspaces_running', remediation: `Stop them first: ${running.map((n) => `pi-tin stop ${n}`).join(', ')}.` },
              );
            }
            const images = listImageNames().filter(isPiTinImageTag);
            const configDir = getConfigDir();
            const preview = {
              action: 'full-wipe',
              images,
              configDir: fs.existsSync(configDir) ? configDir : null,
              prunes: ['containers', 'images', 'volumes'],
            };
            if (json) {
              printJson({ ...preview, dryRun: true });
            } else {
              console.log(`Would remove ${images.length} pi-tin image${images.length === 1 ? '' : 's'}, the config directory, and run all prunes.`);
            }
            return;
          }
          await fullWipe(running, opts.force === true, json);
          return;
        }

        const workspaceNames = listWorkspaces().map((w) => w.name);
        const orphanedImages = selectOrphanedImages({
          imageNames: listImageNames(),
          workspaceNames,
        });

        if (opts.dryRun === true) {
          const preview = {
            action: 'cleanup',
            runningWorkspaces: running,
            stoppedWorkspaces: plan.stoppedWorkspaces,
            orphanedImages,
            prunes: ['containers', 'images', 'volumes'],
          };
          if (json) {
            printJson({ ...preview, dryRun: true });
          } else {
            if (running.length > 0) {
              console.log(chalk.yellow(`Running (skipped): ${running.join(', ')}`));
            }
            if (plan.stoppedWorkspaces.length > 0) {
              console.log(`Would remove stopped workspace container${plan.stoppedWorkspaces.length === 1 ? '' : 's'}: ${plan.stoppedWorkspaces.join(', ')}`);
            }
            if (orphanedImages.length > 0) {
              console.log(`Would remove orphaned image${orphanedImages.length === 1 ? '' : 's'}: ${orphanedImages.join(', ')}`);
            }
            console.log('Would prune stopped containers, dangling images, and unused volumes (not limited to pi-tin).');
          }
          return;
        }

        if (!json && running.length > 0) {
          const names = running.map((n) => chalk.cyan(n)).join(', ');
          console.log(
            chalk.yellow(
              `⚠ ${running.length} pi-tin workspace${running.length === 1 ? '' : 's'} still running (${names}) — ${running.length === 1 ? 'it' : 'they'} will not be cleaned up.`,
            ),
          );
          console.log(
            chalk.dim(
              `  Stop them first with: ${running.map((n) => `pi-tin stop ${n}`).join(', ')}`,
            ),
          );
          console.log();
        }

        const proceed = await confirmCleanup({
          stopped: plan.stoppedWorkspaces,
          force: opts.force === true,
          quiet: json,
        });
        if (!proceed) {
          if (json) {
            printJson({ action: 'cancelled' });
          } else {
            console.log('Cancelled.');
          }
          return;
        }
        if (!json) {
          console.log();
          console.log(chalk.bold('Cleaning up...\n'));
        }

        const orphanedImagesRemoved: string[] = [];
        const orphanedImagesFailed: string[] = [];
        for (const img of orphanedImages) {
          try {
            deleteImage(img);
            orphanedImagesRemoved.push(img);
            if (!json) {
              console.log(chalk.yellow(`Removed orphaned image: ${img}`));
            }
          } catch (err) {
            orphanedImagesFailed.push(img);
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(chalk.yellow(`Warning: failed to remove image '${img}': ${msg}`));
          }
        }

        const containersOutcome = run(['prune'], 'Removed stopped containers', json);
        const imagesOutcome = run(['image', 'prune'], 'Removed dangling images', json);
        const volumesOutcome = run(['volume', 'prune'], 'Removed unused volumes', json);

        if (json) {
          printJson({
            action: 'cleaned',
            orphanedImagesRemoved,
            orphanedImagesFailed,
            prunes: {
              containers: containersOutcome.status,
              images: imagesOutcome.status,
              volumes: volumesOutcome.status,
            },
          });
        } else {
          console.log(chalk.bold('\nDone.'));
        }
      });
    });
```

(The orphaned-image computation moves above the dry-run branch so both paths share it; delete the old in-body copy. `getConfigDir` is already imported; keep the existing running-workspaces stdout warning block but wrap it in `if (!json)`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/commands/cleanup.test.ts && bun x tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 5: README**

Replace the cleanup row's command cell with `pi-tin cleanup [--all] [--force] [--dry-run] [--json]` and append to its description: `; --dry-run previews what would be removed; --json (default when piped) emits a structured result; a full wipe refuses with error code workspaces_running while any workspace is running`.

- [ ] **Step 6: Commit**

```bash
git add src/commands/cleanup.ts src/commands/cleanup.test.ts README.md
git commit -m "feat: add --dry-run and --json to cleanup

Dry-run previews stopped containers, orphaned images, and prune scope
(--all previews the full-wipe scope); JSON mode emits structured results.
The full-wipe refusal while workspaces are running is now a structured
workspaces_running error instead of console.error + exit 1."
```

---

### Task 7: Complete the agent help schema + drift test

**Files:**
- Modify: `src/lib/agent-guide.ts`
- Modify: `src/lib/agent-guide.test.ts`
- Modify: `README.md` (agent-guide bullets)

**Interfaces:**
- Consumes: `buildProgram` from `src/cli-program.js` (test only); flag surfaces added in Tasks 4–6.
- Produces: `HelpCommand.destructive?: true`; `HelpSchema.interactiveOnly: { command: string; use: string }[]`; `HelpSchema.contract.interactive: string`.

- [ ] **Step 1: Write the failing drift test**

Append to `src/lib/agent-guide.test.ts`:

```ts
import type { Command } from 'commander';
import { buildProgram } from '../cli-program.js';

function resolveCommand(root: Command, path: string): Command | undefined {
  return path.split(' ').reduce<Command | undefined>(
    (current, segment) => current?.commands.find((c) => c.name() === segment),
    root,
  );
}

describe('agent help schema drift', () => {
  const program = buildProgram({ version: '0.0.0-test', homepage: 'https://example.invalid' });

  test('every registered command is documented as drivable or interactive-only', () => {
    const documented = new Set([
      ...AGENT_HELP_SCHEMA.commands.map((c) => c.command),
      ...AGENT_HELP_SCHEMA.interactiveOnly.map((c) => c.command),
      'agent-guide',
      'help',
    ]);
    const registered = [
      ...program.commands.map((c) => c.name()),
      ...program.commands.flatMap((group) =>
        group.commands.map((sub) => `${group.name()} ${sub.name()}`),
      ),
    ];
    const undocumented = registered.filter(
      (name) =>
        !documented.has(name)
        && !AGENT_HELP_SCHEMA.commands.some((c) => c.command.startsWith(`${name} `))
        && !AGENT_HELP_SCHEMA.interactiveOnly.some((c) => c.command.startsWith(`${name} `)),
    );
    expect(undocumented).toEqual([]);
  });

  test('every schema command exists with the flags it claims', () => {
    const missing: string[] = [];
    for (const entry of AGENT_HELP_SCHEMA.commands) {
      const command = resolveCommand(program, entry.command);
      if (command === undefined) {
        missing.push(`unknown command '${entry.command}'`);
        continue;
      }
      for (const flag of entry.flags ?? []) {
        const long = flag.split(' ')[0];
        if (!command.options.some((o) => o.long === long)) {
          missing.push(`'${entry.command}' is missing documented flag '${long}'`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('every interactive-only entry exists on the program', () => {
    const unknown = AGENT_HELP_SCHEMA.interactiveOnly
      .filter((entry) => resolveCommand(program, entry.command) === undefined)
      .map((entry) => entry.command);
    expect(unknown).toEqual([]);
  });
});
```

(Merge these imports with the file's existing ones; `AGENT_HELP_SCHEMA` is already imported there. If `help` does not appear in `program.commands`, the hardcoded set entry is simply unused — harmless in both directions because the reverse test only iterates schema entries.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/agent-guide.test.ts`
Expected: FAIL — `interactiveOnly` does not exist on the schema, and `stop`/`delete`/`cleanup`/`open`/`create`/`add`/`agent-profile discover`/`agent-profile finder`/`container-profile` group gaps are reported by the first test.

- [ ] **Step 3: Update the schema**

In `src/lib/agent-guide.ts`:

1. `HelpCommand` gains `destructive?: true;`.
2. `HelpSchema` gains `interactiveOnly: { command: string; use: string }[];` and the contract type gains `interactive: string;`.
3. Add to `AGENT_HELP_SCHEMA.contract` (after `destructive`):

```ts
    interactive:
      'Interactive-only commands (listed under interactiveOnly) refuse without a TTY: exit 1, error code interactive_only. Use the listed alternative.',
```

4. Add to `commands` after the `detect-host` entry:

```ts
    {
      command: 'stop',
      summary: 'Stop a running workspace',
      args: ['<workspace>'],
      flags: ['--force', '--dry-run', '--json'],
      destructive: true,
    },
    {
      command: 'delete',
      summary: 'Delete a workspace: container, image, and config',
      args: ['<workspace>'],
      flags: ['--force', '--dry-run', '--json'],
      destructive: true,
    },
    {
      command: 'cleanup',
      summary: 'Remove stopped containers, dangling images, and unused volumes; --all wipes all pi-tin data',
      flags: ['--all', '--force', '--dry-run', '--json'],
      destructive: true,
    },
```

5. Add `destructive: true,` to the existing `container-profile delete` and `agent-profile delete` entries.
6. Add after `commands`:

```ts
  interactiveOnly: [
    { command: 'create', use: 'Use `apply <name>` with workspace JSON on stdin.' },
    { command: 'add', use: 'Use `show <name> --json`, edit projects, then `apply <name>`. (`add <workspace>` with an explicit name works headless.)' },
    { command: 'open', use: 'Requires a terminal — attaches a tmux session. No headless equivalent.' },
    { command: 'agent-profile discover', use: 'Use `agent-profile add <name> --agent <agent>`.' },
    { command: 'agent-profile finder', use: 'Opens macOS Finder. Use `agent-profile show <name> --json`.' },
  ],
```

7. In `AGENT_GUIDE`: add the contract bullet `- ${AGENT_HELP_SCHEMA.contract.interactive}` after the `destructive` bullet, and add a typical flow after the agent-profiles block:

```
- Stop or delete a workspace (destructive — preview, confirm with the user, then --force):
    pi-tin delete <name> --dry-run
    pi-tin delete <name> --force
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/agent-guide.test.ts && bun x tsc --noEmit && bun test`
Expected: PASS. If the drift test still lists gaps (e.g. a container-profile subcommand or `help` visibility differs from expectation), fix the schema — not the test — unless the test's group-prefix logic is provably wrong.

- [ ] **Step 5: README**

In the **Driving pi-tin from an agent** section, append to the `agent-guide --json` bullet: `The schema also annotates destructive commands (\`destructive: true\`) and lists interactive-only commands (\`interactiveOnly\`) with their headless alternatives.`

In the **Destructive-command confirmation** bullet, append: `All five support \`--dry-run\` (preview the effect) and \`--json\`.`

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent-guide.ts src/lib/agent-guide.test.ts README.md
git commit -m "feat: complete the agent help schema with destructive and interactive-only surfaces

--help --json previously omitted stop/delete/cleanup (which agents can
drive headless under the exit-4 contract) and was silent about the
interactive wizards. Commands now carry a destructive annotation, an
interactiveOnly section names create/add/open/discover/finder with
headless alternatives, and a drift test pins the schema to the
registered commander surface."
```

---

### Task 8: Full gate + end-to-end contract probes

**Files:**
- No source changes expected; fixes only if probes fail.

- [ ] **Step 1: Full release gate**

Run: `bun run prepublishOnly`
Expected: typecheck, full test suite, and build all pass.

- [ ] **Step 2: Re-run the field-test probes against the built CLI**

Run each against `dist/cli.js` from a non-TTY shell (pipe through `cat` if needed). These are read-only or dry-run — none may mutate config or containers. `pi-tin` resolves to this repo's `dist/cli.js` via the global symlink; a sandboxed shell cannot reach the container service, so run probes that need it unsandboxed.

| Probe | Expected |
|---|---|
| `pi-tin create </dev/null; echo $?` | `interactive_only` envelope on stderr, exit `1`, no prompt rendering, no `Goodbye!` |
| `pi-tin add </dev/null; echo $?` | `interactive_only` envelope, exit `1` |
| `pi-tin bogus; echo $?` | `unknown_command` envelope with `validValues`, exit `2` |
| `pi-tin bogus --help; echo $?` | same envelope, exit `2` (no root help) |
| `pi-tin list --bogus; echo $?` | `usage` envelope, exit `2` |
| `pi-tin show; echo $?` | `usage` envelope (missing argument), exit `2` |
| `pi-tin stop <stopped-ws>; echo $?` | `{ "action": "noop", … }` JSON on stdout, exit `0` |
| `pi-tin stop <stopped-ws> --dry-run` | `{ "action": "noop", …, "dryRun": true }` |
| `pi-tin delete <stopped-ws> --dry-run` | `{ "action": "delete", …, "dryRun": true }`, workspace still exists after |
| `pi-tin cleanup --dry-run` | `{ "action": "cleanup", …, "dryRun": true }`, nothing removed |
| `pi-tin cleanup --all --dry-run` | `full-wipe` preview or `workspaces_running` envelope — nothing removed |
| `pi-tin --help --json \| head -5` | schema including `interactiveOnly` |
| `pi-tin stop --help; echo $?` | normal help, exit `0` |
| `pi-tin list && pi-tin show <ws> \| pi-tin apply <ws> --dry-run` | unchanged happy path, `"changes": []` |

Use a stopped workspace name from `pi-tin list` (e.g. `blitz`). After the delete dry-run, confirm with `pi-tin show <ws>` that nothing was deleted.

- [ ] **Step 3: Fix anything that fails, then re-run the gate**

Any failing probe is a bug in the corresponding task — fix it there (root cause, not symptom), keep the probe as the regression check, re-run `bun run prepublishOnly`.

- [ ] **Step 4: Final commit (only if fixes were needed)**

```bash
git add -A src/ README.md
git commit -m "fix: <specific probe failure and root cause>"
```
