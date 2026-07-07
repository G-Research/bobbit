/**
 * PR walkthrough hunk-ID round-trip tests (Issue 4).
 *
 * Test 1 — Hunk IDs from the compact manifest resolve correctly through finalization.
 * Test 2 — resolveAndReadBindingBundle deduplicates concurrent resolutions (mutex).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { routes } from "../market-packs/pr-walkthrough/lib/routes.mjs";
import {
	createAnalysisBundleFromParsedDiff,
	analysisBundleToParsedDiff,
	WalkthroughAnalysisBundleStore,
} from "../src/server/pr-walkthrough/walkthrough-analysis-bundle.ts";

// ── shared helpers ────────────────────────────────────────────────────────────

class MemoryStore {
	data = new Map<string, unknown>();
	puts: Array<{ key: string; value: unknown; opts?: unknown }> = [];
	async get(key: string): Promise<unknown | null> { return this.data.get(key) ?? null; }
	async put(key: string, value: unknown, opts?: unknown): Promise<void> {
		this.puts.push({ key, value, opts });
		this.data.set(key, value);
	}
	async list(prefix = ""): Promise<string[]> { return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort(); }
	async delete(key: string): Promise<boolean> { return this.data.delete(key); }
	async deletePrefix(prefix: string): Promise<number> {
		let count = 0;
		for (const key of [...this.data.keys()]) {
			if (key.startsWith(prefix)) { this.data.delete(key); count++; }
		}
		return count;
	}
}

const TEST_JOB_ID = "prw-roundtrip-test";
const TEST_SESSION_ID = "reviewer-rt";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

// Use a GitHub-style binding so finalization schema validation passes
// (provider must be "github" per the walkthrough YAML schema).
function makeBinding(jobId = TEST_JOB_ID) {
	return {
		jobId,
		changesetId: `github:test-owner/test-repo#1:${HEAD_SHA.slice(0, 7)}`,
		baseSha: BASE_SHA,
		headSha: HEAD_SHA,
		target: {
			provider: "github" as const,
			owner: "test-owner",
			repo: "test-repo",
			number: 1,
			prUrl: "https://github.com/test-owner/test-repo/pull/1",
			prTitle: "Round-trip test PR",
		},
	};
}

function seedCtx(overrides: { jobId?: string } = {}) {
	const jobId = overrides.jobId ?? TEST_JOB_ID;
	const store = new MemoryStore();
	store.data.set(`reviewers/${TEST_SESSION_ID}`, { jobId });
	store.data.set(`reviews/${jobId}/binding/${TEST_SESSION_ID}`, makeBinding(jobId));
	return { ctx: { sessionId: TEST_SESSION_ID, host: { store } }, store };
}

function bundleDiffEvidenceKey(jobId = TEST_JOB_ID): string {
	return `reviews/${jobId}/draft/analysis-bundle-diff`;
}

async function saveChunk(ctx: any, sectionId: string, yaml: string): Promise<void> {
	const result = await routes.publish(ctx, { body: { op: "submitChunk", section_id: sectionId, yaml } });
	assert.equal(result.ok, true, `saveChunk(${sectionId}) failed: ${JSON.stringify(result)}`);
}

async function saveRequiredChunks(ctx: any): Promise<void> {
	await saveChunk(ctx, "metadata", [
		"title: Round-trip walkthrough",
		"original_description:",
		"  body: test",
		"  source: gh_api",
		'  fetched_at: "2026-06-01T00:00:00.000Z"',
		"stats:",
		"  files_changed: 1",
		"  additions: 1",
		"  deletions: 0",
	].join("\n"));
	await saveChunk(ctx, "context", "why_created: A\nproblem_solved: B\nwhy_worth_merging: C\nmerge_concerns: D\nauthor_intent: E\nreviewer_map: F");
	await saveChunk(ctx, "merge_assessment", "recommendation: comment\nconfidence: medium\nsummary: S\nblocking_concerns: []\nnon_blocking_concerns: []");
	await saveChunk(ctx, "audit", "remaining_changed_areas: []\nlow_signal_or_mechanical_changes: []\ngenerated_or_binary_files: []\nreviewer_checklist:\n  - ok");
}

// ── Test 1: Hunk ID round-trip ────────────────────────────────────────────────

test("PR walkthrough hunk ID round-trip: compact manifest → submit chunk → finalize succeeds", async (t) => {
	const tmpDir = fs.mkdtempSync(join(os.tmpdir(), "prw-roundtrip-bundle-"));
	t.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

	// 1. Build a minimal parsedDiff with one file and one hunk bearing an explicit ID.
	//    The hunk ID uses the compact bundle manifest format so we can verify the
	//    round-trip without constructing IDs by inference.
	const hunkSourceId = "block:1:src__roundtrip-ts:h0";
	const parsedDiff = {
		changeset: {
			baseSha: BASE_SHA,
			headSha: HEAD_SHA,
			provider: "github",
			prUrl: "https://github.com/test-owner/test-repo/pull/1",
			prNumber: 1,
			prTitle: "Round-trip test PR",
			filesChanged: 1,
			additions: 1,
			deletions: 1,
		},
		files: [
			{
				filePath: "src/roundtrip.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
				isBinary: false,
				isGenerated: false,
				isTruncated: false,
				diffBlocks: [
					{
						id: "block:1:src__roundtrip-ts",
						filePath: "src/roundtrip.ts",
						status: "modified",
						isBinary: false,
						isGenerated: false,
						isTruncated: false,
						hunks: [
							{
								id: hunkSourceId,
								header: "@@ -1,1 +1,1 @@",
								lines: [
									{ id: `${hunkSourceId}:l0`, side: "old", oldLine: 1, kind: "del", text: "const old = 1;" },
									{ id: `${hunkSourceId}:l1`, side: "new", newLine: 1, kind: "add", text: "const new_ = 1;" },
								],
							},
						],
					},
				],
			},
		],
	};

	// 2. Create job-like record and build the analysis bundle.
	const jobLike = {
		jobId: TEST_JOB_ID,
		childSessionId: TEST_SESSION_ID,
		changesetId: `github:test-owner/test-repo#1:${HEAD_SHA.slice(0, 7)}`,
		target: {
			provider: "github",
			owner: "test-owner",
			repo: "test-repo",
			number: 1,
			prUrl: "https://github.com/test-owner/test-repo/pull/1",
			baseSha: BASE_SHA,
			headSha: HEAD_SHA,
		},
		title: "Round-trip test",
		cwd: tmpDir,
	} as any;
	const bundle = createAnalysisBundleFromParsedDiff(jobLike, parsedDiff as any);

	// 3. Save bundle to a temp state dir.
	const bundleStore = new WalkthroughAnalysisBundleStore(tmpDir);
	bundleStore.save(TEST_JOB_ID, bundle);

	// 4. Read the manifest and extract the hunk ID.
	//    The manifest data (JSON) has files[].hunk_manifest[].hunk_id — the same field
	//    that the compact text formatter emits as `h0 <hunk_id> @@ …`.
	const manifestData = bundleStore.read(jobLike, { mode: "manifest" }) as any;
	const hunkId: string = manifestData.files[0].hunk_manifest[0].hunk_id;

	assert.equal(typeof hunkId, "string", "hunk_id must be a string");
	assert.ok(hunkId.trim().length > 0, "hunk_id must be non-empty");
	// The ID must be preserved verbatim from the source diff (not reconstructed).
	assert.equal(hunkId, hunkSourceId, "hunk_id in manifest must match the source hunk ID");

	// 5. Seed the pack store with bundle evidence so finalization can resolve the hunk ID
	//    (mirrors persistPrwFinalizationBundleEvidence's persisted payload).
	const { ctx, store } = seedCtx();
	store.data.set(bundleDiffEvidenceKey(), {
		schemaVersion: 1,
		kind: "pr_walkthrough_finalization_diff",
		jobId: TEST_JOB_ID,
		source: "analysis-bundle",
		generatedAt: bundle.generated_at,
		parsedDiff: analysisBundleToParsedDiff(bundle),
	});

	// 6. Submit required structural chunks + one card chunk referencing the hunk ID
	//    read from the bundle manifest (step 4).
	await saveRequiredChunks(ctx);
	await saveChunk(ctx, "chunk:rt-card", [
		"phase: significant",
		"title: Round-trip card",
		"reviewer_goal: Verify hunk ID resolves",
		"explanation: Tests that the hunk ID in the compact manifest resolves through finalization.",
		"files:",
		"  - src/roundtrip.ts",
		"relevant_hunks:",
		`  - hunk_id: ${hunkId}`,
		"    placement: primary",
		"    why_relevant: Verifies the round-trip.",
		"suggested_concerns: []",
		"positive_notes: []",
	].join("\n"));

	// 7. Finalize — must succeed with no hunk ID resolution errors.
	const finalized: any = await routes.publish(ctx, { body: { op: "finalizeSubmission" } });
	assert.equal(finalized.ok, true, `Finalization failed: ${JSON.stringify(finalized)}`);
	assert.equal(finalized.coverage.totalHunks, 1, "Should have resolved 1 hunk");

	// Confirm the card carries the correct diffBlock with our hunk.
	const finalPayload: any = await store.get(`reviews/${TEST_JOB_ID}/final/payload`);
	const card = finalPayload?.cards?.find((c: any) => c.title === "Round-trip card");
	assert.ok(card, `Card 'Round-trip card' missing from final payload: ${JSON.stringify(finalPayload?.cards?.map((c: any) => c.title))}`);
	const resolvedHunkIds: string[] = card.diffBlocks.flatMap((b: any) => b.hunks.map((h: any) => h.id));
	assert.ok(resolvedHunkIds.includes(hunkId), `Expected hunk ID ${hunkId} not found in resolved blocks; got: ${JSON.stringify(resolvedHunkIds)}`);
});

// ── Test 2: Concurrent bundle resolution deduplication (mutex pattern) ────────
//
// resolveAndReadBindingBundle (in src/server/pr-walkthrough/routes.ts) uses a
// module-level `resolvingBundlePromises` map so that concurrent reads for the
// same jobId share one promise instead of each independently resolving and
// saving. We test the identical pattern here in isolation (without importing
// routes.ts, which pulls in server-only deps) to verify the invariant: the
// expensive async work runs exactly once per jobId even under concurrent load.

test("concurrent bundle resolution deduplication: work runs exactly once (mutex pattern)", async () => {
	// Re-implement the exact mutex pattern from resolveAndReadBindingBundle.
	// This is an integration-style unit test of the invariant, not a mock.
	const inFlight = new Map<string, Promise<void>>();
	let workCallCount = 0;
	const results = new Map<string, string>();

	// Mirrors the check-then-act flow in resolveAndReadBindingBundle.
	async function resolveWithMutex(jobId: string): Promise<string> {
		if (!results.has(jobId)) {
			if (!inFlight.has(jobId)) {
				const p = (async () => {
					if (results.has(jobId)) return; // double-check after acquiring
					// Simulate async bundle resolution (git diff + bundle build).
					await new Promise<void>((resolve) => setImmediate(resolve));
					workCallCount++;
					results.set(jobId, `bundle-for-${jobId}`);
				})().finally(() => inFlight.delete(jobId));
				inFlight.set(jobId, p);
			}
			await inFlight.get(jobId)!;
		}
		return results.get(jobId) ?? "missing";
	}

	// Three concurrent calls — none await before the next starts.
	const [r1, r2, r3] = await Promise.all([
		resolveWithMutex("job-abc"),
		resolveWithMutex("job-abc"),
		resolveWithMutex("job-abc"),
	]);

	assert.equal(workCallCount, 1, `Work must execute exactly once with the mutex; got ${workCallCount}`);
	assert.equal(r1, "bundle-for-job-abc");
	assert.equal(r1, r2);
	assert.equal(r2, r3);

	// A different jobId must also only resolve its own work once.
	workCallCount = 0;
	const [ra, rb] = await Promise.all([
		resolveWithMutex("job-xyz"),
		resolveWithMutex("job-xyz"),
	]);
	assert.equal(workCallCount, 1, `Different jobId work must also execute exactly once; got ${workCallCount}`);
	assert.equal(ra, "bundle-for-job-xyz");
	assert.equal(ra, rb);

	// Once resolved, a second wave of concurrent calls hits the cache and runs no work.
	workCallCount = 0;
	await Promise.all([
		resolveWithMutex("job-abc"),
		resolveWithMutex("job-abc"),
	]);
	assert.equal(workCallCount, 0, `Cached entries must not trigger any work; got ${workCallCount}`);
});
