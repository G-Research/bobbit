/**
 * SWARM-W1 — scheduler invariant pin (design/swarm-orchestration.md §7 /
 * §14 item 2): "acquire a permit only when a node is runnable; a blocked
 * node reserves nothing; the barrier/join is an event-driven callback off
 * terminal-child events and holds ZERO permits while waiting; the cap is
 * measured over RUNNABLE nodes only."
 *
 * Concretely for best-of-N: the barrier is `SwarmGroupStore.recordArtifact`,
 * invoked synchronously inside `notifyChildTerminal` — it is NEVER itself a
 * scheduled/spawned entity, so it can never hold (or contend for) a permit.
 * The risk this pins is the OTHER half of the invariant: with `fanOut > cap`
 * (N siblings, a root concurrency cap smaller than N), every sibling must
 * still eventually start and reach terminal — i.e. the swarm must always be
 * able to CONVERGE, never wedge with permits held by nothing runnable.
 *
 * Drives `ChildTeamScheduler` directly (the real class, not a fake) with
 * `fanOut(5) > cap(2)`, asserting:
 *   - only `cap` siblings start immediately; the rest are capacity-blocked
 *     (queued, holding NO permit — `pendingCount` reflects them, not
 *     `holding`).
 *   - as each running sibling terminates (`notifyTerminal`), the NEXT queued
 *     sibling starts automatically, permit-for-permit, until ALL 5 have run.
 *   - the barrier (a plain counter here, standing in for
 *     `SwarmGroupStore.recordArtifact`) fires only once all 5 have gone
 *     through `notifyTerminal` — proving convergence under `fanOut > cap`
 *     with zero deadlock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChildTeamScheduler, type ChildTeamSchedulerDeps, type SchedulerChildView } from "../src/server/agent/child-team-scheduler.ts";

const ROOT = "root-fanout";

function makeChildren(n: number): Map<string, SchedulerChildView> {
	const m = new Map<string, SchedulerChildView>();
	for (let i = 0; i < n; i++) m.set(`sib-${i}`, { rootGoalId: ROOT });
	return m;
}

describe("SWARM-W1 scheduler invariant — fanOut > cap converges, never deadlocks", () => {
	it("N=5 siblings under cap=2: only 2 start immediately, the rest queue capacity-blocked with NO permit held", () => {
		const children = makeChildren(5);
		const started: string[] = [];
		const deps: ChildTeamSchedulerDeps = {
			resolveCap: () => 2,
			getChild: (id) => children.get(id),
			startChildTeam: (id) => { started.push(id); },
		};
		const scheduler = new ChildTeamScheduler(deps);
		const outcomes = [0, 1, 2, 3, 4].map(i => scheduler.requestStart(`sib-${i}`));

		assert.equal(outcomes.filter(o => o === "started").length, 2, "exactly `cap` siblings start immediately");
		assert.equal(outcomes.filter(o => o === "capacity-blocked").length, 3, "the rest are parked, not silently dropped");
		assert.equal(scheduler.pendingCount(ROOT), 3, "3 queued — holding ZERO permits (a queued child never called startChildTeam)");
		assert.equal(started.length, 2);
	});

	it("as each running sibling terminates, the scheduler auto-starts the next queued one — ALL 5 eventually run (convergence, no deadlock)", () => {
		const children = makeChildren(5);
		const started: string[] = [];
		let barrierCapturedCount = 0;
		const expectedTotal = 5;

		const deps: ChildTeamSchedulerDeps = {
			resolveCap: () => 2,
			getChild: (id) => children.get(id),
			startChildTeam: (id) => { started.push(id); },
		};
		const scheduler = new ChildTeamScheduler(deps);

		// Fan out all 5 up front — mirrors createBestOfNSwarm's loop calling
		// requestChildStart for every sibling before any of them can possibly
		// terminate.
		for (let i = 0; i < 5; i++) scheduler.requestStart(`sib-${i}`);
		assert.equal(started.length, 2, "only cap=2 running at any instant");

		// Drain: terminate whichever siblings HAVE started, one at a time,
		// until every sibling in the fan-out has both started and terminated.
		// This mirrors real terminal events arriving one at a time as each
		// sibling's own team finishes independently.
		const terminated = new Set<string>();
		let guard = 0;
		while (terminated.size < expectedTotal) {
			if (++guard > 50) throw new Error("scheduler did not converge — possible deadlock under fanOut > cap");
			const runningNotYetTerminated = started.filter(id => !terminated.has(id));
			if (runningNotYetTerminated.length === 0) {
				throw new Error(`stuck: ${terminated.size}/${expectedTotal} terminated but nothing currently running — a real deadlock (permits held by nothing runnable)`);
			}
			const next = runningNotYetTerminated[0];
			terminated.add(next);
			scheduler.notifyTerminal(next); // barrier-equivalent: release permit + drain queue
			barrierCapturedCount++;
		}

		assert.equal(terminated.size, expectedTotal, "every sibling in the fan-out eventually ran and terminated");
		assert.equal(started.length, expectedTotal, "the scheduler auto-started every queued sibling as permits freed — none stranded");
		assert.equal(barrierCapturedCount, expectedTotal, "the barrier-equivalent counter saw exactly one terminal event per sibling — no double-fire, no missed sibling");
		assert.equal(scheduler.pendingCount(ROOT), 0, "queue fully drained");
	});

	it("fanOut === cap (no queueing needed) still converges — the join/barrier itself never contends for a permit at any fan-out size", () => {
		const children = makeChildren(3);
		const started: string[] = [];
		const deps: ChildTeamSchedulerDeps = {
			resolveCap: () => 3,
			getChild: (id) => children.get(id),
			startChildTeam: (id) => { started.push(id); },
		};
		const scheduler = new ChildTeamScheduler(deps);
		for (let i = 0; i < 3; i++) {
			const outcome = scheduler.requestStart(`sib-${i}`);
			assert.equal(outcome, "started", "fanOut === cap: every sibling starts immediately, no queueing");
		}
		for (let i = 0; i < 3; i++) scheduler.notifyTerminal(`sib-${i}`);
		assert.equal(started.length, 3);
		assert.equal(scheduler.pendingCount(ROOT), 0);
	});
});
