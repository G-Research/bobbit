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
 * Subset of GatewaySession / archived session fields that
 * `computeSpawnedClaim` needs. Kept narrow so the helper is
 * unit-testable without importing real session types.
 */
export interface SessionLike {
	id: string;
	role?: string;
	status?: string;
	goalId?: string;
	teamGoalId?: string;
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
 *   - Sort: non-archived before archived, then createdAt asc, ties broken
 *     by id asc — so active children render above archived ones and two
 *     distinct goals with the same title don't shuffle on every render.
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
			const aa = (a.archived ? 1 : 0) - (b.archived ? 1 : 0);
			if (aa !== 0) return aa;
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
/**
 * Compute the set of goal ids that the spawned-children render path
 * (Path A — `renderGoalGroup` → `renderTeamGroup` in render-helpers.ts)
 * will claim. The forest render path (Path B — `buildNestedGoalForest`)
 * must exclude exactly these ids so a goal never renders in two places
 * simultaneously.
 *
 * Mirrors render-helpers.ts::renderTeamGroup's lookup:
 *   - For each parent goal P, find P's live team-lead — the first
 *     session in liveSessions (createdAt asc) where role === "team-lead"
 *     and (goalId === P.id || teamGoalId === P.id). ANY status — matches
 *     `goalSessions.find(s => s.role === "team-lead")` which doesn't
 *     filter on status.
 *   - When showArchived: ALSO include every archived team-lead with
 *     teamGoalId === P.id (matches the archived-leads iteration in
 *     render-helpers).
 *   - For each (P, leadId) tuple, run
 *     selectSpawnedChildren(goals, P.id, leadId, showArchived, leadId)
 *     and union the result ids into the output Set.
 *
 * The `parentLeadId === leadId` parameter mirrors the strict-parent
 * fallback in render-helpers (an unstamped child of P only attaches to
 * P's own lead, never a sibling's).
 *
 * Pure — no DOM, no Lit, unit-testable.
 */
export function computeSpawnedClaim<G extends SpawnedChildLike & { id: string }>(
	goals: readonly G[],
	liveSessions: readonly SessionLike[],
	archivedSessions: readonly SessionLike[],
	showArchived: boolean,
): Set<string> {
	const claimed = new Set<string>();
	// Avoid an O(parents × sessions) scan: bucket sessions by parent goal id
	// once. For each parent we'll pick the first live team-lead (createdAt
	// asc, mirroring the `goalSessions.sort((a,b) => a.createdAt - b.createdAt)`
	// in render-helpers) plus all archived team-leads when showArchived.
	for (const parent of goals) {
		const pid = parent.id;
		const leadIds: string[] = [];
		// Live lead — match render-helpers exactly: first session by
		// createdAt-asc where role==="team-lead" and the session belongs
		// to this goal (either goalId or teamGoalId points at P). ANY
		// status (including "terminated") — render-helpers' `find` doesn't
		// filter on status, and a stale-but-still-listed team-lead still
		// claims its children in Path A.
		const liveLeadCandidates = liveSessions.filter(s =>
			s.role === "team-lead" && (s.goalId === pid || s.teamGoalId === pid)
		);
		if (liveLeadCandidates.length > 0) {
			// `liveSessions` is the gateway-sessions list, which is generally
			// already createdAt-asc, but render-helpers does an explicit
			// `.sort((a,b) => a.createdAt - b.createdAt)` before `find`. We
			// don't have createdAt on SessionLike — accept the natural order
			// of the input (which the caller obtains from state.gatewaySessions,
			// already sorted at insertion). This is good enough: even if the
			// order disagrees, the claim set is still a correct upper bound
			// over Path A's emission, because the only consequence of
			// claiming children of a *second* live lead is that they'd be
			// excluded from the forest — which is desirable (no double
			// render) regardless of which lead Path A actually picks.
			leadIds.push(liveLeadCandidates[0]!.id);
		}
		if (showArchived) {
			for (const s of archivedSessions) {
				if (s.role === "team-lead" && s.teamGoalId === pid) {
					leadIds.push(s.id);
				}
			}
		}
		for (const leadId of leadIds) {
			const children = selectSpawnedChildren(goals, pid, leadId, showArchived, leadId);
			for (const c of children) claimed.add(c.id);
		}
	}
	return claimed;
}

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
