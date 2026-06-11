/**
 * Unit tests for BgProcessManager.waitForExit — deterministic state-machine
 * coverage in the persistent (file-backed) model.
 *
 * The class accepts an injected `SpawnFn` (fake EventEmitter child), a faked
 * `TailerFactory`, an isolated temp `BgProcessStore`, and a faked `BgEnv` so no
 * real OS processes are touched. Exit is now captured from a durable STATUS
 * file (as a wrapper would write it); the child `exit` event is only a hint to
 * check that file promptly, so tests write the status file then emit `exit`.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { BgProcessManager, type SpawnFn, type BgEnv, type TailerFactory, type Tailer } from "../src/server/agent/bg-process-manager.ts";
import { BgProcessStore } from "../src/server/agent/bg-process-store.ts";

// --- Fake child plumbing --------------------------------------------------

interface FakeChild extends EventEmitter {
	pid: number;
	stdout: EventEmitter & { destroy(): void };
	stderr: EventEmitter & { destroy(): void };
	kill(_sig?: string): boolean;
	unref(): void;
}

function makeFakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.pid = Math.floor(Math.random() * 1_000_000) + 1000;
	const mkStream = () => Object.assign(new EventEmitter(), { destroy() { /* noop */ } });
	child.stdout = mkStream();
	child.stderr = mkStream();
	child.kill = () => true;
	child.unref = () => { /* noop */ };
	return child;
}

function makeManager(env?: Partial<BgEnv>) {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-bgmgr-"));
	const store = new BgProcessStore(stateDir);
	let last: FakeChild | null = null;
	const spawn: SpawnFn = () => { last = makeFakeChild(); return last as unknown as ChildProcess; };
	const tailerFactory: TailerFactory = () => {
		const mk = (): Tailer => ({ start() {}, stop() {} });
		return { out: mk(), err: mk() };
	};
	const killCalls: Array<[number, string]> = [];
	const fullEnv: BgEnv = {
		isHostPidAlive: env?.isHostPidAlive ?? (() => false),
		killHostTree: env?.killHostTree ?? ((pid, sig) => killCalls.push([pid, sig])),
		dockerCli: env?.dockerCli ?? (() => ({ code: 0, stdout: "" })),
	};
	const mgr = new BgProcessManager(() => undefined, spawn, () => store, tailerFactory, fullEnv);
	return {
		mgr, stateDir, store,
		last: () => { if (!last) throw new Error("spawn not called"); return last; },
		killCalls,
		/** Drive a clean exit: write the status file then emit the child `exit` hint. */
		driveExit(session: string, id: string, code = 0) {
			const rec = store.get(session, id)!;
			fs.writeFileSync(rec.statusSnapshot, `${code}\n`);
			this.last().emit("exit", code);
		},
	};
}

function freshSession() { return `s-${randomUUID()}`; }

// --- Tests ----------------------------------------------------------------

describe("BgProcessManager.waitForExit — state machine", () => {
	it("abort before exit resolves with aborted:true and leaves process running", async () => {
		const h = makeManager();
		const SESSION = freshSession();
		const info = h.mgr.create(SESSION, "sleep 30", h.stateDir);
		assert.equal(info.status, "running");
		assert.equal(info.terminalReason, null);

		const controller = new AbortController();
		h.mgr.registerWait(SESSION, controller);

		const waitPromise = h.mgr.waitForExit(SESSION, info.id, 10_000, controller.signal);
		h.mgr.abortAllWaits(SESSION);
		const result = await waitPromise;
		h.mgr.unregisterWait(SESSION, controller);

		assert.ok(result, "result should not be null");
		assert.equal(result!.aborted, true);
		assert.equal(result!.timedOut, false);
		assert.equal(result!.info.status, "running");

		const still = h.mgr.list(SESSION).find(p => p.id === info.id);
		assert.ok(still);
		assert.equal(still!.status, "running");
		assert.equal(controller.signal.aborted, true);

		h.mgr.cleanup(SESSION);
	});

	it("exit resolves immediately and reflects exited status + terminalReason normal", async () => {
		const h = makeManager();
		const SESSION = freshSession();
		const info = h.mgr.create(SESSION, "noop", h.stateDir);

		const controller = new AbortController();
		const waitPromise = h.mgr.waitForExit(SESSION, info.id, 10_000, controller.signal);

		queueMicrotask(() => h.driveExit(SESSION, info.id, 0));

		const result = await waitPromise;
		assert.ok(result);
		assert.equal(result!.timedOut, false);
		assert.equal(result!.aborted, false);
		assert.equal(result!.info.status, "exited");
		assert.equal(result!.info.exitCode, 0);
		assert.equal(result!.info.terminalReason, "normal");

		h.mgr.cleanup(SESSION);
	});

	it("already-exited short-circuit returns aborted:false even with a fresh signal", async () => {
		const h = makeManager();
		const SESSION = freshSession();
		const info = h.mgr.create(SESSION, "noop", h.stateDir);

		h.driveExit(SESSION, info.id, 0); // synchronous exit before any waiter attaches

		const controller = new AbortController();
		const result = await h.mgr.waitForExit(SESSION, info.id, 1000, controller.signal);
		assert.ok(result);
		assert.equal(result!.timedOut, false);
		assert.equal(result!.aborted, false);
		assert.equal(result!.info.status, "exited");

		controller.abort();
		h.mgr.cleanup(SESSION);
	});

	it("timeout fires deterministically under fake timers", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });

		const h = makeManager();
		const SESSION = freshSession();
		const info = h.mgr.create(SESSION, "sleep 30", h.stateDir);

		const controller = new AbortController();
		h.mgr.registerWait(SESSION, controller);

		const waitPromise = h.mgr.waitForExit(SESSION, info.id, 50, controller.signal);
		t.mock.timers.tick(50);

		return waitPromise.then((result) => {
			assert.ok(result);
			assert.equal(result!.timedOut, true);
			assert.equal(result!.aborted, false);
			controller.abort();
			h.mgr.unregisterWait(SESSION, controller);
			h.mgr.cleanup(SESSION);
		});
	});

	it("does not leak abort listeners across many cycles", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const h = makeManager();
		const SESSION = freshSession();
		const info = h.mgr.create(SESSION, "sleep 30", h.stateDir);

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

		for (let i = 0; i < 200; i++) {
			const p = h.mgr.waitForExit(SESSION, info.id, 1, signal);
			await Promise.resolve();
			t.mock.timers.tick(1);
			await p;
		}

		assert.equal(active, 0, "abort listener must be removed when wait settles via timeout");
		assert.ok(peak <= 1, `at most one abort listener should be live at a time, peak=${peak}`);
		assert.equal(h.last().listenerCount("exit"), 1, "only the manager's create() exit hint should remain");

		h.mgr.cleanup(SESSION);
	});

	it("multiple concurrent waits all abort on abortAllWaits()", async () => {
		const h = makeManager();
		const SESSION = freshSession();
		const info = h.mgr.create(SESSION, "sleep 30", h.stateDir);

		const c1 = new AbortController();
		const c2 = new AbortController();
		const c3 = new AbortController();
		h.mgr.registerWait(SESSION, c1);
		h.mgr.registerWait(SESSION, c2);
		h.mgr.registerWait(SESSION, c3);

		const p1 = h.mgr.waitForExit(SESSION, info.id, 10_000, c1.signal);
		const p2 = h.mgr.waitForExit(SESSION, info.id, 10_000, c2.signal);
		const p3 = h.mgr.waitForExit(SESSION, info.id, 10_000, c3.signal);

		h.mgr.abortAllWaits(SESSION);
		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

		for (const r of [r1, r2, r3]) {
			assert.ok(r);
			assert.equal(r!.aborted, true);
			assert.equal(r!.info.status, "running");
		}

		h.mgr.unregisterWait(SESSION, c1);
		h.mgr.unregisterWait(SESSION, c2);
		h.mgr.unregisterWait(SESSION, c3);
		h.mgr.cleanup(SESSION);
	});

	it("cleanup() aborts in-flight waits and signals running children", async () => {
		const h = makeManager({ isHostPidAlive: () => true });
		const SESSION = freshSession();
		const info = h.mgr.create(SESSION, "sleep 30", h.stateDir);

		const controller = new AbortController();
		h.mgr.registerWait(SESSION, controller);
		const waitPromise = h.mgr.waitForExit(SESSION, info.id, 10_000, controller.signal);

		h.mgr.cleanup(SESSION);

		const result = await waitPromise;
		assert.ok(result);
		assert.equal(result!.aborted, true, "cleanup must abort the pending wait");
		assert.ok(h.killCalls.length >= 1, "cleanup must signal running children via env.killHostTree");
	});

	it("waitForExit on unknown processId returns null", async () => {
		const h = makeManager();
		const result = await h.mgr.waitForExit(freshSession(), "bg-does-not-exist", 100);
		assert.equal(result, null);
	});

	it("pre-aborted signal returns immediately without arming the timer", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });

		const h = makeManager();
		const SESSION = freshSession();
		const info = h.mgr.create(SESSION, "sleep 30", h.stateDir);

		const controller = new AbortController();
		controller.abort();

		return h.mgr.waitForExit(SESSION, info.id, 10_000, controller.signal).then((result) => {
			assert.ok(result);
			assert.equal(result!.aborted, true);
			assert.equal(result!.timedOut, false);
			t.mock.timers.runAll();
			h.mgr.cleanup(SESSION);
		});
	});
});

describe("BgProcessManager endTime snapshots", () => {
	it("created/running process info exposes endTime null", () => {
		const h = makeManager();
		const SESSION = freshSession();
		const info = h.mgr.create(SESSION, "sleep 30", h.stateDir);
		try {
			assert.equal((info as { endTime?: unknown }).endTime, null, "running BgProcessInfo must include endTime: null");
		} finally {
			h.mgr.cleanup(SESSION);
		}
	});

	it("list() and waitForExit() expose numeric endTime after exit", async () => {
		const h = makeManager();
		const SESSION = freshSession();
		const info = h.mgr.create(SESSION, "noop", h.stateDir);

		try {
			const waitPromise = h.mgr.waitForExit(SESSION, info.id, 10_000);
			queueMicrotask(() => h.driveExit(SESSION, info.id, 0));

			const result = await waitPromise;
			assert.ok(result);
			const listed = h.mgr.list(SESSION).find((p) => p.id === info.id);
			assert.ok(listed);

			const listEndTime = (listed as { endTime?: unknown }).endTime;
			const waitEndTime = (result!.info as { endTime?: unknown }).endTime;

			assert.equal(typeof listEndTime, "number", "exited list() snapshot must include numeric endTime");
			assert.equal(typeof waitEndTime, "number", "waitForExit() snapshot must include numeric endTime");
			assert.ok((listEndTime as number) >= info.startTime, "list() endTime must be at or after startTime");
			assert.equal(waitEndTime, listEndTime, "waitForExit() and list() should report the same final endTime");
		} finally {
			h.mgr.cleanup(SESSION);
		}
	});
});

// Make sure no global mock timer state leaks between describe blocks.
mock.timers.reset();
