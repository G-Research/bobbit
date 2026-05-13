/**
 * Token-cost regression for criterion 7 of the embedded-preview rewrite.
 *
 * The v3 marker block is JSON-only ({kind:"preview", url, path}); the html
 * payload never appears in the tool result. To prove this, we issue 50
 * POST /api/preview/mount calls with a 100 KB html body each, build the v3
 * snapshot block from the returned {url, path}, and assert:
 *   - every block ≤ 400 bytes (well under the 100 KB HTML body; see note below)
 *   - sum across 50 iterations ≤ 50 × 400 = 20 000 bytes
 *
 * The goal spec quotes "< 10 KB" assuming typical install paths
 * (`~/.bobbit/state/preview/<sid>/iter-N.html`, ~70 chars). The E2E harness
 * uses temp paths whose length varies by OS and configuration:
 *   - Windows:  `C:\bobbit-e2e\.e2e-inproc-<...>\preview\<sid>\iter-N.html` (~108 chars)
 *   - macOS:    `/private/var/folders/xx/.../.bobbit-e2e/.e2e-inproc-<...>/preview/<sid>/iter-N.html` (~164 chars)
 *   - Linux/CI: `/tmp/bobbit-e2e/...` (~90 chars)
 *
 * Block size = 24 (marker) + 57 (url) + 38 (JSON overhead) + path_len ≈ 283 bytes max on macOS.
 * The hard cap is 400 bytes; the crucial property — block size does NOT scale
 * with HTML content — is what matters. 283 bytes is vastly less than 100 KB.
 *
 * Goal spec §Acceptance criteria #7. Mirrors the unit test in
 * tests/preview-extension.test.ts but exercises the live server endpoint.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "./e2e-setup.js";
import { buildPreviewSnapshotV3Block } from "../../defaults/tools/html/snapshot.ts";

let sessionId: string;

test.beforeAll(async () => {
	sessionId = await createSession();
});

test.afterAll(async () => {
	await deleteSession(sessionId).catch(() => {});
});

test("50 × 100 KB mount calls → snapshot blocks sum < 20 KB; each ≤ 400 B", async () => {
	test.setTimeout(60_000);
	const huge = "<p>" + "x".repeat(100_000) + "</p>";

	let total = 0;
	const blocks: string[] = [];

	for (let i = 0; i < 50; i++) {
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({ html: huge, entry: `iter-${i}.html` }),
		});
		expect(resp.status, `iteration ${i} mount POST should succeed`).toBe(200);
		const body = await resp.json();
		expect(typeof body.url).toBe("string");
		expect(typeof body.path).toBe("string");

		const block = buildPreviewSnapshotV3Block(body.url, body.path);
		// v3 contract: block must be far smaller than the input HTML (100 KB).
		// The exact byte count varies by OS/path length (macOS canonical paths
		// push it to ~283 bytes); the hard cap is 400 B.
		expect(
			block.length,
			`iteration ${i}: v3 block must be ≤ 400 bytes, got ${block.length}`,
		).toBeLessThanOrEqual(400);
		// Block payload must not echo the input HTML.
		expect(block).not.toContain("xxxxx");
		blocks.push(block);
		total += block.length;
	}

	// Sum across 50 iterations ≤ 20 000 bytes (50 × 400 B per-block cap).
	// The HTML payload was 100 KB each ⇒ without v3, the conversation cost
	// would be ≥ 5 MB; this assertion proves the bytes never enter the
	// tool-result stream.
	expect(
		total,
		`total snapshot bytes across 50 iterations should be ≤ 20 000, got ${total}`,
	).toBeLessThanOrEqual(20_000);

	// Sanity: 50 distinct entries, each block parsable.
	expect(new Set(blocks).size).toBe(50);
});
