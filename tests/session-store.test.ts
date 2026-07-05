/**
 * Unit tests for SessionStore — disk persistence for gateway session metadata.
 * Uses a temp directory via BOBBIT_DIR to isolate from real state.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";

// Point BOBBIT_DIR to a temp directory before importing SessionStore
const tmpRoot = makeTmpDir("session-store-test-");
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
	return new SessionStore(stateDir);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionStore", () => {
	beforeEach(() => {
		// Clear the store file + backups for a clean slate
		try {
			for (const f of fs.readdirSync(stateDir)) {
				if (f === "sessions.json" || f.startsWith("sessions.json.")) {
					try { fs.unlinkSync(path.join(stateDir, f)); } catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }
	});

	afterEach(() => {
		// Clean up store file + any rotated backups so each test starts clean.
		try {
			for (const f of fs.readdirSync(stateDir)) {
				if (f === "sessions.json" || f.startsWith("sessions.json.")) {
					try { fs.unlinkSync(path.join(stateDir, f)); } catch { /* ignore */ }
				}
			}
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

		it("round-trips Claude Code runtime metadata through disk", () => {
			const store1 = freshStore();
			store1.put(makeSession({
				runtime: "claude-code",
				modelProvider: "claude-code",
				modelId: "sonnet",
				claudeCodeSessionId: "cc-session-1",
				claudeCodeExecutable: "claude",
				claudeCodePermissionMode: "acceptEdits",
				claudeCodeModelAlias: "sonnet",
			}));
			store1.flush();

			const store2 = freshStore();
			const restored = store2.get("sess-1")!;
			assert.equal(restored.runtime, "claude-code");
			assert.equal(restored.modelProvider, "claude-code");
			assert.equal(restored.modelId, "sonnet");
			assert.equal(restored.claudeCodeSessionId, "cc-session-1");
			assert.equal(restored.claudeCodeExecutable, "claude");
			assert.equal(restored.claudeCodePermissionMode, "acceptEdits");
			assert.equal(restored.claudeCodeModelAlias, "sonnet");
		});

		it("persists first-class child session metadata", () => {
			const walkthroughAllowedTools = ["read", "grep", "find", "ls", "readonly_bash", "submit_pr_walkthrough_yaml"];
			const store1 = freshStore();
			store1.put(makeSession({
				parentSessionId: "launcher-1",
				childKind: "pr-walkthrough",
				readOnly: true,
				walkthroughJobId: "job-1",
				walkthroughChangesetId: "changeset-1",
				walkthroughTargetKey: "github:owner/repo#123",
				allowedTools: walkthroughAllowedTools,
			}));
			store1.flush();

			const store2 = freshStore();
			const restored = store2.get("sess-1")!;
			assert.equal(restored.parentSessionId, "launcher-1");
			assert.equal(restored.childKind, "pr-walkthrough");
			assert.equal(restored.readOnly, true);
			assert.equal(restored.walkthroughJobId, "job-1");
			assert.equal(restored.walkthroughChangesetId, "changeset-1");
			assert.equal(restored.walkthroughTargetKey, "github:owner/repo#123");
			assert.deepEqual(restored.allowedTools, walkthroughAllowedTools);
			assert.equal(restored.delegateOf, undefined);
		});

		it("round-trips durable delegate task fields (instructions + context) through disk", () => {
			// Delegate restart survival: the delegate's task (instructions + context) is
			// its durable equivalent of a worker's goal spec. It must survive a reboot so
			// restoreSession() can rebuild the system prompt from it.
			const ctx = { role: "helper", deadline: "eod" };
			const store1 = freshStore();
			store1.put(makeSession({
				id: "delegate-1",
				delegateOf: "owner-1",
				instructions: "restart-live-survivor-MARKER helper task",
				context: ctx,
			}));
			store1.flush();

			// New store instance reads from the same on-disk file (a real reboot).
			const store2 = freshStore();
			const restored = store2.get("delegate-1")!;
			assert.equal(restored.delegateOf, "owner-1");
			assert.equal(restored.instructions, "restart-live-survivor-MARKER helper task");
			assert.deepEqual(restored.context, ctx);
		});

		it("updates goalId and taskId", () => {
			const store = freshStore();
			store.put(makeSession());
			store.update("sess-1", { goalId: "g-1", taskId: "t-1" });
			const updated = store.get("sess-1")!;
			assert.equal(updated.goalId, "g-1");
			assert.equal(updated.taskId, "t-1");
		});

		it("lastReadAt round-trips through disk", () => {
			const store1 = freshStore();
			store1.put(makeSession());
			store1.update("sess-1", { lastReadAt: 12345 });
			store1.flush();
			// New store instance reads from same on-disk file
			const store2 = freshStore();
			assert.equal(store2.get("sess-1")!.lastReadAt, 12345);
		});

		it("lastReadAt defaults to undefined for new sessions", () => {
			const store = freshStore();
			store.put(makeSession());
			assert.equal(store.get("sess-1")!.lastReadAt, undefined);
		});

		// -------------------------------------------------------------------
		// CON-04 — restart-redrive fields must flush synchronously
		//
		// wasStreaming / streamingStartedAt / messageQueue decide whether a
		// mid-turn agent (or a queued-but-undispatched prompt) is re-driven
		// after a hard kill. If these ride the 1s save() debounce, a SIGKILL
		// within that window (OOM, harness SIGKILL, docker kill) loses them
		// even though the in-memory session object already reflects the new
		// state — the very state the field exists to make durable.
		//
		// Without calling flush(), the on-disk file must already contain the
		// new value the instant update() returns. A debounced write leaves
		// the on-disk file stale until the 1s timer fires (or flush() is
		// called), which is exactly the lost window.
		// -------------------------------------------------------------------

		it("wasStreaming flushes synchronously (recovery-critical)", () => {
			const store = freshStore();
			store.put(makeSession());
			store.update("sess-1", { wasStreaming: true, streamingStartedAt: 123 });
			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(raw.sessions[0].wasStreaming, true, "wasStreaming must be on disk before flush()/debounce timer");
			assert.equal(raw.sessions[0].streamingStartedAt, 123, "streamingStartedAt must be on disk before flush()/debounce timer");
		});

		it("streamingStartedAt clears synchronously when streaming ends", () => {
			const store = freshStore();
			store.put(makeSession());
			store.update("sess-1", { wasStreaming: true, streamingStartedAt: 123 });
			store.update("sess-1", { wasStreaming: false, streamingStartedAt: undefined });
			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(raw.sessions[0].wasStreaming, false);
			assert.equal(raw.sessions[0].streamingStartedAt, undefined);
		});

		it("messageQueue flushes synchronously (recovery-critical)", () => {
			const store = freshStore();
			store.put(makeSession());
			const queue = [{ id: "m1", text: "queued prompt", createdAt: Date.now() }] as any;
			store.update("sess-1", { messageQueue: queue });
			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.deepEqual(raw.sessions[0].messageQueue, queue, "messageQueue must be on disk before flush()/debounce timer");
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
	// Draft generation (gen) staleness guard — Bug 2 regression
	//
	// `setDraft` must silently discard an out-of-order write whose `gen` is
	// strictly lower than the gen already stored, so a delayed save from an
	// earlier generation can never resurrect/overwrite newer draft state.
	// Equal or higher gens must always be accepted. Drafts without a `gen`
	// field bypass the guard entirely (legacy / non-gen callers).
	// -----------------------------------------------------------------------

	describe("draft gen staleness guard", () => {
		it("accepts a strictly increasing gen (newer write wins)", () => {
			const store = freshStore();
			store.put(makeSession());
			assert.equal(store.setDraft("sess-1", "prompt", { text: "first", gen: 1 }), true);
			assert.equal(store.setDraft("sess-1", "prompt", { text: "second", gen: 2 }), true);
			assert.deepEqual(store.getDraft("sess-1", "prompt"), { text: "second", gen: 2 });
		});

		it("silently discards a stale (lower-gen) write without erroring", () => {
			const store = freshStore();
			store.put(makeSession());
			store.setDraft("sess-1", "prompt", { text: "newer", gen: 2 });
			// A delayed save from an earlier generation arrives out of order.
			const ok = store.setDraft("sess-1", "prompt", { text: "stale", gen: 1 });
			// Returns true (not an error) but must NOT mutate the stored draft.
			assert.equal(ok, true);
			assert.deepEqual(store.getDraft("sess-1", "prompt"), { text: "newer", gen: 2 });
		});

		it("accepts an equal-gen write (idempotent overwrite at same gen)", () => {
			const store = freshStore();
			store.put(makeSession());
			store.setDraft("sess-1", "prompt", { text: "a", gen: 3 });
			assert.equal(store.setDraft("sess-1", "prompt", { text: "b", gen: 3 }), true);
			assert.deepEqual(store.getDraft("sess-1", "prompt"), { text: "b", gen: 3 });
		});

		it("accepts a gen write when the existing draft has no gen field", () => {
			const store = freshStore();
			store.put(makeSession());
			store.setDraft("sess-1", "prompt", { text: "legacy" }); // no gen
			assert.equal(store.setDraft("sess-1", "prompt", { text: "with-gen", gen: 1 }), true);
			assert.deepEqual(store.getDraft("sess-1", "prompt"), { text: "with-gen", gen: 1 });
		});

		it("bypasses the guard when the incoming write has no gen field", () => {
			const store = freshStore();
			store.put(makeSession());
			store.setDraft("sess-1", "prompt", { text: "had-gen", gen: 5 });
			// A gen-less write is always accepted (no staleness comparison possible).
			assert.equal(store.setDraft("sess-1", "prompt", { text: "no-gen" }), true);
			assert.deepEqual(store.getDraft("sess-1", "prompt"), { text: "no-gen" });
		});

		it("does not resurrect a tombstone: stale text save after an empty-text send is dropped", () => {
			const store = freshStore();
			store.put(makeSession());
			// User typed, autosave landed at gen 1.
			store.setDraft("sess-1", "prompt", { text: "draft text", gen: 1 });
			// User sent: client overwrites with an empty-text tombstone at gen 2.
			store.setDraft("sess-1", "prompt", { text: "", gen: 2 });
			// A delayed autosave from the pre-send generation arrives late.
			store.setDraft("sess-1", "prompt", { text: "draft text", gen: 1 });
			// The tombstone must survive — the sent text must not reappear.
			assert.deepEqual(store.getDraft("sess-1", "prompt"), { text: "", gen: 2 });
		});

		it("applies the guard per draft type independently", () => {
			const store = freshStore();
			store.put(makeSession());
			store.setDraft("sess-1", "prompt", { text: "p", gen: 2 });
			store.setDraft("sess-1", "goal", { title: "g", gen: 2 });
			// Stale prompt write is dropped; goal type is unaffected by the prompt gen.
			store.setDraft("sess-1", "prompt", { text: "stale-p", gen: 1 });
			assert.equal(store.setDraft("sess-1", "goal", { title: "g2", gen: 3 }), true);
			assert.deepEqual(store.getDraft("sess-1", "prompt"), { text: "p", gen: 2 });
			assert.deepEqual(store.getDraft("sess-1", "goal"), { title: "g2", gen: 3 });
		});

		it("monotonic gen survives a disk reload (rejects stale write after reopen)", () => {
			const store1 = freshStore();
			store1.put(makeSession());
			store1.setDraft("sess-1", "prompt", { text: "newest", gen: 4 });
			store1.flush();
			// New store instance reloads the persisted draft (and its gen).
			const store2 = freshStore();
			assert.deepEqual(store2.getDraft("sess-1", "prompt"), { text: "newest", gen: 4 });
			// A stale write after reload must still be rejected.
			store2.setDraft("sess-1", "prompt", { text: "stale", gen: 2 });
			assert.deepEqual(store2.getDraft("sess-1", "prompt"), { text: "newest", gen: 4 });
		});
	});

	// NOTE: Composer attachment drafts are deliberately NOT stored in the server
	// SessionStore. They live client-side in IndexedDB (PromptDraftAttachmentsStore)
	// because base64 image blobs are too large for the inline sessions.json draft
	// map, and there is no persistent gen guard on them — stale-load resurrection
	// is prevented by the in-flight async-load generation guard in AgentInterface.
	// Store-level caps/eviction are covered by tests/prompt-draft-attachments-store.test.ts;
	// the in-flight guard is covered by tests/agent-interface-attachment-draft-race.test.ts.
	// See docs/design/composer-draft-persistence.md.

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

		it("persists Opus 4.8 model selection to disk and reloads without fallback", () => {
			const store1 = freshStore();
			store1.put(makeSession({
				id: "opus48-session",
				modelProvider: "anthropic",
				modelId: "claude-opus-4-8",
			}));
			store1.flush();

			const store2 = freshStore();
			const reloaded = store2.get("opus48-session");
			assert.ok(reloaded);
			assert.equal(reloaded.modelProvider, "anthropic");
			assert.equal(reloaded.modelId, "claude-opus-4-8");
			assert.notEqual(reloaded.modelId, "claude-opus-4-7");
			assert.notEqual(reloaded.modelId, "claude-opus-4-6");
			assert.notEqual(reloaded.modelId, "claude-opus-4");
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

		it("skips sessions without id but loads sessions without agentSessionFile", () => {
			const data = [
				{ id: "good", title: "Good", cwd: "/", agentSessionFile: "/a.jsonl", createdAt: 0, lastActivity: 0 },
				{ title: "No ID", cwd: "/", agentSessionFile: "/b.jsonl", createdAt: 0, lastActivity: 0 },
				{ id: "no-file", title: "No File", cwd: "/", createdAt: 0, lastActivity: 0 },
			];
			fs.writeFileSync(STORE_FILE, JSON.stringify(data), "utf-8");
			const store = freshStore();
			// Sessions without id are skipped, but sessions without agentSessionFile
			// are loaded (they represent sessions that were mid-creation when the server restarted)
			assert.equal(store.getAll().length, 2);
			assert.equal(store.get("good")!.title, "Good");
			assert.equal(store.get("no-file")!.title, "No File");
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

			// Verify by reading file directly (v2 shape: {version, epoch, sessions[]})
			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(raw.sessions[0].title, "Debounced");
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
