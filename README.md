# pi-tin

[![npm version](https://img.shields.io/npm/v/pi-tin.svg)](https://www.npmjs.com/package/pi-tin)
[![CI](https://github.com/dave-tn/pi-tin/actions/workflows/ci.yml/badge.svg)](https://github.com/dave-tn/pi-tin/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js Version](https://img.shields.io/node/v/pi-tin.svg)](https://nodejs.org)
[![Platform: macOS 26+ · Apple Silicon](https://img.shields.io/badge/platform-macOS%2026%2B%20%C2%B7%20Apple%20Silicon-000?logo=apple&logoColor=white)](#prerequisites)

_Pie tins hold pies. `pi-tin` holds your agent dev environments._

**Let your AI coding agents run free — local, contained workspaces.**

```bash
cd ~/dev/my-app && pt        # opens a VM-isolated workspace, agent ready
```

The full power of `--dangerously-skip-permissions` (and Codex's and Gemini's YOLO modes), without the danger. pi-tin gives each workspace its own micro-VM — a real Linux container with a full VM boundary, via Apple's efficient, lightweight `container` CLI (no Docker, no shared VM) — so agents can run with permission prompts bypassed, free to move fast _inside the box_, while your Mac, your keys, and your other projects and data stay outside it.

**Running free is the default.** Pi and Amp already work this way; Claude Code, Codex, Gemini, and OpenCode are launched in bypass mode. (Prefer prompts? Set `agent.skipPermissions: false`.)

**Runs on your Mac.** No cloud VMs, no remote dev environment to rent or trust — the sandboxes are local, backed by Apple's native virtualization.

**Open source top to bottom.** pi-tin (GPLv3), Apple's `container` runtime (Apache-2.0), and the Linux kernel — all open — running on the virtualization built into macOS.

**OCI-compatible.** Use standard images from Docker Hub, GHCR, and any OCI registry — existing container images just work.

Daily-driven on Pi and Claude Code; Amp, OpenCode, and more are supported but lightly tested. Customisable to support any agent.

The concept is simple: pi-tin makes a workspace (linux vm, agent profile(s), your selected project repos), and 'entering' the workspace via `pt` teleports you from your Mac into the workspace where agents can be unleashed.

_**Status:** Early (pre-1.0) — the core create/open/share flow is solid, but expect rough edges on less-common agents and setups. Issue reports are welcome._

> [!IMPORTANT]
> What you put in the sandbox is what the agent can access. Everything outside the sandbox is off-limits. The agent cannot see your host machine or your files, unless you explicitly make them available.

## Concepts

pi-tin has four pieces. You set them up once, then live in **workspaces** day to day.

- **Project** — a directory on your Mac (your repo). Mounted into a workspace; the same project can live in more than one workspace, and a workspace can have more than one project.
- **Container profile** — the image recipe: base image, packages, global tools, CPU/memory. One container profile backs many workspaces. pi-tin ships defaults (`node-dev`, `python-dev`, …).
- **Agent profile** — an AI agent's identity: isolated, persistent auth + config (e.g. a `personal` vs `work` login). Independent of the container profile and shareable across workspaces, so you log in once.
- **Workspace** — what you open. It binds **one container profile**, your **project(s)**, and any **agent profile(s)** into a running, shareable container shell. This is your everyday unit.

```
container profile ──┐
                    ├──▶  workspace  ◀──  project(s)
agent profile(s) ───┘
```

Everyday flow: `cd` into a project and run `pt` — it opens the matching workspace (and offers to create or pick one if needed).

## Prerequisites

- Apple Silicon Mac (M1 or later)
- macOS 26 or later with Apple's [`container` CLI](https://github.com/apple/container) **1.0.0 or later** installed
- Node.js 18+

If the `container` CLI isn't installed, pi-tin will offer to install it for you (via Homebrew or direct download).

## Installation

```bash
npm install -g pi-tin
```

> [!TIP]
> `pt` is a built-in alias for `pi-tin` — use whichever you prefer, they're interchangeable (e.g. `pt open myproject`).

## Quick Start

### Set up with an agent

Already have an AI coding agent in your project? Paste the prompt below to get started:

```text
Set up pi-tin for this project, acting as my natural-language UI for it.

1. Read https://github.com/dave-tn/pi-tin to learn what pi-tin is and how it fits
   THIS project (infer the stack from the repo); tell me in 2-3 sentences, then ask
   before doing anything.
2. Run `pi-tin agent-guide` — it tells you pi-tin's command surface, the JSON
   contract and exit codes, AND how to act as my natural-language UI. Follow it.
3. Drive pi-tin through that agent CLI — never the interactive `create` wizard or
   hand-edited YAML — to set up a workspace for this project.
```

### Set up manually

Day to day there's really one command: `pt`. `cd` into a project and run it —

```bash
cd ~/dev/my-app && pt
```

— and `pt` does the right thing for that directory:

- **One workspace includes it** → opens that workspace (starting it, or joining it if it's already running).
- **Several include it** → you pick which to open, or create a new one.
- **None include it** → `pt` offers to create a workspace for it, launching the interactive setup; if you already have other workspaces, it also offers to add this directory to one of them instead.

On first run, `pt` will offer to install the `container` CLI if it's missing; the default container profiles (`node-dev`, `python-dev`, …) are installed automatically and kept up to date (see [Container profiles](#container-profiles)). It also offers to create a default agent profile.

> [!NOTE]
> First run can involve downloading container images and package installs (potentially a few GB), so it may take a few minutes. Subsequent runs are fast; entering a workspace is sub-second.

Workspace names must be lowercase alphanumeric, and may contain `.`, `-`, or `_` (e.g. `my-project`, `app_v2`).

Need to be explicit? `pi-tin create <name>` builds a workspace up front, `pi-tin open <name>` opens one by name from anywhere, and `pi-tin --build` forces an image rebuild on the matched workspace's next start.

## Why Apple Containers?

Most container tools — Docker Desktop, Colima, Podman, OrbStack — run every container inside one shared Linux VM. Apple's [`container`](https://github.com/apple/container) CLI runs **each container in its own lightweight VM** via the Virtualization framework. Apple's container system is lightweight, efficient, and optimised for macOS. For pi-tin that means:

- **Stronger per-workspace isolation.** Each workspace gets a full VM boundary — a better fit for autonomous coding agents than a shared VM.
- **Selective host access.** You mount only the host paths a workspace needs, rather than exposing broader paths to one shared VM.
- **Sub-second start times.** An optimised kernel config, minimal root filesystem, and lightweight init keep startup fast.

## Configuration

Configs live at `~/.config/pi-tin/` (or `$XDG_CONFIG_HOME/pi-tin/`):

```
~/.config/pi-tin/
  profiles/
    node-dev.yaml      # Container image recipe (one of several bundled defaults)
  workspaces/
    myproject.yaml     # Workspace definition
  agent-profiles/
    personal/          # Agent identity (auth + config)
```

Config is created automatically on first use.

### Container profiles

A container profile defines the container image: base image, packages, global tools, and setup commands. pi-tin ships these opinionated defaults, each with the same shell tooling baseline (zsh + Oh My Zsh, zoxide, tmux, GitHub CLI, plus modern search/navigation CLIs — `ripgrep`, `fd`, `bat`, `fzf`, `tree`) and a current Node.js/npm (pi-tin installs all agent and global tooling with npm; container profiles not built on a Node base image install the current Node.js via NodeSource):

| Container profile | Base image | For |
|---------|-----------|-----|
| `node-dev` | `node:trixie-slim` | Node.js, with `@playwright/cli` + Chromium |
| `bun-dev` | `oven/bun:slim` | Bun (project work) alongside Node.js/npm, with `@playwright/cli` + Chromium |
| `python-dev` | `python:3.13-slim` | Python 3.13 with `uv`, pip/venv and build tools |
| `rust-dev` | `debian:trixie-slim` | Rust via `rustup`, with build tools |
| `dotnet-dev` | `mcr.microsoft.com/dotnet/sdk:10.0` | .NET SDK 10 (LTS) |

Defaults ship with pi-tin and are updated automatically when pi-tin is upgraded. To customise one, remove the `# This profile is managed by pi-tin...` comment at the top — pi-tin will then leave the file untouched on future updates — or copy it to a new name and modify the copy.

The managed `node-dev` container profile uses `node:trixie-slim` (Debian 13), installs `@playwright/cli` plus Chromium, and sets `PLAYWRIGHT_MCP_BROWSER=chromium` so `playwright-cli` defaults to Chromium rather than the Chrome channel. All managed profiles set `LANG`/`LC_ALL` (`C.UTF-8`) and `NODE_EXTRA_CA_CERTS`; `dotnet-dev` also sets `DOTNET_CLI_TELEMETRY_OPTOUT` and `DOTNET_NOLOGO`.

#### Container profile schema

| Field             | Required | Description |
| ----------------- | -------- | ----------- |
| `description`     | yes      | Human-readable label. |
| `base_image`      | yes      | OCI image ref (e.g. `node:trixie-slim`, `debian:trixie-slim`). The package manager is auto-detected from the name — see `package_manager`. |
| `package_manager` | no       | Override auto-detection (`apt` / `apk` / `dnf`). Detection: name prefixes `debian`/`ubuntu`/`node`/`python`/`oven/bun`/`buildpack-deps` → `apt`; `alpine` anywhere in the name (e.g. `python:3.12-alpine`) → `apk`; `fedora`/`rockylinux`/`almalinux` prefixes or a `/rhel`/`/ubi` path segment (e.g. `redhat/ubi9` — bare `rhel:9` is not recognised) → `dnf`. **Required when the base image name isn't recognised** (e.g. `mcr.microsoft.com/...`); generation throws otherwise. |
| `user`            | yes      | Non-root username for the container. Must match `^[a-z_][a-z0-9_-]*$`. pi-tin sets `HOME` to `/home/<user>` (`/root` for `root`) and anchors the mounts it manages there; this wins over any home a base image already assigns to a pre-existing user of that name. |
| `packages`        | no       | System packages installed via the package manager. Defaults to `[]`. pi-tin enters a workspace via the container user's login shell (falling back to `/bin/sh`); to use a specific shell, install it here and set it as the login shell in `post_install` (e.g. `chsh -s "$(command -v zsh)" "$USERNAME"`, as the managed profiles do for zsh). |
| `extra_packages`  | no       | Concatenated with `packages` into the **same** install step — no behavioural or layering difference; the split is purely organisational. Defaults to `[]`. |
| `global_tools`    | no       | Packages installed globally with **npm** (always npm, regardless of base image), before workspace tools. Defaults to `[]`. |
| `post_install`    | no       | Root shell commands, run after system packages and before the user switch. Defaults to `[]`. |
| `post_setup`      | no       | User-level shell commands, run as `user` after global tool installs and before workspace packages. Defaults to `[]`. Use this for anything that installs into the user's `$HOME` (e.g. `rustup`). |
| `env`             | no       | Environment variables. Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`; values must be strings (quote numbers, e.g. `"1"`) and are auto-quoted/escaped for the Dockerfile. Defaults to `{}`. |
| `cpus`            | no       | CPU limit, positive integer. Default: host cores − 2 (min 2). |
| `memory`          | no       | Memory limit string, e.g. `"16g"`. K/M/G/T/P suffix (optional trailing `b`). Default: `8g`. |
| `workspace_state` | no       | Home-relative paths carried across container restarts — see [Workspace state](#workspace-state). Each path must be home-relative (no leading `/`, no `.`/`..` segments). Defaults to `[]`. |

#### Workspace state

A workspace container is semi-ephemeral: your project code and a few live host mounts survive because they're bind-mounted from the host, but the rest of the container's home is rebuilt from the image whenever the container is recreated (a restart, or the first open after an auto-stop). That normally discards small, useful container-internal state like the `zoxide` jump database and shell history.

`workspace_state` lists home-relative paths pi-tin snapshots across those recreations: copied **in** when a fresh container starts, and **out** when a session closes while the container is still running. State is stored per workspace under `~/.config/pi-tin/workspace-state/<workspace>/`, so two workspaces on the same profile keep independent copies. Sync is **best-effort**: if Apple's `container` CLI fails or hangs, pi-tin skips the rest of that sync after a timeout rather than blocking `open`/exit indefinitely.

> [!NOTE]
> This is a **snapshot, not a live mount.** State is copied in at start and out at close — never synced live, and no shared-directory budget is used. If two sessions run against the same workspace, the last to close wins. It is not a substitute for host mounts.

Keep `workspace_state` deliberately small and tightly coupled to the container's own tooling — inert, tool-owned data such as databases and history, not shell rc files or anything executed. It exists only to smooth over the container's ephemerality for a few specific dev tools; it is **not** a general state-sync or backup mechanism. Everything else should stay ephemeral, with your code and working files living on host mounts instead. Agent sessions are **not** covered here; they persist via [agent profiles](#agent-profiles) instead.

#### Creating custom container profiles

Copy a managed default to a new name and edit it:

```
cp ~/.config/pi-tin/profiles/node-dev.yaml ~/.config/pi-tin/profiles/my-profile.yaml
```

Remove the `# This profile is managed by pi-tin...` header line so pi-tin won't overwrite it, then adjust the fields above to match your stack. Reference it from a workspace with `profile: my-profile`.

**Tip:** You can ask an AI coding agent to build a custom container profile — point it at the Container profile schema table above and any existing container profile as a template.

> [!NOTE]
> **Terminal fonts:** Nerd Font glyphs are rendered by the terminal app on your Mac, not by the container. If agent UIs show boxes or missing icons, install and select a Nerd Font in your terminal emulator (for example JetBrainsMono Nerd Font or FiraCode Nerd Font).

Container profiles can optionally configure container resources:

```yaml
cpus: 8         # default: system cores - 2 (minimum 2)
memory: "16g"   # default: 8g (supports K, M, G, T, P suffixes)
```

When omitted, pi-tin allocates sensible defaults for development workloads. Resources take effect on the next workspace restart.

> [!NOTE]
> Container memory is reserved on the host but _not_ physically consumed until the container actually uses it. Memory is freed when the workspace stops.

### Workspaces

A workspace defines your dev environment: which container profile to use, which projects to mount, and how the agent and host are configured.

The schema has two key sections: **`agent`** controls agent behaviour inside the workspace, **`host`** controls what the workspace can reach from your Mac.

```yaml
profile: node-dev
projects:
  - /Users/you/dev/my-app
  - /Users/you/dev/my-lib
stopAfterLastSession: 30s
tools:
  - name: Claude Code
    package: "@anthropic-ai/claude-code@latest"
  - name: Pi
    package: "@earendil-works/pi-coding-agent@latest"
agent:
  skipPermissions: true
  profiles:
    - personal
    - pi-agent
host:
  sshAgent: true
  githubCLI: true
  env:
    COLORTERM: ${COLORTERM}
    TZ: America/New_York
    GIT_AUTHOR_NAME: Your Name
    GIT_AUTHOR_EMAIL: you@example.com
    GIT_COMMITTER_NAME: Your Name
    GIT_COMMITTER_EMAIL: you@example.com
    ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
```

Notes:
- `projects` must be absolute paths (set automatically by `pi-tin create`)
- `tools` are installed globally via `npm install -g` during the first `pi-tin open`, then re-installed in the background on every container start (agent binaries are re-wrapped after a successful update; a failed update prints a notice and keeps the existing versions). The interactive `create` command writes only `name` and `package`. For known agents, pi-tin re-derives internal metadata from `package` at runtime. Manual tool entries should also use only `name` and `package`; extra keys are rejected.
- `agent.profiles` names of agent profiles to mount (see Agent Profiles section below). Each profile provides isolated, persistent auth for an agent.
- `agent.skipPermissions` (default `true`) configures supported agents to skip interactive permission prompts (see [Permissions](#permissions)).
- `host.sshAgent` (default `true`) forwards your SSH agent for git auth with any provider.
- `host.githubCLI` (default `false`) enables GitHub CLI integration — automatically mounts `~/.config/gh` and resolves a `GH_TOKEN`.
- `host.mounts` allows additional host directories to be mounted. Each entry is `{ host, container, readonly }`, all three required (e.g. `{ host: ~/data, container: /data, readonly: true }`). `host` supports `~` expansion; a mount whose host path doesn't exist is skipped with a warning. Must be **directories** — single file mounts are not supported.
- `host.env` values are passed to the container at runtime. Use `${VAR}` syntax to forward a host environment variable without hardcoding secrets in the YAML — if the host variable is unset, the entry is silently skipped. Only values that are exactly `${VAR}` are resolved; a `${…}` inside a longer string passes through literally, with a warning.
- `stopAfterLastSession` controls how long pi-tin keeps a workspace running after the last host-side session exits. Format: an integer with a single `s`/`m`/`h` unit (e.g. `90s`, `5m`, `1h`) — no combinations. Default: `30s`.
- If Apple's `container` CLI stops responding, pi-tin bounds all of its non-interactive `container` calls (`exec`, `cp`, `run`, `stop`, `kill`, `delete`, `list` and image operations) and fails fast rather than hanging indefinitely; only the interactive shell attach and the streaming image build run without a deadline. In that state you may need to restart the container system (`container system stop`, then `container system start`) before the workspace can be attached or stopped cleanly. If those commands hang too, try restarting the relevant launchd service (for example `launchctl kickstart -k gui/$(id -u)/com.apple.container.apiserver`, or a specific `com.apple.container.container-runtime-linux.<name>` service). If that still does not recover it, log out/in or reboot macOS.
- A workspace start may mount at most **22 distinct host directories** — a conservative limit to avoid Apple `container` startup failures with large mount sets. Projects, `host.mounts`, agent profiles, and GitHub CLI mounts each count toward it.
- `pi-tin create` forwards `COLORTERM` from the host by default (`COLORTERM: ${COLORTERM}`) so tools inside the workspace can detect truecolor support when your terminal provides it.
- `pi-tin create` detects your Mac's timezone (from `/etc/localtime`) and writes it as a literal `host.env.TZ` (e.g. `TZ: America/New_York`) so the container shares your local time by default. Edit the value to use a different zone, or remove the line to fall back to UTC. The value is a snapshot taken at create time — it does not track later host changes. Existing workspaces are unaffected; add `TZ` by hand to opt in. The managed `node-dev` container profile bundles `tzdata` so IANA zone names resolve; **custom container profiles must include a zoneinfo source (e.g. the `tzdata` package)** or `TZ` will silently fall back to UTC.
- Git identity is detected from your host `~/.gitconfig` during `pi-tin create`.

### Update notifications

pi-tin checks npm in the background — at most once every 24 hours — for a newer
release, and prints a single-line notice the next time you return to your shell
when one is available:

```
pi-tin <latest> available (you have <current>) · update: npm i -g pi-tin
```

The notice is automatically suppressed for non-interactive or machine-readable
use (piped output, `--json`, or a non-TTY stdout). To opt out entirely, set any
of the following to a non-empty value:

- `PI_TIN_NO_UPDATE_NOTIFIER` — pi-tin's own opt-out.
- `NO_UPDATE_NOTIFIER` — the ecosystem-wide convention.
- `CI` — notices are off on CI by default.

> [!NOTE]
> The check queries the public npm registry directly and does not honour a
> private/custom registry configuration.

## Commands

| Command | Description |
|---------|-------------|
| `pi-tin create [name]` | Create a new workspace (interactive; prompts for a name when omitted) |
| `pi-tin [--build]` | Auto-open the workspace matching the current directory; when none match, offer to create a new workspace (or, if other workspaces exist, to add the directory to one of them); `--build` forces a rebuild when a match is found |
| `pi-tin add [workspace]` | Add the current directory to an existing workspace (interactive picker), or `add <name>` to target one directly |
| `pi-tin open <name> [--build]` | Start or join a workspace |
| `pi-tin list [--json]` | List all workspaces and their status (`--json` for machine-readable output: `sessions`/`projects` counts and `shutdownMs`, milliseconds until auto-shutdown or null; JSON is the default when output is piped) |
| `pi-tin show <name> [--json]` | Show a workspace definition as JSON (output is always JSON; `--json` is accepted for consistency) |
| `pi-tin apply <name> [--dry-run]` | Create or update a workspace from a JSON object on stdin (see [Editing workspaces](#editing-workspaces)) |
| `pi-tin detect-host` | Print host facts as JSON (output is always JSON) — `{ gitIdentity, tz, colorterm, apiKeys, agents }` — for an agent to compose into a workspace `apply` payload |
| `pi-tin agent-guide [--json]` | Print the agent usage guide (`--json` for a machine-readable schema of commands, flags, and exit codes) — see [Driving pi-tin from an agent](#driving-pi-tin-from-an-agent) |
| `pi-tin stop <name> [--force]` | Stop a running workspace (prompts only when live sessions would be killed; non-interactive callers must then pass `--force` or get exit code 4; `--force` also escalates to `container kill` if a graceful stop exceeds 5s) |
| `pi-tin delete <name> [--force]` | Delete a workspace and its image (`--force` skips the confirmation prompt; non-interactive callers must pass it or get exit code 4) |
| `pi-tin cleanup [--all] [--force]` | Remove stopped containers, dangling images, unused volumes, and pi-tin images whose workspace no longer exists; `--all` does a full wipe (all pi-tin images, config, and data); `--force` skips the confirmation prompt |
| `pi-tin container-profile list [--json]` | List all available container profiles (`--json` for machine-readable output; JSON is the default when output is piped) |
| `pi-tin container-profile show <name> [--json]` | Show details of a container profile (`--json` for machine-readable output; JSON is the default when output is piped) |
| `pi-tin container-profile apply <name> [--dry-run]` | Create or update a container profile from a JSON object on stdin (see [Editing container profiles](#editing-container-profiles)) |
| `pi-tin container-profile delete <name> [--force] [--dry-run] [--json]` | Delete a container profile (`--dry-run` previews the impact, including referencing workspaces; non-interactive callers must pass `--force` or get exit code 4) |
| `pi-tin agent-profile add <name> --agent <agent> [--host] [--json]` | Create a new agent profile (the non-interactive creation path for agent profiles; `--json` for machine-readable output, JSON is the default when output is piped) |
| `pi-tin agent-profile list [--json]` | List all agent profiles (`--json` for machine-readable output; JSON is the default when output is piped) |
| `pi-tin agent-profile show <name> [--json]` | Show an agent profile (output is always JSON; `--json` is accepted for consistency) |
| `pi-tin agent-profile delete <name> [--force] [--dry-run] [--json]` | Delete an agent profile (`--dry-run` previews the impact, including referencing workspaces; non-interactive callers must pass `--force` or get exit code 4) |
| `pi-tin agent-profile discover` | Scan for agents and create agent profiles |
| `pi-tin agent-profile finder [name]` | Open agent profile directory in Finder |

`pi-tin -v` (`--version`) prints the version; `--force` accepts `-f` everywhere it appears.

## Machine-Readable Output

pi-tin is built to be driven by scripts and AI coding agents, not just humans at a terminal.

### Driving pi-tin from an agent

You can hand pi-tin to an AI coding agent and tell it, in plain language, to do the work — for example *"use the pi-tin CLI to create a Python workspace for this project"* or *"use pi-tin to add an API key to my workspace"*. The agent learns the whole command surface from the binary itself, so it does not need any pre-placed instructions:

- `pi-tin agent-guide` prints a concise usage guide written for agents. The top-level `pi-tin --help` prints this same guide automatically when its output is captured (non-TTY); on an interactive terminal it shows the normal help plus an `Agents: run pi-tin agent-guide` pointer.
- `pi-tin agent-guide --json` (or `pi-tin --help --json`) prints a machine-readable schema of commands, flags, and the exit-code contract.

These describe the [Agent surface](#agent-surface) (the JSON read-modify-write loop) and the [stable exit codes](#machine-readable-output) covered below — start there for the details.

### Agent surface

These commands form the JSON read-modify-write surface an agent uses to inspect and reconfigure pi-tin without a TTY:

| Read (`--json` / always JSON) | Write (JSON on stdin) |
|-------------------------------|-----------------------|
| `show <name>` (workspace) | `apply <name>` (workspace) |
| `container-profile show <name>` | `container-profile apply <name>` |
| `agent-profile show <name>` / `agent-profile list` | `agent-profile add <name> --agent <agent>` |
| `detect-host` (host facts, no name) | — |

The contract is **JSON in, JSON out**:

- Each `show` emits exactly the object its paired `apply` accepts on stdin, so the loop is: read with `show --json`, edit the object, write it back with `apply` (preview first with `--dry-run`). `detect-host` supplies host facts (`{ gitIdentity, tz, colorterm, apiKeys, agents }`) an agent composes into a workspace `apply` payload.
- `apply` is a **full replace**, not a merge — the target file is rewritten from the JSON object, so any YAML comments are dropped. Always preview with `--dry-run` (it prints the diff and writes nothing) before a real write. An existing file that no longer parses doesn't block `apply`: the parse error becomes a warning on stderr and the diff treats the file as empty, so `apply` can repair a corrupt workspace or container profile.
- Invalid input is rejected against the relevant schema before anything is written. Every command exits with a stable, semantic code (see the **Stable exit codes** table below) and, in JSON mode, a structured error envelope — so callers branch on `code`, never on prose.
- `agent-profile add` is the non-interactive creation path; agent-profile credentials are populated by logging in on first workspace use, not via `apply`, so there is no `agent-profile apply`.

The subsections below — [Editing container profiles](#editing-container-profiles) and [Editing workspaces](#editing-workspaces) — give the per-command detail.

- **JSON output.** Data-returning commands (`list`, `show`, `container-profile list`, `container-profile show`, `agent-profile list`, `agent-profile show`) accept `--json`. They also emit JSON **by default when stdout is not a TTY** — i.e. when the output is piped or captured — so a script never has to remember the flag. Pass `--json` explicitly to force JSON even in an interactive terminal.
- **Channels.** Results go to **stdout** (the data channel); diagnostics, prompts, and errors go to **stderr**. Capturing stdout alone gives clean parseable output.
- **Stable exit codes.** Every command exits with a semantic code so callers can branch on the outcome without parsing prose:

  | Code | Name | Meaning |
  | ---- | ---- | ------- |
  | 0 | `SUCCESS` | Success |
  | 1 | `GENERAL` | General / unexpected error |
  | 2 | `VALIDATION` | Bad input / schema validation failure |
  | 3 | `NOT_FOUND` | Named workspace, container profile, or agent profile does not exist |
  | 4 | `CONFIRMATION_REQUIRED` | Destructive op without `--force` in non-interactive mode |

- **Destructive-command confirmation.** Destructive commands (`stop`, `delete`, `cleanup`, `agent-profile delete`, `container-profile delete`) prompt for confirmation on an interactive terminal (`stop` only when live sessions would be killed). Run without a TTY they exit with code `4` instead of hanging, unless `--force` is passed.
- **Structured errors.** In JSON mode, errors are emitted as a structured envelope on stderr — `{ "error": { "message", "code", … } }` — so an agent can read the machine-stable `code` (and any `remediation`, `validValues`, or `badInput` fields) instead of grepping the message text.

### Editing container profiles

`container-profile apply <name>` reads a single JSON object on **stdin** — the same shape that `container-profile show --json` emits — and writes it to `~/.config/pi-tin/profiles/<name>.yaml`. This is the read-modify-write loop for scripts and agents:

```sh
pi-tin container-profile show node-dev --json > p.json
# edit p.json
pi-tin container-profile apply node-dev --dry-run < p.json   # preview the diff, writes nothing
pi-tin container-profile apply node-dev < p.json             # write
```

- The JSON is validated against the container-profile schema before anything is written; invalid input exits with code `2` (`VALIDATION`) and a field-naming message.
- `apply` is a **full replace**, not a merge: the file is rewritten from the JSON object, so any YAML comments (including the managed container-profile header) are dropped. An applied container profile is therefore **user-managed** — pi-tin's default container-profile sync will not overwrite it.
- `--dry-run` prints the diff envelope (`{ "action": "create" | "update", "name", "dryRun": true, "changes": [...] }`) and writes nothing. A real apply prints the result envelope (`{ "action": "created" | "updated", "name", "changes": [...] }`). Each `changes` entry is `{ "path", "kind": "added" | "removed" | "changed", "before"?, "after"? }`. Output is always JSON.

### Editing workspaces

`apply <name>` reads a single JSON object on **stdin** — the same shape that `show --json` emits — and writes it to `~/.config/pi-tin/workspaces/<name>.yaml`. This is the read-modify-write loop for scripts and agents:

```sh
pi-tin show my-workspace --json > w.json
# edit w.json
pi-tin apply my-workspace --dry-run < w.json   # preview the diff, writes nothing
pi-tin apply my-workspace < w.json             # write
```

- The JSON is validated against the workspace schema before anything is written; invalid input exits with code `2` (`VALIDATION`) and a field-naming message.
- `apply` is a **full replace**, not a merge: the file is rewritten from the JSON object, so any YAML comments are dropped.
- `--dry-run` prints the diff envelope (`{ "action": "create" | "update", "name", "dryRun": true, "changes": [...] }`) and writes nothing. A real apply prints the result envelope (`{ "action": "created" | "updated", "name", "changes": [...] }`). Each `changes` entry is `{ "path", "kind": "added" | "removed" | "changed", "before"?, "after"? }`. Output is always JSON.
- `show <name>` exits with code `3` (`NOT_FOUND`) when the workspace does not exist, listing the available workspaces.

## Workspace Lifecycle

Workspaces are **shared-session containers**. `pi-tin open` starts the workspace if needed, or joins the existing workspace if it is already running. Multiple host terminals can connect to the same workspace at the same time, and `pi-tin list` shows session counts plus any pending shutdown countdown.

- **`open`**: Starts the workspace if needed, otherwise joins it. On a fresh start, pi-tin automatically rebuilds the image if the container profile or workspace build config has changed.
- **`open --build`**: Forces an image rebuild on the next fresh start. If the workspace already has active sessions, pi-tin refuses and asks you to stop it first.
- **Bare `pi-tin --build`**: From inside a directory matched by exactly one workspace (or after selecting one from multiple matches), behaves the same as `pi-tin open <workspace> --build`.
- **Rebuild failure**: If a required rebuild fails (for example the machine is offline and the base image or a build step cannot be fetched) and a previously built image exists, pi-tin reports the failure and offers to open the workspace using that older image — your config changes stay unapplied until the next successful rebuild. It aborts instead when there is no previous image to fall back to, or when the session is non-interactive.
- **Last session exit**: When the last host-side `pi-tin open` session closes, pi-tin starts an auto-stop countdown using `stopAfterLastSession` (default `30s`). Reopening during that grace period cancels the pending stop unless a fresh restart is needed to apply config changes.
- **`stop`**: Stops a running workspace immediately.
- **`delete`**: Removes the workspace configuration and its image. It refuses while sessions are still active.

### Opening a directory no workspace includes

When you run `pi-tin` from a directory that no workspace includes, what happens depends on whether any workspaces exist:

- **No workspaces yet**: pi-tin offers to create one.
- **One or more workspaces exist**: pi-tin offers to **create a new workspace** or **add the current directory to an existing one**.

Adding appends the directory to that workspace's `projects` list, preserving your YAML comments and formatting. pi-tin refuses without writing if the directory's basename collides with another project or if adding it would exceed the mount limit.

After the directory is added, the outcome depends on the target workspace's state:

- **Stopped workspace**: it starts immediately with the new project mounted, and you land in that project.
- **Running workspace**: the directory is added to config but is **not** mounted yet — the new project mounts on the workspace's next restart. pi-tin does not reopen it for you. Finish and exit every open session in that workspace, then reopen it (`pi-tin open <name>`) to restart it and mount the project. (Reopening while a session is still active just rejoins it unchanged.)

To add the current directory to a workspace **at any time** — including when it
already matches one (e.g. to also include it in a second workspace, or to fork
it into a new one) — run `pi-tin add`. It shows a picker of the workspaces the
directory is not already in, plus *Create new workspace*. `pi-tin add <name>`
adds it straight to that workspace. The same rules apply: comments are
preserved, a stopped workspace opens with the project mounted, a running one
prints a restart reminder, and an add that would collide on a project name or
exceed the mount limit is refused without writing.

## SSH Agent Forwarding

pi-tin forwards your macOS SSH agent into the container (via `--ssh` on `container run`) instead of mounting `~/.ssh`:

- **Private keys never leave the host.** The container talks to your Mac's SSH agent over a Unix socket; the agent performs each cryptographic operation and returns only the result. The key bytes are never present in the container, so there is nothing to exfiltrate.
- **No configuration.** With `ssh-agent` running on your Mac (the macOS default), Git, scp, and other SSH tools inside the container authenticate transparently.

If you genuinely need keys present in the container, add `~/.ssh` as a custom host mount at creation time — but agent forwarding is recommended.

## Git Authentication

Authentication depends on whether your remotes use SSH or HTTPS URLs.

**SSH remotes** (`git@github.com:...`) work automatically via SSH agent forwarding (above) — no setup.

**HTTPS remotes** (`https://github.com/...`) use the GitHub CLI. The default `node-dev` container profile includes `gh`; with `host.githubCLI: true` set (offered during `pi-tin create`) and a host login (`gh auth login`), pi-tin automatically:

1. Mounts `~/.config/gh` read-only into the container
2. Extracts your token via `gh auth token` at launch
3. Passes it in as `GH_TOKEN`
4. Configures `gh` as the git credential helper

`git pull`, `git push`, and other remote operations then authenticate using your existing GitHub CLI session — no manual login.

> [!WARNING]
> **Custom container profiles:** `host.githubCLI` forwards credentials but does not install the `gh` binary. In a custom container profile, install `gh` (e.g. via `post_install`) or HTTPS git auth will not work.

> [!NOTE]
> `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME`, etc. set during `pi-tin create` control commit identity only — they do not authenticate with remotes.

## Agent Profiles

Agent profiles give your containers isolated, persistent agent identities. Each agent profile is a directory managed by pi-tin that gets mounted into the container as the agent's config directory (e.g., `~/.claude`).

### Why agent profiles?

Agent profiles let you keep separate identities per workspace — one account
for work, another for personal projects, without re-authenticating.

They also solve a macOS-specific problem: some agents, like Claude Code, store
credentials in the macOS Keychain, which isn't available inside Linux
containers. By default each isolated profile gets its own Linux-native
credential store that persists across sessions.

### Setup

Scan your system for installed agents and create agent profiles for them:

```bash
pi-tin agent-profile discover
```

Or create agent profiles manually:

```bash
pi-tin agent-profile add personal --agent "Claude Code"
pi-tin agent-profile add work --agent "Claude Code"
pi-tin agent-profile add my-codex --agent Codex
```

### First use

The first time you open a workspace with a new agent profile, the agent will prompt you to log in inside the container. After that, your credentials persist — every workspace using that agent profile stays authenticated, even across sessions.

### Multi-account

Create separate agent profiles for different accounts:

```bash
pi-tin agent-profile add personal --agent "Claude Code"  # personal account
pi-tin agent-profile add work --agent "Claude Code"      # work account
```

Then assign them to different workspaces via `agent.profiles` in the workspace YAML.

### Host mode

By default an agent profile is **isolated**: pi-tin creates an empty credential store and mounts that copy, so container logins never touch your host config. Passing `--host` instead mounts your **actual host config directory** (e.g. `~/.codex`) straight into the container:

```bash
pi-tin agent-profile add my-codex --agent Codex --host
```

In host mode the container shares your host identity with no separate login, but changes the agent makes inside the container — including credential refreshes — write through to your host config. Use it when you want one identity everywhere; prefer the default isolated mode when you want the container sandboxed from your host.

Host mode is only available for agents whose auth works outside the macOS Keychain. **Claude Code does not support `--host`** (its credentials live in the Keychain, which containers can't reach); Pi, Codex, OpenCode, Amp, and Gemini CLI do. Passing `--host` to an unsupported agent is rejected with an error.

### Sharing agent profiles

Multiple workspaces can share the same agent profile. If workspace A and workspace B both use the `personal` agent profile, logging in from either workspace authenticates both — they share the same credential store.

### Customising agent profiles

Agent profiles start empty and the agent configures itself on first run. If you want to pre-populate custom config (skills, MCP servers, settings files), copy them into the agent profile directory:

```bash
pi-tin agent-profile finder personal   # opens the agent profile directory in Finder
```

Agent profiles live at `~/.config/pi-tin/agent-profiles/<name>/`.

### API key users

If you use API keys rather than OAuth, forward them from your host environment using `${VAR}` syntax in your workspace `host.env` config:

```yaml
host:
  env:
    ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    OPENAI_API_KEY: ${OPENAI_API_KEY}
    OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
```

The `pi-tin create` flow will detect keys in your host environment and offer to add them automatically. Keys are resolved at runtime — nothing secret is stored in the YAML.

### Commands

| Command | Description |
|---------|-------------|
| `pi-tin agent-profile add <name> --agent <agent> [--host] [--json]` | Create a new agent profile (the non-interactive creation path for agent profiles). `--host` mounts your host config directly instead of an isolated copy — see [Host mode](#host-mode). `--json` for machine-readable output; JSON is the default when output is piped |
| `pi-tin agent-profile list [--json]` | List all agent profiles (`--json` for machine-readable output; JSON is the default when output is piped) |
| `pi-tin agent-profile show <name> [--json]` | Show an agent profile (output is always JSON; `--json` is accepted for consistency) |
| `pi-tin agent-profile delete <name> [--force] [--dry-run] [--json]` | Delete an agent profile (`--dry-run` previews the impact, including referencing workspaces; non-interactive callers must pass `--force` or get exit code 4) |
| `pi-tin agent-profile discover` | Scan for agents and create agent profiles |
| `pi-tin agent-profile finder [name]` | Open agent profile directory in Finder |

## Permissions

When a workspace includes Claude Code, pi-tin bakes a `~/.claude.json` into the image marking first-run onboarding complete and fully trusting each mounted project (`projects["/workspace/<name>"]`: `hasTrustDialogAccepted` + `hasTrustDialogHooksAccepted`). Trust must be granted explicitly so Claude Code loads the repo's own `.claude/settings.json` — its `.mcp.json` MCP servers and its hooks in particular, which are gated on workspace trust independently of permission mode (bypass-permissions does not cover them). pi-tin also sets `CLAUDE_CODE_SANDBOXED=1` to signal the container sandbox. Workspaces without Claude Code are unaffected.

Claude Code also runs in bypass-permissions mode by default inside containers, so it won't prompt to read files, run commands, or make edits. Your host installation is unaffected — pi-tin sets this via Claude Code managed settings baked into the image (which also disable Claude Code's inner sandbox — the container is the sandbox), so it survives Claude's self-updates inside the workspace.

To require normal permission prompts instead, set `agent.skipPermissions: false` — then no managed settings are baked and Claude Code's defaults apply:

```yaml
agent:
  skipPermissions: false
```

Gemini CLI workspaces get `NO_BROWSER=true`, so authentication never tries to launch a host browser.

OpenCode workspaces get its `external_directory` permission set to `allow` (via `OPENCODE_CONFIG_CONTENT`, which overrides any project `opencode.json`), so the agent ranges across all mounted projects without prompting — the container is the boundary. OpenCode's other defaults are unchanged: its doom-loop guard and refusal to read `.env` files stay in force.

## Uninstalling

Before uninstalling, you can clean up all container resources:

```bash
pi-tin cleanup           # Remove stopped containers, dangling images, unused volumes, and orphaned pi-tin images
rm -rf ~/.config/pi-tin  # Remove pi-tin config
```

Or do both in one step with `pi-tin cleanup --all` (a full wipe: all pi-tin images, config, and data).

> [!NOTE]
> `cleanup` prunes all Apple `container` resources, not just those created by pi-tin. This is safe — stopped containers, images, and volumes can be re-pulled or rebuilt as needed.

Then uninstall the package:

```bash
npm uninstall -g pi-tin
```

## License

Copyright (C) 2026 dave-tn

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. See [LICENSE](LICENSE) for the full text.
