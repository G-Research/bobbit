/**
 * BFS enrichment for archived sessions reachable from a set of "live" seed
 * ids (live session ids + live goal ids), walking delegateOf,
 * parentSessionId, teamLeadSessionId, teamGoalId, and goalId chains.
 *
 * PERF-03: GET /api/sessions' default (non `include=archived`) path is the
 * single most-polled REST route (sidebar poll, every ~5s) and used to pay
 * for the FULL archive on every request: it cloned every archived session
 * across every visible project context (`{...s, colorIndex, archived:true}`)
 * into one array, then re-scanned that entire array once per BFS-queued
 * node. Cost grew with total archive size, not with the (usually tiny)
 * reachable set the sidebar actually renders.
 *
 * `bfsEnrichArchivedIndexed` fixes this: it builds a parent-key -> children
 * index in a single O(N) pass over the raw (uncloned) archived sessions,
 * then walks only the reachable subgraph from the seeds — O(reachable) BFS
 * instead of O(seeds-processed * N) — and only clones/enriches sessions
 * that actually end up in the result.
 *
 * `bfsEnrichArchivedNaive` is the original algorithm, kept so tests can
 * assert the indexed version is behaviorally identical (same set, same
 * order) without duplicating the reference implementation inline.
 */

export interface ArchivedBfsSession {
	id: string;
	delegateOf?: string;
	parentSessionId?: string;
	teamLeadSessionId?: string;
	teamGoalId?: string;
	goalId?: string;
}

/**
 * Reference implementation — O((seeds processed) * N). Do not use on a hot
 * path; kept for equivalence testing against `bfsEnrichArchivedIndexed`.
 */
export function bfsEnrichArchivedNaive<T extends ArchivedBfsSession>(seedIds: string[], allArchived: T[]): T[] {
	const result: T[] = [];
	const seen = new Set<string>();
	const queue = [...seedIds];
	while (queue.length > 0) {
		const parentId = queue.shift()!;
		for (const s of allArchived) {
			if (!seen.has(s.id) && (
				s.delegateOf === parentId ||
				s.parentSessionId === parentId ||
				s.teamLeadSessionId === parentId ||
				s.teamGoalId === parentId ||
				s.goalId === parentId
			)) {
				seen.add(s.id);
				result.push(s);
				queue.push(s.id);
			}
		}
	}
	return result;
}

/**
 * Indexed implementation. Produces the same set + order as
 * `bfsEnrichArchivedNaive` given the same seeds and archived pool
 * (in stable iteration order), but:
 *  - never clones/enriches a session unless it's actually reachable
 *  - never re-scans the full archived pool per queued node
 *
 * `allArchivedRaw` must be iterated in the same order the naive
 * implementation would have seen it (e.g. context-by-context, then each
 * context's `getArchived()` order) for the result order to match exactly.
 * `clone` is applied only to sessions included in the result (e.g. to
 * attach `colorIndex`/`archived` fields) — never to the full pool.
 */
export function bfsEnrichArchivedIndexed<T extends ArchivedBfsSession>(
	seedIds: string[],
	allArchivedRaw: Iterable<T>,
	clone: (s: T) => T,
): T[] {
	// Build parentKey -> children[] once, without cloning. A session can be
	// indexed under multiple distinct keys (e.g. delegateOf and goalId
	// pointing at different parents) but only once per distinct key value —
	// mirrors the naive version's single OR-match per (session, parentId).
	const byParent = new Map<string, T[]>();
	for (const s of allArchivedRaw) {
		const keys = new Set<string>();
		if (s.delegateOf) keys.add(s.delegateOf);
		if (s.parentSessionId) keys.add(s.parentSessionId);
		if (s.teamLeadSessionId) keys.add(s.teamLeadSessionId);
		if (s.teamGoalId) keys.add(s.teamGoalId);
		if (s.goalId) keys.add(s.goalId);
		for (const k of keys) {
			let arr = byParent.get(k);
			if (!arr) {
				arr = [];
				byParent.set(k, arr);
			}
			arr.push(s);
		}
	}

	const result: T[] = [];
	const seen = new Set<string>();
	const queue = [...seedIds];
	while (queue.length > 0) {
		const parentId = queue.shift()!;
		const children = byParent.get(parentId);
		if (!children) continue;
		for (const s of children) {
			if (!seen.has(s.id)) {
				seen.add(s.id);
				result.push(clone(s));
				queue.push(s.id);
			}
		}
	}
	return result;
}
