/** Relationship fields used to connect archived sessions to sessions or goals. */
export interface ArchivedBfsSession {
	id: string;
	delegateOf?: string;
	parentSessionId?: string;
	teamLeadSessionId?: string;
	teamGoalId?: string;
	goalId?: string;
}

/**
 * Reference implementation of the former route-local traversal. This is kept
 * for equivalence tests; production callers should use the indexed variant.
 */
export function bfsEnrichArchivedNaive<T extends ArchivedBfsSession>(
	seedIds: string[],
	allArchived: T[],
): T[] {
	const result: T[] = [];
	const seen = new Set<string>();
	const queue = [...seedIds];
	while (queue.length > 0) {
		const parentId = queue.shift()!;
		for (const session of allArchived) {
			if (!seen.has(session.id) && (
				session.delegateOf === parentId
				|| session.parentSessionId === parentId
				|| session.teamLeadSessionId === parentId
				|| session.teamGoalId === parentId
				|| session.goalId === parentId
			)) {
				seen.add(session.id);
				result.push(session);
				queue.push(session.id);
			}
		}
	}
	return result;
}

/**
 * Walk archived descendants in the same stable BFS order as the reference
 * implementation. Raw rows are indexed once and cloned only when reachable.
 */
export function bfsEnrichArchivedIndexed<T extends ArchivedBfsSession>(
	seedIds: string[],
	allArchivedRaw: Iterable<T>,
	clone: (session: T) => T,
): T[] {
	const byParent = new Map<string, T[]>();
	for (const session of allArchivedRaw) {
		// The old OR predicate could match a row only once for a parent, even when
		// several relationship fields contained the same value.
		const parentKeys = new Set<string>();
		if (session.delegateOf) parentKeys.add(session.delegateOf);
		if (session.parentSessionId) parentKeys.add(session.parentSessionId);
		if (session.teamLeadSessionId) parentKeys.add(session.teamLeadSessionId);
		if (session.teamGoalId) parentKeys.add(session.teamGoalId);
		if (session.goalId) parentKeys.add(session.goalId);
		for (const parentKey of parentKeys) {
			const children = byParent.get(parentKey);
			if (children) children.push(session);
			else byParent.set(parentKey, [session]);
		}
	}

	const result: T[] = [];
	const seen = new Set<string>();
	const queue = [...seedIds];
	for (let head = 0; head < queue.length; head++) {
		for (const session of byParent.get(queue[head]) ?? []) {
			if (seen.has(session.id)) continue;
			seen.add(session.id);
			result.push(clone(session));
			queue.push(session.id);
		}
	}
	return result;
}
