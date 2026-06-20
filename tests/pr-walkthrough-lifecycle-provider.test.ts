import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import provider from "../market-packs/pr-walkthrough/lib/provider.mjs";

class MemoryStore {
	data = new Map<string, unknown>();
	puts: Array<{ key: string; value: unknown; opts?: unknown }> = [];
	async get(key: string): Promise<unknown | null> { return this.data.get(key) ?? null; }
	async put(key: string, value: unknown, opts?: unknown): Promise<void> {
		this.puts.push({ key, value, opts });
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

const sessionId = "reviewer-1";
const jobId = "job-1";
const changesetId = "github:SuuBro/bobbit#42:abcdef0";

function b64url(value: string): string {
	return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function seedStore(): MemoryStore {
	const store = new MemoryStore();
	store.data.set(`reviewers/${sessionId}`, { jobId, changesetId, createdAt: 1 });
	store.data.set(`reviews/${jobId}/binding/${sessionId}`, { jobId, changesetId, parentSessionId: "parent-1" });
	return store;
}

function ctx(store: MemoryStore, extra: Record<string, unknown> = {}) {
	return { sessionId, roleName: "pr-reviewer", host: { store }, ...extra };
}

test("PR walkthrough provider is registered as a schema-2 provider", () => {
	const packRoot = path.resolve("market-packs", "pr-walkthrough");
	const manifest = fs.readFileSync(path.join(packRoot, "pack.yaml"), "utf-8");
	const providerYaml = fs.readFileSync(path.join(packRoot, "providers", "pr-walkthrough-durable.yaml"), "utf-8");
	assert.match(manifest, /^schema: 2$/m);
	assert.match(manifest, /^  providers: \[pr-walkthrough-durable\]$/m);
	assert.match(providerYaml, /^id: pr-walkthrough-durable$/m);
	assert.match(providerYaml, /^module: ..\/lib\/provider\.mjs$/m);
	assert.match(providerYaml, /^hooks: \[beforePrompt, beforeCompact, sessionShutdown\]$/m);
});

test("beforePrompt returns a bounded durable progress block for reviewer sessions", async () => {
	const store = seedStore();
	store.data.set(`reviews/${jobId}/draft/chunks/context`, { id: "context" });
	store.data.set(`reviews/${jobId}/draft/chunks/chunk:api`, { id: "chunk:api" });
	store.data.set(`reviews/${jobId}/draft/status`, { phase: "draft", updatedAt: Date.UTC(2026, 0, 1) });

	const result = await provider.beforePrompt(ctx(store));
	assert.equal(result.blocks.length, 1);
	const [block] = result.blocks;
	assert.equal(block.authority, "tool");
	assert.equal(block.id, "pr-walkthrough:durable-progress");
	assert.match(block.content, /Job: job-1/);
	assert.match(block.content, /Finalized: no/);
	assert.match(block.content, /Saved chunks \(2\): chunk:api, context/);
	assert.match(block.content, /save missing required chunk\(s\): metadata, merge_assessment, audit/);

	const nonReviewer = await provider.beforePrompt({ sessionId: "other", roleName: "coder", host: { store } });
	assert.deepEqual(nonReviewer, { blocks: [] });
});

test("beforeCompact writes a bounded checkpoint with review-draft quota before finalization", async () => {
	const store = seedStore();
	await provider.beforeCompact(ctx(store, { summary: "saved summary" }));

	const checkpoint = store.data.get(`reviews/${jobId}/draft/checkpoint`) as any;
	assert.equal(checkpoint.schemaVersion, 1);
	assert.equal(checkpoint.jobId, jobId);
	assert.equal(checkpoint.sessionId, sessionId);
	assert.equal(checkpoint.source, "summary");
	assert.equal(checkpoint.text, "saved summary");
	assert.deepEqual(store.puts.at(-1)?.opts, { quotaScope: { prefix: `reviews/${jobId}/draft/`, profile: "review-draft" } });

	store.data.set(`reviews/${jobId}/final/payload`, { jobId, changesetId });
	await provider.beforeCompact(ctx(store, { summary: "should not replace finalized checkpoint" }));
	assert.equal((store.data.get(`reviews/${jobId}/draft/checkpoint`) as any).text, "saved summary");
});

test("sessionShutdown deletes review-scoped state, reviewer index, and tied legacy aliases", async () => {
	const store = seedStore();
	store.data.set(`reviews/${jobId}/draft/chunks/context`, { id: "context" });
	store.data.set(`reviews/${jobId}/final/payload`, { jobId, changesetId: "final-change" });
	store.data.set(`reviews/other/final/payload`, { jobId: "other" });
	store.data.set(`binding/${sessionId}`, { jobId, changesetId });
	store.data.set(`submitted/${jobId}`, { yaml: "schema_version: 1" });
	store.data.set(`job/${jobId}`, { changesetId: "job-change" });
	store.data.set(`cards/${b64url(changesetId)}`, { cards: [] });
	store.data.set(`cards/${b64url("final-change")}`, { cards: [] });
	store.data.set(`cards/${b64url("job-change")}`, { cards: [] });
	store.data.set("cards/unrelated", { cards: [] });

	await provider.sessionShutdown(ctx(store));

	assert.equal(store.data.has(`reviewers/${sessionId}`), false);
	assert.equal(store.data.has(`reviews/${jobId}/final/payload`), false);
	assert.equal(store.data.has(`reviews/${jobId}/draft/chunks/context`), false);
	assert.equal(store.data.has(`binding/${sessionId}`), false);
	assert.equal(store.data.has(`submitted/${jobId}`), false);
	assert.equal(store.data.has(`job/${jobId}`), false);
	assert.equal(store.data.has(`cards/${b64url(changesetId)}`), false);
	assert.equal(store.data.has(`cards/${b64url("final-change")}`), false);
	assert.equal(store.data.has(`cards/${b64url("job-change")}`), false);
	assert.equal(store.data.has(`reviews/other/final/payload`), true);
	assert.equal(store.data.has("cards/unrelated"), true);
});
