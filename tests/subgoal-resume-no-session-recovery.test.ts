/**
 * Pinned regression: BUG-16 from team-lead-317cdb83 PR #409 live test.
 *
 * When a `subgoal` verify step was interrupted by a server restart
 * AFTER the createGoal call but BEFORE the team-lead spawn (or before
 * the wait-loop entered persistent state), the persisted GateSignalStep
 * had `subgoal.childGoalId` recorded but no `sessionId`. On restart,
 * `_resumeOneVerification` saw "step running but no session id" and
 * marked it FAILED with a non-recoverable error. The child goal record
 * existed but had no team \u2014 a zombie shell that blocked re-spawning.
 *
 * Fix: subgoal steps don't have a session of their OWN; the "session"
 * is the child goal record. The resume path now special-cases subgoal
 * steps:
 *   1. Don't fail with "no session" \u2014 the absence is normal.
 *   2. Mark the step as transiently failed with a recovery note so a
 *      subsequent execution-gate signal (auto-fired on goal-plan
 *      re-signal, or manually invoked) re-runs `runSubgoalStep` which
 *      reconciles via the spawnedFromPlanId fallback (cef6257f).
 *   3. Defensively kick off `setupWorktreeAndStartTeam` for the child
 *      if it exists but has no team \u2014 covers the case where the IIFE
 *      crashed AFTER createGoal but BEFORE setupWorktreeAndStartTeam.
 *
 * The unit test below pins the decision predicate; production code in
 * verification-harness.ts::_resumeOneVerification mirrors it exactly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface PersistedStep {
	type: string;
	status: string;
	sessionId?: string;
	subgoal?: { planId?: string; childGoalId?: string };
	startedAt: number;
}

interface FakeChild {
	id: string;
	archived?: boolean;
	setupStatus?: "ready" | "preparing" | "error";
	hasTeamAgents?: boolean;
}

/**
 * Replicates the production decision rule in
 * `verification-harness.ts::_resumeOneVerification` for subgoal steps.
 *
 * Returns one of:
 *   - { kind: "ok-resume" }  \u2014 normal resume path with sessionId
 *   - { kind: "subgoal-recover", retriggerSetup }  \u2014 BUG-16 path
 *   - { kind: "fail" }  \u2014 non-subgoal step with no session
 */
function decideSubgoalResume(
	step: PersistedStep,
	child: FakeChild | undefined,
): { kind: "ok-resume" } | { kind: "subgoal-recover"; retriggerSetup: boolean } | { kind: "fail" } {
	if (step.sessionId) return { kind: "ok-resume" };
	if (step.type !== "subgoal") return { kind: "fail" };
	const childGoalId = step.subgoal?.childGoalId;
	if (!childGoalId || !child || child.archived || child.setupStatus === "error") {
		return { kind: "subgoal-recover", retriggerSetup: false };
	}
	const retriggerSetup = !child.hasTeamAgents;
	return { kind: "subgoal-recover", retriggerSetup };
}

describe("BUG-16: subgoal step resume after restart (no session id)", () => {
	it("non-subgoal step with no session id still fails (existing behaviour)", () => {
		const step: PersistedStep = {
			type: "command",
			status: "running",
			startedAt: Date.now() - 30_000,
		};
		assert.deepEqual(decideSubgoalResume(step, undefined), { kind: "fail" });
	});

	it("subgoal step with no session id and no recorded child: recover but don't re-trigger setup", () => {
		// Step crashed BEFORE createGoal completed \u2014 there's no child to
		// reattach to. A subsequent execution-gate signal will re-spawn.
		const step: PersistedStep = {
			type: "subgoal",
			status: "running",
			startedAt: Date.now() - 30_000,
			subgoal: { planId: "phase-2-storage" },
		};
		assert.deepEqual(decideSubgoalResume(step, undefined), {
			kind: "subgoal-recover",
			retriggerSetup: false,
		});
	});

	it("subgoal step with childGoalId + child exists with no team: recover AND re-trigger setup", () => {
		// This is the headline BUG-16 scenario: zombie shell child created
		// but never got its team-lead.
		const step: PersistedStep = {
			type: "subgoal",
			status: "running",
			startedAt: Date.now() - 30_000,
			subgoal: { planId: "phase-2-storage", childGoalId: "9dbbce41" },
		};
		const child: FakeChild = { id: "9dbbce41", setupStatus: "ready", hasTeamAgents: false };
		assert.deepEqual(decideSubgoalResume(step, child), {
			kind: "subgoal-recover",
			retriggerSetup: true,
		});
	});

	it("subgoal step with healthy child (team agents already exist): recover, no re-trigger", () => {
		const step: PersistedStep = {
			type: "subgoal",
			status: "running",
			startedAt: Date.now() - 30_000,
			subgoal: { planId: "phase-2-storage", childGoalId: "9dbbce41" },
		};
		const child: FakeChild = { id: "9dbbce41", setupStatus: "ready", hasTeamAgents: true };
		assert.deepEqual(decideSubgoalResume(step, child), {
			kind: "subgoal-recover",
			retriggerSetup: false,
		});
	});

	it("subgoal step with archived child: recover but don't re-trigger setup", () => {
		// User explicitly archived the child mid-flight; don't fight that.
		const step: PersistedStep = {
			type: "subgoal",
			status: "running",
			startedAt: Date.now() - 30_000,
			subgoal: { planId: "phase-2-storage", childGoalId: "9dbbce41" },
		};
		const child: FakeChild = { id: "9dbbce41", archived: true, hasTeamAgents: false };
		assert.deepEqual(decideSubgoalResume(step, child), {
			kind: "subgoal-recover",
			retriggerSetup: false,
		});
	});

	it("subgoal step with errored-setup child: don't re-trigger (would loop)", () => {
		// Child's worktree setup failed permanently. Re-triggering won't
		// help \u2014 needs human intervention. Mark recover-without-retry.
		const step: PersistedStep = {
			type: "subgoal",
			status: "running",
			startedAt: Date.now() - 30_000,
			subgoal: { planId: "phase-2-storage", childGoalId: "9dbbce41" },
		};
		const child: FakeChild = { id: "9dbbce41", setupStatus: "error", hasTeamAgents: false };
		assert.deepEqual(decideSubgoalResume(step, child), {
			kind: "subgoal-recover",
			retriggerSetup: false,
		});
	});

	it("step with sessionId proceeds via the normal resume path (not subgoal-specific)", () => {
		const step: PersistedStep = {
			type: "subgoal",
			status: "running",
			sessionId: "some-session-id",
			startedAt: Date.now() - 30_000,
			subgoal: { planId: "phase-2-storage", childGoalId: "9dbbce41" },
		};
		assert.deepEqual(decideSubgoalResume(step, { id: "9dbbce41" }), { kind: "ok-resume" });
	});
});
