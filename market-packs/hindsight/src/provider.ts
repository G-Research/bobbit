// Hindsight lifecycle provider. Rich identity is derived exclusively from the
// host's immutable scopeContext snapshot; compatibility flat fields are never a
// fallback for project, goal, or role.
import {
	clientConfig, completedOutcomeRetention, detectLegacyQueue, documentId, enqueueRetain, isActive, isPendingEnvelope, isQueueEntry,
	loadQueue, makeClient, pendingKey, pendingPrefix, recordError, removeQueuedEntry, resolveConfig, sweepKey,
	tagsForRecord, truncate, updateRecord, type CompletedOutcomeRetention, type EffectiveConfig, type HindsightIdentity, type PendingEnvelope,
	type RuntimeContext, type ScopeProvenance, type StoreLike, type SweepControl, type Tags,
	DEFAULT_STRANDED_AFTER_MS, RETAIN_SWEEP_INTERVAL_MS,
} from "./shared.js";
export { __setClientFactory } from "./shared.js";

interface ScopeContext { project?: { id: string }; goal?: { id: string }; role?: string }
interface Deadline { deadlineEpochMs?: number; isExpired?: boolean }
interface ProviderCtx {
	sessionId?: string; prompt?: string; userText?: string; response?: string; assistantText?: string; summary?: string; span?: string;
	config?: unknown; runtime?: RuntimeContext;
	host?: { store?: StoreLike; memory?: { requireCapability(capability: "memory.read" | "memory.write"): Promise<void> | void } };
	scopeContext?: ScopeContext;
	signal?: AbortSignal; deadline?: Deadline; now?: number;
	/** Host-originated, already bounded outcome snapshot. */ outcome?: unknown; completedAt?: number; completionRevision?: string | number;
}
interface ContextBlock { id: string; title: string; authority: string; priority: number; reason: string; content: string }
const TITLE = "Relevant memory"; const SUMMARY_CAP = 2000;
const RETAIN_QUEUE_PERSISTENCE_ERROR = "HINDSIGHT_RETAIN_QUEUE_PERSISTENCE_FAILED";
const DRAIN_QUEUE_PERSISTENCE_ERROR = "HINDSIGHT_QUEUE_DRAIN_PERSISTENCE_FAILED";
const OUTCOME_NOT_DURABLE_ERROR = "HINDSIGHT_OUTCOME_NOT_DURABLE";
function storeOf(ctx: ProviderCtx): StoreLike | null { return ctx.host?.store ?? null; }
/** Live EP-6 grants are evaluated by the server-owned host adapter. A missing,
 * denied, or revoked adapter is deliberately a non-fatal no-op; automatic memory
 * work must never mutate a queue or contact a provider without its exact grant. */
async function hasMemoryCapability(ctx: ProviderCtx, capability: "memory.read" | "memory.write"): Promise<boolean> {
	const requireCapability = ctx.host?.memory?.requireCapability;
	// A lifecycle invocation without the live server adapter has no grant proof.
	// Fail closed before it can create a client, queue, or diagnostic record.
	if (!requireCapability) return false;
	try { await requireCapability(capability); return true; } catch { return false; }
}
function textOf(v: unknown): string | undefined { return typeof v === "string" && v.trim() ? v.trim() : undefined; }
async function recordAutomaticError(ctx: ProviderCtx, store: StoreLike, error: unknown): Promise<void> {
	if (await hasMemoryCapability(ctx, "memory.write")) await recordError(store, error);
}
function nowOf(ctx: ProviderCtx): number { return typeof ctx.now === "number" ? ctx.now : Date.now(); }
function deadlineOf(ctx: ProviderCtx): number | undefined { return ctx.deadline?.deadlineEpochMs; }
function canContinue(ctx: ProviderCtx, now = nowOf(ctx)): boolean { return !ctx.signal?.aborted && ctx.deadline?.isExpired !== true && (deadlineOf(ctx) === undefined || now < deadlineOf(ctx)!); }
/** The only scope accessor in this module. */
function scopeOf(ctx: ProviderCtx): ScopeProvenance | undefined {
	const projectId = textOf(ctx.scopeContext?.project?.id); if (!projectId) return undefined;
	return { projectId, ...(textOf(ctx.scopeContext?.goal?.id) ? { goalId: textOf(ctx.scopeContext?.goal?.id) } : {}), ...(textOf(ctx.sessionId) ? { sessionId: textOf(ctx.sessionId) } : {}), ...(textOf(ctx.scopeContext?.role) ? { role: textOf(ctx.scopeContext?.role) } : {}) };
}
function tagsFor(scope: ScopeProvenance, kind: "turn" | "compaction" | "outcome"): Tags { return tagsForRecord(scope, kind); }
function turnSummary(ctx: ProviderCtx): string { const p: string[] = []; const u = textOf(ctx.prompt) ?? textOf(ctx.userText); const a = textOf(ctx.response) ?? textOf(ctx.assistantText); if (u) p.push(`User: ${u}`); if (a) p.push(`Assistant: ${a}`); return p.join("\n\n").slice(0, SUMMARY_CAP); }
function compactSummary(ctx: ProviderCtx): string { return (textOf(ctx.summary) ?? textOf(ctx.span) ?? textOf(ctx.prompt) ?? "").slice(0, SUMMARY_CAP); }
function scopedClientConfig(cfg: EffectiveConfig, namespace: string, runtime?: RuntimeContext) { return { ...clientConfig(cfg, runtime), namespace }; }

async function doRecall(ctx: ProviderCtx, cfg: EffectiveConfig, query?: string): Promise<ContextBlock[]> {
	if (!cfg.autoRecall || !textOf(query)) return [];
	const scope = scopeOf(ctx); // Fail closed before constructing a client.
	if (!scope?.projectId || !canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.read")) return [];
	try {
		const client = await makeClient(clientConfig(cfg, ctx.runtime));
		// Client construction can yield to the event loop; the initial check above
		// is not authority for this disclosure.
		if (!canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.read")) return [];
		const res = await client.recall(cfg.bank, textOf(query)!, { maxTokens: cfg.recallBudget, tags: { project: scope.projectId, ...(scope.goalId ? { goal: scope.goalId } : {}) }, tagsMatch: "all_strict" });
		const memories = res?.memories ?? []; return memories.length ? [{ id: "memory:0", title: TITLE, authority: "memory", priority: 50, reason: `Recall for: ${truncate(textOf(query)!, 80)}`, content: memories.map(m => `- ${m.text}`).join("\n") }] : [];
	} catch (e) { const store = storeOf(ctx); if (store) await recordAutomaticError(ctx, store, e); return []; }
}

function pendingIdentity(scope: ScopeProvenance, cfg: EffectiveConfig): HindsightIdentity | undefined { return scope.sessionId ? { projectId: scope.projectId, ...(scope.goalId ? { goalId: scope.goalId } : {}), sessionId: scope.sessionId, bank: cfg.bank, namespace: cfg.namespace, kind: "pending" } : undefined; }
function pendingDue(record: PendingEnvelope, cfg: EffectiveConfig, now: number): boolean { return record.turns.length >= cfg.retainEveryNTurns || (!!record.turns[0] && now - record.turns[0].capturedAt >= cfg.retainMaxDelayMs); }
async function appendTurn(ctx: ProviderCtx, cfg: EffectiveConfig, summary: string): Promise<{ key: string; identity: HindsightIdentity } | undefined> {
	const store = storeOf(ctx); const scope = scopeOf(ctx); if (!store || !scope || !canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.write")) return undefined; const identity = pendingIdentity(scope, cfg); if (!identity) return undefined; const key = pendingKey(identity);
	const appended = await updateRecord<PendingEnvelope>(store, key, current => {
		if (current !== undefined && !isPendingEnvelope(current, identity)) return undefined;
		return current ? { ...current, turns: [...current.turns, { summary, capturedAt: nowOf(ctx) }], updatedAt: nowOf(ctx) } : { version: 2, identity, scope, turns: [{ summary, capturedAt: nowOf(ctx) }], overlap: [], updatedAt: nowOf(ctx), flushSeq: 0 };
	}, deadlineOf(ctx), ctx.signal);
	return appended.durable ? { key, identity } : undefined;
}
function eventIdentity(scope: ScopeProvenance, cfg: EffectiveConfig, kind: "turn" | "compaction" | "outcome", eventId: string, seq?: number): HindsightIdentity {
	return { projectId: scope.projectId, ...(scope.goalId ? { goalId: scope.goalId } : {}), sessionId: eventId, bank: cfg.bank, namespace: cfg.namespace, kind, ...(seq !== undefined ? { seq } : {}) };
}
async function queueRecord(store: StoreLike, scope: ScopeProvenance, identity: HindsightIdentity, content: string, tags: Tags, sync: boolean, ts: number, ctx: ProviderCtx): Promise<boolean> {
	if (!await hasMemoryCapability(ctx, "memory.write")) return false;
	return (await enqueueRetain(store, { version: 2, identity, scope, bank: identity.bank, namespace: identity.namespace, content, tags, ts, ...(sync ? { sync } : {}), documentId: documentId(identity) }, deadlineOf(ctx), ctx.signal)).durable;
}
/** Retain exactly the durable snapshot. Advancement happens only after remote
 * success or a confirmed queue append; an advance CAS failure intentionally leaves
 * a duplicate-eligible record rather than losing an appended suffix. */
async function flushPending(ctx: ProviderCtx, cfg: EffectiveConfig, key: string, identity: HindsightIdentity): Promise<boolean> {
	const store = storeOf(ctx); if (!store || !canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.write")) return false;
	const read = await store.read<unknown>(key); if (read.state !== "present" || !isPendingEnvelope(read.value, identity)) return false;
	const record = read.value; if (!record.turns.length) return true;
	const primary = record.turns.map(t => t.summary); const content = primary.join("\n\n").slice(0, SUMMARY_CAP * 4);
	const target = eventIdentity(record.scope, { ...cfg, bank: record.identity.bank, namespace: record.identity.namespace }, "turn", record.identity.sessionId, record.flushSeq ?? 0);
	let durableOutcome = false;
	try { if (!await hasMemoryCapability(ctx, "memory.write")) return false; const client = await makeClient(scopedClientConfig(cfg, record.identity.namespace, ctx.runtime)); if (!canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.write")) return false; await client.ensureBank(record.identity.bank); if (!canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.write")) return false; await client.retain(record.identity.bank, content, { tags: tagsFor(record.scope, "turn"), sync: false, id: documentId(target) }); durableOutcome = true; }
	catch (e) { durableOutcome = await queueRecord(store, record.scope, target, content, tagsFor(record.scope, "turn"), false, nowOf(ctx), ctx); if (!durableOutcome) { await recordAutomaticError(ctx, store, new Error("HINDSIGHT_QUEUE_UNAVAILABLE")); throw new Error(RETAIN_QUEUE_PERSISTENCE_ERROR); } await recordAutomaticError(ctx, store, e); }
	if (!durableOutcome || !canContinue(ctx)) return false;
	const processed = record.turns.map(t => `${t.capturedAt}\u0000${t.summary}`);
	if (!await hasMemoryCapability(ctx, "memory.write")) return false;
	const advanced = await updateRecord<PendingEnvelope>(store, key, current => {
		if (!isPendingEnvelope(current, identity)) return undefined;
		const currentPrefix = current.turns.slice(0, processed.length).map(t => `${t.capturedAt}\u0000${t.summary}`); if (currentPrefix.join("\u0001") !== processed.join("\u0001")) return undefined;
		return { ...current, turns: current.turns.slice(processed.length), overlap: primary.slice(-4), flushSeq: (current.flushSeq ?? 0) + 1, updatedAt: nowOf(ctx) };
	}, deadlineOf(ctx), ctx.signal);
	return advanced.durable;
}

function authorizedEntry(entry: unknown, projectId: string) {
	if (!isQueueEntry(entry) || entry.scope.projectId !== projectId || entry.identity.projectId !== projectId) return undefined;
	return entry;
}
async function drainQueueHead(store: StoreLike, cfg: EffectiveConfig, ctx: ProviderCtx): Promise<void> {
	const scope = scopeOf(ctx); if (!scope || !canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.write")) return;
	const loaded = await loadQueue(store, scope.projectId); if (!loaded.loaded) { await recordAutomaticError(ctx, store, new Error("HINDSIGHT_QUEUE_UNAVAILABLE")); return; }
	const entry = authorizedEntry(loaded.queue[0], scope.projectId); if (!entry) { if (loaded.queue[0] !== undefined) await recordAutomaticError(ctx, store, new Error("HINDSIGHT_QUEUE_UNAVAILABLE")); return; }
	try {
		if (!await hasMemoryCapability(ctx, "memory.write")) return; const client = await makeClient(scopedClientConfig(cfg, entry.namespace, ctx.runtime)); if (!canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.write")) return; await client.ensureBank(entry.bank); if (!canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.write")) return;
		await client.retain(entry.bank, entry.content, { tags: entry.tags, sync: entry.sync, id: entry.documentId });
		if (await hasMemoryCapability(ctx, "memory.write") && !await removeQueuedEntry(store, scope.projectId, entry, deadlineOf(ctx), ctx.signal)) await recordAutomaticError(ctx, store, new Error(DRAIN_QUEUE_PERSISTENCE_ERROR));
	} catch (e) { await recordAutomaticError(ctx, store, e); }
}
async function drainQueueAll(store: StoreLike, cfg: EffectiveConfig, ctx: ProviderCtx): Promise<void> {
	const scope = scopeOf(ctx); if (!scope || !canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.write")) return;
	const loaded = await loadQueue(store, scope.projectId); if (!loaded.loaded) { await recordAutomaticError(ctx, store, new Error("HINDSIGHT_QUEUE_UNAVAILABLE")); return; }
	for (const candidate of loaded.queue) {
		if (!canContinue(ctx)) return;
		const entry = authorizedEntry(candidate, scope.projectId); if (!entry) { if (candidate !== undefined) await recordAutomaticError(ctx, store, new Error("HINDSIGHT_QUEUE_UNAVAILABLE")); return; }
		try {
			if (!await hasMemoryCapability(ctx, "memory.write")) return; const client = await makeClient(scopedClientConfig(cfg, entry.namespace, ctx.runtime)); if (!canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.write")) return; await client.ensureBank(entry.bank); if (!canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.write")) return;
			await client.retain(entry.bank, entry.content, { tags: entry.tags, sync: entry.sync, id: entry.documentId });
			if (!await hasMemoryCapability(ctx, "memory.write") || !await removeQueuedEntry(store, scope.projectId, entry, deadlineOf(ctx), ctx.signal)) { await recordAutomaticError(ctx, store, new Error(DRAIN_QUEUE_PERSISTENCE_ERROR)); return; }
		} catch (e) { await recordAutomaticError(ctx, store, e); return; }
	}
}

/** Claim an injected-clock, durable, project-partitioned sweep lease. */
async function recoverStranded(ctx: ProviderCtx, cfg: EffectiveConfig): Promise<void> {
	const store = storeOf(ctx); const scope = scopeOf(ctx); const now = nowOf(ctx); const deadline = deadlineOf(ctx); if (!store || !scope || !store.list || !canContinue(ctx, now) || !await hasMemoryCapability(ctx, "memory.write")) return;
	if (await detectLegacyQueue(store)) await recordAutomaticError(ctx, store, new Error("HINDSIGHT_QUEUE_LEGACY_QUARANTINED"));
	if (!await hasMemoryCapability(ctx, "memory.write")) return;
	const controlKey = sweepKey(scope.projectId); const runId = `${now}-${scope.sessionId ?? "recovery"}`;
	const claimed = await updateRecord<SweepControl>(store, controlKey, current => {
		if (current !== undefined && (!current || current.version !== 2)) return undefined;
		if (current?.active && current.active.deadlineEpochMs > now) return undefined;
		const latest = Math.max(current?.lastCompletedAt ?? -Infinity, current?.lastAttemptedAt ?? -Infinity);
		if (latest !== -Infinity && now - latest < RETAIN_SWEEP_INTERVAL_MS) return undefined;
		return { version: 2, ...(current?.lastCompletedAt !== undefined ? { lastCompletedAt: current.lastCompletedAt } : {}), ...(current?.lastAttemptedAt !== undefined ? { lastAttemptedAt: current.lastAttemptedAt } : {}), ...(current?.checkpoint ? { checkpoint: current.checkpoint } : {}), active: { runId, startedAt: now, deadlineEpochMs: deadline ?? now + cfg.timeoutMs } };
	}, deadline, ctx.signal);
	if (!claimed.durable) return;
	let completed = true;
	try {
		const keys = (await store.list(pendingPrefix(scope.projectId))).sort();
		for (const key of keys) {
			if (!canContinue(ctx)) { completed = false; break; }
			const read = await store.read<unknown>(key); if (read.state !== "present" || !isPendingEnvelope(read.value)) { completed = false; continue; }
			const record = read.value;
			// A prefix is only a candidate selector. These complete checks prevent a
			// malformed/cross-project record from ever reaching a project endpoint.
			if (record.scope.projectId !== scope.projectId || record.identity.projectId !== scope.projectId || pendingKey(record.identity) !== key) { completed = false; continue; }
			const oldest = record.turns[0]?.capturedAt; if (oldest === undefined || now - oldest < Math.max(cfg.retainMaxDelayMs * 3, DEFAULT_STRANDED_AFTER_MS)) continue;
			try {
				const advanced = await flushPending(ctx, { ...cfg, bank: record.identity.bank, namespace: record.identity.namespace }, key, record.identity);
				if (!advanced) { completed = false; break; }
				if (!await hasMemoryCapability(ctx, "memory.write")) { completed = false; break; }
				const checkpointed = await updateRecord<SweepControl>(store, controlKey, control => control?.version === 2 && control.active?.runId === runId ? { ...control, checkpoint: { recordKey: key, updatedAt: now } } : undefined, deadline, ctx.signal);
				if (!checkpointed.durable) { completed = false; break; }
			} catch { completed = false; break; }
		}
	} catch { completed = false; }
	if (canContinue(ctx) && await hasMemoryCapability(ctx, "memory.write")) await updateRecord<SweepControl>(store, controlKey, control => {
		if (control?.version !== 2 || control.active?.runId !== runId) return undefined;
		return { version: 2, lastAttemptedAt: now, ...(completed ? { lastCompletedAt: now } : control.lastCompletedAt !== undefined ? { lastCompletedAt: control.lastCompletedAt } : {}), ...(control.checkpoint ? { checkpoint: control.checkpoint } : {}) };
	}, deadline, ctx.signal);
}

function completionRetention(ctx: ProviderCtx, scope: ScopeProvenance, cfg: EffectiveConfig): CompletedOutcomeRetention | undefined {
	return completedOutcomeRetention({ outcome: ctx.outcome, completionRevision: ctx.completionRevision, completedAt: ctx.completedAt }, scope, cfg);
}
/** A compaction's injected event time is the retry-stable per-session sequence.
 * It is encoded in the canonical identity so a queued replay uses the same id. */
function compactionEventSeq(ctx: ProviderCtx): number { const now = nowOf(ctx); return Number.isSafeInteger(now) && now >= 0 ? now : Date.now(); }
async function retainImmediate(ctx: ProviderCtx, cfg: EffectiveConfig, content: string, kind: "compaction" | "outcome", sync: boolean, completed?: CompletedOutcomeRetention): Promise<boolean> {
	const store = storeOf(ctx); const scope = scopeOf(ctx); if (!store || !scope || !canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.write")) return false;
	const seq = kind === "compaction" ? compactionEventSeq(ctx) : undefined;
	const eventId = scope.sessionId ?? `compaction:${seq}`;
	const identity = completed?.identity ?? eventIdentity(scope, cfg, kind, eventId, seq);
	const recordScope = completed?.scope ?? scope;
	const tags = completed?.tags ?? tagsFor(scope, kind);
	try { if (!await hasMemoryCapability(ctx, "memory.write")) return false; const client = await makeClient(clientConfig(cfg, ctx.runtime)); if (!canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.write")) return false; await client.ensureBank(cfg.bank); if (!canContinue(ctx) || !await hasMemoryCapability(ctx, "memory.write")) return false; await client.retain(cfg.bank, content, { tags, sync, id: completed?.documentId ?? documentId(identity) }); return true; }
	catch (e) { const queued = await queueRecord(store, recordScope, identity, content, tags, sync, nowOf(ctx), ctx); if (!queued) throw new Error(RETAIN_QUEUE_PERSISTENCE_ERROR); await recordAutomaticError(ctx, store, e); return true; }
}
const provider = {
	async sessionSetup(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> { const cfg = resolveConfig(ctx.config); if (!isActive(cfg, ctx.runtime)) return { blocks: [] }; await recoverStranded(ctx, cfg); return { blocks: await doRecall(ctx, cfg, ctx.prompt) }; },
	async beforePrompt(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> { const cfg = resolveConfig(ctx.config); return !isActive(cfg, ctx.runtime) ? { blocks: [] } : { blocks: await doRecall(ctx, cfg, ctx.prompt) }; },
	async afterTurn(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> { const cfg = resolveConfig(ctx.config); if (!isActive(cfg, ctx.runtime) || !cfg.autoRetain || !scopeOf(ctx)) return { blocks: [] }; const store = storeOf(ctx); if (!store) return { blocks: [] }; await drainQueueHead(store, cfg, ctx); const summary = turnSummary(ctx); const appended = summary ? await appendTurn(ctx, cfg, summary) : undefined; if (appended) { const read = await store.read<unknown>(appended.key); if (read.state === "present" && isPendingEnvelope(read.value, appended.identity) && pendingDue(read.value, cfg, nowOf(ctx))) await flushPending(ctx, cfg, appended.key, appended.identity); } return { blocks: [] }; },
	async beforeCompact(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> { const cfg = resolveConfig(ctx.config); const content = compactSummary(ctx); if (isActive(cfg, ctx.runtime) && cfg.autoRetain && content) await retainImmediate(ctx, cfg, content, "compaction", true); return { blocks: [] }; },
	async sessionShutdown(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> { const cfg = resolveConfig(ctx.config); if (isActive(cfg, ctx.runtime) && storeOf(ctx)) await drainQueueAll(storeOf(ctx)!, cfg, ctx); return { blocks: [] }; },
	async goalCompleted(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> { const cfg = resolveConfig(ctx.config); const scope = scopeOf(ctx); const completed = scope ? completionRetention(ctx, scope, cfg) : undefined; if (!await hasMemoryCapability(ctx, "memory.write")) return { blocks: [] }; if (!isActive(cfg, ctx.runtime) || !completed || !await retainImmediate(ctx, cfg, completed.content, "outcome", true, completed)) throw new Error(OUTCOME_NOT_DURABLE_ERROR); return { blocks: [] }; },
};
export default provider;
