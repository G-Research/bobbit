/**
 * Pinning test: detached verification commands survive shutdown only after the
 * platform ownership barrier is established (POSIX sentinel FD 3; Windows Job).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** Track pids spawned in the suite for after() cleanup. */
const spawnedPids: number[] = [];

type SpawnLifecycle = {
	t: ReturnType<typeof spawnTracked>;
	ready: Promise<void>;
	closed: Promise<void>;
};

function longRunningTracked(): SpawnLifecycle {
	const t = spawnTracked(
		process.execPath,
		["-e", "setInterval(()=>{}, 1000)"],
		// POSIX injects its FD3 pipe itself. Passing an array with FD3 would
		// become an unnecessary inherited FD4 in the payload.
		{ stdio: "ignore" },
	);
	assert.ok(t.child.pid && t.child.pid > 0, "spawn should produce a pid");
	spawnedPids.push(t.child.pid);
	// Both events can happen before a caller gets to its first await. Register
	// the lifecycle settlement pairs immediately after every real spawn.
	const closed = waitForClose(t.child);
	const ready = t.ownershipReady;
	// Expected pre-ownership reaping closes FD3 without a data acknowledgement.
	// Observe the rejection now so it never becomes an unhandled promise.
	void ready.catch(() => {});
	return { t, ready, closed };
}

async function establishSurvivalOwnership(lifecycle: SpawnLifecycle): Promise<void> {
	// Wait for the platform's observable ownership acknowledgement before
	// allowing a shutdown-survival request to take effect.
	await lifecycle.ready;
	lifecycle.t.markSurvival();
}

/** Event-driven readiness for the Windows native Job-object probe. */
function waitForPidMarker(marker: string): Promise<number> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error, pid?: number) => {
			if (settled) return;
			settled = true;
			watcher.close();
			if (error) reject(error); else resolve(pid!);
		};
		const read = () => {
			try {
				const pid = Number(fs.readFileSync(marker, "utf8"));
				if (Number.isSafeInteger(pid) && pid > 0) finish(undefined, pid);
			} catch { /* marker has not been atomically published yet */ }
		};
		const watcher = fs.watch(path.dirname(marker), { persistent: false }, read);
		watcher.once("error", error => finish(error));
		read();
	});
}

describe("verification-harness shutdown — survival contract", () => {
	it("TrackedChild exposes markSurvival()", async () => {
		const lifecycle = longRunningTracked();
		assert.strictEqual(typeof lifecycle.t.markSurvival, "function");
		killAllTracked("SIGKILL", true);
		await lifecycle.closed;
	});

	it("kills POSIX survival-marked children when shutdown is requested immediately", async () => {
		if (process.platform === "win32") return;
		const lifecycle = longRunningTracked();
		lifecycle.t.markSurvival();
		killAllTracked("SIGKILL");
		await lifecycle.closed;
		// FD 3 can acknowledge from the pipe buffer before close, so ownershipReady
		// may resolve or reject. The subscribed close and dead PID are authoritative.
		assert.equal(isAlive(lifecycle.t.child.pid), false, "handshake-pending survival child must be reaped");
	});

	it("keeps only ownership-established survival children during shutdown", async () => {
		const lifecycle = longRunningTracked();
		await establishSurvivalOwnership(lifecycle);
		assert.ok(isAlive(lifecycle.t.child.pid), "child should be alive before shutdown");
		killAllTracked("SIGKILL");
		assert.ok(_trackedCount() >= 1, "owned survival child must remain registered after ordinary shutdown");
		assert.ok(isAlive(lifecycle.t.child.pid), "owned survival child must remain alive after ordinary shutdown");
		killAllTracked("SIGKILL", true);
		await lifecycle.closed;
		assert.equal(isAlive(lifecycle.t.child.pid), false, "includeSurvival must kill an owned survival child");
	});

	it("killAllTracked still kills non-survival children", async () => {
		const lifecycle = longRunningTracked();
		killAllTracked("SIGKILL");
		await lifecycle.closed;
		// Immediate shutdown races ownership acknowledgement by design. Child close
		// and liveness, not promise settlement direction, prove cleanup completed.
		assert.equal(isAlive(lifecycle.t.child.pid), false, "non-survival child should be reaped by shutdown");
	});

	it("Windows native Job close reaps a SIGTERM-ignoring descendant", async () => {
		if (process.platform !== "win32") return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-windows-job-e2e-"));
		const marker = path.join(dir, "grandchild.pid");
		let tracked: ReturnType<typeof spawnTracked> | undefined;
		try {
			tracked = spawnTracked(process.execPath, ["-e", [
				"const fs=require('node:fs');",
				"const {spawn}=require('node:child_process');",
				"const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
				"fs.writeFileSync(process.argv[1],String(child.pid));",
				"setInterval(()=>{},1000);",
			].join(""), marker], { stdio: "ignore" });
			spawnedPids.push(tracked.child.pid!);
			const closed = waitForClose(tracked.child);
			await tracked.ownershipReady;
			const grandchildPid = await waitForPidMarker(marker);
			killAllTracked("SIGKILL", true);
			await closed;
			assert.equal(isAlive(grandchildPid), false, "closing the native Job must reap its SIGTERM-ignoring payload descendant");
		} finally {
			try { killAllTracked("SIGKILL", true); } catch { /* best effort */ }
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

after(() => {
	try { killAllTracked("SIGKILL", true); } catch { /* best-effort */ }
	for (const pid of spawnedPids) {
		try { if (isAlive(pid)) process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
	}
});
