/**
 * `SessionIndexSource` — yields one `Indexable` per session.
 *
 * Per design §5:
 *   role   = "title"
 *   weight = 3.0
 *   text   = session title (only the title is indexed as searchable text
 *            — goal title and role are denormalised into `metadata` so
 *             filters can reference them without polluting the embedded
 *             text content).
 *   id     = `session:<sessionId>`
 *
 * Sessions with no title are skipped (nothing to embed).
 */

import type { IndexSource, IndexSourceContext, Indexable } from "../types.js";
import { contentHashOf } from "./hash.js";

export class SessionIndexSource implements IndexSource {
	readonly sourceId = "sessions" as const;

	async *iterate(ctx: IndexSourceContext): AsyncIterable<Indexable> {
		const sessions = ctx.sessionStore.getAll();
		// Build goalId → goalTitle map once for denormalisation.
		const goalTitleMap = new Map<string, string>();
		for (const g of ctx.goalStore.getAll()) {
			goalTitleMap.set(g.id, g.title ?? "");
		}

		for (const session of sessions) {
			const title = (session.title ?? "").trim();
			if (!title) continue;
			const text = title;
			const weight = 3.0;
			const role = "title" as const;
			const timestamp = session.createdAt ?? session.lastActivity ?? 0;
			const goalTitle = session.goalId
				? goalTitleMap.get(session.goalId) ?? ""
				: "";
			const metadata: Record<string, string | number | boolean> = {
				sessionId: session.id,
			};
			if (session.goalId) metadata.goalId = session.goalId;
			if (goalTitle) metadata.goalTitle = goalTitle;
			if (session.role) metadata.agentRole = session.role;
			if (session.projectId) metadata.projectIdRef = session.projectId;

			const indexable: Indexable = {
				id: `session:${session.id}`,
				sourceId: "sessions",
				text,
				metadata,
				contentHash: contentHashOf(text, weight, role, timestamp),
				timestamp,
				projectId: session.projectId ?? ctx.projectId,
				archived: session.archived === true,
				weight,
				role,
				display: {
					title,
					snippet: title,
				},
			};
			yield indexable;
		}
	}
}
