/**
 * Unit test for the restore-phase gating in SessionManager.restoreSession.
 *
 * Background: when the gateway server restarts, restoreSession installs an
 * rpc-event subscriber and then calls switch_session, which causes the agent
 * CLI to replay every persisted message as an rpc event. Previously the
 * subscriber bumped session.lastActivity = Date.now() on every event,
 * clobbering the persisted pre-restart timestamp.
 *
 * The fix: gate the lastActivity write on the existing `restoring` flag, which
 * is cleared only after switch_session resolves.
 *
 * This test exercises the exact closure shape used by restoreSession against
 * a real SessionStore, ensuring the persisted lastActivity is preserved
 * across simulated replay events and only updated by post-restore events.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-restore-test-"));
const stateDir = path.join(tmpRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;

const { SessionStore } = await import("../src/server/agent/session-store.ts");
type PersistedSession = import("../src/server/agent/session-store.ts").PersistedSession;

const STORE_FILE = path.join(stateDir, "sessions.json");

const ORIGINAL_TS = Date.now() - 3_600_000; // 1 hour ago

function freshStore() {
	if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
	return new SessionStore(stateDir);
}

function makeSession(): PersistedSession {
	return {
		id: "sess-1",
		title: "Restored Session",
		cwd: "/tmp/test",
		agentSessionFile: "/tmp/test/agent.jsonl",
		createdAt: ORIGINAL_TS - 1000,
		lastActivity: ORIGINAL_TS,
	};
}

/**
 * Build the same closure used inside restoreSession (verbatim shape — the
 * `if (!restoring)` gate and store.update call). Returns the event handler
 * and a setter for the restoring flag, mirroring how the real code uses a
 * `let restoring = true;` var that flips to false after switch_session.
 */
function makeRestoreHandler(store: InstanceType<typeof SessionStore>, sessionId: string) {
	let restoring = true;
	const session = { lastActivity: ORIGINAL_TS };
	const updates: Array<Partial<PersistedSession>> = [];
	const updateSpy = (id: string, u: Partial<PersistedSession>) => {
		if (id === sessionId) updates.push(u);
		store.update(id, u);
	};
	const handler = (_event: any) => {
		if (!restoring) {
			session.lastActivity = Date.now();
			updateSpy(sessionId, { lastActivity: session.lastActivity });
		}
		// Other side-effects intentionally omitted — we are testing the gate.
	};
	return {
		handler,
		session,
		updates,
		setRestoring: (v: boolean) => { restoring = v; },
	};
}

describe("restoreSession lastActivity gating", () => {
	beforeEach(() => {
		if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
	});

	it("does NOT bump lastActivity for events fired during restore", () => {
		const store = freshStore();
		store.put(makeSession());
		const ctx = makeRestoreHandler(store, "sess-1");

		// Simulate a sequence of replayed events (restoring still true)
		ctx.handler({ type: "agent_start" });
		ctx.handler({ type: "message_end" });
		ctx.handler({ type: "tool_use", toolName: "read" });
		ctx.handler({ type: "tool_result" });
		ctx.handler({ type: "agent_end" });

		// No update calls were made for lastActivity
		assert.equal(ctx.updates.length, 0, "no updates should be recorded during replay");
		// In-memory mirror unchanged
		assert.equal(ctx.session.lastActivity, ORIGINAL_TS);
		// On-disk lastActivity unchanged
		store.flush();
		const persisted = store.get("sess-1")!;
		assert.equal(persisted.lastActivity, ORIGINAL_TS, "persisted lastActivity must be preserved");
	});

	it("bumps lastActivity for events fired after switch_session resolves", () => {
		const store = freshStore();
		store.put(makeSession());
		const ctx = makeRestoreHandler(store, "sess-1");

		// Replay phase
		ctx.handler({ type: "agent_start" });
		ctx.handler({ type: "agent_end" });
		// switch_session resolved → restoring = false
		ctx.setRestoring(false);
		const before = Date.now();
		ctx.handler({ type: "message_start" });

		assert.equal(ctx.updates.length, 1, "exactly one update after restoring flips false");
		assert.ok(typeof ctx.updates[0].lastActivity === "number");
		assert.ok((ctx.updates[0].lastActivity as number) >= before);
		store.flush();
		const persisted = store.get("sess-1")!;
		assert.notEqual(persisted.lastActivity, ORIGINAL_TS);
		assert.ok(persisted.lastActivity >= before);
	});

	it("preserves lastActivity across reload after restore-only replay", () => {
		const store1 = freshStore();
		store1.put(makeSession());
		const ctx = makeRestoreHandler(store1, "sess-1");
		// Heavy replay — no flip
		for (let i = 0; i < 50; i++) ctx.handler({ type: "tool_use", i });
		store1.flush();

		// New store instance reads from disk
		const store2 = new SessionStore(stateDir);
		assert.equal(store2.get("sess-1")!.lastActivity, ORIGINAL_TS);
	});
});

// Source-level regression guard: the restoreSession event handler must keep
// its `if (!restoring)` gate around the `session.lastActivity = Date.now()`
// write. If a future refactor drops it, this test fails loudly.
describe("restoreSession source guard", () => {
	it("session-manager.ts contains the restoring gate", async () => {
		const src = fs.readFileSync(
			path.join(process.cwd(), "src/server/agent/session-manager.ts"),
			"utf-8",
		);
		// Find the rpcClient.onEvent callback inside restoreSession by anchoring on
		// the restoreStore variable which is unique to that scope.
		const idx = src.indexOf("const restoreStore = this.getSessionStore(ps.projectId);");
		assert.ok(idx > 0, "restoreStore declaration not found");
		const window = src.slice(idx, idx + 1500);
		assert.ok(
			/if\s*\(\s*!\s*restoring\s*\)\s*\{[^}]*session\.lastActivity\s*=\s*Date\.now\(\)/.test(window),
			"restoreSession's onEvent callback must gate lastActivity assignment behind !restoring",
		);
		assert.ok(
			/restoreStore\.update\(\s*ps\.id\s*,\s*\{\s*lastActivity:/.test(window),
			"restoreStore.update with lastActivity must still exist (gated)",
		);
	});
});
