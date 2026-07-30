import { describe, expect, it } from "vitest";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { killTreeByPid, spawnTracked } from "../../src/server/agent/spawn-tree.js";
import { createManualClock } from "../harness/clock.js";

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
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnTracked } from ${JSON.stringify(new URL("../../src/server/agent/spawn-tree.ts", import.meta.url).href)};

const grandchildScript = "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 600); setInterval(() => {}, 1000);";
const parentScript = "const fs=require('fs'); const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e',process.argv[1]],{stdio:'ignore'}); fs.writeFileSync(process.argv[2],String(child.pid)); if(process.argv[3] === 'exit-root') process.exit(0); setInterval(()=>{},1000);";
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; } };

async function run(mode) {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-spawn-tree-")), "grandchild.pid");
  const tracked = spawnTracked(process.execPath, ["-e", parentScript, grandchildScript, marker, mode === "natural" ? "exit-root" : "stay-root"], {
    stdio: "ignore",
    ...(mode === "timeout" ? { timeoutMs: 100, killGraceMs: 100 } : {}),
  });
  const deadline = Date.now() + 1000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(marker), mode + ": parent should publish its grandchild PID");
  const grandchildPid = Number(fs.readFileSync(marker, "utf8"));
  assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, mode + ": grandchild PID should be valid");
  if (mode === "cancel") tracked.killTree("SIGTERM", 0);
  if (tracked.child.exitCode === null && tracked.child.signalCode === null) await new Promise(resolve => tracked.child.once("exit", resolve));
  assert.equal(await tracked.waitForTreeExit(1500), true, mode + ": tracked tree should be exhausted");
  assert.equal(alive(grandchildPid), false, mode + ": SIGTERM-ignoring grandchild must be reaped");
  console.log(mode + "-tree-reaped");
}

await run("natural");
await run("timeout");
await run("cancel");
`;

function fakeChild(pid: number): ChildProcess & { killCalls: NodeJS.Signals[]; readyPipe: EventEmitter } {
	const killCalls: NodeJS.Signals[] = [];
	const readyPipe = new EventEmitter();
	return Object.assign(new EventEmitter(), {
		pid,
		killCalls,
		readyPipe,
		stdio: [null, null, null, readyPipe],
		kill: (signal: NodeJS.Signals) => { killCalls.push(signal); return true; },
	}) as unknown as ChildProcess & { killCalls: NodeJS.Signals[]; readyPipe: EventEmitter };
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

describe("spawnTracked timeout cleanup", () => {
	it("reaps SIGTERM-ignoring descendants after natural success, timeout, and cancellation", async () => {
		const result = await runProbe();
		expect(result.code, result.stderr).toBe(0);
		for (const mode of ["natural", "timeout", "cancel"]) expect(result.stdout).toContain(`${mode}-tree-reaped`);
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
