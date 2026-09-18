import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";

import { createForegroundShellGroupTracker } from "../../../defaults/tools/shell/extension.ts";

type GroupSignal = "SIGTERM" | "SIGKILL";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH";
	}
}

function deterministicTracker(options: {
	alive: Set<number>;
	onSignal?: (processGroupId: number, signal: GroupSignal) => void;
	deadlineMs?: number;
	graceMs?: number;
	onActiveChange?: (active: boolean) => void;
}) {
	let now = 0;
	const reports: string[] = [];
	const signals: Array<[number, GroupSignal]> = [];
	const tracker = createForegroundShellGroupTracker({
		platform: "linux",
		deadlineMs: options.deadlineMs ?? 25,
		graceMs: options.graceMs ?? 10,
		pollMs: 5,
		onActiveChange: options.onActiveChange,
		ops: {
			now: () => now,
			sleep: async ms => { now += ms; },
			isAlive: processGroupId => options.alive.has(processGroupId),
			signal: (processGroupId, signal) => {
				signals.push([processGroupId, signal]);
				options.onSignal?.(processGroupId, signal);
			},
			report: message => reports.push(message),
		},
	});
	return { tracker, reports, signals, now: () => now };
}

describe("foreground shell process-group lifecycle", () => {
	it("retains an escaped spawn-time group and drains it exactly once before shutdown continues", async () => {
		const alive = new Set([41]);
		const activeChanges: boolean[] = [];
		const fixture = deterministicTracker({
			alive,
			onActiveChange: active => activeChanges.push(active),
			onSignal: (processGroupId, signal) => {
				if (processGroupId === 41 && signal === "SIGKILL") alive.delete(processGroupId);
			},
		});

		fixture.tracker.track(41);
		fixture.tracker.track(41);
		fixture.tracker.releaseIfExited(41);
		assert.equal(fixture.tracker.activeCount, 1, "a descendant keeps the shell's spawn-time group owned after root exit");

		const firstDrain = fixture.tracker.drain();
		const repeatedDrain = fixture.tracker.drain();
		assert.equal(repeatedDrain, firstDrain, "concurrent terminal paths share one bounded drain");
		await firstDrain;

		assert.deepEqual(fixture.signals, [[41, "SIGTERM"], [41, "SIGKILL"]]);
		assert.equal(fixture.tracker.activeCount, 0);
		assert.deepEqual(activeChanges, [true, false], "signal listeners can be installed and removed without duplication");
	});

	it("bounds a non-exiting group at the absolute deadline with credential-neutral diagnostics", async () => {
		const fixture = deterministicTracker({ alive: new Set([63]), deadlineMs: 25, graceMs: 10 });
		fixture.tracker.track(63);
		await fixture.tracker.drain();

		assert.equal(fixture.now(), 25);
		assert.deepEqual(fixture.signals, [[63, "SIGTERM"], [63, "SIGKILL"]]);
		assert.deepEqual(fixture.reports, ["[bash-tool] Foreground process-group drain reached its 25ms deadline (pgids=63)"]);
		assert.equal(fixture.tracker.activeCount, 0);
	});

	it("leaves Windows tree ownership to the outer Job without creating POSIX group state", async () => {
		const signals: Array<[number, GroupSignal]> = [];
		const tracker = createForegroundShellGroupTracker({
			platform: "win32",
			ops: { signal: (processGroupId, signal) => signals.push([processGroupId, signal]) },
		});
		tracker.track(74);
		await tracker.drain();

		assert.equal(tracker.activeCount, 0);
		assert.deepEqual(signals, []);
	});

	it("kills and joins a TERM-ignoring descendant after its detached POSIX shell root exits", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
		const root = spawn(process.execPath, ["-e", [
			"const {spawn}=require('node:child_process');",
			"const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
			"process.stdout.write(String(child.pid));",
			"setTimeout(()=>process.exit(0),20);",
		].join("")], {
			detached: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		assert.ok(root.pid);
		let pidText = "";
		root.stdout!.setEncoding("utf8");
		root.stdout!.on("data", chunk => { pidText += chunk; });
		const tracker = createForegroundShellGroupTracker({ graceMs: 50, deadlineMs: 2_000, pollMs: 10 });
		tracker.track(root.pid);

		try {
			await once(root, "close");
			const descendantPid = Number(pidText);
			assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
			assert.equal(isAlive(descendantPid), true, "fixture descendant must outlive its shell root");
			tracker.releaseIfExited(root.pid);
			assert.equal(tracker.activeCount, 1, "the live group remains owned after root exit");

			await tracker.drain();
			assert.equal(tracker.activeCount, 0);
			assert.equal(isAlive(descendantPid), false, "drain must join the escaped descendant before resolving");
		} finally {
			try { process.kill(-root.pid, "SIGKILL"); } catch { /* already drained */ }
		}
	});
});
