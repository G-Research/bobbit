/**
 * V2-readiness smoke test.
 *
 * Flows a fixture directory end-to-end through:
 *   FilesIndexSourceStub → (toy indexer) → LanceStore → query-by-source
 *
 * The "toy indexer" here is intentionally inline — we are NOT allowed to
 * touch `indexer.ts` (T5's scope) to prove this. The point is to show
 * that the `IndexSource`/`Indexable` surface is sufficient: adding a new
 * source for files requires zero changes to LanceStore, the Arrow schema,
 * or any other core module.
 *
 * Design reference: docs/design/semantic-search.md §12 (v2-readiness test),
 * §15 T6.
 */

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FilesIndexSourceStub } from "../../src/server/search/sources/files-source.stub.ts";
import { LanceStore, EMBED_DIM, type ContentRow } from "../../src/server/search/lance-store.ts";
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

function zeroEmbedding(): Float32Array {
	return new Float32Array(EMBED_DIM);
}

/**
 * Convert an `Indexable` into a `ContentRow` with a placeholder embedding.
 * Mirrors what the real Indexer will do in T5 — inlined here for the
 * stub so we don't depend on indexer.ts existing yet.
 */
function toRow(i: Indexable): ContentRow {
	const display = i.display ?? {};
	return {
		id: i.id,
		source_id: i.sourceId,
		project_id: i.projectId,
		entity_type: entityTypeOf(i.sourceId),
		parent_id: null,
		archived: i.archived === true,
		timestamp: i.timestamp,
		content_hash: i.contentHash,
		weight: i.weight,
		role: i.role ?? null,
		title: display.title ?? null,
		text: i.text,
		goal_id: typeof i.metadata.goalId === "string" ? i.metadata.goalId : null,
		session_id: typeof i.metadata.sessionId === "string" ? i.metadata.sessionId : null,
		session_title: null,
		file_path: display.filePath ?? null,
		start_line: typeof display.startLine === "number" ? display.startLine : null,
		end_line: typeof display.endLine === "number" ? display.endLine : null,
		embedding: zeroEmbedding(),
	};
}

function entityTypeOf(sourceId: Indexable["sourceId"]): string {
	switch (sourceId) {
		case "goals": return "goal";
		case "sessions": return "session";
		case "messages": return "message";
		case "staff": return "staff";
		case "files": return "file";
	}
}

test("files-source → LanceStore end-to-end without touching core modules", async () => {
	// ── Arrange: fixture directory with a small tree of files ────────
	const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "files-stub-fixture-"));
	fs.writeFileSync(path.join(fixtureDir, "readme.md"), "# Project\n\nHello.\n");
	fs.mkdirSync(path.join(fixtureDir, "src"));
	fs.writeFileSync(path.join(fixtureDir, "src", "a.ts"), "export const a = 1;\n");
	fs.writeFileSync(path.join(fixtureDir, "src", "b.ts"), "export const b = 2;\n");
	fs.writeFileSync(path.join(fixtureDir, "empty"), "");

	// ── LanceStore in a separate tmp dir ─────────────────────────────
	const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "files-stub-store-"));
	const dataDir = path.join(storeDir, "search.lance");
	const store = await LanceStore.open({ dataDir, embedDim: EMBED_DIM });

	try {
		const src = new FilesIndexSourceStub({ fixtureDir });
		const ctx = fakeCtx("proj-v2");

		// ── Act: drain source → rows → upsert ───────────────────────
		const rows: ContentRow[] = [];
		for await (const indexable of src.iterate(ctx)) {
			rows.push(toRow(indexable));
		}
		expect(rows.length).toBe(3); // empty file filtered; 3 real files

		await store.upsert(rows);

		// ── Assert: rows land in the content table with file_path set
		const totalFiles = await store.count("source_id = 'files'");
		expect(totalFiles).toBe(3);

		const allFiles = await store.count();
		expect(allFiles).toBe(3);

		// Query by source_id and verify file_path + display line ranges
		const results = (await store
			.query()
			.where("source_id = 'files'")
			.limit(10)
			.toArray()) as unknown as Array<Record<string, unknown>>;
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
