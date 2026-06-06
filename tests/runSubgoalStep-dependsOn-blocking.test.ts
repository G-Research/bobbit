/**
 * dependsOn scheduling enforcement on the parent-workflow subgoal path.
 *
 * Spec: "Full DAG dependencies: declare `dependsOn` between sibling sub-goals;
 * a child with unmet deps is created paused/blocked and auto-resumes when its
 * last dependency merges" and "The `subgoal` verify-step type IS the
 * scheduler." The direct `goal_spawn_child` REST path already blocks on unmet
 * deps (creates `state:"blocked"`, auto-unblocked by integrate-child); this
 * suite pins the equivalent behaviour on `runSubgoalStep` (the `parent`
 * meta-workflow execution path):
 *
 *   - A sibling step with an unmet `dependsOn` is created `state:"blocked"`
 *     and its team/worktree is NOT started.
 *   - Two sibling steps with an A→B dependency do NOT run concurrently:
 *     B's team only starts after A merges (harness auto-unblock scan).
 *   - When all of a step's deps are already merged, it spawns immediately
 *     (never blocked).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("runSubgoalStep — dependsOn scheduling enforcement", () => {
	it("B dependsOn A (same phase): A runs, B is blocked until A merges, then auto-unblocks", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const teamStarted: string[] = [];
		fx.setSetupHook(async (childGoalId) => { teamStarted.push(childGoalId); });

		// Hold A's ready-to-merge until we have observed that B is blocked.
		let releaseA!: () => void;
		const aHeld = new Promise<void>(res => { releaseA = res; });
		fx.setReadyToMergeHook(async (childGoalId) => {
			const g = fx.goalStore.get(childGoalId);
			if (g?.spawnedFromPlanId === "A") await aHeld;
			return "passed";
		});

		const stepA = buildSubgoalStep({ planId: "A", title: "Alpha" });
		const stepB = buildSubgoalStep({ planId: "B", title: "Beta", dependsOn: ["A"] });
		const aA = buildActive(fx.parent.id);
		const aB = buildActive(fx.parent.id);

		const runA = fx.harness.runSubgoalStep(stepA, aA.signal, aA.active, 0);
		const runB = fx.harness.runSubgoalStep(stepB, aB.signal, aB.active, 0);

		const findChild = (planId: string) =>
			fx.goalStore.getAll().find(g => g.parentGoalId === fx.parent.id && g.spawnedFromPlanId === planId);

		// Wait until B is created AND stamped blocked.
		let bChild = findChild("B");
		for (let i = 0; i < 400 && !(bChild && bChild.state === "blocked"); i++) {
			await sleep(5);
			bChild = findChild("B");
		}
		assert.ok(bChild, "B child should be created");
		assert.equal(bChild.state, "blocked", "B must be created blocked while A is unmerged");

		// A (no deps) should start its team; B (blocked) must NOT.
		const aChild = findChild("A");
		assert.ok(aChild, "A child should be created");
		for (let i = 0; i < 200 && !teamStarted.includes(aChild.id); i++) await sleep(5);
		assert.equal(teamStarted.includes(aChild.id), true, "A's team should start (no deps)");
		assert.equal(teamStarted.includes(bChild.id), false, "B's team must NOT start while blocked");

		// The atomic spawn stamp for B carries state='blocked'.
		const bStamp = fx.calls.find(c => c.kind === "updateGoal" && c.updates.spawnedFromPlanId === "B");
		assert.ok(bStamp && bStamp.kind === "updateGoal");
		assert.equal(bStamp.updates.state, "blocked", "B's spawn stamp must set state='blocked'");
		assert.deepEqual(bStamp.updates.dependsOnPlanIds, ["A"]);

		// Release A → A merges + archives → auto-unblock scan flips B → todo and
		// starts B's team → B proceeds to merge.
		releaseA();
		const [rA, rB] = await Promise.all([runA, runB]);
		assert.equal(rA.passed, true, rA.output);
		assert.equal(rB.passed, true, rB.output);
		assert.equal(teamStarted.includes(bChild.id), true, "B's team must start after A merges (auto-unblock)");

		// Both children end complete + archived.
		assert.equal(fx.goalStore.get(aChild.id)?.state, "complete");
		assert.equal(fx.goalStore.get(aChild.id)?.archived, true);
		assert.equal(fx.goalStore.get(bChild.id)?.state, "complete");
		assert.equal(fx.goalStore.get(bChild.id)?.archived, true);
	});

	it("cap=1: auto-unblock does NOT start the dependent's team outside the semaphore (start waits for its own permit)", async () => {
		// Regression for the HIGH finding: `_autoUnblockDependents` must only flip
		// blocked→todo; it must NOT call `_startChildTeam`. The just-merged
		// dependency (A) still holds the single per-root permit while its §8 scan
		// runs, so starting a dependent's team there would run it outside the
		// cap. With two dependents (B, C) both depending on A, the buggy path
		// would start BOTH teams during A's scan (peak occupancy 3); the correct
		// path makes each dependent re-acquire the single permit, serialising the
		// team starts (peak occupancy 1).
		const fx = await buildFixture();
		after(() => fx.cleanup());

		fx.goalStore.update(fx.parent.id, { maxConcurrentChildren: 1 });
		assert.equal(fx.goalManager.resolveRootMaxConcurrentChildren(fx.parent.id), 1);

		const findChild = (planId: string) =>
			fx.goalStore.getAll().find(g => g.parentGoalId === fx.parent.id && g.spawnedFromPlanId === planId);

		// Occupancy = window from a child's team-start (setup hook) until its
		// runSubgoalStep fully resolves (≈ permit release). Peak must never
		// exceed the cap of 1: a team may only be started while its step holds a
		// permit.
		const occupying = new Set<string>();
		let occ = 0;
		let maxOcc = 0;
		const teamStarted: string[] = [];
		fx.setSetupHook(async (childGoalId) => {
			teamStarted.push(childGoalId);
			occupying.add(childGoalId);
			occ++;
			maxOcc = Math.max(maxOcc, occ);
		});
		const endOcc = (childGoalId: string | undefined) => {
			if (childGoalId && occupying.delete(childGoalId)) occ--;
		};

		// Hold A's ready-to-merge until B and C are both observed blocked.
		let releaseA!: () => void;
		const aHeld = new Promise<void>(res => { releaseA = res; });
		fx.setReadyToMergeHook(async (childGoalId) => {
			if (fx.goalStore.get(childGoalId)?.spawnedFromPlanId === "A") await aHeld;
			return "passed";
		});

		const stepA = buildSubgoalStep({ planId: "A", title: "Alpha" });
		const stepB = buildSubgoalStep({ planId: "B", title: "Beta", dependsOn: ["A"] });
		const stepC = buildSubgoalStep({ planId: "C", title: "Gamma", dependsOn: ["A"] });
		const aB = buildActive(fx.parent.id);
		const aC = buildActive(fx.parent.id);
		const aA = buildActive(fx.parent.id);

		// Start B and C FIRST so each acquires the single permit, creates itself
		// blocked (A not yet complete), releases the permit, and parks in
		// _waitForChildUnblock. endOcc on resolution (≈ permit release).
		const runB = fx.harness.runSubgoalStep(stepB, aB.signal, aB.active, 0)
			.then(r => { endOcc(findChild("B")?.id); return r; });
		const runC = fx.harness.runSubgoalStep(stepC, aC.signal, aC.active, 0)
			.then(r => { endOcc(findChild("C")?.id); return r; });

		// Wait until B and C are both created AND stamped blocked.
		const bothBlocked = () => {
			const b = findChild("B");
			const c = findChild("C");
			return b?.state === "blocked" && c?.state === "blocked";
		};
		for (let i = 0; i < 600 && !bothBlocked(); i++) await sleep(5);
		assert.ok(bothBlocked(), "B and C must be created blocked before A merges");

		// Neither dependent's team may have started while blocked.
		assert.equal(teamStarted.length, 0, "no dependent team may start while blocked");

		// Now run A; it holds the single permit through its merge + auto-unblock
		// scan.
		const runA = fx.harness.runSubgoalStep(stepA, aA.signal, aA.active, 0)
			.then(r => { endOcc(findChild("A")?.id); return r; });

		// Let A reach (and park at) its held ready-to-merge.
		const aStarted = () => { const a = findChild("A"); return !!a && teamStarted.includes(a.id); };
		for (let i = 0; i < 400 && !aStarted(); i++) await sleep(5);
		assert.equal(aStarted(), true, "A's team should start (no deps)");

		// Release A → merge + archive → auto-unblock scan flips B,C → todo. The
		// scan must NOT start B/C teams; each re-acquires the single permit.
		releaseA();
		const [rA, rB, rC] = await Promise.all([runA, runB, runC]);
		assert.equal(rA.passed, true, rA.output);
		assert.equal(rB.passed, true, rB.output);
		assert.equal(rC.passed, true, rC.output);

		// No deadlock: both dependents eventually started.
		assert.equal(teamStarted.includes(findChild("B")!.id), true, "B must start after A merges + B acquires its permit");
		assert.equal(teamStarted.includes(findChild("C")!.id), true, "C must start after A merges + C acquires its permit");

		// The semaphore stays authoritative: at no point did more than one child
		// occupy a permit-protected window. The buggy in-scan start would peak at
		// 2–3 here.
		assert.equal(maxOcc, 1, `team starts must respect cap=1; observed peak occupancy ${maxOcc}`);

		// All three end complete + archived.
		for (const pid of ["A", "B", "C"]) {
			const g = findChild(pid);
			assert.equal(g?.state, "complete", `${pid} should be complete`);
			assert.equal(g?.archived, true, `${pid} should be archived`);
		}
	});

	it("spawns immediately (not blocked) when every dep is already merged", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const teamStarted: string[] = [];
		fx.setSetupHook(async (childGoalId) => { teamStarted.push(childGoalId); });

		// Run A to completion first so it is merged + archived (state=complete).
		const stepA = buildSubgoalStep({ planId: "A", title: "Alpha" });
		const aA = buildActive(fx.parent.id);
		const rA = await fx.harness.runSubgoalStep(stepA, aA.signal, aA.active, 0);
		assert.equal(rA.passed, true, rA.output);

		const aChild = fx.goalStore.getAll().find(g => g.spawnedFromPlanId === "A");
		assert.ok(aChild && aChild.state === "complete", "A should be complete after its run");

		// B dependsOn A — but A is already merged, so B must spawn immediately.
		const stepB = buildSubgoalStep({ planId: "B", title: "Beta", dependsOn: ["A"] });
		const aB = buildActive(fx.parent.id);
		const rB = await fx.harness.runSubgoalStep(stepB, aB.signal, aB.active, 0);
		assert.equal(rB.passed, true, rB.output);

		const bChild = fx.goalStore.getAll().find(g => g.spawnedFromPlanId === "B");
		assert.ok(bChild, "B child should be created");
		assert.equal(teamStarted.includes(bChild.id), true, "B's team should start immediately when deps satisfied");

		// The spawn stamp for B must NOT carry state='blocked'.
		const bStamp = fx.calls.find(c => c.kind === "updateGoal" && c.updates.spawnedFromPlanId === "B");
		assert.ok(bStamp && bStamp.kind === "updateGoal");
		assert.equal(bStamp.updates.state, undefined, "B must not be stamped blocked when deps are satisfied");
	});
});
