/**
 * Unit tests for SearchIndex (SQLite FTS5) and message extractor.
 *
 * Uses a temp directory for each test to isolate SQLite databases.
 * Runs via `npx tsx --test tests/search-index.test.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SearchIndex } from "../src/server/search/search-index.js";
import { extractTextFromMessage } from "../src/server/search/message-extractor.js";
import type { PersistedGoal } from "../src/server/agent/goal-store.js";
import type { PersistedSession } from "../src/server/agent/session-store.js";

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDir: string;
let idx: SearchIndex;

function makeGoal(overrides: Partial<PersistedGoal> = {}): PersistedGoal {
	return {
		id: "goal-1",
		title: "Test Goal",
		cwd: "/tmp",
		state: "in-progress",
		spec: "Build the search feature",
		createdAt: 1000,
		updatedAt: 1000,
		...overrides,
	} as PersistedGoal;
}

function makeSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
	return {
		id: "session-1",
		title: "Test Session",
		cwd: "/tmp",
		agentSessionFile: "",
		createdAt: 2000,
		lastActivity: 2000,
		role: "developer",
		...overrides,
	} as PersistedSession;
}

// ── Test setup ───────────────────────────────────────────────────────

describe("SearchIndex", () => {
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-test-"));
		idx = new SearchIndex(path.join(tmpDir, "search.db"));
	});

	afterEach(() => {
		try { idx.close(); } catch { /* ok */ }
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	// ── Lifecycle ────────────────────────────────────────────────

	describe("lifecycle", () => {
		it("needsRebuild returns true on fresh DB", () => {
			idx.open();
			assert.equal(idx.needsRebuild(), true);
		});

		it("needsRebuild returns false after reopening existing DB", () => {
			idx.open();
			idx.close();
			// Re-open the same DB — schema already created
			const idx2 = new SearchIndex(path.join(tmpDir, "search.db"));
			idx2.open();
			assert.equal(idx2.needsRebuild(), false);
			idx2.close();
		});

		it("open creates parent directories", () => {
			const nested = path.join(tmpDir, "deep", "nested", "search.db");
			const nestedIdx = new SearchIndex(nested);
			nestedIdx.open();
			assert.ok(fs.existsSync(nested));
			nestedIdx.close();
		});

		it("close is idempotent", () => {
			idx.open();
			idx.close();
			idx.close(); // Should not throw
		});

		it("search returns empty when DB not opened", () => {
			const result = idx.search("test");
			assert.deepEqual(result, { results: [], total: 0 });
		});
	});

	// ── Goal indexing ────────────────────────────────────────────

	describe("goal indexing", () => {
		it("indexes and finds a goal by title", () => {
			idx.open();
			idx.indexGoal(makeGoal({ title: "Search Feature" }));
			const result = idx.search("Search");
			assert.equal(result.total, 1);
			assert.equal(result.results[0].type, "goal");
			assert.equal(result.results[0].id, "goal-1");
			assert.equal(result.results[0].title, "Search Feature");
		});

		it("indexes and finds a goal by spec", () => {
			idx.open();
			idx.indexGoal(makeGoal({ spec: "Implement pagination for archived items" }));
			const result = idx.search("pagination");
			assert.equal(result.total, 1);
			assert.equal(result.results[0].type, "goal");
		});

		it("upserts on re-index (no duplicates)", () => {
			idx.open();
			idx.indexGoal(makeGoal({ title: "Old Title" }));
			idx.indexGoal(makeGoal({ title: "New Title" }));
			const result = idx.search("Title");
			assert.equal(result.total, 1);
			assert.equal(result.results[0].title, "New Title");
		});

		it("removeGoal removes from index", () => {
			idx.open();
			idx.indexGoal(makeGoal());
			idx.removeGoal("goal-1");
			const result = idx.search("Test Goal");
			assert.equal(result.total, 0);
		});

		it("tracks archived status", () => {
			idx.open();
			idx.indexGoal(makeGoal({ archived: true, archivedAt: 5000 }));
			const result = idx.search("Test Goal");
			assert.equal(result.results[0].archived, true);
		});
	});

	// ── Session indexing ─────────────────────────────────────────

	describe("session indexing", () => {
		it("indexes and finds a session by title", () => {
			idx.open();
			idx.indexSession(makeSession({ title: "Debugging proxy issue" }));
			const result = idx.search("proxy");
			assert.equal(result.total, 1);
			assert.equal(result.results[0].type, "session");
			assert.equal(result.results[0].id, "session-1");
		});

		it("indexes and finds a session by role", () => {
			idx.open();
			idx.indexSession(makeSession({ role: "architect" }));
			const result = idx.search("architect");
			assert.equal(result.total, 1);
			assert.equal(result.results[0].type, "session");
		});

		it("indexes with goal title context", () => {
			idx.open();
			idx.indexSession(makeSession({ goalId: "g1" }), "Search Feature");
			const result = idx.search("Search Feature");
			assert.equal(result.total, 1);
			assert.equal(result.results[0].type, "session");
		});

		it("upserts on re-index", () => {
			idx.open();
			idx.indexSession(makeSession({ title: "Old" }));
			idx.indexSession(makeSession({ title: "New" }));
			const result = idx.search("New");
			assert.equal(result.total, 1);
		});

		it("removeSession removes from index", () => {
			idx.open();
			idx.indexSession(makeSession());
			idx.removeSession("session-1");
			const result = idx.search("Test Session");
			assert.equal(result.total, 0);
		});

		it("tracks goalId on results", () => {
			idx.open();
			idx.indexSession(makeSession({ goalId: "goal-abc" }));
			const result = idx.search("Test Session");
			assert.equal(result.results[0].goalId, "goal-abc");
		});
	});

	// ── Message indexing ─────────────────────────────────────────

	describe("message indexing", () => {
		it("indexes and finds a message by text content", () => {
			idx.open();
			idx.indexMessage("s1", "My Session", "Hello world from the agent", [], 3000);
			const result = idx.search("Hello world");
			assert.equal(result.total, 1);
			assert.equal(result.results[0].type, "message");
			assert.equal(result.results[0].sessionId, "s1");
			assert.equal(result.results[0].sessionTitle, "My Session");
		});

		it("indexes and finds by tool name", () => {
			idx.open();
			idx.indexMessage("s1", "Session", "ran some commands", ["web_search", "bash"], 3000);
			const result = idx.search("web_search");
			assert.equal(result.total, 1);
			assert.equal(result.results[0].type, "message");
		});

		it("skips empty text", () => {
			idx.open();
			idx.indexMessage("s1", "Session", "   ", [], 3000);
			const result = idx.search("Session");
			assert.equal(result.total, 0);
		});

		it("removeMessagesForSession removes all messages for that session", () => {
			idx.open();
			idx.indexMessage("s1", "Session", "first message", [], 1000);
			idx.indexMessage("s1", "Session", "second message", [], 2000);
			idx.indexMessage("s2", "Other", "other message", [], 3000);
			idx.removeMessagesForSession("s1");
			const r1 = idx.search("message");
			assert.equal(r1.total, 1);
			assert.equal(r1.results[0].sessionId, "s2");
		});

		it("message results include session context", () => {
			idx.open();
			idx.indexMessage("s1", "Debug Session", "found the bug", [], 4000);
			const result = idx.search("bug");
			const msg = result.results[0];
			assert.equal(msg.type, "message");
			assert.equal(msg.sessionId, "s1");
			assert.equal(msg.sessionTitle, "Debug Session");
			assert.equal(msg.title, "Debug Session");
		});
	});

	// ── Search options ───────────────────────────────────────────

	describe("search options", () => {
		beforeEach(() => {
			idx.open();
			idx.indexGoal(makeGoal({ id: "g1", title: "Alpha search target" }));
			idx.indexSession(makeSession({ id: "s1", title: "Alpha session target" }));
			idx.indexMessage("s1", "Session", "Alpha message target content", [], 1000);
		});

		it("type filter: goals only", () => {
			const result = idx.search("Alpha", { type: "goals" });
			assert.ok(result.results.every(r => r.type === "goal"));
			assert.equal(result.total, 1);
		});

		it("type filter: sessions only", () => {
			const result = idx.search("Alpha", { type: "sessions" });
			assert.ok(result.results.every(r => r.type === "session"));
			assert.equal(result.total, 1);
		});

		it("type filter: messages only", () => {
			const result = idx.search("Alpha", { type: "messages" });
			assert.ok(result.results.every(r => r.type === "message"));
			assert.equal(result.total, 1);
		});

		it("type filter: all returns all types", () => {
			const result = idx.search("Alpha", { type: "all" });
			const types = new Set(result.results.map(r => r.type));
			assert.ok(types.has("goal"));
			assert.ok(types.has("session"));
			assert.ok(types.has("message"));
		});

		it("limit restricts result count", () => {
			// Add more messages to test limit
			for (let i = 0; i < 15; i++) {
				idx.indexMessage("s1", "Session", `Alpha item number ${i}`, [], 1000 + i);
			}
			const result = idx.search("Alpha", { type: "messages", limit: 5 });
			assert.equal(result.results.length, 5);
			assert.ok(result.total > 5); // total should be higher than returned
		});

		it("offset skips results", () => {
			for (let i = 0; i < 10; i++) {
				idx.indexMessage(`s${i}`, "Session", `Alpha unique item ${i}`, [], 1000 + i);
			}
			const page1 = idx.search("Alpha", { type: "messages", limit: 5, offset: 0 });
			const page2 = idx.search("Alpha", { type: "messages", limit: 5, offset: 5 });
			// Pages should be different (no overlap in IDs)
			const ids1 = new Set(page1.results.map(r => r.id));
			const ids2 = new Set(page2.results.map(r => r.id));
			for (const id of ids2) {
				assert.ok(!ids1.has(id), `ID ${id} appears in both pages`);
			}
		});

		it("snippets contain highlighting tags", () => {
			// Index a goal whose spec matches so the snippet (from spec column) highlights it
			idx.indexGoal(makeGoal({ id: "g-snip", title: "Snippet Test", spec: "Alpha content in spec" }));
			const result = idx.search("Alpha", { type: "goals" });
			assert.ok(result.results.length > 0);
			// FTS5 snippet uses <b></b> for highlighting in the spec column
			const hasHighlight = result.results.some(r => r.snippet.includes("<b>"));
			assert.ok(hasHighlight,
				`Expected at least one snippet with <b> highlight, got: ${result.results.map(r => r.snippet).join("; ")}`);
		});
	});

	// ── FTS query sanitisation ───────────────────────────────────

	describe("FTS query sanitisation", () => {
		beforeEach(() => {
			idx.open();
			idx.indexGoal(makeGoal({ title: "Hello World" }));
		});

		it("empty query returns empty results", () => {
			const result = idx.search("");
			assert.deepEqual(result, { results: [], total: 0 });
		});

		it("whitespace-only query returns empty results", () => {
			const result = idx.search("   ");
			assert.deepEqual(result, { results: [], total: 0 });
		});

		it("ASCII double quotes are stripped (not FTS syntax error)", () => {
			// Should not throw — quotes are sanitised out
			const result = idx.search('"Hello"');
			assert.ok(result.total >= 1);
		});

		it("smart quotes (curly) are stripped", () => {
			const result = idx.search("\u201CHello\u201D");
			assert.ok(result.total >= 1);
		});

		it("special FTS characters (colons, hyphens) handled", () => {
			idx.indexGoal(makeGoal({ id: "g2", title: "error: something-went-wrong" }));
			// Should not throw
			const result = idx.search("error: something-went-wrong");
			assert.ok(typeof result.total === "number");
		});

		it("handles query with only special characters", () => {
			const result = idx.search('"""');
			assert.deepEqual(result, { results: [], total: 0 });
		});
	});

	// ── Multiple types mixed ─────────────────────────────────────

	describe("cross-type search", () => {
		it("finds matches across goals, sessions, and messages", () => {
			idx.open();
			idx.indexGoal(makeGoal({ title: "Implement deployment pipeline" }));
			idx.indexSession(makeSession({ title: "Deployment debugging" }));
			idx.indexMessage("s1", "Session", "Fixed deployment script", [], 1000);

			const result = idx.search("deployment");
			assert.equal(result.total, 3);
			const types = result.results.map(r => r.type);
			assert.ok(types.includes("goal"));
			assert.ok(types.includes("session"));
			assert.ok(types.includes("message"));
		});
	});
});

// ── Message extractor ────────────────────────────────────────────────

describe("extractTextFromMessage", () => {
	it("returns empty for null/undefined", () => {
		assert.deepEqual(extractTextFromMessage(null), { text: "", toolNames: [] });
		assert.deepEqual(extractTextFromMessage(undefined), { text: "", toolNames: [] });
	});

	it("returns empty for non-object", () => {
		assert.deepEqual(extractTextFromMessage("string"), { text: "", toolNames: [] });
		assert.deepEqual(extractTextFromMessage(42), { text: "", toolNames: [] });
	});

	it("returns empty for non-assistant roles", () => {
		assert.deepEqual(
			extractTextFromMessage({ role: "user", content: "hello" }),
			{ text: "", toolNames: [] },
		);
		assert.deepEqual(
			extractTextFromMessage({ role: "system", content: "prompt" }),
			{ text: "", toolNames: [] },
		);
	});

	it("extracts string content from assistant message", () => {
		const result = extractTextFromMessage({
			role: "assistant",
			content: "Hello world",
		});
		assert.equal(result.text, "Hello world");
		assert.deepEqual(result.toolNames, []);
	});

	it("extracts text blocks from array content", () => {
		const result = extractTextFromMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "First paragraph" },
				{ type: "text", text: "Second paragraph" },
			],
		});
		assert.equal(result.text, "First paragraph\nSecond paragraph");
		assert.deepEqual(result.toolNames, []);
	});

	it("extracts tool_use names", () => {
		const result = extractTextFromMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "Let me search" },
				{ type: "tool_use", id: "t1", name: "web_search", input: {} },
				{ type: "tool_use", id: "t2", name: "bash", input: {} },
			],
		});
		assert.equal(result.text, "Let me search");
		assert.deepEqual(result.toolNames, ["web_search", "bash"]);
	});

	it("skips thinking blocks", () => {
		const result = extractTextFromMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "internal reasoning..." },
				{ type: "text", text: "Visible output" },
			],
		});
		assert.equal(result.text, "Visible output");
	});

	it("skips tool_result blocks", () => {
		const result = extractTextFromMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "Here is the result" },
				{ type: "tool_result", tool_use_id: "t1", content: "noisy output" },
			],
		});
		assert.equal(result.text, "Here is the result");
	});

	it("skips image blocks", () => {
		const result = extractTextFromMessage({
			role: "assistant",
			content: [
				{ type: "image", source: { type: "base64", data: "..." } },
				{ type: "text", text: "Description" },
			],
		});
		assert.equal(result.text, "Description");
	});

	it("handles empty content array", () => {
		const result = extractTextFromMessage({
			role: "assistant",
			content: [],
		});
		assert.equal(result.text, "");
		assert.deepEqual(result.toolNames, []);
	});

	it("handles missing content field", () => {
		const result = extractTextFromMessage({ role: "assistant" });
		assert.equal(result.text, "");
		assert.deepEqual(result.toolNames, []);
	});

	it("handles null blocks in content array gracefully", () => {
		const result = extractTextFromMessage({
			role: "assistant",
			content: [null, undefined, { type: "text", text: "valid" }],
		});
		assert.equal(result.text, "valid");
	});
});
