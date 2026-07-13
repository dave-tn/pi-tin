# Agent-ready CLI hardening — design

Date: 2026-07-13
Status: approved

## Context

A black-box field test (an agent driving the installed CLI from `--help`
alone, no source access) confirmed the agent contract from
`2026-06-25-agent-drivable-cli-design.md` largely holds: JSON-on-non-TTY,
error envelopes, exit codes 2/3/4, dry-run diffs, and blast-radius previews
all behaved as documented. It also surfaced four defects:

1. **`create` false-reports success non-interactively.** With no TTY it
   renders its inquirer prompt anyway, hits EOF, prints `Goodbye!` and exits
   0 having created nothing. `add` and the bare `pi-tin` default action share
   the unguarded-prompt pattern. Root cause: `withExitHandling` treats
   inquirer's `ExitPromptError` as a graceful quit, and nothing gates the
   wizards on `isInteractiveSession()` the way commit `7049f25` gated the
   prereq flows.
2. **The agent schema hides commands agents legitimately drive.**
   `--help --json` omits `stop`, `delete`, `cleanup` — all three already
   refuse safely (exit 4) non-interactively via `confirmDestructive`, so
   hiding them protects nothing. Agents discover them anyway through the
   root-help leak (`pi-tin <unknown> --help` prints the full Commander
   command list, exit 0) and then drive them without contract guidance,
   `--dry-run`, or `--json`. The genuinely human-only wizards (`create`,
   `open`, `add`) are omitted silently rather than explicitly.
3. **Two error dialects.** pi-tin's own errors are JSON envelopes with typed
   exit codes; Commander-level errors (unknown option, missing argument)
   bypass them — plain text, exit 1. Worst case: `pi-tin bogus` reports
   `error: too many arguments` (the root default action's excess-args check),
   and `pi-tin bogus --help` exits 0 with root help — a false positive for
   existence probing.
4. **Contract leaks in stop/delete/cleanup.** `stop` prints prose to stdout
   in JSON mode (`Workspace 'X' is not running.`); none of the three support
   `--dry-run`/`--json`, unlike the profile deletes; `cleanup --all` refuses
   with `console.error` + exit 1 instead of a `CliError` when workspaces are
   running.

## Decisions

- Non-TTY wizard invocations refuse with a structured error: exit 1
  (`EXIT.GENERAL`), envelope code `interactive_only`. No new exit code — the
  stable exit-code table is unchanged; agents branch on the envelope code.
- The schema surface splits: `commands[]` remains "what agents drive" and
  gains `stop`/`delete`/`cleanup` annotated `destructive: true`; a new
  `interactiveOnly` section names `create`/`open`/`add` with a `use` pointer
  each. Wizards stay human-only; no non-interactive `create`/`add` path is
  added (`apply` already covers it).
- Commander usage errors map to `EXIT.VALIDATION` (2) and flow through the
  existing envelope/prose handler. Unknown first positional beats `--help`.

## Design

### 1. `interactive_only` refusal for wizard entry points

`ensureInteractive(command, remediation)` lives in `src/lib/confirmation.ts`
beside `isInteractiveSession()`: when the session is not interactive it
throws `CliError(EXIT.GENERAL, { code: 'interactive_only', remediation })`.
Called at the top of:

- `runCreateFlow` (`src/commands/create.ts`) — remediation points at
  `pi-tin apply <name>` (JSON on stdin) and `pi-tin detect-host`.
- `runAddCommand` (`src/commands/add.ts`) — remediation points at
  `show --json` → edit → `apply`.
- `runDefaultAction` (`src/lib/default-action.ts`) — remediation points at
  explicit commands (`list`, `open <workspace>`).
- `agent-profile discover` (`src/commands/agent-profile-discover.ts`) if its
  wizard is unguarded — confirm during implementation; same treatment.

The guard throws before any prompt renders, so `withExitHandling` never
converts the failure into `Goodbye!`/exit 0. Interactive behaviour is
untouched.

### 2. Schema surface split (`src/lib/agent-guide.ts`)

- `HelpCommand` gains optional `destructive?: true`.
- `AGENT_HELP_SCHEMA.commands` adds:
  - `stop <workspace>` — flags `--force`, `--dry-run`, `--json`,
    `destructive: true`
  - `delete <workspace>` — flags `--force`, `--dry-run`, `--json`,
    `destructive: true`
  - `cleanup` — flags `--all`, `--force`, `--dry-run`, `--json`,
    `destructive: true`
  - existing profile-delete entries gain `destructive: true` for
    consistency.
- New `HelpSchema` field:

  ```ts
  interactiveOnly: { command: string; use: string }[]
  ```

  Entries: `create` → "use `apply` (JSON on stdin)"; `add` → "use
  `show --json` → edit → `apply`"; `open` → "requires a terminal — attaches a
  tmux session". These commands refuse with `interactive_only` when run
  without a TTY.
- Contract prose gains one line for `destructive` semantics (already partly
  present) and one for `interactiveOnly`. `AGENT_GUIDE` mentions the
  workspace-level destructive flow (`--dry-run` preview → confirm →
  `--force`).
- **Drift test**: a test builds the program via `buildProgram()` and asserts
  the schema's `commands` ∪ `interactiveOnly` ∪ `{help, agent-guide}` equals
  the registered top-level command names (and likewise for the two profile
  subcommand groups), so the hand-maintained schema cannot silently drift.
  Flags per command are similarly asserted against Commander's registered
  options.

### 3. Commander errors through the envelope

- `buildProgram` calls `program.exitOverride()`.
- A pure classifier (plan/execute style, colocated with
  `src/lib/help-request.ts` logic) inspects argv before parse: first
  positional not in the known command set → plan `refuse-unknown-command`.
  The effectful side throws
  `CliError(EXIT.VALIDATION, { code: 'unknown_command', badInput,
  validValues, remediation })`. This wins over `--help`, closing the
  `bogus --help` → exit 0 false positive. Hidden intercepted commands
  (auto-stop, check-for-update) and flag-only invocations are exempt.
- `src/cli.ts` catches `CommanderError`: `commander.helpDisplayed` /
  `commander.version` → exit 0; usage codes (`unknownOption`,
  `missingArgument`, `excessArguments`, `invalidArgument`, `unknownCommand`)
  → rethrown as `CliError(EXIT.VALIDATION, { code: 'usage', remediation })`
  handled by the existing envelope/prose emitter.

### 4. `--dry-run`/`--json` on stop, delete, cleanup

Mirror `src/commands/agent-profile-delete.ts`:
validate → plan → `shouldEmitJson(opts.json)` → dry-run prints the impact
object with `dryRun: true` (prose preview on TTY); real run confirms via
`confirmDestructive`, then prints a structured result.

- `stop`: plan already exists (`planStopWorkspace`). JSON outputs for every
  outcome, including the no-op
  (`{ action: 'noop', workspace, reason: 'not-running' }`) — fixing the
  prose-on-stdout leak. Dry-run reports what would be stopped/removed.
- `delete`: dry-run previews the blast radius — container, image, config
  path, project count — from `planDeleteWorkspace` data.
- `cleanup`: dry-run lists what `planCleanup` selected (containers, images,
  volumes); `--all` dry-run summarises the full-wipe scope. The
  running-workspaces refusal in `fullWipe` becomes a `CliError` instead of
  `console.error` + exit 1.

Existing planners already make the decisions; this is output-layer work. No
planner semantics change.

## Testing

- Unit: `ensureInteractive` truth table; invocation classifier plans;
  Commander-error mapping; JSON/prose output shapes for
  stop/delete/cleanup (planner-level, temp dirs + `XDG_CONFIG_HOME`).
- Drift test as in §2.
- End-to-end (after `bun run build`): re-run the field-test probes —
  `create </dev/null` (exit 1, `interactive_only` envelope), `pi-tin bogus`
  (exit 2, `unknown_command`, `validValues`), `pi-tin bogus --help` (exit 2),
  `stop` no-op in JSON mode, `delete`/`cleanup --dry-run`, and the unchanged
  happy paths (`list`, `show`, `apply --dry-run` round-trip).

## README impact

- Command table rows for `stop`/`delete`/`cleanup` (`--dry-run`, `--json`).
- Destructive-command contract section: workspace commands now share the
  preview → confirm → `--force` flow.
- Agent-guide section: `interactiveOnly`, `destructive` annotation,
  `interactive_only` and `unknown_command` error codes.
- Exit-code table: unchanged (deliberately).

## Out of scope

- Non-interactive `create`/`add` (covered by `apply`).
- Headless `open` / starting a workspace without attaching.
- Changing `cleanup --all` semantics beyond error-shape and dry-run.
- Deriving the agent schema from Commander (hand-maintained + drift test is
  simpler and keeps the schema curated).
