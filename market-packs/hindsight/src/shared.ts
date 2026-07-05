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
export type RecallBudget = "low" | "mid" | "high";
export type UpdateMode = "replace" | "append";
export const RECALL_TYPES: readonly RecallType[] = ["observation", "world", "experience"];

export interface EntityInput {
	text: string;
	type?: string;
}

export interface RecallInclude {
	entities?: null | Record<string, unknown>;
	chunks?: null | Record<string, unknown>;
	source_facts?: null | Record<string, unknown>;
}

export interface RetainClientOptions {
	tags?: Tags;
	sync?: boolean;
	documentId?: string;
	updateMode?: UpdateMode;
	entities?: EntityInput[];
	timestamp?: string;
	observationScopes?: string | string[][];
	metadata?: Record<string, string>;
}

export interface ReflectClientOptions {
	tags?: Tags;
	tagsMatch?: TagsMatch;
	responseSchema?: Record<string, unknown>;
	factTypes?: RecallType[];
	budget?: RecallBudget;
	maxTokens?: number;
	include?: RecallInclude;
	excludeMentalModels?: boolean;
	excludeMentalModelIds?: string[];
}

export interface DirectiveConfig {
	name: string;
	content: string;
	priority?: number;
	tags?: string[];
}

export interface OutcomeDigestInput {
	projectId?: string;
	goalId?: string;
	pr?: string | number;
	branch?: string;
	mergeTarget?: string;
	title?: string;
	content?: string;
	achievements?: string[];
	decisions?: string[];
	files?: string[];
	touchedFiles?: string[];
	components?: string[];
	tags?: Tags;
	timestamp?: string;
}

export interface OutcomeDigest {
	content: string;
	documentId: string;
	tags: Tags;
	entities?: EntityInput[];
	timestamp: string;
	observationScopes?: string[][];
}

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
		opts?: { maxTokens?: number; budget?: RecallBudget; tags?: Tags; tagsMatch?: TagsMatch; types?: RecallType[]; include?: RecallInclude; queryTimestamp?: string; trace?: boolean },
	): Promise<{ memories: RecallMemory[] }>;
	retain(bank: string, content: string, opts?: RetainClientOptions): Promise<void>;
	reflect(bank: string, prompt: string, opts?: ReflectClientOptions): Promise<{ text: string; structuredOutput?: unknown }>;
	listBanks(): Promise<{ banks: string[] }>;
	/** Idempotent bank-config mission update (PATCH …/config). Optional so unit-test
	 *  fakes need not implement it; {@link applyBankMission} no-ops when absent. */
	updateBankConfig?(bank: string, updates: BankMissionUpdates): Promise<void>;
	getMentalModel?(bank: string, id: string): Promise<{ content?: string } | null>;
	ensureMentalModel?(bank: string, opts: { id?: string; name: string; sourceQuery: string; tags?: string[]; maxTokens?: number; trigger?: Record<string, unknown> }): Promise<{ model: { content?: string } | null; created: boolean; operationId?: string }>;
	refreshMentalModel?(bank: string, id: string): Promise<{ operationId?: string }>;
	listDirectives?(bank: string): Promise<{ items: Array<{ id: string; name?: string; content?: string; priority?: number; is_active?: boolean; tags?: string[] }> }>;
	createDirective?(bank: string, directive: { name: string; content: string; priority?: number; isActive?: boolean; tags?: string[] }): Promise<unknown>;
	updateDirective?(bank: string, id: string, patch: { name?: string; content?: string; priority?: number; isActive?: boolean; tags?: string[] }): Promise<unknown>;
	llmHealth?(bank: string): Promise<unknown>;
	listOperations?(bank: string): Promise<{ items: unknown[] }>;
	invalidateMemory?(bank: string, id: string, reason: string): Promise<void>;
	getMemoryHistory?(bank: string, id: string): Promise<{ history: unknown[] }>;
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
	recallQueryTimestampEnabled: boolean;
	mentalModelEnabled: boolean;
	mentalModelMaxTokens: number;
	mentalModelRefreshEveryMs: number;
	mentalModelRecallMaxTokens: number;
	directivesEnabled: boolean;
	directiveApplyMode: "disabled" | "bank-wide-explicit-opt-in" | "scoped-if-supported";
	directiveSetVersion: string;
	directives: DirectiveConfig[];
	retainQueueDrainMaxPerHook: number;
	retainQueueShutdownMax: number;
	retainQueueHealthGate: boolean;
	retainQueueLlmHealthGate: boolean;
	retainQueueBatchPauseMs: number;
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

export const DEFAULT_BOBBIT_DIRECTIVES: readonly DirectiveConfig[] = [
	{
		name: "bobbit-coding-agent-recall",
		content: "Answer for a coding agent. Prefer recent, durable project facts and decisions; cite source facts when present; ignore transient turn noise unless it records a lasting decision or project-state change.",
		priority: 50,
		tags: ["bobbit"],
	},
];

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
	recallQueryTimestampEnabled: true,
	mentalModelEnabled: true,
	mentalModelMaxTokens: 1000,
	mentalModelRefreshEveryMs: 86_400_000,
	mentalModelRecallMaxTokens: 1200,
	directivesEnabled: false,
	directiveApplyMode: "disabled",
	directiveSetVersion: "bobbit-v1",
	directives: DEFAULT_BOBBIT_DIRECTIVES.map((d) => ({ ...d, tags: d.tags ? [...d.tags] : undefined })),
	retainQueueDrainMaxPerHook: 1,
	retainQueueShutdownMax: 10,
	retainQueueHealthGate: true,
	retainQueueLlmHealthGate: false,
	retainQueueBatchPauseMs: 0,
	retainMission: DEFAULT_RETAIN_MISSION,
	observationsMission: DEFAULT_OBSERVATIONS_MISSION,
	reflectMission: DEFAULT_REFLECT_MISSION,
	recallMaxInputChars: 3000,
	timeoutMs: 4000,
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
function isDirectiveApplyMode(v: unknown): v is EffectiveConfig["directiveApplyMode"] {
	return v === "disabled" || v === "bank-wide-explicit-opt-in" || v === "scoped-if-supported";
}
function asDirectives(v: unknown, d: DirectiveConfig[]): DirectiveConfig[] {
	if (!Array.isArray(v)) return d.map((x) => ({ ...x, tags: x.tags ? [...x.tags] : undefined }));
	const out: DirectiveConfig[] = [];
	for (const item of v) {
		if (!isObj(item) || typeof item.name !== "string" || item.name.trim().length === 0 || typeof item.content !== "string") continue;
		out.push({
			name: item.name.trim(),
			content: item.content,
			...(typeof item.priority === "number" && Number.isFinite(item.priority) ? { priority: item.priority } : {}),
			...(Array.isArray(item.tags) ? { tags: item.tags.filter((t) => typeof t === "string") } : {}),
		});
	}
	return out.length > 0 ? out : d.map((x) => ({ ...x, tags: x.tags ? [...x.tags] : undefined }));
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
	const directiveApplyModeRaw = flat(raw, "directiveApplyMode");
	const retainQueueDrainMaxPerHook = Math.max(0, Math.floor(asNum(flat(raw, "retainQueueDrainMaxPerHook"), CONFIG_DEFAULTS.retainQueueDrainMaxPerHook)));
	const retainQueueShutdownMax = Math.max(0, Math.floor(asNum(flat(raw, "retainQueueShutdownMax"), CONFIG_DEFAULTS.retainQueueShutdownMax)));
	const retainQueueBatchPauseMs = Math.max(0, Math.floor(asNum(flat(raw, "retainQueueBatchPauseMs"), CONFIG_DEFAULTS.retainQueueBatchPauseMs)));
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
		recallQueryTimestampEnabled: asBool(flat(raw, "recallQueryTimestampEnabled"), CONFIG_DEFAULTS.recallQueryTimestampEnabled),
		mentalModelEnabled: asBool(flat(raw, "mentalModelEnabled"), CONFIG_DEFAULTS.mentalModelEnabled),
		mentalModelMaxTokens: Math.max(1, Math.floor(asNum(flat(raw, "mentalModelMaxTokens"), CONFIG_DEFAULTS.mentalModelMaxTokens))),
		mentalModelRefreshEveryMs: Math.max(0, Math.floor(asNum(flat(raw, "mentalModelRefreshEveryMs"), CONFIG_DEFAULTS.mentalModelRefreshEveryMs))),
		mentalModelRecallMaxTokens: Math.max(1, Math.floor(asNum(flat(raw, "mentalModelRecallMaxTokens"), CONFIG_DEFAULTS.mentalModelRecallMaxTokens))),
		directivesEnabled: asBool(flat(raw, "directivesEnabled"), CONFIG_DEFAULTS.directivesEnabled),
		directiveApplyMode: isDirectiveApplyMode(directiveApplyModeRaw) ? directiveApplyModeRaw : CONFIG_DEFAULTS.directiveApplyMode,
		directiveSetVersion: asString(flat(raw, "directiveSetVersion")) ?? CONFIG_DEFAULTS.directiveSetVersion,
		directives: asDirectives(flat(raw, "directives"), CONFIG_DEFAULTS.directives),
		retainQueueDrainMaxPerHook,
		retainQueueShutdownMax,
		retainQueueHealthGate: asBool(flat(raw, "retainQueueHealthGate"), CONFIG_DEFAULTS.retainQueueHealthGate),
		retainQueueLlmHealthGate: asBool(flat(raw, "retainQueueLlmHealthGate"), CONFIG_DEFAULTS.retainQueueLlmHealthGate),
		retainQueueBatchPauseMs,
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

/** Joiner spliced between the kept head and tail when {@link clampRecallQuery}
 *  clips a query (MEM-5). Its length is deducted from the character budget so the
 *  clamped output is always EXACTLY `effective` chars — callers that size around
 *  the clamp see no contract change. */
const RECALL_QUERY_JOINER = " ... ";
/** Fraction of the post-joiner budget given to the HEAD; the remainder goes to the
 *  TAIL. Biased toward the tail because a long turn/prompt's actual question is
 *  usually asked LAST — a pure head-slice (the old behavior) silently dropped it. */
const RECALL_QUERY_HEAD_FRACTION = 0.4;

/** Clamp a recall QUERY so it can NEVER trip the data plane's 500-token "Query too
 *  long" 400. Trims first, then clips to the SMALLER of the configured `maxChars`
 *  char clamp (when `maxChars > 0`) and the hard {@link RECALL_QUERY_SAFE_CHAR_CEILING}
 *  token-safe ceiling. The token-safe ceiling is enforced even when char-clamping is
 *  disabled (`maxChars <= 0` / non-finite) — the query stays under the token cap
 *  regardless of the configured value.
 *
 *  MEM-5: when clipping is needed, keeps BOTH ends (head + tail joined by
 *  {@link RECALL_QUERY_JOINER}) instead of a pure head-slice — a long prompt's tail
 *  often carries the actual question, which a head-only clamp silently lost. The
 *  output length is always exactly `effective` chars (same as the old head-slice),
 *  so callers relying on the length contract are unaffected. Falls back to a plain
 *  head-slice when the budget is too small for a joiner to be worthwhile. Pure;
 *  never throws. */
export function clampRecallQuery(query: string, maxChars: number): string {
	const trimmed = (query ?? "").trim();
	const charClamp = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : Number.POSITIVE_INFINITY;
	const effective = Math.min(charClamp, RECALL_QUERY_SAFE_CHAR_CEILING);
	if (trimmed.length <= effective) return trimmed;
	const available = effective - RECALL_QUERY_JOINER.length;
	if (available < 2) return trimmed.slice(0, effective);
	const headLen = Math.floor(available * RECALL_QUERY_HEAD_FRACTION);
	const tailLen = available - headLen;
	const head = trimmed.slice(0, headLen);
	const tail = trimmed.slice(trimmed.length - tailLen);
	return `${head}${RECALL_QUERY_JOINER}${tail}`;
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
 *  `kind:"http"` + `status:400` + a message that names the query AND carries
 *  query-too-long/token-limit wording (the client surfaces the upstream `detail`
 *  body in the error message). */
export function isQueryTooLongError(e: unknown): boolean {
	if (!e || typeof e !== "object") return false;
	const err = e as { kind?: unknown; status?: unknown; message?: unknown };
	if (err.kind !== "http" || err.status !== 400) return false;
	const msg = typeof err.message === "string" ? err.message.toLowerCase() : "";
	if (!/\bquery\b/.test(msg)) return false;
	if (/\btoo\s+(?:long|large|many\s+tokens?)\b/.test(msg)) return true;
	return /\b(?:exceeds?|exceeded)\b.*\b(?:max(?:imum)?|limit|tokens?)\b/.test(msg)
		|| /\b(?:max(?:imum)?|limit|tokens?)\b.*\b(?:exceeds?|exceeded)\b/.test(msg);
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
	documentId?: string;
	updateMode?: UpdateMode;
	entities?: EntityInput[];
	timestamp?: string;
	observationScopes?: string | string[][];
	metadata?: Record<string, string>;
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
export const MENTAL_MODEL_REFRESH_PREFIX = "mental-model-refresh:";
export const DIRECTIVES_APPLIED_PREFIX = "directives-applied:";
export const QUEUE_CAP = 100;
/** Durable eviction counter (MEM-3): incremented every time a full retry queue
 *  drops an entry on the floor instead of queuing it, so sustained-outage loss is
 *  observable (routes `status` surfaces it) instead of silent. */
export const QUEUE_EVICTIONS_KEY = "retain-queue-evictions";

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

/** Durable eviction stats persisted at {@link QUEUE_EVICTIONS_KEY} (MEM-3). */
export interface QueueEvictionStats {
	count: number;
	lastAt: number;
	/** A short, non-sensitive preview of the most recently dropped entry's tags,
	 *  for diagnostics (never the full content — kept small). */
	lastTags?: Tags;
}

/** Read the durable eviction counter (defaults to a zero-count record). */
export async function loadQueueEvictions(store: StoreLike): Promise<QueueEvictionStats> {
	try {
		const v = await store.get<QueueEvictionStats>(QUEUE_EVICTIONS_KEY);
		return v && typeof v.count === "number" ? v : { count: 0, lastAt: 0 };
	} catch {
		return { count: 0, lastAt: 0 };
	}
}

/** Record ONE dropped-on-the-floor retry-queue entry: bump the durable counter
 *  (so `status` can surface sustained-outage loss instead of it being silent) and
 *  emit a console.warn with the running count. Best-effort; never throws. */
async function recordQueueEviction(store: StoreLike, dropped: QueueEntry, now = Date.now()): Promise<void> {
	try {
		const prior = await loadQueueEvictions(store);
		const next: QueueEvictionStats = { count: prior.count + 1, lastAt: now, lastTags: dropped.tags };
		await store.put(QUEUE_EVICTIONS_KEY, next);
		console.warn(
			`[hindsight] retry queue full (cap ${QUEUE_CAP}); dropped an entry instead of queuing it — ${next.count} total eviction(s) so far. A sustained outage is silently losing memories; check the data-plane connection.`,
		);
	} catch {
		/* diagnostics are non-fatal */
	}
}

/** Append a failed retain to the durable retry queue, capped at {@link QUEUE_CAP}
 *  (100). MEM-3: when the queue is already full, TAIL-DROP — refuse the incoming
 *  (newest) entry rather than evicting the queue HEAD (the oldest). The head is
 *  also the entry `drainQueueHead`/`drainQueueAll` retry NEXT, and it has already
 *  survived the longest without loss; evicting it to make room for a flood of new
 *  failures during a sustained outage threw away the durable backlog that was
 *  closest to recovering. Tail-dropping instead means: (1) FIFO drain order and
 *  continuity are preserved once the data plane recovers — no gap is punched
 *  into the middle of the backlog, and (2) the loss is NOT silent — every drop is
 *  durably counted ({@link QUEUE_EVICTIONS_KEY}) and logged so a sustained outage
 *  is observable via `status.queueEvictions` instead of vanishing unnoticed. */
export async function enqueueRetain(store: StoreLike, entry: QueueEntry): Promise<void> {
	const q = await loadQueue(store);
	if (q.length >= QUEUE_CAP) {
		await recordQueueEviction(store, entry);
		return;
	}
	q.push(entry);
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

function cleanIdPart(s: string): string {
	return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function mentalModelId(projectId: string): string {
	return `bobbit-${cleanIdPart(projectId)}`;
}

export function mentalModelTags(projectId: string): string[] {
	const pid = pidOf(projectId);
	return pid ? [`project:${pid}`, "bobbit", "kind:mental-model"] : ["bobbit", "kind:mental-model"];
}

export function mentalModelSourceQuery(projectId: string, maxTokens: number): string {
	const pid = pidOf(projectId) ?? "this project";
	return `Current durable project state for ${pid}: key decisions, architecture, conventions, open threads, recent outcomes, and next actions. Prefer consolidated observations and durable facts. Limit to about ${Math.max(1, Math.floor(maxTokens))} tokens.`;
}

export interface MentalModelRefreshRecord {
	lastAttemptAt?: number;
	lastSuccessAt?: number;
	operationId?: string;
}

export function mentalModelRefreshKey(cfg: EffectiveConfig, projectId: string): string {
	return `${MENTAL_MODEL_REFRESH_PREFIX}${cfg.namespace}:${cfg.bank}:${mentalModelId(projectId)}`;
}

export async function shouldRefreshMentalModel(store: StoreLike | null, cfg: EffectiveConfig, projectId: string, now: number): Promise<boolean> {
	if (!cfg.mentalModelEnabled) return false;
	if (!Number.isFinite(cfg.mentalModelRefreshEveryMs) || cfg.mentalModelRefreshEveryMs <= 0) return true;
	if (!store) return true;
	try {
		const rec = await store.get<MentalModelRefreshRecord>(mentalModelRefreshKey(cfg, projectId));
		const last = rec && typeof rec.lastAttemptAt === "number" ? rec.lastAttemptAt : rec && typeof rec.lastSuccessAt === "number" ? rec.lastSuccessAt : 0;
		return now - last >= cfg.mentalModelRefreshEveryMs;
	} catch {
		return true;
	}
}

export async function recordMentalModelRefresh(store: StoreLike | null, cfg: EffectiveConfig, projectId: string, rec: MentalModelRefreshRecord): Promise<void> {
	if (!store) return;
	try {
		await store.put(mentalModelRefreshKey(cfg, projectId), rec);
	} catch {
		/* best-effort cadence cache */
	}
}

export function observationScopesForProject(projectId?: string): string[][] | undefined {
	const pid = pidOf(projectId);
	return pid ? [[`project:${pid}`]] : undefined;
}

function uniqueEntities(items: EntityInput[]): EntityInput[] {
	const seen = new Set<string>();
	const out: EntityInput[] = [];
	for (const item of items) {
		const text = typeof item.text === "string" ? item.text.trim() : "";
		if (!text) continue;
		const type = typeof item.type === "string" && item.type.trim().length > 0 ? item.type.trim() : undefined;
		const key = `${type ?? ""}\0${text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(type ? { text, type } : { text });
	}
	return out;
}

function stringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];
}

export function entitiesFromContext(ctx: unknown): EntityInput[] | undefined {
	if (!isObj(ctx)) return undefined;
	const files = [...stringArray(ctx.files), ...stringArray(ctx.touchedFiles)];
	const components = stringArray(ctx.components);
	const entities = uniqueEntities([
		...files.map((text) => ({ text, type: "file" })),
		...components.map((text) => ({ text, type: "component" })),
	]);
	return entities.length > 0 ? entities : undefined;
}

export function entitiesFromOutcomeBody(body: unknown): EntityInput[] | undefined {
	if (!isObj(body)) return undefined;
	const explicit = Array.isArray(body.entities)
		? body.entities.filter((e): e is EntityInput => isObj(e) && typeof e.text === "string").map((e) => ({ text: e.text, ...(typeof e.type === "string" ? { type: e.type } : {}) }))
		: [];
	const files = [...stringArray(body.files), ...stringArray(body.touchedFiles)];
	const components = stringArray(body.components);
	const entities = uniqueEntities([
		...explicit,
		...files.map((text) => ({ text, type: "file" })),
		...components.map((text) => ({ text, type: "component" })),
	]);
	return entities.length > 0 ? entities : undefined;
}

export function outcomeTags(input: OutcomeDigestInput, extra?: Tags): Tags {
	const tags: Tags = { kind: "outcome", bobbit: "true", ...(extra ?? {}), ...(input.tags ?? {}) };
	const pid = pidOf(input.projectId);
	if (pid) tags.project = pid;
	if (typeof input.goalId === "string" && input.goalId.trim().length > 0) tags.goal = input.goalId.trim();
	if (input.pr !== undefined && String(input.pr).trim().length > 0) tags.pr = String(input.pr).trim();
	return tags;
}

export function buildOutcomeDigest(input: OutcomeDigestInput): OutcomeDigest {
	const timestamp = input.timestamp && !Number.isNaN(Date.parse(input.timestamp)) ? input.timestamp : new Date().toISOString();
	const goalOrPr = input.goalId ? `goal:${input.goalId}` : input.pr !== undefined ? `pr:${input.pr}` : `manual:${cleanIdPart(input.title ?? timestamp)}`;
	const lines: string[] = [];
	lines.push(input.title ? `Outcome: ${input.title}` : `Outcome digest for ${goalOrPr}`);
	if (input.branch) lines.push(`Branch: ${input.branch}`);
	if (input.mergeTarget) lines.push(`Merge target: ${input.mergeTarget}`);
	if (input.content && input.content.trim()) lines.push(input.content.trim());
	if (input.achievements?.length) lines.push(`Achievements:\n${input.achievements.map((x) => `- ${x}`).join("\n")}`);
	if (input.decisions?.length) lines.push(`Decisions:\n${input.decisions.map((x) => `- ${x}`).join("\n")}`);
	const files = [...stringArray(input.files), ...stringArray(input.touchedFiles)];
	if (files.length) lines.push(`Files/components:\n${[...files, ...stringArray(input.components)].map((x) => `- ${x}`).join("\n")}`);
	const entities = entitiesFromOutcomeBody(input);
	return {
		content: lines.join("\n\n"),
		documentId: input.goalId ? `outcome:${input.goalId}` : input.pr !== undefined ? `outcome:pr:${input.pr}` : `outcome:${goalOrPr}`,
		tags: outcomeTags(input),
		...(entities ? { entities } : {}),
		timestamp,
		...(observationScopesForProject(input.projectId) ? { observationScopes: observationScopesForProject(input.projectId) } : {}),
	};
}

export function currentQueryTimestamp(enabled: boolean, now = new Date()): string | undefined {
	return enabled ? now.toISOString() : undefined;
}

export function directivesSignature(cfg: EffectiveConfig): string {
	return JSON.stringify({ ns: cfg.namespace, bank: cfg.bank, mode: cfg.directiveApplyMode, version: cfg.directiveSetVersion, directives: cfg.directives });
}

export function reflectInstructionPrefix(cfg: EffectiveConfig): string {
	if (cfg.directivesEnabled && cfg.directiveApplyMode !== "disabled") return "";
	return DEFAULT_BOBBIT_DIRECTIVES[0]?.content ?? "";
}

export async function applyDirectives(store: StoreLike | null, client: HindsightClientLike, cfg: EffectiveConfig): Promise<void> {
	if (!cfg.directivesEnabled || cfg.directiveApplyMode === "disabled") return;
	if (typeof client.listDirectives !== "function" || typeof client.createDirective !== "function") return;
	const key = `${DIRECTIVES_APPLIED_PREFIX}${cfg.namespace}:${cfg.bank}`;
	const sig = directivesSignature(cfg);
	if (store) {
		try {
			if ((await store.get<string>(key)) === sig) return;
		} catch {
			/* fall through */
		}
	}
	try {
		const existing = await client.listDirectives(cfg.bank);
		for (const directive of cfg.directives) {
			if (!directive.name.startsWith("bobbit-")) continue;
			const current = existing.items.find((d) => d.name === directive.name);
			const payload = { ...directive, isActive: true, tags: [...new Set([...(directive.tags ?? []), "bobbit"])] };
			if (current?.id && typeof client.updateDirective === "function") await client.updateDirective(cfg.bank, current.id, payload);
			else await client.createDirective(cfg.bank, payload);
		}
		if (store) await store.put(key, sig);
	} catch (e) {
		if (store) await recordError(store, e);
	}
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
	for (const key of ["recallQueryTimestampEnabled", "mentalModelEnabled", "directivesEnabled", "retainQueueHealthGate", "retainQueueLlmHealthGate"] as const) {
		if (key in body) {
			if (typeof body[key] === "boolean") value[key] = body[key];
			else errors.push(`${key} must be a boolean`);
		}
	}
	if ("directiveApplyMode" in body) {
		if (isDirectiveApplyMode(body.directiveApplyMode)) value.directiveApplyMode = body.directiveApplyMode;
		else errors.push("directiveApplyMode must be 'disabled', 'bank-wide-explicit-opt-in', or 'scoped-if-supported'");
	}
	if ("directiveSetVersion" in body) {
		if (typeof body.directiveSetVersion === "string" && body.directiveSetVersion.trim().length > 0) value.directiveSetVersion = body.directiveSetVersion.trim();
		else errors.push("directiveSetVersion must be a non-empty string");
	}
	if ("directives" in body) {
		const parsed = asDirectives(body.directives, []);
		if (parsed.length > 0) value.directives = parsed;
		else errors.push("directives must be a non-empty list of { name, content }");
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
	for (const key of ["recallBudget", "recallMaxInputChars", "timeoutMs", "mentalModelMaxTokens", "mentalModelRecallMaxTokens"] as const) {
		if (key in body) {
			const v = body[key];
			if (typeof v === "number" && Number.isFinite(v) && v > 0) value[key] = v;
			else errors.push(`${key} must be a positive number`);
		}
	}
	for (const key of ["mentalModelRefreshEveryMs", "retainQueueDrainMaxPerHook", "retainQueueShutdownMax", "retainQueueBatchPauseMs"] as const) {
		if (key in body) {
			const v = body[key];
			if (typeof v === "number" && Number.isFinite(v) && v >= 0) value[key] = Math.floor(v);
			else errors.push(`${key} must be a number >= 0`);
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

// ── Crash-recovery sweep for STRANDED pending buffers (MEM-1b) ────────────────
//
// `sessionShutdown` is the ONLY thing that flushes a session's durable pending
// buffer outside the normal batch/max-delay cadence. A session that never reaches
// it — killed (SIGKILL/OOM), a host crash/reboot, or (historically, see MEM-1a)
// a gateway shutdown path that forgot to dispatch it — leaves its
// `retain-pending:<sessionId>` buffer on disk FOREVER: nothing else ever reads it
// again, so it is silently lost even though the bytes are still sitting in the
// store.
//
// There is no dedicated pack "boot" lifecycle hook (adding one is a wide,
// high-risk cross-cutting change touching `LIFECYCLE_HOOKS` — see
// lifecycle-hooks.ts's own warning about hook-set drift being exactly how a past
// outage happened). Instead this piggybacks on `sessionSetup`, which fires near
// every session start/resume: at most once per `RETAIN_SWEEP_INTERVAL_MS` (a
// stored last-swept timestamp gates it, mirroring the mental-model refresh
// cadence), it lists every OTHER session's pending buffer and reclaims any whose
// oldest turn is older than `staleAfterMs` — comfortably past when a live session
// would have flushed it itself via the batch/max-delay cadence or its own
// shutdown.
export const RETAIN_SWEEP_LAST_KEY = "retain-pending-sweep:last";
/** Minimum spacing between sweeps — cheap (one store list + gate check) but there
 *  is no reason to pay it on every single sessionSetup. */
export const RETAIN_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/** Floor for how old a pending buffer's oldest turn must be before it is treated
 *  as stranded, regardless of the caller's configured `retainMaxDelayMs` (a
 *  disabled/huge max-delay must not make the sweep effectively never fire). */
export const DEFAULT_STRANDED_AFTER_MS = 3 * 60 * 60 * 1000;

/** List sessions (other than `currentSessionId`) whose durable pending buffer
 *  looks stranded (non-empty, oldest turn older than `staleAfterMs`), gated to
 *  run at most once per {@link RETAIN_SWEEP_INTERVAL_MS}. Returns `[]` on a
 *  gate-skip, a store without `list`, or any error (best-effort; never throws).
 *  Callers (the provider's `sessionSetup`) are expected to flush/queue each
 *  returned session id via the normal `flushPending` path — this helper only
 *  identifies candidates, it does not touch the network. */
export async function listStrandedPendingSessions(
	store: StoreLike,
	currentSessionId: string | undefined,
	staleAfterMs: number,
	now: number = Date.now(),
): Promise<string[]> {
	if (typeof store.list !== "function") return [];
	try {
		const last = await store.get<number>(RETAIN_SWEEP_LAST_KEY);
		if (typeof last === "number" && Number.isFinite(last) && now - last < RETAIN_SWEEP_INTERVAL_MS) return [];
		await store.put(RETAIN_SWEEP_LAST_KEY, now);
	} catch {
		return [];
	}
	const stranded: string[] = [];
	try {
		const keys = await store.list(RETAIN_PENDING_PREFIX);
		for (const key of keys) {
			const sessionId = key.startsWith(RETAIN_PENDING_PREFIX) ? key.slice(RETAIN_PENDING_PREFIX.length) : "";
			if (!sessionId || sessionId === currentSessionId) continue;
			const buf = await loadPending(store, sessionId);
			if (buf.turns.length === 0) continue;
			const oldest = buf.turns[0]?.ts ?? now;
			if (now - oldest >= staleAfterMs) stranded.push(sessionId);
		}
	} catch {
		/* best-effort: return whatever was found before the error */
	}
	return stranded;
}

// ── CAS-guarded pending-buffer mutation (MEM-4) ───────────────────────────────
//
// `afterTurn`'s lifecycle dispatch is fire-and-forget (session-manager.ts) while
// `sessionShutdown`'s is awaited, so for the SAME session two separate flushes can
// genuinely overlap in wall-clock time. Bobbit's pack confinement model runs
// EVERY lifecycle hook dispatch in its own fresh, isolated `worker_threads.Worker`
// (module-host-worker.ts spins one up per `ModuleHost.invoke()` call and tears it
// down when that call settles), so an in-module `Promise`-chain mutex — the
// models-json-store.ts idiom — cannot serialize two SEPARATE hook dispatches: they
// execute in different JS heaps with no shared memory. The actual race window is
// the durable store's two independent `get`/`put` round trips (one file per key,
// no built-in compare-and-swap) sitting on either side of the pending-buffer
// read-modify-write.
//
// Since there is no atomic host-store primitive to hold a lock across, safety has
// to be an APPLICATION-LEVEL optimistic-concurrency retry using only get/put:
// re-read immediately before writing, and if the stored value moved since the
// value the caller's mutation was computed FROM, retry the mutation against the
// freshly observed value instead of blindly overwriting it. This still has a
// theoretical (much narrower — two local reads instead of a full network retain
// round trip) TOCTOU gap between the final re-read and the write; a fully
// airtight fix needs a host-level atomic CAS store primitive, which is a
// versioned host-API contract change out of scope here (flagged in the PR).

function pendingSnapshotEqual(a: PendingBuffer, b: PendingBuffer): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** CAS-retry a pending-buffer mutation: `transform` is re-applied against the
 *  FRESHEST stored value until a write lands with no concurrent writer detected
 *  in between (bounded attempts). On exhausting `maxAttempts` under sustained
 *  contention, applies one final `transform`/save and logs a durable warning so
 *  the (rare) residual race is visible rather than silent. `transform` must be
 *  pure/synchronous — it may be invoked more than once. */
export async function mutatePending(
	store: StoreLike,
	sessionId: string,
	transform: (buf: PendingBuffer) => PendingBuffer,
	maxAttempts = 5,
): Promise<PendingBuffer> {
	let current = await loadPending(store, sessionId);
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const next = transform(current);
		const recheck = await loadPending(store, sessionId);
		if (pendingSnapshotEqual(recheck, current)) {
			await savePending(store, sessionId, next);
			return next;
		}
		current = recheck; // a concurrent writer landed between our load and this recheck — retry against it
	}
	const next = transform(current);
	console.warn(`[hindsight] pending-buffer update for session ${sessionId} applied after exhausting ${maxAttempts} CAS retries (sustained contention)`);
	await savePending(store, sessionId, next);
	return next;
}
