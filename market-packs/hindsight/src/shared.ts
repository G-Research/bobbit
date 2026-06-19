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
	apiKey?: string;
	/** External Postgres connection URL for `managed-external-postgres` mode. Maps
	 *  onto the runtime env HINDSIGHT_API_DATABASE_URL; never used in external mode. */
	externalDatabaseUrl?: string;
	/** Host bind-mount path for fully managed Postgres data (`managed` mode). */
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
	mode: "external",
	dataDir: "~/.hindsight",
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
	const externalDatabaseUrl = asString(flat(raw, "externalDatabaseUrl"));
	const recallScope = flat(raw, "recallScope") === "project" ? "project" : "all";
	return {
		mode: asString(flat(raw, "mode")) ?? CONFIG_DEFAULTS.mode,
		...(externalUrl ? { externalUrl } : {}),
		...(apiKey ? { apiKey } : {}),
		...(externalDatabaseUrl ? { externalDatabaseUrl } : {}),
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
}

export const QUEUE_KEY = "retain-queue";
export const LAST_ERROR_KEY = "last-error";
// Must match src/server/agent/pack-contributions.ts::providerConfigStoreKey("memory").
// The host overlays this key over provider yaml defaults and evaluates
// activation.requiresConfig against it before bridge injection.
export const CONFIG_KEY = "provider-config:memory";
export const QUEUE_CAP = 100;

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
	for (const key of ["externalUrl", "apiKey", "externalDatabaseUrl"] as const) {
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

/** Redact secrets for the `config` GET surface — every secret field collapses to a
 *  `<field>Set` boolean and the raw value is never echoed. */
export function redactConfig(cfg: EffectiveConfig): Record<string, unknown> {
	const { apiKey, externalDatabaseUrl, ...rest } = cfg;
	return {
		...rest,
		apiKeySet: typeof apiKey === "string" && apiKey.length > 0,
		externalDatabaseUrlSet: typeof externalDatabaseUrl === "string" && externalDatabaseUrl.length > 0,
	};
}

/** Effective config for the routes (store overrides over flat defaults). */
export async function loadEffectiveConfig(store: StoreLike): Promise<EffectiveConfig> {
	let stored: unknown;
	try {
		stored = await store.get(CONFIG_KEY);
	} catch {
		stored = undefined;
	}
	return resolveConfig({ ...CONFIG_DEFAULTS, ...(isObj(stored) ? stored : {}) });
}
