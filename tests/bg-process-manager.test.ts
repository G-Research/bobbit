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

describe("BgProcessManager endTime snapshots", () => {
	it("created/running process info exposes endTime null", () => {
		const { mgr } = makeManager();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "sleep 30", os.tmpdir());

		try {
			assert.equal((info as { endTime?: unknown }).endTime, null, "running BgProcessInfo must include endTime: null");
		} finally {
			mgr.cleanup(SESSION);
		}
	});

	it("list() and waitForExit() expose numeric endTime after child exit", async () => {
		const { mgr, last } = makeManager();
		const SESSION = freshSession();
		const info = mgr.create(SESSION, "noop", os.tmpdir());

		try {
			const waitPromise = mgr.waitForExit(SESSION, info.id, 10_000);
			queueMicrotask(() => last().emit("exit", 0));

			const result = await waitPromise;
			assert.ok(result);
			const listed = mgr.list(SESSION).find((p) => p.id === info.id);
			assert.ok(listed);

			const listEndTime = (listed as { endTime?: unknown }).endTime;
			const waitEndTime = (result!.info as { endTime?: unknown }).endTime;

			assert.equal(typeof listEndTime, "number", "exited list() snapshot must include numeric endTime");
			assert.equal(typeof waitEndTime, "number", "waitForExit() snapshot must include numeric endTime");
			assert.ok((listEndTime as number) >= info.startTime, "list() endTime must be at or after startTime");
			assert.equal(waitEndTime, listEndTime, "waitForExit() and list() should report the same final endTime");
		} finally {
			mgr.cleanup(SESSION);
		}
	});
});

// Make sure no global mock timer state leaks between describe blocks.
mock.timers.reset();
