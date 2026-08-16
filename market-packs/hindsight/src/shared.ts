// Shared durable mechanics for the Hindsight server pack. Store reads are
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
	browse?(bank: string, opts?: { query?: string; cursor?: string; limit?: number; tags?: Tags; tagsMatch?: TagsMatch }): Promise<{ memories: Record<string, unknown>[]; cursor?: string }>;
	detail?(bank: string, id: string): Promise<Record<string, unknown> | null>;
	history?(bank: string, id: string): Promise<{ history: Record<string, unknown>[] }>;
	reflectScoped?(bank: string, prompt: string, opts: { tags?: Tags; tagsMatch?: TagsMatch }): Promise<{ text: string }>;
	invalidateMemory?(bank: string, id: string, opts?: { tags?: Tags; tagsMatch?: TagsMatch; reason?: string }): Promise<void>;
	invalidate?(bank: string, id: string, opts?: { tags?: Tags; tagsMatch?: TagsMatch; reason?: string }): Promise<void>;
}
export interface ClientConfig { baseUrl: string; apiKey?: string; namespace?: string; timeoutMs?: number; signal?: AbortSignal }
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
/** The external service bearer token is never a managed-runtime credential. */
export function clientConfig(cfg: EffectiveConfig, runtime?: RuntimeContext): ClientConfig {
	const external = cfg.runtimeMode === "external";
	const endpoint = external ? (cfg.externalUrl ?? "") : (readyEndpoint(runtime) ?? "");
	return {
		baseUrl: endpoint.replace(/\/+$/, ""),
		...(external && cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
		namespace: cfg.namespace,
		timeoutMs: cfg.timeoutMs,
	};
}

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
/** Legacy unpartitioned v2 key. It is diagnostic-only and is never replayed. */
export const QUEUE_KEY = "retain-queue/v2";
export const QUEUE_PREFIX = "retain-queue/v3/";
export const LAST_ERROR_KEY = "last-error"; export const CONFIG_KEY = "provider-config:memory"; export const QUEUE_CAP = 100;
export const RETAIN_SWEEP_INTERVAL_MS = 60_000; export const DEFAULT_STRANDED_AFTER_MS = 5 * 60_000;

export interface ScopeProvenance { projectId: string; goalId?: string; sessionId?: string; role?: string }
export type HindsightKind = "pending" | "turn" | "compaction" | "outcome" | "queue";
export interface HindsightIdentity { projectId: string; goalId?: string; sessionId: string; bank: string; namespace: string; kind: HindsightKind; seq?: number }
function required(v: string | undefined, name: string): string { if (!v || !v.length) throw new Error(`HINDSIGHT_IDENTITY_${name}_REQUIRED`); return v; }
/** Tagged components make absence injectively distinct from every present string. */
function enc(v: string | undefined): string { return v === undefined ? "n" : `s${encodeURIComponent(v)}`; }
function dec(v: string): string | undefined { if (v === "n") return undefined; if (!v.startsWith("s")) return undefined; try { const out = decodeURIComponent(v.slice(1)); return out.length ? out : undefined; } catch { return undefined; } }
function encSeq(seq: number | undefined): string { return seq === undefined ? "n" : `i${seq}`; }
function decSeq(v: string): number | undefined { if (v === "n") return undefined; if (!/^i(?:0|[1-9]\d*)$/.test(v)) return undefined; const n = Number(v.slice(1)); return Number.isSafeInteger(n) ? n : undefined; }
function validKind(v: unknown): v is HindsightKind { return v === "pending" || v === "turn" || v === "compaction" || v === "outcome" || v === "queue"; }
function identityParts(identity: HindsightIdentity): string[] { return [enc(required(identity.projectId, "PROJECT")), enc(identity.goalId), enc(required(identity.sessionId, "SESSION")), enc(required(identity.bank, "BANK")), enc(required(identity.namespace, "NAMESPACE")), enc(identity.kind), encSeq(identity.seq)]; }
export function encodeIdentity(identity: HindsightIdentity): string { return `v2/p/${identityParts(identity).join("/")}`; }
export function pendingKey(identity: Omit<HindsightIdentity, "kind" | "seq">): string { return `retain-pending/${encodeIdentity({ ...identity, kind: "pending" })}`; }
export function pendingPrefix(projectId?: string): string { return projectId ? `retain-pending/v2/p/${enc(projectId)}/` : "retain-pending/v2/p/"; }
export function queueKey(projectId: string): string { return `${QUEUE_PREFIX}${enc(required(projectId, "PROJECT"))}`; }
export function sweepKey(projectId: string): string { return `retain-sweep/v3/${enc(required(projectId, "PROJECT"))}`; }
export function documentId(identity: HindsightIdentity): string { return `hindsight/${encodeIdentity(identity)}`; }
export function decodePendingKey(key: string): HindsightIdentity | undefined {
	const m = /^retain-pending\/v2\/p\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(key); if (!m) return undefined;
	const [projectId, goalId, sessionId, bank, namespace, kind] = m.slice(1, 7).map(dec); const seq = decSeq(m[7]);
	if (!projectId || !sessionId || !bank || !namespace || kind !== "pending" || seq !== undefined) return undefined;
	return { projectId, ...(goalId ? { goalId } : {}), sessionId, bank, namespace, kind };
}
function validScope(v: unknown): v is ScopeProvenance { return isObj(v) && typeof v.projectId === "string" && !!v.projectId && (v.goalId === undefined || typeof v.goalId === "string" && !!v.goalId) && (v.sessionId === undefined || typeof v.sessionId === "string" && !!v.sessionId) && (v.role === undefined || typeof v.role === "string" && !!v.role); }
function validIdentity(v: unknown): v is HindsightIdentity { return isObj(v) && typeof v.projectId === "string" && !!v.projectId && (v.goalId === undefined || typeof v.goalId === "string" && !!v.goalId) && typeof v.sessionId === "string" && !!v.sessionId && typeof v.bank === "string" && !!v.bank && typeof v.namespace === "string" && !!v.namespace && validKind(v.kind) && (v.seq === undefined || typeof v.seq === "number" && Number.isSafeInteger(v.seq) && v.seq >= 0); }
function sameOptional(a: string | undefined, b: string | undefined): boolean { return a === b; }
function sameIdentity(a: HindsightIdentity, b: HindsightIdentity): boolean { return encodeIdentity(a) === encodeIdentity(b); }
function scopeMatchesIdentity(scope: ScopeProvenance, identity: HindsightIdentity, strictSession: boolean): boolean {
	if (scope.projectId !== identity.projectId || !sameOptional(scope.goalId, identity.goalId)) return false;
	if (scope.sessionId !== undefined) return scope.sessionId === identity.sessionId;
	// Host-only completion/compaction records have no session provenance. Their
	// deterministic event identity is still required before a queue can replay.
	return !strictSession && ((identity.kind === "outcome" && identity.sessionId.startsWith("goal-completion:")) || (identity.kind === "compaction" && identity.sessionId.startsWith("compaction:")));
}
export interface PendingTurn { summary: string; capturedAt: number }
export interface PendingEnvelope { version: 2; identity: HindsightIdentity; scope: ScopeProvenance; turns: PendingTurn[]; overlap: string[]; updatedAt: number; flushSeq?: number }
export interface QueueEntry { version: 2; identity: HindsightIdentity; scope: ScopeProvenance; bank: string; namespace: string; content: string; tags: Tags; ts: number; sync?: boolean; documentId: string }
export function isPendingEnvelope(v: unknown, expected?: HindsightIdentity): v is PendingEnvelope {
	if (!isObj(v) || v.version !== 2 || !Array.isArray(v.turns) || !Array.isArray(v.overlap) || !validIdentity(v.identity) || !validScope(v.scope) || typeof v.updatedAt !== "number" || !Number.isFinite(v.updatedAt)) return false;
	const i = v.identity; const s = v.scope;
	return i.kind === "pending" && i.seq === undefined && scopeMatchesIdentity(s, i, true) && (!expected || sameIdentity(i, expected)) && (v.flushSeq === undefined || typeof v.flushSeq === "number" && Number.isSafeInteger(v.flushSeq) && v.flushSeq >= 0) && v.turns.every(t => isObj(t) && typeof t.summary === "string" && typeof t.capturedAt === "number" && Number.isFinite(t.capturedAt)) && v.overlap.every(x => typeof x === "string");
}
export function tagsForRecord(scope: ScopeProvenance, kind: "turn" | "compaction" | "outcome"): Tags { return { kind, project: scope.projectId, ...(scope.goalId ? { goal: scope.goalId } : {}), ...(scope.role ? { agent: scope.role } : {}), ...(scope.sessionId ? { session: scope.sessionId } : {}) }; }

export interface CompletedOutcomeRetention {
	content: string;
	identity: HindsightIdentity;
	documentId: string;
	tags: Tags;
	scope: ScopeProvenance;
}

function outcomeText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Render the server-owned completion snapshot once for both lifecycle delivery
 * and the explicit route. It deliberately accepts the older flat shape as a
 * migration compatibility input, but never receives a request body. */
export function completionOutcomeSummary(outcome: unknown): string | undefined {
	const lines = ["Goal outcome"];
	const add = (label: string, value: unknown, cap = 480) => {
		const valueText = typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
		if (valueText) lines.push(`${label}: ${truncate(valueText.replace(/\s+/g, " "), cap)}`);
	};
	const addItems = (label: "Task" | "Gate", items: unknown) => {
		if (!Array.isArray(items)) return;
		for (const item of items.slice(0, 100)) if (isObj(item)) {
			add(label, [item.title ?? item.name ?? item.id, item.state ?? item.status, item.resultSummary ?? item.summary ?? item.content].filter(value => typeof value === "string" && value.trim()).join(" — "));
		}
	};
	if (typeof outcome === "string") add("Summary", outcome, 7_600);
	else if (isObj(outcome)) {
		const goal = outcome.goal;
		if (isObj(goal)) {
			const before = lines.length;
			add("Goal title", goal.title);
			add("Goal state", goal.state);
			add("Goal spec", goal.spec);
			if (lines.length === before) add("Goal", goal.id ?? "completed");
		} else {
			for (const key of ["title", "state", "spec", "summary", "content", "result", "decision", "completedAt"]) add(key[0]!.toUpperCase() + key.slice(1), outcome[key]);
		}
		addItems("Task", outcome.tasks);
		addItems("Gate", outcome.gates);
	}
	let result = "";
	for (const line of lines) {
		if (result.length + line.length + 1 > 8_000) break;
		result += `${result ? "\n" : ""}${line}`;
	}
	return result === "Goal outcome" ? undefined : result;
}

function completionRevision(input: unknown): string | undefined {
	if (!isObj(input)) return undefined;
	const revision = outcomeText(input.completionRevision)
		?? (typeof input.completionRevision === "number" && Number.isFinite(input.completionRevision) ? String(input.completionRevision) : undefined)
		?? (typeof input.completedAt === "number" && Number.isFinite(input.completedAt) ? String(input.completedAt) : undefined)
		// Older host snapshots used an outcome id. It remains host-only and is
		// treated as a revision, never passed through as a document id.
		?? outcomeText(input.outcomeId)
		?? outcomeText(input.id);
	return revision ? `goal-completion:${revision}` : undefined;
}

/** Derive the one stable completion document identity shared by lifecycle and
 * route retention. Outcome documents intentionally omit session/role tags: a
 * goal completion belongs to its project and goal, not the panel session that
 * happened to request an idempotent replay. */
export function completedOutcomeRetention(
	input: unknown,
	scope: Pick<ScopeProvenance, "projectId" | "goalId">,
	config: Pick<EffectiveConfig, "bank" | "namespace">,
): CompletedOutcomeRetention | undefined {
	if (!scope.projectId || !scope.goalId) return undefined;
	const envelope = isObj(input) && "outcome" in input ? input : undefined;
	const outcome = envelope ? envelope.outcome : input;
	const eventId = completionRevision(envelope ?? input);
	const content = completionOutcomeSummary(outcome);
	if (!eventId || !content) return undefined;
	const outcomeScope: ScopeProvenance = { projectId: scope.projectId, goalId: scope.goalId };
	const identity: HindsightIdentity = { projectId: outcomeScope.projectId, goalId: outcomeScope.goalId, sessionId: eventId, bank: config.bank, namespace: config.namespace, kind: "outcome" };
	return { content, identity, documentId: documentId(identity), tags: tagsForRecord(outcomeScope, "outcome"), scope: outcomeScope };
}

export function isQueueEntry(v: unknown): v is QueueEntry {
	if (!isObj(v) || v.version !== 2 || !validIdentity(v.identity) || !validScope(v.scope) || typeof v.bank !== "string" || typeof v.namespace !== "string" || typeof v.content !== "string" || !isObj(v.tags) || typeof v.ts !== "number" || !Number.isFinite(v.ts) || typeof v.documentId !== "string" || (v.sync !== undefined && typeof v.sync !== "boolean")) return false;
	const i = v.identity; if (i.kind !== "turn" && i.kind !== "compaction" && i.kind !== "outcome") return false;
	const kind = i.kind; return v.bank === i.bank && v.namespace === i.namespace && scopeMatchesIdentity(v.scope, i, false) && v.documentId === documentId(i) && JSON.stringify(v.tags) === JSON.stringify(tagsForRecord(v.scope, kind));
}
export type QueueLoadResult = { loaded: true; queue: unknown[]; source: "absent" | "present"; key: string } | { loaded: false; diagnostic: StoreReadDiagnostic };
/** Without a project this reads only the legacy queue for status/diagnostics. */
export async function loadQueue(store: StoreLike, projectId?: string): Promise<QueueLoadResult> {
	const key = projectId ? queueKey(projectId) : QUEUE_KEY; const result = await readStore<unknown>(store, key);
	if (result.state === "error") return { loaded: false, diagnostic: result.diagnostic }; if (result.state === "absent") return { loaded: true, queue: [], source: "absent", key };
	return Array.isArray(result.value) ? { loaded: true, queue: result.value, source: "present", key } : { loaded: false, diagnostic: { code: "HINDSIGHT_QUEUE_INVALID", recoverable: true } };
}
/** A legacy global queue is intentionally never replayed under a project endpoint. */
export async function detectLegacyQueue(store: StoreLike): Promise<boolean> { const q = await loadQueue(store); return q.loaded && q.source === "present" && q.queue.length > 0; }
export type QueueSaveResult = { durable: true } | { durable: false };
/** Compatibility helper; production retry decisions use enqueue/remove below. */
export async function saveQueue(store: StoreLike, q: unknown[]): Promise<QueueSaveResult> { try { await store.put(QUEUE_KEY, q); return { durable: true }; } catch { return { durable: false }; } }
/** #1091/#1106: appends are fenced and partitioned by their captured project. */
export async function enqueueRetain(store: StoreLike, entry: QueueEntry, deadline?: number, signal?: AbortSignal): Promise<QueueSaveResult> {
	if (!isQueueEntry(entry)) return { durable: false };
	const updated = await updateRecord<unknown[]>(store, queueKey(entry.scope.projectId), current => {
		if (current !== undefined && !Array.isArray(current)) return undefined;
		const queue = [...(current ?? []), entry]; return queue.length > QUEUE_CAP ? queue.slice(-QUEUE_CAP) : queue;
	}, deadline, signal);
	return updated.durable ? { durable: true } : { durable: false };
}
/** Remove precisely a remotely replayed entry, retaining concurrent appended suffixes. */
export async function removeQueuedEntry(store: StoreLike, projectId: string, entry: QueueEntry, deadline?: number, signal?: AbortSignal): Promise<boolean> {
	if (!isQueueEntry(entry)) return false;
	const fingerprint = JSON.stringify(entry);
	const updated = await updateRecord<unknown[]>(store, queueKey(projectId), current => {
		if (!Array.isArray(current) || JSON.stringify(current[0]) !== fingerprint) return undefined;
		return current.slice(1);
	}, deadline, signal);
	return updated.durable;
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
		if (!store.mutate) { if (read.state === "present") return { durable: false }; try { await store.put(key, next); return { durable: true, value: next }; } catch { return { durable: false }; } }
		if (read.state === "present" && read.version === undefined) return { durable: false };
		let result: StoreMutationResult<T>;
		try { result = await store.mutate(key, next, { expectedVersion: read.state === "absent" ? null : read.version, ...(deadline !== undefined ? { deadlineEpochMs: deadline } : {}), ...(signal ? { signal } : {}) }); }
		catch { return { durable: false }; }
		if (result.status === "committed" || result.status === "replayed") return { durable: true, value: result.value as T };
		if (result.status !== "conflict") return { durable: false };
	}
	return { durable: false };
}
export interface SweepControl { version: 2; active?: { runId: string; startedAt: number; deadlineEpochMs: number }; lastCompletedAt?: number; lastAttemptedAt?: number; checkpoint?: { recordKey: string; updatedAt: number } }
/** Retained only for compatibility; all production sweep records are project-partitioned. */
export const SWEEP_KEY = "retain-sweep/v2/control";
/** A malformed record is quarantined and retried on cadence, not on every setup. */
export function sweepDue(control: SweepControl | undefined, now: number): boolean { const latest = Math.max(control?.lastCompletedAt ?? -Infinity, control?.lastAttemptedAt ?? -Infinity); return !control?.active && (latest === -Infinity || now - latest >= RETAIN_SWEEP_INTERVAL_MS); }

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
