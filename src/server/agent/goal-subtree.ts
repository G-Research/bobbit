/**
 * Shared hierarchical-cascade framework.
 *
 * Single canonical BFS walk over a goal tree, plus a thin async cascade
 * runner that applies an action to every node in walk order. Every
 * cascade operation in the server (archive, pause, resume, teardown,
 * tree-cost rollup, in-flight-child check, descendants endpoint) is
 * expected to route through these helpers — see `docs/goals-workflows-tasks.md`
 * and the design doc on the `goal/hierarchic-5fd09910` branch.
 *
 * Design invariants:
 *   - `walkGoalSubtree` is pure (no I/O, no side effects). Cycle defence
 *     via a `seen` set + a depth cap so pathological persisted state
 *     never hangs the server.
 *   - `includeArchived: false` (default) excludes archived nodes from
 *     output, but STILL walks through their subtrees so a live grandchild
 *     under an archived parent is reachable. Matches the legacy
 *     `listDescendants` walk-through semantics.
 *   - `filter` similarly: a filtered node is omitted from output but its
 *     subtree is still walked.
 *   - `cascadeSubtree.order` is REQUIRED. No silent default — every
 *     call site must declare top-down vs bottom-up at code-review time.
 *   - Errors are collected, not thrown (unless `stopOnError`).
 */

import type { PersistedGoal } from "./goal-store.js";

/** Hard cap on the BFS walk depth, defends against malformed cycles. */
export const SUBTREE_WALK_DEFAULT_DEPTH_CAP = 32;

export interface SubtreeWalkOpts {
	/** Include the root itself in the walk. Default true. */
	includeRoot?: boolean;
	/** Include archived nodes in the output. Default false (still walks through them). */
	includeArchived?: boolean;
	/** Max depth from root (defence against cycles). Default 32. */
	maxDepth?: number;
	/**
	 * Filter applied at each visit. Returning false omits the node from
	 * the output, but the walk still descends into its children.
	 */
	filter?: (g: PersistedGoal) => boolean;
}

/**
 * BFS the subtree rooted at `rootId` over the `parentGoalId` chain.
 * Pure — no I/O, no mutation. Cycle-safe (`seen` set + depth cap).
 */
export function walkGoalSubtree(
	rootId: string,
	allGoals: PersistedGoal[],
	opts: SubtreeWalkOpts = {},
): PersistedGoal[] {
	const {
		includeRoot = true,
		includeArchived = false,
		maxDepth = SUBTREE_WALK_DEFAULT_DEPTH_CAP,
		filter,
	} = opts;
	if (!rootId) return [];

	// Build parent → children adjacency once.
	const byParent = new Map<string, PersistedGoal[]>();
	const byId = new Map<string, PersistedGoal>();
	for (const g of allGoals) {
		byId.set(g.id, g);
		const pid = g.parentGoalId;
		if (!pid) continue;
		if (pid === g.id) continue; // direct self-cycle: drop the edge
		const list = byParent.get(pid);
		if (list) list.push(g); else byParent.set(pid, [g]);
	}

	const accept = (g: PersistedGoal): boolean => {
		if (!includeArchived && g.archived) return false;
		if (filter && !filter(g)) return false;
		return true;
	};

	const out: PersistedGoal[] = [];
	const seen = new Set<string>([rootId]);
	let frontier: string[] = [rootId];

	// Root admission — distinct from descendant admission because `seen`
	// guards us against revisiting the root via a cycle, and includeRoot
	// only controls whether the root appears in the output.
	if (includeRoot) {
		const rootGoal = byId.get(rootId);
		if (rootGoal && accept(rootGoal)) out.push(rootGoal);
	}

	for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
		const next: string[] = [];
		for (const parentId of frontier) {
			const kids = byParent.get(parentId);
			if (!kids) continue;
			for (const kid of kids) {
				if (seen.has(kid.id)) continue;
				seen.add(kid.id);
				if (accept(kid)) out.push(kid);
				// Walk-through: even when `accept` drops a node, descend
				// into its children — live grandchildren under archived
				// or filtered ancestors must still be reachable.
				next.push(kid.id);
			}
		}
		frontier = next;
	}
	return out;
}

export interface CascadeOpts<T> {
	/** Per-node action. Errors collected unless `stopOnError`. */
	apply: (g: PersistedGoal) => Promise<T>;
	/**
	 * Walk order. `top-down` visits the root first; `bottom-up` visits
	 * leaves first (reversed BFS). REQUIRED — every call site must
	 * declare the order at code-review time.
	 */
	order: "top-down" | "bottom-up";
	/** Stop on first error? Default false — collect all and continue. */
	stopOnError?: boolean;
}

export interface CascadeResult<T> {
	processed: Array<{ goalId: string; result: T }>;
	errors: Array<{ goalId: string; error: Error }>;
}

/**
 * Apply an async action to every node in a subtree. Walks via
 * `walkGoalSubtree`, reverses for `bottom-up`, applies sequentially.
 *
 * The `allGoals` snapshot is captured once at call time; callers
 * concerned about concurrent mutations should re-read `goalStore.getAll()`
 * immediately before invoking. The cascade itself does not re-walk.
 */
export async function cascadeSubtree<T>(
	rootId: string,
	allGoals: PersistedGoal[],
	walkOpts: SubtreeWalkOpts,
	cascadeOpts: CascadeOpts<T>,
): Promise<CascadeResult<T>> {
	const nodes = walkGoalSubtree(rootId, allGoals, walkOpts);
	const ordered = cascadeOpts.order === "bottom-up" ? [...nodes].reverse() : nodes;
	const processed: Array<{ goalId: string; result: T }> = [];
	const errors: Array<{ goalId: string; error: Error }> = [];
	for (const g of ordered) {
		try {
			const result = await cascadeOpts.apply(g);
			processed.push({ goalId: g.id, result });
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			errors.push({ goalId: g.id, error: e });
			if (cascadeOpts.stopOnError) break;
		}
	}
	return { processed, errors };
}
