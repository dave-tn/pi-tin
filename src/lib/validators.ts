import * as v from 'valibot';

// Validation patterns for Dockerfile-interpolated fields
const imageRefPattern = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]*(:[a-zA-Z0-9._-]+)?$/;
const posixUserPattern = /^[a-z_][a-z0-9_-]*$/;
const packageNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/;
const singleLinePattern = /^[^\n\r]+$/;
const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const durationPattern = /^[1-9]\d*[smh]$/;
// Size with an optional K/M/G/T/P suffix (and optional trailing 'b'), e.g. 8g, 512m, 1tb.
// The value must be positive: zero sizes like 0, 0.0, 00, 0b, or 0.0g are
// rejected (the lookahead), while positive fractions like 0.5g stay valid.
const memoryPattern = /^(?!0+(\.0+)?([kmgtp]b?|b)?$)\d+(\.\d+)?([kmgtp]b?|b)?$/i;

const PositiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

const BaseImageSchema = v.pipe(v.string(), v.regex(imageRefPattern));

// Workspace-state entries are home-relative paths used as filesystem targets
// for `container cp` and `container exec`. Config is trusted input, so these
// constraints are robustness, not security: reject a leading '/' or any
// '.'/'..' segment so a path cannot escape the home dir, and keep the charset
// to simple path characters.
const workspaceStatePathSegmentPattern = /^[A-Za-z0-9._-]+$/;
function isWorkspaceStatePath(value: string): boolean {
  return value
    .split('/')
    .every((segment) => segment !== '.' && segment !== '..' && workspaceStatePathSegmentPattern.test(segment));
}
const WorkspaceStatePathSchema = v.pipe(
  v.string(),
  v.check(
    isWorkspaceStatePath,
    'Workspace state paths must be home-relative (e.g. ".zsh_history" or ".local/share/zoxide"): no leading "/", no "." or ".." segments, and only letters, digits, ".", "_", "-".',
  ),
);

export const ContainerProfileSchema = v.strictObject({
  description: v.string(),
  base_image: BaseImageSchema,
  package_manager: v.optional(v.picklist(['apt', 'apk', 'dnf'])),
  user: v.pipe(v.string(), v.regex(posixUserPattern)),
  packages: v.optional(v.array(v.pipe(v.string(), v.regex(packageNamePattern))), []),
  extra_packages: v.optional(v.array(v.pipe(v.string(), v.regex(packageNamePattern))), []),
  global_tools: v.optional(v.array(v.pipe(v.string(), v.minLength(1), v.regex(singleLinePattern))), []),
  post_install: v.optional(v.array(v.pipe(v.string(), v.minLength(1), v.regex(singleLinePattern))), []),
  post_setup: v.optional(v.array(v.pipe(v.string(), v.minLength(1), v.regex(singleLinePattern))), []),
  env: v.optional(v.record(v.pipe(v.string(), v.regex(envKeyPattern)), v.string()), {}),
  cpus: v.optional(PositiveIntegerSchema),
  memory: v.optional(v.pipe(v.string(), v.regex(memoryPattern))),
  workspace_state: v.optional(v.array(WorkspaceStatePathSchema), []),
});

const HostMountSchema = v.strictObject({
  host: v.string(),
  container: v.string(),
  readonly: v.boolean(),
});

const npmPackagePattern = /^[@a-zA-Z0-9][a-zA-Z0-9._\/-]*(@[a-zA-Z0-9._-]+)?$/i;

const ToolSchema = v.strictObject({
  name: v.string(),
  package: v.pipe(v.string(), v.regex(npmPackagePattern)),
});

const AgentSchema = v.strictObject({
  // Defaults to true: container isolation makes it safe to skip permission prompts
  skipPermissions: v.optional(v.boolean(), true),
  profiles: v.optional(v.array(v.string()), []),
});

const HostSchema = v.strictObject({
  sshAgent: v.optional(v.boolean(), true),
  githubCLI: v.optional(v.boolean(), false),
  mounts: v.optional(v.array(HostMountSchema), []),
  // Same key rule as profile env: keys are interpolated into the container
  // runtime environment, so they must be well-formed identifiers.
  env: v.optional(v.record(v.pipe(v.string(), v.regex(envKeyPattern)), v.string()), {}),
});

const TmuxSchema = v.strictObject({
  mode: v.picklist(['host', 'isolated']),
  mountPlugins: v.optional(v.boolean(), false),
});

// Also the valid values for the CLI attach override (`--attach`, `pi-tin
// [shell|herdr]`) — keep the schema and the CLI boundary on one constant.
export const ATTACH_MODES = ['shell', 'herdr'] as const;

/** Narrow a CLI-supplied attach token, or null when it is not a mode. */
export function parseAttachMode(value: string): Workspace['attach'] | null {
  return ATTACH_MODES.find((mode) => mode === value) ?? null;
}

export const WorkspaceSchema = v.strictObject({
  profile: v.string(),
  projects: v.array(v.string()),
  tools: v.optional(v.array(ToolSchema), []),
  agent: v.optional(AgentSchema),
  host: v.optional(HostSchema),
  tmux: v.optional(TmuxSchema),
  // Runs an unprivileged sshd in the workspace; implied by attach: herdr.
  sshd: v.optional(v.boolean(), false),
  attach: v.optional(v.picklist(ATTACH_MODES), 'shell'),
  stopAfterLastSession: v.optional(v.pipe(v.string(), v.regex(durationPattern)), '30s'),
});

// Agent profile metadata (loaded from profile.yaml inside agent profile dirs)
const AgentProfileMetaSchema = v.strictObject({
  agent: v.string(),
  mode: v.pipe(
    v.picklist(['host', 'shared', 'isolated']),
    v.transform((val) => (val === 'shared' ? 'host' as const : val)),
  ),
  mounts: v.array(v.string()),
});

// Schemas for pi-tin's own runtime-state JSON files. These are parse
// boundaries: the files are written by one pi-tin process and read by another,
// so the contents may come from an older build or be corrupted on disk.

export const SessionRecordSchema = v.object({
  sessionId: v.string(),
  startedAt: v.string(),
  hostPid: PositiveIntegerSchema,
  state: v.literal('active'),
  // Process-identity token captured when the session was registered. Guards
  // against OS PID reuse: a different process inheriting hostPid will not match.
  hostToken: v.optional(v.string()),
});

export const RuntimeMetaSchema = v.object({
  startedAt: v.string(),
  buildHash: v.string(),
  runtimeHash: v.string(),
});

export const ShutdownRecordSchema = v.object({
  armedAt: v.string(),
  deadlineMs: PositiveIntegerSchema,
  helperPid: v.optional(PositiveIntegerSchema),
  // Identity token of the helper process, captured when the shutdown was armed.
  helperToken: v.optional(v.string()),
});

export const LockRecordSchema = v.object({
  ownerPid: PositiveIntegerSchema,
  acquiredAt: v.string(),
  // Identity token of the lock owner, captured when the lock was acquired.
  ownerToken: v.optional(v.string()),
});

// Schemas for external JSON (container CLI, GitHub API)

// Stopped containers hold no network attachments, so `networks` must stay
// optional for `container list --all` to keep parsing.
const RawContainerNetworkSchema = v.object({
  ipv4Address: v.optional(v.string()),
});

const RawContainerListEntrySchema = v.object({
  id: v.string(),
  status: v.object({
    state: v.string(),
    networks: v.optional(v.array(RawContainerNetworkSchema), []),
  }),
});

// The wire value is CIDR ("192.168.64.5/24"); consumers want a plain address.
function firstIpv4Address(
  networks: v.InferOutput<typeof RawContainerNetworkSchema>[],
): string | null {
  const cidr = networks.find((network) => network.ipv4Address !== undefined)?.ipv4Address;
  const address = cidr?.split('/')[0];
  return address !== undefined && address !== '' ? address : null;
}

export const ContainerListSchema = v.pipe(
  v.array(RawContainerListEntrySchema),
  v.transform((containers) => containers.map((container) => ({
    id: container.id,
    status: container.status.state,
    ipv4Address: firstIpv4Address(container.status.networks),
  }))),
);

const RawImageListEntrySchema = v.object({
  configuration: v.object({
    name: v.string(),
  }),
});

export const ImageListSchema = v.pipe(
  v.array(RawImageListEntrySchema),
  v.transform((images) => images.map((image) => image.configuration.name)),
);

const ContainerSystemVersionEntrySchema = v.object({
  appName: v.string(),
  version: v.string(),
});

export const ContainerSystemVersionSchema = v.array(ContainerSystemVersionEntrySchema);

// `container system status --format json` payload. On failure the CLI reports
// { "status": "not running" | "unregistered" }; keep the field a plain string
// so unknown future statuses parse and the caller decides what they mean.
export const ContainerSystemStatusSchema = v.object({
  status: v.string(),
});

// `herdr agent list --json` payload, from inside a workspace container.
// Deliberately loose — only the per-agent status string matters, herdr's
// schema is not pinned by pi-tin, and any parse failure downgrades the
// auto-stop query to 'unavailable' (which stops).
// `herdr agent list` (verified live, herdr 0.7.x) already emits JSON — there
// is no --json flag — shaped { result: { agents: [{ agent_status }] } }, where
// agent_status is one of idle | working | blocked | done | unknown.
const HerdrAgentEntrySchema = v.pipe(
  v.object({ agent_status: v.optional(v.string()) }),
  v.transform((entry) => ({ status: entry.agent_status ?? null })),
);
export const HerdrAgentListSchema = v.pipe(
  v.object({ result: v.object({ agents: v.array(HerdrAgentEntrySchema) }) }),
  v.transform((payload) => payload.result.agents),
);

const GitHubAssetSchema = v.object({
  name: v.optional(v.string()),
  browser_download_url: v.optional(v.string()),
});

export const GitHubReleaseSchema = v.object({
  assets: v.array(GitHubAssetSchema),
});

export type ContainerProfile = v.InferOutput<typeof ContainerProfileSchema>;
export type HostMount = v.InferOutput<typeof HostMountSchema>;
export type Tool = v.InferOutput<typeof ToolSchema>;
export type AgentProfileMeta = v.InferOutput<typeof AgentProfileMetaSchema>;
export type Workspace = v.InferOutput<typeof WorkspaceSchema>;
export type SessionRecord = v.InferOutput<typeof SessionRecordSchema>;
export type RuntimeMeta = v.InferOutput<typeof RuntimeMetaSchema>;
export type ShutdownRecord = v.InferOutput<typeof ShutdownRecordSchema>;
export type LockRecord = v.InferOutput<typeof LockRecordSchema>;
export type ListedContainer = v.InferOutput<typeof ContainerListSchema>[number];

function parseWithContext<T>(
  context: string,
  schema: v.GenericSchema<unknown, T>,
  raw: unknown,
): T {
  try {
    return v.parse(schema, raw);
  } catch (error) {
    if (error instanceof v.ValiError) {
      const issues = v.flatten(error.issues);
      const rootDetails = [...(issues.root ?? []), ...(issues.other ?? [])].map(
        (message) => `  ${message}`,
      );
      const nestedDetails = Object.entries(issues.nested ?? {}).map(([field, msgs]) => {
        const messages = Array.isArray(msgs) ? msgs.join(', ') : 'unknown error';
        return `  ${field}: ${messages}`;
      });
      const details = [...rootDetails, ...nestedDetails].join('\n');
      throw new Error(`Invalid ${context} configuration:\n${details}`);
    }
    throw error;
  }
}

export function validateContainerProfile(raw: unknown): ContainerProfile {
  return parseWithContext('container profile', ContainerProfileSchema, raw);
}

export function validateWorkspace(raw: unknown): Workspace {
  return parseWithContext('workspace', WorkspaceSchema, raw);
}

export function validateAgentProfileMeta(raw: unknown): AgentProfileMeta {
  return parseWithContext('agent profile', AgentProfileMetaSchema, raw);
}

// npm dist-tags response: GET https://registry.npmjs.org/-/package/pi-tin/dist-tags
// Non-strict: npm returns other tags (beta, next, …) we deliberately ignore.
export const NpmDistTagsSchema = v.object({ latest: v.string() });

// On-disk update-check cache (written by the detached checker, read on startup).
export const UpdateCheckCacheSchema = v.object({
  lastCheckMs: v.number(),
  latestVersion: v.string(),
});
export type UpdateCheckCache = v.InferOutput<typeof UpdateCheckCacheSchema>;
