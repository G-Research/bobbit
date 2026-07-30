import { describe, expect, it } from "vitest";
import type { ChildProcess, SpawnOptions } from "node:child_process";

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
});
