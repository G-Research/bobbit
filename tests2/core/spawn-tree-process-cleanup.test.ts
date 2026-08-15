import { describe, expect, it, test } from "vitest";
import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { _trackedCount, killAllTracked, killTreeByPid, spawnTracked } from "../../src/server/agent/spawn-tree.js";
import { VerificationHarness, type ActiveVerification } from "../../src/server/agent/verification-harness.js";
import { createManualClock } from "../harness/clock.js";
import { FakePinnedCheckoutManager, pinnedCheckoutReference } from "../harness/fake-pinned-checkout-manager.js";

const SPAWN_TREE_SOURCE = readFileSync(new URL("../../src/server/agent/spawn-tree.ts", import.meta.url), "utf8");
const POSIX_SUPERVISOR_SOURCE = readFileSync(new URL("../../src/server/agent/posix-tree-supervisor.ts", import.meta.url), "utf8");

type NativeSpawn = typeof import("node:child_process").spawn;

/**
 * The tier-1 spawn guard intentionally fences ordinary test subprocesses. This
 * narrow process-tree exception retrieves its preserved native spawn and
 * executes the probe in a separate Node process, where spawn-tree is unguarded.
 * Its grandchild ignores SIGTERM but has a finite final safety lifetime: every
 * lifecycle path must prove it was reaped before that fallback can matter.
 */
type GuardState = { originals?: { spawn?: NativeSpawn } };
const SPAWN_GUARD_STATE = Symbol.for("bobbit.tests2.tier1-spawn-guard-state");

const PROCESS_TREE_PROBE = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnTracked } from ${JSON.stringify(new URL("../../src/server/agent/spawn-tree.ts", import.meta.url).href)};
import { createManualClock } from ${JSON.stringify(new URL("../harness/clock.ts", import.meta.url).href)};

const grandchildScript = "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 600); setInterval(() => {}, 1000);";
const parentScript = "const fs=require('fs'); const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e',process.argv[1]],{stdio:'ignore'}); fs.writeFileSync(process.argv[2],String(child.pid)); if(process.argv[3] === 'exit-root') process.exit(0); setInterval(()=>{},1000);";
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; } };

// The watcher is armed before the Job supervisor starts. That makes the
// payload's marker an explicit lifecycle acknowledgement rather than a
// wall-clock/polling assumption, including during cold Add-Type compilation.
function prepareGrandchildAcknowledgement(marker, mode) {
  let child;
  let stdout = "";
  let stderr = "";
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const onStdout = (chunk) => { stdout += chunk.toString(); };
  const onStderr = (chunk) => { stderr += chunk.toString(); };
  const cleanup = () => {
    watcher.close();
    child?.stdout?.off("data", onStdout);
    child?.stderr?.off("data", onStderr);
    child?.off("close", onClose);
    child?.off("error", onError);
  };
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback(value);
  };
  const markerPid = () => {
    try {
      const pid = Number(fs.readFileSync(marker, "utf8"));
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    } catch { return undefined; }
  };
  const inspectMarker = () => {
    const pid = markerPid();
    if (pid != null) finish(resolveReady, pid);
  };
  const onClose = (code, signal) => {
    // A final synchronous read covers a close event delivered before the
    // directory watch callback for the parent's completed write.
    const pid = markerPid();
    if (pid != null) return finish(resolveReady, pid);
    finish(rejectReady, new Error(
      mode + ": Job supervisor closed before payload readiness (code=" + code + ", signal=" + signal
        + ", stdout=" + JSON.stringify(stdout) + ", stderr=" + JSON.stringify(stderr) + ")",
    ));
  };
  const onError = (error) => finish(rejectReady, error);
  // The unique directory has no pre-existing marker, so observing it before
  // spawn cannot miss a fast payload's acknowledgement.
  const watcher = fs.watch(path.dirname(marker), { persistent: false }, inspectMarker);
  return {
    ready,
    attach(tracked) {
      child = tracked.child;
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.once("close", onClose);
      child.once("error", onError);
    },
    fail(error) { finish(rejectReady, error); },
  };
}

async function run(mode) {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-spawn-tree-"));
  const marker = path.join(markerDir, "grandchild.pid");
  const acknowledgement = prepareGrandchildAcknowledgement(marker, mode);
  try {
    const clock = mode === "timeout" ? createManualClock(0) : undefined;
    const tracked = spawnTracked(process.execPath, ["-e", parentScript, grandchildScript, marker, mode === "natural" ? "exit-root" : "stay-root"], {
      // Capture the native supervisor's own diagnostics if it closes before
      // the marker; readiness itself never relies on stdio forwarding.
      stdio: ["ignore", "pipe", "pipe"],
      ...(clock ? { timeoutMs: 100, killGraceMs: 100, clock } : {}),
    });
    const rootPid = tracked.child.pid;
    acknowledgement.attach(tracked);
    // The native sentinel owns the detached group before the timeout is armed.
    // The manual clock makes the marker acknowledgement a second, explicit
    // ordering boundary rather than a scheduling assumption.
    await tracked.ownershipReady;
    const grandchildPid = await acknowledgement.ready;
    if (clock) {
      assert.equal(tracked.timedOut(), false, "timeout must remain idle until both readiness boundaries are observed");
      clock.advance(100);
      assert.equal(tracked.timedOut(), true, "advancing exactly the configured timeout must reap the owned tree");
    }
    if (mode === "cancel") tracked.killTree("SIGTERM", 0);
    if (tracked.child.exitCode === null && tracked.child.signalCode === null) await new Promise(resolve => tracked.child.once("exit", resolve));
    assert.equal(await tracked.waitForTreeExit(1500), true, mode + ": tracked tree should be exhausted");
    assert.equal(alive(rootPid), false, mode + ": root must be reaped");
    assert.equal(alive(grandchildPid), false, mode + ": SIGTERM-ignoring grandchild must be reaped");
    console.log(mode + "-tree-reaped");
  } catch (error) {
    acknowledgement.fail(error);
    throw error;
  } finally {
    fs.rmSync(markerDir, { recursive: true, force: true });
  }
}

// The unit tier keeps Windows lifecycle assertions on deterministic seams.
// Native Job-object descendant cleanup runs in the real-fidelity node E2E lane
// (tests/spawn-tree-shutdown-survival.test.ts) so cold PowerShell/.NET
// compilation cannot make a fixed wall-clock probe load-bearing here. POSIX
// retains its native timeout-tree probe because it has no cold supervisor.
for (const mode of ["natural", "timeout", "cancel"]) await run(mode);
`;

const RECOVERED_SENTINEL_PROBE = String.raw`
import fs from "node:fs";
import { spawnTracked } from ${JSON.stringify(new URL("../../src/server/agent/spawn-tree.ts", import.meta.url).href)};

const stateDir = process.env.BOBBIT_RECOVERED_SENTINEL_STATE;
const exitFile = process.env.BOBBIT_RECOVERED_SENTINEL_EXIT;
if (!stateDir || !exitFile) throw new Error("missing recovered-sentinel probe paths");
const nonce = "recovered-sentinel-nonce";
const pidFile = stateDir + "/root.pid";
const sentinelFile = stateDir + "/sentinel.json";
const tracked = spawnTracked("/bin/sh", ["-c", 'read __bobbit_parent_exit <&4; printf 0 > "$BOBBIT_RECOVERED_SENTINEL_EXIT"'], {
  // FD 4 blocks the payload until this probe exits and closes its pipe end.
  // This makes parent death the lifecycle handoff without polling or sleeps.
  stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  posixSentinelIdentity: { file: sentinelFile, nonce },
  env: process.env,
});
tracked.markSurvival();
await tracked.ownershipReady;
if (!fs.existsSync(sentinelFile)) throw new Error("sentinel ownershipReady resolved before publishing its identity");
fs.writeFileSync(pidFile, String(tracked.child.pid) + "\n" + nonce + "\n");
process.stdout.write(JSON.stringify({ pid: tracked.child.pid, pidFile, sentinelFile, nonce }) + "\n", () => process.exit(0));
`;

const FAST_EXIT_SENTINEL_PROBE = String.raw`
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnTracked } from ${JSON.stringify(new URL("../../src/server/agent/spawn-tree.ts", import.meta.url).href)};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-fast-sentinel-"));
const identityFile = path.join(dir, "sentinel.json");
const tracked = spawnTracked("/bin/sh", ["-c", "exit 0"], {
  stdio: ["ignore", "ignore", "ignore", "pipe"],
  posixSentinelIdentity: { file: identityFile, nonce: "fast-exit-nonce" },
});
await new Promise((resolve, reject) => {
  const ready = tracked.child.stdio[3];
  if (!ready) return reject(new Error("missing sentinel readiness pipe"));
  ready.once("data", resolve);
  ready.once("error", reject);
});
const identity = JSON.parse(fs.readFileSync(identityFile, "utf8"));
process.stdout.write(JSON.stringify({ rootPid: tracked.child.pid, identity }) + "\n", () => {
  try { tracked.killTree("SIGKILL"); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
});
`;

const NESTED_SENTINEL_PAYLOAD = String.raw`
import fs from "node:fs";
import { spawnTracked } from ${JSON.stringify(new URL("../../src/server/agent/spawn-tree.ts", import.meta.url).href)};
const inherited = {
  file: process.env.BOBBIT_POSIX_SENTINEL_IDENTITY_FILE,
  nonce: process.env.BOBBIT_POSIX_SENTINEL_IDENTITY_NONCE,
  script: process.env.BOBBIT_POSIX_TREE_SENTINEL_CHILD_SCRIPT,
  payload: process.env.BOBBIT_POSIX_TREE_PAYLOAD,
  pgid: process.env.BOBBIT_POSIX_SENTINEL_PGID,
};
const nested = spawnTracked(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", "pipe"], posixSentinelIdentity: { file: process.env.BOBBIT_NESTED_SENTINEL_FILE, nonce: "nested-nonce" } });
// The nested payload deliberately stays alive until its owned group is killed.
// Subscribe before FD3 readiness so its close cannot race the subsequent await.
const nestedClosed = new Promise((resolve, reject) => { nested.child.once("close", resolve); nested.child.once("error", reject); });
await new Promise((resolve, reject) => { const ready = nested.child.stdio[3]; if (!ready) return reject(new Error("missing nested ready")); ready.once("data", resolve); ready.once("error", reject); });
fs.writeFileSync(process.env.BOBBIT_NESTED_SENTINEL_RESULT, JSON.stringify({ inherited, nested: JSON.parse(fs.readFileSync(process.env.BOBBIT_NESTED_SENTINEL_FILE, "utf8")), outer: JSON.parse(fs.readFileSync(process.env.BOBBIT_OUTER_SENTINEL_FILE, "utf8")) }));
nested.killTree("SIGKILL");
await nestedClosed;
process.exit(0);
`;

const NESTED_SENTINEL_PROBE = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnTracked } from ${JSON.stringify(new URL("../../src/server/agent/spawn-tree.ts", import.meta.url).href)};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-nested-sentinel-"));
const outerFile = path.join(dir, "outer.json"), nestedFile = path.join(dir, "nested.json"), resultFile = path.join(dir, "result.json");
const tracked = spawnTracked(process.execPath, ["--import", "tsx", "--input-type=module", "-e", ${JSON.stringify(NESTED_SENTINEL_PAYLOAD)}], { stdio: ["ignore", "ignore", "ignore", "pipe"], env: { ...process.env, BOBBIT_OUTER_SENTINEL_FILE: outerFile, BOBBIT_NESTED_SENTINEL_FILE: nestedFile, BOBBIT_NESTED_SENTINEL_RESULT: resultFile }, posixSentinelIdentity: { file: outerFile, nonce: "outer-nonce" } });
// The payload can exit before its outer sentinel's FD3 acknowledgement.
// Subscribe before either event so a fast close cannot be lost between awaits.
const closed = new Promise((resolve, reject) => { tracked.child.once("close", resolve); tracked.child.once("error", reject); });
await new Promise((resolve, reject) => { const ready = tracked.child.stdio[3]; if (!ready) return reject(new Error("missing outer ready")); ready.once("data", resolve); ready.once("error", reject); });
const outer = JSON.parse(fs.readFileSync(outerFile, "utf8"));
process.kill(outer.pid, "SIGTERM");
await new Promise(resolve => setTimeout(resolve, 30));
try { process.kill(outer.pid, 0); } catch (error) { assert.fail("sentinel must survive immediate post-ownership SIGTERM: " + error); }
await closed;
const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
process.stdout.write(JSON.stringify({ ...result, survivedImmediateSigterm: true }) + "\n", () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); });
`;

const IDENTITY_FAILURE_PROBE = String.raw`
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnTracked } from ${JSON.stringify(new URL("../../src/server/agent/spawn-tree.ts", import.meta.url).href)};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-sentinel-write-fail-"));
const tracked = spawnTracked("/bin/sh", ["-c", "exec tail -f /dev/null"], {
  stdio: ["ignore", "ignore", "ignore", "pipe"],
  posixSentinelIdentity: { file: path.join(dir, "missing", "sentinel.json"), nonce: "write-fail" },
  timeoutMs: 10_000,
});
const ready = tracked.child.stdio[3];
let acknowledged = false;
await new Promise((resolve, reject) => {
  if (!ready) return reject(new Error("missing readiness pipe"));
  ready.on("data", () => { acknowledged = true; });
  ready.once("close", resolve);
  ready.once("error", reject);
});
const reaped = await tracked.waitForTreeExit(1_500);
process.stdout.write(JSON.stringify({ acknowledged, reaped }) + "\n", () => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
});
`;

const POSIX_COMMAND_INJECTION_PROBE = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnTracked } from ${JSON.stringify(new URL("../../src/server/agent/spawn-tree.ts", import.meta.url).href)};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-posix-command-injection-"));
const injected = path.join(dir, "injected");
try {
  // If this command were assembled into shell source, the trailing redirect
  // would create the marker. The tracked launcher must instead try to execute
  // this complete string as one shell-free executable path.
  const command = process.execPath + "; printf injected > " + JSON.stringify(injected);
  const tracked = spawnTracked(command, [], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  await tracked.ownershipReady;
  await new Promise((resolve, reject) => { tracked.child.once("close", resolve); tracked.child.once("error", reject); });
  assert.equal(fs.existsSync(injected), false, "configured command must not be interpreted by a shell");
  assert.equal(await tracked.waitForTreeExit(1_500), true);
  process.stdout.write(JSON.stringify({ injected: fs.existsSync(injected) }) + "\n");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
`;

type FakeReadyPipe = EventEmitter & { unrefCalls: number; unref(): void };
type FakeChild = ChildProcess & { killCalls: NodeJS.Signals[]; readyPipe: FakeReadyPipe };

function fakeChild(pid: number): FakeChild {
	const killCalls: NodeJS.Signals[] = [];
	const readyPipe = Object.assign(new EventEmitter(), {
		unrefCalls: 0,
		unref() { this.unrefCalls++; },
	}) as FakeReadyPipe;
	return Object.assign(new EventEmitter(), {
		pid,
		killCalls,
		readyPipe,
		stdio: [null, null, null, readyPipe],
		kill: (signal: NodeJS.Signals) => { killCalls.push(signal); return true; },
	}) as unknown as FakeChild;
}

function runProbe(): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const state = (process as NodeJS.Process & { [SPAWN_GUARD_STATE]?: GuardState })[SPAWN_GUARD_STATE];
	const nativeSpawn = state?.originals?.spawn;
	if (!nativeSpawn) throw new Error("process-tree probe requires the tier-1 spawn guard's preserved native spawn");
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let finished = false;
		const finish = (result: { stdout: string; stderr: string; code: number | null }) => {
			if (finished) return;
			finished = true;
			clearTimeout(timeout);
			resolve(result);
		};
		const options: SpawnOptions = { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] };
		const child: ChildProcess = nativeSpawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", PROCESS_TREE_PROBE], options);
		child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
		child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
		child.once("error", reject);
		child.once("close", code => finish({ stdout, stderr, code }));
		const timeout = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch { /* probe has finite child lifetime */ }
			finish({ stdout, stderr: `${stderr}\nprobe exceeded 10s`, code: null });
		}, 10_000);
		timeout.unref();
	});
}

function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			watcher.close();
			if (error) reject(error); else resolve();
		};
		const watcher = fs.watch(path.dirname(file), { persistent: false }, () => {
			if (fs.existsSync(file)) finish();
		});
		timeout = setTimeout(() => finish(new Error(`timed out waiting for ${file}`)), timeoutMs);
		// This guard prevents a genuinely broken regression from consuming the
		// worker forever; file creation, not elapsed time, is the assertion boundary.
		timeout.unref();
		if (fs.existsSync(file)) finish();
	});
}

function recoveredSentinelProbe(stateDir: string, exitFile: string): Promise<{ pid: number; pidFile: string; sentinelFile: string; nonce: string }> {
	const state = (process as NodeJS.Process & { [SPAWN_GUARD_STATE]?: GuardState })[SPAWN_GUARD_STATE];
	const nativeSpawn = state?.originals?.spawn;
	if (!nativeSpawn) throw new Error("recovered-sentinel probe requires the tier-1 spawn guard's preserved native spawn");
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const child = nativeSpawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", RECOVERED_SENTINEL_PROBE], {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				BOBBIT_RECOVERED_SENTINEL_STATE: stateDir,
				BOBBIT_RECOVERED_SENTINEL_EXIT: exitFile,
			},
		});
		child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
		child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
		child.once("error", reject);
		child.once("close", code => {
			if (code !== 0) return reject(new Error(`recovered-sentinel probe failed (code=${code}): ${stderr}`));
			try { resolve(JSON.parse(stdout.trim())); }
			catch (error) { reject(new Error(`recovered-sentinel probe emitted invalid state: ${stdout}\n${String(error)}`)); }
		});
	});
}

function runNativeJsonProbe(source: string): Promise<any> {
	const state = (process as NodeJS.Process & { [SPAWN_GUARD_STATE]?: GuardState })[SPAWN_GUARD_STATE];
	const nativeSpawn = state?.originals?.spawn;
	if (!nativeSpawn) throw new Error("native probe requires the tier-1 spawn guard's preserved spawn");
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const child = nativeSpawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
		child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
		child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
		child.once("error", reject);
		child.once("close", code => {
			if (code !== 0) return reject(new Error(`native probe failed (code=${code}): ${stderr}`));
			try { resolve(JSON.parse(stdout.trim())); }
			catch (error) { reject(new Error(`native probe emitted invalid JSON: ${stdout}\n${String(error)}`)); }
		});
	});
}

function groupAlive(pid: number): boolean {
	try { process.kill(-pid, 0); return true; }
	catch (error: any) { return error?.code === "EPERM"; }
}

function makeRecoveryHarness(
	stateDir: string,
	calls: Array<{ kind: string; status: string }>,
	deps: { platform?: NodeJS.Platform; posixProcessIdentityInspector?: (pid: number) => any; containerProcessIdentityInspector?: (containerId: string, pid: number) => Promise<{ pid: number; pgid: number; startToken: string } | undefined>; containerProcessTopSnapshot?: (containerId: string) => Promise<readonly any[]>; persistedTreeKiller?: (pid: number, signal?: NodeJS.Signals) => "signalled" | "unsupported" | "invalid"; recoveredSentinelReaper?: (step: any) => Promise<void>; projectContextManager?: any; clock?: any; pinnedCheckoutManager?: FakePinnedCheckoutManager } = {},
): VerificationHarness {
	const pinnedCheckoutManager = deps.pinnedCheckoutManager ?? new FakePinnedCheckoutManager(path.join(stateDir, "verification-checkouts"));
	const persistPath = path.join(stateDir, "active-verifications.json");
	if (fs.existsSync(persistPath)) {
		const persisted = JSON.parse(fs.readFileSync(persistPath, "utf8"));
		let changed = false;
		for (const verification of persisted.verifications ?? []) {
			if (typeof verification?.signalId !== "string") continue;
			const checkout = pinnedCheckoutManager.seed(verification.signalId, stateDir);
			if (!verification.pinnedCheckout) {
				verification.pinnedCheckout = pinnedCheckoutReference(checkout);
				changed = true;
			}
		}
		if (changed) fs.writeFileSync(persistPath, JSON.stringify(persisted));
	}
	return new VerificationHarness(
		stateDir,
		{
			updateSignalVerification: (_signalId: string, update: any) => calls.push({ kind: "verification", status: update.status }),
			updateGateStatus: (_goalId: string, _gateId: string, status: string) => calls.push({ kind: "gate", status }),
			getGate: () => undefined,
		} as any,
		() => {},
		{ get: () => undefined, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined,
		undefined,
		deps.projectContextManager,
		undefined,
		{
			...deps,
			pinnedCheckoutManager: pinnedCheckoutManager as any,
			containerProcessIdentityInspector: deps.containerProcessIdentityInspector ?? (async (_containerId, pid) => ({ pid, pgid: pid, startToken: "container-start" })),
			containerProcessTopSnapshot: deps.containerProcessTopSnapshot ?? (async () => [{ pid: 1, ppid: 1, pgid: 1, state: "S", args: "init" }]),
		},
	);
}

function recoveredContainerOwnership(nonce: string, { containerId = "container-under-test", sentinelPid = 321_654, pgid = sentinelPid, startToken = "container-start", execId = "exec", enginePid = 1, enginePgid = 2, tag = "tag" }: { containerId?: string; sentinelPid?: number; pgid?: number; startToken?: string; execId?: string; enginePid?: number; enginePgid?: number; tag?: string } = {}): Record<string, unknown> {
	return {
		containerOwnershipWitness: { containerId, nonce, sentinelPid, pgid, startToken },
		containerOwnershipAttestation: { version: 1, containerId, nonce, execId, enginePid, enginePgid, tag, sentinelPid, pgid, startToken },
	};
}

function recoveredContainerSentinelStep(stateDir: string, name: string, nonce: string, deadlineMs: number): any {
	return {
		name, type: "command", status: "running", startedAt: Date.now() - 1_000,
		containerId: "container-under-test", restartRecoveryMode: "container-exec", pid: 321_654, pidFile: "/tmp/.bobbit-verif/signal/0.pid",
		pidNonce: nonce, sentinelFile: path.join(stateDir, "docker-exec.sentinel.json"),
		...recoveredContainerOwnership(nonce),
		exitFile: "/tmp/.bobbit-verif/signal/0.exit", heartbeatFile: "/tmp/.bobbit-verif/signal/0.heartbeat", deadlineMs,
	};
}

async function expectRecoveredContainerSentinelWait(
	stateDir: string,
	{ name, nonce, deadlineMs, recordTerm, events: expectedEvents, statuses }: { name: string; nonce: string; deadlineMs: number; recordTerm: boolean; events: string[]; statuses: Array<{ kind: string; status: string }> },
): Promise<void> {
	let releaseReap!: () => void;
	const reapReleased = new Promise<void>(resolve => { releaseReap = resolve; });
	let resolveReapStarted!: () => void;
	const reapStarted = new Promise<void>(resolve => { resolveReapStarted = resolve; });
	const events: string[] = [];
	const calls: Array<{ kind: string; status: string }> = [];
	const pinnedCheckoutManager = new FakePinnedCheckoutManager(path.join(stateDir, "verification-checkouts"));
	const harness = makeRecoveryHarness(stateDir, calls, { platform: "linux", pinnedCheckoutManager });
	(harness as any)._reapRecoveredPosixSentinel = async () => {
		events.push("reap");
		resolveReapStarted();
		await reapReleased;
	};
	(harness as any)._dockerExecCapture = async (_cid: string, command: string) => {
		if (recordTerm && command.includes("kill -TERM")) events.push("container-kill");
		return { code: 0, stdout: "" };
	};
	const step = recoveredContainerSentinelStep(stateDir, name, nonce, deadlineMs);
	const active: ActiveVerification = {
		goalId: "goal", gateId: "implementation", signalId: "signal", overallStatus: "running", startedAt: Date.now(), currentPhase: 0, steps: [step],
		pinnedCheckout: pinnedCheckoutReference(pinnedCheckoutManager.seed("signal", stateDir)),
	};
	fs.writeFileSync(path.join(stateDir, "active-verifications.json"), JSON.stringify({ verifications: [active] }));
	const result = harness.resumeInterruptedVerifications();
	await reapStarted;
	expect(events).toEqual(expectedEvents);
	expect(calls).toEqual([]);
	releaseReap();
	await expect(result).resolves.toBeUndefined();
	expect(events).toEqual(expectedEvents);
	expect(calls).toEqual(statuses);
}

describe("spawnTracked timeout cleanup", () => {
	it("keeps STARTUPINFO flags unsigned so the Windows Job supervisor Add-Type source compiles", () => {
		const startupInfo = SPAWN_TREE_SOURCE.match(/public struct STARTUPINFO \{(?<body>[^}]+)\}/s)?.groups?.body;
		expect(startupInfo).toContain("public uint dwFlags;");
		expect(SPAWN_TREE_SOURCE).toContain("si.dwFlags = STARTF_USESTDHANDLES;");
		expect(SPAWN_TREE_SOURCE).toContain("InheritableStdHandle(-10, GENERIC_READ, out ownIn)");
		expect(SPAWN_TREE_SOURCE).toContain("InheritableStdHandle(-11, GENERIC_WRITE, out ownOut)");
		expect(SPAWN_TREE_SOURCE).toContain("InheritableStdHandle(-12, GENERIC_WRITE, out ownErr)");
		expect(SPAWN_TREE_SOURCE).toContain("Remove-Item Env:BOBBIT_WINDOWS_JOB_PAYLOAD");
		expect(SPAWN_TREE_SOURCE).toContain("Remove-Item Env:BOBBIT_WINDOWS_JOB_READY_FILE");
		expect(SPAWN_TREE_SOURCE).toMatch(/AssignProcessToJobObject\(job, pi\.hProcess\).*File\.Move\(pendingReadyFile, readyFile\).*ResumeThread\(pi\.hThread\)/s);
	});

	it("treats unset optional Windows Job file arguments as absent after PowerShell string conversion", () => {
		expect(SPAWN_TREE_SOURCE).toContain("if (!String.IsNullOrEmpty(readyFile))");
		expect(SPAWN_TREE_SOURCE).toContain("if (assigned && !String.IsNullOrEmpty(completionFile) && !String.IsNullOrEmpty(completionNonce))");
	});

	it("reaps SIGTERM-ignoring descendants through the native POSIX process model", async () => {
		if (process.platform === "win32") {
			// Windows native Job cleanup is real-fidelity E2E coverage; focused
			// seams below pin its ownership and timeout state transitions here.
			expect(process.platform).toBe("win32");
			return;
		}
		const result = await runProbe();
		expect(result.code, result.stderr).toBe(0);
		for (const mode of ["natural", "timeout", "cancel"]) expect(result.stdout).toContain(`${mode}-tree-reaped`);
	});

	it("reaps a recovered POSIX sentinel after its original parent exits even if the root PID stamp was interrupted", async () => {
		if (process.platform !== "linux" && process.platform !== "darwin") {
			expect(["linux", "darwin"]).not.toContain(process.platform);
			return;
		}
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-recovered-sentinel-"));
		const exitFile = path.join(stateDir, "command.exit");
		let rootPid: number | undefined;
		try {
			const probe = await recoveredSentinelProbe(stateDir, exitFile);
			rootPid = probe.pid;
			const sentinelIdentity = JSON.parse(fs.readFileSync(probe.sentinelFile, "utf8"));
			expect(sentinelIdentity.pid, "the durable record must name the separately-invoked sentinel, not the root wrapper").not.toBe(rootPid);
			// The probe already exited. Its closed FD 4 now releases the payload,
			// which publishes this exit file without any timing-based polling.
			await waitForFile(exitFile);
			expect(groupAlive(rootPid), "the probe parent exited, but its same-group sentinel must retain the original PGID for recovered cleanup").toBe(true);

			const active: ActiveVerification = {
				goalId: "goal-recovered-sentinel",
				gateId: "implementation",
				signalId: "sig-recovered-sentinel",
				overallStatus: "running",
				startedAt: Date.now() - 1_000,
				currentPhase: 0,
				steps: [{
					name: "Recovered command",
					type: "command",
					status: "running",
					phase: 0,
					startedAt: Date.now() - 1_000,
					// Simulate a gateway crash after the sentinel published its durable
					// identity but before the host root PID stamp reached state.
					pidFile: probe.pidFile,
					pidNonce: probe.nonce,
					sentinelFile: probe.sentinelFile,
					exitFile,
					commandCwd: stateDir,
				}],
			};
			fs.writeFileSync(path.join(stateDir, "active-verifications.json"), JSON.stringify({ verifications: [active] }));
			const calls: Array<{ kind: string; status: string }> = [];
			await makeRecoveryHarness(stateDir, calls, {
				// The tier-1 spawn guard blocks `ps`; the native probe above proves
				// Darwin publication and ownershipReady, while this seam drives the
				// corresponding recovered exact-identity state transition.
				posixProcessIdentityInspector: pid => pid === sentinelIdentity.pid
					? sentinelIdentity.startTokenKind === "darwin-lstart-argv-nonce"
						? { startTokenKind: "darwin-lstart-argv-nonce", startToken: sentinelIdentity.startToken, pgid: sentinelIdentity.pgid, sentinelNonce: sentinelIdentity.nonce }
						: { startTokenKind: "linux-proc-stat-22", startToken: sentinelIdentity.startToken, pgid: sentinelIdentity.pgid }
					: undefined,
			}).resumeInterruptedVerifications();

			expect(calls).toContainEqual({ kind: "gate", status: "passed" });
			expect(groupAlive(rootPid), "successful recovered verification must reap the sentinel group left by the exited parent").toBe(false);
		} finally {
			if (rootPid && groupAlive(rootPid)) {
				try { process.kill(-rootPid, "SIGKILL"); } catch { /* test cleanup */ }
			}
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("reaps the persisted docker-exec host sentinel before publishing a recovered container result", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-sentinel-order-"));
		const events: string[] = [];
		try {
			const harness = makeRecoveryHarness(stateDir, []);
			(harness as any)._reapRecoveredPosixSentinel = async (step: any) => {
				events.push(`reap:${step.pid}:${step.sentinelFile}`);
			};
			(harness as any)._dockerExecCapture = async () => ({ code: 0, stdout: "0\n" });
			const hostResult = path.join(stateDir, "docker-exec.result.json");
			fs.writeFileSync(hostResult, JSON.stringify({ nonce: "host-sentinel-nonce", exitCode: 0 }));
			const step: any = {
				name: "Recovered container command", type: "command", status: "running", startedAt: Date.now() - 1_000,
				containerId: "container-under-test", restartRecoveryMode: "container-exec",
				pid: 321_654, pidFile: "/tmp/.bobbit-verif/signal/0.pid", pidNonce: "host-sentinel-nonce", sentinelFile: path.join(stateDir, "docker-exec.sentinel.json"),
				...recoveredContainerOwnership("host-sentinel-nonce"),
				exitFile: "/tmp/.bobbit-verif/signal/0.exit", heartbeatFile: "/tmp/.bobbit-verif/signal/0.heartbeat",
				containerCompletionFile: hostResult, containerCompletionNonce: "host-sentinel-nonce",
			};
			const active: any = { goalId: "goal", gateId: "implementation", signalId: "signal", overallStatus: "running", startedAt: Date.now(), steps: [step] };
			const resumed = await (harness as any)._resumeContainerCommandStep(active, step, {
				finalize: (code: number) => {
					events.push(`finalize:${code}`);
					return { name: step.name, type: step.type, passed: code === 0, output: `exit code ${code}`, duration_ms: 0 };
				},
				timeoutResult: () => { throw new Error("unexpected timeout"); },
				restartInterrupted: (reason?: string) => { throw new Error(`unexpected interruption: ${reason}`); },
			});
			expect(resumed).toMatchObject({ passed: true });
			expect(events).toEqual([`reap:321654:${step.sentinelFile}`, "finalize:0"]);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("fails a recovered POSIX container verdict closed when host sentinel metadata is absent", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-sentinel-metadata-"));
		try {
			const harness = makeRecoveryHarness(stateDir, [], { platform: "linux" });
			(harness as any)._dockerExecCapture = async () => ({ code: 0, stdout: "0\n" });
			const hostResult = path.join(stateDir, "docker-exec.result.json");
			fs.writeFileSync(hostResult, JSON.stringify({ nonce: "missing-sentinel-nonce", exitCode: 0 }));
			const step: any = {
				name: "Container without host sentinel", type: "command", status: "running", startedAt: Date.now() - 1_000,
				containerId: "container-under-test", restartRecoveryMode: "container-exec", pid: 321_654, pidFile: "/tmp/.bobbit-verif/signal/0.pid",
				pidNonce: "missing-sentinel-nonce", ...recoveredContainerOwnership("missing-sentinel-nonce"), exitFile: "/tmp/.bobbit-verif/signal/0.exit", heartbeatFile: "/tmp/.bobbit-verif/signal/0.heartbeat",
				containerCompletionFile: hostResult, containerCompletionNonce: "missing-sentinel-nonce",
			};
			const active: any = { goalId: "goal", gateId: "implementation", signalId: "signal", overallStatus: "running", startedAt: Date.now(), steps: [step] };
			let finalized = false;
			await expect((harness as any)._resumeContainerCommandStep(active, step, {
				finalize: () => { finalized = true; throw new Error("must not finalize without host sentinel metadata"); },
				timeoutResult: () => { throw new Error("unexpected timeout"); },
				restartInterrupted: () => { throw new Error("must not return waiting without host sentinel metadata"); },
			})).rejects.toThrow(/no durable host docker-exec sentinel metadata/i);
			expect(finalized).toBe(false);
			expect(step.sentinelCleanupPending).toBe(true);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("uses exact sentinel metadata to bridge the recovered container spawn-to-state crash window", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-sentinel-group-"));
		const sentinelFile = path.join(stateDir, "docker-exec.sentinel.json");
		const nonce = "container-group-nonce";
		const groupId = 321_654;
		const killCalls: number[] = [];
		// A field-22-shaped kernel tick token, not a coarse wall-clock `lstart`.
		const kernelStartToken = "4242424242";
		try {
			fs.writeFileSync(sentinelFile, JSON.stringify({ pid: process.pid, pgid: groupId, nonce, startTokenKind: "linux-proc-stat-22", startToken: kernelStartToken }));
			const harness = makeRecoveryHarness(stateDir, [], {
				platform: "linux",
				posixProcessIdentityInspector: () => ({ startTokenKind: "linux-proc-stat-22", startToken: kernelStartToken, pgid: groupId }),
				persistedTreeKiller: pid => { killCalls.push(pid); return "signalled"; },
			});
			// Simulate a crash after the pre-spawn sentinel metadata was persisted,
			// but before JS stamped child.pid into active verification state.
			(harness as any)._waitForPidToExit = async () => true;
			const crashedBeforePidStamp: any = {
				name: "Container without persisted group", type: "command", status: "running", startedAt: Date.now(),
				containerId: "container-under-test", restartRecoveryMode: "container-exec", pidNonce: nonce, sentinelFile,
			};
			await expect((harness as any)._reapRecoveredPosixSentinel(crashedBeforePidStamp)).resolves.toBeUndefined();
			expect(killCalls).toEqual([groupId]);

			await expect((harness as any)._reapRecoveredPosixSentinel({
				...crashedBeforePidStamp, pid: groupId + 1,
			})).rejects.toThrow(/did not match persisted group metadata/i);
			expect(killCalls).toEqual([groupId]);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("keeps recovered Windows container transport pending without nonce-bound Job completion evidence", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-sentinel-windows-"));
		const calls: Array<{ kind: string; status: string }> = [];
		try {
			const pinnedCheckoutManager = new FakePinnedCheckoutManager(path.join(stateDir, "verification-checkouts"));
			const harness = makeRecoveryHarness(stateDir, calls, { platform: "win32", pinnedCheckoutManager });
			(harness as any)._dockerExecCapture = async () => ({ code: 0, stdout: "0\n" });
			const step: any = {
				name: "Windows container", type: "command", status: "running", startedAt: Date.now() - 1_000,
				containerId: "container-under-test", restartRecoveryMode: "container-exec", pidNonce: "windows-nonce", ...recoveredContainerOwnership("windows-nonce"), pidFile: "/tmp/.bobbit-verif/signal/0.pid", exitFile: "/tmp/.bobbit-verif/signal/0.exit", heartbeatFile: "/tmp/.bobbit-verif/signal/0.heartbeat",
			};
			const active: ActiveVerification = {
				goalId: "goal", gateId: "implementation", signalId: "signal", overallStatus: "running", startedAt: Date.now(), currentPhase: 0, steps: [step],
				pinnedCheckout: pinnedCheckoutReference(pinnedCheckoutManager.seed("signal", stateDir)),
			};
			fs.writeFileSync(path.join(stateDir, "active-verifications.json"), JSON.stringify({ verifications: [active] }));

			await expect(harness.resumeInterruptedVerifications()).resolves.toBeUndefined();

			// Windows cannot reopen a historical Job by PID. A missing nonce-bound
			// post-Job-close record leaves its transport cleanup retryable; it must
			// never accept the former no-op and publish a terminal verification/gate.
			expect(calls).toEqual([]);
			const resumed = (harness as any).activeVerifications.get("signal") as ActiveVerification;
			expect(resumed).toBeDefined();
			const resumedStep = resumed.steps[0] as any;
			expect(resumedStep.containerPayloadCleanupCompletedAt).toEqual(expect.any(Number));
			expect(resumedStep.containerTransportCleanupPending).toBe(true);
			expect(resumedStep.sentinelCleanupPending).toBe(true);
			expect(resumedStep.containerTransportCleanupCompletedAt).toBeUndefined();
			const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "active-verifications.json"), "utf8"));
			expect(persisted.verifications).toHaveLength(1);
			expect(persisted.verifications[0].steps[0]).toMatchObject({
				containerTransportCleanupPending: true,
				sentinelCleanupPending: true,
			});
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("reaps the exact host sentinel before publishing a recovered container timeout", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-sentinel-timeout-"));
		try {
			// Resume must keep this persisted entry active until the exact sentinel
			// reaper settles, rather than bypassing the production recovery loop.
			await expectRecoveredContainerSentinelWait(stateDir, {
				name: "Timed out container", nonce: "timeout-nonce", deadlineMs: Date.now() - 1, recordTerm: true, events: ["container-kill", "reap"],
				statuses: [{ kind: "verification", status: "failed" }, { kind: "gate", status: "failed" }],
			});
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("reaps the exact host sentinel before returning a recovered container no-verdict wait", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-sentinel-no-verdict-"));
		try {
			await expectRecoveredContainerSentinelWait(stateDir, {
				name: "No-verdict container", nonce: "no-verdict-nonce", deadlineMs: Date.now() + 10_000, recordTerm: false, events: ["reap"],
				statuses: [{ kind: "verification", status: "failed" }, { kind: "gate", status: "pending" }],
			});
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("records the original group for a fast-exiting payload", async () => {
		if (process.platform !== "linux") {
			expect(process.platform).not.toBe("linux");
			return;
		}
		const result = await runNativeJsonProbe(FAST_EXIT_SENTINEL_PROBE);
		expect(result.identity.pid).not.toBe(result.rootPid);
		expect(result.identity.pgid).toBe(result.rootPid);
		expect(result.identity.startToken).toEqual(expect.any(String));
	});

	it("records a nonce-bound Darwin sentinel identity from the live supervisor argv", async () => {
		if (process.platform !== "darwin") {
			expect(process.platform).not.toBe("darwin");
			return;
		}
		const result = await runNativeJsonProbe(FAST_EXIT_SENTINEL_PROBE);
		expect(result.identity).toMatchObject({
			nonce: "fast-exit-nonce",
			pgid: result.rootPid,
			startTokenKind: "darwin-lstart-argv-nonce",
		});
	});

	it("keeps the post-ownership sentinel alive and scrubs its envelope before a nested tracked spawn", async () => {
		if (process.platform === "win32") {
			expect(process.platform).toBe("win32");
			return;
		}
		const result = await runNativeJsonProbe(NESTED_SENTINEL_PROBE);
		expect(result.inherited).toEqual({ file: undefined, nonce: undefined, script: undefined, payload: undefined, pgid: undefined });
		expect(result.outer.nonce).toBe("outer-nonce");
		expect(result.nested.nonce).toBe("nested-nonce");
		expect(result.nested.pid).not.toBe(result.outer.pid);
		expect(result.survivedImmediateSigterm).toBe(true);
	});

	it("does not acknowledge or leak when sentinel identity publishing fails", async () => {
		if (process.platform === "win32") {
			expect(process.platform).toBe("win32");
			return;
		}
		const result = await runNativeJsonProbe(IDENTITY_FAILURE_PROBE);
		expect(result).toEqual({ acknowledged: false, reaped: true });
	});

	it("keeps configured POSIX commands outside every shell boundary", async () => {
		if (process.platform === "win32") {
			expect(process.platform).toBe("win32");
			return;
		}
		const result = await runNativeJsonProbe(POSIX_COMMAND_INJECTION_PROBE);
		expect(result).toEqual({ injected: false });
		expect(SPAWN_TREE_SOURCE).toContain("posixSupervisorArgs");
		expect(SPAWN_TREE_SOURCE).toContain("POSIX_TREE_PAYLOAD_ENV");
		expect(SPAWN_TREE_SOURCE).not.toContain('"/bin/sh"');
		expect(SPAWN_TREE_SOURCE).not.toContain("/dev/fd/");
		expect(POSIX_SUPERVISOR_SOURCE).toContain('spawn("/usr/bin/env", ["--", payload.file, ...payload.args]');
		expect(POSIX_SUPERVISOR_SOURCE).toContain("process.exitCode = 125;");
	});

	it("refuses a reused POSIX sentinel PID before it can signal a group", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-reused-sentinel-"));
		const sentinelFile = path.join(stateDir, "sentinel.json");
		const groupId = 123_456;
		const nonce = "original-sentinel-nonce";
		fs.writeFileSync(sentinelFile, JSON.stringify({ pid: process.pid, pgid: groupId, nonce, startTokenKind: "linux-proc-stat-22", startToken: "original-process" }));
		const killCalls: Array<{ pid: number; signal: NodeJS.Signals | undefined }> = [];
		try {
			const harness = makeRecoveryHarness(stateDir, [], {
				platform: "linux",
				posixProcessIdentityInspector: () => ({ startTokenKind: "linux-proc-stat-22", startToken: "reused-process", pgid: groupId }),
				persistedTreeKiller: (pid, signal) => {
					killCalls.push({ pid, signal });
					return "signalled";
				},
			});
			await expect((harness as any)._reapRecoveredPosixSentinel({
				name: "Recovered command", type: "command", status: "running", startedAt: Date.now(),
				pid: groupId, pidNonce: nonce, sentinelFile,
			})).rejects.toThrow(/no longer matches its original exact process identity/i);
			expect(killCalls, "a mismatched live sentinel PID must not authorize any process-group signal").toEqual([]);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("rejects same-second Darwin PID reuse when the process-held nonce differs", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-darwin-same-second-reuse-"));
		const sentinelFile = path.join(stateDir, "sentinel.json");
		const groupId = 234_567;
		const nonce = "darwin-original-128-bit-nonce";
		const startToken = "Sun Aug  2 19:39:25 2026";
		const killCalls: number[] = [];
		try {
			fs.writeFileSync(sentinelFile, JSON.stringify({ pid: process.pid, pgid: groupId, nonce, startTokenKind: "darwin-lstart-argv-nonce", startToken }));
			const harness = makeRecoveryHarness(stateDir, [], {
				platform: "darwin",
				posixProcessIdentityInspector: () => ({ startTokenKind: "darwin-lstart-argv-nonce", startToken, pgid: groupId, sentinelNonce: "darwin-reused-128-bit-nonce" }),
				persistedTreeKiller: pid => { killCalls.push(pid); return "signalled"; },
			});
			await expect((harness as any)._reapRecoveredPosixSentinel({
				name: "Darwin same-second reused sentinel", type: "command", status: "running", startedAt: Date.now(),
				pid: groupId, pidNonce: nonce, sentinelFile,
			})).rejects.toThrow(/no longer matches its original exact process identity/i);
			expect(killCalls, "same-second lstart equality without the live nonce must not authorize a group signal").toEqual([]);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("authorizes a Darwin sentinel only when lstart and its live nonce match", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-darwin-exact-sentinel-"));
		const sentinelFile = path.join(stateDir, "sentinel.json");
		const groupId = 234_568;
		const nonce = "darwin-exact-128-bit-nonce";
		const startToken = "Sun Aug  2 19:39:25 2026";
		const killCalls: number[] = [];
		try {
			fs.writeFileSync(sentinelFile, JSON.stringify({ pid: process.pid, pgid: groupId, nonce, startTokenKind: "darwin-lstart-argv-nonce", startToken }));
			const harness = makeRecoveryHarness(stateDir, [], {
				platform: "darwin",
				posixProcessIdentityInspector: () => ({ startTokenKind: "darwin-lstart-argv-nonce", startToken, pgid: groupId, sentinelNonce: nonce }),
				persistedTreeKiller: pid => { killCalls.push(pid); return "signalled"; },
			});
			(harness as any)._waitForPidToExit = async () => true;
			await expect((harness as any)._reapRecoveredPosixSentinel({
				name: "Exact Darwin sentinel", type: "command", status: "running", startedAt: Date.now(),
				pid: groupId, pidNonce: nonce, sentinelFile,
			})).resolves.toBeUndefined();
			expect(killCalls).toEqual([groupId]);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("keeps an exit-file command active until recovered sentinel cleanup settles", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-exit-sentinel-cleanup-"));
		const exitFile = path.join(stateDir, "command.exit");
		fs.writeFileSync(exitFile, "0\n");
		const step: any = { name: "Recovered", type: "command", status: "passed", startedAt: Date.now(), exitFile, sentinelCleanupPending: true };
		const active: any = { goalId: "goal", gateId: "implementation", signalId: "sig", overallStatus: "running", startedAt: Date.now(), currentPhase: 0, steps: [step] };
		let calls = 0;
		const harness = makeRecoveryHarness(stateDir, [], {
			recoveredSentinelReaper: async target => {
				calls++;
				if (calls === 1) throw Object.assign(new Error("pending sentinel cleanup"), { name: "PendingCommandCleanupError" });
				delete target.sentinelCleanupPending;
			},
		});
		try {
			const pending = await (harness as any)._killPersistedCommandSteps(active, "SIGKILL", { markIntent: false });
			expect(pending).toBe(false);
			expect(step.sentinelCleanupPending).toBe(true);
			expect((harness as any)._hasPendingCommandKillCleanup(active)).toBe(true);
			const settled = await (harness as any)._killPersistedCommandSteps(active, "SIGKILL", { markIntent: false });
			expect(settled).toBe(true);
			expect(calls).toBe(2);
			expect((harness as any)._hasPendingCommandKillCleanup(active)).toBe(false);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("cancels terminal-goal crash recovery before pending cleanup retries delete it", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-terminal-sentinel-cleanup-"));
		const exitFile = path.join(stateDir, "command.exit");
		fs.writeFileSync(exitFile, "0\n");
		const signalId = "terminal-signal";
		fs.writeFileSync(path.join(stateDir, "active-verifications.json"), JSON.stringify({ verifications: [{
			goalId: "terminal-goal", gateId: "implementation", signalId, overallStatus: "running", startedAt: Date.now(), currentPhase: 0,
			steps: [{ name: "Recovered", type: "command", status: "running", startedAt: Date.now(), exitFile, sentinelCleanupPending: true }],
		}] }));
		let retry: (() => Promise<void>) | undefined;
		let reapCalls = 0;
		const calls: Array<{ kind: string; status: string }> = [];
		try {
			const harness = makeRecoveryHarness(stateDir, calls, {
				projectContextManager: { getContextForGoal: () => ({ goalStore: { get: () => ({ state: "complete" }) } }) },
				clock: { setTimeout: (fn: () => Promise<void>) => { retry = fn; return { unref() {} }; }, clearTimeout() {} },
				recoveredSentinelReaper: async step => {
					reapCalls++;
					if (reapCalls === 1) throw Object.assign(new Error("pending"), { name: "PendingCommandCleanupError" });
					delete step.sentinelCleanupPending;
				},
			});
			await harness.resumeInterruptedVerifications();
			const pending = JSON.parse(fs.readFileSync(path.join(stateDir, "active-verifications.json"), "utf8")).verifications[0];
			expect(pending).toMatchObject({ signalId, cancelled: true, overallStatus: "cancelled" });
			expect(retry).toBeTypeOf("function");
			await retry!();
			expect(harness.getActiveVerifications()).toEqual([]);
			expect(fs.existsSync(path.join(stateDir, "active-verifications.json"))).toBe(false);
			expect(calls).toEqual([]);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("fails Windows restart survival closed before the Job acknowledgement", async () => {
		const root = fakeChild(2_147_483_646);
		const tracked = spawnTracked("node", ["worker"], {
			platform: "win32",
			spawnImpl: (() => root) as unknown as NativeSpawn,
			windowsJobSupervisor: true,
		});
		tracked.markSurvival();
		killAllTracked();
		expect(root.killCalls).toEqual(["SIGKILL"]);
		root.emit("close", 0, null);
		await expect(tracked.ownershipReady).rejects.toThrow("Windows Job ownership was not established");
	});

	it("preserves a Windows survival child only after the pre-resume Job acknowledgement", async () => {
		const root = fakeChild(2_147_483_645);
		const spawnImpl = ((_cmd: string, _args: string[], options: SpawnOptions) => {
			const encoded = options.env?.BOBBIT_WINDOWS_JOB_PAYLOAD;
			const readyFile = options.env?.BOBBIT_WINDOWS_JOB_READY_FILE;
			expect(encoded).toEqual(expect.any(String));
			expect(readyFile).toEqual(expect.any(String));
			fs.writeFileSync(`${readyFile}.tmp`, "ready");
			fs.renameSync(`${readyFile}.tmp`, readyFile!);
			return root;
		}) as unknown as NativeSpawn;
		const tracked = spawnTracked("node", ["worker"], {
			platform: "win32",
			spawnImpl,
			windowsJobSupervisor: true,
		});
		await tracked.ownershipReady;
		tracked.markSurvival();
		killAllTracked();
		expect(root.killCalls).toEqual([]);
		root.emit("close", 0, null);
	});

	it("does not re-register a POSIX child whose readiness pipe is missing", async () => {
		const root = fakeChild(123_457);
		Object.defineProperty(root, "stdio", { value: [null, null, null] });
		const before = _trackedCount();
		const tracked = spawnTracked("node", ["worker"], {
			platform: "linux",
			spawnImpl: (() => root) as unknown as NativeSpawn,
			posixTreeSentinel: true,
			isProcessGroupAlive: () => false,
		});
		await expect(tracked.ownershipReady).rejects.toThrow("POSIX sentinel ownership was not established");
		expect(_trackedCount()).toBe(before);
		root.emit("close", 0, null);
	});

	it("reaps a POSIX survival child before readiness but preserves it after readiness", () => {
		const pendingRoot = fakeChild(123_458);
		const pendingSignals: NodeJS.Signals[] = [];
		const pending = spawnTracked("node", ["worker"], {
			platform: "linux",
			spawnImpl: (() => pendingRoot) as unknown as NativeSpawn,
			posixTreeSentinel: true,
			isProcessGroupAlive: () => true,
			signalProcessGroup: (_pgid, signal) => { pendingSignals.push(signal); },
		});
		pending.markSurvival();
		killAllTracked();
		expect(pendingSignals).toEqual(["SIGKILL"]);
		pendingRoot.emit("close", null, "SIGKILL");

		const readyRoot = fakeChild(123_459);
		const readySignals: NodeJS.Signals[] = [];
		const ready = spawnTracked("node", ["worker"], {
			platform: "linux",
			spawnImpl: (() => readyRoot) as unknown as NativeSpawn,
			posixTreeSentinel: true,
			isProcessGroupAlive: () => true,
			signalProcessGroup: (_pgid, signal) => { readySignals.push(signal); },
		});
		ready.markSurvival();
		readyRoot.readyPipe.emit("data", Buffer.from("."));
		killAllTracked();
		expect(readySignals).toEqual([]);
		ready.killTree("SIGKILL");
		readyRoot.emit("close", null, "SIGKILL");
	});

	it("Windows treats root exit as a PID-reuse boundary, even before inherited stdio closes", async () => {
		const clock = createManualClock(0);
		const root = fakeChild(2_147_483_647);
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const spawnImpl = ((cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return root;
		}) as unknown as NativeSpawn;
		const tracked = spawnTracked("node", ["worker"], {
			platform: "win32",
			spawnImpl,
			clock,
			timeoutMs: 50,
		});

		// `close` can lag because descendants retain inherited stdio, but after
		// `exit` this numeric PID is no longer safe to target: Windows may reuse it.
		root.emit("exit", 0, null);
		clock.advance(50);
		expect(tracked.timedOut()).toBe(true);
		expect(await tracked.waitForTreeExit(0)).toBe(false);
		expect(calls).toEqual([{ cmd: "node", args: ["worker"] }]);

		root.emit("close", 0, null);
		tracked.killTree();
		expect(calls).toHaveLength(1);
	});

	it("Windows Job timeout is armed deterministically and joins supervisor close without PID retargeting", async () => {
		const clock = createManualClock(0);
		const root = fakeChild(2_147_483_647);
		const tracked = spawnTracked("node", ["worker"], {
			platform: "win32",
			spawnImpl: ((_cmd: string, _args: string[], options: SpawnOptions) => {
				fs.writeFileSync(String(options.env?.BOBBIT_WINDOWS_JOB_READY_FILE), "ready");
				return root;
			}) as unknown as NativeSpawn,
			windowsJobSupervisor: true,
			clock,
			timeoutMs: 50,
		});

		await tracked.ownershipReady;
		clock.advance(50);
		expect(tracked.timedOut()).toBe(true);
		expect(root.killCalls).toEqual(["SIGTERM"]);
		const completion = tracked.waitForTreeExit(1_000);
		root.emit("exit", null, "SIGTERM");
		root.emit("close", null, "SIGTERM");
		expect(await completion).toBe(true);
	});

	it("Windows supervises the payload from spawn and joins its Job close without PID retargeting", async () => {
		const root = fakeChild(2_147_483_647);
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const spawnImpl = ((cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return root;
		}) as unknown as NativeSpawn;
		const tracked = spawnTracked("node", ["worker"], {
			platform: "win32",
			spawnImpl,
			windowsJobSupervisor: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].cmd).toBe("powershell.exe");
		expect(calls[0].args).toContain("-EncodedCommand");
		tracked.killTree("SIGTERM");
		expect(root.killCalls).toEqual(["SIGTERM"]);

		const completion = tracked.waitForTreeExit(1_000);
		root.emit("exit", null, "SIGTERM");
		root.emit("close", null, "SIGTERM");
		expect(await completion).toBe(true);
		tracked.killTree("SIGKILL");
		expect(root.killCalls).toEqual(["SIGTERM"]);
		expect(calls).toHaveLength(1);
	});

	it("Windows refuses a platform seam without spawn-time Job ownership", async () => {
		const root = fakeChild(2_147_483_647);
		const tracked = spawnTracked("node", ["worker"], {
			platform: "win32",
			spawnImpl: (() => root) as unknown as NativeSpawn,
		});
		root.emit("exit", 0, null);
		expect(await tracked.waitForTreeExit(0)).toBe(false);
		expect(root.killCalls).toEqual([]);
	});

	it("unrefs the parent FD-3 handle after survival is durably acknowledged", () => {
		const root = fakeChild(123_454);
		const tracked = spawnTracked("node", ["worker"], {
			platform: "linux",
			spawnImpl: (() => root) as unknown as NativeSpawn,
			posixTreeSentinel: true,
		});

		tracked.markSurvival();
		expect(root.readyPipe.unrefCalls).toBe(0);
		root.readyPipe.emit("data", Buffer.from("."));
		expect(root.readyPipe.unrefCalls).toBe(1);
	});

	it("dispatches immediate POSIX SIGKILL without waiting for the FD-3 acknowledgement", () => {
		const root = fakeChild(123_454);
		const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
		const tracked = spawnTracked("node", ["worker"], {
			platform: "linux",
			spawnImpl: (() => root) as unknown as NativeSpawn,
			posixTreeSentinel: true,
			isProcessGroupAlive: () => true,
			signalProcessGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
		});

		tracked.killTree("SIGKILL");
		expect(signals).toEqual([{ pgid: 123_454, signal: "SIGKILL" }]);
	});

	it("queues an immediate POSIX kill until the sentinel confirms group ownership", () => {
		const root = fakeChild(123_455);
		const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
		const tracked = spawnTracked("node", ["worker"], {
			platform: "linux",
			spawnImpl: (() => root) as unknown as NativeSpawn,
			posixTreeSentinel: true,
			isProcessGroupAlive: () => true,
			signalProcessGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
		});

		tracked.killTree("SIGTERM", 0);
		expect(signals).toEqual([]);
		root.readyPipe.emit("data", Buffer.from("."));
		expect(signals).toEqual([{ pgid: 123_455, signal: "SIGTERM" }]);
		root.emit("exit", null, "SIGTERM");
		expect(signals).toEqual([
			{ pgid: 123_455, signal: "SIGTERM" },
			{ pgid: 123_455, signal: "SIGKILL" },
		]);
	});

	it("POSIX synchronously finalizes a live group at root exit and never rearms its PGID", async () => {
		const clock = createManualClock(0);
		const root = fakeChild(123_456);
		const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
		let groupAlive = true;
		const tracked = spawnTracked("node", ["worker"], {
			platform: "linux",
			spawnImpl: (() => root) as unknown as NativeSpawn,
			clock,
			killGraceMs: 50,
			posixTreeSentinel: true,
			isProcessGroupAlive: () => groupAlive,
			signalProcessGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
		});

		root.readyPipe.emit("data", Buffer.from("."));
		tracked.killTree("SIGTERM");
		expect(signals).toEqual([{ pgid: 123_456, signal: "SIGTERM" }]);

		// The root exits while a descendant still retains stdio. The final kill is
		// dispatched synchronously in that exit callback, before a later empty
		// group could make the numeric PGID reusable.
		root.emit("exit", 0, null);
		expect(signals).toEqual([
			{ pgid: 123_456, signal: "SIGTERM" },
			{ pgid: 123_456, signal: "SIGKILL" },
		]);
		groupAlive = false;
		expect(await tracked.waitForTreeExit()).toBe(true);
		clock.advance(50);
		tracked.killTree("SIGKILL");
		expect(signals).toHaveLength(2);
	});

	it("retains only a container transport sentinel through root exit until the explicit handoff reap", async () => {
		const root = fakeChild(123_456);
		const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
		let groupAlive = true;
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-transport-handoff-"));
		const identityFile = path.join(stateDir, "sentinel.json");
		const nonce = "container-transport-nonce";
		fs.writeFileSync(identityFile, JSON.stringify({ pid: 654_321, pgid: root.pid, nonce, startTokenKind: "linux-proc-stat-22", startToken: "exact-start" }));
		const tracked = spawnTracked("docker", ["exec"], {
			platform: "linux",
			spawnImpl: (() => root) as unknown as NativeSpawn,
			posixTreeSentinel: true,
			posixSentinelIdentity: { file: identityFile, nonce },
			posixSentinelIdentityInspector: pid => pid === 654_321 ? { pgid: root.pid!, startTokenKind: "linux-proc-stat-22", startToken: "exact-start" } : undefined,
			retainPosixSentinelForContainerTransport: true,
			isProcessGroupAlive: () => groupAlive,
			signalProcessGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
		});

		try {
			root.readyPipe.emit("data", Buffer.from("."));
			root.emit("exit", 0, null);
			// Normal POSIX commands synchronously SIGKILL here. A durable docker-exec
			// transport instead leaves its exact in-group sentinel for payload cleanup
			// and crash recovery.
			expect(signals).toEqual([]);

			tracked.killTree("SIGKILL");
			expect(signals).toEqual([{ pgid: 123_456, signal: "SIGKILL" }]);
			groupAlive = false;
			expect(await tracked.waitForTreeExit(0)).toBe(true);
			root.emit("close", 0, null);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("keeps a retained transport pending when its sentinel is absent or reused", async () => {
		const root = fakeChild(123_458);
		const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-transport-stale-"));
		const identityFile = path.join(stateDir, "sentinel.json");
		const nonce = "container-transport-stale-nonce";
		fs.writeFileSync(identityFile, JSON.stringify({ pid: 654_322, pgid: root.pid, nonce, startTokenKind: "linux-proc-stat-22", startToken: "original-start" }));
		const tracked = spawnTracked("docker", ["exec"], {
			platform: "linux",
			spawnImpl: (() => root) as unknown as NativeSpawn,
			posixTreeSentinel: true,
			posixSentinelIdentity: { file: identityFile, nonce },
			posixSentinelIdentityInspector: () => ({ pgid: root.pid!, startTokenKind: "linux-proc-stat-22", startToken: "reused-start" }),
			retainPosixSentinelForContainerTransport: true,
			isProcessGroupAlive: () => true,
			signalProcessGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
		});

		try {
			root.readyPipe.emit("data", Buffer.from("."));
			root.emit("exit", 0, null);
			tracked.killTree("SIGKILL");
			expect(signals).toEqual([]);
			expect(await tracked.waitForTreeExit(0)).toBe(false);
			root.emit("close", 0, null);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("POSIX timeout firing after root exit never signals an unrelated recycled group", async () => {
		const clock = createManualClock(0);
		const root = fakeChild(123_457);
		const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
		const tracked = spawnTracked("node", ["worker"], {
			platform: "linux",
			spawnImpl: (() => root) as unknown as NativeSpawn,
			clock,
			timeoutMs: 50,
			posixTreeSentinel: true,
			isProcessGroupAlive: () => true,
			signalProcessGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
		});

		root.readyPipe.emit("data", Buffer.from("."));
		root.emit("exit", 0, null);
		clock.advance(50);

		expect(tracked.timedOut()).toBe(true);
		// The timeout sees a root that has already exited, but the exit callback
		// already synchronously finalized the still-owned group. It never emits a
		// later SIGTERM against a possibly recycled numeric PGID.
		expect(signals).toEqual([{ pgid: 123_457, signal: "SIGKILL" }]);
		expect(await tracked.waitForTreeExit(0)).toBe(false);
	});

	it("Windows never signals a supervisor after it has closed", () => {
		const root = fakeChild(2_147_483_647);
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const spawnImpl = ((cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return root;
		}) as unknown as NativeSpawn;
		const tracked = spawnTracked("node", ["worker"], { platform: "win32", spawnImpl });

		root.emit("close", 0, null);
		tracked.killTree();
		expect(calls).toEqual([{ cmd: "node", args: ["worker"] }]);
	});

	it("never retargets a persisted Windows PID or falls back after a lost POSIX group", () => {
		const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		const killImpl = (pid: number, signal: NodeJS.Signals) => {
			calls.push({ pid, signal });
			throw new Error("original process group is gone");
		};

		expect(killTreeByPid(424_242, "SIGKILL", { platform: "win32", killImpl })).toBe("unsupported");
		expect(calls).toEqual([]);

		expect(killTreeByPid(424_242, "SIGKILL", { platform: "linux", killImpl })).toBe("invalid");
		expect(calls).toEqual([{ pid: -424_242, signal: "SIGKILL" }]);
	});
});


// PID reuse regression retained from the required RED gate.
const CONTAINER_ID = "container-under-test";
const VERIFICATION_NONCE = "pid-reuse-verification-nonce";
const SENTINEL_PID = 321_654;
const ORIGINAL_START_TOKEN = "original-sentinel-start-token";
const REUSED_START_TOKEN = "reused-sentinel-start-token";
const WITNESS_START_TOKEN_MISMATCH = "BOBBIT_CONTAINER_WITNESS_START_TOKEN_MISMATCH";

function makeHarness(
	stateDir: string,
	containerProcessIdentityInspector: (containerId: string, pid: number) => Promise<{ pid: number; pgid: number; startToken: string } | undefined> = async (containerId: string, pid: number) => {
		// The recovered process has reused the sentinel's historical numeric PID
		// and remains a PGID leader. Only its Linux start token exposes that it is
		// unrelated work in this shared container.
		assert.equal(containerId, CONTAINER_ID);
		assert.equal(pid, SENTINEL_PID);
		return { pid: SENTINEL_PID, pgid: SENTINEL_PID, startToken: REUSED_START_TOKEN };
	},
	containerProcessTopSnapshot: () => Promise<readonly { pid: number; ppid: number; pgid: number; state: string; args: string }[]> = async () => [{ pid: 1, ppid: 1, pgid: 1, state: "S", args: "init" }],
): VerificationHarness {
	return new VerificationHarness(
		stateDir,
		{
			updateSignalVerification: () => {},
			updateGateStatus: () => {},
			getGate: () => undefined,
		} as any,
		() => {},
		{ get: () => undefined, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ platform: "linux", containerProcessIdentityInspector, containerProcessTopSnapshot } as any,
	);
}

/** Match every supported shell spelling before recording a destructive PGID signal. */
function isDestructiveContainerGroupSignal(command: string): boolean {
	return /\bkill\s+-(?:TERM|KILL)\s+(?:--\s+)?-["']?(?:\$\{?\w+\}?|\d+)/.test(command);
}

function recoveredContainerStep(overrides: Record<string, unknown> = {}): any {
	return {
		name: "Recovered container command",
		type: "command",
		status: "running",
		phase: 0,
		startedAt: Date.now() - 1_000,
		startTimeMs: Date.now() - 1_000,
		deadlineMs: Date.now() - 1,
		containerId: CONTAINER_ID,
		restartRecoveryMode: "container-exec",
		exitFile: "/tmp/.bobbit-verif/witness.exit",
		pidFile: "/tmp/.bobbit-verif/witness.pid",
		pidNonce: VERIFICATION_NONCE,
		...recoveredContainerOwnership(VERIFICATION_NONCE, { containerId: CONTAINER_ID, sentinelPid: SENTINEL_PID, startToken: ORIGINAL_START_TOKEN, execId: "engine-exec", enginePid: 77, enginePgid: SENTINEL_PID, tag: "attested-sentinel" }),
		...overrides,
	};
}

async function invokeRecoveredContainerCleanup(
	harness: VerificationHarness,
	step: any,
	signalAttempts: string[],
	active?: ActiveVerification,
): Promise<unknown> {
	(harness as any)._dockerExecCapture = async (containerId: string, command: string) => {
		assert.equal(containerId, CONTAINER_ID);
		if (isDestructiveContainerGroupSignal(command)) signalAttempts.push(command);
		return { code: 0, stdout: "" };
	};
	const recovery = active ?? {
		goalId: "goal-container-witness",
		gateId: "implementation",
		signalId: `sig-container-witness-${step.name}`,
		overallStatus: "running",
		startedAt: Date.now(),
		currentPhase: 0,
		steps: [step],
	} satisfies ActiveVerification;
	(harness as any).activeVerifications.set(recovery.signalId, recovery);
	try {
		await (harness as any)._resumeContainerCommandStep(recovery, step, {
			finalize: () => { throw new Error("must not finalize before failed-closed cleanup settles"); },
			timeoutResult: () => { throw new Error("must not publish a timeout before failed-closed cleanup settles"); },
			restartInterrupted: () => { throw new Error("must not publish a retryable verdict before failed-closed cleanup settles"); },
		});
	} catch (error) {
		return error;
	}
	throw new Error("expected recovered container cleanup to remain pending");
}

function expectFailedClosedWitness(step: any, error: unknown, signalAttempts: string[], diagnostic: string): void {
	expect(signalAttempts).toEqual([]);
	expect(step.killUnsafeReason).toBe(diagnostic);
	expect(step.containerPayloadCleanupPending).toBe(true);
	expect(String((error as Error | undefined)?.message)).toContain(diagnostic);
}

function containerWitness(nonce: string, sentinelPid = SENTINEL_PID, startToken = ORIGINAL_START_TOKEN): Record<string, unknown> {
	return { containerId: CONTAINER_ID, nonce, sentinelPid, pgid: sentinelPid, startToken };
}

async function expectRecoveredContainerWitnessRejection(stateDir: string, step: any, diagnostic: string, inspect: () => Promise<any>, expectedInspections?: number): Promise<void> {
	const signalAttempts: string[] = [];
	let inspections = 0;
	const harness = makeHarness(stateDir, async () => { inspections++; return inspect(); });
	const error = await invokeRecoveredContainerCleanup(harness, step, signalAttempts);
	if (expectedInspections != null) expect(inspections).toBe(expectedInspections);
	expectFailedClosedWitness(step, error, signalAttempts, diagnostic);
}

test("PID-reused container sentinel never authorizes a negative-PGID signal", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-witness-pid-reuse-"));
	const signalAttempts: string[] = [];
	try {
		const harness = makeHarness(stateDir);
		(harness as any)._dockerExecCapture = async (containerId: string, command: string) => {
			assert.equal(containerId, CONTAINER_ID);
			if (isDestructiveContainerGroupSignal(command)) {
				// Record the resolved destructive target rather than the shell
				// variable used by the transport script, making the RED diagnostic
				// independent of whether the transport uses an optional `--`.
				signalAttempts.push(`kill -TERM -${SENTINEL_PID}`);
			}
			// The unsafe historical recovery implementation reaches this response
			// after finding no exit file, then attempts to signal -321654. The fixed
			// implementation must reject its exact witness before issuing this call.
			return { code: 0, stdout: "" };
		};

		const step = recoveredContainerStep({
			name: "PID-reused recovered container command",
			exitFile: "/tmp/.bobbit-verif/pid-reuse.exit",
			pidFile: "/tmp/.bobbit-verif/pid-reuse.pid",
		});
		const active: ActiveVerification = {
			goalId: "goal-container-pid-reuse",
			gateId: "implementation",
			signalId: "sig-container-pid-reuse",
			overallStatus: "running",
			startedAt: Date.now(),
			currentPhase: 0,
			steps: [step],
		};

		// Recovery helpers only act on the exact active-verification instance the
		// harness loaded from durable state; an unregistered object intentionally
		// behaves as a cancelled resume and would hide the destructive path.
		(harness as any).activeVerifications.set(active.signalId, active);

		let cleanupError: unknown;
		try {
			await (harness as any)._resumeContainerCommandStep(active, step, {
				finalize: () => { throw new Error("must not finalize a PID-reused container command"); },
				timeoutResult: () => { throw new Error("must not publish a timeout before exact container cleanup"); },
				restartInterrupted: () => { throw new Error("must preserve failed-closed cleanup as pending"); },
			});
		} catch (error) {
			cleanupError = error;
		}

		assert.deepEqual(
			signalAttempts,
			[],
			`${WITNESS_START_TOKEN_MISMATCH}: a reused in-container sentinel PID must never receive a negative-PGID signal`,
		);
		assert.equal(step.killUnsafeReason, WITNESS_START_TOKEN_MISMATCH);
		assert.equal(step.containerPayloadCleanupPending, true, "identity loss remains durable retryable cleanup");
		assert.match(String((cleanupError as Error | undefined)?.message), new RegExp(WITNESS_START_TOKEN_MISMATCH));
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test.each([
	["missing witness", recoveredContainerStep({ containerOwnershipWitness: undefined, containerWitnessFile: undefined }), "BOBBIT_CONTAINER_WITNESS_MISSING"],
	["legacy PID-only evidence", recoveredContainerStep({ containerOwnershipWitness: undefined, containerWitnessFile: undefined, pid: SENTINEL_PID, pgid: SENTINEL_PID }), "BOBBIT_CONTAINER_WITNESS_MISSING"],
] as const)("recovered container cleanup rejects %s without a destructive signal", async (_caseName, step, diagnostic) => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-witness-missing-"));
	try {
		await expectRecoveredContainerWitnessRejection(stateDir, step, diagnostic, async () => ({ pid: SENTINEL_PID, pgid: SENTINEL_PID, startToken: ORIGINAL_START_TOKEN }), 0);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("recovered container cleanup rejects a nonce-mismatched witness before inspecting or signalling", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-witness-nonce-"));
	try {
		const step = recoveredContainerStep({ containerOwnershipWitness: containerWitness("other-step-nonce") });
		await expectRecoveredContainerWitnessRejection(stateDir, step, "BOBBIT_CONTAINER_WITNESS_NONCE_MISMATCH", async () => ({ pid: SENTINEL_PID, pgid: SENTINEL_PID, startToken: ORIGINAL_START_TOKEN }), 0);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("recovered container cleanup rejects a live sentinel PGID mismatch without signalling", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-witness-pgid-"));
	try {
		await expectRecoveredContainerWitnessRejection(stateDir, recoveredContainerStep(), "BOBBIT_CONTAINER_WITNESS_PGID_MISMATCH", async () => ({
			pid: SENTINEL_PID, pgid: SENTINEL_PID + 1, startToken: ORIGINAL_START_TOKEN,
		}));
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("same-container steps cannot authorize each other's deliberately crossed witnesses", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-witness-crossed-"));
	try {
		const first = recoveredContainerStep({
			name: "same-container-first",
			pidNonce: "first-step-nonce",
			containerOwnershipWitness: containerWitness("second-step-nonce", 111_111, "second-start"),
		});
		const second = recoveredContainerStep({
			name: "same-container-second",
			pidNonce: "second-step-nonce",
			containerOwnershipWitness: containerWitness("first-step-nonce", 222_222, "first-start"),
		});
		const signalAttempts: string[] = [];
		const harness = makeHarness(stateDir, async () => {
			throw new Error("crossed witnesses must fail before live identity inspection");
		});
		const active: ActiveVerification = {
			goalId: "goal-container-witness-crossed",
			gateId: "implementation",
			signalId: "sig-container-witness-crossed",
			overallStatus: "running",
			startedAt: Date.now(),
			currentPhase: 0,
			steps: [first, second],
		};
		const firstError = await invokeRecoveredContainerCleanup(harness, first, signalAttempts, active);
		const secondError = await invokeRecoveredContainerCleanup(harness, second, signalAttempts, active);
		expectFailedClosedWitness(first, firstError, signalAttempts, "BOBBIT_CONTAINER_WITNESS_NONCE_MISMATCH");
		expectFailedClosedWitness(second, secondError, signalAttempts, "BOBBIT_CONTAINER_WITNESS_NONCE_MISMATCH");
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("zombie-only container group completes exact cleanup", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-zombie-cleanup-"));
	try {
		const signalAttempts: string[] = [];
		const harness = makeHarness(
			stateDir,
			async () => ({ pid: SENTINEL_PID, pgid: SENTINEL_PID, startToken: ORIGINAL_START_TOKEN }),
			async () => [
				{ pid: SENTINEL_PID, ppid: 1, pgid: SENTINEL_PID, state: "Z", args: "sentinel" },
				{ pid: SENTINEL_PID + 1, ppid: 1, pgid: SENTINEL_PID, state: "Z", args: "payload" },
				{ pid: 1, ppid: 1, pgid: 1, state: "S", args: "init" },
			],
		);
		(harness as any)._dockerExecCapture = async (_containerId: string, command: string) => {
			if (isDestructiveContainerGroupSignal(command)) signalAttempts.push(command);
			return { code: 0, stdout: "" };
		};
		const step = recoveredContainerStep();
		await expect((harness as any)._killAndVerifyRecoveredContainerProcessGroup(step)).resolves.toBeUndefined();
		expect(signalAttempts).toHaveLength(1);
		expect(step.containerPayloadCleanupCompletedAt).toEqual(expect.any(Number));
		expect(step.containerPayloadCleanupPending).toBeUndefined();
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test.each([
	["a mixed zombie and live member", async () => [
		{ pid: SENTINEL_PID, ppid: 1, pgid: SENTINEL_PID, state: "Z", args: "sentinel" },
		{ pid: SENTINEL_PID + 1, ppid: 1, pgid: SENTINEL_PID, state: "S", args: "live-payload" },
	]],
	["a live exact-group member", async () => [
		{ pid: SENTINEL_PID, ppid: 1, pgid: SENTINEL_PID, state: "R", args: "reused-group-member" },
	]],
	["malformed Engine evidence", async () => { throw new Error("Docker Engine top response contained a malformed process row"); }],
	["an empty Engine snapshot", async () => []],
] as const)("container cleanup remains pending for %s", async (_caseName, snapshot) => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-live-cleanup-"));
	try {
		const harness = makeHarness(
			stateDir,
			async () => ({ pid: SENTINEL_PID, pgid: SENTINEL_PID, startToken: ORIGINAL_START_TOKEN }),
			snapshot,
		);
		(harness as any)._dockerExecCapture = async () => ({ code: 0, stdout: "" });
		const step = recoveredContainerStep();
		await expect((harness as any)._killAndVerifyRecoveredContainerProcessGroup(step)).rejects.toThrow(/cleanup is not yet safe or complete/);
		expect(step.containerPayloadCleanupCompletedAt).toBeUndefined();
		expect(step.containerPayloadCleanupPending).toBe(true);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a persisted container signal attempt converges through Engine observation after its sentinel exits", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-observation-retry-"));
	try {
		let sentinelLive = true;
		let snapshot = 0;
		const signals: string[] = [];
		const harness = makeHarness(
			stateDir,
			async () => sentinelLive ? { pid: SENTINEL_PID, pgid: SENTINEL_PID, startToken: ORIGINAL_START_TOKEN } : undefined,
			async () => ++snapshot === 1
				? [{ pid: SENTINEL_PID, ppid: 1, pgid: SENTINEL_PID, state: "S", args: "still-draining" }]
				: [{ pid: 1, ppid: 1, pgid: 1, state: "S", args: "init" }],
		);
		(harness as any)._dockerExecCapture = async (_containerId: string, command: string) => {
			if (isDestructiveContainerGroupSignal(command)) signals.push(command);
			return { code: 0, stdout: "" };
		};
		const step = recoveredContainerStep();
		(harness as any).activeVerifications.set("sig-container-observation-retry", {
			goalId: "goal", gateId: "implementation", signalId: "sig-container-observation-retry", overallStatus: "running", startedAt: Date.now(), steps: [step],
		});

		await expect((harness as any)._killAndVerifyRecoveredContainerProcessGroup(step)).rejects.toThrow(/BOBBIT_CONTAINER_GROUP_REMAINS/);
		expect(step.containerPayloadSignalAttemptedAt).toEqual(expect.any(Number));
		expect(signals).toHaveLength(1);
		sentinelLive = false;
		await expect((harness as any)._killAndVerifyRecoveredContainerProcessGroup(step)).resolves.toBeUndefined();
		expect(signals).toHaveLength(1);
		expect(step.containerPayloadCleanupCompletedAt).toEqual(expect.any(Number));
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a persisted container signal attempt survives an Engine failure and reload without re-signalling", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-observation-reload-"));
	try {
		const signals: string[] = [];
		const live = async () => ({ pid: SENTINEL_PID, pgid: SENTINEL_PID, startToken: ORIGINAL_START_TOKEN });
		const harness = makeHarness(stateDir, live, async () => {
			throw new Error("Engine temporarily unavailable");
		});
		(harness as any)._dockerExecCapture = async (_containerId: string, command: string) => {
			if (isDestructiveContainerGroupSignal(command)) signals.push(command);
			return { code: 0, stdout: "" };
		};
		const step = recoveredContainerStep();
		const active = { goalId: "goal", gateId: "implementation", signalId: "sig-container-observation-reload", overallStatus: "running", startedAt: Date.now(), steps: [step] };
		(harness as any).activeVerifications.set(active.signalId, active);
		await expect((harness as any)._killAndVerifyRecoveredContainerProcessGroup(step)).rejects.toThrow(/snapshot was unavailable/);
		expect(JSON.parse(fs.readFileSync(path.join(stateDir, "active-verifications.json"), "utf8")).verifications[0].steps[0].containerPayloadSignalAttemptedAt).toEqual(expect.any(Number));
		expect(signals).toHaveLength(1);

		const resumed = makeHarness(stateDir, async () => undefined, async () => [{ pid: 1, ppid: 1, pgid: 1, state: "S", args: "init" }]);
		const reloaded = JSON.parse(fs.readFileSync(path.join(stateDir, "active-verifications.json"), "utf8")).verifications[0];
		(resumed as any).activeVerifications.set(reloaded.signalId, reloaded);
		(resumed as any)._dockerExecCapture = async (_containerId: string, command: string) => {
			if (isDestructiveContainerGroupSignal(command)) signals.push(command);
			return { code: 0, stdout: "" };
		};
		await expect((resumed as any)._killAndVerifyRecoveredContainerProcessGroup(reloaded.steps[0])).resolves.toBeUndefined();
		expect(signals).toHaveLength(1);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("observation-only recovery leaves a reused attested Engine PGID pending without a signal", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-observation-reuse-"));
	try {
		const signals: string[] = [];
		const harness = makeHarness(
			stateDir,
			async () => undefined,
			async () => [{ pid: SENTINEL_PID + 44, ppid: 1, pgid: SENTINEL_PID, state: "S", args: "unrelated-reused-group" }],
		);
		(harness as any)._dockerExecCapture = async (_containerId: string, command: string) => {
			if (isDestructiveContainerGroupSignal(command)) signals.push(command);
			return { code: 0, stdout: "" };
		};
		const step = recoveredContainerStep({ containerPayloadSignalAttemptedAt: Date.now() - 1 });
		(harness as any).activeVerifications.set("sig-container-observation-reuse", {
			goalId: "goal", gateId: "implementation", signalId: "sig-container-observation-reuse", overallStatus: "running", startedAt: Date.now(), steps: [step],
		});
		await expect((harness as any)._killAndVerifyRecoveredContainerProcessGroup(step)).rejects.toThrow(/BOBBIT_CONTAINER_GROUP_REMAINS/);
		expect(signals).toEqual([]);
		expect(step.containerPayloadCleanupPending).toBe(true);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("container escalation revalidates the exact witness before TERM and KILL without a timing gap", async () => {
	const source = fs.readFileSync(new URL("../../src/server/agent/verification-harness.ts", import.meta.url), "utf8");
	const method = source.slice(source.indexOf("private async _killAndVerifyRecoveredContainerProcessGroup"), source.indexOf("private async _resumeContainerCommandStep"));
	const term = method.indexOf('kill -TERM -"$pgid"');
	const kill = method.indexOf('kill -KILL -"$pgid"');
	expect(term).toBeGreaterThan(-1);
	expect(kill).toBeGreaterThan(term);
	expect(method.slice(0, term).match(/\$\{verify\}/g)?.length).toBe(1);
	expect(method.slice(term, kill).match(/\$\{verify\}/g)?.length).toBe(1);
	expect(method.slice(term, kill)).not.toMatch(/sleep|setTimeout|setInterval/);
});
