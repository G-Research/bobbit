/**
 * Tree-kill on verification command-step timeout / cancellation.
 *
 * Pins the contract laid out in docs/design (Verification command-step
 * tree-kill v2): when a `command` verification step exceeds its timeout
 * or is cancelled, the entire spawned process tree must be reaped — not
 * just the immediate shell — and the step must resolve as failed with
 * the specified marker text.
 *
 * Every test runs on POSIX *and* Windows. The fixtures rely only on:
 *   - `process.execPath` to invoke Node from itself.
 *   - inline `node -e "<js>"` payloads (no bash, no cmd builtins, no
 *     temp script files).
 *   - `process.kill(pid, 0)` for liveness — maps to ESRCH/EPERM via
 *     OpenProcess+ExitCode on Windows and kill(pid,0) on POSIX.
 *
 * There are no `process.platform` skip guards anywhere.
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
const { spawnTracked, killAllTracked, killTreeByPid, _trackedCount } = await import("../src/server/agent/spawn-tree.ts");

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
 * delivers no signal. Node maps this to OpenProcess+ExitCode on Windows and
 * kill(pid, 0) on POSIX. ESRCH = gone, EPERM = alive but we don't own it.
 */
function isAlive(pid: number): boolean {
	if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (err: any) { return err?.code === "EPERM"; }
}

async function withTimeout<T>(promise: Promise<T>, budgetMs: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} within ${budgetMs}ms`)), budgetMs);
				timer.unref();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function killPidBestEffort(pid: number): void {
	if (!pid || !isAlive(pid)) return;
	try { killTreeByPid(pid, "SIGKILL"); } catch { /* best-effort */ }
	try { process.kill(pid, "SIGKILL"); } catch { /* best-effort */ }
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
 * Inline JS payload (passed via `node -e`) that:
 *   - prints `PARENT_PID=<pid>`
 *   - spawns an inner `node -e` child that prints `CHILD_PID=<pid>` and idles
 *   - pipes the inner stdout through so the parent's stdout carries both
 *   - idles forever (the test kills the parent via tree-kill)
 *
 * Works identically on POSIX and Windows.
 */
// Inner script: print CHILD_PID then idle. The child writes through its own
// piped stdout, which the parent forwards onto its own stdout. We wait for
// the first chunk before printing PARENT_PID so the test always sees both
// pids together (no timing window where only PARENT_PID is visible).
// Three-level escaping (this TS source → outer node -e → inner node -e).
// To get a real newline written by the innermost script, the inner-
// inner JS source string must contain the literal sequence `\n` (two
// chars). The outer payload is itself a JS string, so we double again
// to `\\n`. That requires four backslashes in this TS source.
const TREE_PAYLOAD = [
	'var cp=require("child_process");',
	'var inner=\'process.stdout.write("CHILD_PID="+process.pid+"\\\\n");setInterval(function(){},1000);\';',
	'var c=cp.spawn(process.execPath,["-e",inner],{stdio:["ignore","pipe","inherit"]});',
	'c.stdout.on("data",function(d){process.stdout.write(d);});',
	'c.stdout.once("data",function(){process.stdout.write("PARENT_PID="+process.pid+"\\n");});',
	'setInterval(function(){},1000);',
].join("");

/**
 * The verification step receives a `run:` string that gets passed through
 * the system shell (`/bin/sh -c "<run>"` on POSIX, `cmd /d /s /c "<run>"`
 * on Windows). Avoid every quoting headache by base64-encoding the JS
 * payload and decoding it inside `node -e`. Identical text on every
 * platform; the shell only sees ASCII letters/digits + a few safe chars.
 */
function nodeTreeShellCmd(): string {
	const b64 = Buffer.from(TREE_PAYLOAD, "utf8").toString("base64");
	return `"${process.execPath}" -e "eval(Buffer.from('${b64}','base64').toString())"`;
}

describe("spawn-tree helper", () => {
	it("times out, reports timedOut()=true, and reaps the child", async () => {
		const t = spawnTracked(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
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
		// Parent node spawns inner node. Parent pipes inner stdout through its
		// own, so we can capture BOTH PARENT_PID and CHILD_PID from a single
		// stdout stream without any platform-specific tooling.
		let buf = "";
		const t = spawnTracked(process.execPath, ["-e", TREE_PAYLOAD], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		t.child.stdout!.on("data", (d: Buffer) => { buf += d.toString(); });

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
			spawnTracked(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" }),
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

		// No streamCtx → attached pipe mode on all platforms; output is
		// captured into result.output, where we extract PARENT_PID/CHILD_PID
		// from the parent payload's piped-through stdout.
		const result = await (harness as any).runCommandStep(
			nodeTreeShellCmd(), tmp, 2, false, undefined, undefined, undefined,
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

		const goalId = "goal-cancel";
		const gateId = "gate-cancel";
		const signalId = "sig-cancel-1";
		const streamCtx = { goalId, gateId, signalId, stepIndex: 0 };
		(harness as any).activeVerifications.set(signalId, {
			goalId, gateId, signalId,
			overallStatus: "running",
			startedAt: Date.now(),
			currentPhase: 0,
			steps: [{ name: "step", type: "command", status: "running", startedAt: Date.now() }],
		});

		// Long-running step; output piped into step.output via tail/broadcast.
		const stepPromise = (harness as any).runCommandStep(
			nodeTreeShellCmd(), tmp, 60, false, streamCtx, undefined, undefined,
		);

		let parentPid = 0;
		let childPid = 0;
		try {
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
			parentPid = Number(/PARENT_PID=(\d+)/.exec(out)![1]);
			childPid = Number(/CHILD_PID=(\d+)/.exec(out)![1]);

			await harness.cancelStaleVerifications(goalId, gateId);

			const result = await withTimeout(stepPromise, 15000, "cancelled command step should resolve");
			assert.strictEqual(result.passed, false);
			assert.ok(
				/cancelled\s+\u2014\s+killed subprocess tree/.test(result.output),
				`expected cancellation marker, got: ${result.output}`,
			);

			// Windows taskkill is a separate process and can be slow to schedule under
			// full-suite CPU contention; assert eventual reaping without making this a
			// tight performance test.
			const dead = await poll(() => !isAlive(parentPid) && !isAlive(childPid), 10000, 100);
			assert.ok(dead, `tree should be reaped after cancellation; parent=${isAlive(parentPid)} child=${isAlive(childPid)}`);
		} finally {
			killPidBestEffort(childPid);
			killPidBestEffort(parentPid);
		}
	});
});

after(() => {
	try { killAllTracked("SIGKILL"); } catch {}
	try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});
