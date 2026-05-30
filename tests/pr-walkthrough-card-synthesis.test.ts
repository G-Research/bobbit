import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { synthesiseWalkthroughCards, validateSynthesisedCards } from "../src/server/pr-walkthrough/card-synthesis.ts";
import { normalizeGithubResolvedWalkthrough, setPrWalkthroughSynthesisAdapterForTesting } from "../src/server/pr-walkthrough/routes.ts";
import { WALKTHROUGH_STORE_SCHEMA_VERSION, WalkthroughStore } from "../src/server/pr-walkthrough/walkthrough-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("PR walkthrough card synthesis", () => {
	it("builds deterministic fallback phases and groups multiple diff blocks by path", async () => {
		const cards = await synthesiseWalkthroughCards(changeset(), [
			file("src/server/routes.ts", "modified", [block("server-a", "src/server/routes.ts", 8), block("server-b", "src/server/routes.ts", 5)]),
			file("src/ui/panel.ts", "modified", [block("ui-a", "src/ui/panel.ts", 6)]),
			file("docs/pr.md", "modified", [block("docs-a", "docs/pr.md", 2)]),
		]);

		assert.deepEqual(cards.map(card => card.phaseId), ["orientation", "design", "significant", "other", "audit"]);
		const design = cards.find(card => card.phaseId === "design");
		assert.ok(design);
		assert.deepEqual(design.diffBlocks.map(block => block.id), ["server-a", "server-b"]);
		assert.equal(new Set(cards.flatMap(card => card.phaseId === "orientation" || card.phaseId === "audit" ? [] : card.diffBlocks.map(block => block.id))).size, 4);
	});

	it("puts generated, renamed, deleted, and binary blocks into other review cards", async () => {
		const cards = await synthesiseWalkthroughCards(changeset(), [
			file("src/core.ts", "modified", [block("core", "src/core.ts", 10)]),
			file("dist/bundle.js", "modified", [block("generated", "dist/bundle.js", 20)], { isGenerated: true }),
			file("assets/logo.png", "binary", [block("binary", "assets/logo.png", 1)], { isBinary: true }),
			file("src/old.ts", "deleted", [block("deleted", "src/old.ts", 3)]),
			file("src/new-name.ts", "renamed", [block("renamed", "src/new-name.ts", 3)]),
		]);

		const other = cards.find(card => card.phaseId === "other");
		assert.ok(other);
		assert.deepEqual(other.diffBlocks.map(block => block.id), ["generated", "binary", "deleted", "renamed"]);
	});

	it("falls back when LLM synthesis is unavailable or invalid", async () => {
		const cards = await synthesiseWalkthroughCards(changeset(), [file("src/a.ts", "modified", [block("a", "src/a.ts", 2)])], {
			allowLlm: true,
			llm: () => ({ cards: [{ phaseId: "not-a-phase", title: "Bad", summary: "Bad", diffBlockIds: ["a"] }] }),
		});

		assert.equal(cards[0].phaseId, "orientation");
		assert.ok(cards.some(card => card.diffBlocks.some(diffBlock => diffBlock.id === "a")));
	});

	it("validates LLM card schema and drops suggested comments with bad anchors", () => {
		const files = [file("src/a.ts", "modified", [block("a", "src/a.ts", 2)])];
		const cards = validateSynthesisedCards({
			cards: [
				{
					phaseId: "significant",
					title: "Check resolver",
					summary: "Resolver behavior changed.",
					diffBlockIds: ["a", "missing"],
					suggestedComments: [
						{ diffBlockId: "a", lineId: "a-l1", body: "Valid anchor" },
						{ diffBlockId: "a", lineId: "missing-line", body: "Invalid line" },
						{ diffBlockId: "missing", lineId: "a-l1", body: "Invalid block" },
					],
				},
				{ phaseId: "audit", title: "No blocks", summary: "Rejected", diffBlockIds: ["missing"] },
			],
		}, files);

		assert.equal(cards.length, 1);
		assert.equal(cards[0].phaseId, "significant");
		assert.deepEqual(cards[0].diffBlocks.map(diffBlock => diffBlock.id), ["a"]);
		assert.equal(cards[0].suggestedComments?.length, 1);
		assert.equal(cards[0].suggestedComments?.[0]?.body, "Valid anchor");
	});

	it("normalizes adapter-style GitHub files into real diff blocks for resolver synthesis", async () => {
		const result = await normalizeGithubResolvedWalkthrough({
			changesetId: "github:SuuBro/bobbit#42:abcdef1",
			changeset: { ...changeset(), provider: "github", prUrl: "https://github.com/SuuBro/bobbit/pull/42", prNumber: 42 },
			files: [file("src/a.ts", "modified", [block("adapter-block", "src/a.ts", 2)])],
			warnings: [],
			export: { provider: "github", available: false },
		});

		assert.ok(result);
		const diffBlocks = result.cards.flatMap(card => card.diffBlocks);
		assert.ok(diffBlocks.some(diffBlock => diffBlock.id === "adapter-block" && Array.isArray(diffBlock.hunks)));
		assert.equal(diffBlocks.some(diffBlock => (diffBlock as any).diffBlocks), false);
	});

	it("resolver synthesis invokes configured LLM adapter and falls back when it returns invalid output", async () => {
		let calls = 0;
		setPrWalkthroughSynthesisAdapterForTesting(() => {
			calls += 1;
			return { cards: [{ phaseId: "significant", title: "LLM card", summary: "Validated output", diffBlockIds: ["llm-block"] }] };
		});
		try {
			const result = await normalizeGithubResolvedWalkthrough({
				changesetId: "github:SuuBro/bobbit#42:abcdef1",
				changeset: { ...changeset(), provider: "github", prUrl: "https://github.com/SuuBro/bobbit/pull/42", prNumber: 42 },
				files: [file("src/llm.ts", "modified", [block("llm-block", "src/llm.ts", 2)])],
				warnings: [],
				export: { provider: "github", available: false },
			});
			assert.equal(calls, 1);
			assert.equal(result?.cards[0]?.title, "LLM card");

			setPrWalkthroughSynthesisAdapterForTesting(() => ({ cards: [{ phaseId: "bad", title: "Bad", summary: "Bad", diffBlockIds: ["llm-block"] }] }));
			const fallback = await normalizeGithubResolvedWalkthrough({
				changesetId: "github:SuuBro/bobbit#42:abcdef1",
				changeset: { ...changeset(), provider: "github", prUrl: "https://github.com/SuuBro/bobbit/pull/42", prNumber: 42 },
				files: [file("src/llm.ts", "modified", [block("llm-block", "src/llm.ts", 2)])],
				warnings: [],
				export: { provider: "github", available: false },
			});
			assert.ok(fallback?.cards.some(card => card.phaseId === "orientation"));
			assert.ok(fallback?.cards.some(card => card.diffBlocks.some(diffBlock => diffBlock.id === "llm-block")));
		} finally {
			setPrWalkthroughSynthesisAdapterForTesting(undefined);
		}
	});

	it("reserves unassigned blocks for audit coverage without duplicating earlier cards", async () => {
		const files = Array.from({ length: 8 }, (_, index) => file(`pkg${index}/file.ts`, "modified", [block(`b${index}`, `pkg${index}/file.ts`, 10 - index)]));
		const cards = await synthesiseWalkthroughCards(changeset(), files);
		const audit = cards.find(card => card.phaseId === "audit");
		assert.ok(audit);
		assert.ok(audit.diffBlocks.length > 0);

		const nonAuditIds = new Set(cards.filter(card => card.phaseId !== "audit").flatMap(card => card.diffBlocks.map(diffBlock => diffBlock.id)));
		for (const diffBlock of audit.diffBlocks) assert.equal(nonAuditIds.has(diffBlock.id), false);
	});
});

describe("WalkthroughStore", () => {
	it("persists schema-versioned walkthrough payloads by changeset id", async () => {
		const dir = makeTempDir();
		const store = new WalkthroughStore(dir);
		const cards = await synthesiseWalkthroughCards(changeset(), [file("src/a.ts", "modified", [block("a", "src/a.ts", 2)])]);

		const saved = store.save({ changesetId: "github:owner/repo#12:abcdef", changeset: changeset(), cards, warnings: [] });
		const loaded = store.get("github:owner/repo#12:abcdef");

		assert.equal(saved.schemaVersion, WALKTHROUGH_STORE_SCHEMA_VERSION);
		assert.equal(loaded?.changesetId, "github:owner/repo#12:abcdef");
		assert.equal(loaded?.cards.length, cards.length);
		assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
	});

	it("ignores stale schema files and never persists auth tokens or raw headers", async () => {
		const dir = makeTempDir();
		const store = new WalkthroughStore(dir);
		store.save({
			changesetId: "local-a..b",
			changeset: changeset(),
			cards: [],
			warnings: [],
			export: {
				enabled: true,
				provider: "github",
				token: "ghp_secret",
				headers: { authorization: "Bearer secret" },
				nested: { authHeaders: { authorization: "Bearer secret" } },
			} as never,
		});

		const raw = JSON.stringify(store.get("local-a..b"));
		assert.equal(raw.includes("ghp_secret"), false);
		assert.equal(raw.includes("Bearer secret"), false);

		const file = path.join(dir, "pr-walkthrough", `v${WALKTHROUGH_STORE_SCHEMA_VERSION}`, `${Buffer.from("stale", "utf-8").toString("base64url")}.json`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ schemaVersion: 0, changesetId: "stale", updatedAt: new Date().toISOString(), changeset: {}, cards: [], warnings: [] }), "utf-8");
		assert.equal(store.get("stale"), null);
	});
});

function changeset() {
	return {
		baseSha: "1234567890abcdef",
		headSha: "abcdef1234567890",
		title: "Complete walkthrough",
		filesChanged: 8,
		additions: 80,
		deletions: 20,
	};
}

function file(filePath: string, status: string, diffBlocks: ReturnType<typeof block>[], extra: Record<string, unknown> = {}) {
	return { filePath, status, diffBlocks, ...extra };
}

function block(id: string, filePath: string, changedLines: number) {
	return {
		id,
		filePath,
		hunks: [
			{
				id: `${id}-h1`,
				header: "@@ -1,1 +1,1 @@",
				lines: Array.from({ length: changedLines }, (_, index) => ({
					id: `${id}-l${index + 1}`,
					side: "new",
					newLine: index + 1,
					kind: "add",
					text: `line ${index + 1}`,
				})),
			},
		],
	};
}

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pr-walkthrough-store-"));
	tempDirs.push(dir);
	return dir;
}
