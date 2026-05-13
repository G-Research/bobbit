/**
 * Tree-kill on verification command-step timeout / cancellation.
 *
 * Pins the contract laid out in docs/design (Verification command-step
 * tree-kill v2): when a `command` verification step exceeds its timeout
 * or is cancelled, the entire spawned process tree must be reaped — not
 * just the immediate shell — and the step must resolve as failed with the
 * specified marker text.
 *
 * Cross-platform: every test runs on POSIX and Windows. Polling uses
 * `process.kill(pid, 0)` (cross-platform liveness check that maps to
 * the right OS primitive in Node) and `node -e ...` for spawned
 * payloads (avoids `bash` / `sleep` / `cmd` / `ping` shell-specific
 * fixtures).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-treekill-test-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });
process.env.BOBBIT_DIR = TEST_DIR;

const { VerificationHarness } = await import("../src/server/agent/verification-harness.ts");
const { spawnTracked, killAllTracked, _trackedCount } = await import("../src/server/agent/spawn-tree.ts");

/** Poll predicate with explicit budget. Returns true if satisfied within the budget. */
async function poll(predicate: () => boolean | Promise<boolean>, budgetMs: number, stepMs = 50): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise(r => setTimeout(r, stepMs));
	}
	return Boolean(await predicate());
}

/**
 * Cross-platform: is `pid` a live OS process?
 *
 * `process.kill(pid, 0)` sends signal 0 — a permission/existence check that
 * delivers no signal. Maps to OpenProcess+ExitCode on Windows, kill(pid, 0)
 * on POSIX. ESRCH = gone, EPERM = exists but we don't own it (count alive).
 */
function isAlive(pid: number): boolean {
	if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
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

/**
 * Build a portable shell command that runs node with a script file.
 * Cross-platform-safe because the path is quoted with double-quotes
 * which both `bash` and `cmd` honour. Avoids any inline `-e` escaping
 * headaches across shells.
 */
function nodeCmd(scriptPath: string): string {
	return `"${process.execPath}" "${scriptPath}"`;
}

/**
 * Write a node script that prints `PARENT_PID=<n>` then spawns a
 * child node process, prints `CHILD_PID=<n>`, and keeps both alive for
 * the requested duration. Used to verify that tree-kill reaps the
 * grandchild (which is the CHILD_PID), not just the shell.
 */
function writeTreeScript(dir: string, holdMs = 60_000): string {
	const file = path.join(dir, "tree.cjs");
	fs.writeFileSync(file, `
process.stdout.write("PARENT_PID=" + process.pid + "\\n");
const cp = require("child_process");
const c = cp.spawn(process.execPath, ["-e", "setTimeout(()=>{}, ${holdMs})"], { stdio: "ignore" });
process.stdout.write("CHILD_PID=" + c.pid + "\\n");
setTimeout(()=>{}, ${holdMs});
`);
	return file;
}

describe("spawn-tree helper", () => {
	it("times out, reports timedOut()=true, and reaps the child", async () => {
		const t = spawnTracked(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
			stdio: "ignore",
			timeoutMs: 200,
		});
		const childPid = t.child.pid!;
		await new Promise<void>((resolve) => t.child.once("close", () => resolve()));
		assert.strictEqual(t.timedOut(), true, "timedOut() should be true after timer fires");
		const dead = await poll(() => !isAlive(childPid), 3000);
		assert.ok(dead, `child pid ${childPid} should be reaped after close`);
	});

	it("killTree reaps the entire subprocess tree", async () => {
		// Outer node spawns inner node, prints both pids on stdout. We then call
		// killTree() and assert BOTH pids become unreachable.
		const tmp = fs.mkdtempSync(path.join(TEST_DIR, "tree-"));
		const script = writeTreeScript(tmp);
		let buf = "";
		const t = spawnTracked(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
		t.child.stdout!.on("data", (d: Buffer) => { buf += d.toString(); });

		// Wait until both pids are printed.
		const got = await poll(() => /PARENT_PID=(\d+)/.test(buf) && /CHILD_PID=(\d+)/.test(buf), 5000);
		assert.ok(got, `expected both pids on stdout; got: ${JSON.stringify(buf)}`);
		const parentPid = Number(/PARENT_PID=(\d+)/.exec(buf)![1]);
		const childPid = Number(/CHILD_PID=(\d+)/.exec(buf)![1]);
		assert.ok(isAlive(parentPid), "parent should be alive before kill");
		assert.ok(isAlive(childPid), "grandchild should be alive before kill");

		t.killTree("SIGKILL", 0);
		await new Promise<void>((resolve) => t.child.once("close", () => resolve()));

		const cleaned = await poll(() => !isAlive(parentPid) && !isAlive(childPid), 3000);
		assert.ok(cleaned, `both pids should be reaped; parent=${isAlive(parentPid)} child=${isAlive(childPid)}`);
	});

	it("killAllTracked reaps every tracked child", async () => {
		const children = [0, 1, 2].map(() =>
			spawnTracked(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" }),
		);
		const pids = children.map(c => c.child.pid!);
		assert.ok(_trackedCount() >= 3, `expected >=3 tracked, got ${_trackedCount()}`);
		killAllTracked("SIGKILL");
		await Promise.all(children.map(c => new Promise<void>((res) => c.child.once("close", () => res()))));
		const ok = await poll(() => pids.every(p => !isAlive(p)), 3000);
		assert.ok(ok, "all tracked children should be reaped within budget");
	});
});

describe("runCommandStep tree-kill", () => {
	it("kills the entire subprocess tree on step timeout and emits the marker", async () => {
		const harness = makeHarness();
		const tmp = fs.mkdtempSync(path.join(TEST_DIR, "rcs-timeout-"));
		const script = writeTreeScript(tmp);

		// No streamCtx → attached pipe mode on all platforms; output is captured
		// directly into result.output, where we can grep for PARENT_PID/CHILD_PID.
		const result = await (harness as any).runCommandStep(
			nodeCmd(script), tmp, 2, false, undefined, undefined, undefined,
		);
		assert.strictEqual(result.passed, false, `expected failed step, got: ${JSON.stringify(result)}`);
		assert.ok(
			/timed out after 2s\s+\u2014\s+killed subprocess tree/.test(result.output),
			`expected timeout marker, got: ${result.output}`,
		);

		const parentMatch = /PARENT_PID=(\d+)/.exec(result.output);
		const childMatch = /CHILD_PID=(\d+)/.exec(result.output);
		assert.ok(parentMatch, `output missing PARENT_PID: ${result.output}`);
		assert.ok(childMatch, `output missing CHILD_PID: ${result.output}`);
		const parentPid = Number(parentMatch![1]);
		const childPid = Number(childMatch![1]);

		const dead = await poll(() => !isAlive(parentPid) && !isAlive(childPid), 5000);
		assert.ok(dead, `descendants should be reaped after timeout; parent=${isAlive(parentPid)} child=${isAlive(childPid)}`);
	});

	it("cancellation tree-kills the subprocess and emits the cancelled marker", async () => {
		const harness = makeHarness();
		const tmp = fs.mkdtempSync(path.join(TEST_DIR, "rcs-cancel-"));
		const script = writeTreeScript(tmp);

		const goalId = "goal-cancel";
		const gateId = "gate-cancel";
		const signalId = "sig-cancel-1";
		const streamCtx = { goalId, gateId, signalId, stepIndex: 0 };
		// Seed activeVerification so the persisted-step write path is happy
		// and so the cancellation lookup hits this signalId.
		(harness as any).activeVerifications.set(signalId, {
			goalId, gateId, signalId,
			overallStatus: "running",
			startedAt: Date.now(),
			currentPhase: 0,
			steps: [{ name: "step", type: "command", status: "running", startedAt: Date.now() }],
		});

		// Kick off the long-running step. Captures stdout into step.output via
		// the broadcastFn path or via the detached-mode tail.
		const stepPromise = (harness as any).runCommandStep(
			nodeCmd(script), tmp, 60, false, streamCtx, undefined, undefined,
		);

		// Wait until the tracked child is registered AND the script has printed
		// both pids so we have something to assert against.
		const registered = await poll(() => (harness as any)._trackedCommandChildren.size > 0, 3000);
		assert.ok(registered, "tracked child should be registered shortly after spawn");

		const pidsReady = await poll(() => {
			const av = (harness as any).activeVerifications.get(signalId);
			const out = av?.steps?.[0]?.output ?? "";
			return /PARENT_PID=\d+/.test(out) && /CHILD_PID=\d+/.test(out);
		}, 6000);
		assert.ok(pidsReady, "script should have printed both pids before cancel");
		const av = (harness as any).activeVerifications.get(signalId);
		const out = av.steps[0].output as string;
		const parentPid = Number(/PARENT_PID=(\d+)/.exec(out)![1]);
		const childPid = Number(/CHILD_PID=(\d+)/.exec(out)![1]);

		await harness.cancelStaleVerifications(goalId, gateId);

		// Tree should be reaped within ~1s (SIGTERM grace 1000ms → SIGKILL on POSIX;
		// taskkill /T /F is unconditional on Windows).
		const dead = await poll(() => !isAlive(parentPid) && !isAlive(childPid), 3000);
		assert.ok(dead, `tree should be reaped within budget; parent=${isAlive(parentPid)} child=${isAlive(childPid)}`);

		const result = await stepPromise;
		assert.strictEqual(result.passed, false);
		assert.ok(
			/cancelled\s+\u2014\s+killed subprocess tree/.test(result.output),
			`expected cancellation marker, got: ${result.output}`,
		);
	});
});

after(() => {
	try { killAllTracked("SIGKILL"); } catch {}
	try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});
