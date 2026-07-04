import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { routes } from "../market-packs/pr-walkthrough/lib/routes.mjs";
import { ModuleHost } from "../src/server/extension-host/module-host-worker.ts";
import { createPackStore } from "../src/server/extension-host/pack-store.ts";

class MemoryStore {
	data = new Map<string, unknown>();
	puts: Array<{ key: string; value: unknown; opts?: unknown }> = [];
	rejectUnscopedPuts = false;
	async get(key: string): Promise<unknown | null> { return this.data.get(key) ?? null; }
	async put(key: string, value: unknown, opts?: unknown): Promise<void> {
		this.puts.push({ key, value, opts });
		if (this.rejectUnscopedPuts && !opts) throw new Error(`unscoped put rejected for ${key}`);
		this.data.set(key, value);
	}
	async list(prefix = ""): Promise<string[]> { return [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort(); }
	async delete(key: string): Promise<boolean> { return this.data.delete(key); }
	async deletePrefix(prefix: string): Promise<number> {
		let count = 0;
		for (const key of [...this.data.keys()]) {
			if (key.startsWith(prefix)) { this.data.delete(key); count++; }
		}
		return count;
	}
}

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const jobId = "prw-test";
const sessionId = "reviewer-1";
const packRoot = resolve("market-packs/pr-walkthrough");
const routesModule = resolve(packRoot, "lib/routes.mjs");

function reviewBinding(overrides: Record<string, any> = {}) {
	const target = { provider: "github", owner: "SuuBro", repo: "bobbit", number: 42, prUrl: "https://github.com/SuuBro/bobbit/pull/42", ...(overrides.target ?? {}) };
	return {
		jobId,
		changesetId: "github:SuuBro/bobbit#42:bbbbbbb",
		parentSessionId: "owner-1",
		baseSha,
		headSha,
		...overrides,
		target,
	};
}

function seedCtx(overrides: Record<string, any> = {}) {
	const store = new MemoryStore();
	const binding = reviewBinding(overrides);
	store.data.set(`reviewers/${sessionId}`, { jobId: binding.jobId });
	store.data.set(`reviews/${binding.jobId}/binding/${sessionId}`, binding);
	return { ctx: { sessionId, host: { store } }, store };
}

function bundleDiffEvidenceKey(id = jobId): string {
	return `reviews/${id}/draft/analysis-bundle-diff`;
}

function seedBundleDiffEvidence(store: MemoryStore, hunkId: string): void {
	store.data.set(bundleDiffEvidenceKey(), {
		schemaVersion: 1,
		kind: "pr_walkthrough_finalization_diff",
		jobId,
		source: "analysis-bundle",
		generatedAt: "2026-06-01T00:00:00.000Z",
		parsedDiff: {
			changeset: {
				baseSha,
				headSha,
				provider: "github",
				prUrl: "https://github.com/SuuBro/bobbit/pull/42",
				prNumber: 42,
				prTitle: "Bundle fallback",
				filesChanged: 1,
				additions: 1,
				deletions: 1,
			},
			files: [{
				filePath: "src/bundle-fallback.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
				diffBlocks: [{
					id: "bundle-src-bundle-fallback",
					filePath: "src/bundle-fallback.ts",
					status: "modified",
					hunks: [{
						id: hunkId,
						header: "@@ -1,1 +1,1 @@",
						lines: [
							{ id: `${hunkId}:l1`, side: "old", oldLine: 1, kind: "del", text: "old value" },
							{ id: `${hunkId}:l2`, side: "new", newLine: 1, kind: "add", text: "new value" },
						],
					}],
				}],
			}],
			warnings: [],
		},
	});
}

async function seedQuotaCtx(rootDir: string) {
	const packId = "pr-walkthrough-quota-regression";
	const packStore = createPackStore({
		rootDir,
		quota: {
			maxValueBytes: 128 * 1024,
			maxKeys: 100,
			maxTotalBytes: 512,
			maxTotalBytesEmergency: 256 * 1024,
			profiles: {
				default: { maxTotalBytes: 64 * 1024 },
				"review-draft": { maxTotalBytes: 64 * 1024 },
				"review-final": { maxTotalBytes: 128 * 1024 },
			},
		},
	});
	const puts: Array<{ key: string; value: unknown; opts?: unknown }> = [];
	const errors: Array<{ key: string; err: unknown }> = [];
	const store = {
		puts,
		errors,
		async get(key: string): Promise<unknown | null> { return packStore.get(packId, key); },
		async put(key: string, value: unknown, opts?: unknown): Promise<void> {
			puts.push({ key, value, opts });
			try {
				await packStore.put(packId, key, value, opts as any);
			} catch (err) {
				errors.push({ key, err });
				throw err;
			}
		},
		async list(prefix = ""): Promise<string[]> { return packStore.list(packId, prefix); },
		async delete(key: string): Promise<boolean> { return packStore.delete(packId, key); },
		async deletePrefix(prefix: string): Promise<number> { return packStore.deletePrefix(packId, prefix); },
	};
	await store.put(`reviewers/${sessionId}`, { jobId }, { quotaScope: { prefix: `reviewers/${sessionId}`, profile: "default" } });
	await store.put(`reviews/${jobId}/binding/${sessionId}`, reviewBinding(), { quotaScope: { prefix: `reviews/${jobId}/`, profile: "default" } });
	return { ctx: { sessionId, host: { store } }, store, packStore, packId };
}

test("PR walkthrough status stops polling archived reviewer self sessions", async () => {
	const { ctx } = seedCtx();
	const running = await routes.status(ctx, { body: { childSessionId: sessionId, jobId } });
	assert.equal(running.phase, "running", JSON.stringify(running));

	const archived = await routes.status({ ...ctx, sessionArchived: true }, { body: { childSessionId: sessionId, jobId } });
	assert.equal(archived.phase, "error", JSON.stringify(archived));
	assert.equal(archived.code, "PRW_REVIEWER_ARCHIVED");
});

async function saveChunk(ctx: any, section_id: string, yaml: string) {
	const result = await routes.publish(ctx, { body: { op: "submitChunk", section_id, yaml } });
	assert.equal(result.ok, true, JSON.stringify(result));
	return result;
}

async function saveRequiredChunks(ctx: any) {
	await saveChunk(ctx, "metadata", `title: Durable chunks\noriginal_description:\n  body: test\n  source: gh_api\n  fetched_at: "2026-05-30T00:00:00.000Z"\nstats:\n  files_changed: 1\n  additions: 1\n  deletions: 0`);
	await saveChunk(ctx, "context", "why_created: A\nproblem_solved: B\nwhy_worth_merging: C\nmerge_concerns: D\nauthor_intent: E\nreviewer_map: F");
	await saveChunk(ctx, "merge_assessment", "recommendation: comment\nconfidence: medium\nsummary: S\nblocking_concerns: []\nnon_blocking_concerns: []");
	await saveChunk(ctx, "audit", "remaining_changed_areas: []\nlow_signal_or_mechanical_changes: []\ngenerated_or_binary_files: []\nreviewer_checklist:\n  - ok");
}

async function saveMinimumChunks(ctx: any) {
	await saveRequiredChunks(ctx);
	await saveChunk(ctx, "chunk:readme", "phase: significant\ntitle: README\nreviewer_goal: G\nexplanation: E\nfiles: []\nrelevant_hunks: []\nsuggested_concerns: []\npositive_notes: []");
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeRepoFile(root: string, relativePath: string, content: string): void {
	fs.mkdirSync(join(root, dirname(relativePath)), { recursive: true });
	fs.writeFileSync(join(root, relativePath), content);
}

function routeSlug(value: string): string {
	return String(value).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "file";
}

function routeHunks(cwd: string, base: string, head: string): Array<{ file: string; hunkId: string; hunkIndex: number; header: string }> {
	const diff = git(cwd, ["diff", "--no-ext-diff", "--no-color", "--unified=80", base, head]);
	const hunks: Array<{ file: string; hunkId: string; hunkIndex: number; header: string }> = [];
	let blockIndex = 0;
	let hunkIndex = 0;
	let file = "";
	for (const line of diff.split(/\r?\n/)) {
		const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
		if (fileMatch) {
			blockIndex += 1;
			file = fileMatch[2];
			hunkIndex = 0;
			continue;
		}
		if (line.startsWith("@@ ")) {
			hunkIndex += 1;
			hunks.push({ file, hunkId: `block-${blockIndex}-${routeSlug(file)}-h${hunkIndex}`, hunkIndex: hunkIndex - 1, header: line });
		}
	}
	return hunks;
}

function seedGitRepo(t: any, afterFiles: Record<string, string>, beforeFiles: Record<string, string> = {}): { cwd: string; baseSha: string; headSha: string; hunks: Array<{ file: string; hunkId: string; hunkIndex: number; header: string }> } {
	const cwd = fs.mkdtempSync(join(os.tmpdir(), "prw-route-git-"));
	t.after(() => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } });
	git(cwd, ["init"]);
	git(cwd, ["config", "user.name", "Test User"]);
	git(cwd, ["config", "user.email", "test@example.invalid"]);
	git(cwd, ["config", "core.autocrlf", "false"]);
	for (const [file, content] of Object.entries(beforeFiles)) writeRepoFile(cwd, file, content);
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "base"]);
	const base = git(cwd, ["rev-parse", "HEAD"]);
	for (const [file, content] of Object.entries(afterFiles)) writeRepoFile(cwd, file, content);
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "head"]);
	const head = git(cwd, ["rev-parse", "HEAD"]);
	return { cwd, baseSha: base, headSha: head, hunks: routeHunks(cwd, base, head) };
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.cwd();
	process.chdir(cwd);
	try { return await fn(); }
	finally { process.chdir(previous); }
}

function numberedLines(prefix: string, count: number, suffix = ""): string {
	return Array.from({ length: count }, (_, index) => `${prefix}${index}${suffix}`).join("\n") + "\n";
}

test("PR walkthrough routes load under pack-root module confinement", async () => {
	const moduleHost = new ModuleHost({ timeoutMs: 10_000 });
	try {
		const store = new MemoryStore();
		const result = await moduleHost.invoke({
			url: pathToFileURL(routesModule).href,
			packRoot,
			epoch: 0,
			exportKind: "routes",
			member: "publish",
			ctx: {
				sessionId,
				toolUseId: "tu-prw",
				tool: "pr-walkthrough/publish",
				workingDir: process.cwd(),
				host: { capabilities: { store: true }, store },
			},
			arg: { body: { op: "submissionStatus", jobId } },
			workingDir: process.cwd(),
		});
		assert.equal((result as any).ok, false, JSON.stringify(result));
		assert.equal((result as any).code, "PRW_MISSING_BINDING");
	} finally {
		moduleHost.dispose();
	}
});

test("PR walkthrough run uses scoped review writes and skips legacy binding writes", async () => {
	const store = new MemoryStore();
	store.rejectUnscopedPuts = true;
	const prompted: string[] = [];
	const ctx = {
		sessionId: "owner-1",
		host: {
			store,
			agents: {
				async spawn() { return { childSessionId: "child-1" }; },
				async prompt(childSessionId: string) { prompted.push(childSessionId); },
				async dismiss() { throw new Error("should not dismiss"); },
			},
		},
	};
	const result = await routes.run(ctx, { body: { prUrl: "https://github.com/SuuBro/bobbit/pull/42", baseSha, headSha } });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(prompted[0], "child-1");
	assert.equal(await store.get("binding/child-1"), null);
	const keys = store.puts.map((put) => put.key);
	assert.ok(keys.includes("reviewers/child-1"));
	assert.ok(keys.includes(`reviews/${result.jobId}/binding/child-1`));
	assert.ok(!keys.includes("binding/child-1"));
	for (const put of store.puts) assert.ok(put.opts, `${put.key} should be quota scoped`);
});

test("PR walkthrough chunks are idempotent and finalized into review-scoped payload", async () => {
	const { ctx, store } = seedCtx();
	await saveChunk(ctx, "context", "why_created: first\nproblem_solved: B\nwhy_worth_merging: C\nmerge_concerns: D\nauthor_intent: E\nreviewer_map: F");
	await saveChunk(ctx, "context", "why_created: second\nproblem_solved: B\nwhy_worth_merging: C\nmerge_concerns: D\nauthor_intent: E\nreviewer_map: F");
	let status = await routes.publish(ctx, { body: { op: "submissionStatus" } });
	assert.equal(status.chunkSummary.chunks.filter((chunk: any) => chunk.id === "context").length, 1);

	await saveMinimumChunks(ctx);
	const finalized = await routes.publish(ctx, { body: { op: "finalizeSubmission" } });
	assert.equal(finalized.ok, true, JSON.stringify(finalized));
	assert.equal(finalized.cardCount, 3);
	assert.equal(finalized.coverage.totalHunks, 0);
	assert.equal(await store.get(`reviews/${jobId}/draft/chunks/context`), null);
	const finalPayload: any = await store.get(`reviews/${jobId}/final/payload`);
	assert.equal(finalPayload.jobId, jobId);
	assert.equal(finalPayload.coverage.totalHunks, 0);
	assert.match(finalPayload.yaml, /why_created: A/);

	const bundle = await routes.bundle(ctx, { query: { jobId } });
	assert.equal(bundle.cardsSource, "stored-final");
	assert.equal(bundle.cardCount, 3);
	assert.equal(bundle.cards.length, 3);
});

test("PR walkthrough durable finalization resolves hunk ids from stored bundle evidence when local SHAs are unavailable", async () => {
	const hunkId = "bundle-hunk-src-fallback-h0";
	const { ctx, store } = seedCtx();
	seedBundleDiffEvidence(store, hunkId);
	await saveRequiredChunks(ctx);
	await saveChunk(ctx, "chunk:bundle-fallback", `phase: significant
title: Bundle fallback
reviewer_goal: Review bundle fallback
explanation: Uses persisted bundle evidence when local git cannot resolve the PR SHAs.
files:
  - src/bundle-fallback.ts
relevant_hunks:
  - hunk_id: ${hunkId}
    placement: primary
    why_relevant: The finalizer must map this hunk from the stored analysis bundle.
suggested_concerns: []
positive_notes: []`);

	const status = await routes.publish(ctx, { body: { op: "submissionStatus" } });
	assert.equal(status.draftCoverage.totalHunks, 1);
	assert.equal(status.draftCoverage.unread, 1);

	const finalized = await routes.publish(ctx, { body: { op: "finalizeSubmission" } });
	assert.equal(finalized.ok, true, JSON.stringify(finalized));
	assert.equal(finalized.coverage.totalHunks, 1);
	assert.equal(finalized.coverage.unread, 1);
	const finalPayload: any = await store.get(`reviews/${jobId}/final/payload`);
	const card = finalPayload.cards.find((item: any) => item.title === "Bundle fallback");
	assert.ok(card, JSON.stringify(finalPayload.cards.map((item: any) => item.title)));
	assert.deepEqual(card.diffBlocks.flatMap((block: any) => block.hunks.map((hunk: any) => hunk.id)), [hunkId]);
	assert.equal(finalPayload.changeset.prUrl, "https://github.com/SuuBro/bobbit/pull/42");
});

test("PR walkthrough durable finalization rejects duplicate primary hunk ownership without writing final payload", async (t) => {
	const before = { "src/app.ts": numberedLines("old-value-", 12) };
	const after = { "src/app.ts": numberedLines("new-value-", 12) };
	const repo = seedGitRepo(t, after, before);
	const hunk = repo.hunks.find((item) => item.file === "src/app.ts");
	assert.ok(hunk, JSON.stringify(repo.hunks));
	const { ctx, store } = seedCtx({ baseSha: repo.baseSha, headSha: repo.headSha });
	await saveRequiredChunks(ctx);
	await saveChunk(ctx, "chunk:first", `phase: significant
title: First owner
reviewer_goal: Review first owner
explanation: First explanation
files:
  - src/app.ts
relevant_hunks:
  - hunk_id: ${hunk.hunkId}
    placement: primary
    why_relevant: First card claims this hunk.
suggested_concerns: []
positive_notes: []`);
	await saveChunk(ctx, "chunk:second", `phase: significant
title: Second owner
reviewer_goal: Review second owner
explanation: Second explanation
files:
  - src/app.ts
relevant_hunks:
  - hunk_id: ${hunk.hunkId}
    placement: primary
    why_relevant: Second card also claims this hunk.
suggested_concerns: []
positive_notes: []`);

	const finalized = await withCwd(repo.cwd, () => routes.publish(ctx, { body: { op: "finalizeSubmission" } }));
	assert.equal(finalized.ok, false);
	assert.equal(finalized.code, "PRW_DUPLICATE_PRIMARY_HUNK");
	assert.equal(finalized.retryable, true);
	assert.equal(finalized.details.conflicts[0].hunkId, hunk.hunkId);
	assert.equal(await store.get(`reviews/${jobId}/final/payload`), null);
});

test("PR walkthrough status and final payload include read-receipt coverage summaries", async (t) => {
	const before = {
		"src/app.ts": numberedLines("old-app-", 10),
		"src/skipped.ts": numberedLines("old-skip-", 10),
	};
	const after = {
		"src/app.ts": numberedLines("new-app-", 10),
		"src/skipped.ts": numberedLines("new-skip-", 10),
	};
	const repo = seedGitRepo(t, after, before);
	const appHunk = repo.hunks.find((item) => item.file === "src/app.ts");
	const skippedHunk = repo.hunks.find((item) => item.file === "src/skipped.ts");
	assert.ok(appHunk && skippedHunk, JSON.stringify(repo.hunks));
	const { ctx, store } = seedCtx({ baseSha: repo.baseSha, headSha: repo.headSha });
	await saveRequiredChunks(ctx);
	await saveChunk(ctx, "chunk:primary", `phase: significant
title: App flow
reviewer_goal: Review app flow
explanation: App flow explanation
files:
  - src/app.ts
relevant_hunks:
  - hunk_id: ${appHunk.hunkId}
    placement: primary
    why_relevant: App flow changed here.
suggested_concerns: []
positive_notes: []`);
	await saveChunk(ctx, "chunk:repeat", `phase: other
title: Repeated app note
reviewer_goal: Cross-reference app flow
explanation: Repeat explanation
files:
  - src/app.ts
relevant_hunks:
  - hunk_id: ${appHunk.hunkId}
    placement: secondary
    primary_card_id: significant-primary
    why_relevant: Refer back to the app flow change.
suggested_concerns: []
positive_notes: []`);
	await saveChunk(ctx, "chunk:skip", `phase: other
title: Mechanical skip
reviewer_goal: Confirm mechanical skip
explanation: Skip explanation
files:
  - src/skipped.ts
relevant_hunks:
  - hunk_id: ${skippedHunk.hunkId}
    placement: skip
    skip_reason: mechanical
    why_relevant: Mechanical rename churn.
suggested_concerns: []
positive_notes: []`);
	store.data.set(`reviews/${jobId}/draft/read-receipts/rr-app`, {
		schemaVersion: 1,
		id: "rr-app",
		jobId,
		sessionId,
		readAt: 123,
		format: "compact",
		mode: "file",
		path: "src/app.ts",
		hunkIds: [appHunk.hunkId],
		truncated: false,
	});

	const draftStatus = await withCwd(repo.cwd, () => routes.publish(ctx, { body: { op: "submissionStatus" } }));
	assert.equal(draftStatus.readReceipts.total, 1);
	assert.deepEqual(draftStatus.readReceipts.bodyReadHunkIds, [appHunk.hunkId]);
	assert.equal(draftStatus.draftCoverage.primaryReviewed, 1);
	assert.equal(draftStatus.draftCoverage.skipped, 1);
	assert.equal(draftStatus.draftCoverage.repeatedSecondaryReferences, 1);
	assert.equal(draftStatus.draftCoverage.repeated_refs[0].hunkId, appHunk.hunkId);
	assert.equal(draftStatus.draftCoverage.skipped_hunks[0].hunkId, skippedHunk.hunkId);

	const finalized = await withCwd(repo.cwd, () => routes.publish(ctx, { body: { op: "finalizeSubmission" } }));
	assert.equal(finalized.ok, true, JSON.stringify(finalized));
	assert.equal(finalized.coverage.primaryReviewed, 1);
	assert.equal(finalized.coverage.skipped, 1);
	assert.equal(finalized.coverage.repeatedSecondaryReferences, 1);
	const finalPayload: any = await store.get(`reviews/${jobId}/final/payload`);
	assert.equal(finalPayload.coverage.primaryReviewed, 1);
	assert.equal(finalPayload.coverage.records.find((record: any) => record.hunkId === appHunk.hunkId).readReceiptIds[0], "rr-app");

	const finalStatus = await routes.publish(ctx, { body: { op: "submissionStatus" } });
	assert.equal(finalStatus.finalized, true);
	assert.equal(finalStatus.finalCoverage.primaryReviewed, 1);
	assert.equal(finalStatus.finalCoverage.skipped_hunks[0].hunkId, skippedHunk.hunkId);
	assert.equal(finalStatus.readReceipts.total, 0);
});

test("PR walkthrough durable finalization preserves more than twelve logical cards", async () => {
	const { ctx, store } = seedCtx();
	await saveRequiredChunks(ctx);
	for (let index = 1; index <= 13; index += 1) {
		await saveChunk(ctx, `chunk:item-${index}`, `phase: significant
title: Logical card ${index}
reviewer_goal: Review logical card ${index}
explanation: Explanation ${index}
files: []
relevant_hunks: []
suggested_concerns: []
positive_notes: []`);
	}
	const finalized = await routes.publish(ctx, { body: { op: "finalizeSubmission" } });
	assert.equal(finalized.ok, true, JSON.stringify(finalized));
	assert.equal(finalized.cardCount, 15);
	const finalPayload: any = await store.get(`reviews/${jobId}/final/payload`);
	assert.equal(finalPayload.cards.filter((card: any) => /^Logical card /.test(card.title)).length, 13);
});

test("PR walkthrough durable finalization blocks major completion-sweep hunks without writing final payload", async (t) => {
	const before = { "src/app.ts": numberedLines("old-major-", 12) };
	const after = { "src/app.ts": numberedLines("new-major-", 12) };
	const repo = seedGitRepo(t, after, before);
	const { ctx, store } = seedCtx({ baseSha: repo.baseSha, headSha: repo.headSha });
	await saveRequiredChunks(ctx);

	const status = await withCwd(repo.cwd, () => routes.publish(ctx, { body: { op: "submissionStatus" } }));
	assert.equal(status.draftSynthesisError.code, "PRW_MAJOR_REMAINING_HUNKS");
	assert.equal(status.major_remaining[0].filePath, "src/app.ts");

	const finalized = await withCwd(repo.cwd, () => routes.publish(ctx, { body: { op: "finalizeSubmission" } }));
	assert.equal(finalized.ok, false);
	assert.equal(finalized.code, "PRW_MAJOR_REMAINING_HUNKS");
	assert.equal(finalized.retryable, true);
	assert.equal(finalized.details.major_remaining[0].filePath, "src/app.ts");
	assert.equal(await store.get(`reviews/${jobId}/final/payload`), null);
});

test("PR walkthrough review chunk files stay metadata-only at durable finalization", async (t) => {
	const before = { "docs/guide.md": "old line one\nold line two\n" };
	const after = { "docs/guide.md": "new line one\nnew line two\n" };
	const repo = seedGitRepo(t, after, before);
	const { ctx, store } = seedCtx({ baseSha: repo.baseSha, headSha: repo.headSha });
	await saveRequiredChunks(ctx);
	await saveChunk(ctx, "chunk:docs", `phase: significant
title: Docs metadata
reviewer_goal: Review docs metadata
explanation: Docs explanation
files:
  - docs/guide.md
relevant_hunks: []
suggested_concerns: []
positive_notes: []`);

	const finalized = await withCwd(repo.cwd, () => routes.publish(ctx, { body: { op: "finalizeSubmission" } }));
	assert.equal(finalized.ok, true, JSON.stringify(finalized));
	assert.equal(finalized.coverage.completionSweepRemaining, 1);
	const finalPayload: any = await store.get(`reviews/${jobId}/final/payload`);
	const docsCard = finalPayload.cards.find((card: any) => card.id === "significant-docs");
	assert.ok(docsCard, JSON.stringify(finalPayload.cards.map((card: any) => card.id)));
	assert.deepEqual(docsCard.diffBlocks, []);
});

test("PR walkthrough quota regression: finalize persists binding metadata after scoped review payloads exceed legacy quota", async (t) => {
	const quotaRoot = fs.mkdtempSync(join(os.tmpdir(), "prw-route-quota-"));
	t.after(() => { try { fs.rmSync(quotaRoot, { recursive: true, force: true }); } catch { /* best effort */ } });
	const { ctx, store, packStore, packId } = await seedQuotaCtx(quotaRoot);
	await saveMinimumChunks(ctx);
	const finalized = await routes.publish(ctx, { body: { op: "finalizeSubmission" } });
	assert.equal(finalized.ok, true, JSON.stringify(finalized));
	const stats = await packStore.stats(packId);
	assert.ok(stats.bytes > 512, `scoped review payloads should exceed the legacy cap; got ${stats.bytes}`);

	const errorText = store.errors.map(({ key, err }) => `${key}: ${String((err as { code?: unknown })?.code ?? "")} ${String((err as Error)?.message ?? err)}`).join("\n");
	assert.equal(store.errors.length, 0, `unexpected store quota errors after scoped review payloads exceeded legacy cap:\n${errorText}`);
	assert.ok(await store.get(`binding/${sessionId}`), "legacy binding metadata marker should persist after finalization");
	const bindingPut = [...store.puts].reverse().find((put) => put.key === `binding/${sessionId}`);
	assert.deepEqual(bindingPut?.opts, { quotaScope: { prefix: `binding/${sessionId}`, profile: "default" } }, `binding/${sessionId} should be quota scoped`);
});

test("PR walkthrough metadata chunk trusted fields are merged without duplicate pr keys", async () => {
	const { ctx, store } = seedCtx();
	await saveChunk(ctx, "metadata", `provider: gitlab
owner: attacker
repo: wrong
number: 999
url: https://example.invalid/wrong
base_sha: ${"c".repeat(40)}
head_sha: ${"d".repeat(40)}
title: Reviewer title
original_description:
  body: preserved body
  source: gh_api
  fetched_at: "2026-05-30T00:00:00.000Z"
stats:
  files_changed: 3
  additions: 10
  deletions: 2`);
	await saveChunk(ctx, "context", "why_created: A\nproblem_solved: B\nwhy_worth_merging: C\nmerge_concerns: D\nauthor_intent: E\nreviewer_map: F");
	await saveChunk(ctx, "merge_assessment", "recommendation: comment\nconfidence: medium\nsummary: S\nblocking_concerns: []\nnon_blocking_concerns: []");
	await saveChunk(ctx, "audit", "remaining_changed_areas: []\nlow_signal_or_mechanical_changes: []\ngenerated_or_binary_files: []\nreviewer_checklist:\n  - ok");
	await saveChunk(ctx, "chunk:readme", "phase: significant\ntitle: README\nreviewer_goal: G\nexplanation: E\nfiles: []\nrelevant_hunks: []\nsuggested_concerns: []\npositive_notes: []");

	const finalized = await routes.publish(ctx, { body: { op: "finalizeSubmission" } });
	assert.equal(finalized.ok, true, JSON.stringify(finalized));
	const finalPayload: any = await store.get(`reviews/${jobId}/final/payload`);
	const yaml = finalPayload.yaml;
	for (const key of ["provider", "owner", "repo", "number", "url", "base_sha", "head_sha"]) {
		assert.equal((yaml.match(new RegExp(`^  ${key}:`, "gm")) || []).length, 1, `${key} should be emitted once`);
	}
	assert.match(yaml, /^  provider: "github"$/m);
	assert.match(yaml, /^  owner: "SuuBro"$/m);
	assert.match(yaml, /^  repo: "bobbit"$/m);
	assert.match(yaml, /^  number: 42$/m);
	assert.match(yaml, /^  url: "https:\/\/github\.com\/SuuBro\/bobbit\/pull\/42"$/m);
	assert.match(yaml, new RegExp(`^  base_sha: "${baseSha}"$`, "m"));
	assert.match(yaml, new RegExp(`^  head_sha: "${headSha}"$`, "m"));
	assert.match(yaml, /^  title: "Reviewer title"$/m);
	assert.match(yaml, /^    files_changed: 3$/m);
	assert.match(yaml, /^    body: "preserved body"$/m);
});

test("bundle denies unauthorized reads of review-scoped final payloads", async () => {
	const { ctx, store } = seedCtx();
	await saveMinimumChunks(ctx);
	const finalized = await routes.publish(ctx, { body: { op: "finalizeSubmission" } });
	assert.equal(finalized.ok, true, JSON.stringify(finalized));

	const denied = await routes.bundle({ sessionId: "attacker", host: { store } }, { query: { jobId } });
	assert.equal(denied.found, false);
	assert.equal(denied.code, "PRW_REVIEW_UNAUTHORIZED");
	assert.equal(denied.cardsSource, undefined);
});

test("compat publish without binding cannot overwrite a review-scoped final payload", async () => {
	const { ctx, store } = seedCtx();
	await saveMinimumChunks(ctx);
	const finalized = await routes.publish(ctx, { body: { op: "finalizeSubmission" } });
	assert.equal(finalized.ok, true, JSON.stringify(finalized));
	const originalFinal: any = await store.get(`reviews/${jobId}/final/payload`);
	const attackerYaml = originalFinal.yaml.replace("Durable chunks", "Attacker overwrite");

	const result = await routes.publish({ sessionId: "attacker", host: { store } }, { body: { jobId, yaml: attackerYaml, baseSha, headSha } });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.legacy, true);
	const protectedFinal: any = await store.get(`reviews/${jobId}/final/payload`);
	assert.equal(protectedFinal.yaml, originalFinal.yaml);
	assert.doesNotMatch(protectedFinal.yaml, /Attacker overwrite/);
});

test("submit_pr_walkthrough_yaml rejects before writing document over incremental chunks", async () => {
	const { ctx, store } = seedCtx();
	await saveChunk(ctx, "metadata", "title: Partial\nstats:\n  files_changed: 1\n  additions: 1\n  deletions: 0\noriginal_description:\n  body: test\n  source: gh_api\n  fetched_at: \"2026-05-30T00:00:00.000Z\"");
	const result = await routes.publish(ctx, { body: { op: "submitYaml", yaml: "not: used" } });
	assert.equal(result.ok, false);
	assert.equal(result.code, "PRW_CHUNK_CONFLICT");
	assert.equal(await store.get(`reviews/${jobId}/draft/chunks/document`), null);

	await saveChunk(ctx, "context", "why_created: A\nproblem_solved: B\nwhy_worth_merging: C\nmerge_concerns: D\nauthor_intent: E\nreviewer_map: F");
	await saveChunk(ctx, "merge_assessment", "recommendation: comment\nconfidence: medium\nsummary: S\nblocking_concerns: []\nnon_blocking_concerns: []");
	await saveChunk(ctx, "chunk:readme", "phase: significant\ntitle: README\nreviewer_goal: G\nexplanation: E\nfiles: []\nrelevant_hunks: []\nsuggested_concerns: []\npositive_notes: []");
	await saveChunk(ctx, "audit", "remaining_changed_areas: []\nlow_signal_or_mechanical_changes: []\ngenerated_or_binary_files: []\nreviewer_checklist:\n  - ok");
	const finalized = await routes.publish(ctx, { body: { op: "finalizeSubmission" } });
	assert.equal(finalized.ok, true, JSON.stringify(finalized));
});

test("audit reviewer_checklist nested array satisfies chunk-or-audit minimum", async () => {
	const { ctx, store } = seedCtx();
	await saveRequiredChunks(ctx);
	const status = await routes.publish(ctx, { body: { op: "submissionStatus" } });
	assert.ok(!status.chunkSummary.missing.includes("chunk:<id> or audit.reviewer_checklist"), JSON.stringify(status.chunkSummary));
	const finalized = await routes.publish(ctx, { body: { op: "finalizeSubmission" } });
	assert.equal(finalized.ok, true, JSON.stringify(finalized));
	const finalPayload: any = await store.get(`reviews/${jobId}/final/payload`);
	assert.match(finalPayload.yaml, /reviewer_checklist:\n\s+- ok/);
	const auditCard = finalPayload.cards.find((card: any) => card.id.startsWith("audit-checklist"));
	assert.deepEqual(auditCard.checklist, ["ok"]);
});
