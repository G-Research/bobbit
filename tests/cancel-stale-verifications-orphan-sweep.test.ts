/**
 * Pinned regression: when a previous gate-signal route handler crashed
 * BEFORE populating `activeVerifications` (the `dependsOn` TypeError class),
 * any reviewer sessions it spawned survive into the next signal cycle.
 * The original `cancelStaleVerifications` walked only `activeVerifications`,
 * so it would silently no-op on these orphans \u2014 they ran in parallel with
 * the new round, finished, tried to submit a `verification_result`, were
 * correctly rejected by the harness, and then sat idle holding a worktree.
 *
 * Fix: after the activeVerifications sweep, fall back to the team-manager's
 * reviewer-agent list and terminate any reviewer for the goal that wasn't
 * already cancelled. Reviewers are short-lived and only spawned by the
 * harness, so over-terminating is safe \u2014 the new round re-spawns the ones
 * it needs.
 *
 * See:
 *   - team-lead-317cdb83 live integration test (PR #409 hardening)
 *   - src/server/agent/verification-harness.ts::cancelStaleVerifications
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-stale-orphan-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

// ---------------------------------------------------------------------------
// Minimal stubs \u2014 we exercise the orphan-sweep code path which only needs
// `teamManager.listAgents` + `sessionManager.terminateSession` +
// `teamManager.unregisterReviewerSession`. The harness's main verify loop
// is not exercised here.
// ---------------------------------------------------------------------------

interface ReviewerAgentLike {
	sessionId: string;
	role: string;
	task?: string;
}

class FakeTeamManager {
	public reviewers: ReviewerAgentLike[] = [];
	public unregisterCalls: string[] = [];

	listAgents(_goalId: string): ReviewerAgentLike[] {
		// Return a copy so harness iteration is decoupled from our mutations.
		return [...this.reviewers];
	}

	unregisterReviewerSession(_goalId: string, sessionId: string): void {
		this.unregisterCalls.push(sessionId);
		const i = this.reviewers.findIndex(r => r.sessionId === sessionId);
		if (i !== -1) this.reviewers.splice(i, 1);
	}
}

class FakeSessionManager {
	public terminated: string[] = [];
	async terminateSession(sessionId: string): Promise<void> {
		this.terminated.push(sessionId);
	}
	getSession(_id: string): unknown { return undefined; }
}

function buildHarness(team: FakeTeamManager, session: FakeSessionManager): any {
	const stateDir = fs.mkdtempSync(path.join(TEST_DIR, "state-"));
	const harness = new VerificationHarness(
		stateDir,
		undefined,
		() => { /* no broadcasts */ },
		{ get: () => null, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined as any,
		undefined,
	);
	(harness as any).teamManager = team;
	(harness as any).sessionManager = session;
	(harness as any).resolveGateStore = () => ({
		updateSignalVerification: () => {},
	});
	return harness;
}

test("cancelStaleVerifications terminates orphan reviewers missed by activeVerifications walk", async () => {
	const team = new FakeTeamManager();
	team.reviewers = [
		{ sessionId: "orphan-reviewer-1", role: "reviewer", task: "Verification review: DAG correctness" },
		{ sessionId: "orphan-reviewer-2", role: "reviewer", task: "Verification review: Spec completeness" },
	];
	const session = new FakeSessionManager();
	const harness = buildHarness(team, session);

	// activeVerifications is empty \u2014 simulates the post-crash scenario where
	// the route handler died before populating the map.
	assert.equal((harness as any).activeVerifications.size, 0);

	await harness.cancelStaleVerifications("goal-1", "plan-review");

	// Both orphan reviewers must have been terminated and unregistered.
	assert.deepEqual(session.terminated.sort(), ["orphan-reviewer-1", "orphan-reviewer-2"]);
	assert.deepEqual(team.unregisterCalls.sort(), ["orphan-reviewer-1", "orphan-reviewer-2"]);
});

test("orphan-sweep does NOT touch worker-role agents (only `reviewer` role)", async () => {
	const team = new FakeTeamManager();
	team.reviewers = [
		{ sessionId: "reviewer-1", role: "reviewer", task: "Verification review: foo" },
		// A worker the team-lead spawned via team_spawn \u2014 must be untouched
		{ sessionId: "coder-1", role: "coder", task: "implement feature X" },
	];
	const session = new FakeSessionManager();
	const harness = buildHarness(team, session);

	await harness.cancelStaleVerifications("goal-1", "design-doc");

	// Only the reviewer is terminated. The coder is left alone.
	assert.deepEqual(session.terminated, ["reviewer-1"]);
	assert.deepEqual(team.unregisterCalls, ["reviewer-1"]);
	// And it's still in the (post-mutation) reviewer list because we mutate
	// the FakeTeamManager.reviewers list on unregister; the coder must remain.
	assert.equal(team.reviewers.length, 1);
	assert.equal(team.reviewers[0].sessionId, "coder-1");
});

test("orphan-sweep skips reviewers already cancelled via activeVerifications path", async () => {
	const team = new FakeTeamManager();
	team.reviewers = [
		{ sessionId: "already-cancelled", role: "reviewer", task: "Verification review: foo" },
		{ sessionId: "actually-orphan", role: "reviewer", task: "Verification review: bar" },
	];
	const session = new FakeSessionManager();
	const harness = buildHarness(team, session);

	// Pre-populate activeVerifications with an entry whose step has already
	// terminated `already-cancelled`. The orphan-sweep should NOT re-terminate.
	(harness as any).activeVerifications.set("sig-1", {
		signalId: "sig-1",
		goalId: "goal-1",
		gateId: "design-doc",
		overallStatus: "running",
		startedAt: Date.now(),
		steps: [
			{ name: "Cancelled step", type: "llm-review", status: "running", phase: 0, sessionId: "already-cancelled" },
		],
		cancelled: false,
	});
	(harness as any)._persistActive = () => {};

	await harness.cancelStaleVerifications("goal-1", "design-doc");

	// `already-cancelled` was terminated once via the activeVerifications walk,
	// not twice via the orphan sweep.
	const cancelledCount = session.terminated.filter(id => id === "already-cancelled").length;
	assert.equal(cancelledCount, 1, "must not double-terminate via orphan sweep");

	// `actually-orphan` was caught only by the orphan sweep.
	assert.ok(session.terminated.includes("actually-orphan"),
		"orphan reviewer not in activeVerifications must be terminated by the sweep");
});

test("orphan-sweep is a no-op when no reviewers exist", async () => {
	const team = new FakeTeamManager();
	team.reviewers = [];
	const session = new FakeSessionManager();
	const harness = buildHarness(team, session);

	await harness.cancelStaleVerifications("goal-1", "any-gate");

	assert.deepEqual(session.terminated, []);
	assert.deepEqual(team.unregisterCalls, []);
});
