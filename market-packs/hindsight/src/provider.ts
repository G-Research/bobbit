// Hindsight lifecycle provider. Rich identity is derived exclusively from the
// host's immutable scopeContext snapshot; compatibility flat fields are never a
// fallback for project, goal, or role.
import {
	clientConfig, documentId, enqueueRetain, isActive, isPendingEnvelope, isQueueEntry,
	loadQueue, makeClient, pendingKey, pendingPrefix, recordError, resolveConfig, saveQueue,
	truncate, updateRecord, type EffectiveConfig, type HindsightIdentity, type PendingEnvelope,
	type RuntimeContext, type ScopeProvenance, type StoreLike, type SweepControl, type Tags,
	DEFAULT_STRANDED_AFTER_MS, RETAIN_SWEEP_INTERVAL_MS, SWEEP_KEY,
} from "./shared.js";
export { __setClientFactory } from "./shared.js";

interface ScopeContext { project?: { id: string }; goal?: { id: string }; role?: string }
interface Deadline { deadlineEpochMs?: number; isExpired?: boolean }
interface ProviderCtx {
	sessionId?: string; prompt?: string; userText?: string; response?: string; assistantText?: string; summary?: string; span?: string;
	config?: unknown; runtime?: RuntimeContext; host?: { store?: StoreLike }; scopeContext?: ScopeContext;
	signal?: AbortSignal; deadline?: Deadline; now?: number;
	/** Host-originated, already bounded outcome snapshot. */ outcome?: unknown; completedAt?: number;
}
interface ContextBlock { id: string; title: string; authority: string; priority: number; reason: string; content: string }
const TITLE = "Relevant memory"; const SUMMARY_CAP = 2000;
const RETAIN_QUEUE_PERSISTENCE_ERROR = "HINDSIGHT_RETAIN_QUEUE_PERSISTENCE_FAILED";
const DRAIN_QUEUE_PERSISTENCE_ERROR = "HINDSIGHT_QUEUE_DRAIN_PERSISTENCE_FAILED";
function storeOf(ctx: ProviderCtx): StoreLike | null { return ctx.host?.store ?? null; }
function textOf(v: unknown): string | undefined { return typeof v === "string" && v.trim() ? v.trim() : undefined; }
function nowOf(ctx: ProviderCtx): number { return typeof ctx.now === "number" ? ctx.now : Date.now(); }
function deadlineOf(ctx: ProviderCtx): number | undefined { return ctx.deadline?.deadlineEpochMs; }
function canContinue(ctx: ProviderCtx, now = nowOf(ctx)): boolean { return !ctx.signal?.aborted && ctx.deadline?.isExpired !== true && (deadlineOf(ctx) === undefined || now < deadlineOf(ctx)!); }
/** The only scope accessor in this module. */
function scopeOf(ctx: ProviderCtx): ScopeProvenance | undefined {
	const projectId = textOf(ctx.scopeContext?.project?.id); if (!projectId) return undefined;
	return { projectId, ...(textOf(ctx.scopeContext?.goal?.id) ? { goalId: textOf(ctx.scopeContext?.goal?.id) } : {}), ...(textOf(ctx.sessionId) ? { sessionId: textOf(ctx.sessionId) } : {}), ...(textOf(ctx.scopeContext?.role) ? { role: textOf(ctx.scopeContext?.role) } : {}) };
}
function tagsFor(scope: ScopeProvenance, kind: "turn" | "compaction" | "outcome"): Tags { return { kind, project: scope.projectId, ...(scope.goalId ? { goal: scope.goalId } : {}), ...(scope.role ? { agent: scope.role } : {}), ...(scope.sessionId ? { session: scope.sessionId } : {}) }; }
function turnSummary(ctx: ProviderCtx): string { const p: string[] = []; const u = textOf(ctx.prompt) ?? textOf(ctx.userText); const a = textOf(ctx.response) ?? textOf(ctx.assistantText); if (u) p.push(`User: ${u}`); if (a) p.push(`Assistant: ${a}`); return p.join("\n\n").slice(0, SUMMARY_CAP); }
function compactSummary(ctx: ProviderCtx): string { return (textOf(ctx.summary) ?? textOf(ctx.span) ?? textOf(ctx.prompt) ?? "").slice(0, SUMMARY_CAP); }
function scopedClientConfig(cfg: EffectiveConfig, namespace: string, runtime?: RuntimeContext) { return { ...clientConfig(cfg, runtime), namespace }; }

async function doRecall(ctx: ProviderCtx, cfg: EffectiveConfig, query?: string): Promise<ContextBlock[]> {
	if (!cfg.autoRecall || !textOf(query)) return [];
	const scope = scopeOf(ctx); // Fail closed before constructing a client.
	if (!scope?.projectId || !canContinue(ctx)) return [];
	try {
		const res = await (await makeClient(clientConfig(cfg, ctx.runtime))).recall(cfg.bank, textOf(query)!, { maxTokens: cfg.recallBudget, tags: { project: scope.projectId, ...(scope.goalId ? { goal: scope.goalId } : {}) }, tagsMatch: "all_strict" });
		const memories = res?.memories ?? []; return memories.length ? [{ id: "memory:0", title: TITLE, authority: "memory", priority: 50, reason: `Recall for: ${truncate(textOf(query)!, 80)}`, content: memories.map(m => `- ${m.text}`).join("\n") }] : [];
	} catch (e) { const store = storeOf(ctx); if (store) await recordError(store, e); return []; }
}

function pendingIdentity(scope: ScopeProvenance, cfg: EffectiveConfig): HindsightIdentity | undefined { return scope.sessionId ? { projectId: scope.projectId, ...(scope.goalId ? { goalId: scope.goalId } : {}), sessionId: scope.sessionId, bank: cfg.bank, namespace: cfg.namespace, kind: "pending" } : undefined; }
function pendingDue(record: PendingEnvelope, cfg: EffectiveConfig, now: number): boolean { return record.turns.length >= cfg.retainEveryNTurns || (!!record.turns[0] && now - record.turns[0].capturedAt >= cfg.retainMaxDelayMs); }
async function appendTurn(ctx: ProviderCtx, cfg: EffectiveConfig, summary: string): Promise<{ key: string; identity: HindsightIdentity } | undefined> {
	const scope = scopeOf(ctx); if (!scope || !canContinue(ctx)) return undefined; const identity = pendingIdentity(scope, cfg); if (!identity) return undefined; const key = pendingKey(identity);
	const appended = await updateRecord<PendingEnvelope>(storeOf(ctx)!, key, current => {
		if (current !== undefined && !isPendingEnvelope(current, identity)) return undefined;
		return current ? { ...current, turns: [...current.turns, { summary, capturedAt: nowOf(ctx) }], updatedAt: nowOf(ctx) } : { version: 2, identity, scope, turns: [{ summary, capturedAt: nowOf(ctx) }], overlap: [], updatedAt: nowOf(ctx) };
	}, deadlineOf(ctx), ctx.signal);
	return appended.durable ? { key, identity } : undefined;
}
async function queueRecord(store: StoreLike, scope: ScopeProvenance, cfg: EffectiveConfig, content: string, tags: Tags, kind: "turn" | "compaction" | "outcome", sync: boolean, ts: number): Promise<boolean> {
	const identity: HindsightIdentity = { projectId: scope.projectId, ...(scope.goalId ? { goalId: scope.goalId } : {}), sessionId: scope.sessionId ?? `detached-${ts}`, bank: cfg.bank, namespace: cfg.namespace, kind: "queue" };
	return (await enqueueRetain(store, { version: 2, identity, scope, bank: cfg.bank, namespace: cfg.namespace, content, tags, ts, ...(sync ? { sync } : {}), documentId: documentId({ ...identity, kind: kind === "outcome" ? "outcome" : "queue" }) })).durable;
}
/** Retain exactly the durable snapshot. Advancement happens only after remote
 * success or a confirmed queue append; an advance CAS failure intentionally leaves
 * a duplicate-eligible record rather than losing an appended suffix. */
async function flushPending(ctx: ProviderCtx, cfg: EffectiveConfig, key: string, identity: HindsightIdentity): Promise<boolean> {
	const store = storeOf(ctx); if (!store || !canContinue(ctx)) return false;
	const read = await store.read<unknown>(key); if (read.state !== "present" || !isPendingEnvelope(read.value, identity)) return false;
	const record = read.value; if (!record.turns.length) return true;
	const primary = record.turns.map(t => t.summary); const content = [...record.overlap, ...primary].join("\n\n").slice(0, SUMMARY_CAP * 4);
	let durableOutcome = false;
	try { const client = await makeClient(scopedClientConfig(cfg, record.identity.namespace, ctx.runtime)); if (!canContinue(ctx)) return false; await client.ensureBank(record.identity.bank); if (!canContinue(ctx)) return false; await client.retain(record.identity.bank, content, { tags: tagsFor(record.scope, "turn"), sync: false, id: documentId(record.identity) }); durableOutcome = true; }
	catch (e) { durableOutcome = await queueRecord(store, record.scope, { ...cfg, bank: record.identity.bank, namespace: record.identity.namespace }, content, tagsFor(record.scope, "turn"), "turn", false, nowOf(ctx)); if (!durableOutcome) { await recordError(store, e); throw new Error(RETAIN_QUEUE_PERSISTENCE_ERROR); } await recordError(store, e); }
	if (!durableOutcome || !canContinue(ctx)) return false;
	const processed = record.turns.map(t => `${t.capturedAt}\u0000${t.summary}`);
	const advanced = await updateRecord<PendingEnvelope>(store, key, current => {
		if (!isPendingEnvelope(current, identity)) return undefined;
		const currentPrefix = current.turns.slice(0, processed.length).map(t => `${t.capturedAt}\u0000${t.summary}`); if (currentPrefix.join("\u0001") !== processed.join("\u0001")) return undefined;
		return { ...current, turns: current.turns.slice(processed.length), overlap: primary.slice(-4), updatedAt: nowOf(ctx) };
	}, deadlineOf(ctx), ctx.signal);
	return advanced.durable;
}

async function drainQueueHead(store: StoreLike, cfg: EffectiveConfig, ctx: ProviderCtx): Promise<void> {
	const loaded = await loadQueue(store); if (!loaded.loaded) { await recordError(store, new Error("HINDSIGHT_QUEUE_UNAVAILABLE")); return; }
	const entry = loaded.queue[0]; if (!entry) return;
	if (!isQueueEntry(entry)) { await recordError(store, new Error("HINDSIGHT_QUEUE_UNAVAILABLE")); return; } // v1 has insufficient target provenance.
	try { const client = await makeClient(scopedClientConfig(cfg, entry.namespace, ctx.runtime)); if (!canContinue(ctx)) return; await client.ensureBank(entry.bank); await client.retain(entry.bank, entry.content, { tags: entry.tags, sync: entry.sync, id: entry.documentId }); const saved = await saveQueue(store, loaded.queue.slice(1)); if (!saved.durable) await recordError(store, new Error(DRAIN_QUEUE_PERSISTENCE_ERROR)); } catch (e) { await recordError(store, e); }
}
async function drainQueueAll(store: StoreLike, cfg: EffectiveConfig, ctx: ProviderCtx): Promise<void> {
	const loaded = await loadQueue(store); if (!loaded.loaded) { await recordError(store, new Error("HINDSIGHT_QUEUE_UNAVAILABLE")); return; }
	let remaining: unknown[] = [];
	for (const entry of loaded.queue) {
		if (!isQueueEntry(entry) || !canContinue(ctx)) { remaining.push(entry); continue; }
		try { const client = await makeClient(scopedClientConfig(cfg, entry.namespace, ctx.runtime)); await client.ensureBank(entry.bank); await client.retain(entry.bank, entry.content, { tags: entry.tags, sync: entry.sync, id: entry.documentId }); } catch { remaining.push(entry); }
	}
	if (!(await saveQueue(store, remaining)).durable) await recordError(store, new Error(DRAIN_QUEUE_PERSISTENCE_ERROR));
}

/** Claim an injected-clock, durable sweep lease. */
async function recoverStranded(ctx: ProviderCtx, cfg: EffectiveConfig): Promise<void> {
	const store = storeOf(ctx); const now = nowOf(ctx); const deadline = deadlineOf(ctx); if (!store || !store.list || !canContinue(ctx, now)) return;
	const runId = `${now}-${ctx.sessionId ?? "recovery"}`;
	const claimed = await updateRecord<SweepControl>(store, SWEEP_KEY, current => {
		if (current !== undefined && (!current || current.version !== 2)) return undefined;
		if (current?.active && current.active.deadlineEpochMs > now) return undefined;
		if (current?.lastCompletedAt !== undefined && now - current.lastCompletedAt < RETAIN_SWEEP_INTERVAL_MS) return undefined;
		return { version: 2, ...(current?.lastCompletedAt !== undefined ? { lastCompletedAt: current.lastCompletedAt } : {}), ...(current?.checkpoint ? { checkpoint: current.checkpoint } : {}), active: { runId, startedAt: now, deadlineEpochMs: deadline ?? now + cfg.timeoutMs } };
	}, deadline, ctx.signal);
	if (!claimed.durable) return;
	let completed = true;
	try {
		const keys = (await store.list(pendingPrefix())).sort();
		// Prefix matches are never authorization: each candidate is read, decoded,
		// and compared to its complete canonical identity below.
		for (const key of keys) {
			if (!canContinue(ctx)) { completed = false; break; }
			const read = await store.read<unknown>(key); if (read.state !== "present" || !isPendingEnvelope(read.value)) { completed = false; continue; }
			const record = read.value; if (pendingKey(record.identity) !== key) { completed = false; continue; }
			const oldest = record.turns[0]?.capturedAt; if (oldest === undefined || now - oldest < Math.max(cfg.retainMaxDelayMs * 3, DEFAULT_STRANDED_AFTER_MS)) continue;
			try { const advanced = await flushPending(ctx, { ...cfg, bank: record.identity.bank, namespace: record.identity.namespace }, key, record.identity); if (!advanced) { completed = false; break; }
				const checkpointed = await updateRecord<SweepControl>(store, SWEEP_KEY, control => control?.version === 2 && control.active?.runId === runId ? { ...control, checkpoint: { recordKey: key, updatedAt: now } } : undefined, deadline, ctx.signal); if (!checkpointed.durable) { completed = false; break; }
			} catch { completed = false; break; }
		}
	} catch { completed = false; }
	if (completed && canContinue(ctx)) await updateRecord<SweepControl>(store, SWEEP_KEY, control => control?.version === 2 && control.active?.runId === runId ? { version: 2, lastCompletedAt: now, ...(control.checkpoint ? { checkpoint: control.checkpoint } : {}) } : undefined, deadline, ctx.signal);
}

function outcomeSummary(ctx: ProviderCtx): string { const raw = typeof ctx.outcome === "string" ? ctx.outcome : JSON.stringify(ctx.outcome ?? {}); return `Goal outcome\n${raw}`.slice(0, 8_000); }
async function retainImmediate(ctx: ProviderCtx, cfg: EffectiveConfig, content: string, kind: "compaction" | "outcome", sync: boolean): Promise<boolean> {
	const store = storeOf(ctx); const scope = scopeOf(ctx); if (!store || !scope || !canContinue(ctx)) return false;
	try { const client = await makeClient(clientConfig(cfg, ctx.runtime)); await client.ensureBank(cfg.bank); if (!canContinue(ctx)) return false; const id: HindsightIdentity = { projectId: scope.projectId, ...(scope.goalId ? { goalId: scope.goalId } : {}), sessionId: scope.sessionId ?? `goal-${nowOf(ctx)}`, bank: cfg.bank, namespace: cfg.namespace, kind: kind === "outcome" ? "outcome" : "queue" }; await client.retain(cfg.bank, content, { tags: tagsFor(scope, kind), sync, id: documentId(id) }); return true; }
	catch (e) { const queued = await queueRecord(store, scope, cfg, content, tagsFor(scope, kind), kind, sync, nowOf(ctx)); if (!queued) throw new Error(RETAIN_QUEUE_PERSISTENCE_ERROR); await recordError(store, e); return true; }
}
const provider = {
	async sessionSetup(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> { const cfg = resolveConfig(ctx.config); if (!isActive(cfg, ctx.runtime)) return { blocks: [] }; await recoverStranded(ctx, cfg); return { blocks: await doRecall(ctx, cfg, ctx.prompt) }; },
	async beforePrompt(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> { const cfg = resolveConfig(ctx.config); return !isActive(cfg, ctx.runtime) ? { blocks: [] } : { blocks: await doRecall(ctx, cfg, ctx.prompt) }; },
	async afterTurn(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> { const cfg = resolveConfig(ctx.config); if (!isActive(cfg, ctx.runtime) || !cfg.autoRetain || !scopeOf(ctx)) return { blocks: [] }; const store = storeOf(ctx); if (!store) return { blocks: [] }; await drainQueueHead(store, cfg, ctx); const summary = turnSummary(ctx); const appended = summary ? await appendTurn(ctx, cfg, summary) : undefined; if (appended) { const read = await store.read<unknown>(appended.key); if (read.state === "present" && isPendingEnvelope(read.value, appended.identity) && pendingDue(read.value, cfg, nowOf(ctx))) await flushPending(ctx, cfg, appended.key, appended.identity); } return { blocks: [] }; },
	async beforeCompact(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> { const cfg = resolveConfig(ctx.config); const content = compactSummary(ctx); if (isActive(cfg, ctx.runtime) && cfg.autoRetain && content) await retainImmediate(ctx, cfg, content, "compaction", true); return { blocks: [] }; },
	async sessionShutdown(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> { const cfg = resolveConfig(ctx.config); if (isActive(cfg, ctx.runtime) && storeOf(ctx)) await drainQueueAll(storeOf(ctx)!, cfg, ctx); return { blocks: [] }; },
	async goalCompleted(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> { const cfg = resolveConfig(ctx.config); const content = outcomeSummary(ctx); if (!isActive(cfg, ctx.runtime) || !scopeOf(ctx)?.goalId || !content) return { blocks: [] }; await retainImmediate(ctx, cfg, content, "outcome", true); return { blocks: [] }; },
};
export default provider;
