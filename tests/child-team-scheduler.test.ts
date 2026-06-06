/**
 * Unified per-root child-team scheduler — the SINGLE authority for the
 * per-tree concurrency cap across every child-team start path (harness
 * `runSubgoalStep`, REST `spawn-child`, `POST /api/goals` child creation, and
 * `integrate-child` dependency auto-unblock).
 *
 * These pure unit tests pin the core invariant the HIGH "per-root cap only
 * enforced in the harness" finding is about: at most `cap` child teams run
 * concurrently, the rest are parked capacity-blocked + enqueued FIFO, and a
 * terminal event (merge/archive/completion) releases a permit which
 * synchronously starts the next eligible queued child (the semaphore IS the
 * scheduler — no poll loop). Live `PATCH /policy` resizes apply in place.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ChildTeamScheduler, type SchedulerChildView } from "../src/server/agent/child-team-scheduler.ts";

interface FakeChild extends SchedulerChildView { id: string; }

/**
 * Build a scheduler over an in-memory child table. `startChildTeam` records
 * the order children were started (and marks them "running" so the test can
 * compute peak concurrency).
 */
function build(cap: number) {
	const ROOT = "root-1";
	const children = new Map<string, FakeChild>();
	const started: string[] = [];
	const running = new Set<string>();
	let peak = 0;

	const addChild = (id: string, over: Partial<FakeChild> = {}): FakeChild => {
		const c: FakeChild = { id, state: "todo", rootGoalId: ROOT, parentGoalId: ROOT, ...over };
		children.set(id, c);
		return c;
	};

	const scheduler = new ChildTeamScheduler({
		resolveCap: () => cap,
		getChild: (id) => children.get(id),
		startChildTeam: (id) => {
			started.push(id);
			running.add(id);
			peak = Math.max(peak, running.size);
		},
	});

	// Mark a child terminal (merge/archive): stop "running" + notify scheduler.
	const terminate = (id: string) => {
		running.delete(id);
		const c = children.get(id);
		if (c) c.archived = true;
		scheduler.notifyTerminal(id);
	};

	// Simulate the pause cascade marking a child paused (it is NOT dequeued).
	const pause = (id: string) => { const c = children.get(id); if (c) c.paused = true; };
	// Simulate resume clearing the paused flag.
	const resume = (id: string) => { const c = children.get(id); if (c) c.paused = false; };

	return { ROOT, scheduler, children, started, running, addChild, terminate, pause, resume, peak: () => peak };
}

describe("ChildTeamScheduler — per-root concurrency cap", () => {
	it("cap=1: only one child starts; the rest are capacity-blocked + enqueued", () => {
		const fx = build(1);
		fx.addChild("c1"); fx.addChild("c2"); fx.addChild("c3");

		assert.equal(fx.scheduler.requestStart("c1"), "started");
		assert.equal(fx.scheduler.requestStart("c2"), "capacity-blocked");
		assert.equal(fx.scheduler.requestStart("c3"), "capacity-blocked");

		assert.deepEqual(fx.started, ["c1"], "only the first child starts under cap=1");
		assert.equal(fx.scheduler.pendingCount(fx.ROOT), 2);
		assert.equal(fx.peak(), 1);
	});

	it("terminal release starts the next eligible queued child (FIFO) — peak never exceeds cap", () => {
		const fx = build(1);
		fx.addChild("c1"); fx.addChild("c2"); fx.addChild("c3");
		fx.scheduler.requestStart("c1");
		fx.scheduler.requestStart("c2");
		fx.scheduler.requestStart("c3");

		fx.terminate("c1");
		assert.deepEqual(fx.started, ["c1", "c2"], "c1 merge starts c2 (FIFO order)");
		assert.equal(fx.scheduler.pendingCount(fx.ROOT), 1);

		fx.terminate("c2");
		assert.deepEqual(fx.started, ["c1", "c2", "c3"], "c2 merge starts c3");
		assert.equal(fx.scheduler.pendingCount(fx.ROOT), 0);

		assert.equal(fx.peak(), 1, "peak concurrent teams must never exceed cap=1");
	});

	it("cap=2: at most two run; a merge admits exactly one more", () => {
		const fx = build(2);
		for (const id of ["a", "b", "c", "d", "e"]) fx.addChild(id);
		const outcomes = ["a", "b", "c", "d", "e"].map(id => fx.scheduler.requestStart(id));
		assert.deepEqual(outcomes, ["started", "started", "capacity-blocked", "capacity-blocked", "capacity-blocked"]);
		assert.deepEqual(fx.started, ["a", "b"]);

		fx.terminate("a");
		assert.deepEqual(fx.started, ["a", "b", "c"]);
		fx.terminate("b");
		assert.deepEqual(fx.started, ["a", "b", "c", "d"]);

		assert.equal(fx.peak(), 2, "peak must never exceed cap=2");
	});

	it("a terminal event for a capacity-blocked (never-started) child just dequeues it — no permit churn", () => {
		const fx = build(1);
		fx.addChild("c1"); fx.addChild("c2"); fx.addChild("c3");
		fx.scheduler.requestStart("c1");          // started, holds the only permit
		fx.scheduler.requestStart("c2");          // capacity-blocked
		fx.scheduler.requestStart("c3");          // capacity-blocked
		assert.equal(fx.scheduler.pendingCount(fx.ROOT), 2);

		// c2 is archived while still queued (never held a permit).
		fx.terminate("c2");
		assert.equal(fx.scheduler.pendingCount(fx.ROOT), 1, "c2 dropped from the queue");
		assert.deepEqual(fx.started, ["c1"], "no new start — the only permit is still held by c1");

		// c1 finishes → next eligible (c3) starts; the dead c2 is gone.
		fx.terminate("c1");
		assert.deepEqual(fx.started, ["c1", "c3"]);
	});

	it("a stale (archived) queued child is dropped without consuming a permit", () => {
		const fx = build(1);
		fx.addChild("c1"); fx.addChild("c2"); fx.addChild("c3");
		fx.scheduler.requestStart("c1");
		fx.scheduler.requestStart("c2");
		fx.scheduler.requestStart("c3");

		// c2 gets archived out-of-band (not via notifyTerminal).
		fx.children.get("c2")!.archived = true;

		fx.terminate("c1"); // frees one permit
		// c2 is skipped (archived) → c3 starts instead, and the single freed
		// permit lands on c3 (not wasted on the dead c2).
		assert.deepEqual(fx.started, ["c1", "c3"]);
		assert.equal(fx.scheduler.pendingCount(fx.ROOT), 0);
	});

	it("requestStart with no resolvable root starts immediately (never strands a child)", () => {
		const fx = build(1);
		fx.addChild("orphan", { rootGoalId: undefined, parentGoalId: undefined });
		assert.equal(fx.scheduler.requestStart("orphan"), "started");
		assert.deepEqual(fx.started, ["orphan"]);
	});

	it("notifyTerminal is idempotent / a no-op for an unknown child", () => {
		const fx = build(1);
		fx.addChild("c1");
		fx.scheduler.requestStart("c1");
		fx.scheduler.notifyTerminal("c1");
		// Second call must not throw nor over-release.
		fx.scheduler.notifyTerminal("c1");
		fx.scheduler.notifyTerminal("never-seen");
		assert.equal(fx.scheduler.pendingCount(fx.ROOT), 0);
	});
});

describe("ChildTeamScheduler — pause awareness (no paused start; no permit leak)", () => {
	it("cap=1: A holds permit, B queued; pause + A terminal → B NOT started, permit not leaked, B stays queued; resume → B starts", () => {
		const fx = build(1);
		fx.addChild("A"); fx.addChild("B");
		assert.equal(fx.scheduler.requestStart("A"), "started");
		assert.equal(fx.scheduler.requestStart("B"), "capacity-blocked");
		assert.deepEqual(fx.started, ["A"]);
		assert.equal(fx.scheduler.pendingCount(fx.ROOT), 1);

		// Pause the root subtree: the cascade marks B paused but leaves it queued.
		fx.pause("B");

		// A reaches a terminal event (merge/archive/completion), releasing its permit.
		fx.terminate("A");

		// B must NOT start (it is paused) and must remain queued for resume.
		assert.deepEqual(fx.started, ["A"], "paused B must not be started by the freed permit");
		assert.equal(fx.scheduler.pendingCount(fx.ROOT), 1, "B stays queued while paused");

		// Resume B and re-drive the scheduler (mirrors the resume handler's pass).
		// If A's permit had leaked, B could never acquire one here — the start proves
		// the permit was released and is still available.
		fx.resume("B");
		fx.scheduler.startNextEligible(fx.ROOT);
		assert.deepEqual(fx.started, ["A", "B"], "resumed B starts into the still-free permit");
		assert.equal(fx.scheduler.pendingCount(fx.ROOT), 0);
		assert.equal(fx.peak(), 1, "peak never exceeds cap=1");
	});

	it("permit is not leaked while a queued child is paused: a non-paused sibling can acquire the freed slot", () => {
		const fx = build(1);
		fx.addChild("A"); fx.addChild("B"); fx.addChild("C");
		fx.scheduler.requestStart("A");           // started, holds the only permit
		fx.scheduler.requestStart("B");           // queued
		fx.pause("B");
		fx.terminate("A");                          // frees the permit; paused B skipped
		assert.deepEqual(fx.started, ["A"]);
		// C requests a start: the permit freed by A is available (not leaked on B).
		assert.equal(fx.scheduler.requestStart("C"), "started");
		assert.deepEqual(fx.started, ["A", "C"]);
		// B is still queued (paused), waiting for resume.
		assert.equal(fx.scheduler.pendingCount(fx.ROOT), 1);
	});

	it("scans past a paused queued child to start the next eligible (non-paused) sibling", () => {
		const fx = build(1);
		fx.addChild("A"); fx.addChild("B"); fx.addChild("C");
		fx.scheduler.requestStart("A");           // started
		fx.scheduler.requestStart("B");           // queued (will be paused)
		fx.scheduler.requestStart("C");           // queued
		fx.pause("B");
		fx.terminate("A");                          // freed permit skips paused B, starts C
		assert.deepEqual(fx.started, ["A", "C"], "paused B skipped; next eligible C starts");
		assert.equal(fx.scheduler.pendingCount(fx.ROOT), 1, "paused B remains queued");
	});
});

describe("ChildTeamScheduler — start-failure never leaks a permit", () => {
	it("releases the permit + re-enqueues the child when startChildTeam throws synchronously", () => {
		const ROOT = "r";
		const children = new Map<string, FakeChild>([
			["x", { id: "x", state: "todo", rootGoalId: ROOT, parentGoalId: ROOT }],
		]);
		let throwOnce = true;
		const started: string[] = [];
		const scheduler = new ChildTeamScheduler({
			resolveCap: () => 1,
			getChild: (id) => children.get(id),
			startChildTeam: (id) => {
				if (id === "x" && throwOnce) { throwOnce = false; throw new Error("boom"); }
				started.push(id);
			},
		});
		// First start throws → permit released + child re-enqueued (parked).
		assert.equal(scheduler.requestStart("x"), "capacity-blocked");
		assert.equal(scheduler.pendingCount(ROOT), 1);
		assert.deepEqual(started, []);
		// The freed permit is reusable: re-drive starts x (now succeeds).
		scheduler.startNextEligible(ROOT);
		assert.deepEqual(started, ["x"]);
		assert.equal(scheduler.pendingCount(ROOT), 0);
	});
});

describe("ChildTeamScheduler — live cap resize (PATCH /policy)", () => {
	it("growing the cap admits queued children immediately", () => {
		const fx = build(1);
		fx.addChild("c1"); fx.addChild("c2"); fx.addChild("c3");
		fx.scheduler.requestStart("c1");
		fx.scheduler.requestStart("c2");
		fx.scheduler.requestStart("c3");
		assert.deepEqual(fx.started, ["c1"]);

		// Grow 1 → 3: the two queued children start without any merge.
		const resized = fx.scheduler.resize(fx.ROOT, 3);
		assert.equal(resized, true);
		assert.deepEqual(fx.started, ["c1", "c2", "c3"]);
		assert.equal(fx.scheduler.pendingCount(fx.ROOT), 0);
	});

	it("shrinking the cap never interrupts running children but blocks new starts", () => {
		const fx = build(3);
		for (const id of ["a", "b", "c", "d"]) fx.addChild(id);
		fx.scheduler.requestStart("a");
		fx.scheduler.requestStart("b");
		fx.scheduler.requestStart("c");          // 3 running
		assert.deepEqual(fx.started, ["a", "b", "c"]);

		// Shrink 3 → 1 while 3 are held. No interruption; over-subscription debt
		// is paid down as holders finish.
		fx.scheduler.resize(fx.ROOT, 1);
		assert.equal(fx.scheduler.requestStart("d"), "capacity-blocked");

		fx.terminate("a"); // pays debt — does NOT start d
		assert.deepEqual(fx.started, ["a", "b", "c"]);
		fx.terminate("b"); // pays debt — still over the new cap
		assert.deepEqual(fx.started, ["a", "b", "c"]);
		fx.terminate("c"); // now within cap=1 → d starts
		assert.deepEqual(fx.started, ["a", "b", "c", "d"]);
		assert.equal(fx.peak(), 3, "the three already-running children were never interrupted");
	});

	it("resize returns false for a root with no semaphore created yet", () => {
		const fx = build(1);
		assert.equal(fx.scheduler.resize("never-used-root", 5), false);
	});
});
