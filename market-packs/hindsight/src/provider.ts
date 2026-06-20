// Hindsight memory lifecycle provider (Extension Platform G2.1/G2.2, external
// mode). Runs on the Extension Host worker tier (per-hook, stateless): it reads
// merged flat config from `ctx.config`, constructs a REST client per hook, and
// keeps all durable state (retry queue, last error) in the pack-scoped
// `ctx.host.store`. See docs/design/hindsight-pack-external.md §5.
//
// DORMANCY (the central invariant): unless `mode === "external"` AND `externalUrl`
// is a non-empty string, EVERY hook returns immediately — `{ blocks: [] }` for the
// recall hooks, a no-op for the retain hooks — and constructs NO client and touches
// NO network. This is the defensive backstop; the host's
// `activation.requiresConfig: [externalUrl]` is the primary guarantee that an
// unconfigured pack contributes no active provider at all.

import {
	applyBankMission,
	buildAggregateContent,
	clampRecallQuery,
	clearError,
	clientConfig,
	enqueueRetain,
	isActive,
	loadPending,
	loadQueue,
	makeClient,
	nextOverlap,
	overlayProjectConfig,
	recallTagFilter,
	recordError,
	resolveConfig,
	savePending,
	saveQueue,
	shouldFlushPending,
	truncate,
	type EffectiveConfig,
	type PendingBuffer,
	type QueueEntry,
	type RuntimeContext,
	type StoreLike,
	type Tags,
} from "./shared.js";

// Re-exported so unit tests may inject a fake client through the provider module.
export { __setClientFactory } from "./shared.js";

/** The (permissive) lifecycle hook context. Only the fields the provider reads are
 *  declared; the host passes a superset. `host.store` arrives via the provider
 *  store capability (design §1.3). Turn/compaction TEXT fields are read
 *  defensively — the provider uses whatever the host supplies. */
interface ProviderCtx {
	sessionId?: string;
	projectId?: string;
	goalId?: string;
	roleName?: string;
	prompt?: string;
	userText?: string;
	response?: string;
	assistantText?: string;
	summary?: string;
	span?: string;
	config?: unknown;
	/** Managed-runtime context injected by the host for ACTIVE managed Hindsight
	 *  invocations (design § deployment modes). Absent in external mode and
	 *  whenever the managed runtime is not running — the provider then stays dormant
	 *  and NEVER starts Docker itself. */
	runtime?: RuntimeContext;
	host?: { store?: StoreLike };
}

interface ContextBlock {
	id: string;
	title: string;
	authority: string;
	priority: number;
	reason: string;
	content: string;
}

const TITLE = "Relevant memory";
const SUMMARY_CAP = 2000;

function getStore(ctx: ProviderCtx): StoreLike | null {
	return ctx?.host?.store ?? null;
}

function projectIdOf(ctx: ProviderCtx): string | undefined {
	return ctx.projectId !== undefined ? String(ctx.projectId) : undefined;
}

function sessionIdOf(ctx: ProviderCtx): string | undefined {
	const s = ctx.sessionId !== undefined ? String(ctx.sessionId).trim() : "";
	return s.length > 0 ? s : undefined;
}

/** Resolve the effective config for a hook: the host-merged `ctx.config`
 *  (server/global base) with the per-project overlay (safe memory-quality keys)
 *  layered on top. Activation/dormancy is gated on the BASE elsewhere; the overlay
 *  never changes mode/externalUrl. */
async function effectiveConfig(ctx: ProviderCtx, base: EffectiveConfig): Promise<EffectiveConfig> {
	return overlayProjectConfig(base, getStore(ctx), projectIdOf(ctx));
}

function textOf(v: unknown): string | undefined {
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** Auto-tag taxonomy (the agent never hand-tags). Undefined values are omitted. */
function autoTags(ctx: ProviderCtx, kind: "turn" | "compaction"): Tags {
	const tags: Tags = { kind };
	if (ctx.projectId) tags.project = String(ctx.projectId);
	if (ctx.goalId) tags.goal = String(ctx.goalId);
	if (ctx.roleName) tags.agent = String(ctx.roleName);
	if (ctx.sessionId) tags.session = String(ctx.sessionId);
	return tags;
}

function buildTurnSummary(ctx: ProviderCtx): string {
	const parts: string[] = [];
	const user = textOf(ctx.prompt) ?? textOf(ctx.userText);
	const assistant = textOf(ctx.response) ?? textOf(ctx.assistantText);
	if (user) parts.push(`User: ${user}`);
	if (assistant) parts.push(`Assistant: ${assistant}`);
	const joined = parts.join("\n\n").trim();
	return joined ? joined.slice(0, SUMMARY_CAP) : "";
}

function buildCompactSummary(ctx: ProviderCtx): string {
	const text = textOf(ctx.summary) ?? textOf(ctx.span) ?? textOf(ctx.prompt);
	return text ? text.slice(0, SUMMARY_CAP) : "";
}

async function doRecall(ctx: ProviderCtx, cfg: EffectiveConfig, query: string | undefined): Promise<ContextBlock[]> {
	if (!cfg.autoRecall) return [];
	const q = (query ?? "").trim();
	if (!q) return [];

	// Project scope maps to a project-tagged + (with tagsMatch `any`) untagged/global
	// filter on the shared bank; `any_strict` excludes global; `all` scope sends none.
	const filter = recallTagFilter(cfg.recallScope, projectIdOf(ctx), cfg.tagsMatch);
	const store = getStore(ctx);
	// Clamp the query to avoid the data plane's 500-token "Query too long" 400.
	const clampedQuery = clampRecallQuery(q, cfg.recallMaxInputChars);
	try {
		const client = await makeClient(clientConfig(cfg, ctx.runtime));
		const res = await client.recall(cfg.bank, clampedQuery, {
			maxTokens: cfg.recallBudget,
			types: cfg.recallTypes,
			...(filter ? { tags: filter.tags, tagsMatch: filter.tagsMatch } : {}),
		});
		if (store) await clearError(store);
		const memories = res?.memories ?? [];
		if (memories.length === 0) return [];
		return [
			{
				id: "memory:0",
				title: TITLE,
				authority: "memory",
				priority: 50,
				reason: `Recall for: ${truncate(q, 80)}`,
				content: memories.map((m) => `- ${m.text}`).join("\n"),
			},
		];
	} catch (e) {
		if (store) await recordError(store, e);
		return [];
	}
}

/** Replay ONE queued entry into the bank/namespace it was ORIGINALLY routed to
 *  (captured at enqueue) — never the current hook's (possibly per-project-
 *  overridden) `cfg.bank`, so a failed retain can never cross banks/projects.
 *  Entries queued before the `bank`/`namespace` fields existed fall back to the
 *  current cfg. Throws on failure so callers can decide whether to requeue. */
async function retainQueueEntry(store: StoreLike, cfg: EffectiveConfig, runtime: RuntimeContext | undefined, entry: QueueEntry): Promise<void> {
	const bank = entry.bank ?? cfg.bank;
	const namespace = entry.namespace ?? cfg.namespace;
	// Effective cfg pinned to the entry's target so ensureBank + mission + retain all
	// agree on the ORIGINAL bank/namespace (deployment fields are server-global and
	// unchanged by the per-project overlay, so reusing cfg's baseUrl/auth is correct).
	const targetCfg: EffectiveConfig = { ...cfg, bank, namespace };
	const cc = clientConfig(cfg, runtime);
	const client = await makeClient(cc.namespace === namespace ? cc : { ...cc, namespace });
	await client.ensureBank(bank);
	await applyBankMission(store, client, targetCfg);
	await client.retain(bank, entry.content, { tags: entry.tags, sync: false });
}

/** Retry the queue HEAD (one entry) before the turn's own retain. */
async function drainQueueHead(store: StoreLike, cfg: EffectiveConfig, runtime?: RuntimeContext): Promise<void> {
	const q = await loadQueue(store);
	if (q.length === 0) return;
	const head = q[0];
	try {
		await retainQueueEntry(store, cfg, runtime, head);
		q.shift();
		await saveQueue(store, q);
	} catch (e) {
		await recordError(store, e); // leave the head for a later attempt
	}
}

/** Best-effort ONE-PASS drain of the whole queue (sessionShutdown). Each entry is
 *  replayed into its OWN captured bank/namespace (a queue may mix banks across
 *  per-project overrides), so a failed entry never lands in another project's bank. */
async function drainQueueAll(store: StoreLike, cfg: EffectiveConfig, runtime?: RuntimeContext): Promise<void> {
	const q = await loadQueue(store);
	if (q.length === 0) return;
	const remaining: QueueEntry[] = [];
	for (const entry of q) {
		try {
			await retainQueueEntry(store, cfg, runtime, entry);
		} catch {
			remaining.push(entry);
		}
	}
	await saveQueue(store, remaining);
}

async function retainWithQueue(ctx: ProviderCtx, cfg: EffectiveConfig, summary: string, kind: "turn" | "compaction", sync: boolean): Promise<void> {
	const store = getStore(ctx);
	const tags = autoTags(ctx, kind);
	try {
		const client = await makeClient(clientConfig(cfg, ctx.runtime));
		await client.ensureBank(cfg.bank);
		await applyBankMission(store, client, cfg);
		await client.retain(cfg.bank, summary, { tags, sync });
		if (store) await clearError(store);
	} catch (e) {
		if (store) {
			await enqueueRetain(store, { content: summary, tags, ts: Date.now(), bank: cfg.bank, namespace: cfg.namespace });
			await recordError(store, e);
		}
	}
}

/** Flush the durable per-session pending buffer as ONE aggregate retain (overlap
 *  context + every pending primary turn). On success the sticky error is cleared;
 *  on failure the aggregate is durably queued for retry (never dropped). EITHER
 *  way the buffer is advanced: the last `retainOverlapTurns` summaries are carried
 *  forward as bounded overlap and the primary turns are cleared so the count
 *  advances. No-op for an empty buffer. */
async function flushPending(ctx: ProviderCtx, cfg: EffectiveConfig, store: StoreLike, sessionId: string, sync: boolean): Promise<void> {
	const buf = await loadPending(store, sessionId);
	if (buf.turns.length === 0) return;
	const content = buildAggregateContent(buf);
	const tags = autoTags(ctx, "turn");
	try {
		const client = await makeClient(clientConfig(cfg, ctx.runtime));
		await client.ensureBank(cfg.bank);
		await applyBankMission(store, client, cfg);
		await client.retain(cfg.bank, content, { tags, sync });
		await clearError(store);
	} catch (e) {
		await enqueueRetain(store, { content, tags, ts: Date.now(), bank: cfg.bank, namespace: cfg.namespace });
		await recordError(store, e);
	}
	// Advance the buffer regardless of success (failures are durably queued): carry
	// bounded overlap forward, clear the primary turns so the count advances.
	const overlap = nextOverlap(buf.turns, cfg.retainOverlapTurns);
	await savePending(store, sessionId, { turns: [], overlap });
}

const provider = {
	async sessionSetup(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> {
		const base = resolveConfig(ctx.config);
		if (!isActive(base, ctx.runtime)) return { blocks: [] };
		const cfg = await effectiveConfig(ctx, base);
		return { blocks: await doRecall(ctx, cfg, ctx.prompt) };
	},

	async beforePrompt(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> {
		const base = resolveConfig(ctx.config);
		if (!isActive(base, ctx.runtime)) return { blocks: [] };
		const cfg = await effectiveConfig(ctx, base);
		return { blocks: await doRecall(ctx, cfg, ctx.prompt) };
	},

	async afterTurn(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> {
		const base = resolveConfig(ctx.config);
		if (!isActive(base, ctx.runtime) || !base.autoRetain) return { blocks: [] };
		const cfg = await effectiveConfig(ctx, base);
		const store = getStore(ctx);
		if (store) await drainQueueHead(store, cfg, ctx.runtime);
		const summary = buildTurnSummary(ctx);
		const sessionId = sessionIdOf(ctx);
		// No durable buffer (no store or no session id) ⇒ capture-everything per-turn
		// fallback (cannot batch without a place to hold pending turns).
		if (!store || !sessionId) {
			if (summary) await retainWithQueue(ctx, cfg, summary, "turn", false);
			return { blocks: [] };
		}
		// Batch (never sample): append this turn's compact summary to the durable
		// pending buffer, then flush ONE aggregate when the batch is full or the
		// oldest pending turn has aged past retainMaxDelayMs (hook-observed timeout).
		let buf: PendingBuffer = await loadPending(store, sessionId);
		if (summary) {
			buf = { turns: [...buf.turns, { summary, ts: Date.now() }], overlap: buf.overlap };
			await savePending(store, sessionId, buf);
		}
		if (shouldFlushPending(buf, cfg.retainEveryNTurns, cfg.retainMaxDelayMs, Date.now())) {
			await flushPending(ctx, cfg, store, sessionId, false);
		}
		return { blocks: [] };
	},

	async beforeCompact(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> {
		const base = resolveConfig(ctx.config);
		if (!isActive(base, ctx.runtime) || !base.autoRetain) return { blocks: [] };
		const cfg = await effectiveConfig(ctx, base);
		const store = getStore(ctx);
		const sessionId = sessionIdOf(ctx);
		// Synchronously flush any pending buffered turns BEFORE the about-to-be-lost
		// span so no batched turn is dropped when context is compacted.
		if (store && sessionId) await flushPending(ctx, cfg, store, sessionId, true);
		const summary = buildCompactSummary(ctx);
		// sync:true, batch-EXEMPT — always land the about-to-be-lost span.
		if (summary) await retainWithQueue(ctx, cfg, summary, "compaction", true);
		return { blocks: [] };
	},

	async sessionShutdown(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> {
		const base = resolveConfig(ctx.config);
		if (!isActive(base, ctx.runtime)) return { blocks: [] };
		const cfg = await effectiveConfig(ctx, base);
		const store = getStore(ctx);
		const sessionId = sessionIdOf(ctx);
		// Best-effort: flush any remaining buffered turns, then one-pass drain the
		// durable retry queue.
		if (store) {
			if (base.autoRetain && sessionId) await flushPending(ctx, cfg, store, sessionId, false);
			await drainQueueAll(store, cfg, ctx.runtime);
		}
		return { blocks: [] };
	},
};

export default provider;
