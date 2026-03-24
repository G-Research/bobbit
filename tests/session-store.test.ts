/**
 * Unit tests for SessionStore — disk persistence for gateway session metadata.
 * Uses a temp directory via BOBBIT_DIR to isolate from real state.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point BOBBIT_DIR to a temp directory before importing SessionStore
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-test-"));
const stateDir = path.join(tmpRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;

const STORE_FILE = path.join(stateDir, "sessions.json");

// Dynamic import after env is set
const { SessionStore } = await import("../src/server/agent/session-store.ts");
type PersistedSession = import("../src/server/agent/session-store.ts").PersistedSession;

function makeSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
	return {
		id: "sess-1",
		title: "Test Session",
		cwd: "/tmp/test",
		agentSessionFile: "/tmp/test/agent.jsonl",
		createdAt: Date.now(),
		lastActivity: Date.now(),
		...overrides,
	};
}

function freshStore(): InstanceType<typeof SessionStore> {
	return new SessionStore();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionStore", () => {
	beforeEach(() => {
		// Clear the store file for a clean slate
		if (fs.existsSync(STORE_FILE)) {
			fs.unlinkSync(STORE_FILE);
		}
	});

	afterEach(() => {
		// Clean up store file
		try {
			if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
		} catch { /* ignore */ }
	});

	// After all tests, clean up temp dir
	// (node:test doesn't have afterAll, but the OS cleans tmpdir eventually)

	// -----------------------------------------------------------------------
	// Basic CRUD
	// -----------------------------------------------------------------------

	describe("basic CRUD", () => {
		it("put and get a session", () => {
			const store = freshStore();
			const session = makeSession();
			store.put(session);
			const retrieved = store.get("sess-1");
			assert.ok(retrieved);
			assert.equal(retrieved.id, "sess-1");
			assert.equal(retrieved.title, "Test Session");
			assert.equal(retrieved.cwd, "/tmp/test");
			assert.equal(retrieved.agentSessionFile, "/tmp/test/agent.jsonl");
		});

		it("get returns undefined for non-existent session", () => {
			const store = freshStore();
			assert.equal(store.get("nonexistent"), undefined);
		});

		it("getAll returns all sessions", () => {
			const store = freshStore();
			store.put(makeSession({ id: "s1" }));
			store.put(makeSession({ id: "s2", title: "Second" }));
			const all = store.getAll();
			assert.equal(all.length, 2);
			const ids = all.map(s => s.id).sort();
			assert.deepEqual(ids, ["s1", "s2"]);
		});

		it("remove deletes a session", () => {
			const store = freshStore();
			store.put(makeSession());
			assert.ok(store.get("sess-1"));
			store.remove("sess-1");
			assert.equal(store.get("sess-1"), undefined);
			assert.equal(store.getAll().length, 0);
		});

		it("remove on non-existent session does not throw", () => {
			const store = freshStore();
			store.remove("nonexistent"); // should not throw
			assert.equal(store.getAll().length, 0);
		});

		it("put overwrites existing session with same id", () => {
			const store = freshStore();
			store.put(makeSession());
			store.put(makeSession({ title: "Updated" }));
			const retrieved = store.get("sess-1");
			assert.ok(retrieved);
			assert.equal(retrieved.title, "Updated");
			assert.equal(store.getAll().length, 1);
		});
	});

	// -----------------------------------------------------------------------
	// update()
	// -----------------------------------------------------------------------

	describe("update()", () => {
		it("updates specified fields", () => {
			const store = freshStore();
			store.put(makeSession());
			store.update("sess-1", { title: "New Title", wasStreaming: true });
			const updated = store.get("sess-1")!;
			assert.equal(updated.title, "New Title");
			assert.equal(updated.wasStreaming, true);
			// Unchanged fields preserved
			assert.equal(updated.cwd, "/tmp/test");
		});

		it("update on non-existent session is a no-op", () => {
			const store = freshStore();
			store.update("nonexistent", { title: "X" });
			assert.equal(store.get("nonexistent"), undefined);
		});

		it("updates role and teamGoalId", () => {
			const store = freshStore();
			store.put(makeSession());
			store.update("sess-1", { role: "coder", teamGoalId: "goal-42" });
			const updated = store.get("sess-1")!;
			assert.equal(updated.role, "coder");
			assert.equal(updated.teamGoalId, "goal-42");
		});

		it("updates goalId and taskId", () => {
			const store = freshStore();
			store.put(makeSession());
			store.update("sess-1", { goalId: "g-1", taskId: "t-1" });
			const updated = store.get("sess-1")!;
			assert.equal(updated.goalId, "g-1");
			assert.equal(updated.taskId, "t-1");
		});
	});

	// -----------------------------------------------------------------------
	// Drafts
	// -----------------------------------------------------------------------

	describe("drafts", () => {
		it("set and get a draft", () => {
			const store = freshStore();
			store.put(makeSession());
			const ok = store.setDraft("sess-1", "prompt", { text: "Hello" });
			assert.equal(ok, true);
			const draft = store.getDraft("sess-1", "prompt");
			assert.deepEqual(draft, { text: "Hello" });
		});

		it("getDraft returns undefined for missing session", () => {
			const store = freshStore();
			assert.equal(store.getDraft("nonexistent", "prompt"), undefined);
		});

		it("getDraft returns undefined for missing draft type", () => {
			const store = freshStore();
			store.put(makeSession());
			assert.equal(store.getDraft("sess-1", "prompt"), undefined);
		});

		it("setDraft returns false for missing session", () => {
			const store = freshStore();
			assert.equal(store.setDraft("nonexistent", "prompt", {}), false);
		});

		it("deleteDraft removes a draft", () => {
			const store = freshStore();
			store.put(makeSession());
			store.setDraft("sess-1", "prompt", { text: "Hi" });
			const ok = store.deleteDraft("sess-1", "prompt");
			assert.equal(ok, true);
			assert.equal(store.getDraft("sess-1", "prompt"), undefined);
		});

		it("deleteDraft cleans up empty drafts object", () => {
			const store = freshStore();
			store.put(makeSession());
			store.setDraft("sess-1", "prompt", { text: "Hi" });
			store.deleteDraft("sess-1", "prompt");
			const session = store.get("sess-1")!;
			assert.equal(session.drafts, undefined);
		});

		it("deleteDraft returns false for missing session", () => {
			const store = freshStore();
			assert.equal(store.deleteDraft("nonexistent", "prompt"), false);
		});

		it("deleteDraft returns false when no drafts exist", () => {
			const store = freshStore();
			store.put(makeSession());
			assert.equal(store.deleteDraft("sess-1", "prompt"), false);
		});
	});

	// -----------------------------------------------------------------------
	// Persistence round-trips
	// -----------------------------------------------------------------------

	describe("persistence", () => {
		it("persists sessions to disk and reloads", () => {
			const store1 = freshStore();
			store1.put(makeSession({ id: "s1", title: "First" }));
			store1.put(makeSession({ id: "s2", title: "Second" }));

			// Create a new store instance — it should reload from disk
			const store2 = freshStore();
			assert.equal(store2.getAll().length, 2);
			assert.equal(store2.get("s1")!.title, "First");
			assert.equal(store2.get("s2")!.title, "Second");
		});

		it("remove persists deletion", () => {
			const store1 = freshStore();
			store1.put(makeSession());
			store1.remove("sess-1");

			const store2 = freshStore();
			assert.equal(store2.get("sess-1"), undefined);
			assert.equal(store2.getAll().length, 0);
		});

		it("handles missing file gracefully", () => {
			if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
			const store = freshStore();
			assert.equal(store.getAll().length, 0);
		});

		it("handles corrupt JSON gracefully", () => {
			fs.writeFileSync(STORE_FILE, "not valid json{{{", "utf-8");
			const store = freshStore();
			// Should not throw — store starts empty
			assert.equal(store.getAll().length, 0);
			// And should still be functional
			store.put(makeSession({ id: "post-corrupt" }));
			assert.ok(store.get("post-corrupt"));
		});

		it("handles non-array JSON gracefully", () => {
			fs.writeFileSync(STORE_FILE, '{"not": "an array"}', "utf-8");
			const store = freshStore();
			assert.equal(store.getAll().length, 0);
		});

		it("skips sessions without id or agentSessionFile", () => {
			const data = [
				{ id: "good", title: "Good", cwd: "/", agentSessionFile: "/a.jsonl", createdAt: 0, lastActivity: 0 },
				{ title: "No ID", cwd: "/", agentSessionFile: "/b.jsonl", createdAt: 0, lastActivity: 0 },
				{ id: "no-file", title: "No File", cwd: "/", createdAt: 0, lastActivity: 0 },
			];
			fs.writeFileSync(STORE_FILE, JSON.stringify(data), "utf-8");
			const store = freshStore();
			assert.equal(store.getAll().length, 1);
			assert.equal(store.get("good")!.title, "Good");
		});
	});

	// -----------------------------------------------------------------------
	// Legacy migration
	// -----------------------------------------------------------------------

	describe("legacy migration", () => {
		it("migrates swarmGoalId to teamGoalId", () => {
			const data = [{
				id: "legacy-1",
				title: "Legacy",
				cwd: "/",
				agentSessionFile: "/a.jsonl",
				createdAt: 0,
				lastActivity: 0,
				swarmGoalId: "goal-old",
			}];
			fs.writeFileSync(STORE_FILE, JSON.stringify(data), "utf-8");
			const store = freshStore();
			const session = store.get("legacy-1")!;
			assert.equal(session.teamGoalId, "goal-old");
			assert.equal((session as any).swarmGoalId, undefined);
		});

		it("normalizes legacy boolean goalAssistant to assistantType", () => {
			const data = [{
				id: "legacy-goal",
				title: "Goal Assist",
				cwd: "/",
				agentSessionFile: "/a.jsonl",
				createdAt: 0,
				lastActivity: 0,
				goalAssistant: true,
			}];
			fs.writeFileSync(STORE_FILE, JSON.stringify(data), "utf-8");
			const store = freshStore();
			assert.equal(store.get("legacy-goal")!.assistantType, "goal");
		});

		it("normalizes legacy boolean roleAssistant to assistantType", () => {
			const data = [{
				id: "legacy-role",
				title: "Role Assist",
				cwd: "/",
				agentSessionFile: "/a.jsonl",
				createdAt: 0,
				lastActivity: 0,
				roleAssistant: true,
			}];
			fs.writeFileSync(STORE_FILE, JSON.stringify(data), "utf-8");
			const store = freshStore();
			assert.equal(store.get("legacy-role")!.assistantType, "role");
		});

		it("normalizes legacy boolean toolAssistant to assistantType", () => {
			const data = [{
				id: "legacy-tool",
				title: "Tool Assist",
				cwd: "/",
				agentSessionFile: "/a.jsonl",
				createdAt: 0,
				lastActivity: 0,
				toolAssistant: true,
			}];
			fs.writeFileSync(STORE_FILE, JSON.stringify(data), "utf-8");
			const store = freshStore();
			assert.equal(store.get("legacy-tool")!.assistantType, "tool");
		});

		it("does not overwrite existing assistantType with legacy boolean", () => {
			const data = [{
				id: "has-both",
				title: "Both",
				cwd: "/",
				agentSessionFile: "/a.jsonl",
				createdAt: 0,
				lastActivity: 0,
				assistantType: "goal",
				roleAssistant: true,
			}];
			fs.writeFileSync(STORE_FILE, JSON.stringify(data), "utf-8");
			const store = freshStore();
			assert.equal(store.get("has-both")!.assistantType, "goal");
		});
	});

	// -----------------------------------------------------------------------
	// flush()
	// -----------------------------------------------------------------------

	describe("flush()", () => {
		it("flushes debounced writes immediately", async () => {
			const store = freshStore();
			store.put(makeSession({ id: "s1" }));
			// update() uses debounced save
			store.update("s1", { title: "Debounced" });
			// flush forces write
			store.flush();

			// Verify by reading file directly
			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(raw[0].title, "Debounced");
		});

		it("flush is a no-op when nothing is pending", () => {
			const store = freshStore();
			store.flush(); // should not throw
		});
	});

	// -----------------------------------------------------------------------
	// Empty store
	// -----------------------------------------------------------------------

	describe("empty store", () => {
		it("starts with empty getAll when no file exists", () => {
			const store = freshStore();
			assert.deepEqual(store.getAll(), []);
		});

		it("starts with empty getAll from empty array file", () => {
			fs.writeFileSync(STORE_FILE, "[]", "utf-8");
			const store = freshStore();
			assert.deepEqual(store.getAll(), []);
		});
	});
});
