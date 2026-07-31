import { describe, expect, it } from "vitest";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { killAllTracked, killTreeByPid, spawnTracked } from "../../src/server/agent/spawn-tree.js";
import { VerificationHarness, type ActiveVerification } from "../../src/server/agent/verification-harness.js";
import { createManualClock } from "../harness/clock.js";

const SPAWN_TREE_SOURCE = readFileSync(new URL("../../src/server/agent/spawn-tree.ts", import.meta.url), "utf8");

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
    const tracked = spawnTracked(process.execPath, ["-e", parentScript, grandchildScript, marker, mode === "natural" ? "exit-root" : "stay-root"], {
      // Capture the native supervisor's own diagnostics if it closes before
      // the marker; readiness itself never relies on stdio forwarding.
      stdio: ["ignore", "pipe", "pipe"],
      ...(mode === "timeout" ? { timeoutMs: 100, killGraceMs: 100 } : {}),
    });
    acknowledgement.attach(tracked);
    const grandchildPid = await acknowledgement.ready;
    if (mode === "cancel") tracked.killTree("SIGTERM", 0);
    if (tracked.child.exitCode === null && tracked.child.signalCode === null) await new Promise(resolve => tracked.child.once("exit", resolve));
    assert.equal(await tracked.waitForTreeExit(1500), true, mode + ": tracked tree should be exhausted");
    assert.equal(alive(grandchildPid), false, mode + ": SIGTERM-ignoring grandchild must be reaped");
    console.log(mode + "-tree-reaped");
  } catch (error) {
    acknowledgement.fail(error);
    throw error;
  } finally {
    fs.rmSync(markerDir, { recursive: true, force: true });
  }
}

// PowerShell must compile the native Job supervisor before the payload can
// publish readiness. On Windows exercise that native lifecycle directly, then
// cover timeout delivery deterministically below; POSIX retains its native
// timeout-tree probe because it has no cold supervisor compilation phase.
for (const mode of process.platform === "win32" ? ["natural", "cancel"] : ["natural", "timeout", "cancel"]) await run(mode);
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
await new Promise((resolve, reject) => {
  const ready = tracked.child.stdio[3];
  if (!ready) return reject(new Error("sentinel readiness pipe is unavailable"));
  ready.once("data", resolve);
  ready.once("error", reject);
});
if (!fs.existsSync(sentinelFile)) throw new Error("sentinel acknowledged before publishing its identity");
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
  pgid: process.env.BOBBIT_POSIX_SENTINEL_PGID,
};
const nested = spawnTracked("/bin/sh", ["-c", "exit 0"], { stdio: ["ignore", "ignore", "ignore", "pipe"], posixSentinelIdentity: { file: process.env.BOBBIT_NESTED_SENTINEL_FILE, nonce: "nested-nonce" } });
await new Promise((resolve, reject) => { const ready = nested.child.stdio[3]; if (!ready) return reject(new Error("missing nested ready")); ready.once("data", resolve); ready.once("error", reject); });
fs.writeFileSync(process.env.BOBBIT_NESTED_SENTINEL_RESULT, JSON.stringify({ inherited, nested: JSON.parse(fs.readFileSync(process.env.BOBBIT_NESTED_SENTINEL_FILE, "utf8")), outer: JSON.parse(fs.readFileSync(process.env.BOBBIT_OUTER_SENTINEL_FILE, "utf8")) }));
nested.killTree("SIGKILL");
`;

const NESTED_SENTINEL_PROBE = String.raw`
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnTracked } from ${JSON.stringify(new URL("../../src/server/agent/spawn-tree.ts", import.meta.url).href)};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-nested-sentinel-"));
const outerFile = path.join(dir, "outer.json"), nestedFile = path.join(dir, "nested.json"), resultFile = path.join(dir, "result.json");
const tracked = spawnTracked(process.execPath, ["--import", "tsx", "--input-type=module", "-e", ${JSON.stringify(NESTED_SENTINEL_PAYLOAD)}], { stdio: ["ignore", "ignore", "ignore", "pipe"], env: { ...process.env, BOBBIT_OUTER_SENTINEL_FILE: outerFile, BOBBIT_NESTED_SENTINEL_FILE: nestedFile, BOBBIT_NESTED_SENTINEL_RESULT: resultFile }, posixSentinelIdentity: { file: outerFile, nonce: "outer-nonce" } });
await new Promise((resolve, reject) => { const ready = tracked.child.stdio[3]; if (!ready) return reject(new Error("missing outer ready")); ready.once("data", resolve); ready.once("error", reject); });
await new Promise((resolve, reject) => { tracked.child.once("close", resolve); tracked.child.once("error", reject); });
const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
process.stdout.write(JSON.stringify(result) + "\n", () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); });
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
	deps: { platform?: NodeJS.Platform; posixProcessIdentityInspector?: (pid: number) => { startToken: string; pgid: number } | undefined; persistedTreeKiller?: (pid: number, signal?: NodeJS.Signals) => "signalled" | "unsupported" | "invalid"; recoveredSentinelReaper?: (step: any) => Promise<void>; projectContextManager?: any } = {},
): VerificationHarness {
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
		deps,
	);
}

describe("spawnTracked timeout cleanup", () => {
	it("keeps STARTUPINFO flags unsigned so the Windows Job supervisor Add-Type source compiles", () => {
		const startupInfo = SPAWN_TREE_SOURCE.match(/public struct STARTUPINFO \{(?<body>[^}]+)\}/s)?.groups?.body;
		expect(startupInfo).toContain("public uint dwFlags;");
		expect(SPAWN_TREE_SOURCE).toContain("si.dwFlags = STARTF_USESTDHANDLES;");
		expect(SPAWN_TREE_SOURCE).toContain("InheritableStdHandle(-10, GENERIC_READ, out ownIn)");
		expect(SPAWN_TREE_SOURCE).toContain("InheritableStdHandle(-11, GENERIC_WRITE, out ownOut)");
		expect(SPAWN_TREE_SOURCE).toContain("InheritableStdHandle(-12, GENERIC_WRITE, out ownErr)");
	});

	it("reaps SIGTERM-ignoring descendants through each native process model", async () => {
		const result = await runProbe();
		expect(result.code, result.stderr).toBe(0);
		for (const mode of ["natural", "cancel"]) expect(result.stdout).toContain(`${mode}-tree-reaped`);
		if (process.platform !== "win32") expect(result.stdout).toContain("timeout-tree-reaped");
	});

	it("reaps a recovered POSIX sentinel after its original parent exits", async () => {
		if (process.platform === "win32") {
			expect(process.platform).toBe("win32");
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
					pid: rootPid,
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
				// The tier-1 spawn guard blocks `ps`; the native probe above already
				// proves this is the separately-invoked live sentinel. Production uses
				// the default C-locale `ps` inspector.
				posixProcessIdentityInspector: pid => pid === sentinelIdentity.pid
					? { startToken: sentinelIdentity.startToken, pgid: sentinelIdentity.pgid }
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

	it("records the original group for a fast-exiting payload", async () => {
		if (process.platform === "win32") {
			expect(process.platform).toBe("win32");
			return;
		}
		const result = await runNativeJsonProbe(FAST_EXIT_SENTINEL_PROBE);
		expect(result.identity.pid).not.toBe(result.rootPid);
		expect(result.identity.pgid).toBe(result.rootPid);
		expect(result.identity.startToken).toEqual(expect.any(String));
	});

	it("scrubs outer sentinel identity before a nested tracked spawn", async () => {
		if (process.platform === "win32") {
			expect(process.platform).toBe("win32");
			return;
		}
		const result = await runNativeJsonProbe(NESTED_SENTINEL_PROBE);
		expect(result.inherited).toEqual({ file: undefined, nonce: undefined, script: undefined, pgid: undefined });
		expect(result.outer.nonce).toBe("outer-nonce");
		expect(result.nested.nonce).toBe("nested-nonce");
		expect(result.nested.pid).not.toBe(result.outer.pid);
	});

	it("does not acknowledge or leak when sentinel identity publishing fails", async () => {
		if (process.platform === "win32") {
			expect(process.platform).toBe("win32");
			return;
		}
		const result = await runNativeJsonProbe(IDENTITY_FAILURE_PROBE);
		expect(result).toEqual({ acknowledged: false, reaped: true });
	});

	it("refuses a reused POSIX sentinel PID before it can signal a group", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-reused-sentinel-"));
		const sentinelFile = path.join(stateDir, "sentinel.json");
		const groupId = 123_456;
		const nonce = "original-sentinel-nonce";
		fs.writeFileSync(sentinelFile, JSON.stringify({ pid: process.pid, pgid: groupId, nonce, startToken: "original-process" }));
		const killCalls: Array<{ pid: number; signal: NodeJS.Signals | undefined }> = [];
		try {
			const harness = makeRecoveryHarness(stateDir, [], {
				platform: "linux",
				posixProcessIdentityInspector: () => ({ startToken: "reused-process", pgid: groupId }),
				persistedTreeKiller: (pid, signal) => {
					killCalls.push({ pid, signal });
					return "signalled";
				},
			});
			await expect((harness as any)._reapRecoveredPosixSentinel({
				name: "Recovered command", type: "command", status: "running", startedAt: Date.now(),
				pid: groupId, pidNonce: nonce, sentinelFile,
			})).rejects.toThrow(/no longer matches its original process identity/i);
			expect(killCalls, "a mismatched live sentinel PID must not authorize any process-group signal").toEqual([]);
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

	it("keeps terminal-goal crash recovery active while sentinel cleanup is pending", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-terminal-sentinel-cleanup-"));
		const exitFile = path.join(stateDir, "command.exit");
		fs.writeFileSync(exitFile, "0\n");
		const signalId = "terminal-signal";
		fs.writeFileSync(path.join(stateDir, "active-verifications.json"), JSON.stringify({ verifications: [{
			goalId: "terminal-goal", gateId: "implementation", signalId, overallStatus: "running", startedAt: Date.now(), currentPhase: 0,
			steps: [{ name: "Recovered", type: "command", status: "running", startedAt: Date.now(), exitFile, sentinelCleanupPending: true }],
		}] }));
		try {
			const harness = makeRecoveryHarness(stateDir, [], {
				projectContextManager: { getContextForGoal: () => ({ goalStore: { get: () => ({ state: "complete" }) } }) },
				recoveredSentinelReaper: async () => { throw Object.assign(new Error("pending"), { name: "PendingCommandCleanupError" }); },
			});
			await harness.resumeInterruptedVerifications();
			expect(harness.getActiveVerifications().map(v => v.signalId)).toContain(signalId);
			const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "active-verifications.json"), "utf8"));
			expect(persisted.verifications.map((v: any) => v.signalId)).toContain(signalId);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("keeps a survival-marked Windows Job child alive during shutdown", () => {
		const root = fakeChild(2_147_483_646);
		const tracked = spawnTracked("node", ["worker"], {
			platform: "win32",
			spawnImpl: (() => root) as unknown as NativeSpawn,
			windowsJobSupervisor: true,
		});
		tracked.markSurvival();
		killAllTracked();
		expect(root.killCalls).toEqual([]);
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
			spawnImpl: (() => root) as unknown as NativeSpawn,
			windowsJobSupervisor: true,
			clock,
			timeoutMs: 50,
		});

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
