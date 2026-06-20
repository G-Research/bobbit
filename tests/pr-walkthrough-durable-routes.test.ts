import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { routes } from "../market-packs/pr-walkthrough/lib/routes.mjs";
import { ModuleHost } from "../src/server/extension-host/module-host-worker.ts";

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

function seedCtx() {
	const store = new MemoryStore();
	const binding = {
		jobId,
		changesetId: "github:SuuBro/bobbit#42:bbbbbbb",
		parentSessionId: "owner-1",
		baseSha,
		headSha,
		target: { provider: "github", owner: "SuuBro", repo: "bobbit", number: 42, prUrl: "https://github.com/SuuBro/bobbit/pull/42" },
	};
	store.data.set(`reviewers/${sessionId}`, { jobId });
	store.data.set(`reviews/${jobId}/binding/${sessionId}`, binding);
	return { ctx: { sessionId, host: { store } }, store };
}

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
