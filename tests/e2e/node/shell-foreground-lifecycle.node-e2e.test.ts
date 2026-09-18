import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
	createForegroundGroupWitness,
	createForegroundShellGroupTracker,
	ForegroundShellGroupDrainError,
	foregroundShellSpawnSpec,
	type ForegroundGroupWitness,
} from "../../../defaults/tools/shell/extension.ts";

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
	onSignal?: (processGroupId: number, signal: GroupSignal) => void;
	deadlineMs?: number;
	graceMs?: number;
	onActiveChange?: (active: boolean) => void;
	onSleep?: () => void;
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
			sleep: async ms => {
				now += ms;
				options.onSleep?.();
			},
			signal: (processGroupId, signal) => {
				signals.push([processGroupId, signal]);
				options.onSignal?.(processGroupId, signal);
			},
			report: message => reports.push(message),
		},
	});
	return { tracker, reports, signals, now: () => now };
}

function mutableWitness(initial: "pending" | "live" | "lost" = "live"): {
	witness: ForegroundGroupWitness;
	set: (status: "pending" | "live" | "lost") => void;
} {
	let status = initial;
	return { witness: { status: () => status }, set: next => { status = next; } };
}

describe("foreground shell process-group lifecycle", () => {
	it("retains an escaped spawn-time group and drains it exactly once before shutdown continues", async () => {
		const ownership = mutableWitness();
		const activeChanges: boolean[] = [];
		const fixture = deterministicTracker({
			onActiveChange: active => activeChanges.push(active),
			onSignal: (processGroupId, signal) => {
				if (processGroupId === 41 && signal === "SIGKILL") ownership.set("lost");
			},
		});

		fixture.tracker.track(41, ownership.witness);
		fixture.tracker.track(41, ownership.witness);
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

	it("rejects a non-exiting group at the absolute deadline with structured credential-neutral diagnostics", async () => {
		const fixture = deterministicTracker({ deadlineMs: 25, graceMs: 10 });
		fixture.tracker.track(63, mutableWitness().witness);
		const firstDrain = fixture.tracker.drain();
		assert.equal(fixture.tracker.drain(), firstDrain, "terminal drain failures remain coalesced");

		let failure: unknown;
		await assert.rejects(firstDrain, error => {
			failure = error;
			return error instanceof ForegroundShellGroupDrainError;
		});

		assert.equal(fixture.now(), 25);
		assert.deepEqual(fixture.signals, [[63, "SIGTERM"], [63, "SIGKILL"]]);
		assert.deepEqual((failure as ForegroundShellGroupDrainError).groups, [{
			processGroupId: 63,
			finalWitnessStatus: "live",
			termAttempt: "sent",
			killAttempt: "sent",
			reason: "deadline-exceeded",
			elapsedMs: 25,
			deadlineMs: 25,
		}]);
		assert.equal(fixture.reports.length, 1, "the structured terminal failure is reported exactly once");
		assert.match(fixture.reports[0], /pgid=63 status=live reason=deadline-exceeded TERM=sent KILL=sent/);
		assert.equal(fixture.tracker.activeCount, 1, "an unresolved owner must not look like a successful empty drain");
	});

	it("never signals a reused PGID after its spawn-time witness identity is replaced", async () => {
		const fixture = deterministicTracker({});
		const readiness = new PassThrough();
		let currentStartToken = "original-incarnation";
		const witness = createForegroundGroupWitness(readiness, 91, "spawn-nonce", "linux", pid => ({
			pid,
			pgid: 91,
			kind: "linux-proc-stat-22",
			startToken: currentStartToken,
		}));
		readiness.write("R\t501\t91\tlinux-proc-stat-22\toriginal-incarnation\tspawn-nonce\n");
		assert.equal(witness.status(), "live");
		fixture.tracker.track(91, witness);

		// The same sentinel PID and numeric PGID now describe another process
		// incarnation. Apparent group liveness cannot restore old authority.
		currentStartToken = "reused-incarnation";
		fixture.tracker.releaseIfExited(91);
		await assert.rejects(fixture.tracker.drain(), (error: unknown) => {
			assert.ok(error instanceof ForegroundShellGroupDrainError);
			assert.deepEqual(error.groups, [{
				processGroupId: 91,
				finalWitnessStatus: "lost",
				termAttempt: "not-attempted",
				killAttempt: "not-attempted",
				reason: "ownership-lost",
				elapsedMs: 25,
				deadlineMs: 25,
			}]);
			return true;
		});
		currentStartToken = "original-incarnation";

		assert.equal(witness.status(), "lost", "witness loss is permanent even if old identity values reappear");
		assert.deepEqual(fixture.signals, [], "a lost witness never regains numeric signal authority");
		assert.equal(fixture.reports.length, 1);
		assert.equal(fixture.tracker.activeCount, 1, "lost ownership remains visible to enclosing teardown");
		readiness.destroy();
	});

	it("queues timeout termination until the spawn-time witness is ready", async () => {
		const ownership = mutableWitness("pending");
		const fixture = deterministicTracker({ onSleep: () => ownership.set("live") });
		fixture.tracker.track(93, ownership.witness);
		fixture.tracker.terminate(93);
		await new Promise(resolve => setImmediate(resolve));

		assert.deepEqual(fixture.signals, [[93, "SIGTERM"]]);
		assert.deepEqual(fixture.reports, []);
		ownership.set("lost");
		fixture.tracker.releaseIfExited(93);
	});

	it("rejects and retains ownership when the sentinel readiness handshake never completes", async () => {
		const fixture = deterministicTracker({ deadlineMs: 25 });
		fixture.tracker.track(92, mutableWitness("pending").witness);

		await assert.rejects(fixture.tracker.drain(), (error: unknown) => {
			assert.ok(error instanceof ForegroundShellGroupDrainError);
			assert.deepEqual(error.groups, [{
				processGroupId: 92,
				finalWitnessStatus: "pending",
				termAttempt: "not-attempted",
				killAttempt: "not-attempted",
				reason: "ownership-never-established",
				elapsedMs: 25,
				deadlineMs: 25,
			}]);
			return true;
		});

		assert.equal(fixture.now(), 25);
		assert.deepEqual(fixture.signals, []);
		assert.equal(fixture.reports.length, 1);
		assert.equal(fixture.tracker.activeCount, 1);
	});

	it("propagates a terminal drain failure before an enclosing cleanup can remove its root", async () => {
		const fixture = deterministicTracker({ deadlineMs: 25, graceMs: 10 });
		fixture.tracker.track(94, mutableWitness().witness);
		let removed = false;
		const sessionShutdownThenRemove = async () => {
			await fixture.tracker.drain();
			removed = true;
		};

		await assert.rejects(sessionShutdownThenRemove(), ForegroundShellGroupDrainError);
		assert.equal(removed, false, "session_shutdown rejection must fence owned-root removal");
		assert.equal(fixture.tracker.activeCount, 1);
	});

	it("rejects a signal failure without treating the numeric PGID as proof of exit", async () => {
		const ownership = mutableWitness();
		const fixture = deterministicTracker({
			deadlineMs: 25,
			graceMs: 10,
			onSignal: (_processGroupId, signal) => {
				if (signal === "SIGTERM") {
					const error = new Error("credential-bearing operating-system detail") as NodeJS.ErrnoException;
					error.code = "EPERM";
					throw error;
				}
				ownership.set("lost");
			},
		});
		fixture.tracker.track(95, ownership.witness);

		await assert.rejects(fixture.tracker.drain(), (error: unknown) => {
			assert.ok(error instanceof ForegroundShellGroupDrainError);
			assert.equal(error.groups[0].reason, "signal-failed");
			assert.equal(error.groups[0].termAttempt, "failed");
			assert.equal(error.groups[0].killAttempt, "sent");
			assert.doesNotMatch(error.message, /credential-bearing/);
			return true;
		});
		assert.deepEqual(fixture.signals, [[95, "SIGTERM"], [95, "SIGKILL"]]);
		assert.equal(fixture.tracker.activeCount, 1);
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
		const command = [
			"const {spawn}=require('node:child_process');",
			"const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
			"process.stdout.write(String(child.pid));",
			"setTimeout(()=>process.exit(0),20);",
		].join("");
		const spec = foregroundShellSpawnSpec(process.execPath, ["-e"], command);
		const root = spawn(spec.file, spec.args, {
			detached: true,
			env: spec.env,
			stdio: spec.stdio,
		});
		assert.ok(root.pid);
		let pidText = "";
		let resolvePidText!: () => void;
		const pidTextReady = new Promise<void>(resolve => { resolvePidText = resolve; });
		root.stdout!.setEncoding("utf8");
		root.stdout!.on("data", chunk => {
			pidText += chunk;
			if (/^\d+$/.test(pidText)) resolvePidText();
		});
		const tracker = createForegroundShellGroupTracker({ graceMs: 50, deadlineMs: 2_000, pollMs: 10 });
		tracker.track(root.pid, createForegroundGroupWitness(
			root.stdio[3] as NodeJS.ReadableStream,
			root.pid,
			spec.witnessNonce,
		));

		try {
			await Promise.all([once(root, "exit"), pidTextReady]);
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
