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
	isQueryTooLongError,
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
	/** Optional lifecycle fields used by the v2 provider hooks. The host may pass
	 *  richer objects; the provider reads them defensively. */
	headSha?: string;
	prNumber?: string | number;
	title?: string;
	files?: unknown;
	touchedFiles?: unknown;
	changedFiles?: unknown;
	components?: unknown;
	decisions?: unknown;
	achievements?: unknown;
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
const MENTAL_MODEL_TITLE = "Project memory model";
const SUMMARY_CAP = 2000;
const DEFAULT_MENTAL_MODEL_REFRESH_EVERY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MENTAL_MODEL_MAX_TOKENS = 1000;
const DEFAULT_QUEUE_DRAIN_MAX = Number.POSITIVE_INFINITY;
const MENTAL_MODEL_REFRESH_PREFIX = "mental-model-refresh:";
const DIRECTIVE_APPLIED_PREFIX = "directive-applied:";
const GOAL_COMPLETED_PREFIX = "goal-completed:";
const inFlightGoalCompleted = new Set<string>();

type MentalModelState = "injected" | "empty" | "skipped" | "failed";

interface MentalModelResult {
	state: MentalModelState;
	block?: ContextBlock;
}

interface RetainExtras {
	documentId?: string;
	updateMode?: "replace" | "append";
	entities?: string[];
	observationScopes?: string[][];
	timestamp?: string;
	metadata?: Record<string, unknown>;
}

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
	const cfg = await overlayProjectConfig(base, getStore(ctx), projectIdOf(ctx));
	// v2 provider keys may not exist in older shared.ts while parallel API-surface
	// work is in flight. Preserve raw hook config values structurally so provider
	// mechanics can be tested and later shared helpers can type them.
	const raw = rawConfig(ctx);
	const extras: Record<string, unknown> = {};
	for (const key of [
		"mentalModelEnabled",
		"mentalModelRefreshEveryMs",
		"mentalModelMaxTokens",
		"queryTimestampEnabled",
		"directivesEnabled",
		"directiveText",
		"retainHealthGateEnabled",
		"retainHealthLlmProbeEnabled",
		"retainQueueDrainMax",
	] as const) {
		if (key in raw) extras[key] = raw[key];
	}
	return { ...cfg, ...extras } as EffectiveConfig;
}

function textOf(v: unknown): string | undefined {
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** Auto-tag taxonomy (the agent never hand-tags). Undefined values are omitted. */
function autoTags(ctx: ProviderCtx, kind: "turn" | "compaction" | "outcome"): Tags {
	const tags: Tags = { kind };
	if (ctx.projectId) tags.project = String(ctx.projectId);
	if (ctx.goalId) tags.goal = String(ctx.goalId);
	if (ctx.roleName) tags.agent = String(ctx.roleName);
	if (ctx.sessionId) tags.session = String(ctx.sessionId);
	return tags;
}

function rawConfig(ctx: ProviderCtx): Record<string, unknown> {
	return ctx.config && typeof ctx.config === "object" && !Array.isArray(ctx.config) ? (ctx.config as Record<string, unknown>) : {};
}

function cfgValue(ctx: ProviderCtx, cfg: EffectiveConfig, key: string): unknown {
	const effective = cfg as unknown as Record<string, unknown>;
	return effective[key] ?? rawConfig(ctx)[key];
}

function cfgBool(ctx: ProviderCtx, cfg: EffectiveConfig, key: string, fallback: boolean): boolean {
	const v = cfgValue(ctx, cfg, key);
	return typeof v === "boolean" ? v : fallback;
}

function cfgNumber(ctx: ProviderCtx, cfg: EffectiveConfig, key: string, fallback: number): number {
	const v = cfgValue(ctx, cfg, key);
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function normalizeList(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap((v) => normalizeList(v));
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (value && typeof value === "object") {
		const out: string[] = [];
		for (const v of Object.values(value as Record<string, unknown>)) out.push(...normalizeList(v));
		return out;
	}
	return [];
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function projectObservationScopes(ctx: ProviderCtx): string[][] | undefined {
	const projectId = projectIdOf(ctx)?.trim();
	return projectId ? [[`project:${projectId}`]] : undefined;
}

function derivedEntities(ctx: ProviderCtx): string[] | undefined {
	const values = unique([
		...normalizeList(ctx.files),
		...normalizeList(ctx.touchedFiles),
		...normalizeList(ctx.changedFiles),
		...normalizeList(ctx.components),
	]);
	return values.length > 0 ? values : undefined;
}

function retainOpts(ctx: ProviderCtx, tags: Tags, sync: boolean, extras: RetainExtras = {}): Record<string, unknown> {
	return {
		tags,
		sync,
		...(extras.documentId ? { documentId: extras.documentId } : {}),
		...(extras.updateMode ? { updateMode: extras.updateMode } : {}),
		...(extras.entities && extras.entities.length > 0 ? { entities: extras.entities } : {}),
		...(extras.observationScopes && extras.observationScopes.length > 0 ? { observationScopes: extras.observationScopes } : {}),
		...(extras.timestamp ? { timestamp: extras.timestamp } : {}),
		...(extras.metadata ? { metadata: extras.metadata } : {}),
	};
}

function queueEntry(ctx: ProviderCtx, cfg: EffectiveConfig, content: string, tags: Tags, extras: RetainExtras = {}): QueueEntry {
	return {
		content,
		tags,
		ts: Date.now(),
		bank: cfg.bank,
		namespace: cfg.namespace,
		...(extras.documentId ? { documentId: extras.documentId } : {}),
		...(extras.updateMode ? { updateMode: extras.updateMode } : {}),
		...(extras.entities && extras.entities.length > 0 ? { entities: extras.entities } : {}),
		...(extras.observationScopes && extras.observationScopes.length > 0 ? { observationScopes: extras.observationScopes } : {}),
		...(extras.timestamp ? { timestamp: extras.timestamp } : {}),
		...(extras.metadata ? { metadata: extras.metadata } : {}),
	} as QueueEntry;
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
			...(cfgBool(ctx, cfg, "queryTimestampEnabled", false) ? { queryTimestamp: new Date().toISOString() } : {}),
			...(filter ? { tags: filter.tags, tagsMatch: filter.tagsMatch } : {}),
		} as never);
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
		// The data plane's 500-token "Query too long" 400 is a SOFT skip: recall
		// returns empty for this turn and we DO NOT record a sticky lastError (and
		// clear any prior one), so the marketplace/panel banner can never reappear
		// from this cause. The token-safe clamp should prevent it ever firing; this
		// is defence in depth. Genuine errors still surface as before.
		if (isQueryTooLongError(e)) {
			if (store) await clearError(store);
			return [];
		}
		if (store) await recordError(store, e);
		return [];
	}
}

function mentalModelId(projectId: string): string {
	return `bobbit-${projectId.replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

function mentalModelContent(model: unknown): string | undefined {
	if (!model || typeof model !== "object") return undefined;
	const m = model as Record<string, unknown>;
	if (typeof m.content === "string" && m.content.trim()) return m.content.trim();
	const rr = m.reflect_response;
	if (rr && typeof rr === "object" && typeof (rr as Record<string, unknown>).text === "string") {
		const text = String((rr as Record<string, unknown>).text).trim();
		return text || undefined;
	}
	return undefined;
}

async function maybeRefreshMentalModel(ctx: ProviderCtx, cfg: EffectiveConfig, client: unknown, id: string, model: unknown): Promise<void> {
	const refresh = (client as { refreshMentalModel?: (bank: string, id: string) => Promise<unknown> }).refreshMentalModel;
	if (!refresh) return;
	const store = getStore(ctx);
	const everyMs = Math.max(0, cfgNumber(ctx, cfg, "mentalModelRefreshEveryMs", DEFAULT_MENTAL_MODEL_REFRESH_EVERY_MS));
	if (everyMs <= 0) return;
	const key = `${MENTAL_MODEL_REFRESH_PREFIX}${cfg.namespace}:${cfg.bank}:${id}`;
	const now = Date.now();
	let due = model && typeof model === "object" && (model as Record<string, unknown>).is_stale === true;
	if (store) {
		const last = await store.get<number>(key);
		due = typeof last !== "number" || now - last >= everyMs;
	}
	if (!due) return;
	try {
		await refresh.call(client, cfg.bank, id);
		if (store) await store.put(key, now);
	} catch {
		// Refresh is opportunistic; stale-but-present content is still valuable.
	}
}

async function doMentalModel(ctx: ProviderCtx, cfg: EffectiveConfig): Promise<MentalModelResult> {
	if (!cfg.autoRecall || !cfgBool(ctx, cfg, "mentalModelEnabled", true)) return { state: "skipped" };
	const projectId = projectIdOf(ctx)?.trim();
	if (!projectId) return { state: "skipped" };
	const id = mentalModelId(projectId);
	const filter = recallTagFilter("project", projectId, "all_strict");
	const tags = { project: projectId, bobbit: "true", kind: "mental-model" };
	try {
		const client = (await makeClient(clientConfig(cfg, ctx.runtime))) as unknown as {
			ensureMentalModel?: (bank: string, spec: Record<string, unknown>) => Promise<unknown>;
			getMentalModel?: (bank: string, id: string) => Promise<unknown>;
		};
		if (!client.ensureMentalModel && !client.getMentalModel) return { state: "skipped" };
		const spec = {
			id,
			name: `Bobbit project memory: ${projectId}`,
			sourceQuery: `Current durable project state, key decisions, architecture, conventions, open threads, and recent outcomes for project ${projectId}.`,
			tags,
			maxTokens: Math.max(1, cfgNumber(ctx, cfg, "mentalModelMaxTokens", DEFAULT_MENTAL_MODEL_MAX_TOKENS)),
			trigger: {
				factTypes: cfg.recallTypes,
				excludeMentalModels: true,
				include: null,
				...(filter ? { tags: filter.tags, tagsMatch: filter.tagsMatch } : {}),
			},
		};
		const ensured = client.ensureMentalModel ? await client.ensureMentalModel(cfg.bank, spec) : undefined;
		const model = client.getMentalModel ? await client.getMentalModel(cfg.bank, id) : ensured;
		const content = mentalModelContent(model);
		if (!content) return { state: "empty" };
		await maybeRefreshMentalModel(ctx, cfg, client, id, model);
		if (getStore(ctx)) await clearError(getStore(ctx)!);
		return {
			state: "injected",
			block: {
				id: "memory:mental-model",
				title: MENTAL_MODEL_TITLE,
				authority: "memory",
				priority: 60,
				reason: `Hindsight mental model for project ${projectId}`,
				content,
			},
		};
	} catch (e) {
		const store = getStore(ctx);
		if (store) await recordError(store, e);
		return { state: "failed" };
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
	await applyDirectivesIfEnabled(store, client, targetCfg);
	const extras = entry as QueueEntry & RetainExtras;
	await client.retain(bank, entry.content, retainOpts({ projectId: entry.tags.project } as ProviderCtx, entry.tags, false, {
		documentId: extras.documentId,
		updateMode: extras.updateMode,
		entities: extras.entities,
		observationScopes: extras.observationScopes,
		timestamp: extras.timestamp,
		metadata: extras.metadata,
	}) as never);
}

async function applyDirectivesIfEnabled(store: StoreLike | null, client: unknown, cfg: EffectiveConfig): Promise<void> {
	const raw = cfg as unknown as Record<string, unknown>;
	if (raw.directivesEnabled !== true) return;
	const ensureDirective = (client as { ensureDirective?: (bank: string, directive: Record<string, unknown>) => Promise<unknown> }).ensureDirective;
	const applyDirectives = (client as { applyDirectives?: (bank: string, directives: unknown) => Promise<unknown> }).applyDirectives;
	if (!ensureDirective && !applyDirectives) return;
	const directiveText = typeof raw.directiveText === "string" && raw.directiveText.trim()
		? raw.directiveText.trim()
		: "For Bobbit coding agents: cite source facts when available, prefer recent durable observations, and answer concisely for an implementation agent.";
	const signature = `${cfg.namespace}:${cfg.bank}:${directiveText}`;
	const key = `${DIRECTIVE_APPLIED_PREFIX}${signature}`;
	if (store && (await store.get(key))) return;
	if (ensureDirective) {
		await ensureDirective.call(client, cfg.bank, {
			id: "bobbit-agent-behavior",
			name: "Bobbit agent behavior",
			text: directiveText,
			tags: ["bobbit"],
		});
	} else if (applyDirectives) {
		await applyDirectives.call(client, cfg.bank, [{ id: "bobbit-agent-behavior", text: directiveText, tags: ["bobbit"] }]);
	}
	if (store) await store.put(key, true);
}

async function queueDrainHealthy(store: StoreLike, cfg: EffectiveConfig, runtime?: RuntimeContext): Promise<boolean> {
	const raw = cfg as unknown as Record<string, unknown>;
	if (raw.retainHealthGateEnabled === false) return true;
	try {
		const client = (await makeClient(clientConfig(cfg, runtime))) as unknown as {
			health?: () => Promise<{ ok?: boolean }>;
			healthLlm?: () => Promise<unknown>;
		};
		const health = client.health ? await client.health() : { ok: true };
		if (health?.ok === false) return false;
		if (raw.retainHealthLlmProbeEnabled === true && client.healthLlm) {
			const llm = await client.healthLlm();
			if (llm && typeof llm === "object") {
				const statuses = Object.values(llm as Record<string, unknown>);
				if (statuses.some((v) => v && typeof v === "object" && (v as Record<string, unknown>).ok === false)) return false;
			}
		}
		return true;
	} catch (e) {
		await recordError(store, e);
		return false;
	}
}

/** Retry the queue HEAD (one entry) before the turn's own retain. */
async function drainQueueHead(store: StoreLike, cfg: EffectiveConfig, runtime?: RuntimeContext): Promise<void> {
	const q = await loadQueue(store);
	if (q.length === 0) return;
	if (!(await queueDrainHealthy(store, cfg, runtime))) return;
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
	if (!(await queueDrainHealthy(store, cfg, runtime))) return;
	const limit = Math.max(1, Math.floor((cfg as unknown as Record<string, unknown>).retainQueueDrainMax as number || DEFAULT_QUEUE_DRAIN_MAX));
	const remaining: QueueEntry[] = [];
	let drained = 0;
	for (const entry of q) {
		if (drained >= limit) {
			remaining.push(entry);
			continue;
		}
		try {
			await retainQueueEntry(store, cfg, runtime, entry);
			drained++;
		} catch {
			remaining.push(entry);
		}
	}
	await saveQueue(store, remaining);
}

async function retainWithQueue(ctx: ProviderCtx, cfg: EffectiveConfig, summary: string, kind: "turn" | "compaction", sync: boolean): Promise<void> {
	const store = getStore(ctx);
	const tags = autoTags(ctx, kind);
	const extras: RetainExtras = { observationScopes: projectObservationScopes(ctx), entities: derivedEntities(ctx), timestamp: new Date().toISOString() };
	try {
		const client = await makeClient(clientConfig(cfg, ctx.runtime));
		await client.ensureBank(cfg.bank);
		await applyBankMission(store, client, cfg);
		await applyDirectivesIfEnabled(store, client, cfg);
		await client.retain(cfg.bank, summary, retainOpts(ctx, tags, sync, extras) as never);
		if (store) await clearError(store);
	} catch (e) {
		if (store) {
			await enqueueRetain(store, queueEntry(ctx, cfg, summary, tags, extras));
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
	const extras: RetainExtras = { observationScopes: projectObservationScopes(ctx), entities: derivedEntities(ctx), timestamp: new Date().toISOString() };
	try {
		const client = await makeClient(clientConfig(cfg, ctx.runtime));
		await client.ensureBank(cfg.bank);
		await applyBankMission(store, client, cfg);
		await applyDirectivesIfEnabled(store, client, cfg);
		await client.retain(cfg.bank, content, retainOpts(ctx, tags, sync, extras) as never);
		await clearError(store);
	} catch (e) {
		await enqueueRetain(store, queueEntry(ctx, cfg, content, tags, extras));
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
		const mental = await doMentalModel(ctx, cfg);
		if (mental.state === "injected" && mental.block) return { blocks: [mental.block] };
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

	async goalCompleted(ctx: ProviderCtx): Promise<{ blocks: ContextBlock[] }> {
		const base = resolveConfig(ctx.config);
		if (!isActive(base, ctx.runtime) || !base.autoRetain) return { blocks: [] };
		const cfg = await effectiveConfig(ctx, base);
		const store = getStore(ctx);
		const goalId = ctx.goalId ? String(ctx.goalId) : "unknown";
		const headSha = ctx.headSha ? String(ctx.headSha) : "unknown";
		const marker = `${GOAL_COMPLETED_PREFIX}${goalId}:${headSha}`;
		if (store && (await store.get(marker))) return { blocks: [] };
		if (inFlightGoalCompleted.has(marker)) return { blocks: [] };
		inFlightGoalCompleted.add(marker);
		try {
			if (store) await store.put(marker, { ts: Date.now(), state: "started" });
			const tags = autoTags(ctx, "outcome");
			tags.bobbit = "true";
			if (ctx.prNumber !== undefined) tags.pr = String(ctx.prNumber);
			const entities = derivedEntities(ctx);
			const lines = [
				`Goal completed: ${goalId}`,
				ctx.title ? `Title: ${ctx.title}` : undefined,
				headSha !== "unknown" ? `Head SHA: ${headSha}` : undefined,
				ctx.prNumber !== undefined ? `PR: ${ctx.prNumber}` : undefined,
				...normalizeList(ctx.achievements).map((v) => `Achievement: ${v}`),
				...normalizeList(ctx.decisions).map((v) => `Decision: ${v}`),
				...(entities ? entities.map((v) => `Entity: ${v}`) : []),
			].filter(Boolean) as string[];
			const content = lines.join("\n");
			const extras: RetainExtras = {
				documentId: `outcome:${goalId}`,
				updateMode: "replace",
				entities,
				observationScopes: projectObservationScopes(ctx),
				timestamp: new Date().toISOString(),
				metadata: { headSha },
			};
			try {
				const client = await makeClient(clientConfig(cfg, ctx.runtime));
				await client.ensureBank(cfg.bank);
				await applyBankMission(store, client, cfg);
				await applyDirectivesIfEnabled(store, client, cfg);
				await client.retain(cfg.bank, content, retainOpts(ctx, tags, false, extras) as never);
				if (store) {
					await clearError(store);
					await store.put(marker, { ts: Date.now(), state: "retained" });
				}
			} catch (e) {
				if (store) {
					await enqueueRetain(store, queueEntry(ctx, cfg, content, tags, extras));
					await recordError(store, e);
					await store.put(marker, { ts: Date.now(), state: "queued" });
				}
			}
		} finally {
			inFlightGoalCompleted.delete(marker);
		}
		return { blocks: [] };
	},
};

export default provider;
