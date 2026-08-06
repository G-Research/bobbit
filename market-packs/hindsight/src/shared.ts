// Shared durable mechanics for the Hindsight server pack.  Store reads are
// deliberately tri-state: an unreadable record is never treated as a miss.

export type Tags = Record<string, string>;
export type TagsMatch = "any" | "all" | "any_strict" | "all_strict";
export interface RecallMemory { text: string; score?: number; id?: string }
export interface HindsightClientLike {
	health(): Promise<{ ok: boolean }>;
	ensureBank(bank: string): Promise<void>;
	recall(bank: string, query: string, opts?: { maxTokens?: number; tags?: Tags; tagsMatch?: TagsMatch }): Promise<{ memories: RecallMemory[] }>;
	retain(bank: string, content: string, opts?: { tags?: Tags; sync?: boolean; id?: string }): Promise<void>;
	reflect(bank: string, prompt: string): Promise<{ text: string }>;
	listBanks(): Promise<{ banks: string[] }>;
}
export interface ClientConfig { baseUrl: string; apiKey?: string; namespace?: string; timeoutMs?: number }
export interface RuntimeContext { endpoint?: string; state: "stopped" | "starting" | "ready" | "degraded" | "blocked" | "unavailable"; diagnostic?: { code: string; retryAt?: string } }
export type ManagedRuntimeMode = "local" | "docker" | "compose";
export type ClientFactory = (cfg: ClientConfig) => HindsightClientLike | Promise<HindsightClientLike>;
let clientFactoryOverride: ClientFactory | null = null;
export function __setClientFactory(fn: ClientFactory | null): void { clientFactoryOverride = fn; }
export async function makeClient(cfg: ClientConfig): Promise<HindsightClientLike> {
	if (clientFactoryOverride) return clientFactoryOverride(cfg);
	const mod = await import("./hindsight-client.js") as { createClient: (c: ClientConfig) => HindsightClientLike };
	return mod.createClient(cfg);
}

export interface EffectiveConfig {
	runtimeMode: "external" | ManagedRuntimeMode; externalUrl?: string; apiKey?: string; dataDir: string;
	bank: string; namespace: string; recallScope: "project"; autoRecall: boolean; autoRetain: boolean;
	recallBudget: number; timeoutMs: number; retainEveryNTurns: number; retainMaxDelayMs: number;
}
export const CONFIG_DEFAULTS: EffectiveConfig = {
	runtimeMode: "external", dataDir: "${stateDir}/service-data/hindsight", bank: "bobbit", namespace: "default",
	recallScope: "project", autoRecall: true, autoRetain: true, recallBudget: 1200, timeoutMs: 1500,
	retainEveryNTurns: 1, retainMaxDelayMs: 60_000,
};
function isObj(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function flat(raw: unknown, key: string): unknown { const v = isObj(raw) ? raw[key] : undefined; return isObj(v) && "default" in v ? v.default : v; }
function asString(v: unknown): string | undefined { return typeof v === "string" && v.length > 0 ? v : undefined; }
function asBool(v: unknown, d: boolean): boolean { return typeof v === "boolean" ? v : d; }
function asNum(v: unknown, d: number): number { return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d; }
export function resolveConfig(raw: unknown): EffectiveConfig {
	const mode = asString(flat(raw, "runtimeMode")) ?? asString(flat(raw, "mode"));
	const runtimeMode: EffectiveConfig["runtimeMode"] = mode === "local" || mode === "docker" || mode === "compose" ? mode : "external";
	return { runtimeMode, ...(asString(flat(raw, "externalUrl")) ? { externalUrl: asString(flat(raw, "externalUrl")) } : {}), ...(asString(flat(raw, "apiKey")) ? { apiKey: asString(flat(raw, "apiKey")) } : {}),
		dataDir: asString(flat(raw, "dataDir")) ?? CONFIG_DEFAULTS.dataDir, bank: asString(flat(raw, "bank")) ?? CONFIG_DEFAULTS.bank,
		namespace: asString(flat(raw, "namespace")) ?? CONFIG_DEFAULTS.namespace, recallScope: "project", autoRecall: asBool(flat(raw, "autoRecall"), true), autoRetain: asBool(flat(raw, "autoRetain"), true),
		recallBudget: asNum(flat(raw, "recallBudget"), 1200), timeoutMs: asNum(flat(raw, "timeoutMs"), 1500),
		retainEveryNTurns: Math.max(1, Math.floor(asNum(flat(raw, "retainEveryNTurns"), CONFIG_DEFAULTS.retainEveryNTurns))), retainMaxDelayMs: asNum(flat(raw, "retainMaxDelayMs"), CONFIG_DEFAULTS.retainMaxDelayMs) };
}
export function runtimeModeFor(cfg: EffectiveConfig): ManagedRuntimeMode | undefined { return cfg.runtimeMode === "external" ? undefined : cfg.runtimeMode; }
function readyEndpoint(runtime?: RuntimeContext): string | undefined { return runtime?.state === "ready" && typeof runtime.endpoint === "string" && runtime.endpoint.trim() ? runtime.endpoint : undefined; }
export function isActive(cfg: EffectiveConfig, runtime?: RuntimeContext): boolean { return cfg.runtimeMode === "external" ? !!cfg.externalUrl?.trim() : readyEndpoint(runtime) !== undefined; }
export function isConfigured(cfg: EffectiveConfig): boolean { return cfg.runtimeMode !== "external" || !!cfg.externalUrl?.trim(); }
export function clientConfig(cfg: EffectiveConfig, runtime?: RuntimeContext): ClientConfig { const endpoint = cfg.runtimeMode === "external" ? (cfg.externalUrl ?? "") : (readyEndpoint(runtime) ?? ""); return { baseUrl: endpoint.replace(/\/+$/, ""), ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}), namespace: cfg.namespace, timeoutMs: cfg.timeoutMs }; }

export interface StoreReadDiagnostic { code: string; retryable?: boolean; recoverable?: boolean }
export type StoreReadResult<T> = { state: "absent" } | { state: "present"; value: T; version?: number } | { state: "error"; diagnostic: StoreReadDiagnostic };
export type StoreMutationResult<T> = { status: "committed" | "replayed"; committed: boolean; value: T; version: number } | { status: "conflict" | "rejected" | "aborted" | "error"; committed: false; diagnostic: StoreReadDiagnostic };
export interface StoreLike {
	get<T = unknown>(key: string): Promise<T | null>; read<T = unknown>(key: string): Promise<StoreReadResult<T>>; put<T = unknown>(key: string, value: T): Promise<void>;
	mutate?<T = unknown>(key: string, value: T, opts?: { expectedVersion?: number | null; deadlineEpochMs?: number; signal?: AbortSignal; idempotencyKey?: string }): Promise<StoreMutationResult<T>>;
	list?(prefix?: string): Promise<string[]>;
}
const READ_ERROR: StoreReadDiagnostic = { code: "STORE_READ_IO", retryable: true };
export async function readStore<T>(store: StoreLike, key: string): Promise<StoreReadResult<T>> { try { return await store.read<T>(key); } catch { return { state: "error", diagnostic: READ_ERROR }; } }
export const QUEUE_KEY = "retain-queue/v2"; export const LAST_ERROR_KEY = "last-error"; export const CONFIG_KEY = "provider-config:memory"; export const QUEUE_CAP = 100;
export const RETAIN_SWEEP_INTERVAL_MS = 60_000; export const DEFAULT_STRANDED_AFTER_MS = 5 * 60_000;

export interface ScopeProvenance { projectId: string; goalId?: string; sessionId?: string; role?: string }
export interface HindsightIdentity { projectId: string; goalId?: string; sessionId: string; bank: string; namespace: string; kind: "pending" | "outcome" | "queue" }
function required(v: string | undefined, name: string): string { if (!v || !v.length) throw new Error(`HINDSIGHT_IDENTITY_${name}_REQUIRED`); return v; }
/** Encodes each tuple part independently. Prefixes always end at a component boundary. */
function enc(v: string | undefined): string { return v === undefined ? "_" : encodeURIComponent(v); }
function dec(v: string): string | undefined { if (v === "_") return undefined; try { const out = decodeURIComponent(v); return out.length ? out : undefined; } catch { return undefined; } }
function identityParts(identity: HindsightIdentity): string[] { return [enc(required(identity.projectId, "PROJECT")), enc(identity.goalId), enc(required(identity.sessionId, "SESSION")), enc(required(identity.bank, "BANK")), enc(required(identity.namespace, "NAMESPACE")), enc(identity.kind)]; }
export function encodeIdentity(identity: HindsightIdentity): string { return `v2/p/${identityParts(identity).join("/")}`; }
export function pendingKey(identity: Omit<HindsightIdentity, "kind">): string { return `retain-pending/${encodeIdentity({ ...identity, kind: "pending" })}`; }
export function pendingPrefix(projectId?: string): string { return projectId ? `retain-pending/v2/p/${enc(projectId)}/` : "retain-pending/v2/p/"; }
export function documentId(identity: HindsightIdentity): string { return `hindsight/${encodeIdentity(identity)}`; }
export function decodePendingKey(key: string): HindsightIdentity | undefined {
	const m = /^retain-pending\/v2\/p\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(key); if (!m) return undefined;
	const [projectId, goalId, sessionId, bank, namespace, kind] = m.slice(1).map(dec);
	if (!projectId || !sessionId || !bank || !namespace || kind !== "pending") return undefined;
	return { projectId, ...(goalId ? { goalId } : {}), sessionId, bank, namespace, kind };
}
export interface PendingTurn { summary: string; capturedAt: number }
export interface PendingEnvelope { version: 2; identity: HindsightIdentity; scope: ScopeProvenance; turns: PendingTurn[]; overlap: string[]; updatedAt: number }
export interface QueueEntry { version: 2; identity: HindsightIdentity; scope: ScopeProvenance; bank: string; namespace: string; content: string; tags: Tags; ts: number; sync?: boolean; documentId: string }
function sameIdentity(a: HindsightIdentity, b: HindsightIdentity): boolean { return encodeIdentity(a) === encodeIdentity(b); }
export function isPendingEnvelope(v: unknown, expected?: HindsightIdentity): v is PendingEnvelope {
	if (!isObj(v) || v.version !== 2 || !Array.isArray(v.turns) || !Array.isArray(v.overlap) || !isObj(v.identity) || !isObj(v.scope)) return false;
	const i = v.identity as unknown as HindsightIdentity; const s = v.scope as unknown as ScopeProvenance;
	return i.kind === "pending" && typeof i.projectId === "string" && typeof i.sessionId === "string" && typeof i.bank === "string" && typeof i.namespace === "string" && typeof s.projectId === "string" && s.projectId === i.projectId && (!expected || sameIdentity(i, expected)) && v.turns.every(t => isObj(t) && typeof t.summary === "string" && typeof t.capturedAt === "number") && v.overlap.every(x => typeof x === "string");
}
export function isQueueEntry(v: unknown): v is QueueEntry { return isObj(v) && v.version === 2 && isObj(v.identity) && (v.identity as unknown as HindsightIdentity).kind === "queue" && typeof v.content === "string" && typeof v.bank === "string" && typeof v.namespace === "string" && isObj(v.tags) && isObj(v.scope) && typeof v.documentId === "string"; }
export type QueueLoadResult = { loaded: true; queue: unknown[]; source: "absent" | "present" } | { loaded: false; diagnostic: StoreReadDiagnostic };
export async function loadQueue(store: StoreLike): Promise<QueueLoadResult> { const result = await readStore<unknown>(store, QUEUE_KEY); if (result.state === "error") return { loaded: false, diagnostic: result.diagnostic }; if (result.state === "absent") return { loaded: true, queue: [], source: "absent" }; return Array.isArray(result.value) ? { loaded: true, queue: result.value, source: "present" } : { loaded: false, diagnostic: { code: "HINDSIGHT_QUEUE_INVALID", recoverable: true } }; }
export async function loadQueueForMutation(store: StoreLike): Promise<QueueLoadResult> { return loadQueue(store); }
export type QueueSaveResult = { durable: true } | { durable: false };
export async function saveQueue(store: StoreLike, q: unknown[]): Promise<QueueSaveResult> { try { await store.put(QUEUE_KEY, q); return { durable: true }; } catch { return { durable: false }; } }
/** #1091/#1106: a read failure or malformed present queue is never replaced.
 * Queue appends are fenced so two failed retains cannot overwrite each other. */
export async function enqueueRetain(store: StoreLike, entry: QueueEntry): Promise<QueueSaveResult> {
	const updated = await updateRecord<unknown[]>(store, QUEUE_KEY, current => {
		if (current !== undefined && !Array.isArray(current)) return undefined;
		const queue = [...(current ?? []), entry]; return queue.length > QUEUE_CAP ? queue.slice(-QUEUE_CAP) : queue;
	});
	return updated.durable ? { durable: true } : { durable: false };
}
export async function recordError(store: StoreLike, e: unknown): Promise<void> { try { await store.put(LAST_ERROR_KEY, { message: messageOf(e), ts: Date.now() }); } catch {} }
export function messageOf(e: unknown): string { return e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e); }
export function truncate(s: string, n: number): string { return s.length <= n ? s : `${s.slice(0, n - 1)}…`; }

/** A compare-and-swap mutation. Pre-mutation writes are refused for legacy records
 * without a durable version; silently overwriting such a record would violate H-1. */
export async function updateRecord<T>(store: StoreLike, key: string, change: (current: T | undefined) => T | undefined, deadline?: number, signal?: AbortSignal): Promise<{ durable: boolean; value?: T }> {
	for (let attempt = 0; attempt < 4; attempt++) {
		const read = await readStore<T>(store, key); if (read.state === "error") return { durable: false };
		if (deadline !== undefined && Date.now() >= deadline || signal?.aborted) return { durable: false };
		const current = read.state === "present" ? read.value : undefined; const next = change(current); if (next === undefined) return { durable: false };
		if (!store.mutate) { // old hosts do not provide a fence; retain the safer no-write behavior for present state.
			if (read.state === "present") return { durable: false }; try { await store.put(key, next); return { durable: true, value: next }; } catch { return { durable: false }; }
		}
		// A present value written with legacy put has no fence version. Never turn
		// that unknown concurrent state into an unconditional mutate.
		if (read.state === "present" && read.version === undefined) return { durable: false };
		const result = await store.mutate(key, next, { expectedVersion: read.state === "absent" ? null : read.version, ...(deadline !== undefined ? { deadlineEpochMs: deadline } : {}), ...(signal ? { signal } : {}) });
		if (result.status === "committed" || result.status === "replayed") return { durable: true, value: result.value as T };
		if (result.status !== "conflict") return { durable: false };
	}
	return { durable: false };
}
export interface SweepControl { version: 2; active?: { runId: string; startedAt: number; deadlineEpochMs: number }; lastCompletedAt?: number; checkpoint?: { recordKey: string; updatedAt: number } }
export const SWEEP_KEY = "retain-sweep/v2/control";
export function sweepDue(control: SweepControl | undefined, now: number): boolean { return !control?.active && (control?.lastCompletedAt === undefined || now - control.lastCompletedAt >= RETAIN_SWEEP_INTERVAL_MS); }

export interface ConfigValidation { ok: boolean; value?: Record<string, unknown>; errors?: string[] }
export function validateConfigOverrides(body: unknown): ConfigValidation {
	if (!isObj(body)) return { ok: false, errors: ["body must be an object"] }; const value: Record<string, unknown> = {}; const errors: string[] = [];
	if ("runtimeMode" in body) { if (["external", "local", "docker", "compose"].includes(String(body.runtimeMode))) value.runtimeMode = body.runtimeMode; else errors.push("runtimeMode must be 'external', 'local', 'docker', or 'compose'"); }
	if ("mode" in body) { if (body.mode === "external") value.runtimeMode = "external"; else errors.push("mode is obsolete; use runtimeMode"); }
	for (const key of ["externalUrl", "apiKey"] as const) if (key in body) typeof body[key] === "string" || body[key] === null ? value[key] = body[key] ?? "" : errors.push(`${key} must be a string`);
	for (const key of ["bank", "namespace", "dataDir"] as const) if (key in body) typeof body[key] === "string" && body[key].trim() ? value[key] = body[key].trim() : errors.push(`${key} must be a non-empty string`);
	if ("recallScope" in body) errors.push("recallScope is fixed to 'project'");
	for (const key of ["autoRecall", "autoRetain"] as const) if (key in body) typeof body[key] === "boolean" ? value[key] = body[key] : errors.push(`${key} must be a boolean`);
	for (const key of ["recallBudget", "timeoutMs", "retainEveryNTurns", "retainMaxDelayMs"] as const) if (key in body) typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] > 0 ? value[key] = body[key] : errors.push(`${key} must be a positive number`);
	return errors.length ? { ok: false, errors } : { ok: true, value };
}
export function redactConfig(cfg: EffectiveConfig): Record<string, unknown> { const { apiKey, ...rest } = cfg; return { ...rest, apiKeySet: !!apiKey }; }
export type EffectiveConfigLoadResult = { available: true; config: EffectiveConfig; overrides: Record<string, unknown> } | { available: false; diagnostic: StoreReadDiagnostic };
export async function loadEffectiveConfig(store: StoreLike): Promise<EffectiveConfigLoadResult> { const result = await readStore<unknown>(store, CONFIG_KEY); if (result.state === "error") return { available: false, diagnostic: result.diagnostic }; if (result.state === "absent") return { available: true, config: resolveConfig(CONFIG_DEFAULTS), overrides: {} }; if (!isObj(result.value)) return { available: false, diagnostic: { code: "HINDSIGHT_CONFIG_INVALID", recoverable: true } }; const { llmApiKey: _legacy, ...overrides } = result.value; return { available: true, overrides, config: resolveConfig({ ...CONFIG_DEFAULTS, ...overrides }) }; }
