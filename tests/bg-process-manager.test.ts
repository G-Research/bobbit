/**
 * Unit tests for BgProcessManager.waitForExit — abort-signal behaviour.
 *
 * Spawns real short-running child processes via the public `create()` API
 * (so all the listeners & broadcast plumbing is exercised) and exercises
 * the new AbortController path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import { BgProcessManager } from "../src/server/agent/bg-process-manager.ts";

const SESSION = "sess-bg-test";
// Use a command that works on both POSIX + Windows shells. getShellConfig picks
// cmd.exe on win32 so `ping` works; on POSIX the default shell runs `sleep`.
const SLEEP_CMD = process.platform === "win32"
	? "ping -n 30 127.0.0.1 >NUL"
	: "sleep 30";

function makeManager(): BgProcessManager {
	// clientsProvider returns undefined — no websocket broadcast side effects.
	return new BgProcessManager(() => undefined);
}

describe("BgProcessManager.waitForExit — AbortSignal", () => {
	it("abort before exit resolves with aborted:true and leaves process running", async () => {
		const mgr = makeManager();
		const info = mgr.create(SESSION, SLEEP_CMD, os.tmpdir());
		assert.equal(info.status, "running");

		const controller = new AbortController();
		mgr.registerWait(SESSION, controller);

		const start = Date.now();
		const waitPromise = mgr.waitForExit(SESSION, info.id, 10_000, controller.signal);
		// Abort on the next tick.
		setImmediate(() => mgr.abortAllWaits(SESSION));
		const result = await waitPromise;
		const elapsed = Date.now() - start;
		mgr.unregisterWait(SESSION, controller);

		assert.ok(result, "result should not be null");
		assert.equal(result!.aborted, true);
		assert.equal(result!.timedOut, false);
		assert.equal(result!.info.status, "running", "process must still be running after abort");
		assert.ok(elapsed < 500, `abort should resolve quickly, was ${elapsed}ms`);

		// Process is still alive — verify via list.
		const still = mgr.list(SESSION).find(p => p.id === info.id);
		assert.ok(still, "process should still be tracked");
		assert.equal(still!.status, "running");

		// Cleanup — kill the bg process so the test doesn't leak.
		mgr.cleanup(SESSION);
	});

	it("abort after exit is a no-op (exit wins)", async () => {
		const mgr = makeManager();
		const cmd = process.platform === "win32" ? "cmd /c exit 0" : "true";
		const info = mgr.create(SESSION, cmd, os.tmpdir());

		// Wait until it exits.
		await new Promise((resolve) => setTimeout(resolve, 100));

		const controller = new AbortController();
		const result = await mgr.waitForExit(SESSION, info.id, 1000, controller.signal);
		// Process already exited — should short-circuit with aborted:false.
		assert.ok(result);
		assert.equal(result!.timedOut, false);
		assert.equal(result!.aborted, false);
		assert.equal(result!.info.status, "exited");

		// Firing abort now should not produce an extra resolution or throw.
		controller.abort();
		mgr.cleanup(SESSION);
	});

	it("abort after timeout is a no-op (timeout already settled)", async () => {
		const mgr = makeManager();
		const info = mgr.create(SESSION, SLEEP_CMD, os.tmpdir());

		const controller = new AbortController();
		mgr.registerWait(SESSION, controller);

		const result = await mgr.waitForExit(SESSION, info.id, 50, controller.signal);
		assert.ok(result);
		assert.equal(result!.timedOut, true);
		assert.equal(result!.aborted, false);

		// Abort after the fact — must be a no-op, no extra resolution or listener leak.
		controller.abort();
		// Give listeners a tick to fire if incorrectly still attached.
		await new Promise((r) => setTimeout(r, 20));

		mgr.unregisterWait(SESSION, controller);
		mgr.cleanup(SESSION);
	});

	it("multiple concurrent waits all abort on abortAllWaits()", async () => {
		const mgr = makeManager();
		const info = mgr.create(SESSION, SLEEP_CMD, os.tmpdir());

		const c1 = new AbortController();
		const c2 = new AbortController();
		const c3 = new AbortController();
		mgr.registerWait(SESSION, c1);
		mgr.registerWait(SESSION, c2);
		mgr.registerWait(SESSION, c3);

		const p1 = mgr.waitForExit(SESSION, info.id, 10_000, c1.signal);
		const p2 = mgr.waitForExit(SESSION, info.id, 10_000, c2.signal);
		const p3 = mgr.waitForExit(SESSION, info.id, 10_000, c3.signal);

		setImmediate(() => mgr.abortAllWaits(SESSION));
		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

		for (const r of [r1, r2, r3]) {
			assert.ok(r);
			assert.equal(r!.aborted, true);
			assert.equal(r!.info.status, "running");
		}

		mgr.unregisterWait(SESSION, c1);
		mgr.unregisterWait(SESSION, c2);
		mgr.unregisterWait(SESSION, c3);
		mgr.cleanup(SESSION);
	});

	it("cleanup() aborts in-flight waits so HTTP handlers resolve", async () => {
		const mgr = makeManager();
		const info = mgr.create(SESSION, SLEEP_CMD, os.tmpdir());

		const controller = new AbortController();
		mgr.registerWait(SESSION, controller);
		const waitPromise = mgr.waitForExit(SESSION, info.id, 10_000, controller.signal);

		// Terminate path calls cleanup, which must abort waits.
		mgr.cleanup(SESSION);

		const result = await waitPromise;
		assert.ok(result);
		// Either aborted (abort fired first) or exit (cleanup's SIGTERM fired first)
		// is acceptable — the important thing is that the wait resolves quickly.
		assert.ok(result!.aborted || result!.info.status === "exited");
	});
});
