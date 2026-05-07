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
 *
 * **Subgoals (Experimental) feature gate**: when the system-scope flag is
 * off, the forest collapses to a flat list of top-level goals (every input
 * goal becomes its own root with no children). See
 * docs/design/subgoals-experimental-toggle.md.
 */
import { isSubgoalsEnabled } from "./subgoals-flag.js";

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
	/**
	 * Short id suffix to disambiguate this node from a sibling that shares
	 * the same `goal.title`. Set by `buildNestedGoalForest` only when
	 * collision is detected; undefined for unique siblings. Renderers
	 * should append ` (<suffix>)` to the displayed title when this field
	 * is set so users can tell duplicate-titled goals apart at a glance.
	 */
	displayTitleSuffix?: string;
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
	// R-042: dedupe via byId rather than a parallel `enqueued` Set. The byId
	// Map.set semantics already collapse same-id entries, and we iterate
	// `byId.values()` here so each unique id is visited exactly once.
	for (const g of byId.values()) {
		// Promote orphans (parent not in visible set) to top-level.
		const effectiveParent = g.parentGoalId !== undefined && byId.has(g.parentGoalId)
			? g.parentGoalId
			: undefined;
		const list = childrenByParent.get(effectiveParent);
		if (list) list.push(g);
		else childrenByParent.set(effectiveParent, [g]);
	}
	// Sort children by createdAt ASC, ties broken by id ASC. The tiebreak is
	// what makes the order stable across renders when two goals share a
	// createdAt timestamp (e.g. two same-titled siblings created back-to-back
	// within the same millisecond, or two distinct goals with intentionally
	// matching createdAt). Without it the user saw same-titled "duplicate"
	// audits shuffle order between renders.
	for (const list of childrenByParent.values()) {
		list.sort((a, b) => {
			if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
	}
	return { byId, childrenByParent };
}

function buildNode(
	goal: NestableGoal,
	depth: number,
	idx: BuildIndex,
	opts: ResolvedOpts,
	visited: Set<string>,
): NestedGoalNode {
	// Cycle guard — defensive against any data anomaly that would leave
	// goal X reachable as its own descendant via the parentGoalId chain.
	// `createGoal`'s cycle prevention should make this unreachable, but
	// the tree builder must not loop indefinitely on malformed inputs.
	visited.add(goal.id);

	const directChildren = idx.childrenByParent.get(goal.id) ?? [];
	const node: NestedGoalNode = {
		goal,
		depth,
		children: [],
		descendantCount: 0,
	};
	if (directChildren.length === 0) {
		visited.delete(goal.id);
		return node;
	}
	if (depth + 1 > opts.maxDepth) {
		node.truncatedChildrenCount = directChildren.length;
		visited.delete(goal.id);
		return node;
	}

	// Detect title-collisions among the (about-to-render) sibling set so
	// we can stamp a short id suffix on each colliding node. Without this
	// the user sees "AUDIT: CLAUDE CODE" twice with no way to tell them
	// apart at a glance. The suffix is the first 6 hex chars of the goal id
	// — short enough to keep the row compact, long enough to be unique in
	// any realistic sibling set. Same-id duplicates are already deduped at
	// the index layer, so this only fires for genuine distinct-id sibs.
	const titleCounts = new Map<string, number>();
	for (const child of directChildren) {
		titleCounts.set(child.title, (titleCounts.get(child.title) ?? 0) + 1);
	}

	let descendants = 0;
	for (const child of directChildren) {
		if (visited.has(child.id)) {
			// Cycle detected — render this child as a stub leaf with no
			// further recursion. truncatedChildrenCount marks that we
			// stopped here so the caller can show a placeholder.
			const stub: NestedGoalNode = {
				goal: child,
				depth: depth + 1,
				children: [],
				descendantCount: 0,
				truncatedChildrenCount: 0,
			};
			if ((titleCounts.get(child.title) ?? 0) > 1) {
				stub.displayTitleSuffix = child.id.slice(0, 6);
			}
			node.children.push(stub);
			descendants += 1;
			continue;
		}
		const childNode = buildNode(child, depth + 1, idx, opts, visited);
		if ((titleCounts.get(child.title) ?? 0) > 1) {
			childNode.displayTitleSuffix = child.id.slice(0, 6);
		}
		node.children.push(childNode);
		descendants += 1 + childNode.descendantCount;
	}
	node.descendantCount = descendants;
	visited.delete(goal.id);
	return node;
}

/** Build the full nested forest. Top-level roots are returned in input order. */
export function buildNestedGoalForest(
	goals: NestableGoal[],
	opts?: BuildNestedTreeOpts,
): NestedGoalNode[] {
	// Subgoals (Experimental) feature gate: when off, treat every goal as a
	// top-level root with no nesting. See docs/design/subgoals-experimental-toggle.md.
	if (!isSubgoalsEnabled()) {
		const resolvedFlat = resolveOpts(opts);
		const visibleFlat = resolvedFlat.includeArchived ? goals : goals.filter(g => !g.archived);
		return visibleFlat.map(g => ({
			goal: g,
			depth: 0,
			children: [],
			descendantCount: 0,
		}));
	}
	const resolved = resolveOpts(opts);
	const idx = indexGoals(goals, resolved);
	const visible = resolved.includeArchived ? goals : goals.filter(g => !g.archived);
	// Collect top-level roots first so we can stamp title-collision
	// suffixes on them too (sibling-rule applies at the forest root layer
	// just as it does inside any node's children).
	const rootSeen = new Set<string>();
	const tops: NestableGoal[] = [];
	for (const g of visible) {
		if (rootSeen.has(g.id)) continue;
		const isOrphan = g.parentGoalId !== undefined && !idx.byId.has(g.parentGoalId);
		const isTopLevel = g.parentGoalId === undefined || isOrphan;
		if (!isTopLevel) continue;
		rootSeen.add(g.id);
		tops.push(g);
	}
	const rootTitleCounts = new Map<string, number>();
	for (const t of tops) rootTitleCounts.set(t.title, (rootTitleCounts.get(t.title) ?? 0) + 1);
	const out: NestedGoalNode[] = [];
	for (const g of tops) {
		const node = buildNode(g, 0, idx, resolved, new Set<string>());
		if ((rootTitleCounts.get(g.title) ?? 0) > 1) {
			node.displayTitleSuffix = g.id.slice(0, 6);
		}
		out.push(node);
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
	return buildNode(root, 0, idx, resolved, new Set<string>());
}
