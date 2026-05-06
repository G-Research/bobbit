/**
 * Phase 3 — happy-path merge + archive flow when child reaches ready-to-merge.
 *
 * SUBGOALS-SPEC §2 step 8: on `outcome.merged || outcome.alreadyMerged`:
 *   - teamManager.teardownTeam(childGoalId)  (try/catch — non-fatal)
 *   - goalManager.archiveGoalAfterMerge(childGoalId)
 *   - Return passed=true
 *
 * On conflict:
 *   - Return passed=false; do NOT auto-archive, do NOT auto-resolve
 *     (anti-pattern §9). Output references manual recovery.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

describe("runSubgoalStep — merge + archive flow", () => {
	it("ready-to-merge passes → mergeChild + teardownTeam + archiveAfterMerge in order", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const step = buildSubgoalStep({ planId: "p-merge" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);

		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);
		assert.equal(result.passed, true);
		assert.match(result.output, /merged \+ archived/i);

		const order = fx.calls.map(c => c.kind);
		const mergeIdx = order.indexOf("mergeChild");
		const tearIdx = order.indexOf("teardownTeam");
		const archIdx = order.indexOf("archiveGoalAfterMerge");
		assert.notEqual(mergeIdx, -1);
		assert.notEqual(tearIdx, -1);
		assert.notEqual(archIdx, -1);
		assert.ok(mergeIdx < tearIdx, "mergeChild must precede teardownTeam");
		assert.ok(tearIdx < archIdx, "teardownTeam must precede archiveAfterMerge");
	});

	it("R-028: archiveGoalAfterMerge sets state=complete BEFORE archiving (Lesson 4.2 rescue path)", async () => {
		// Order is load-bearing: the archived snapshot must have
		// state=complete on disk so the rescue-path tier-2 short-circuit fires.
		// Wrap goalStore.update to log the state stamp; wrap goalStore.archive
		// to log the archive call. Assert state-complete < archive.
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const storeCalls: string[] = [];
		const origUpdate = fx.goalStore.update.bind(fx.goalStore);
		const origArchive = fx.goalStore.archive.bind(fx.goalStore);
		(fx.goalStore as any).update = (id: string, updates: any) => {
			if (updates && updates.state === "complete") storeCalls.push(`state-complete:${id}`);
			return origUpdate(id, updates);
		};
		(fx.goalStore as any).archive = (id: string) => {
			storeCalls.push(`archive:${id}`);
			return origArchive(id);
		};

		const step = buildSubgoalStep({ planId: "p-order" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);
		assert.equal(result.passed, true);

		const stateIdx = storeCalls.findIndex(c => c.startsWith("state-complete:"));
		const archiveIdx = storeCalls.findIndex(c => c.startsWith("archive:"));
		assert.notEqual(stateIdx, -1, `expected state-complete log entry, got: ${storeCalls.join(", ")}`);
		assert.notEqual(archiveIdx, -1, `expected archive log entry, got: ${storeCalls.join(", ")}`);
		assert.ok(stateIdx < archiveIdx,
			`state=complete must be set BEFORE archive(). order: ${storeCalls.join(" → ")}`);
	});

	it("alreadyMerged child → still tears down + archives, returns passed=true", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		fx.setMergeOutcome({ alreadyMerged: true, merged: false, output: "Already up to date." });

		const step = buildSubgoalStep({ planId: "p-already" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);
		assert.equal(result.passed, true);
		assert.match(result.output, /already merged/i);
		assert.ok(fx.calls.find(c => c.kind === "teardownTeam"));
		assert.ok(fx.calls.find(c => c.kind === "archiveGoalAfterMerge"));
	});

	it("merge conflict → passed=false, NO auto-archive, NO auto-teardown, NO auto-resolve (anti-pattern §9)", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		fx.setMergeOutcome({ conflict: true, output: "Auto-merging file.txt\nCONFLICT (content): merge conflict in file.txt" });

		const step = buildSubgoalStep({ planId: "p-conflict" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, false, "merge conflict must fail the step");
		assert.match(result.output, /merge conflict|manual resolution|manual recovery/i,
			`expected manual-recovery message, got: ${result.output}`);
		assert.match(result.output, /docs\/nested-goals\.md/, "output must reference docs/nested-goals.md");

		// Anti-pattern §9: no auto-teardown, no auto-archive.
		assert.equal(fx.calls.find(c => c.kind === "teardownTeam"), undefined,
			"must NOT auto-teardown on conflict — preserves work for retry");
		assert.equal(fx.calls.find(c => c.kind === "archiveGoalAfterMerge"), undefined,
			"must NOT auto-archive on conflict — preserves work for retry");
	});

	it("teardownTeam failure is non-fatal (try/catch) — archive + passed=true still happen", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		// Override teardownTeam to throw.
		const origTeardown = fx.mockTeamManager.teardownTeam;
		fx.mockTeamManager.teardownTeam = async (goalId: string) => {
			fx.calls.push({ kind: "teardownTeam", goalId });
			throw new Error("teardown blew up");
		};

		const step = buildSubgoalStep({ planId: "p-teardown-fail" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, true);
		assert.ok(fx.calls.find(c => c.kind === "archiveGoalAfterMerge"),
			"archiveAfterMerge must still run even when teardown threw");

		fx.mockTeamManager.teardownTeam = origTeardown;
	});
});
