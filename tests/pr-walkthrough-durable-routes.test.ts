import assert from "node:assert/strict";
import test from "node:test";

import { routes } from "../market-packs/pr-walkthrough/lib/routes.mjs";

class MemoryStore {
	data = new Map<string, unknown>();
	async get(key: string): Promise<unknown | null> { return this.data.get(key) ?? null; }
	async put(key: string, value: unknown): Promise<void> { this.data.set(key, value); }
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

async function saveMinimumChunks(ctx: any) {
	await saveChunk(ctx, "metadata", `title: Durable chunks\noriginal_description:\n  body: test\n  source: gh_api\n  fetched_at: "2026-05-30T00:00:00.000Z"\nstats:\n  files_changed: 1\n  additions: 1\n  deletions: 0`);
	await saveChunk(ctx, "context", "why_created: A\nproblem_solved: B\nwhy_worth_merging: C\nmerge_concerns: D\nauthor_intent: E\nreviewer_map: F");
	await saveChunk(ctx, "merge_assessment", "recommendation: comment\nconfidence: medium\nsummary: S\nblocking_concerns: []\nnon_blocking_concerns: []");
	await saveChunk(ctx, "chunk:readme", "phase: significant\ntitle: README\nreviewer_goal: G\nexplanation: E\nfiles: []\nrelevant_hunks: []\nsuggested_concerns: []\npositive_notes: []");
	await saveChunk(ctx, "audit", "remaining_changed_areas: []\nlow_signal_or_mechanical_changes: []\ngenerated_or_binary_files: []\nreviewer_checklist:\n  - ok");
}

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
