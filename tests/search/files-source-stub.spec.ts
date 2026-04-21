/**
 * V2-readiness smoke test.
 *
 * Flows a fixture directory end-to-end through:
 *   FilesIndexSourceStub → (inline toy mapper) → FlexSearchStore → query-by-source
 *
 * The mapper is intentionally inline — we are NOT allowed to touch
 * `indexer.ts` to prove this. The point is to show that the
 * `IndexSource`/`Indexable` surface is sufficient: adding a new source
 * for files requires zero changes to the store.
 *
 * Design reference: docs/design/portable-search.md §12.
 */

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FilesIndexSourceStub } from "../../src/server/search/sources/files-source.stub.ts";
import { FlexSearchStore, type FlexDoc } from "../../src/server/search/flex-store.ts";
import type { Indexable, IndexSourceContext } from "../../src/server/search/types.ts";
import type { GoalStore } from "../../src/server/agent/goal-store.ts";
import type { SessionStore } from "../../src/server/agent/session-store.ts";
import type { StaffStore } from "../../src/server/agent/staff-store.ts";

test.setTimeout(60_000);

function fakeCtx(projectId: string): IndexSourceContext {
	return {
		projectId,
		goalStore: { getAll: () => [] } as unknown as GoalStore,
		sessionStore: { getAll: () => [] } as unknown as SessionStore,
		staffStore: { getAll: () => [] } as unknown as StaffStore,
	};
}

function toDoc(i: Indexable): FlexDoc {
	const display = i.display ?? {};
	return {
		id: i.id,
		source_id: i.sourceId,
		project_id: i.projectId,
		entity_type: entityTypeOf(i.sourceId),
		parent_id: null,
		archived: i.archived === true,
		archived_tag: i.archived ? "true" : "false",
		timestamp: i.timestamp,
		content_hash: i.contentHash,
		weight: i.weight,
		role: i.role ?? null,
		title: display.title ?? null,
		text: i.text,
		identifier_text: "",
		goal_id: typeof i.metadata.goalId === "string" ? i.metadata.goalId : null,
		session_id: typeof i.metadata.sessionId === "string" ? i.metadata.sessionId : null,
		session_title: null,
		file_path: display.filePath ?? null,
		start_line: typeof display.startLine === "number" ? display.startLine : null,
		end_line: typeof display.endLine === "number" ? display.endLine : null,
	};
}

function entityTypeOf(sourceId: Indexable["sourceId"]): FlexDoc["entity_type"] {
	switch (sourceId) {
		case "goals": return "goal";
		case "sessions": return "session";
		case "messages": return "message";
		case "staff": return "staff";
		case "files": return "file";
	}
}

test("files-source → FlexSearchStore end-to-end without touching core modules", async () => {
	const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "files-stub-fixture-"));
	fs.writeFileSync(path.join(fixtureDir, "readme.md"), "# Project\n\nHello.\n");
	fs.mkdirSync(path.join(fixtureDir, "src"));
	fs.writeFileSync(path.join(fixtureDir, "src", "a.ts"), "export const a = 1;\n");
	fs.writeFileSync(path.join(fixtureDir, "src", "b.ts"), "export const b = 2;\n");
	fs.writeFileSync(path.join(fixtureDir, "empty"), "");

	const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "files-stub-store-"));
	const dataDir = path.join(storeDir, "search.flex");
	const store = await FlexSearchStore.open({ dataDir });

	try {
		const src = new FilesIndexSourceStub({ fixtureDir });
		const ctx = fakeCtx("proj-v2");

		const docs: FlexDoc[] = [];
		for await (const indexable of src.iterate(ctx)) {
			docs.push(toDoc(indexable));
		}
		expect(docs.length).toBe(3);

		await store.upsert(docs);

		expect(store.count({ source_id: "files" })).toBe(3);
		expect(store.count()).toBe(3);

		const results = store.list({ source_id: "files", limit: 10 });
		expect(results.length).toBe(3);
		for (const r of results) {
			expect(typeof r.file_path).toBe("string");
			expect((r.file_path as string).length).toBeGreaterThan(0);
			expect(r.start_line).toBe(1);
			expect(typeof r.end_line).toBe("number");
			expect(r.project_id).toBe("proj-v2");
			expect(r.source_id).toBe("files");
		}
		const paths = results.map((r) => r.file_path).sort();
		expect(paths).toEqual(["readme.md", "src/a.ts", "src/b.ts"]);
	} finally {
		await store.close();
		fs.rmSync(fixtureDir, { recursive: true, force: true });
		fs.rmSync(storeDir, { recursive: true, force: true });
	}
});
