import fs from "node:fs";
import path from "node:path";

export interface SessionCost {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCost: number;
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
							this.costs.set(id, {
								inputTokens: typeof c.inputTokens === "number" ? c.inputTokens : 0,
								outputTokens: typeof c.outputTokens === "number" ? c.outputTokens : 0,
								cacheReadTokens: typeof c.cacheReadTokens === "number" ? c.cacheReadTokens : 0,
								cacheWriteTokens: typeof c.cacheWriteTokens === "number" ? c.cacheWriteTokens : 0,
								totalCost: typeof c.totalCost === "number" ? c.totalCost : 0,
							});
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
	 */
	recordUsage(sessionId: string, usage: UsageData): SessionCost {
		const existing = this.costs.get(sessionId) ?? emptyCost();
		existing.inputTokens += usage.inputTokens ?? 0;
		existing.outputTokens += usage.outputTokens ?? 0;
		existing.cacheReadTokens += usage.cacheReadTokens ?? 0;
		existing.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		existing.totalCost += usage.cost ?? 0;
		existing.totalCost = Math.round(existing.totalCost * 1_000_000) / 1_000_000;
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
	 * Aggregate cost across multiple sessions (caller provides session IDs).
	 * Returns a combined SessionCost. Sessions without cost data are skipped.
	 */
	getGoalCost(_goalId: string, sessionIds: string[]): SessionCost {
		const total = emptyCost();
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
 */
export function computeTreeCost(
	rootGoalId: string,
	allGoals: TreeCostGoal[],
	costTracker: CostTracker,
	sessionIdsForGoal: SessionIdsForGoalFn,
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
		const sids = sessionIdsForGoal(g.id);
		const cost = costTracker.getGoalCost(g.id, sids);
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
