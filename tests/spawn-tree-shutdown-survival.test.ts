/**
 * Pinning test: Layer 1 restart-survival contract for detached verification
 * command steps.
 *
 * Production sequence (`runCommandStep` → `shutdown()`):
 *   1. `tracked = spawnTracked(...)`
 *   2. `child.unref()`          — don't block graceful gateway exit
 *   3. `tracked.markSurvival()` — flag for `killAllTracked` to skip
 *   4. (gateway exit) → `killAllTracked("SIGKILL")` via `shutdown()`
 *   5. Child MUST still be alive for `_resumeCommandStep` on next boot.
 *
 * Before the fix (PR #576 as submitted), `killAllTracked` was
 * indiscriminate and killed every tracked child — including the ones
 * `unref()`'d + marked for survival. The fix adds `markSurvival()` to
 * the `TrackedChild` interface and teaches `killAllTracked` to skip
 * flagged entries.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

const { spawnTracked, killAllTracked, _trackedCount } =
	await import("../src/server/agent/spawn-tree.ts");

async function poll(predicate: () => boolean, budgetMs: number, stepMs = 50): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise(r => setTimeout(r, stepMs));
	}
	return predicate();
}

function isAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (err: any) { return err?.code === "EPERM"; }
}

/** Track pids spawned in the suite for after() cleanup. */
const spawnedPids: number[] = [];

describe("verification-harness shutdown — survival contract", () => {
	it("TrackedChild exposes markSurvival()", () => {
		const t = spawnTracked(
			process.execPath,
			["-e", "setTimeout(()=>{},100)"],
			{ stdio: "ignore" },
		);
		if (t.child.pid) spawnedPids.push(t.child.pid);
		assert.strictEqual(
			typeof t.markSurvival, "function",
			"TrackedChild must expose markSurvival() — Layer 1 restart-survival " +
			"relies on callers marking detached children so killAllTracked " +
			"skips them on shutdown.",
		);
	});

	it("killAllTracked skips survival-marked children", async () => {
		// Mirrors production: runCommandStep's useDetached path.
		const t = spawnTracked(
			process.execPath,
			["-e", "setInterval(()=>{}, 1000)"],
			{ stdio: "ignore" },
		);
		const pid = t.child.pid;
		assert.ok(pid && pid > 0, "spawn should produce a pid");
		spawnedPids.push(pid);

		// Production calls child.unref() then tracked.markSurvival().
		try { t.child.unref(); } catch { /* ignore */ }
		t.markSurvival();

		assert.ok(isAlive(pid), "child should be alive before shutdown");
		assert.ok(_trackedCount() >= 1, "child should be in registry");

		// Simulate VerificationHarness.shutdown().
		killAllTracked("SIGKILL");

		// The child must survive — _resumeCommandStep needs it on next boot.
		const wasKilled = await poll(() => !isAlive(pid), 2000);
		assert.strictEqual(
			wasKilled, false,
			"killAllTracked killed a survival-marked child. Layer 1 " +
			"restart-survival is broken: _resumeCommandStep will see a " +
			"dead pid and no exit file → step finalised as failed.",
		);
	});

	it("killAllTracked still kills NON-survival children", async () => {
		const t = spawnTracked(
			process.execPath,
			["-e", "setInterval(()=>{}, 1000)"],
			{ stdio: "ignore" },
		);
		const pid = t.child.pid!;
		spawnedPids.push(pid);

		// No markSurvival() — should be killed normally.
		killAllTracked("SIGKILL");
		await new Promise<void>((res) => t.child.once("close", () => res()));

		const dead = await poll(() => !isAlive(pid), 3000);
		assert.ok(dead, "non-survival child should be reaped by killAllTracked");
	});

	it("killAllTracked with includeSurvival=true kills everything", async () => {
		const t = spawnTracked(
			process.execPath,
			["-e", "setInterval(()=>{}, 1000)"],
			{ stdio: "ignore" },
		);
		const pid = t.child.pid!;
		spawnedPids.push(pid);
		t.markSurvival();

		killAllTracked("SIGKILL", true);
		await new Promise<void>((res) => t.child.once("close", () => res()));

		const dead = await poll(() => !isAlive(pid), 3000);
		assert.ok(dead, "includeSurvival=true should kill even survival-marked children");
	});
});

after(() => {
	// Force-kill everything including survival entries.
	try { killAllTracked("SIGKILL", true); } catch { /* best-effort */ }
	// Belt-and-braces: kill any pids we tracked explicitly.
	for (const pid of spawnedPids) {
		try { if (isAlive(pid)) process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
	}
});
