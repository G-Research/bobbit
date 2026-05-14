/**
 * Pure builder for the sidebar's nested child-goal forest. No DOM, no Lit.
 *
 * Invariants:
 * - Top-level roots: `parentGoalId` undefined OR points at an absent goal
 *   (orphan promotion covers archived / cross-project parents).
 * - Children sorted by `createdAt` ASC, ties broken by id.
 * - Archived excluded unless `includeArchived` is set.
 * - `maxDepth` default 5 — beyond cap, `truncatedChildrenCount` is stamped.
 * - Feature-flag-off: forest collapses to a flat list (see below).
 *
 * See docs/nested-goals.md and docs/design/subgoals-experimental-toggle.md.
 */
import { isSubgoalsEnabled } from "./subgoals-flag.js";

export interface NestableGoal {
	id: string;
	parentGoalId?: string;
	rootGoalId?: string;
	archived?: boolean;
	title: string;
	state: "todo" | "in-progress" | "complete" | "shelved" | "blocked";
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
	// Dedupe via byId.values() — Map.set collapses same-id entries.
	for (const g of byId.values()) {
		// Promote orphans (parent not in visible set) to top-level.
		const effectiveParent = g.parentGoalId !== undefined && byId.has(g.parentGoalId)
			? g.parentGoalId
			: undefined;
		const list = childrenByParent.get(effectiveParent);
		if (list) list.push(g);
		else childrenByParent.set(effectiveParent, [g]);
	}
	// Sort children by createdAt ASC, id ASC tiebreak — stable across renders
	// when two siblings share a createdAt timestamp.
	for (const list of childrenByParent.values()) {
		list.sort((a, b) => {
			const aa = (a.archived ? 1 : 0) - (b.archived ? 1 : 0);
			if (aa !== 0) return aa;
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
	// Cycle guard — defensive; createGoal already prevents cycles.
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

	// Title-collision suffix: stamp a 6-hex-char id suffix on siblings that
	// share a title so the user can tell duplicate-titled goals apart.
	const titleCounts = new Map<string, number>();
	for (const child of directChildren) {
		titleCounts.set(child.title, (titleCounts.get(child.title) ?? 0) + 1);
	}

	let descendants = 0;
	for (const child of directChildren) {
		if (visited.has(child.id)) {
			// Cycle detected — render as stub leaf; truncatedChildrenCount=0
			// marks the cut so the caller can show a placeholder.
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
	// Collect roots first so title-collision suffixes apply at the forest
	// root layer too (same sibling-rule as nested children).
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
