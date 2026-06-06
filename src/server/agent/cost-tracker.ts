import fs from "node:fs";
import path from "node:path";

import { walkGoalSubtree } from "./goal-subtree.js";
import type { PersistedGoal } from "./goal-store.js";

/**
 * Raw per-session cost counters as stored on disk and accumulated in memory.
 * `cacheHitRate` is intentionally NOT persisted — it is a derived field
 * computed at read time from `cacheReadTokens` and `inputTokens`. See
 * docs/design (Cache-Hit Metric).
 */
export interface RawSessionCost {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCost: number;
	/**
	 * Goal this session's cost belongs to. Stamped once at record time so
	 * tree-cost rollups survive session purge — `sessionStore` is wiped on
	 * cleanup but cost entries persist. Optional: non-goal sessions
	 * (assistants, staff, etc.) record cost without a goalId.
	 *
	 * Write-once: set on the first `recordUsage` call that supplies a
	 * goalId, never overwritten thereafter (guards against pathological
	 * re-association).
	 */
	goalId?: string;
	/**
	 * Wall-clock timestamp (ms since epoch) when this entry first gained
	 * any usage. Stamped once on the first `recordUsage` call, never
	 * overwritten. Optional because entries persisted before this field
	 * existed (legacy data) have none — `getUnattributableLegacyCostWithMetadata`
	 * only reports a `firstSeenAt` when at least one unstamped entry has one.
	 */
	firstSeenAt?: number;
}

/**
 * Public-facing session cost snapshot. Adds the derived `cacheHitRate`
 * to {@link RawSessionCost}. `cacheHitRate` is `null` when the denominator
 * (`cacheReadTokens + inputTokens`) is 0 — i.e. cold sessions, or providers
 * that do not report cache counters. UI renders `null` as `—`.
 */
export interface SessionCost extends RawSessionCost {
	cacheHitRate: number | null;
}

export interface UsageData {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cost?: number;
}

/** Per-goal entry in a tree-cost rollup. */
export interface TreeCostEntry {
	goalId: string;
	depth: number;
	title: string;
	costUsd: number;
	tokensIn: number;
	tokensOut: number;
}

/** Aggregate tree-cost rollup result (tree-cost rollup). */
export interface TreeCostBreakdown {
	rootGoalId: string;
	totalCostUsd: number;
	totalTokensIn: number;
	totalTokensOut: number;
	/** Per-goal breakdown sorted by (depth ASC, createdAt ASC). */
	breakdown: TreeCostEntry[];
}

/**
 * Minimal goal shape consumed by `computeTreeCost`. Only the fields used by
 * the BFS walk + per-entry projection are required, so the helper stays
 * decoupled from `goal-store.ts` (avoids a server-only type cycle in tests).
 */
export interface TreeCostGoal {
	id: string;
	title?: string;
	createdAt?: number;
	parentGoalId?: string;
	rootGoalId?: string;
	archived?: boolean;
}

/** Source of session ids per goal — pluggable so tests don't need a real SessionManager. */
export type SessionIdsForGoalFn = (goalId: string) => string[];

/**
 * Sentinel goalId for legacy cost entries whose original goal mapping
 * could not be recovered by `backfillLegacyCostGoalIds` (no live session
 * record + no sidecar on disk). Surfaced via `getUnattributableLegacyCost`
 * and rendered as a separate informational row in the tree-cost panel —
 * never silently absorbed into a parent goal's subtree total.
 */
export const UNATTRIBUTABLE_LEGACY_GOAL_ID = "__unattributable__";

function emptyRaw(): RawSessionCost {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalCost: 0,
	};
}

/**
 * Derive the cache-hit rate from a raw cost snapshot.
 *
 * Formula: `cacheReadTokens / (cacheReadTokens + inputTokens)`. `cacheWriteTokens`
 * is intentionally excluded — writes are charged at full price and are not hits.
 * Returns `null` when the denominator is 0 so cold sessions render as `—`
 * rather than `0%`.
 */
export function deriveCacheHitRate(
	cost: Pick<RawSessionCost, "inputTokens" | "cacheReadTokens">,
): number | null {
	const denom = (cost.cacheReadTokens ?? 0) + (cost.inputTokens ?? 0);
	if (denom <= 0) return null;
	return (cost.cacheReadTokens ?? 0) / denom;
}

/** Decorate a raw cost with the derived `cacheHitRate` field. */
export function withDerivedFields(raw: RawSessionCost): SessionCost {
	return { ...raw, cacheHitRate: deriveCacheHitRate(raw) };
}

/**
 * Tracks cumulative per-session cost/usage data.
 * Persists to .bobbit/state/session-costs.json.
 * Same load-on-construct, write-on-mutate pattern as GoalStore/SessionStore.
 */
export class CostTracker {
	private costs: Map<string, RawSessionCost> = new Map();
	private readonly storeDir: string;
	private readonly storeFile: string;
	/** Monotonically increasing tick — bumped on every cost mutation.
	 *  Used by `computeTreeCost` for cache invalidation (tree-cost rollup). */
	private generation = 0;

	constructor(stateDir: string) {
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "session-costs.json");
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(this.storeFile)) {
				const data = JSON.parse(fs.readFileSync(this.storeFile, "utf-8"));
				if (data && typeof data === "object" && !Array.isArray(data)) {
					for (const [id, cost] of Object.entries(data)) {
						if (id && cost && typeof cost === "object") {
							const c = cost as Record<string, unknown>;
							const entry: RawSessionCost = {
								inputTokens: typeof c.inputTokens === "number" ? c.inputTokens : 0,
								outputTokens: typeof c.outputTokens === "number" ? c.outputTokens : 0,
								cacheReadTokens: typeof c.cacheReadTokens === "number" ? c.cacheReadTokens : 0,
								cacheWriteTokens: typeof c.cacheWriteTokens === "number" ? c.cacheWriteTokens : 0,
								totalCost: typeof c.totalCost === "number" ? c.totalCost : 0,
							};
							if (typeof c.goalId === "string" && c.goalId.length > 0) {
								entry.goalId = c.goalId;
							}
							if (typeof c.firstSeenAt === "number" && Number.isFinite(c.firstSeenAt)) {
								entry.firstSeenAt = c.firstSeenAt;
							}
							this.costs.set(id, entry);
						}
					}
				}
			}
		} catch (err) {
			console.error("[cost-tracker] Failed to load persisted costs:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(this.storeDir)) {
				fs.mkdirSync(this.storeDir, { recursive: true });
			}
			// Persist the raw counters plus the stamped `goalId` / `firstSeenAt`
			// (needed for tree-cost rollups + legacy backfill to survive reload).
			// Derived fields (cacheHitRate) are NEVER written — recomputed on read.
			const data: Record<string, RawSessionCost> = {};
			for (const [id, cost] of this.costs) {
				const entry: RawSessionCost = {
					inputTokens: cost.inputTokens,
					outputTokens: cost.outputTokens,
					cacheReadTokens: cost.cacheReadTokens,
					cacheWriteTokens: cost.cacheWriteTokens,
					totalCost: cost.totalCost,
				};
				if (cost.goalId) entry.goalId = cost.goalId;
				if (typeof cost.firstSeenAt === "number") entry.firstSeenAt = cost.firstSeenAt;
				data[id] = entry;
			}
			fs.writeFileSync(this.storeFile, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[cost-tracker] Failed to save costs:", err);
		}
	}

	/**
	 * Add usage data to the cumulative totals for a session.
	 * Handles partial usage objects — undefined fields are treated as 0.
	 *
	 * `goalId` is stamped onto the entry at record time so tree-cost rollups
	 * survive session purge. Write-once semantics: only stamped if currently
	 * unset; subsequent calls with the same or different goalId never
	 * overwrite. Passing `undefined` for an already-stamped entry is a no-op.
	 *
	 * Returns a snapshot with the derived `cacheHitRate` populated.
	 */
	recordUsage(sessionId: string, usage: UsageData, goalId?: string): SessionCost {
		const existing = this.costs.get(sessionId) ?? emptyRaw();
		existing.inputTokens += usage.inputTokens ?? 0;
		existing.outputTokens += usage.outputTokens ?? 0;
		existing.cacheReadTokens += usage.cacheReadTokens ?? 0;
		existing.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		existing.totalCost += usage.cost ?? 0;
		existing.totalCost = Math.round(existing.totalCost * 1_000_000) / 1_000_000;
		if (goalId && !existing.goalId) {
			existing.goalId = goalId;
		}
		if (!existing.firstSeenAt) {
			existing.firstSeenAt = Date.now();
		}
		this.costs.set(sessionId, existing);
		this.generation++;
		this.save();
		return withDerivedFields(existing);
	}

	/** Current generation tick. Bumped on every cost mutation. */
	getGeneration(): number {
		return this.generation;
	}

	getSessionCost(sessionId: string): SessionCost | undefined {
		const cost = this.costs.get(sessionId);
		return cost ? withDerivedFields(cost) : undefined;
	}

	/**
	 * Aggregate cost for a goal.
	 *
	 * One-arg form: scans all entries by stamped `goalId`. This is the
	 * primary path — survives session purge because cost entries are
	 * addressed by goalId, not by sessionId lookup through `sessionStore`.
	 *
	 * Two-arg form: legacy explicit-scope path. Aggregates exactly the
	 * given sessionIds. Kept for tests and callers that want to scope
	 * by an explicit session set.
	 *
	 * Both forms return a combined SessionCost with the aggregate
	 * `cacheHitRate` derived from the aggregate counters.
	 */
	getGoalCost(goalId: string): SessionCost;
	getGoalCost(goalId: string, sessionIds: string[]): SessionCost;
	getGoalCost(goalId: string, sessionIds?: string[]): SessionCost {
		const total = emptyRaw();
		if (sessionIds === undefined) {
			for (const c of this.costs.values()) {
				if (c.goalId === goalId) {
					total.inputTokens += c.inputTokens;
					total.outputTokens += c.outputTokens;
					total.cacheReadTokens += c.cacheReadTokens;
					total.cacheWriteTokens += c.cacheWriteTokens;
					total.totalCost += c.totalCost;
				}
			}
			return withDerivedFields(total);
		}
		for (const sid of sessionIds) {
			const c = this.costs.get(sid);
			if (c) {
				total.inputTokens += c.inputTokens;
				total.outputTokens += c.outputTokens;
				total.cacheReadTokens += c.cacheReadTokens;
				total.cacheWriteTokens += c.cacheWriteTokens;
				total.totalCost += c.totalCost;
			}
		}
		return withDerivedFields(total);
	}

	getAllCosts(): Map<string, SessionCost> {
		const out = new Map<string, SessionCost>();
		for (const [id, cost] of this.costs) {
			out.set(id, withDerivedFields(cost));
		}
		return out;
	}

	/**
	 * Aggregate cost across all entries that have no stamped `goalId`.
	 * These are typically legacy entries recorded before goalId stamping
	 * existed (commit `a4050f59`) AND whose source session has been
	 * purged AND whose sidecar lookup failed during boot backfill.
	 *
	 * Kept separate from `computeTreeCost` so unattributable totals are
	 * never silently rolled into a parent goal's subtree — the tree-cost
	 * endpoint exposes this as an explicit `unattributableLegacy` bucket.
	 */
	getUnattributableLegacyCost(): SessionCost {
		const total = emptyRaw();
		for (const c of this.costs.values()) {
			if (c.goalId) continue;
			total.inputTokens += c.inputTokens;
			total.outputTokens += c.outputTokens;
			total.cacheReadTokens += c.cacheReadTokens;
			total.cacheWriteTokens += c.cacheWriteTokens;
			total.totalCost += c.totalCost;
		}
		total.totalCost = Math.round(total.totalCost * 1_000_000) / 1_000_000;
		return withDerivedFields(total);
	}

	/**
	 * Same as `getUnattributableLegacyCost` but also returns the minimum
	 * `firstSeenAt` timestamp across unstamped entries (when any have one).
	 * Used by `/api/goals/:id/tree-cost` so the UI can compute a legacy-
	 * threshold without hardcoding a date. `firstSeenAt` is `undefined`
	 * when no unstamped entry has a recorded timestamp (genuinely-legacy
	 * data that pre-dates the field).
	 */
	getUnattributableLegacyCostWithMetadata(): SessionCost & { firstSeenAt?: number } {
		const total = this.getUnattributableLegacyCost();
		let firstSeenAt: number | undefined;
		for (const c of this.costs.values()) {
			if (c.goalId) continue;
			if (typeof c.firstSeenAt === "number" && Number.isFinite(c.firstSeenAt)) {
				if (firstSeenAt === undefined || c.firstSeenAt < firstSeenAt) {
					firstSeenAt = c.firstSeenAt;
				}
			}
		}
		return firstSeenAt !== undefined ? { ...total, firstSeenAt } : total;
	}

	/**
	 * Iterate session ids that have a recorded cost entry without a
	 * stamped `goalId`. Used by the boot-time legacy backfill
	 * (`cost-backfill.ts`) to drive its resolver. Returns a fresh array
	 * so callers don't see internal-map mutations during iteration.
	 */
	getUnstampedSessionIds(): string[] {
		const out: string[] = [];
		for (const [sid, c] of this.costs) {
			if (!c.goalId) out.push(sid);
		}
		return out;
	}

	removeSession(sessionId: string): void {
		if (this.costs.delete(sessionId)) {
			this.generation++;
			this.save();
		}
	}

	/**
	 * One-shot lazy migration — stamp `goalId` on legacy entries that lack
	 * one. For each unstamped entry, calls `resolver(sessionId)`; if it
	 * returns a goalId, stamps it onto the entry. Saves once at end if
	 * any entries were updated. Idempotent: a second invocation with the
	 * same data stamps zero entries.
	 *
	 * Returns the count of entries that were stamped.
	 *
	 * Bumps the generation tick if any entries were updated so cached
	 * tree-cost rollups recompute.
	 */
	backfillGoalIds(resolver: (sessionId: string) => string | undefined): number {
		let stamped = 0;
		for (const [sid, entry] of this.costs) {
			if (entry.goalId) continue;
			const goalId = resolver(sid);
			if (goalId) {
				entry.goalId = goalId;
				stamped++;
			}
		}
		if (stamped > 0) {
			this.generation++;
			this.save();
		}
		return stamped;
	}
}

// ---------------------------------------------------------------------------
// Tree cost rollup (tree-cost rollup)
// ---------------------------------------------------------------------------

/** Cache entry for `computeTreeCost`. Keyed by `rootGoalId`.
 *  Invalidated when ANY of these change:
 *    - cost mutation     -> `generation` bumps
 *    - tree shape        -> `treeSignature` differs (goals added / removed /
 *                           reparented / archived flag flipped within the
 *                           rooted subtree)
 *    - fallback resolver -> `hasSessionIdsResolver` differs (caller went
 *                           from no-fallback to fallback or vice-versa).
 *                           When a resolver IS supplied we additionally
 *                           skip the cache entirely below, because its
 *                           closure state can change between calls in
 *                           ways we cannot fingerprint. */
interface TreeCostCacheEntry {
	generation: number;
	treeSignature: string;
	hasSessionIdsResolver: boolean;
	result: TreeCostBreakdown;
}

/** Fingerprint the relevant subset of `allGoals` for cache invalidation.
 *  Walks the SAME `parentGoalId` subtree that `computeTreeCost` sums — via
 *  `walkGoalSubtree` rooted at `rootGoalId` — and hashes id + parentGoalId +
 *  rootGoalId + archived flag + createdAt for every member.
 *
 *  Must NOT filter by `rootGoalId === requestedGoalId`: subgoal descendants
 *  keep the *top-level* root's id in their `rootGoalId` stamp, so a
 *  rootGoalId-equality filter excludes the whole subtree when the requested
 *  goal is itself a subgoal — the cache key would never change when a deep
 *  descendant is added / removed / reparented / archived (finding C3). The
 *  subtree walk includes those descendants, so the signature invalidates
 *  correctly. We deliberately avoid hashing state/title: those don't affect
 *  breakdown membership or ordering keys.
 *  pinned by tests/tree-cost-rollup.test.ts::cache invalidates when a deep subgoal descendant changes */
function computeTreeSignature(rootGoalId: string, allGoals: TreeCostGoal[]): string {
	const members = walkGoalSubtree(rootGoalId, allGoals as unknown as PersistedGoal[], {
		includeRoot: true,
		includeArchived: true,
	}) as unknown as TreeCostGoal[];
	const parts: string[] = [];
	for (const g of members) {
		parts.push(`${g.id}|${g.parentGoalId ?? ""}|${g.rootGoalId ?? ""}|${g.archived ? "a" : ""}|${g.createdAt ?? 0}`);
	}
	parts.sort();
	return `${parts.length}:${parts.join(",")}`;
}

/**
 * Per-CostTracker LRU-ish cache. Map insertion order doubles as recency.
 * We don't bound size — there's only ever a handful of root goals on a
 * Bobbit server. Generation-based invalidation makes stale entries cheap.
 */
const treeCostCache = new WeakMap<CostTracker, Map<string, TreeCostCacheEntry>>();

function getCache(tracker: CostTracker): Map<string, TreeCostCacheEntry> {
	let cache = treeCostCache.get(tracker);
	if (!cache) {
		cache = new Map();
		treeCostCache.set(tracker, cache);
	}
	return cache;
}

/**
 * Walk the goal-tree rooted at `rootGoalId` (BFS via the rootGoalId / parentGoalId
 * chain) and sum each goal's accumulated cost. Caches the result by
 * `(rootGoalId, costGeneration)`; invalidated on the next cost mutation.
 *
 * Goals not part of this tree (different rootGoalId chain) are excluded.
 * Archived goals are still counted — their cost survives archival.
 *
 * Per-goal cost is looked up via the one-arg `costTracker.getGoalCost(gid)`,
 * which scans entries by stamped `goalId`. Survives session purge.
 * `sessionIdsForGoal` is accepted for backward compatibility but, when
 * supplied, only acts as an additional fallback for any goal whose
 * stamped-by-goalId aggregate would be zero (e.g. legacy data that
 * predates the backfill, or test scaffolding that records cost without a
 * goalId).
 */
export function computeTreeCost(
	rootGoalId: string,
	allGoals: TreeCostGoal[],
	costTracker: CostTracker,
	sessionIdsForGoal?: SessionIdsForGoalFn,
): TreeCostBreakdown {
	const cache = getCache(costTracker);
	const generation = costTracker.getGeneration();
	const hasSessionIdsResolver = !!sessionIdsForGoal;
	const treeSignature = computeTreeSignature(rootGoalId, allGoals);
	const cached = cache.get(rootGoalId);
	// Cache hit ONLY when generation + tree shape + resolver-presence all
	// match. When a resolver was supplied we additionally bypass caching
	// on writes below — its closure state can change between calls in
	// ways we cannot fingerprint, so returning a cached breakdown could
	// be stale even with matching generation/shape.
	if (
		cached &&
		cached.generation === generation &&
		cached.treeSignature === treeSignature &&
		cached.hasSessionIdsResolver === hasSessionIdsResolver &&
		!hasSessionIdsResolver
	) {
		return cached.result;
	}

	// Build adjacency map (parent → children) and a global lookup.
	const byId = new Map<string, TreeCostGoal>();
	for (const g of allGoals) byId.set(g.id, g);

	const root = byId.get(rootGoalId);
	if (!root) {
		const empty: TreeCostBreakdown = {
			rootGoalId,
			totalCostUsd: 0,
			totalTokensIn: 0,
			totalTokensOut: 0,
			breakdown: [],
		};
		if (!hasSessionIdsResolver) {
			cache.set(rootGoalId, { generation, treeSignature, hasSessionIdsResolver, result: empty });
		}
		return empty;
	}

	// Walk the subtree via the shared cascade helper. Equivalent to the
	// legacy `id === rootGoalId || rootGoalId === rootGoalId` filter
	// because the `rootGoalId` stamp on every persisted goal is consistent
	// with its `parentGoalId` chain (see goal-manager.createGoal). Include
	// archived nodes — their cost survives archival.
	// pinned by tests/cost-tree-archived.test.ts::computeTreeCost includes archived descendants in breakdown
	const treeMembers = walkGoalSubtree(rootGoalId, allGoals as PersistedGoal[], {
		includeRoot: true,
		includeArchived: true,
	}) as unknown as TreeCostGoal[];

	// Compute depth via parent chain. Cap at 32 to defend against cycles
	// (Phase 1 already rejects cycles at createGoal, but persisted state
	// can be hand-edited).
	const depthOf = (g: TreeCostGoal): number => {
		let d = 0;
		let cur: TreeCostGoal | undefined = g;
		const seen = new Set<string>();
		while (cur && cur.parentGoalId && !seen.has(cur.id) && d < 32) {
			seen.add(cur.id);
			cur = byId.get(cur.parentGoalId);
			if (cur) d++;
			else break;
		}
		return d;
	};

	const entries: TreeCostEntry[] = [];
	let totalCostUsd = 0;
	let totalTokensIn = 0;
	let totalTokensOut = 0;

	for (const g of treeMembers) {
		// Primary path: scan by stamped goalId (survives session purge).
		let cost = costTracker.getGoalCost(g.id);
		// Fallback: if a sessionIds resolver was supplied and the stamped
		// aggregate is empty, try the explicit-scope path. Lets older
		// callers that recorded cost without a goalId still roll up.
		if (cost.totalCost === 0 && cost.inputTokens === 0 && cost.outputTokens === 0 && sessionIdsForGoal) {
			const sids = sessionIdsForGoal(g.id);
			if (sids.length > 0) {
				cost = costTracker.getGoalCost(g.id, sids);
			}
		}
		entries.push({
			goalId: g.id,
			depth: depthOf(g),
			title: g.title ?? g.id,
			costUsd: cost.totalCost,
			tokensIn: cost.inputTokens,
			tokensOut: cost.outputTokens,
		});
		totalCostUsd += cost.totalCost;
		totalTokensIn += cost.inputTokens;
		totalTokensOut += cost.outputTokens;
	}

	// Sort by depth ASC, then createdAt ASC for determinism.
	entries.sort((a, b) => {
		if (a.depth !== b.depth) return a.depth - b.depth;
		const ga = byId.get(a.goalId);
		const gb = byId.get(b.goalId);
		const ca = ga?.createdAt ?? 0;
		const cb = gb?.createdAt ?? 0;
		return ca - cb;
	});

	// Round aggregate to 6dp to match per-session precision.
	totalCostUsd = Math.round(totalCostUsd * 1_000_000) / 1_000_000;

	const result: TreeCostBreakdown = {
		rootGoalId,
		totalCostUsd,
		totalTokensIn,
		totalTokensOut,
		breakdown: entries,
	};
	// Only cache when no fallback resolver was supplied. See header doc.
	if (!hasSessionIdsResolver) {
		cache.set(rootGoalId, { generation, treeSignature, hasSessionIdsResolver, result });
	}
	return result;
}

/** Test helper — clears the tree-cost cache for a given tracker. */
export function _resetTreeCostCacheForTesting(tracker: CostTracker): void {
	treeCostCache.delete(tracker);
}
