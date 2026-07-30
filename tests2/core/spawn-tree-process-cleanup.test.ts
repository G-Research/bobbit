import { describe, expect, it } from "vitest";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { spawnTracked } from "../../src/server/agent/spawn-tree.js";
import { createManualClock } from "../harness/clock.js";

type NativeSpawn = typeof import("node:child_process").spawn;

/**
 * The tier-1 spawn guard intentionally fences ordinary test subprocesses. This
 * test is the narrow process-tree exception: retrieve its preserved native
 * spawn and execute the probe in a separate Node process, where spawn-tree is
 * unguarded. The probe's grandchild has a finite safety lifetime and the probe
 * explicitly reaps it on assertion failure, so this regression test cannot
 * itself leave an orphan behind.
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

const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-spawn-tree-")), "grandchild.pid");
const grandchildScript = "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 2500); setInterval(() => {}, 1000);";
const parentScript = "const fs=require('fs'); const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e',process.argv[1]],{stdio:'ignore'}); fs.writeFileSync(process.argv[2],String(child.pid)); setInterval(()=>{},1000);";
const tracked = spawnTracked(process.execPath, ["-e", parentScript, grandchildScript, marker], {
  stdio: "ignore",
  timeoutMs: 100,
  killGraceMs: 100,
});

const deadline = Date.now() + 1000;
while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
assert.ok(fs.existsSync(marker), "parent should publish its grandchild PID before timeout");
const grandchildPid = Number(fs.readFileSync(marker, "utf8"));
assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, "grandchild PID should be valid");

const exited = await tracked.waitForTreeExit(1500);
const alive = (() => { try { process.kill(grandchildPid, 0); return true; } catch (err) { return err?.code === "EPERM"; } })();
if (alive) {
  // This PID came from the just-spawned probe, so emergency cleanup remains
  // targeted even if the assertion below catches a regression.
  try { process.kill(grandchildPid, "SIGKILL"); } catch {}
}
assert.equal(exited, true, "owned process group/job should exit within the bounded cleanup window");
assert.equal(alive, false, "SIGTERM-ignoring grandchild must be reaped by the owned-tree kill");
console.log("process-tree-cleanup-ok");
`;

function fakeChild(pid: number): ChildProcess {
	return Object.assign(new EventEmitter(), { pid }) as unknown as ChildProcess;
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
	it("reaps an SIGTERM-ignoring grandchild after its shell leader exits", async () => {
		const result = await runProbe();
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("process-tree-cleanup-ok");
	});

	it("Windows retains tree-kill ownership from root exit until inherited stdio closes", async () => {
		const clock = createManualClock(0);
		const root = fakeChild(2_147_483_647);
		const taskkill = fakeChild(2_147_483_646);
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const spawnImpl = ((cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return calls.length === 1 ? root : taskkill;
		}) as unknown as NativeSpawn;
		const tracked = spawnTracked("node", ["worker"], {
			platform: "win32",
			spawnImpl,
			clock,
			timeoutMs: 50,
		});

		// Windows can emit `exit` while a descendant owns inherited stdio. That is
		// not a PID-reuse boundary: the timeout must still start exactly one scoped
		// taskkill before the later full `close`.
		root.emit("exit", 0, null);
		expect(await tracked.waitForTreeExit(0)).toBe(false);
		clock.advance(50);
		expect(tracked.timedOut()).toBe(true);
		expect(calls).toEqual([
			{ cmd: "node", args: ["worker"] },
			{ cmd: "taskkill", args: ["/T", "/F", "/PID", "2147483647"] },
		]);

		const completion = tracked.waitForTreeExit(1_000);
		taskkill.emit("close", 0, null);
		expect(await completion).toBe(true);

		root.emit("close", 0, null);
		tracked.killTree();
		expect(calls).toHaveLength(2);
	});

	it("Windows cleanup joins one taskkill and never retargets a closed or completed root", async () => {
		const root = fakeChild(2_147_483_647);
		const taskkill = fakeChild(2_147_483_646);
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const spawnImpl = ((cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return calls.length === 1 ? root : taskkill;
		}) as unknown as NativeSpawn;
		const tracked = spawnTracked("node", ["worker"], { platform: "win32", spawnImpl });

		tracked.killTree();
		tracked.killTree("SIGKILL");
		const completion = tracked.waitForTreeExit(1_000);
		let settled = false;
		void completion.then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(calls).toEqual([
			{ cmd: "node", args: ["worker"] },
			{ cmd: "taskkill", args: ["/T", "/F", "/PID", "2147483647"] },
		]);

		taskkill.emit("close", 0, null);
		expect(await completion).toBe(true);

		// Retain the resolved cleanup promise even while the root close event has
		// not arrived: completed cleanup must not restart taskkill.
		tracked.killTree();
		expect(calls).toHaveLength(2);

		// A late root close likewise cannot make a reused PID targetable.
		root.emit("close", 0, null);
		tracked.killTree();
		expect(calls).toHaveLength(2);
	});

	it("POSIX drops delayed escalation after the original process group becomes empty", () => {
		const clock = createManualClock(0);
		const root = fakeChild(123_456);
		const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
		let groupAlive = true;
		const tracked = spawnTracked("node", ["worker"], {
			platform: "linux",
			spawnImpl: (() => root) as unknown as NativeSpawn,
			clock,
			killGraceMs: 50,
			isProcessGroupAlive: () => groupAlive,
			signalProcessGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
		});

		tracked.killTree("SIGTERM");
		expect(signals).toEqual([{ pgid: 123_456, signal: "SIGTERM" }]);

		// The group's original descendants all exit before grace elapses. A later
		// `true` models the kernel reusing that numeric PGID for an unrelated tree.
		groupAlive = false;
		root.emit("exit", 0, null);
		groupAlive = true;
		clock.advance(50);
		tracked.killTree("SIGKILL");

		expect(signals).toEqual([{ pgid: 123_456, signal: "SIGTERM" }]);
	});

	it("Windows never starts taskkill once the tracked root has closed", () => {
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
});
