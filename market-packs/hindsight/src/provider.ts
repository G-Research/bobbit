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
	clientConfig,
	enqueueRetain,
	isActive,
	loadQueue,
	makeClient,
	recordError,
	resolveConfig,
	saveQueue,
	truncate,
	type EffectiveConfig,
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

	const tags: Tags | undefined = cfg.recallScope === "project" && ctx.projectId ? { project: String(ctx.projectId) } : undefined;
	const store = getStore(ctx);
	try {
		const client = await makeClient(clientConfig(cfg));
		const res = await client.recall(cfg.bank, q, {
			maxTokens: cfg.recallBudget,
			...(tags ? { tags, tagsMatch: "any" as const } : {}),
		});
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

/** Retry the queue HEAD (one entry) before the turn's own retain. */
async function drainQueueHead(store: StoreLike, cfg: EffectiveConfig): Promise<void> {
	const q = await loadQueue(store);
	if (q.length === 0) return;
	const head = q[0];
	try {
		const client = await makeClient(clientConfig(cfg));
		await client.ensureBank(cfg.bank);
		await client.retain(cfg.bank, head.content, { tags: head.tags, sync: false });
		q.shift();
		await saveQueue(store, q);
	} catch (e) {
		await recordError(store, e); // leave the head for a later attempt
	}
}

/** Best-effort ONE-PASS drain of the whole queue (sessionShutdown). */
async function drainQueueAll(store: StoreLike, cfg: EffectiveConfig): Promise<void> {
	const q = await loadQueue(store);
	if (q.length === 0) return;
	let client;
	try {
		client = await makeClient(clientConfig(cfg));
	} catch {
		return;
	}
	const remaining = [];
	for (const entry of q) {
		try {
			await client.ensureBank(cfg.bank);
			await client.retain(cfg.bank, entry.content, { tags: entry.tags, sync: false });
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
		const client = await makeClient(clientConfig(cfg));
		await client.ensureBank(cfg.bank);
		await client.retain(cfg.bank, summary, { tags, sync });
	} catch (e) {
		if (store) {
			await enqueueRetain(store, { content: summary, tags, ts: Date.now() });
			await recordError(store, e);
		}
	}
}

const provider = {
	async sessionSetup(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> {
		const cfg = resolveConfig(ctx.config);
		if (!isActive(cfg)) return { blocks: [] };
		return { blocks: await doRecall(ctx, cfg, ctx.prompt) };
	},

	async beforePrompt(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> {
		const cfg = resolveConfig(ctx.config);
		if (!isActive(cfg)) return { blocks: [] };
		return { blocks: await doRecall(ctx, cfg, ctx.prompt) };
	},

	async afterTurn(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> {
		const cfg = resolveConfig(ctx.config);
		if (!isActive(cfg) || !cfg.autoRetain) return { blocks: [] };
		const store = getStore(ctx);
		if (store) await drainQueueHead(store, cfg);
		const summary = buildTurnSummary(ctx);
		if (summary) await retainWithQueue(ctx, cfg, summary, "turn", false);
		return { blocks: [] };
	},

	async beforeCompact(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> {
		const cfg = resolveConfig(ctx.config);
		if (!isActive(cfg) || !cfg.autoRetain) return { blocks: [] };
		const summary = buildCompactSummary(ctx);
		// sync:true — land the about-to-be-lost span before context is dropped.
		if (summary) await retainWithQueue(ctx, cfg, summary, "compaction", true);
		return { blocks: [] };
	},

	async sessionShutdown(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> {
		const cfg = resolveConfig(ctx.config);
		if (!isActive(cfg)) return { blocks: [] };
		const store = getStore(ctx);
		if (store) await drainQueueAll(store, cfg);
		return { blocks: [] };
	},
};

export default provider;
