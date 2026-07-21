/**
 * Token-cost regression for criterion 7 of the embedded-preview rewrite.
 *
 * The v3 marker block is JSON-only ({kind:"preview", url, path, entry, contentHash, artifactId});
 * the html payload never appears in the tool result. To prove this, we issue 50
 * POST /api/preview/mount calls with a 100 KB html body each, build the v3
 * snapshot block from the returned {url, relPath, entry, contentHash, artifactId}, and assert:
 *   - every block ≤ 250 bytes  (the canonical v3 contract from snapshot.ts)
 *   - sum across 50 iterations ≤ 50 × 250 = 12 500 bytes
 *
 * Normalisation invariant
 * -----------------------
 * The `path` field stamped into the v3 block is the **project-root-relative**
 * identifier `<sessionId>/<entry>` (forward slashes), NOT the host-absolute
 * path. This is what keeps block size bounded by content shape rather than
 * by where `bobbitStateDir()` happens to live on disk.
 *
 * Earlier revisions of this test bumped the per-block cap (250 → 320 → 400 B)
 * to absorb canonical macOS tmpdir paths (`/private/var/folders/...`) and
 * long Windows E2E harness paths
 * (`C:\Users\...\AppData\Local\Temp\bobbit-e2e\.e2e-inproc-...\state\preview\<sid>\iter-N.html`).
 * Each bump silently weakened the regression guard. The fix landed in PR #599
 * review: the agent tool (`defaults/tools/html/extension.ts`) now feeds
 * `mountResult.relPath` (a short, host-invariant string returned by the
 * gateway) to `buildPreviewSnapshotV3Block` instead of the host-absolute
 * `path`. With that in place, the 250 B cap holds on every OS and any future
 * inflation here is a real regression — DO NOT bump the cap to absorb it.
 *
 * Goal spec §Acceptance criteria #7. Mirrors the unit test in
 * tests/preview-extension.test.ts but exercises the live server endpoint.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	createSession,
	defaultProjectId,
	deleteSession,
	nonGitCwd,
} from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import { buildPreviewSnapshotV3Block, parseSnapshot } from "../../defaults/tools/html/snapshot.ts";

// Keep this token-shape test at five mounts per catalog; same-session catalog
// growth is pinned by the dedicated artifact cost tests.
const SESSION_POOL_SIZE = 10;
let sessionIds: string[] = [];

test.beforeAll(async () => {
	const projectId = await defaultProjectId();
	const cwd = nonGitCwd();
	const creationResults = await Promise.allSettled(
		Array.from({ length: SESSION_POOL_SIZE }, () => createSession({ projectId, cwd })),
	);
	sessionIds = creationResults.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);
	const failures = creationResults.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (failures.length > 0) {
		throw new AggregateError(failures, "Failed to create preview token-cost session pool");
	}
});

test.afterAll(async () => {
	await Promise.allSettled(sessionIds.map((sessionId) => deleteSession(sessionId)));
});

test("50 × 100 KB mount calls → snapshot blocks sum ≤ 12 500 B; each ≤ 250 B", async () => {
	test.setTimeout(60_000);
	const huge = "<p>" + "x".repeat(100_000) + "</p>";

	let total = 0;
	const blocks: string[] = [];

	for (let i = 0; i < 50; i++) {
		const sessionId = sessionIds[i % SESSION_POOL_SIZE]!;
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			// Side-panel tab persistence is orthogonal to the mount response/snapshot
			// contract and would repeatedly serialize the growing 50-tab workspace.
			body: JSON.stringify({ html: huge, entry: `iter-${i}.html`, workspaceTab: false }),
		});
		expect(resp.status, `iteration ${i} mount POST should succeed`).toBe(200);
		const body = await resp.json();
		expect(typeof body.url).toBe("string");
		expect(typeof body.path).toBe("string");
		expect(
			typeof body.relPath,
			`iteration ${i}: response should include relPath`,
		).toBe("string");
		expect(body.relPath.length).toBeGreaterThan(0);
		expect(typeof body.contentHash).toBe("string");
		expect(body.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(typeof body.artifactId).toBe("string");
		expect(body.artifactId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
		expect(body.entry).toBe(`iter-${i}.html`);
		// relPath is host-invariant: always `<sid>/<entry>` with forward slashes.
		expect(body.relPath).toBe(`${sessionId}/iter-${i}.html`);

		// Build the v3 block the way the agent tool does in production:
		// feed the relPath (not the host-abs path) so the block size is
		// bounded by content shape, not install location.
		const block = buildPreviewSnapshotV3Block(body.url, body.relPath, body.contentHash, {
			artifactId: body.artifactId,
			entry: body.entry,
		});
		expect(
			block.length,
			`iteration ${i}: v3 block must be ≤ 250 bytes, got ${block.length}`,
		).toBeLessThanOrEqual(250);
		// Block payload must not echo the input HTML, but must retain immutable
		// restore identity.
		expect(block).not.toContain("xxxxx");
		const parsed = parseSnapshot(block);
		expect(parsed?.kind).toBe("preview");
		if (parsed?.kind === "preview") {
			expect(parsed.entry).toBe(body.entry);
			expect(parsed.artifactId).toBe(body.artifactId);
			expect(parsed.contentHash).toBe(body.contentHash);
		}
		blocks.push(block);
		total += block.length;

		// Each immutable artifact already captured the response identity. Remove the
		// live entry so the next call does not recopy an ever-growing mount fixture.
		fs.rmSync(body.path, { force: true });
	}

	// Sum across 50 iterations ≤ 12 500 bytes (50 × 250 B per-block cap).
	// The HTML payload was 100 KB each ⇒ without v3, the conversation cost
	// would be ≥ 5 MB; this assertion proves the bytes never enter the
	// tool-result stream.
	expect(
		total,
		`total snapshot bytes across 50 iterations should be ≤ 12 500, got ${total}`,
	).toBeLessThanOrEqual(12_500);

	// Sanity: 50 distinct entries, each block parsable.
	expect(new Set(blocks).size).toBe(50);
});
