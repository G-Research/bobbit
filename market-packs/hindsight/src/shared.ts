// Internal shared helpers for the Hindsight pack SERVER modules (provider +
// routes). This file is NOT a standalone build entry: it is imported by
// `provider.ts` and `routes.ts` and esbuild INLINES it into lib/provider.mjs and
// lib/routes.mjs (scripts/build-market-packs.mjs). copy-builtin-packs ships only
// lib/, never src/, so this never reaches disk as a separate module.
//
// The REST client (`./hindsight-client.js`) is reached through a DYNAMIC import in
// `makeClient` so:
//   1. esbuild inlines the client into each single-file bundle (RULE 2), and
//   2. unit tests can inject a fake client via `__setClientFactory` WITHOUT the
//      client module being present (the dynamic import is never executed when an
//      override is installed) — the provider/routes own no client source.

// ── Client contract (structural — declared locally to avoid a static dependency
//    on the client module; the real client satisfies this exactly, see
//    docs/design/hindsight-pack-external.md §3). ──
export type Tags = Record<string, string>;
export type TagsMatch = "any" | "all" | "any_strict" | "all_strict";

/** Tag-match mode for a PROJECT-scoped recall/reflect on the single shared bank.
 *  Per the Hindsight recall API, `"any"` means "OR, INCLUDES untagged": it returns
 *  memories tagged with this project AND untagged/global memories, while STILL
 *  excluding other projects' tagged memories. That is exactly the shared
 *  tag-scoped bank design — project scope = this project + global, never another
 *  project. (`"any_strict"` is "OR, EXCLUDES untagged"; we deliberately do NOT use
 *  it, which would drop global memories from a project recall.) */
export const PROJECT_RECALL_TAGS_MATCH: TagsMatch = "any";

/** Hindsight fact types (recall `types` filter). Biasing recall toward consolidated
 *  `observation`s (plus `world`/`experience`) returns deduped knowledge over raw
 *  per-turn chatter. */
export type RecallType = "observation" | "world" | "experience";
export const RECALL_TYPES: readonly RecallType[] = ["observation", "world", "experience"];

/** Resolve the recall/reflect tag filter for a deployment scope on the single
 *  shared bank (the single source of truth shared by the provider auto-recall and
 *  the `recall`/`reflect` routes):
 *   - `project` scope WITH a real project id, NO extra tags ⇒ `{ project:<id> }`
 *     matched with `tagsMatch` (default `any` = project-tagged PLUS untagged/global;
 *     `any_strict` = project-only, EXCLUDING global — a rare opt-in).
 *   - `project` scope WITH extra tags ⇒ the extra tags NARROW the recall: require
 *     the project tag AND every extra tag, EXCLUDING untagged/global (`all_strict`).
 *     This never broadens past the current project — an extra tag (e.g. `goal:g`)
 *     can NOT pull in untagged/global memories nor OTHER projects that merely share
 *     that tag. The route-derived project tag is AUTHORITATIVE: an extra `project`
 *     tag can NEVER override it (it is dropped). Compound boolean queries are a
 *     direct-API escape hatch only (no `tag_groups` is ever exposed to tools).
 *   - `scope: all` (or no project id): NO fabricated project tag. An explicit
 *     `extraTags` filter (a simple targeted cross-project/goal query) is still
 *     applied additively, with `any` so global/untagged stays visible. */
export function recallTagFilter(
	scope: "project" | "all",
	projectId: string | undefined,
	tagsMatch: TagsMatch = PROJECT_RECALL_TAGS_MATCH,
	extraTags?: Tags,
): { tags: Tags; tagsMatch: TagsMatch } | undefined {
	const pid = typeof projectId === "string" && projectId.trim().length > 0 ? projectId.trim() : undefined;
	const extra = extraTags && Object.keys(extraTags).length > 0 ? { ...extraTags } : undefined;
	if (scope === "project" && pid) {
		// The route-derived project tag is AUTHORITATIVE: drop any extra `project` so a
		// caller-supplied tag can never override the current project.
		const rest = { ...(extra ?? {}) };
		delete rest.project;
		if (Object.keys(rest).length > 0) {
			// Extra tags NARROW: require project AND every extra tag, EXCLUDE untagged/
			// global (all_strict). Replaces the old `any`-merge that broadened recall to
			// untagged/global AND other-project memories sharing an extra tag.
			return { tags: { project: pid, ...rest }, tagsMatch: "all_strict" };
		}
		return { tags: { project: pid }, tagsMatch };
	}
	if (extra) return { tags: extra, tagsMatch: "any" };
	return undefined;
}

export interface RecallMemory {
	text: string;
	score?: number;
	id?: string;
}

/** Bank-config mission updates (snake_case to mirror the Hindsight REST API
 *  `PATCH …/banks/{bank}/config` body `{ updates: {...} }`). */
export interface BankMissionUpdates {
	retain_mission?: string;
	observations_mission?: string;
	reflect_mission?: string;
}

export interface HindsightClientLike {
	health(): Promise<{ ok: boolean }>;
	ensureBank(bank: string): Promise<void>;
	recall(
		bank: string,
		query: string,
		opts?: { maxTokens?: number; tags?: Tags; tagsMatch?: TagsMatch; types?: RecallType[] },
	): Promise<{ memories: RecallMemory[] }>;
	retain(bank: string, content: string, opts?: { tags?: Tags; sync?: boolean }): Promise<void>;
	reflect(bank: string, prompt: string, opts?: { tags?: Tags; tagsMatch?: TagsMatch }): Promise<{ text: string }>;
	listBanks(): Promise<{ banks: string[] }>;
	/** Idempotent bank-config mission update (PATCH …/config). Optional so unit-test
	 *  fakes need not implement it; {@link applyBankMission} no-ops when absent. */
	updateBankConfig?(bank: string, updates: BankMissionUpdates): Promise<void>;
}

export interface ClientConfig {
	baseUrl: string;
	apiKey?: string;
	namespace?: string;
	timeoutMs?: number;
}

// ── Managed-runtime context (P3) ───────────────────────────────────────────────
// Injected by the host (lifecycle hub) for ACTIVE managed Hindsight provider
// invocations only. `baseUrl` points at the locally-running managed Hindsight API
// (`http://127.0.0.1:<api-port>`); `headers` mirrors the apiKey-derived auth the
// client also builds; `status` is the supervisor's runtime state. Absent in
// external mode and whenever the managed runtime is not running — the provider
// stays dormant in that case (it NEVER starts Docker itself).
export interface RuntimeContext {
	baseUrl: string;
	headers?: Record<string, string>;
	status?: string;
}

/** The deployment modes that are backed by a Bobbit-managed Docker runtime
 *  (Hindsight API/web, with managed or external Postgres). External mode keeps
 *  the unchanged operator-supplied data-plane URL path. */
export function isManagedMode(mode: string): boolean {
	return mode === "managed" || mode === "managed-external-postgres";
}

/** Map a deployment `mode` onto the runtime descriptor's launch mode key
 *  (market-packs/hindsight/runtimes/hindsight.yaml::modes). `managed` brings up a
 *  managed Postgres (`managed-postgres`); `managed-external-postgres` omits the
 *  `db` service and injects HINDSIGHT_API_DATABASE_URL (`external-postgres`).
 *  External mode launches no runtime ⇒ undefined. This is the single source of
 *  truth for the config-mode → runtime-mode mapping the host's enable action uses. */
export function runtimeModeFor(mode: string): "managed-postgres" | "external-postgres" | undefined {
	if (mode === "managed") return "managed-postgres";
	if (mode === "managed-external-postgres") return "external-postgres";
	return undefined;
}

export type ClientFactory = (cfg: ClientConfig) => HindsightClientLike | Promise<HindsightClientLike>;

let clientFactoryOverride: ClientFactory | null = null;

/** TEST SEAM: install a fake client factory (unit tests). Pass `null` to restore
 *  the real dynamic-import factory. Never used in production (the worker reloads
 *  the module per hook and never calls this). */
export function __setClientFactory(fn: ClientFactory | null): void {
	clientFactoryOverride = fn;
}

export async function makeClient(cfg: ClientConfig): Promise<HindsightClientLike> {
	if (clientFactoryOverride) return clientFactoryOverride(cfg);
	const mod = (await import("./hindsight-client.js")) as { createClient: (c: ClientConfig) => HindsightClientLike };
	return mod.createClient(cfg);
}

// ── Effective configuration ──────────────────────────────────────────────────
export interface EffectiveConfig {
	mode: string;
	externalUrl?: string;
	/** Optional human-facing Hindsight dashboard URL. Purely informational: it is
	 *  display/open-only (used by "Open Hindsight UI"), NEVER dialed by the client and
	 *  NEVER influences activation/dormancy (which stay keyed on externalUrl). Not a
	 *  secret. */
	uiUrl?: string;
	apiKey?: string;
	/** External Postgres connection URL for `managed-external-postgres` mode. Maps
	 *  onto the runtime env HINDSIGHT_API_DATABASE_URL; never used in external mode. */
	externalDatabaseUrl?: string;
	/** LLM API key the MANAGED Hindsight API uses. Maps onto the runtime env
	 *  HINDSIGHT_API_LLM_API_KEY (the runtime's only user-configured secret); never
	 *  used by the provider client itself, only forwarded to the managed runtime. */
	llmApiKey?: string;
	/** Host bind-mount path for fully managed Postgres data (`managed` mode). */
	dataDir: string;
	bank: string;
	namespace: string;
	recallScope: "project" | "all";
	/** Tag-match mode for a PROJECT-scoped recall/reflect: `any` = project + global
	 *  (the default; never hides shared/global memory); `any_strict` = project-only,
	 *  EXCLUDING global (a rare opt-in for true isolation). */
	tagsMatch: "any" | "any_strict";
	autoRecall: boolean;
	autoRetain: boolean;
	/** Auto-retain BATCH size: hold compact turn summaries in a durable per-session
	 *  buffer and flush ONE aggregate retain (containing all pending turns) once the
	 *  buffer reaches N turns (cost lever — `1` ≈ the old per-turn behavior). NOTHING
	 *  is dropped: turns are batched, never sampled. `beforeCompact` flushes the
	 *  buffer synchronously regardless so the about-to-be-lost span is never lost. */
	retainEveryNTurns: number;
	/** Hook-observed max age (ms) of the OLDEST pending buffered turn before it is
	 *  flushed even though the batch is not full. A later hook observing a pending
	 *  buffer older than this flushes it (no unreliable provider-local timers).
	 *  `0` disables the time-based flush (count-only). */
	retainMaxDelayMs: number;
	/** How many of the just-flushed turn summaries to carry forward as OVERLAP
	 *  context into the next aggregate (thread continuity across batches). The
	 *  primary pending turns are cleared after each flush so the count always
	 *  advances; overlap is bounded by this value so it never grows unbounded. */
	retainOverlapTurns: number;
	recallBudget: number;
	/** Hindsight recall `types` filter — bias recall toward consolidated knowledge.
	 *  Default favours `observation` plus `world`/`experience`. */
	recallTypes: RecallType[];
	/** Bank-config missions applied to the shared bank (steer extraction/observation/
	 *  reflection toward durable knowledge, away from transient noise). */
	retainMission: string;
	observationsMission: string;
	reflectMission: string;
	/** Max characters of the recall QUERY sent to the data plane. The Hindsight
	 *  recall API caps queries at 500 tokens and returns HTTP 400 ("Query too long")
	 *  for longer queries; clamping the query keeps non-trivial turns working.
	 *  Mirrors Hermes' `recall_max_input_chars`. `<= 0` disables clamping. */
	recallMaxInputChars: number;
	timeoutMs: number;
}

/** Durable-knowledge bank missions — steer Hindsight extraction/consolidation/
 *  reflection toward preferences, decisions, conventions, architecture, and lasting
 *  project state, and away from transient noise. Configurable via config overrides. */
export const DEFAULT_RETAIN_MISSION =
	"Capture durable, reusable knowledge: user and team preferences, decisions and their rationale, conventions, standards, architecture, and lasting project state. Ignore transient noise — stack traces, PIDs, timestamps, one-off command output, failed attempts, greetings, and routine per-turn chatter — unless it records a decision or changes project state.";
export const DEFAULT_OBSERVATIONS_MISSION =
	"Observations are stable, durable facts about the people and projects in this bank: preferences, conventions, recurring decisions, architecture, and project state. Consolidate repeated facts into general, reusable statements. Ignore one-off events, ephemeral state, and transient per-turn details.";
export const DEFAULT_REFLECT_MISSION =
	"You are a long-term engineering memory for this team. Ground answers in documented decisions, preferences, conventions, and project state, drawing on consolidated observations rather than raw per-turn chatter. Be direct and precise; do not speculate or resurface transient noise.";

/** Flat defaults — the single source of truth mirrored by providers/memory.yaml. */
export const CONFIG_DEFAULTS: EffectiveConfig = {
	mode: "external",
	dataDir: "~/.hindsight",
	bank: "bobbit",
	namespace: "default",
	recallScope: "project",
	tagsMatch: "any",
	autoRecall: true,
	autoRetain: true,
	retainEveryNTurns: 5,
	retainMaxDelayMs: 1_800_000,
	retainOverlapTurns: 2,
	recallBudget: 1200,
	recallTypes: [...RECALL_TYPES],
	retainMission: DEFAULT_RETAIN_MISSION,
	observationsMission: DEFAULT_OBSERVATIONS_MISSION,
	reflectMission: DEFAULT_REFLECT_MISSION,
	recallMaxInputChars: 3000,
	timeoutMs: 1500,
};

function isObj(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Read one config key, tolerating BOTH a flat value (post-loader-merge — the
 *  expected shape) AND a `{ type, default }` schema descriptor (an un-amended
 *  loader passing providers/memory.yaml verbatim). This keeps the provider's
 *  dormancy gate correct regardless of host loader state. */
function flat(raw: unknown, key: string): unknown {
	if (!isObj(raw)) return undefined;
	const v = raw[key];
	if (isObj(v) && "default" in v) return (v as Record<string, unknown>).default;
	return v;
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asBool(v: unknown, d: boolean): boolean {
	return typeof v === "boolean" ? v : d;
}
function asNum(v: unknown, d: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function isRecallType(v: unknown): v is RecallType {
	return v === "observation" || v === "world" || v === "experience";
}
/** Parse a recall `types` array; falls back to the default when absent/invalid. */
function asRecallTypes(v: unknown, d: RecallType[]): RecallType[] {
	if (!Array.isArray(v)) return [...d];
	const valid = v.filter(isRecallType);
	return valid.length > 0 ? [...new Set(valid)] : [...d];
}

export function resolveConfig(raw: unknown): EffectiveConfig {
	const externalUrl = asString(flat(raw, "externalUrl"));
	const uiUrl = asString(flat(raw, "uiUrl"));
	const apiKey = asString(flat(raw, "apiKey"));
	const externalDatabaseUrl = asString(flat(raw, "externalDatabaseUrl"));
	const llmApiKey = asString(flat(raw, "llmApiKey"));
	// Default scope is now `project` (project + global via tags_match `any`); only an
	// explicit `all` opts into whole-bank recall.
	const recallScope = flat(raw, "recallScope") === "all" ? "all" : "project";
	const tagsMatch = flat(raw, "tagsMatch") === "any_strict" ? "any_strict" : "any";
	const retainEveryNTurns = Math.max(1, Math.floor(asNum(flat(raw, "retainEveryNTurns"), CONFIG_DEFAULTS.retainEveryNTurns)));
	const retainMaxDelayMs = Math.max(0, Math.floor(asNum(flat(raw, "retainMaxDelayMs"), CONFIG_DEFAULTS.retainMaxDelayMs)));
	const retainOverlapTurns = Math.max(0, Math.floor(asNum(flat(raw, "retainOverlapTurns"), CONFIG_DEFAULTS.retainOverlapTurns)));
	return {
		mode: asString(flat(raw, "mode")) ?? CONFIG_DEFAULTS.mode,
		...(externalUrl ? { externalUrl } : {}),
		...(uiUrl ? { uiUrl } : {}),
		...(apiKey ? { apiKey } : {}),
		...(externalDatabaseUrl ? { externalDatabaseUrl } : {}),
		...(llmApiKey ? { llmApiKey } : {}),
		dataDir: asString(flat(raw, "dataDir")) ?? CONFIG_DEFAULTS.dataDir,
		bank: asString(flat(raw, "bank")) ?? CONFIG_DEFAULTS.bank,
		namespace: asString(flat(raw, "namespace")) ?? CONFIG_DEFAULTS.namespace,
		recallScope,
		tagsMatch,
		autoRecall: asBool(flat(raw, "autoRecall"), CONFIG_DEFAULTS.autoRecall),
		autoRetain: asBool(flat(raw, "autoRetain"), CONFIG_DEFAULTS.autoRetain),
		retainEveryNTurns,
		retainMaxDelayMs,
		retainOverlapTurns,
		recallBudget: asNum(flat(raw, "recallBudget"), CONFIG_DEFAULTS.recallBudget),
		recallTypes: asRecallTypes(flat(raw, "recallTypes"), CONFIG_DEFAULTS.recallTypes),
		retainMission: asString(flat(raw, "retainMission")) ?? CONFIG_DEFAULTS.retainMission,
		observationsMission: asString(flat(raw, "observationsMission")) ?? CONFIG_DEFAULTS.observationsMission,
		reflectMission: asString(flat(raw, "reflectMission")) ?? CONFIG_DEFAULTS.reflectMission,
		recallMaxInputChars: asNum(flat(raw, "recallMaxInputChars"), CONFIG_DEFAULTS.recallMaxInputChars),
		timeoutMs: asNum(flat(raw, "timeoutMs"), CONFIG_DEFAULTS.timeoutMs),
	};
}

// ── Token-safe recall-query clamp ─────────────────────────────────────────────
//
// Hindsight caps the recall QUERY at 500 tokens and returns
// `HTTP 400 {"detail":"Query too long: <N> tokens exceeds maximum of 500..."}`.
// The configured `recallMaxInputChars` (default 3000) is a CHAR limit, but ~3000
// dense chars ≈ 1400+ tokens ⇒ still 400. The char clamp is the wrong unit, so we
// ALWAYS enforce a hard token-safe CHARACTER ceiling derived from the token cap —
// regardless of the configured char value (even when char-clamping is "disabled").
//
// Ratio rationale: real recall queries are natural-language turn text, which runs
// ~4–6 chars/token (a live 9200-char query measured ~5.75 chars/token against the
// data plane). We deliberately use a CONSERVATIVE 3.5 chars/token — below realistic
// prose — and target ~450 tokens (headroom below the 500 hard cap). 450 tokens ×
// 3.5 chars/token ≈ 1575 ⇒ a 1600-char ceiling sits comfortably under 500 tokens
// (1600 ÷ 3.5 ≈ 457 tokens) even for denser-than-estimated text.
/** Hindsight's hard recall-query token cap (HTTP 400 "Query too long" above it). */
export const RECALL_QUERY_TOKEN_CAP = 500;
/** Conservative chars/token estimate (below realistic ~4–6 prose) used to convert
 *  the token cap into a character ceiling. */
export const RECALL_QUERY_CHARS_PER_TOKEN = 3.5;
/** Hard token-safe CHARACTER ceiling for the recall query, ALWAYS enforced
 *  regardless of `recallMaxInputChars`. 1600 chars ÷ 3.5 ≈ 457 tokens — under the
 *  500-token cap with headroom (see the block comment above for the derivation). */
export const RECALL_QUERY_SAFE_CHAR_CEILING = 1600;

/** Clamp a recall QUERY so it can NEVER trip the data plane's 500-token "Query too
 *  long" 400. Trims first, then slices to the SMALLER of the configured `maxChars`
 *  char clamp (when `maxChars > 0`) and the hard {@link RECALL_QUERY_SAFE_CHAR_CEILING}
 *  token-safe ceiling. The token-safe ceiling is enforced even when char-clamping is
 *  disabled (`maxChars <= 0` / non-finite) — the query stays under the token cap
 *  regardless of the configured value. Pure; never throws. */
export function clampRecallQuery(query: string, maxChars: number): string {
	const trimmed = (query ?? "").trim();
	const charClamp = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : Number.POSITIVE_INFINITY;
	const effective = Math.min(charClamp, RECALL_QUERY_SAFE_CHAR_CEILING);
	return trimmed.length <= effective ? trimmed : trimmed.slice(0, effective);
}

/** Classify a recall failure as the data plane's 500-token "Query too long" 400 —
 *  a SOFT skip, not a real error. Hindsight returns
 *  `HTTP 400 {"detail":"Query too long: <N> tokens exceeds maximum of 500..."}`.
 *  Even with {@link clampRecallQuery} this is defence in depth: if it ever fires,
 *  recall returns empty for the turn and the provider/route does NOT record it as a
 *  sticky `lastError` (it clears any prior one), so the marketplace/panel banner can
 *  never reappear from this cause. Genuine failures (network/5xx/timeout, and other
 *  4xx such as auth) are unaffected and still surface.
 *
 *  Detected STRUCTURALLY (no static dependency on the client's `HindsightError`):
 *  `kind:"http"` + `status:400` + a "too long"/"query" message (the client surfaces
 *  the upstream `detail` body in the error message). */
export function isQueryTooLongError(e: unknown): boolean {
	if (!e || typeof e !== "object") return false;
	const err = e as { kind?: unknown; status?: unknown; message?: unknown };
	if (err.kind !== "http" || err.status !== 400) return false;
	const msg = typeof err.message === "string" ? err.message.toLowerCase() : "";
	return msg.includes("too long") || msg.includes("query");
}

/** The dormancy gate (the central invariant): the provider runs a hook's work
 *  ONLY when active; inactive ⇒ every hook is a no-op and no client is constructed.
 *
 *  - External mode: active ONLY with a non-empty `externalUrl` (unchanged).
 *  - Managed modes: active ONLY when the host injected a running managed runtime
 *    (`runtime.baseUrl` present and `status` not stopped/unhealthy/starting). The
 *    provider NEVER starts Docker — an absent/stopped/unhealthy runtime simply
 *    keeps it dormant, so recall yields no blocks and retains queue. */
export function isActive(cfg: EffectiveConfig, runtime?: RuntimeContext): boolean {
	if (cfg.mode === "external") {
		return typeof cfg.externalUrl === "string" && cfg.externalUrl.trim().length > 0;
	}
	if (isManagedMode(cfg.mode)) {
		if (!runtime || typeof runtime.baseUrl !== "string" || runtime.baseUrl.trim().length === 0) return false;
		// Defensive: only a running runtime serves recall/retain. A known
		// stopped/unhealthy/starting/docker-unavailable status keeps us dormant; an
		// unspecified status is tolerated (treated as reachable).
		return runtime.status === undefined || runtime.status === "running";
	}
	return false;
}

/** The routes' "configured" surface (no runtime context available). External mode
 *  needs a URL; a managed mode is "configured" once the user selects it — runtime
 *  health is a separate, runtime-context-gated concern surfaced via `isActive`. */
export function isConfigured(cfg: EffectiveConfig): boolean {
	if (cfg.mode === "external") {
		return typeof cfg.externalUrl === "string" && cfg.externalUrl.trim().length > 0;
	}
	return isManagedMode(cfg.mode);
}

/** Build the REST client config for the effective deployment mode. Managed modes
 *  ignore `externalUrl` and dial the host-injected managed runtime base URL;
 *  external mode keeps the operator-supplied URL. The apiKey (when set) drives the
 *  client's own `Authorization` header, mirroring `runtime.headers`. */
export function clientConfig(cfg: EffectiveConfig, runtime?: RuntimeContext): ClientConfig {
	const base = isManagedMode(cfg.mode) ? (runtime?.baseUrl ?? "") : (cfg.externalUrl ?? "");
	return {
		baseUrl: base.replace(/\/+$/, ""),
		...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
		namespace: cfg.namespace,
		timeoutMs: cfg.timeoutMs,
	};
}

// ── Pack-store helpers (shared by provider + routes; same pack-scoped store). ──
export interface StoreLike {
	get<T = unknown>(key: string): Promise<T | null>;
	put<T = unknown>(key: string, value: T): Promise<void>;
	list?(prefix?: string): Promise<string[]>;
}

export interface QueueEntry {
	content: string;
	tags: Tags;
	ts: number;
	/** Target bank captured at ENQUEUE time so a retry always replays into the bank
	 *  the retain was originally routed to — never the next hook's (possibly
	 *  per-project-overridden) `cfg.bank`. Optional for backward compat with entries
	 *  queued before this field existed (drain falls back to the current cfg). */
	bank?: string;
	/** Target namespace captured at ENQUEUE time (mirrors {@link bank}). */
	namespace?: string;
}

export const QUEUE_KEY = "retain-queue";
export const LAST_ERROR_KEY = "last-error";
// Must match src/server/agent/pack-contributions.ts::providerConfigStoreKey("memory").
// The host overlays this key over provider yaml defaults and evaluates
// activation.requiresConfig against it before bridge injection.
export const CONFIG_KEY = "provider-config:memory";
/** Per-project config overlay key prefix (pack-managed, same pack store). The
 *  overlay holds memory-quality keys only and layers OVER the global CONFIG_KEY. */
export const PROJECT_CONFIG_KEY_PREFIX = "provider-config:memory:project:";
/** Last-applied bank-mission signature cache prefix (one per namespace:bank). */
export const BANK_CONFIG_APPLIED_PREFIX = "bank-config-applied:";
/** Durable per-session auto-retain PENDING BUFFER prefix (holds the compact turn
 *  summaries awaiting an aggregate flush — batching, never sampling). */
export const RETAIN_PENDING_PREFIX = "retain-pending:";
export const QUEUE_CAP = 100;

export function projectConfigKey(projectId: string): string {
	return `${PROJECT_CONFIG_KEY_PREFIX}${projectId}`;
}

export async function loadQueue(store: StoreLike): Promise<QueueEntry[]> {
	try {
		const v = await store.get<QueueEntry[]>(QUEUE_KEY);
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

export async function saveQueue(store: StoreLike, q: QueueEntry[]): Promise<void> {
	try {
		await store.put(QUEUE_KEY, q);
	} catch {
		/* best-effort durable queue */
	}
}

/** Append a failed retain; FIFO-evict the oldest beyond the cap (100). */
export async function enqueueRetain(store: StoreLike, entry: QueueEntry): Promise<void> {
	const q = await loadQueue(store);
	q.push(entry);
	while (q.length > QUEUE_CAP) q.shift();
	await saveQueue(store, q);
}

export async function recordError(store: StoreLike, e: unknown): Promise<void> {
	try {
		await store.put(LAST_ERROR_KEY, { message: messageOf(e), ts: Date.now() });
	} catch {
		/* diagnostics are non-fatal */
	}
}

/** Clear the sticky `lastError` after a SUCCESSFUL data-plane operation so a
 *  transient failure (e.g. a since-fixed "Query too long" 400) does not show
 *  stickily in the marketplace row / panel. Best-effort; never throws and is
 *  NEVER called on failure. */
export async function clearError(store: StoreLike): Promise<void> {
	try {
		await store.put(LAST_ERROR_KEY, null);
	} catch {
		/* diagnostics are non-fatal */
	}
}

export function messageOf(e: unknown): string {
	if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
	return String(e);
}

export function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ── Config validation (routes `config` SET). ──────────────────────────────────
export interface ConfigValidation {
	ok: boolean;
	value?: Record<string, unknown>;
	errors?: string[];
}

/** Validate a partial config override against the providers/memory.yaml schema.
 *  Only provided + valid keys are returned in `value`; unknown keys are ignored.
 *  An empty string clears an optional string (externalUrl/apiKey). */
export function validateConfigOverrides(body: unknown): ConfigValidation {
	if (!isObj(body)) return { ok: false, errors: ["body must be an object"] };
	const errors: string[] = [];
	const value: Record<string, unknown> = {};

	if ("mode" in body) {
		if (body.mode === "external" || body.mode === "managed" || body.mode === "managed-external-postgres") value.mode = body.mode;
		else errors.push("mode must be 'external', 'managed', or 'managed-external-postgres'");
	}
	// Optional secret/string fields; "" (or null) clears.
	for (const key of ["externalUrl", "apiKey", "externalDatabaseUrl", "llmApiKey"] as const) {
		if (key in body) {
			const v = body[key];
			if (typeof v === "string") value[key] = v; // "" clears
			else if (v === null) value[key] = "";
			else errors.push(`${key} must be a string`);
		}
	}
	// Optional NON-secret dashboard URL; "" (or null) clears. When non-empty it must
	// parse as an http(s) URL (it is opened by the UI, never dialed by the client).
	if ("uiUrl" in body) {
		const v = body.uiUrl;
		if (v === null || v === "") value.uiUrl = "";
		else if (typeof v === "string") {
			let parsed: URL | undefined;
			try {
				parsed = new URL(v);
			} catch {
				parsed = undefined;
			}
			if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) value.uiUrl = v;
			else errors.push("uiUrl must be an http(s) URL");
		} else errors.push("uiUrl must be a string");
	}
	for (const key of ["bank", "namespace", "dataDir"] as const) {
		if (key in body) {
			const v = body[key];
			if (typeof v === "string" && v.trim().length > 0) value[key] = v.trim();
			else errors.push(`${key} must be a non-empty string`);
		}
	}
	if ("recallScope" in body) {
		if (body.recallScope === "project" || body.recallScope === "all") value.recallScope = body.recallScope;
		else errors.push("recallScope must be 'project' or 'all'");
	}
	if ("tagsMatch" in body) {
		if (body.tagsMatch === "any" || body.tagsMatch === "any_strict") value.tagsMatch = body.tagsMatch;
		else errors.push("tagsMatch must be 'any' or 'any_strict'");
	}
	if ("recallTypes" in body) {
		const v = body.recallTypes;
		if (Array.isArray(v) && v.length > 0 && v.every(isRecallType)) value.recallTypes = [...new Set(v)];
		else errors.push("recallTypes must be a non-empty array of 'observation'|'world'|'experience'");
	}
	// Configurable bank-mission strings ("" keeps the default — see resolveConfig).
	for (const key of ["retainMission", "observationsMission", "reflectMission"] as const) {
		if (key in body) {
			if (typeof body[key] === "string") value[key] = body[key];
			else errors.push(`${key} must be a string`);
		}
	}
	for (const key of ["autoRecall", "autoRetain"] as const) {
		if (key in body) {
			if (typeof body[key] === "boolean") value[key] = body[key];
			else errors.push(`${key} must be a boolean`);
		}
	}
	if ("retainEveryNTurns" in body) {
		const v = body.retainEveryNTurns;
		if (typeof v === "number" && Number.isFinite(v) && v >= 1) value.retainEveryNTurns = Math.floor(v);
		else errors.push("retainEveryNTurns must be a number >= 1");
	}
	if ("retainMaxDelayMs" in body) {
		const v = body.retainMaxDelayMs;
		if (typeof v === "number" && Number.isFinite(v) && v >= 0) value.retainMaxDelayMs = Math.floor(v);
		else errors.push("retainMaxDelayMs must be a number >= 0 (0 disables the time-based flush)");
	}
	if ("retainOverlapTurns" in body) {
		const v = body.retainOverlapTurns;
		if (typeof v === "number" && Number.isFinite(v) && v >= 0) value.retainOverlapTurns = Math.floor(v);
		else errors.push("retainOverlapTurns must be a number >= 0");
	}
	for (const key of ["recallBudget", "recallMaxInputChars", "timeoutMs"] as const) {
		if (key in body) {
			const v = body[key];
			if (typeof v === "number" && Number.isFinite(v) && v > 0) value[key] = v;
			else errors.push(`${key} must be a positive number`);
		}
	}

	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Validate a PER-PROJECT config overlay. Only memory-quality keys may be set per
 *  project (`recallScope`, `bank`, `tagsMatch`, `recallBudget`, `recallTypes`); a
 *  project overlay can NEVER change `mode`, `externalUrl`, secrets, or runtime
 *  deployment (those stay server-global). A key set to `null`/`""` is cleared
 *  (omitted from the result), so a full overlay write replaces the stored one. */
export function validateProjectOverride(body: unknown): ConfigValidation {
	if (!isObj(body)) return { ok: false, errors: ["projectOverride must be an object"] };
	const errors: string[] = [];
	const value: Record<string, unknown> = {};
	const cleared = (v: unknown): boolean => v === null || v === "";

	if ("recallScope" in body && !cleared(body.recallScope)) {
		if (body.recallScope === "project" || body.recallScope === "all") value.recallScope = body.recallScope;
		else errors.push("recallScope must be 'project' or 'all'");
	}
	if ("bank" in body && !cleared(body.bank)) {
		if (typeof body.bank === "string" && body.bank.trim().length > 0) value.bank = body.bank.trim();
		else errors.push("bank must be a non-empty string");
	}
	if ("tagsMatch" in body && !cleared(body.tagsMatch)) {
		if (body.tagsMatch === "any" || body.tagsMatch === "any_strict") value.tagsMatch = body.tagsMatch;
		else errors.push("tagsMatch must be 'any' or 'any_strict'");
	}
	if ("recallBudget" in body && !cleared(body.recallBudget)) {
		const v = body.recallBudget;
		if (typeof v === "number" && Number.isFinite(v) && v > 0) value.recallBudget = v;
		else errors.push("recallBudget must be a positive number");
	}
	if ("recallTypes" in body && body.recallTypes !== null) {
		const v = body.recallTypes;
		if (Array.isArray(v) && v.length > 0 && v.every(isRecallType)) value.recallTypes = [...new Set(v)];
		else errors.push("recallTypes must be a non-empty array of 'observation'|'world'|'experience'");
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Redact secrets for the `config` GET surface — every secret field collapses to a
 *  `<field>Set` boolean and the raw value is never echoed. */
export function redactConfig(cfg: EffectiveConfig): Record<string, unknown> {
	const { apiKey, externalDatabaseUrl, llmApiKey, ...rest } = cfg;
	return {
		...rest,
		apiKeySet: typeof apiKey === "string" && apiKey.length > 0,
		externalDatabaseUrlSet: typeof externalDatabaseUrl === "string" && externalDatabaseUrl.length > 0,
		llmApiKeySet: typeof llmApiKey === "string" && llmApiKey.length > 0,
	};
}

async function readStored(store: StoreLike, key: string): Promise<Record<string, unknown> | undefined> {
	try {
		const v = await store.get(key);
		return isObj(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

const pidOf = (projectId?: string): string | undefined =>
	typeof projectId === "string" && projectId.trim().length > 0 ? projectId.trim() : undefined;

/** Read + validate the per-project config overlay (safe memory-quality keys only).
 *  Returns undefined when there is no project id or no usable stored overlay. */
export async function loadProjectOverride(store: StoreLike, projectId?: string): Promise<Record<string, unknown> | undefined> {
	const pid = pidOf(projectId);
	if (!pid) return undefined;
	const raw = await readStored(store, projectConfigKey(pid));
	if (!raw) return undefined;
	const v = validateProjectOverride(raw);
	return v.ok && v.value && Object.keys(v.value).length > 0 ? v.value : undefined;
}

/** Effective config for the routes. Resolution precedence (low → high):
 *  CONFIG_DEFAULTS → global store config (CONFIG_KEY) → per-project overlay. */
export async function loadEffectiveConfig(store: StoreLike, projectId?: string): Promise<EffectiveConfig> {
	const global = (await readStored(store, CONFIG_KEY)) ?? {};
	const overlay = (await loadProjectOverride(store, projectId)) ?? {};
	return resolveConfig({ ...CONFIG_DEFAULTS, ...global, ...overlay });
}

/** Overlay the per-project config onto an ALREADY-resolved base (the provider's
 *  `ctx.config`, which the host has merged from yaml defaults + global store). The
 *  overlay only carries safe memory-quality keys, so deployment/activation fields
 *  (mode/externalUrl) are never changed by it. */
export async function overlayProjectConfig(
	base: EffectiveConfig,
	store: StoreLike | null,
	projectId?: string,
): Promise<EffectiveConfig> {
	if (!store) return base;
	const overlay = await loadProjectOverride(store, projectId);
	if (!overlay) return base;
	return resolveConfig({ ...base, ...overlay });
}

// ── Bank mission (durable-knowledge steering) ─────────────────────────────────

/** Non-empty mission updates in the snake_case REST shape (empty ⇒ field omitted). */
export function bankMissionUpdates(cfg: EffectiveConfig): BankMissionUpdates {
	const u: BankMissionUpdates = {};
	if (cfg.retainMission && cfg.retainMission.trim().length > 0) u.retain_mission = cfg.retainMission;
	if (cfg.observationsMission && cfg.observationsMission.trim().length > 0) u.observations_mission = cfg.observationsMission;
	if (cfg.reflectMission && cfg.reflectMission.trim().length > 0) u.reflect_mission = cfg.reflectMission;
	return u;
}

/** Stable signature of the mission config for the applied-cache (skip redundant PATCH). */
export function missionSignature(cfg: EffectiveConfig): string {
	return JSON.stringify({ ns: cfg.namespace, bank: cfg.bank, ...bankMissionUpdates(cfg) });
}

/** Idempotently apply the bank-config missions (PATCH …/config) after ensureBank.
 *  Caches the last-applied signature per namespace:bank in the pack store and
 *  re-PATCHes ONLY when it changes (no extra call per turn). Best-effort: a PATCH
 *  failure records a diagnostic but NEVER blocks retain — the caller proceeds. */
export async function applyBankMission(store: StoreLike | null, client: HindsightClientLike, cfg: EffectiveConfig): Promise<void> {
	const updates = bankMissionUpdates(cfg);
	if (Object.keys(updates).length === 0 || typeof client.updateBankConfig !== "function") return;
	const key = `${BANK_CONFIG_APPLIED_PREFIX}${cfg.namespace}:${cfg.bank}`;
	const sig = missionSignature(cfg);
	if (store) {
		try {
			if ((await store.get<string>(key)) === sig) return;
		} catch {
			/* fall through and (re)apply */
		}
	}
	try {
		await client.updateBankConfig(cfg.bank, updates);
		if (store) {
			try {
				await store.put(key, sig);
			} catch {
				/* best-effort cache */
			}
		}
	} catch (e) {
		if (store) await recordError(store, e); // diagnostic only — never blocks retain
	}
}

// ── Auto-retain batching (durable per-session pending buffer) ─────────────────
//
// Turns are BATCHED, never sampled: each `afterTurn` appends a compact summary to
// a durable per-session buffer and an aggregate retain (containing ALL pending
// primary turns) is flushed when the buffer reaches `retainEveryNTurns`, or when
// the oldest pending turn ages past `retainMaxDelayMs` (a hook-observed timeout —
// no provider-local timers). After a flush the last `retainOverlapTurns` summaries
// are carried forward as bounded OVERLAP context and the primary turns are cleared
// so the count always advances and the buffer never grows unbounded.

/** One buffered turn summary + its capture timestamp (for the max-delay flush). */
export interface PendingTurn {
	summary: string;
	ts: number;
}

/** Durable per-session retain buffer: primary `turns` (count toward the batch) plus
 *  `overlap` carry-forward summaries from the previous flush (do NOT count). */
export interface PendingBuffer {
	turns: PendingTurn[];
	overlap: string[];
}

/** Separator between turn summaries inside a flushed aggregate retain. */
export const AGGREGATE_SEPARATOR = "\n\n---\n\n";

export function pendingKey(sessionId: string): string {
	return `${RETAIN_PENDING_PREFIX}${sessionId}`;
}

function asPendingTurns(v: unknown): PendingTurn[] {
	if (!Array.isArray(v)) return [];
	return v
		.filter((t): t is PendingTurn => isObj(t) && typeof (t as { summary?: unknown }).summary === "string")
		.map((t) => ({ summary: String(t.summary), ts: typeof t.ts === "number" && Number.isFinite(t.ts) ? t.ts : 0 }));
}

/** Read the durable pending buffer (tolerant of an absent/legacy/garbled value). */
export async function loadPending(store: StoreLike, sessionId: string): Promise<PendingBuffer> {
	try {
		const v = await store.get<PendingBuffer>(pendingKey(sessionId));
		if (isObj(v)) {
			return {
				turns: asPendingTurns((v as PendingBuffer).turns),
				overlap: Array.isArray((v as PendingBuffer).overlap) ? (v as PendingBuffer).overlap.filter((s) => typeof s === "string") : [],
			};
		}
	} catch {
		/* fall through to empty */
	}
	return { turns: [], overlap: [] };
}

export async function savePending(store: StoreLike, sessionId: string, buf: PendingBuffer): Promise<void> {
	try {
		await store.put(pendingKey(sessionId), buf);
	} catch {
		/* best-effort durable buffer */
	}
}

/** Whether the pending buffer should flush now: the batch is full (turns >=
 *  everyN), OR (time-based) the oldest pending turn has aged past maxDelayMs.
 *  Never flushes an empty buffer; `maxDelayMs <= 0` disables the time-based flush. */
export function shouldFlushPending(buf: PendingBuffer, everyN: number, maxDelayMs: number, now: number): boolean {
	if (buf.turns.length === 0) return false;
	const n = Number.isFinite(everyN) && everyN >= 1 ? Math.floor(everyN) : 1;
	if (buf.turns.length >= n) return true;
	if (Number.isFinite(maxDelayMs) && maxDelayMs > 0) {
		const oldest = buf.turns[0]?.ts ?? now;
		if (now - oldest >= maxDelayMs) return true;
	}
	return false;
}

/** Build the aggregate retain content: overlap context (from the previous flush)
 *  followed by every pending primary turn, joined by {@link AGGREGATE_SEPARATOR}. */
export function buildAggregateContent(buf: PendingBuffer): string {
	const parts: string[] = [];
	if (buf.overlap.length > 0) parts.push(`Earlier context (overlap):${AGGREGATE_SEPARATOR}${buf.overlap.join(AGGREGATE_SEPARATOR)}`);
	for (const t of buf.turns) parts.push(t.summary);
	return parts.join(AGGREGATE_SEPARATOR);
}

/** The overlap carry-forward for the NEXT batch: the last `overlapTurns` summaries
 *  of the just-flushed primary turns (bounded — never the previous overlap). */
export function nextOverlap(turns: PendingTurn[], overlapTurns: number): string[] {
	const k = Number.isFinite(overlapTurns) && overlapTurns >= 1 ? Math.floor(overlapTurns) : 0;
	if (k <= 0) return [];
	return turns.slice(-k).map((t) => t.summary);
}
