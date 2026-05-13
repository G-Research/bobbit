/**
 * Tree-kill on verification command-step timeout / cancellation.
 *
 * Pins the contract laid out in docs/design (Verification command-step
 * tree-kill v2): when a `command` verification step exceeds its timeout
 * or is cancelled, the entire spawned process tree must be reaped — not
 * just the immediate shell — and the step must resolve as failed with the
 * specified marker text.
 *
 * Coverage:
 *   1. Tree-kill on timeout (POSIX): descendant `sleep` is dead after
 *      step settle.
 *   2. Cancellation kills the tree (POSIX): cancelStaleVerifications
 *      reaps the pgid within ~1s.
 *   3. Tree-kill on timeout (Windows): tasklist shows the child gone.
 *   4. Helper-direct: spawnTracked timeout flips timedOut() and reaps
 *      the child.
 *   5. Helper-direct: killAllTracked reaps every tracked child.
 *   6. SIGKILL escalation: killGraceMs honoured.
 *
 * All polling uses explicit budgets, never fixed sleeps.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-treekill-test-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });
process.env.BOBBIT_DIR = TEST_DIR;

const { VerificationHarness } = await import("../src/server/agent/verification-harness.ts");
const { spawnTracked, killAllTracked, _trackedCount } = await import("../src/server/agent/spawn-tree.ts");

const IS_POSIX = process.platform !== "win32";

/** Poll predicate with explicit budget. Returns true if satisfied. */
async function poll(predicate: () => boolean | Promise<boolean>, budgetMs: number, stepMs = 50): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise(r => setTimeout(r, stepMs));
	}
	return predicate() as any;
}

/** Cross-platform: is `pid` a live OS process? */
function isAlive(pid: number): boolean {
	if (!pid) return false;
	try { process.kill(pid, 0); return true; }
	catch (err: any) { return err?.code === "EPERM"; }
}

/** Minimal stubs for a bare-bones VerificationHarness. */
function makeHarness() {
	const stateDir = fs.mkdtempSync(path.join(TEST_DIR, "harness-"));
	fs.mkdirSync(stateDir, { recursive: true });
	const stubGateStore = {
		updateSignalVerification: () => {},
		updateGateStatus: () => {},
		getGate: () => undefined,
	} as any;
	const roleStore = { get: () => undefined, getAll: () => [] } as any;
	return new VerificationHarness(
		stateDir,
		stubGateStore,
		() => {},
		roleStore,
		undefined, undefined, undefined, undefined, undefined, undefined,
	);
}

describe("spawn-tree helper", () => {
	it("times out and reports timedOut()=true (POSIX)", { skip: !IS_POSIX }, async () => {
		const t = spawnTracked("bash", ["-c", "sleep 30"], {
			stdio: "ignore",
			timeoutMs: 200,
		});
		const childPid = t.child.pid!;
		// Wait for close.
		await new Promise<void>((resolve) => t.child.once("close", () => resolve()));
		assert.strictEqual(t.timedOut(), true, "timedOut() should be true after timer fires");
		// Process should be reaped (we already got close).
		assert.strictEqual(isAlive(childPid), false, "child pid should be reaped after close");
	});

	it("SIGKILL escalation honours killGraceMs (POSIX)", { skip: !IS_POSIX }, async () => {
		// Trap SIGTERM in the child so SIGTERM alone won't kill it; require SIGKILL escalation.
		const t = spawnTracked("bash", ["-c", "trap '' TERM; sleep 30"], {
			stdio: "ignore",
			timeoutMs: 100,
			killGraceMs: 200,
		});
		const childPid = t.child.pid!;
		const start = Date.now();
		await new Promise<void>((resolve) => t.child.once("close", () => resolve()));
		const elapsed = Date.now() - start;
		assert.ok(elapsed >= 100, `should not close before timeout fires; got ${elapsed}ms`);
		assert.ok(elapsed < 5000, `SIGKILL escalation should reap within budget; got ${elapsed}ms`);
		assert.strictEqual(isAlive(childPid), false);
	});

	it("killAllTracked reaps every tracked child (POSIX)", { skip: !IS_POSIX }, async () => {
		const children = [0, 1, 2].map(() => spawnTracked("bash", ["-c", "sleep 30"], { stdio: "ignore" }));
		const pids = children.map(c => c.child.pid!);
		const baselineTracked = _trackedCount();
		assert.ok(baselineTracked >= 3, `expected >=3 tracked, got ${baselineTracked}`);
		killAllTracked("SIGKILL");
		await Promise.all(children.map(c => new Promise<void>((res) => c.child.once("close", () => res()))));
		const ok = await poll(() => pids.every(p => !isAlive(p)), 2000);
		assert.ok(ok, "all tracked children should be reaped within 2s");
	});

	it("tree-kill via taskkill (Windows)", { skip: IS_POSIX }, async () => {
		// `ping -n 60 127.0.0.1` blocks for 60s; spawned via cmd /c.
		const t = spawnTracked("cmd", ["/c", "ping -n 60 127.0.0.1 >NUL"], {
			stdio: "ignore",
			timeoutMs: 300,
			windowsHide: true,
		});
		const pid = t.child.pid!;
		await new Promise<void>((resolve) => t.child.once("close", () => resolve()));
		assert.strictEqual(t.timedOut(), true);
		// tasklist should not list this pid anymore.
		const ok = await poll(() => {
			try {
				const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: "utf8" });
				return !out.includes(String(pid));
			} catch { return true; }
		}, 5000);
		assert.ok(ok, "Windows process should be gone after tree-kill");
	});
});

describe("runCommandStep tree-kill on timeout (POSIX)", () => {
	it("kills grandchild on step timeout", { skip: !IS_POSIX }, async () => {
		const harness = makeHarness();
		const tmpDir = fs.mkdtempSync(path.join(TEST_DIR, "gc-"));
		const gcPidFile = path.join(tmpDir, "gc.pid");
		// Outer bash spawns inner bash sleep 60 as a background descendant
		// and `wait`s — so the timeout has to reach the grandchild.
		const cmd = `bash -c 'sleep 60 & echo $! > ${gcPidFile}; wait'`;

		const streamCtx = { goalId: "g1", gateId: "gate1", signalId: "sig-timeout-1", stepIndex: 0 };
		// Seed activeVerification entry so the persisted-step write doesn't blow up.
		(harness as any).activeVerifications.set(streamCtx.signalId, {
			goalId: streamCtx.goalId,
			gateId: streamCtx.gateId,
			signalId: streamCtx.signalId,
			overallStatus: "running",
			startedAt: Date.now(),
			currentPhase: 0,
			steps: [{ name: "step", type: "command", status: "running", startedAt: Date.now() }],
		});

		const result = await (harness as any).runCommandStep(cmd, tmpDir, 2, false, streamCtx, undefined, undefined);
		assert.strictEqual(result.passed, false, `expected failed step, got: ${JSON.stringify(result)}`);
		assert.ok(
			/timed out after 2s\s+\u2014\s+killed subprocess tree/.test(result.output),
			`expected timeout marker, got: ${result.output}`,
		);

		// Grandchild pid should be unreachable (ESRCH) within 3s of settle.
		await poll(() => fs.existsSync(gcPidFile), 1000);
		const gcPid = parseInt(fs.readFileSync(gcPidFile, "utf8").trim(), 10);
		assert.ok(Number.isFinite(gcPid) && gcPid > 0, `bad grandchild pid: ${gcPid}`);
		const dead = await poll(() => !isAlive(gcPid), 3000);
		assert.ok(dead, `grandchild pid ${gcPid} should be dead within 3s of step settle`);
	});

	it("cancellation tree-kills the subprocess and reports cancelled marker (POSIX)", { skip: !IS_POSIX }, async () => {
		const harness = makeHarness();
		const tmpDir = fs.mkdtempSync(path.join(TEST_DIR, "cancel-"));
		const gcPidFile = path.join(tmpDir, "gc.pid");
		const cmd = `bash -c 'sleep 60 & echo $! > ${gcPidFile}; wait'`;

		const goalId = "goal-cancel";
		const gateId = "gate-cancel";
		const signalId = "sig-cancel-1";
		const streamCtx = { goalId, gateId, signalId, stepIndex: 0 };
		(harness as any).activeVerifications.set(signalId, {
			goalId,
			gateId,
			signalId,
			overallStatus: "running",
			startedAt: Date.now(),
			currentPhase: 0,
			steps: [{ name: "step", type: "command", status: "running", startedAt: Date.now() }],
		});

		// Kick off the long-running step.
		const stepPromise = (harness as any).runCommandStep(cmd, tmpDir, 60, false, streamCtx, undefined, undefined);

		// Wait until the tracked child is registered.
		const registered = await poll(() => (harness as any)._trackedCommandChildren.size > 0, 2000);
		assert.ok(registered, "tracked child should be registered shortly after spawn");

		// Wait for the grandchild pid file to appear so we have a target to verify.
		await poll(() => fs.existsSync(gcPidFile), 2000);
		const gcPid = parseInt(fs.readFileSync(gcPidFile, "utf8").trim(), 10);
		assert.ok(Number.isFinite(gcPid) && gcPid > 0);

		await harness.cancelStaleVerifications(goalId, gateId);

		// pgid should be dead within ~1s (SIGTERM grace=1000 → SIGKILL).
		const dead = await poll(() => !isAlive(gcPid), 2500);
		assert.ok(dead, `grandchild pid ${gcPid} should die within ~1s of cancel`);

		const result = await stepPromise;
		assert.strictEqual(result.passed, false);
		assert.ok(
			/cancelled\s+\u2014\s+killed subprocess tree/.test(result.output),
			`expected cancellation marker, got: ${result.output}`,
		);
	});
});

after(() => {
	// Sweep any leftover trackers so subsequent test files start clean.
	try { killAllTracked("SIGKILL"); } catch {}
	try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});
