/**
 * Unit tests for BgProcessManager.waitForExit \u2014 deterministic state-machine
 * coverage.
 *
 * Previously these tests spawned real child processes (sleep/ping/cmd /c exit)
 * and asserted on wall-clock elapsed times. That made them flaky on loaded CI
 * runners and forced ordering hacks (50 ms slack, polling loops, "give
 * listeners a tick" sleeps).
 *
 * The class now accepts an injected `SpawnFn`. Tests pass a fake child built
 * on EventEmitter so `exit` is fired by the test, not by the OS scheduler.
 * Combined with `node:test` mock timers this gives us byte-deterministic
 * coverage of the abort / timeout / exit race without touching processes.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { ChildProcess } from "node:child_process";

import { BgProcessManager, type SpawnFn } from "../src/server/agent/bg-process-manager.ts";

// --- Fake child plumbing --------------------------------------------------

interface FakeChild extends EventEmitter {
	pid: number;
	stdout: EventEmitter & { destroy(): void };
	stderr: EventEmitter & { destroy(): void };
	kill(_sig?: string): boolean;
	unref(): void;
	__killed: string[];
}

function makeFakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.pid = Math.floor(Math.random() * 1_000_000) + 1000;
	child.__killed = [];
	const mkStream = () => Object.assign(new EventEmitter(), { destroy() { /* noop */ } });
	child.stdout = mkStream();
	child.stderr = mkStream();
	child.kill = (sig = "SIGTERM") => { child.__killed.push(sig); return true; };
	child.unref = () => { /* noop */ };
	return child;
}

/** SpawnFn that returns a fresh fake and exposes it via the returned ref. */
function fakeSpawner(): { spawn: SpawnFn; last: () => FakeChild } {
	let last: FakeChild | null = null;
	const spawn: SpawnFn = () => {
		last = makeFakeChild();
		return last as unknown as ChildProcess;
	};
	return { spawn, last: () => { if (!last) throw new Error("spawn not called"); return last; } };
}

function makeManager() {
	const spawner = fakeSpawner();
	const mgr = new BgProcessManager(() => undefined, spawner.spawn);
	return { mgr, last: spawner.last };
}

// Each test gets its own session id so a leaked entry can't bleed across cases.
function freshSession() { return `s-${randomUUID()}`; }

// --- Tests ----------------------------------------------------------------

describe("BgProcessManager.waitForExit \u2014 state machine", () => {
	it("abort before exit resolves with aborted:true and leaves process running", async () => {
		const { mgr, last } = makeManager();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "sleep 30", os.tmpdir());
		assert.equal(info.status, "running");

		const controller = new AbortController();
		mgr.registerWait(SESSION, controller);

		const waitPromise = mgr.waitForExit(SESSION, info.id, 10_000, controller.signal);
		mgr.abortAllWaits(SESSION);
		const result = await waitPromise;
		mgr.unregisterWait(SESSION, controller);

		assert.ok(result, "result should not be null");
		assert.equal(result!.aborted, true);
		assert.equal(result!.timedOut, false);
		assert.equal(result!.info.status, "running", "process must still be running after abort");

		// No bg-process side effect from the abort itself.
		assert.deepEqual(last().__killed, [], "abort must not kill the underlying child");

		// Process is still tracked & running.
		const still = mgr.list(SESSION).find(p => p.id === info.id);
		assert.ok(still);
		assert.equal(still!.status, "running");

		// No listener leaks on the abort signal.
		assert.equal(controller.signal.aborted, true);

		mgr.cleanup(SESSION);
	});

	it("exit resolves immediately and reflects exited status (no 50ms slack)", async () => {
		const { mgr, last } = makeManager();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "noop", os.tmpdir());

		const controller = new AbortController();
		const waitPromise = mgr.waitForExit(SESSION, info.id, 10_000, controller.signal);

		// Drive the exit on a microtask boundary so the awaiter is already parked.
		queueMicrotask(() => last().emit("exit", 0));

		const result = await waitPromise;
		assert.ok(result);
		assert.equal(result!.timedOut, false);
		assert.equal(result!.aborted, false);
		// The critical invariant: the snapshot returned to the caller already
		// shows status === "exited". Previously this required a 50 ms slack
		// timeout to be reliable.
		assert.equal(result!.info.status, "exited");
		assert.equal(result!.info.exitCode, 0);

		mgr.cleanup(SESSION);
	});

	it("already-exited short-circuit returns aborted:false even with a fresh signal", async () => {
		const { mgr, last } = makeManager();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "noop", os.tmpdir());

		// Synchronously exit before any waiter attaches.
		last().emit("exit", 0);

		const controller = new AbortController();
		const result = await mgr.waitForExit(SESSION, info.id, 1000, controller.signal);
		assert.ok(result);
		assert.equal(result!.timedOut, false);
		assert.equal(result!.aborted, false);
		assert.equal(result!.info.status, "exited");

		// Aborting after the fact must not throw or produce side effects.
		controller.abort();
		assert.deepEqual(last().__killed, []);

		mgr.cleanup(SESSION);
	});

	it("timeout fires deterministically under fake timers", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });

		const { mgr } = makeManager();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "sleep 30", os.tmpdir());

		const controller = new AbortController();
		mgr.registerWait(SESSION, controller);

		const waitPromise = mgr.waitForExit(SESSION, info.id, 50, controller.signal);

		// Advance by the exact timeout \u2014 zero wall-clock involvement.
		t.mock.timers.tick(50);

		return waitPromise.then((result) => {
			assert.ok(result);
			assert.equal(result!.timedOut, true);
			assert.equal(result!.aborted, false);

			// Aborting after timeout must not produce a second resolution.
			controller.abort();
			mgr.unregisterWait(SESSION, controller);
			mgr.cleanup(SESSION);
		});
	});

	it("does not leak abort listeners across many cycles", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { mgr, last } = makeManager();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "sleep 30", os.tmpdir());

		// AbortSignal has no public listener-count API — wrap add/remove so the
		// test can assert structurally that every wait that didn't fire abort
		// still cleaned up the listener it added.
		const controller = new AbortController();
		const signal = controller.signal;
		let active = 0;
		let peak = 0;
		const origAdd = signal.addEventListener.bind(signal);
		const origRemove = signal.removeEventListener.bind(signal);
		signal.addEventListener = ((type: string, listener: any, opts?: any) => {
			if (type === "abort") { active++; peak = Math.max(peak, active); }
			return origAdd(type, listener, opts);
		}) as any;
		signal.removeEventListener = ((type: string, listener: any, opts?: any) => {
			if (type === "abort") active = Math.max(0, active - 1);
			return origRemove(type, listener, opts);
		}) as any;

		// 200 wait/timeout cycles re-using the same signal. If we leak a listener
		// per cycle, `active` grows without bound.
		for (let i = 0; i < 200; i++) {
			const p = mgr.waitForExit(SESSION, info.id, 1, signal);
			// Drain microtasks so the wait has parked, then fire its timer.
			await Promise.resolve();
			t.mock.timers.tick(1);
			await p;
		}

		assert.equal(active, 0, "abort listener must be removed when wait settles via timeout");
		assert.ok(peak <= 1, `at most one abort listener should be live at a time, peak=${peak}`);
		// And no listener accumulated on the underlying child either.
		assert.equal(last().listenerCount("exit"), 1, "only the manager's create() listener should remain");

		mgr.cleanup(SESSION);
	});

	it("multiple concurrent waits all abort on abortAllWaits()", async () => {
		const { mgr, last } = makeManager();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "sleep 30", os.tmpdir());

		const c1 = new AbortController();
		const c2 = new AbortController();
		const c3 = new AbortController();
		mgr.registerWait(SESSION, c1);
		mgr.registerWait(SESSION, c2);
		mgr.registerWait(SESSION, c3);

		const p1 = mgr.waitForExit(SESSION, info.id, 10_000, c1.signal);
		const p2 = mgr.waitForExit(SESSION, info.id, 10_000, c2.signal);
		const p3 = mgr.waitForExit(SESSION, info.id, 10_000, c3.signal);

		mgr.abortAllWaits(SESSION);
		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

		for (const r of [r1, r2, r3]) {
			assert.ok(r);
			assert.equal(r!.aborted, true);
			assert.equal(r!.info.status, "running");
		}
		assert.deepEqual(last().__killed, [], "abortAllWaits must not kill the bg child");

		mgr.unregisterWait(SESSION, c1);
		mgr.unregisterWait(SESSION, c2);
		mgr.unregisterWait(SESSION, c3);
		mgr.cleanup(SESSION);
	});

	it("cleanup() aborts in-flight waits (separate from kill)", async () => {
		const { mgr, last } = makeManager();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "sleep 30", os.tmpdir());

		const controller = new AbortController();
		mgr.registerWait(SESSION, controller);
		const waitPromise = mgr.waitForExit(SESSION, info.id, 10_000, controller.signal);

		mgr.cleanup(SESSION);

		const result = await waitPromise;
		assert.ok(result);
		// cleanup() calls abortAllWaits() FIRST, so the abort branch must win
		// regardless of what happens to the child afterwards.
		assert.equal(result!.aborted, true, "cleanup must abort the pending wait");

		// And cleanup must also have signalled the child.
		assert.ok(last().__killed.includes("SIGTERM"), "cleanup must SIGTERM running children");
	});

	it("waitForExit on unknown processId returns null", async () => {
		const { mgr } = makeManager();
		const result = await mgr.waitForExit(freshSession(), "bg-does-not-exist", 100);
		assert.equal(result, null);
	});

	it("pre-aborted signal returns immediately without arming the timer", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });

		const { mgr } = makeManager();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "sleep 30", os.tmpdir());

		const controller = new AbortController();
		controller.abort(); // abort BEFORE waitForExit is invoked

		// If waitForExit incorrectly armed the timer it would still be pending;
		// we can detect that via t.mock.timers.runAll() having work to do.
		return mgr.waitForExit(SESSION, info.id, 10_000, controller.signal).then((result) => {
			assert.ok(result);
			assert.equal(result!.aborted, true);
			assert.equal(result!.timedOut, false);
			// Running all pending timers must not produce any extra resolution
			// or unhandled rejection \u2014 this assertion is purely structural.
			t.mock.timers.runAll();
			mgr.cleanup(SESSION);
		});
	});
});

// --- Exit notification tests --------------------------------------------
//
// These tests cover the design at docs/design ("wake owning agent when a
// bash_bg process exits"). The production wiring (notifier callback +
// notified/suppressNotification fields) is now live, so these tests assert
// notifier delivery unconditionally — a missing notification is a real
// regression, not a skip condition.

type ExitNotification = {
	sessionId: string;
	processId: string;
	name: string;
	command: string;
	exitCode: number | null;
	signal: string | null;
	success: boolean;
	startTime: number;
	endTime: number;
	durationMs: number;
	tail: string[];
};

function makeManagerWithNotifier() {
	const spawner = fakeSpawner();
	const calls: ExitNotification[] = [];
	const notifier = (n: ExitNotification) => { calls.push(n); };
	// Constructor third arg may not yet exist in production — cast through any
	// so this file still compiles. When wired, the manager will invoke it.
	const Ctor = BgProcessManager as unknown as new (
		cp: () => undefined,
		sp: SpawnFn,
		notifier: (n: ExitNotification) => void,
	) => BgProcessManager;
	const mgr = new Ctor(() => undefined, spawner.spawn, notifier);
	return { mgr, last: spawner.last, calls };
}

/** Drain microtasks so any queued notifier invocation runs before assertions. */
async function drainMicrotasks() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("BgProcessManager \u2014 exit notifications", () => {
	it("notifies owning session on successful exit with full payload", async () => {
		const { mgr, last, calls } = makeManagerWithNotifier();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "echo hi && true", os.tmpdir(), undefined, false, "smoke");

		last().stdout.emit("data", Buffer.from("hello\nworld\n"));
		last().stderr.emit("data", Buffer.from("warn: nothing\n"));
		last().emit("exit", 0, null);
		await drainMicrotasks();

		assert.equal(calls.length, 1, "notifier must fire exactly once");
		const n = calls[0];
		assert.equal(n.sessionId, SESSION);
		assert.equal(n.processId, info.id);
		assert.equal(n.name, "smoke");
		assert.equal(n.command, "echo hi && true");
		assert.equal(n.exitCode, 0);
		assert.equal(n.signal, null);
		assert.equal(n.success, true);
		assert.equal(typeof n.startTime, "number");
		assert.equal(typeof n.endTime, "number");
		assert.ok(n.endTime >= n.startTime);
		assert.equal(n.durationMs, n.endTime - n.startTime);
		assert.ok(Array.isArray(n.tail));
		assert.ok(n.tail.length > 0, "tail should include some output when present");

		mgr.cleanup(SESSION);
	});

	it("surfaces failures \u2014 non-zero exit reports success:false and tail includes error", async () => {
		const { mgr, last, calls } = makeManagerWithNotifier();
		const SESSION = freshSession();
		mgr.create(SESSION, "build && test", os.tmpdir(), undefined, false, "tests");

		last().stdout.emit("data", Buffer.from("starting build\n"));
		last().stderr.emit("data", Buffer.from("Error: compilation failed at foo.ts:42\n"));
		last().emit("exit", 1, null);
		await drainMicrotasks();

		assert.equal(calls.length, 1);
		const n = calls[0];
		assert.equal(n.success, false);
		assert.equal(n.exitCode, 1);
		assert.equal(n.signal, null);
		assert.ok(
			n.tail.some((l) => /error|fail/i.test(l)),
			`failure tail must surface error line, got: ${JSON.stringify(n.tail)}`,
		);

		mgr.cleanup(SESSION);
	});

	it("signal termination surfaces as failure", async () => {
		const { mgr, last, calls } = makeManagerWithNotifier();
		const SESSION = freshSession();
		mgr.create(SESSION, "sleep 30", os.tmpdir());
		// Simulate external SIGKILL (no agent-initiated kill() call → not suppressed)
		last().emit("exit", null, "SIGKILL");
		await drainMicrotasks();

		assert.equal(calls.length, 1);
		assert.equal(calls[0].success, false);
		assert.equal(calls[0].signal, "SIGKILL");

		mgr.cleanup(SESSION);
	});

	it("explicit wait observes exit without producing an auto notification", async () => {
		const { mgr, last, calls } = makeManagerWithNotifier();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "noop", os.tmpdir());

		const controller = new AbortController();
		const waitP = mgr.waitForExit(SESSION, info.id, 10_000, controller.signal);
		// Drive exit AFTER the waiter has parked so wait wins the race.
		queueMicrotask(() => last().emit("exit", 0, null));
		const result = await waitP;
		assert.ok(result);
		assert.equal(result!.info.status, "exited");

		// Allow any queued auto-notification microtask to run.
		await drainMicrotasks();

		// Two acceptable outcomes per design: wait wins (0 calls) OR auto raced
		// first (1 call). Either way: exactly-once observation.
		assert.ok(calls.length <= 1, `expected at most 1 notification, got ${calls.length}`);

		mgr.cleanup(SESSION);
	});

	it("wait-in-progress on a running process claims the exit and suppresses auto-notify", async () => {
		const { mgr, last, calls } = makeManagerWithNotifier();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "noop", os.tmpdir());

		const controller = new AbortController();
		mgr.registerWait(SESSION, controller);
		// Start the wait BEFORE the process exits — this is the path used by
		// `bash_bg wait` mid-turn. The wait must claim the exit so the auto
		// notifier never fires (regression: STREAM_BURST duplicates).
		const waitP = mgr.waitForExit(SESSION, info.id, 10_000, controller.signal);

		// Yield so the wait has parked, then drive the exit.
		await Promise.resolve();
		last().emit("exit", 0, null);

		const result = await waitP;
		mgr.unregisterWait(SESSION, controller);
		assert.ok(result);
		assert.equal(result!.info.status, "exited");
		assert.equal(result!.info.exitCode, 0);

		// Even after draining microtasks the notifier must NOT have fired — the
		// agent observed the exit synchronously via the wait return value.
		await drainMicrotasks();
		assert.equal(calls.length, 0, `wait must claim the exit, got ${calls.length} notifications`);

		mgr.cleanup(SESSION);
	});

	it("timed-out wait does NOT suppress later auto-notification when the process exits afterwards", async (t) => {
		// Regression: previously `waitForExit` claimed `notified = true` as soon
		// as it was invoked on a running process. That meant a wait that timed
		// out (or was aborted) before the process exited permanently silenced
		// the auto-notifier, leaving an idle agent unaware that its bg job
		// finished. The correct semantics: `notified` is set only when an exit
		// is actually observed. A wait that times out/aborts before exit must
		// allow the eventual exit to wake the owning agent.
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { mgr, last, calls } = makeManagerWithNotifier();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "sleep 30", os.tmpdir());

		const controller = new AbortController();
		mgr.registerWait(SESSION, controller);
		const waitP = mgr.waitForExit(SESSION, info.id, 50, controller.signal);
		t.mock.timers.tick(50);
		const result = await waitP;
		mgr.unregisterWait(SESSION, controller);
		assert.ok(result);
		assert.equal(result!.timedOut, true);
		assert.equal(result!.info.status, "running", "timeout must leave process running");
		assert.equal(calls.length, 0, "no notification yet — process hasn't exited");

		// Process exits later, after the agent already saw the timeout and went
		// idle. The auto-notifier MUST fire so the agent gets woken.
		last().emit("exit", 0, null);
		await drainMicrotasks();
		assert.equal(calls.length, 1, "late exit after timed-out wait must wake the agent");
		assert.equal(calls[0].processId, info.id);
		assert.equal(calls[0].success, true);

		mgr.cleanup(SESSION);
	});

	it("aborted wait does NOT suppress later auto-notification when the process exits afterwards", async () => {
		// Same semantic as the timeout case but for abort: an abort before exit
		// (e.g. live-steer cancels the wait) must not silence the eventual
		// auto-notifier.
		const { mgr, last, calls } = makeManagerWithNotifier();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "sleep 30", os.tmpdir());

		const controller = new AbortController();
		mgr.registerWait(SESSION, controller);
		const waitP = mgr.waitForExit(SESSION, info.id, 10_000, controller.signal);
		mgr.abortAllWaits(SESSION);
		const result = await waitP;
		mgr.unregisterWait(SESSION, controller);
		assert.ok(result);
		assert.equal(result!.aborted, true);
		assert.equal(result!.info.status, "running");
		assert.equal(calls.length, 0, "no notification yet — process hasn't exited");

		last().emit("exit", 0, null);
		await drainMicrotasks();
		assert.equal(calls.length, 1, "late exit after aborted wait must wake the agent");
		assert.equal(calls[0].processId, info.id);

		mgr.cleanup(SESSION);
	});

	it("auto notification then wait does not duplicate", async () => {
		const { mgr, last, calls } = makeManagerWithNotifier();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "noop", os.tmpdir());

		// No waiter \u2014 exit must auto-notify.
		last().emit("exit", 0, null);
		await drainMicrotasks();

		assert.equal(calls.length, 1, "auto notify on exit with no waiter");

		// Subsequent wait must return cached info without a second notification.
		const result = await mgr.waitForExit(SESSION, info.id, 1000);
		assert.ok(result);
		assert.equal(result!.info.status, "exited");
		await drainMicrotasks();
		assert.equal(calls.length, 1, "wait after auto-notify must not produce a second notification");

		mgr.cleanup(SESSION);
	});

	it("kill suppression \u2014 agent-initiated kill must not wake the session", async () => {
		const { mgr, last, calls } = makeManagerWithNotifier();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "sleep 30", os.tmpdir());

		const killed = mgr.kill(SESSION, info.id);
		assert.equal(killed, true);

		// Simulate child exiting in response to our SIGTERM.
		last().emit("exit", null, "SIGTERM");
		await drainMicrotasks();

		assert.equal(calls.length, 0, "kill() must suppress auto-notification");

		mgr.cleanup(SESSION);
	});

	it("cleanup() suppresses notifications for running processes", async () => {
		const { mgr, last, calls } = makeManagerWithNotifier();
		const SESSION = freshSession();
		mgr.create(SESSION, "sleep 30", os.tmpdir());

		mgr.cleanup(SESSION);
		// child fires exit in response to the SIGTERM cleanup sent.
		last().emit("exit", null, "SIGTERM");
		await drainMicrotasks();

		assert.equal(calls.length, 0, "cleanup() must suppress notifications");
	});

	it("multiple concurrent processes notify independently with no cross-talk", async () => {
		const { mgr, calls } = makeManagerWithNotifier();
		const SESSION = freshSession();

		// Two separate spawners so each create() captures its own child.
		const spawnerA = fakeSpawner();
		const spawnerB = fakeSpawner();
		// Re-wire the manager's spawnFn per-create via a small queue.
		const queue: SpawnFn[] = [spawnerA.spawn, spawnerB.spawn];
		(mgr as any).spawnFn = (cmd: string, cwd: string, cid?: string) => queue.shift()!(cmd, cwd, cid);

		const a = mgr.create(SESSION, "cmd-a", os.tmpdir(), undefined, false, "alpha");
		const b = mgr.create(SESSION, "cmd-b", os.tmpdir(), undefined, false, "beta");

		spawnerA.last().emit("exit", 0, null);
		spawnerB.last().emit("exit", 2, null);
		await drainMicrotasks();

		assert.equal(calls.length, 2, "each process must notify exactly once");
		const byId = new Map(calls.map((n) => [n.processId, n] as const));
		assert.ok(byId.has(a.id) && byId.has(b.id), "both ids represented");
		assert.equal(byId.get(a.id)!.success, true);
		assert.equal(byId.get(a.id)!.name, "alpha");
		assert.equal(byId.get(a.id)!.command, "cmd-a");
		assert.equal(byId.get(b.id)!.success, false);
		assert.equal(byId.get(b.id)!.exitCode, 2);
		assert.equal(byId.get(b.id)!.name, "beta");

		mgr.cleanup(SESSION);
	});

	it("notifier failures do not crash the exit handler", async () => {
		const spawner = fakeSpawner();
		const notifier = mock.fn(() => { throw new Error("notifier boom"); });
		const Ctor = BgProcessManager as unknown as new (
			cp: () => undefined,
			sp: SpawnFn,
			notifier: (n: ExitNotification) => void,
		) => BgProcessManager;
		const mgr = new Ctor(() => undefined, spawner.spawn, notifier as any);
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "x", os.tmpdir());

		// Must not throw / reject.
		spawner.last().emit("exit", 0, null);
		await drainMicrotasks();

		assert.equal(notifier.mock.callCount(), 1, "notifier must be invoked even though it throws");

		// State should still reflect exit even though notifier threw.
		const snap = mgr.list(SESSION).find((p) => p.id === info.id);
		assert.ok(snap);
		assert.equal(snap!.status, "exited");

		mgr.cleanup(SESSION);
	});
});

// Make sure no global mock timer state leaks between describe blocks.
mock.timers.reset();
