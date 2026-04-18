/**
 * `GoalIndexSource` — yields one `Indexable` per goal for the semantic
 * search pipeline.
 *
 * Per design §5 (Content policy):
 *   role    = "spec"
 *   weight  = 2.5
 *   text    = `title + "\n\n" + spec`
 *   id      = `goal:<goalId>`
 *
 * Archived goals are still emitted (with `archived=true`) so search can
 * surface them under the "include archived" filter. Empty-text goals
 * (no title AND no spec) are skipped — nothing useful to embed.
 */

import type { IndexSource, IndexSourceContext, Indexable } from "../types.js";
import { contentHashOf } from "./hash.js";

export class GoalIndexSource implements IndexSource {
	readonly sourceId = "goals" as const;

	async *iterate(ctx: IndexSourceContext): AsyncIterable<Indexable> {
		const goals = ctx.goalStore.getAll();
		for (const goal of goals) {
			const title = (goal.title ?? "").trim();
			const spec = (goal.spec ?? "").trim();
			if (!title && !spec) continue;
			const text = title && spec ? `${title}\n\n${spec}` : title || spec;
			const weight = 2.5;
			const role = "spec" as const;
			const timestamp = goal.updatedAt ?? goal.createdAt ?? 0;
			const indexable: Indexable = {
				id: `goal:${goal.id}`,
				sourceId: "goals",
				text,
				metadata: {
					goalId: goal.id,
					state: goal.state ?? "",
					...(goal.projectId ? { projectIdRef: goal.projectId } : {}),
				},
				contentHash: contentHashOf(text, weight, role, timestamp),
				timestamp,
				projectId: goal.projectId ?? ctx.projectId,
				archived: goal.archived === true,
				weight,
				role,
				display: {
					title,
					snippet: spec.slice(0, 300),
				},
			};
			yield indexable;
		}
	}
}
