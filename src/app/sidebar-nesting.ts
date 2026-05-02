/**
 * Pure helper for recursive child-goal rendering in the sidebar (Phase 5a).
 *
 * Builds a structured `NestedGoalNode` forest from a flat list of goals using
 * the `parentGoalId` relation. Returned nodes carry `depth`, `descendantCount`
 * and an optional `truncatedChildrenCount` populated when the render-depth cap
 * is hit. The Phase 5b consumer (sidebar Lit components) walks the forest;
 * this module never touches the DOM and never imports from `lit`.
 *
 * Top-level membership rule: a goal is a top-level root if its `parentGoalId`
 * is undefined OR points at a goal that does not exist in the input list
 * (orphan promotion — covers archived/cross-project parents).
 *
 * Sort: children at every level are ordered by `createdAt` ASC so the sidebar
 * renders in spawn order. Top-level roots are returned in their original
 * input order — the caller decides how to sort the forest itself.
 *
 * Filtering: archived goals are excluded by default. Set `includeArchived`
 * to keep them. The exclusion is structural — if a parent is archived but
 * its children aren't, the children are promoted as orphans.
 *
 * Render-depth cap (`maxDepth`, default 5): when a node's depth + 1 would
 * exceed `maxDepth`, recursion stops and `truncatedChildrenCount` is set to
 * the number of children that would have been included. The cap matches the
 * sidebar's documented depth-5 cap (Phase 5 spec, Lesson 4.22).
 */

export interface NestableGoal {
	id: string;
	parentGoalId?: string;
	rootGoalId?: string;
	archived?: boolean;
	title: string;
	state: "todo" | "in-progress" | "complete" | "shelved";
	paused?: boolean;
	createdAt: number;
}

export interface NestedGoalNode {
	goal: NestableGoal;
	depth: number;
	children: NestedGoalNode[];
	/** Total descendant count (children + grandchildren etc.) */
	descendantCount: number;
	/** True when render-depth cap was hit and N children were elided */
	truncatedChildrenCount?: number;
}

export interface BuildNestedTreeOpts {
	/** Maximum depth to recurse. Default 5 (matches sidebar render cap). */
	maxDepth?: number;
	/** Filter — only include non-archived by default. */
	includeArchived?: boolean;
}

const DEFAULT_MAX_DEPTH = 5;

interface ResolvedOpts {
	maxDepth: number;
	includeArchived: boolean;
}

function resolveOpts(opts?: BuildNestedTreeOpts): ResolvedOpts {
	return {
		maxDepth: opts?.maxDepth ?? DEFAULT_MAX_DEPTH,
		includeArchived: opts?.includeArchived ?? false,
	};
}

interface BuildIndex {
	byId: Map<string, NestableGoal>;
	childrenByParent: Map<string | undefined, NestableGoal[]>;
}

function indexGoals(goals: NestableGoal[], opts: ResolvedOpts): BuildIndex {
	const visible = opts.includeArchived ? goals : goals.filter(g => !g.archived);
	const byId = new Map<string, NestableGoal>();
	for (const g of visible) byId.set(g.id, g);
	const childrenByParent = new Map<string | undefined, NestableGoal[]>();
	for (const g of visible) {
		// Promote orphans (parent not in visible set) to top-level.
		const effectiveParent = g.parentGoalId !== undefined && byId.has(g.parentGoalId)
			? g.parentGoalId
			: undefined;
		const list = childrenByParent.get(effectiveParent);
		if (list) list.push(g);
		else childrenByParent.set(effectiveParent, [g]);
	}
	// Sort children by createdAt ASC.
	for (const list of childrenByParent.values()) {
		list.sort((a, b) => a.createdAt - b.createdAt);
	}
	return { byId, childrenByParent };
}

function buildNode(
	goal: NestableGoal,
	depth: number,
	idx: BuildIndex,
	opts: ResolvedOpts,
): NestedGoalNode {
	const directChildren = idx.childrenByParent.get(goal.id) ?? [];
	const node: NestedGoalNode = {
		goal,
		depth,
		children: [],
		descendantCount: 0,
	};
	if (directChildren.length === 0) return node;
	if (depth + 1 > opts.maxDepth) {
		node.truncatedChildrenCount = directChildren.length;
		return node;
	}
	let descendants = 0;
	for (const child of directChildren) {
		const childNode = buildNode(child, depth + 1, idx, opts);
		node.children.push(childNode);
		descendants += 1 + childNode.descendantCount;
	}
	node.descendantCount = descendants;
	return node;
}

/** Build the full nested forest. Top-level roots are returned in input order. */
export function buildNestedGoalForest(
	goals: NestableGoal[],
	opts?: BuildNestedTreeOpts,
): NestedGoalNode[] {
	const resolved = resolveOpts(opts);
	const idx = indexGoals(goals, resolved);
	const visible = resolved.includeArchived ? goals : goals.filter(g => !g.archived);
	const out: NestedGoalNode[] = [];
	for (const g of visible) {
		const isOrphan = g.parentGoalId !== undefined && !idx.byId.has(g.parentGoalId);
		const isTopLevel = g.parentGoalId === undefined || isOrphan;
		if (!isTopLevel) continue;
		out.push(buildNode(g, 0, idx, resolved));
	}
	return out;
}

/** Build a single rooted subtree at the requested goal id. */
export function buildNestedSubtree(
	rootId: string,
	goals: NestableGoal[],
	opts?: BuildNestedTreeOpts,
): NestedGoalNode | undefined {
	const resolved = resolveOpts(opts);
	const idx = indexGoals(goals, resolved);
	const root = idx.byId.get(rootId);
	if (!root) return undefined;
	return buildNode(root, 0, idx, resolved);
}
