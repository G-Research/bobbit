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

export interface RecallMemory {
	text: string;
	score?: number;
	id?: string;
}

export interface HindsightClientLike {
	health(): Promise<{ ok: boolean }>;
	ensureBank(bank: string): Promise<void>;
	recall(
		bank: string,
		query: string,
		opts?: { maxTokens?: number; tags?: Tags; tagsMatch?: TagsMatch },
	): Promise<{ memories: RecallMemory[] }>;
	retain(bank: string, content: string, opts?: { tags?: Tags; sync?: boolean }): Promise<void>;
	reflect(bank: string, prompt: string): Promise<{ text: string }>;
	listBanks(): Promise<{ banks: string[] }>;
}

export interface ClientConfig {
	baseUrl: string;
	apiKey?: string;
	namespace?: string;
	timeoutMs?: number;
}

/** Read-only public runtime context injected by the host. It intentionally has no
 * runner, mode, setting, or lifecycle-control surface. */
export interface RuntimeContext {
	endpoint?: string;
	state: "stopped" | "starting" | "ready" | "degraded" | "blocked" | "unavailable";
	diagnostic?: { code: string; retryAt?: string };
}

export type ManagedRuntimeMode = "local" | "docker" | "compose";

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
	runtimeMode: "external" | ManagedRuntimeMode;
	externalUrl?: string;
	apiKey?: string;
	dataDir: string;
	bank: string;
	namespace: string;
	recallScope: "project" | "all";
	autoRecall: boolean;
	autoRetain: boolean;
	recallBudget: number;
	timeoutMs: number;
}

/** Flat defaults — the single source of truth mirrored by providers/memory.yaml. */
export const CONFIG_DEFAULTS: EffectiveConfig = {
	runtimeMode: "external",
	dataDir: "${stateDir}/service-data/hindsight",
	bank: "bobbit",
	namespace: "default",
	recallScope: "all",
	autoRecall: true,
	autoRetain: true,
	recallBudget: 1200,
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

export function resolveConfig(raw: unknown): EffectiveConfig {
	const externalUrl = asString(flat(raw, "externalUrl"));
	const apiKey = asString(flat(raw, "apiKey"));
	const configuredMode = asString(flat(raw, "runtimeMode")) ?? asString(flat(raw, "mode"));
	const runtimeMode: EffectiveConfig["runtimeMode"] = configuredMode === "local" || configuredMode === "docker" || configuredMode === "compose"
		? configuredMode
		: "external";
	const recallScope = flat(raw, "recallScope") === "project" ? "project" : "all";
	return {
		runtimeMode,
		...(externalUrl ? { externalUrl } : {}),
		...(apiKey ? { apiKey } : {}),
		dataDir: asString(flat(raw, "dataDir")) ?? CONFIG_DEFAULTS.dataDir,
		bank: asString(flat(raw, "bank")) ?? CONFIG_DEFAULTS.bank,
		namespace: asString(flat(raw, "namespace")) ?? CONFIG_DEFAULTS.namespace,
		recallScope,
		autoRecall: asBool(flat(raw, "autoRecall"), CONFIG_DEFAULTS.autoRecall),
		autoRetain: asBool(flat(raw, "autoRetain"), CONFIG_DEFAULTS.autoRetain),
		recallBudget: asNum(flat(raw, "recallBudget"), CONFIG_DEFAULTS.recallBudget),
		timeoutMs: asNum(flat(raw, "timeoutMs"), CONFIG_DEFAULTS.timeoutMs),
	};
}

/** The pack-side runtime settings adapter. It only maps the selected generic
 * runner; it never imports or controls the supervisor. */
export function runtimeModeFor(cfg: EffectiveConfig): ManagedRuntimeMode | undefined {
	return cfg.runtimeMode === "external" ? undefined : cfg.runtimeMode;
}

function readyRuntimeEndpoint(runtime?: RuntimeContext): string | undefined {
	return runtime?.state === "ready" && typeof runtime.endpoint === "string" && runtime.endpoint.trim().length > 0
		? runtime.endpoint
		: undefined;
}

/** External deployments need their configured URL; managed selections need a
 * ready injected endpoint. Neither branch starts, allocates, or controls a service. */
export function isActive(cfg: EffectiveConfig, runtime?: RuntimeContext): boolean {
	return cfg.runtimeMode === "external"
		? typeof cfg.externalUrl === "string" && cfg.externalUrl.trim().length > 0
		: readyRuntimeEndpoint(runtime) !== undefined;
}

/** A selected managed runtime is configured before it is ready. Read callers must
 * use isActive before constructing a client so unavailable services remain inert. */
export function isConfigured(cfg: EffectiveConfig): boolean {
	return cfg.runtimeMode !== "external" || (typeof cfg.externalUrl === "string" && cfg.externalUrl.trim().length > 0);
}

/** One client contract for external and all managed adapters: the client sees an
 * endpoint only, never an adapter mode. */
export function clientConfig(cfg: EffectiveConfig, runtime?: RuntimeContext): ClientConfig {
	const baseUrl = cfg.runtimeMode === "external" ? cfg.externalUrl : readyRuntimeEndpoint(runtime);
	return {
		baseUrl: (baseUrl ?? "").replace(/\/+$/, ""),
		...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
		namespace: cfg.namespace,
		timeoutMs: cfg.timeoutMs,
	};
}

// ── Pack-store helpers (shared by provider + routes; same pack-scoped store). ──
export interface StoreReadDiagnostic {
	/** Stable, path- and secret-free store diagnostic code. */
	code: string;
	retryable?: boolean;
	recoverable?: boolean;
}

export type StoreReadResult<T> =
	| { state: "absent" }
	| { state: "present"; value: T }
	| { state: "error"; diagnostic: StoreReadDiagnostic };

const UNAVAILABLE_READ_DIAGNOSTIC: StoreReadDiagnostic = { code: "STORE_READ_IO", retryable: true };

/** Pack-scoped durable-store capability. `get` remains legacy/lossy; durable
 * decisions must use `read`, which proves absence separately from failure. */
export interface StoreLike {
	get<T = unknown>(key: string): Promise<T | null>;
	read<T = unknown>(key: string): Promise<StoreReadResult<T>>;
	put<T = unknown>(key: string, value: T): Promise<void>;
	list?(prefix?: string): Promise<string[]>;
}

/** A transport failure is also unknown state. Do not expose its exception: the
 * host's structured diagnostic is preferred, and this fallback stays safe. */
export async function readStore<T>(store: StoreLike, key: string): Promise<StoreReadResult<T>> {
	try {
		return await store.read<T>(key);
	} catch {
		return { state: "error", diagnostic: UNAVAILABLE_READ_DIAGNOSTIC };
	}
}

export interface QueueEntry {
	content: string;
	tags: Tags;
	ts: number;
}

export const QUEUE_KEY = "retain-queue";
export const LAST_ERROR_KEY = "last-error";
// Must match src/server/agent/pack-contributions.ts::providerConfigStoreKey("memory").
// The host overlays this key over provider yaml defaults and evaluates
// activation.requiresConfig against it before bridge injection.
export const CONFIG_KEY = "provider-config:memory";
export const QUEUE_CAP = 100;

export type QueueLoadResult =
	| { loaded: true; queue: QueueEntry[]; source: "absent" | "present" }
	| { loaded: false; diagnostic: StoreReadDiagnostic };

const INVALID_QUEUE_DIAGNOSTIC: StoreReadDiagnostic = { code: "HINDSIGHT_QUEUE_INVALID", recoverable: true };

/** Load a queue snapshot. Store errors and invalid present values deliberately
 * remain unknown: no caller may replace them with an empty queue. */
export async function loadQueue(store: StoreLike): Promise<QueueLoadResult> {
	const result = await readStore<unknown>(store, QUEUE_KEY);
	if (result.state === "error") return { loaded: false, diagnostic: result.diagnostic };
	if (result.state === "absent") return { loaded: true, queue: [], source: "absent" };
	if (!Array.isArray(result.value)) return { loaded: false, diagnostic: INVALID_QUEUE_DIAGNOSTIC };
	return { loaded: true, queue: result.value as QueueEntry[], source: "present" };
}

/** Alias retained to make mutation call sites explicit. */
export async function loadQueueForMutation(store: StoreLike): Promise<QueueLoadResult> {
	return loadQueue(store);
}

export type QueueSaveResult = { durable: true } | { durable: false };

/** Persist a queue snapshot and report whether it was durably committed. */
export async function saveQueue(store: StoreLike, q: QueueEntry[]): Promise<QueueSaveResult> {
	try {
		await store.put(QUEUE_KEY, q);
		return { durable: true };
	} catch {
		return { durable: false };
	}
}

/** Append a failed retain; FIFO-evict the oldest beyond the cap (100).
 * A queue-read failure is not an empty queue: do not write a replacement. */
export async function enqueueRetain(store: StoreLike, entry: QueueEntry): Promise<QueueSaveResult> {
	const loaded = await loadQueueForMutation(store);
	if (!loaded.loaded) return { durable: false };
	const q = [...loaded.queue, entry];
	return saveQueue(store, q.length > QUEUE_CAP ? q.slice(-QUEUE_CAP) : q);
}

export async function recordError(store: StoreLike, e: unknown): Promise<void> {
	try {
		await store.put(LAST_ERROR_KEY, { message: messageOf(e), ts: Date.now() });
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
 *  An empty string clears an optional string (externalUrl/apiKey). Managed runtime
 *  secrets are descriptor-owned and deliberately have no provider-config key. */
export function validateConfigOverrides(body: unknown): ConfigValidation {
	if (!isObj(body)) return { ok: false, errors: ["body must be an object"] };
	const errors: string[] = [];
	const value: Record<string, unknown> = {};

	if ("runtimeMode" in body) {
		if (body.runtimeMode === "external" || body.runtimeMode === "local" || body.runtimeMode === "docker" || body.runtimeMode === "compose") value.runtimeMode = body.runtimeMode;
		else errors.push("runtimeMode must be 'external', 'local', 'docker', or 'compose'");
	}
	// Accept only the legacy external spelling while existing persisted config migrates.
	if ("mode" in body) {
		if (body.mode === "external") value.runtimeMode = "external";
		else errors.push("mode is obsolete; use runtimeMode");
	}
	for (const key of ["externalUrl", "apiKey"] as const) {
		if (key in body) {
			const v = body[key];
			if (typeof v === "string") value[key] = v; // "" clears
			else if (v === null) value[key] = "";
			else errors.push(`${key} must be a string`);
		}
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
	for (const key of ["autoRecall", "autoRetain"] as const) {
		if (key in body) {
			if (typeof body[key] === "boolean") value[key] = body[key];
			else errors.push(`${key} must be a boolean`);
		}
	}
	for (const key of ["recallBudget", "timeoutMs"] as const) {
		if (key in body) {
			const v = body[key];
			if (typeof v === "number" && Number.isFinite(v) && v > 0) value[key] = v;
			else errors.push(`${key} must be a positive number`);
		}
	}

	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Redact secrets for the `config` GET surface — apiKey collapses to a boolean. */
export function redactConfig(cfg: EffectiveConfig): Record<string, unknown> {
	const { apiKey, ...rest } = cfg;
	return {
		...rest,
		apiKeySet: typeof apiKey === "string" && apiKey.length > 0,
	};
}

/** Hindsight used to persist its managed-runtime LLM key in ordinary provider
 * config. The descriptor now owns that write-only resolver name, so a later
 * ordinary config update must also remove any legacy stored copy. */
function withoutLegacyRuntimeSecret(overrides: Record<string, unknown>): Record<string, unknown> {
	const { llmApiKey: _legacyRuntimeSecret, ...safeOverrides } = overrides;
	return safeOverrides;
}

export type EffectiveConfigLoadResult =
	| { available: true; config: EffectiveConfig; overrides: Record<string, unknown> }
	| { available: false; diagnostic: StoreReadDiagnostic };

const INVALID_CONFIG_DIAGNOSTIC: StoreReadDiagnostic = { code: "HINDSIGHT_CONFIG_INVALID", recoverable: true };

/** Load persisted config without ever treating an unreadable snapshot as defaults.
 * Defaults apply only to a proven store miss; a malformed present value remains
 * unavailable so a config SET cannot overwrite it. */
export async function loadEffectiveConfig(store: StoreLike): Promise<EffectiveConfigLoadResult> {
	const result = await readStore<unknown>(store, CONFIG_KEY);
	if (result.state === "error") return { available: false, diagnostic: result.diagnostic };
	if (result.state === "absent") return { available: true, config: resolveConfig(CONFIG_DEFAULTS), overrides: {} };
	if (!isObj(result.value)) return { available: false, diagnostic: INVALID_CONFIG_DIAGNOSTIC };
	const overrides = withoutLegacyRuntimeSecret(result.value);
	return {
		available: true,
		overrides,
		config: resolveConfig({ ...CONFIG_DEFAULTS, ...overrides }),
	};
}
