/**
 * `StaffIndexSource` — yields one `Indexable` per staff member.
 *
 * Per design §5:
 *   role    = "profile"
 *   weight  = 1.5
 *   text    = `name + "\n\n" + description`
 *   id      = `staff:<staffId>`
 */

import type { IndexSource, IndexSourceContext, Indexable } from "../types.js";
import { contentHashOf } from "./hash.js";

export class StaffIndexSource implements IndexSource {
	readonly sourceId = "staff" as const;

	async *iterate(ctx: IndexSourceContext): AsyncIterable<Indexable> {
		const entries = ctx.staffStore.getAll();
		for (const staff of entries) {
			const name = (staff.name ?? "").trim();
			const description = (staff.description ?? "").trim();
			if (!name && !description) continue;
			const text = name && description ? `${name}\n\n${description}` : name || description;
			const weight = 1.5;
			const role = "profile" as const;
			const timestamp = staff.updatedAt ?? staff.createdAt ?? 0;
			const metadata: Record<string, string | number | boolean> = {
				staffId: staff.id,
				state: staff.state ?? "",
			};
			if (staff.projectId) metadata.projectIdRef = staff.projectId;
			if (staff.roleId) metadata.roleId = staff.roleId;

			const indexable: Indexable = {
				id: `staff:${staff.id}`,
				sourceId: "staff",
				text,
				metadata,
				contentHash: contentHashOf(text, weight, role, timestamp),
				timestamp,
				projectId: staff.projectId ?? ctx.projectId,
				archived: false,
				weight,
				role,
				display: {
					title: name,
					snippet: description.slice(0, 300),
				},
			};
			yield indexable;
		}
	}
}
