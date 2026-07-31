/**
 * Pinning test: detached verification commands survive shutdown only after the
 * platform ownership barrier is established (POSIX sentinel FD 3; Windows Job).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

const { spawnTracked, killAllTracked, _trackedCount } =
	await import("../src/server/agent/spawn-tree.ts");

function isAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (err: any) { return err?.code === "EPERM"; }
}

function waitForClose(child: import("node:child_process").ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once("close", () => resolve());
		child.once("error", reject);
	});
}

/** Track pids spawned in the suite for after() cleanup. */
const spawnedPids: number[] = [];

type SpawnLifecycle = {
	t: ReturnType<typeof spawnTracked>;
	ready: Promise<void>;
	closed: Promise<void>;
};

function longRunningTracked(): SpawnLifecycle {
	const t = spawnTracked(
		process.execPath,
		["-e", "setInterval(()=>{}, 1000)"],
		// POSIX injects its FD3 pipe itself. Passing an array with FD3 would
		// become an unnecessary inherited FD4 in the payload.
		{ stdio: "ignore" },
	);
	assert.ok(t.child.pid && t.child.pid > 0, "spawn should produce a pid");
	spawnedPids.push(t.child.pid);
	// Both events can happen before a caller gets to its first await. Register
	// the lifecycle settlement pairs immediately after every real spawn.
	const closed = waitForClose(t.child);
	const ready = t.ownershipReady;
	// Expected pre-ownership reaping closes FD3 without a data acknowledgement.
	// Observe the rejection now so it never becomes an unhandled promise.
	void ready.catch(() => {});
	return { t, ready, closed };
}

async function establishSurvivalOwnership(lifecycle: SpawnLifecycle): Promise<void> {
	// Windows spawnTracked owns the real Job before returning. POSIX must wait
	// for its sentinel to atomically publish ownership on FD 3.
	await lifecycle.ready;
	lifecycle.t.markSurvival();
}

describe("verification-harness shutdown — survival contract", () => {
	it("TrackedChild exposes markSurvival()", async () => {
		const lifecycle = longRunningTracked();
		assert.strictEqual(typeof lifecycle.t.markSurvival, "function");
		killAllTracked("SIGKILL", true);
		await lifecycle.closed;
	});

	it("kills POSIX survival-marked children before sentinel readiness", async () => {
		if (process.platform === "win32") return;
		const lifecycle = longRunningTracked();
		lifecycle.t.markSurvival();
		killAllTracked("SIGKILL");
		await lifecycle.closed;
		await assert.rejects(lifecycle.ready);
		assert.equal(isAlive(lifecycle.t.child.pid), false, "handshake-pending survival child must be reaped");
	});

	it("keeps only ownership-established survival children during shutdown", async () => {
		const lifecycle = longRunningTracked();
		await establishSurvivalOwnership(lifecycle);
		assert.ok(isAlive(lifecycle.t.child.pid), "child should be alive before shutdown");
		killAllTracked("SIGKILL");
		assert.ok(_trackedCount() >= 1, "owned survival child must remain registered after ordinary shutdown");
		assert.ok(isAlive(lifecycle.t.child.pid), "owned survival child must remain alive after ordinary shutdown");
		killAllTracked("SIGKILL", true);
		await lifecycle.closed;
		assert.equal(isAlive(lifecycle.t.child.pid), false, "includeSurvival must kill an owned survival child");
	});

	it("killAllTracked still kills non-survival children", async () => {
		const lifecycle = longRunningTracked();
		killAllTracked("SIGKILL");
		await lifecycle.closed;
		if (process.platform !== "win32") await assert.rejects(lifecycle.ready);
		assert.equal(isAlive(lifecycle.t.child.pid), false, "non-survival child should be reaped by shutdown");
	});
});

after(() => {
	try { killAllTracked("SIGKILL", true); } catch { /* best-effort */ }
	for (const pid of spawnedPids) {
		try { if (isAlive(pid)) process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
	}
});
