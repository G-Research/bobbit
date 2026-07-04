import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
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

function reviewBinding() {
	return {
		jobId,
		changesetId: "github:SuuBro/bobbit#42:bbbbbbb",
		parentSessionId: "owner-1",
		baseSha,
		headSha,
		target: { provider: "github", owner: "SuuBro", repo: "bobbit", number: 42, prUrl: "https://github.com/SuuBro/bobbit/pull/42" },
	};
}

function seedCtx() {
	const store = new MemoryStore();
	const binding = reviewBinding();
	store.data.set(`reviewers/${sessionId}`, { jobId });
	store.data.set(`reviews/${jobId}/binding/${sessionId}`, binding);
	return { ctx: { sessionId, host: { store } }, store };
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
	assert.equal(await store.get(`reviews/${jobId}/draft/chunks/context`), null);
	const finalPayload: any = await store.get(`reviews/${jobId}/final/payload`);
	assert.equal(finalPayload.jobId, jobId);
	assert.match(finalPayload.yaml, /why_created: A/);

	const bundle = await routes.bundle(ctx, { query: { jobId } });
	assert.equal(bundle.cardsSource, "stored-final");
	assert.equal(bundle.cardCount, undefined);
	assert.equal(bundle.cards.length, 3);
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
