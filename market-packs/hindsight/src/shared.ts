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
	const recallScope = flat(raw, "recallScope") === "project" ? "project" : "all";
	return {
		mode: asString(flat(raw, "mode")) ?? CONFIG_DEFAULTS.mode,
		...(externalUrl ? { externalUrl } : {}),
		...(apiKey ? { apiKey } : {}),
		bank: asString(flat(raw, "bank")) ?? CONFIG_DEFAULTS.bank,
		namespace: asString(flat(raw, "namespace")) ?? CONFIG_DEFAULTS.namespace,
		recallScope,
		autoRecall: asBool(flat(raw, "autoRecall"), CONFIG_DEFAULTS.autoRecall),
		autoRetain: asBool(flat(raw, "autoRetain"), CONFIG_DEFAULTS.autoRetain),
		recallBudget: asNum(flat(raw, "recallBudget"), CONFIG_DEFAULTS.recallBudget),
		timeoutMs: asNum(flat(raw, "timeoutMs"), CONFIG_DEFAULTS.timeoutMs),
	};
}

/** The dormancy gate (the central invariant): active ONLY in external mode with a
 *  non-empty URL. Inactive ⇒ every hook is a no-op and no client is constructed. */
export function isActive(cfg: EffectiveConfig): boolean {
	return cfg.mode === "external" && typeof cfg.externalUrl === "string" && cfg.externalUrl.trim().length > 0;
}

/** Same gate phrased for the routes' "configured" surface. */
export function isConfigured(cfg: EffectiveConfig): boolean {
	return isActive(cfg);
}

export function clientConfig(cfg: EffectiveConfig): ClientConfig {
	return {
		baseUrl: (cfg.externalUrl ?? "").replace(/\/+$/, ""),
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
		if (body.mode === "external" || body.mode === "managed") value.mode = body.mode;
		else errors.push("mode must be 'external' or 'managed'");
	}
	for (const key of ["externalUrl", "apiKey"] as const) {
		if (key in body) {
			const v = body[key];
			if (typeof v === "string") value[key] = v; // "" clears
			else if (v === null) value[key] = "";
			else errors.push(`${key} must be a string`);
		}
	}
	for (const key of ["bank", "namespace"] as const) {
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
	return { ...rest, apiKeySet: typeof apiKey === "string" && apiKey.length > 0 };
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
