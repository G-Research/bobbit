import { state } from "./state.js";

/**
 * Walk client state for the count of non-archived descendants of `goalId`.
 *
 * Extracted from `dialogs.ts` so synchronous callers (e.g. `api.ts`'s
 * cascade-archive / pause / resume paths) can import it without statically
 * pulling the entire heavy `dialogs.ts` module into the eager
 * session-runtime chunk. `dialogs.ts` re-exports it for backward
 * compatibility; the dialogs themselves are loaded lazily.
 */
export function countDescendants(goalId: string): number {
	// Walk THROUGH archived nodes (mirroring the server's walk-through semantics
	// so a live grandchild under an archived parent is counted). Only count
	// non-archived nodes so the dialog accurately reflects what the cascade will
	// archive beyond what is already archived.
	let total = 0;
	const queue = [goalId];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const cur = queue.shift()!;
		for (const g of state.goals) {
			if (g.parentGoalId !== cur) continue;
			if (seen.has(g.id)) continue;
			seen.add(g.id);
			if (!g.archived) total++;
			queue.push(g.id); // always descend, even through archived
		}
	}
	return total;
}
