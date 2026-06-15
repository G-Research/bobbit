/**
 * WP9 / S8 — forceAbort force-kills at the grace period, not at the 30s ack timeout.
 *
 * On master, forceAbort did `await session.rpcClient.abort()` BEFORE awaiting the
 * grace-timer race, so a wedged bridge (abort() blocked on the 30s sendCommand
 * timeout, no agent_end) delayed the force-kill to ~30s — Stop appeared to do
 * nothing. The fix fires abort() un-awaited and races it against gracePeriodMs.
 * Here abort() never resolves and no agent_end is emitted; forceAbort must still
 * force-kill (stop()) within ~gracePeriodMs. RED on master (would take ~30s).
 */
import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";

const tmpRoot = makeTmpDir("force-abort-grace-test-");
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { PromptQueue } = await import("../src/server/agent/prompt-queue.ts");
const { EventBuffer } = await import("../src/server/agent/event-buffer.ts");
const { registerRpcBridgeFactory } = await import("../src/server/agent/rpc-bridge.ts");

const managers: any[] = [];
afterEach(() => {
	registerRpcBridgeFactory(null);
	while (managers.length > 0) {
		const m = managers.pop();
		if (m._statusHeartbeatTimer) clearInterval(m._statusHeartbeatTimer);
		m.sessions?.clear();
	}
});

describe("SessionManager.forceAbort grace race (S8)", () => {
	it("force-kills within the grace period when abort() hangs and no agent_end arrives", async () => {
		// Respawn must not spawn a real process — a throwing factory is caught by
		// forceAbort's restart try/catch (status → "terminated").
		registerRpcBridgeFactory(() => { throw new Error("no respawn in test"); });

		const manager: any = new SessionManager();
		manager._testStore = { update: mock.fn(() => {}), get: mock.fn(() => undefined) };
		managers.push(manager);

		const stop = mock.fn(async () => {});
		const abortStarted = mock.fn();
		const session: any = {
			id: "s-wedged",
			title: "Wedged",
			titleGenerated: true,
			cwd: tmpRoot,
			status: "streaming",
			statusVersion: 1,
			streamingStartedAt: Date.now(),
			createdAt: Date.now(),
			lastActivity: Date.now(),
			clients: new Set([{ readyState: 1, send: () => {} }]),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			inFlightSteerTexts: [],
			unsubscribe: () => {},
			rpcClient: {
				abort: () => { abortStarted(); return new Promise<void>(() => {}); }, // never resolves
				onEvent: () => () => {}, // never emits agent_end
				getState: async () => ({ success: false }),
				stop,
			},
		};
		manager.sessions.set(session.id, session);

		const GRACE = 80;
		const t0 = Date.now();
		await manager.forceAbort(session.id, GRACE);
		const elapsed = Date.now() - t0;

		assert.equal(abortStarted.mock.callCount(), 1, "graceful abort() was attempted");
		assert.equal(stop.mock.callCount(), 1, "force-kill stop() was called (didn't hang on abort)");
		assert.ok(elapsed < 5000, `forceAbort resolved promptly (${elapsed}ms), not at the ~30s ack timeout`);
		assert.ok(elapsed >= GRACE - 20, `did not force-kill before the grace period (${elapsed}ms)`);
	});

	it("cancels a pending auto-retry timer even when not streaming (S40)", async () => {
		const manager: any = new SessionManager();
		manager._testStore = { update: mock.fn(() => {}), get: mock.fn(() => undefined) };
		managers.push(manager);

		const cancel = mock.fn();
		const session: any = {
			id: "s-backoff",
			status: "idle", // post-error backoff — NOT streaming
			statusVersion: 1,
			clients: new Set(),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			pendingAutoRetryTimer: setTimeout(() => {}, 60_000),
		};
		manager.sessions.set(session.id, session);
		// Spy cancelPendingAutoRetry to confirm forceAbort calls it before the
		// not-streaming early-return.
		const orig = manager.cancelPendingAutoRetry.bind(manager);
		manager.cancelPendingAutoRetry = (s: any, reason: any) => { cancel(reason); return orig(s, reason); };

		await manager.forceAbort(session.id, 50);

		assert.equal(cancel.mock.callCount(), 1, "forceAbort cancels the pending auto-retry timer");
		assert.equal(session.pendingAutoRetryTimer, undefined, "timer was cleared");
	});
});
