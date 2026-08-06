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

/** Runtime defaults. `mode` remains only for an old PackStore fallback: the
 * project-scoped generic declaration in providers/memory.yaml is external-only. */
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
// This is a legacy PackStore fallback only. Generic project settings never write
// this key; the pack routes may read it solely for migration diagnostics.
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

// ── Legacy PackStore fallback diagnostics ─────────────────────────────────────
// The generic settings API owns validation, mutation, secret storage, and runtime
// composition. Hindsight retains this read-only helper so pre-settings installs
// can be diagnosed without copying their global configuration into a project.
export type LegacyConfigDiagnosticResult =
	| { available: true; config: EffectiveConfig; overrides: Record<string, unknown> }
	| { available: false; diagnostic: StoreReadDiagnostic };

const INVALID_CONFIG_DIAGNOSTIC: StoreReadDiagnostic = { code: "HINDSIGHT_CONFIG_INVALID", recoverable: true };

/** Read the old persisted config without ever treating an unreadable snapshot as
 * defaults. This is only for migration diagnostics; provider runtime receives the
 * generic effective project configuration through `ctx.config`. */
export async function loadLegacyConfigForDiagnostics(store: StoreLike): Promise<LegacyConfigDiagnosticResult> {
	const result = await readStore<unknown>(store, CONFIG_KEY);
	if (result.state === "error") return { available: false, diagnostic: result.diagnostic };
	if (result.state === "absent") return { available: true, config: resolveConfig(CONFIG_DEFAULTS), overrides: {} };
	if (!isObj(result.value)) return { available: false, diagnostic: INVALID_CONFIG_DIAGNOSTIC };
	return {
		available: true,
		overrides: result.value,
		config: resolveConfig({ ...CONFIG_DEFAULTS, ...result.value }),
	};
}
