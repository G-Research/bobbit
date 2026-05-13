import fs from "node:fs";
import path from "node:path";

export interface SessionCost {
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

function emptyCost(): SessionCost {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalCost: 0,
	};
}

/**
 * Tracks cumulative per-session cost/usage data.
 * Persists to .bobbit/state/session-costs.json.
 * Same load-on-construct, write-on-mutate pattern as GoalStore/SessionStore.
 */
export class CostTracker {
	private costs: Map<string, SessionCost> = new Map();
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
							const entry: SessionCost = {
								inputTokens: typeof c.inputTokens === "number" ? c.inputTokens : 0,
								outputTokens: typeof c.outputTokens === "number" ? c.outputTokens : 0,
								cacheReadTokens: typeof c.cacheReadTokens === "number" ? c.cacheReadTokens : 0,
								cacheWriteTokens: typeof c.cacheWriteTokens === "number" ? c.cacheWriteTokens : 0,
								totalCost: typeof c.totalCost === "number" ? c.totalCost : 0,
							};
							if (typeof c.goalId === "string" && c.goalId.length > 0) {
								entry.goalId = c.goalId;
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
			const data: Record<string, SessionCost> = {};
			for (const [id, cost] of this.costs) {
				data[id] = cost;
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
	 */
	recordUsage(sessionId: string, usage: UsageData, goalId?: string): SessionCost {
		const existing = this.costs.get(sessionId) ?? emptyCost();
		existing.inputTokens += usage.inputTokens ?? 0;
		existing.outputTokens += usage.outputTokens ?? 0;
		existing.cacheReadTokens += usage.cacheReadTokens ?? 0;
		existing.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		existing.totalCost += usage.cost ?? 0;
		existing.totalCost = Math.round(existing.totalCost * 1_000_000) / 1_000_000;
		if (goalId && !existing.goalId) {
			existing.goalId = goalId;
		}
		this.costs.set(sessionId, existing);
		this.generation++;
		this.save();
		return { ...existing };
	}

	/** Current generation tick. Bumped on every cost mutation. */
	getGeneration(): number {
		return this.generation;
	}

	getSessionCost(sessionId: string): SessionCost | undefined {
		const cost = this.costs.get(sessionId);
		return cost ? { ...cost } : undefined;
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
	 */
	getGoalCost(goalId: string): SessionCost;
	getGoalCost(goalId: string, sessionIds: string[]): SessionCost;
	getGoalCost(goalId: string, sessionIds?: string[]): SessionCost {
		const total = emptyCost();
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
			return total;
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
		return total;
	}

	getAllCosts(): Map<string, SessionCost> {
		return new Map(this.costs);
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

/** Cache entry for `computeTreeCost`. Keyed by `rootGoalId`. */
interface TreeCostCacheEntry {
	generation: number;
	result: TreeCostBreakdown;
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
	const cached = cache.get(rootGoalId);
	if (cached && cached.generation === generation) {
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
		cache.set(rootGoalId, { generation, result: empty });
		return empty;
	}

	// BFS — goals belong to this tree iff their rootGoalId === rootGoalId
	// OR their id === rootGoalId (root itself, which may have rootGoalId
	// undefined or self-equal depending on Phase 1 lazy migration).
	const treeMembers = allGoals.filter(
		(g) => g.id === rootGoalId || g.rootGoalId === rootGoalId,
	);

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
	cache.set(rootGoalId, { generation, result });
	return result;
}

/** Test helper — clears the tree-cost cache for a given tracker. */
export function _resetTreeCostCacheForTesting(tracker: CostTracker): void {
	treeCostCache.delete(tracker);
}
