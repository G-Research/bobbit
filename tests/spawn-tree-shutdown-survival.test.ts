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

/** FD 3 is the POSIX sentinel's durable ownership acknowledgement. */
function waitForPosixSentinelReady(child: import("node:child_process").ChildProcess): Promise<void> {
	const ready = child.stdio[3];
	if (!ready) return Promise.reject(new Error("POSIX sentinel readiness pipe is missing"));
	return new Promise((resolve, reject) => {
		ready.once("data", () => resolve());
		ready.once("close", () => reject(new Error("POSIX sentinel closed before readiness")));
		ready.once("error", reject);
	});
}

/** Track pids spawned in the suite for after() cleanup. */
const spawnedPids: number[] = [];

function longRunningTracked() {
	const t = spawnTracked(
		process.execPath,
		["-e", "setInterval(()=>{}, 1000)"],
		{ stdio: ["ignore", "ignore", "ignore", "pipe"] },
	);
	assert.ok(t.child.pid && t.child.pid > 0, "spawn should produce a pid");
	spawnedPids.push(t.child.pid);
	return t;
}

async function establishSurvivalOwnership(t: ReturnType<typeof spawnTracked>): Promise<void> {
	// Windows spawnTracked owns the real Job before returning. POSIX must wait
	// for its sentinel to atomically publish ownership on FD 3.
	if (process.platform !== "win32") await waitForPosixSentinelReady(t.child);
	t.markSurvival();
}

describe("verification-harness shutdown — survival contract", () => {
	it("TrackedChild exposes markSurvival()", async () => {
		const t = longRunningTracked();
		assert.strictEqual(typeof t.markSurvival, "function");
		killAllTracked("SIGKILL", true);
		await waitForClose(t.child);
	});

	it("kills POSIX survival-marked children before sentinel readiness", async () => {
		if (process.platform === "win32") return;
		const t = longRunningTracked();
		t.markSurvival();
		killAllTracked("SIGKILL");
		await waitForClose(t.child);
		assert.equal(isAlive(t.child.pid), false, "handshake-pending survival child must be reaped");
	});

	it("keeps only ownership-established survival children during shutdown", async () => {
		const t = longRunningTracked();
		await establishSurvivalOwnership(t);
		assert.ok(isAlive(t.child.pid), "child should be alive before shutdown");
		killAllTracked("SIGKILL");
		assert.ok(_trackedCount() >= 1, "owned survival child must remain registered after ordinary shutdown");
		assert.ok(isAlive(t.child.pid), "owned survival child must remain alive after ordinary shutdown");
		killAllTracked("SIGKILL", true);
		await waitForClose(t.child);
		assert.equal(isAlive(t.child.pid), false, "includeSurvival must kill an owned survival child");
	});

	it("killAllTracked still kills non-survival children", async () => {
		const t = longRunningTracked();
		killAllTracked("SIGKILL");
		await waitForClose(t.child);
		assert.equal(isAlive(t.child.pid), false, "non-survival child should be reaped by shutdown");
	});
});

after(() => {
	try { killAllTracked("SIGKILL", true); } catch { /* best-effort */ }
	for (const pid of spawnedPids) {
		try { if (isAlive(pid)) process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
	}
});
