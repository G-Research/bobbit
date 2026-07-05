/**
 * SWARM-W3 — the "team actually started" scheduler hook
 * (design/swarm-orchestration.md; the scheduler-hook gap explicitly flagged
 * by docs/design/swarm-orchestration-w2.md: "createBestOfNSwarm calls
 * swarmGovernor.registerNode for EVERY sibling before requestChildStart,
 * including ones the scheduler reports capacity-blocked ... under fanOut >
 * cap with a long queue, a capacity-blocked sibling could in principle be
 * straggler-killed before it ever gets to run. Fixing this requires
 * plumbing a 'team actually started' callback from ChildTeamScheduler back
 * into the registration path").
 *
 * Exercises `ChildTeamScheduler.requestStart`'s new `onStart` parameter
 * directly (the real class, not a fake) with `fanOut(3) > cap(1)`, proving:
 *   1. `onStart` fires synchronously, immediately, for a sibling that gets a
 *      free permit right away.
 *   2. `onStart` does NOT fire for a capacity-blocked sibling merely because
 *      `requestStart` was called — it must wait for the sibling's own
 *      actual start.
 *   3. `onStart` fires exactly when the scheduler later drains a
 *      capacity-blocked sibling into a freed permit (`notifyTerminal` →
 *      `_startNextEligible`).
 *   4. A capacity-blocked sibling dropped as a stale/archived queue entry
 *      (never actually starts) never fires its `onStart` — no false-positive
 *      governor arm for a child that was cleaned up, not started.
 *   5. `notifyTerminal` on a still-queued (never-started) child clears its
 *      pending `onStart` — no late/leaked fire after the child is gone.
 *
 * `swarm-w1-best-of-n.test.ts` covers the same guarantee one layer up
 * (`createBestOfNSwarm` deferring `SwarmGovernor.registerNode` to this
 * hook); this file pins the scheduler primitive itself.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChildTeamScheduler, type ChildTeamSchedulerDeps, type SchedulerChildView } from "../src/server/agent/child-team-scheduler.ts";

const ROOT = "root-hook";

function makeChildren(n: number): Map<string, SchedulerChildView> {
	const m = new Map<string, SchedulerChildView>();
	for (let i = 0; i < n; i++) m.set(`sib-${i}`, { rootGoalId: ROOT });
	return m;
}

describe("ChildTeamScheduler.requestStart — onStart hook (SWARM-W3)", () => {
	it("fires onStart synchronously for a sibling that gets a free permit immediately", () => {
		const children = makeChildren(1);
		const deps: ChildTeamSchedulerDeps = {
			resolveCap: () => 3,
			getChild: (id) => children.get(id),
			startChildTeam: () => {},
		};
		const scheduler = new ChildTeamScheduler(deps);
		const fired: string[] = [];
		const outcome = scheduler.requestStart("sib-0", () => fired.push("sib-0"));
		assert.equal(outcome, "started");
		assert.deepEqual(fired, ["sib-0"], "onStart must have already fired by the time requestStart returns for an immediate start");
	});

	it("does NOT fire onStart for a capacity-blocked sibling merely because requestStart was called — only once its team actually starts", () => {
		const children = makeChildren(3);
		const started: string[] = [];
		const deps: ChildTeamSchedulerDeps = {
			resolveCap: () => 1,
			getChild: (id) => children.get(id),
			startChildTeam: (id) => { started.push(id); },
		};
		const scheduler = new ChildTeamScheduler(deps);
		const fired: string[] = [];

		const o0 = scheduler.requestStart("sib-0", () => fired.push("sib-0"));
		const o1 = scheduler.requestStart("sib-1", () => fired.push("sib-1"));
		const o2 = scheduler.requestStart("sib-2", () => fired.push("sib-2"));

		assert.equal(o0, "started");
		assert.equal(o1, "capacity-blocked");
		assert.equal(o2, "capacity-blocked");
		assert.deepEqual(fired, ["sib-0"], "only the immediately-started sibling's onStart has fired — the two queued siblings must NOT be armed yet (this is the exact gap: a queued sibling's straggler clock must not tick before its team runs)");

		// Draining the queue as permits free must fire each queued sibling's
		// onStart exactly when ITS team actually starts, not before.
		scheduler.notifyTerminal("sib-0");
		assert.deepEqual(fired, ["sib-0", "sib-1"], "sib-1 (FIFO head) starts and fires onStart the instant a permit frees");

		scheduler.notifyTerminal("sib-1");
		assert.deepEqual(fired, ["sib-0", "sib-1", "sib-2"], "sib-2 starts and fires onStart once the second permit frees");

		assert.deepEqual(started, ["sib-0", "sib-1", "sib-2"], "every sibling eventually actually starts (convergence unaffected by the hook)");
	});

	it("never fires onStart for a capacity-blocked sibling dropped as a stale/archived queue entry (it never actually starts)", () => {
		const children = makeChildren(2);
		const deps: ChildTeamSchedulerDeps = {
			resolveCap: () => 1,
			getChild: (id) => children.get(id),
			startChildTeam: () => {},
		};
		const scheduler = new ChildTeamScheduler(deps);
		const fired: string[] = [];

		scheduler.requestStart("sib-0", () => fired.push("sib-0"));
		scheduler.requestStart("sib-1", () => fired.push("sib-1"));
		assert.deepEqual(fired, ["sib-0"]);

		// sib-1 gets archived while still queued (never started).
		children.delete("sib-1");
		scheduler.notifyTerminal("sib-0"); // frees the permit, drains the queue — finds sib-1 stale, drops it
		assert.deepEqual(fired, ["sib-0"], "an archived-while-queued sibling must never fire onStart — it never actually started");
	});

	it("notifyTerminal on a still-queued (never-started) child clears its pending onStart — no late/leaked fire", () => {
		const children = makeChildren(2);
		const deps: ChildTeamSchedulerDeps = {
			resolveCap: () => 1,
			getChild: (id) => children.get(id),
			startChildTeam: () => {},
		};
		const scheduler = new ChildTeamScheduler(deps);
		const fired: string[] = [];

		scheduler.requestStart("sib-0", () => fired.push("sib-0"));
		scheduler.requestStart("sib-1", () => fired.push("sib-1"));
		assert.deepEqual(fired, ["sib-0"]);

		// sib-1 is externally resolved (e.g. archived + notified) WHILE STILL
		// QUEUED, distinct from the stale-drop path above — this simulates a
		// direct notifyTerminal call for a child that was never dequeued via
		// _startNextEligible at all.
		scheduler.notifyTerminal("sib-1");
		assert.deepEqual(fired, ["sib-0"], "sib-1 must not fire onStart — it went terminal while still queued, never actually started");

		// A later permit-free (sib-0 terminates) must not resurrect sib-1's
		// callback or fire it retroactively — it's already been removed from
		// the queue and the callback map by notifyTerminal.
		scheduler.notifyTerminal("sib-0");
		assert.deepEqual(fired, ["sib-0"], "no late fire for sib-1 after its own terminal event, even once sib-0 also terminates");
	});

	it("fanOut(5) > cap(2): onStart fires exactly once per sibling, in start order, matching startChildTeam's own invocations 1:1", () => {
		const children = makeChildren(5);
		const started: string[] = [];
		const deps: ChildTeamSchedulerDeps = {
			resolveCap: () => 2,
			getChild: (id) => children.get(id),
			startChildTeam: (id) => { started.push(id); },
		};
		const scheduler = new ChildTeamScheduler(deps);
		const fired: string[] = [];
		for (let i = 0; i < 5; i++) scheduler.requestStart(`sib-${i}`, () => fired.push(`sib-${i}`));
		assert.deepEqual(fired, ["sib-0", "sib-1"], "only cap=2 fire immediately");

		const terminated = new Set<string>();
		let guard = 0;
		while (terminated.size < 5) {
			if (++guard > 50) throw new Error("did not converge");
			const runningNotYetTerminated = started.filter(id => !terminated.has(id));
			const next = runningNotYetTerminated[0];
			terminated.add(next);
			scheduler.notifyTerminal(next);
		}
		assert.deepEqual(fired, started, "onStart fired exactly once per sibling, in exactly the order startChildTeam was actually invoked");
		assert.equal(fired.length, 5);
	});
});
