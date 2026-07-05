/**
 * E2E: the FlexSearch `files` source (NAV-doc-knowledge-retrieval / F10) —
 * a real doc under `docs/**` becomes searchable via `GET /api/search`
 * after a rebuild, through the exact same route the `search` tool
 * (defaults/tools/harness/search.yaml) and the web UI's full search page use.
 *
 * Complements the unit-level FilesIndexSource coverage in
 * tests/search/files-source.spec.ts (index/query/exclusion in isolation) by
 * exercising the real REST route + real ProjectContext wiring end-to-end.
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./in-process-harness.js";
import { apiFetch, defaultProject } from "./e2e-setup.js";

const TOKEN = `QuackerDocSearchE2E${Date.now()}`;

test.describe.configure({ mode: "serial" });

test("a doc placed under docs/ becomes searchable via GET /api/search?type=files after rebuild", async () => {
	const project = await defaultProject();
	const docsDir = path.join(project.rootPath, "docs");
	const docPath = path.join(docsDir, "e2e-search-fixture.md");
	fs.mkdirSync(docsDir, { recursive: true });
	fs.writeFileSync(
		docPath,
		`# E2E fixture\n\n${TOKEN} proves the files source indexes real repo docs end to end.\n`,
		"utf-8",
	);

	try {
		const rebuildResp = await apiFetch("/api/search/rebuild", {
			method: "POST",
			body: JSON.stringify({ projectId: project.id }),
		});
		expect([202, 503]).toContain(rebuildResp.status);
		test.skip(rebuildResp.status === 503, "search stack unavailable in this environment");

		let hit: any;
		await expect.poll(async () => {
			const resp = await apiFetch(
				`/api/search?q=${encodeURIComponent(TOKEN)}&type=files&projectId=${encodeURIComponent(project.id)}`,
			);
			expect(resp.status).toBe(200);
			const body = await resp.json();
			hit = body.results?.[0];
			return hit;
		}, { timeout: 15_000 }).not.toBeUndefined();

		expect(hit.type).toBe("file");
		expect(hit.filePath).toBe("docs/e2e-search-fixture.md");
		expect(hit.startLine).toBe(1);
		expect(typeof hit.snippet).toBe("string");
		expect(hit.snippet.toLowerCase()).toContain(TOKEN.toLowerCase());
		// Snippet is a bounded excerpt, never the whole file body verbatim
		// (the highlighter always wraps matches in <b> and HTML-escapes).
		expect(hit.snippet).toContain("<b>");

		// The stats endpoint's files row count reflects the fixture too.
		const statsResp = await apiFetch(`/api/search/stats?projectId=${encodeURIComponent(project.id)}`);
		expect(statsResp.status).toBe(200);
		const stats = await statsResp.json();
		expect(stats.rowCountsBySource.files).toBeGreaterThanOrEqual(1);
	} finally {
		fs.rmSync(docPath, { force: true });
	}
});

test("GET /api/search accepts type=files as a valid filter (no 400)", async () => {
	const project = await defaultProject();
	const resp = await apiFetch(`/api/search?q=nonexistent-term-xyz&type=files&projectId=${encodeURIComponent(project.id)}`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(Array.isArray(body.results)).toBe(true);
});
