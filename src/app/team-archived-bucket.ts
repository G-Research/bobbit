/**
 * Pure helpers for bucketing team-member rows in the sidebar.
 *
 * Problem: `renderTeamGroup` (in render-helpers.ts) was emitting
 * terminated/archived team-member sessions in the "active" bucket above
 * the "Archived" divider. The bug: `teamChildren` includes every
 * non-lead session in `goalSessions`, regardless of status, while
 * `archivedForLiveLead` only pulls from the separate
 * `state.archivedSessions` collection. Recently-terminated members
 * still in `gatewaySessions` slipped past both filters and rendered
 * above the divider.
 *
 * Fix: bucket `teamChildren` by status and merge the terminated ones
 * with `archivedForLiveLead`, deduping by `id` (a session may appear
 * in both `gatewaySessions` with status=terminated AND in
 * `archivedSessions`).
 *
 * This module is intentionally tiny and pure so the bucketing is
 * unit-testable without standing up the full render-helpers state.
 * Tested by `tests/render-helpers-team-archived.test.ts`.
 */

export interface TeamChildLike {
	id: string;
	status?: string;
	archived?: boolean;
}

/**
 * Split a team-lead's children list into live rows (rendered above the
 * "Archived" divider) and recently-terminated rows (rendered below,
 * merged with the fully-purged archived list).
 *
 * Dedup key is `id` — a session present in both `teamChildren`
 * (terminated) and `archivedForLiveLead` (already purged into the
 * archived collection) appears only once, taking the `teamChildren`
 * representation first.
 */
export function bucketTeamChildren<T extends TeamChildLike>(
	teamChildren: T[],
	archivedForLiveLead: T[],
	showArchived: boolean,
): { liveTeamChildren: T[]; archivedBelow: T[] } {
	const liveTeamChildren = teamChildren.filter(
		s => s.status !== "terminated" && !s.archived,
	);
	const recentlyTerminated = showArchived
		? teamChildren.filter(s => s.status === "terminated" || s.archived)
		: [];

	const seen = new Set<string>();
	const archivedBelow: T[] = [];
	for (const s of [...recentlyTerminated, ...archivedForLiveLead]) {
		if (seen.has(s.id)) continue;
		seen.add(s.id);
		archivedBelow.push(s);
	}
	return { liveTeamChildren, archivedBelow };
}
