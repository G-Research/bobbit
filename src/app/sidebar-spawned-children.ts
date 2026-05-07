/**
 * Pure helpers for the recursive spawned-children sidebar render path.
 *
 * The render-helpers.ts code that drives `renderSpawnedChildGoalRow` →
 * `renderGoalGroup` uses three defensive mechanics that have to behave
 * deterministically on any data shape — including malformed shapes the
 * data layer is supposed to reject (id cycles, duplicate ids in the goal
 * list) but might produce in edge cases or under reducer races. Those
 * mechanics live here so they're unit-testable without Lit / DOM.
 */

export interface SpawnedChildLike {
	id: string;
	parentGoalId?: string | undefined;
	spawnedBySessionId?: string | undefined;
	archived?: boolean | undefined;
	createdAt: number;
	title?: string;
}

/**
 * Filter, dedupe, and sort the goals that should appear under a particular
 * team-lead's expanded block.
 *
 *   - Filter: parentGoalId === parentId, then either:
 *       • stamped child  — spawnedBySessionId === leadId, OR
 *       • unstamped child — leadId === parentLeadId (defence-in-depth
 *         strict-parent attribution: an unstamped orphan only attaches
 *         to its parent's OWN team-lead, never a sibling's).
 *     Archived flag honoured per `showArchived`.
 *   - Dedupe by id (last-write-wins) — defensive guard against state.goals
 *     containing two copies of the same id during a reducer race.
 *   - Sort: createdAt asc, ties broken by id asc — so two distinct goals
 *     with the same title don't shuffle on every render.
 *
 * `parentLeadId` is OPTIONAL. When omitted (or undefined), the unstamped
 * branch never matches and behaviour is identical to the historical
 * stamped-only filter — so legacy callers don't need to change.
 */
export function selectSpawnedChildren<G extends SpawnedChildLike>(
	goals: readonly G[],
	parentId: string,
	leadId: string,
	showArchived: boolean,
	parentLeadId?: string,
): G[] {
	const seen = new Set<string>();
	return goals
		.filter(g =>
			g.parentGoalId === parentId
			&& (g.spawnedBySessionId
				? g.spawnedBySessionId === leadId
				: parentLeadId !== undefined && leadId === parentLeadId)
			&& (showArchived || !g.archived))
		.filter(g => {
			if (seen.has(g.id)) return false;
			seen.add(g.id);
			return true;
		})
		.sort((a, b) => {
			const at = a.createdAt ?? 0;
			const bt = b.createdAt ?? 0;
			if (at !== bt) return at - bt;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
}

/**
 * Return true when `child.id` is already in `renderedAncestors`, meaning
 * the renderer has previously rendered this exact goal as an ancestor of
 * the current row. Callers should render a compact "loop" placeholder
 * instead of recursing into renderGoalGroup again.
 *
 * Note: this only catches **id-cycles**. Two distinct goals with the same
 * title (separate ids) are NOT a cycle — they're legitimate (if confusing)
 * data. The renderer should show both, in deterministic order. Detecting
 * title-collisions is a separate concern (and risky — legitimate sibling
 * patterns can have repeating names).
 */
export function isAncestorCycle(
	childId: string,
	renderedAncestors: ReadonlySet<string> | undefined,
): boolean {
	return renderedAncestors?.has(childId) === true;
}

/**
 * Extend an ancestor set with a new goal id, returning a new Set. Pure —
 * never mutates the input. Used by renderGoalGroup to thread the visited
 * set down to its children.
 */
export function extendAncestors(
	prev: ReadonlySet<string> | undefined,
	goalId: string,
): Set<string> {
	const next = new Set(prev ?? []);
	next.add(goalId);
	return next;
}

/**
 * Compute per-id title-suffix disambiguators for a sibling set. Returns a
 * Map keyed by goal id; the value is the short id-suffix (`id.slice(0, 6)`)
 * for siblings whose `title` collides with at least one other sibling, or
 * undefined for siblings with unique titles. Mirrors the collision-detection
 * logic in `buildNestedGoalForest` so the live spawned-children render
 * path produces the same `(<suffix>)` tag as the archived forest path.
 *
 * Pure — call site decides how to apply the suffix to the rendered title.
 */
export function computeTitleSuffixes<G extends { id: string; title?: string }>(
	siblings: readonly G[],
): Map<string, string | undefined> {
	const titleCounts = new Map<string, number>();
	for (const s of siblings) {
		const t = s.title ?? "";
		titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
	}
	const out = new Map<string, string | undefined>();
	for (const s of siblings) {
		const t = s.title ?? "";
		if ((titleCounts.get(t) ?? 0) > 1) {
			out.set(s.id, s.id.slice(0, 6));
		} else {
			out.set(s.id, undefined);
		}
	}
	return out;
}
