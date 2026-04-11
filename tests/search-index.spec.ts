import { test, expect } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { SearchIndex } from "../dist/server/search/search-index.js";

/**
 * Unit tests for SearchIndex — FTS5 search index lifecycle,
 * indexing roundtrips, removal, type filtering, special characters,
 * and edge cases.
 *
 * Run with:
 *   npx playwright test tests/search-index.spec.ts --config tests/playwright.config.ts
 */

function makeTempDbPath(): string {
	return path.join(os.tmpdir(), `bobbit-search-test-${crypto.randomUUID()}.db`);
}

function cleanupDb(dbPath: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			fs.unlinkSync(dbPath + suffix);
		} catch {
			// ignore
		}
	}
}

// ── Lifecycle ──────────────────────────────────────────────────────

test("needsRebuild() returns true on fresh DB", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		expect(index.needsRebuild()).toBe(true);
	} finally {
		index.close();
		cleanupDb(dbPath);
	}
});

test("needsRebuild() returns false after reopen (schema exists)", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		index.close();

		// Reopen — schema already created with correct version
		const index2 = new SearchIndex(dbPath);
		index2.open();
		expect(index2.needsRebuild()).toBe(false);
		index2.close();
	} finally {
		cleanupDb(dbPath);
	}
});

// ── Goal indexing roundtrip ────────────────────────────────────────

test("indexGoal + search returns the goal", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		index.indexGoal({
			id: "g1",
			title: "Deploy Pipeline",
			spec: "Deploy to production environment",
			state: "active",
			archived: false,
			createdAt: Date.now(),
		} as any);

		const results = index.search("Deploy");
		expect(results.results.length).toBeGreaterThan(0);
		expect(results.results[0].type).toBe("goal");
		expect(results.results[0].id).toBe("g1");
		expect(results.results[0].title).toBe("Deploy Pipeline");
	} finally {
		index.close();
		cleanupDb(dbPath);
	}
});

// ── Session indexing roundtrip ─────────────────────────────────────

test("indexSession + search returns the session", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		index.indexSession(
			{
				id: "s1",
				title: "Debugging WebSocket",
				role: "coder",
				goalId: "",
				archived: false,
				createdAt: Date.now(),
			} as any,
			"",
			"",
		);

		const results = index.search("WebSocket");
		expect(results.results.length).toBeGreaterThan(0);
		expect(results.results[0].type).toBe("session");
		expect(results.results[0].id).toBe("s1");
	} finally {
		index.close();
		cleanupDb(dbPath);
	}
});

// ── Message indexing roundtrip ─────────────────────────────────────

test("indexMessage + search returns the message", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		index.indexMessage("s1", "My Session", "refactored the authentication middleware", ["bash"], Date.now());

		const results = index.search("authentication");
		expect(results.results.length).toBeGreaterThan(0);
		expect(results.results[0].type).toBe("message");
		expect(results.results[0].sessionId).toBe("s1");
	} finally {
		index.close();
		cleanupDb(dbPath);
	}
});

// ── Staff indexing roundtrip ───────────────────────────────────────

test("indexStaff + search returns the staff", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		index.indexStaff({
			id: "st1",
			name: "CodeReviewer",
			description: "Reviews pull requests and suggests improvements",
			state: "active",
			createdAt: Date.now(),
		} as any);

		const results = index.search("CodeReviewer");
		expect(results.results.length).toBeGreaterThan(0);
		expect(results.results[0].type).toBe("staff");
		expect(results.results[0].id).toBe("st1");
	} finally {
		index.close();
		cleanupDb(dbPath);
	}
});

// ── Remove goal ────────────────────────────────────────────────────

test("removeGoal removes the goal from results", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		index.indexGoal({
			id: "g1",
			title: "Ephemeral Goal",
			spec: "Will be removed",
			state: "active",
			archived: false,
			createdAt: Date.now(),
		} as any);

		// Verify it's indexed
		let results = index.search("Ephemeral");
		expect(results.results.length).toBe(1);

		// Remove and verify it's gone
		index.removeGoal("g1");
		results = index.search("Ephemeral");
		expect(results.results.length).toBe(0);
	} finally {
		index.close();
		cleanupDb(dbPath);
	}
});

// ── Type filtering ─────────────────────────────────────────────────

test("type filter returns only matching type", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		index.indexGoal({
			id: "g1",
			title: "Terraform Module",
			spec: "Infrastructure as code",
			state: "active",
			archived: false,
			createdAt: Date.now(),
		} as any);
		index.indexSession(
			{
				id: "s1",
				title: "Terraform Discussion",
				role: "coder",
				goalId: "",
				archived: false,
				createdAt: Date.now(),
			} as any,
			"",
			"",
		);

		// Search all — both types present
		const all = index.search("Terraform");
		expect(all.results.length).toBe(2);

		// Filter to goals only
		const goalsOnly = index.search("Terraform", { type: "goals" });
		expect(goalsOnly.results.length).toBe(1);
		expect(goalsOnly.results[0].type).toBe("goal");

		// Filter to sessions only
		const sessionsOnly = index.search("Terraform", { type: "sessions" });
		expect(sessionsOnly.results.length).toBe(1);
		expect(sessionsOnly.results[0].type).toBe("session");
	} finally {
		index.close();
		cleanupDb(dbPath);
	}
});

// ── Special characters don't crash ─────────────────────────────────

test.describe("special characters in queries do not throw", () => {
	const queries = [
		"deploy:prod",
		"hello-world",
		"path/to/file",
		"foo(bar)",
		"+debug -test",
		"C:\\Users\\name",
		"version=2.0",
		"@mention #tag",
		'he said "hello"',
	];

	for (const q of queries) {
		test(`query: ${q}`, () => {
			const dbPath = makeTempDbPath();
			const index = new SearchIndex(dbPath);
			try {
				index.open();
				// Should not throw
				const results = index.search(q);
				expect(results).toBeDefined();
				expect(Array.isArray(results.results)).toBe(true);
			} finally {
				index.close();
				cleanupDb(dbPath);
			}
		});
	}
});

// ── Empty / whitespace queries ─────────────────────────────────────

test("empty string returns empty results", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		const results = index.search("");
		expect(results.results.length).toBe(0);
		expect(results.total).toBe(0);
	} finally {
		index.close();
		cleanupDb(dbPath);
	}
});

test("whitespace-only query returns empty results", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		const results = index.search("   ");
		expect(results.results.length).toBe(0);
		expect(results.total).toBe(0);
	} finally {
		index.close();
		cleanupDb(dbPath);
	}
});

// ── All-special-chars query ────────────────────────────────────────

test("all-special-chars query returns empty results", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		const results = index.search("++--");
		expect(results.results.length).toBe(0);
		expect(results.total).toBe(0);
	} finally {
		index.close();
		cleanupDb(dbPath);
	}
});

// ── Prefix matching ───────────────────────────────────────────────

test("prefix matching works (partial word)", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		index.indexGoal({
			id: "g1",
			title: "Sandbox Configuration",
			spec: "Configure the Docker sandbox",
			state: "active",
			archived: false,
			createdAt: Date.now(),
		} as any);

		// "sand" should match "sandbox" via prefix
		const results = index.search("sand");
		expect(results.results.length).toBeGreaterThan(0);
		expect(results.results[0].id).toBe("g1");
	} finally {
		index.close();
		cleanupDb(dbPath);
	}
});

// ── Long query ─────────────────────────────────────────────────────

test("long query (500+ chars) does not crash", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		const longQuery = "search ".repeat(100); // ~700 chars
		const results = index.search(longQuery);
		expect(results).toBeDefined();
		expect(Array.isArray(results.results)).toBe(true);
	} finally {
		index.close();
		cleanupDb(dbPath);
	}
});

// ── Remove session messages ────────────────────────────────────────

test("removeMessagesForSession removes all messages for that session", () => {
	const dbPath = makeTempDbPath();
	const index = new SearchIndex(dbPath);
	try {
		index.open();
		index.indexMessage("s1", "Session A", "unique flamingo content", [], Date.now());
		index.indexMessage("s1", "Session A", "another flamingo message", [], Date.now());
		index.indexMessage("s2", "Session B", "flamingo in session B", [], Date.now());

		// All three indexed
		let results = index.search("flamingo");
		expect(results.results.length).toBe(3);

		// Remove s1 messages
		index.removeMessagesForSession("s1");
		results = index.search("flamingo");
		expect(results.results.length).toBe(1);
		expect(results.results[0].sessionId).toBe("s2");
	} finally {
		index.close();
		cleanupDb(dbPath);
	}
});
