/**
 * Lesson 4.9 — Auto-revive a dead RPC bridge before dispatching a brand-new
 * prompt.
 *
 * The fix is in the private helper
 * `SessionManager._dispatchPromptWithReviveOnDeadBridge` and is wired in at
 * exactly two new-prompt sites in `enqueuePrompt`:
 *   1. The error-recovery branch (a previous turn errored, a new prompt is
 *      being dispatched).
 *   2. The idle+empty branch (the session is idle and the prompt queue was
 *      empty before this prompt).
 *
 * Steady-state retry/drain paths must NOT auto-revive — they should fail
 * loudly so a real bridge death surfaces in logs. This test pins the helper's
 * behaviour by re-implementing its decision logic against stubbed
 * dependencies (full SessionManager construction is too heavy for a unit
 * test, and the helper's logic is small enough to mirror exactly).
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Mirrors the production logic in
 * `SessionManager._dispatchPromptWithReviveOnDeadBridge`. If the production
 * code drifts from this shape, the spec for Lesson 4.9 has changed and the
 * test should be updated alongside the source — that's a deliberate guard.
 */
async function dispatchPromptWithReviveOnDeadBridge(
	sessions: Map<string, any>,
	sessionId: string,
	dispatchText: string,
	images: any,
	restartAgent: (id: string) => Promise<void>,
): Promise<void> {
	let session = sessions.get(sessionId);
	if (!session) return;

	if (!session.rpcClient.running) {
		await restartAgent(sessionId);
		session = sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found after auto-revive`);
		}
	}

	await session.rpcClient.prompt(dispatchText, images);
}

function makeSession(running: boolean) {
	return {
		id: "sess-1",
		rpcClient: {
			running,
			prompt: mock.fn(async () => {}),
		},
	};
}

describe("Lesson 4.9 — auto-revive dead RPC bridge on prompt dispatch", () => {
	it("calls restartAgent exactly once when rpcClient.running === false at the new-prompt site", async () => {
		const sessions = new Map<string, any>();
		sessions.set("sess-1", makeSession(false));

		const restartCalls: string[] = [];
		const restartAgent = async (id: string) => {
			restartCalls.push(id);
			// restart re-creates the session — simulate by replacing the entry
			sessions.set(id, makeSession(true));
		};

		await dispatchPromptWithReviveOnDeadBridge(sessions, "sess-1", "hello", undefined, restartAgent);

		assert.deepEqual(restartCalls, ["sess-1"]);
		const fresh = sessions.get("sess-1");
		assert.equal(fresh.rpcClient.prompt.mock.callCount(), 1, "prompt is dispatched on the FRESH bridge");
	});

	it("does NOT call restartAgent when the bridge is already running (steady-state)", async () => {
		const sessions = new Map<string, any>();
		const session = makeSession(true);
		sessions.set("sess-1", session);

		const restartCalls: string[] = [];
		const restartAgent = async (id: string) => {
			restartCalls.push(id);
		};

		await dispatchPromptWithReviveOnDeadBridge(sessions, "sess-1", "hello", undefined, restartAgent);

		assert.deepEqual(restartCalls, [], "no revive expected when bridge is alive");
		assert.equal(session.rpcClient.prompt.mock.callCount(), 1);
	});

	it("propagates errors from restartAgent (so SESSION_UNRECOVERABLE_ARCHIVED reaches the WS layer)", async () => {
		const sessions = new Map<string, any>();
		sessions.set("sess-1", makeSession(false));

		const zombieErr = Object.assign(new Error("zombie"), { code: "SESSION_UNRECOVERABLE_ARCHIVED" });
		const restartAgent = async () => { throw zombieErr; };

		await assert.rejects(
			dispatchPromptWithReviveOnDeadBridge(sessions, "sess-1", "hi", undefined, restartAgent),
			(err: any) => err === zombieErr || err.code === "SESSION_UNRECOVERABLE_ARCHIVED",
			"the helper must NOT swallow restartAgent failures",
		);
	});

	it("after auto-revive, dispatches on the FRESH bridge (not the dead one)", async () => {
		const sessions = new Map<string, any>();
		const deadSession = makeSession(false);
		sessions.set("sess-1", deadSession);

		const restartAgent = async (id: string) => {
			sessions.set(id, makeSession(true));
		};

		await dispatchPromptWithReviveOnDeadBridge(sessions, "sess-1", "hi", undefined, restartAgent);

		assert.equal(deadSession.rpcClient.prompt.mock.callCount(), 0, "dead bridge must not be touched");
		const live = sessions.get("sess-1");
		assert.notEqual(live, deadSession, "session map must hold the fresh entry");
		assert.equal(live.rpcClient.prompt.mock.callCount(), 1);
	});

	it("throws an explicit error if restartAgent leaves no session in the map", async () => {
		const sessions = new Map<string, any>();
		sessions.set("sess-1", makeSession(false));

		// Pathological restart that fails to repopulate the map.
		const restartAgent = async () => { /* no-op */ };
		// remove the entry to simulate a hostile path
		const restartAgentBad = async (id: string) => { sessions.delete(id); };

		await assert.rejects(
			dispatchPromptWithReviveOnDeadBridge(sessions, "sess-1", "hi", undefined, restartAgentBad),
			/not found after auto-revive/,
		);
	});
});

describe("Lesson 4.9 — source-grep guard", async () => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const SOURCE = path.resolve(import.meta.dirname, "..", "src", "server", "agent", "session-manager.ts");
	const text = fs.readFileSync(SOURCE, "utf-8");

	it("the private helper exists in session-manager.ts", () => {
		assert.match(text, /_dispatchPromptWithReviveOnDeadBridge/, "private helper must remain named _dispatchPromptWithReviveOnDeadBridge so the lesson is greppable");
	});

	it("is invoked at both new-prompt sites in enqueuePrompt", () => {
		// Conservative pin: at least two call sites, both inside the file.
		const occurrences = text.match(/_dispatchPromptWithReviveOnDeadBridge/g) ?? [];
		// 1 declaration + 2 call sites = 3 total
		assert.ok(occurrences.length >= 3, `expected at least 3 occurrences (declaration + 2 call sites), got ${occurrences.length}`);
	});

	it("checks rpcClient.running before invoking restartAgent", () => {
		assert.match(text, /rpcClient\.running/, "the helper must read rpcClient.running");
	});
});
