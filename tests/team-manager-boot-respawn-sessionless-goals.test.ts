/**
 * Pinned regression: TeamManager.resubscribeTeamEvents respawns
 * team-leads for sessionless in-progress goals on boot.
 *
 * Live test (PR #409 v0.2-embeddings, Issue 12 from
 * team-lead-4285af30): three Phase-2 leaves (cfe8cbe2-hybrid-
 * retrieval, 5c8a6c7a-write-policies-and-dedup, e270b449-safety-
 * scanner) all sat in:
 *   state: in-progress
 *   setupStatus: ready
 *   archived: null
 *   team agents: []
 *   team-lead session: NONE
 *
 * with their parent (4285af30 Meg Awatt) holding still on a stale
 * `Resume Error: Step was running but had no session ID` failure.
 *
 * Why the existing BUG-16 recovery (verification-harness.ts ~L857)
 * didn't help: that path only fires when there's an active
 * verification with the child's recorded planId. If the parent's
 * verification record is itself lost (active-verifications.json
 * gone, or the verification was never persisted), the children stay
 * sessionless until manually rescued.
 *
 * Fix: at the end of TeamManager.resubscribeTeamEvents (called once
 * on boot after restoreTeams), walk all non-archived in-progress
 * goals; for any with NO team entry in `this.teams`, fire
 * setupWorktreeAndStartTeam to re-spawn a fresh team-lead.
 *
 * The team-lead's first move will be to reconcile with the work
 * already on the child's branch — no work is lost.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface GoalLike {
	id: string;
	state?: string;
	setupStatus?: string;
	archived?: boolean;
	title?: string;
}

/** Replicates the boot-respawn predicate. */
function shouldRespawnTeamLead(
	goal: GoalLike,
	hasTeamEntry: boolean,
): boolean {
	if (goal.archived) return false;
	if (goal.state !== "in-progress") return false;
	if (goal.setupStatus !== "ready") return false;
	if (hasTeamEntry) return false; // Already has a team entry
	return true;
}

describe("TeamManager boot-respawn predicate for sessionless goals", () => {
	it("THE bug: in-progress, setupStatus=ready, no team entry -> respawn", () => {
		// Exact pattern from the live bug report (cfe8cbe2 / 5c8a6c7a / e270b449)
		assert.equal(shouldRespawnTeamLead(
			{ id: "cfe8cbe2", state: "in-progress", setupStatus: "ready", archived: false },
			false,
		), true);
	});

	it("archived goal -> don't respawn (terminal)", () => {
		assert.equal(shouldRespawnTeamLead(
			{ id: "x", state: "in-progress", setupStatus: "ready", archived: true },
			false,
		), false);
	});

	it("complete goal -> don't respawn (terminal)", () => {
		assert.equal(shouldRespawnTeamLead(
			{ id: "x", state: "complete", setupStatus: "ready", archived: false },
			false,
		), false);
	});

	it("shelved goal -> don't respawn (terminal)", () => {
		assert.equal(shouldRespawnTeamLead(
			{ id: "x", state: "shelved", setupStatus: "ready", archived: false },
			false,
		), false);
	});

	it("setup interrupted by previous restart (setupStatus=error) -> don't respawn", () => {
		// The user (or retrySetup) needs to kick this manually; respawning
		// blindly could overwrite a partial setup that's still being investigated.
		assert.equal(shouldRespawnTeamLead(
			{ id: "x", state: "in-progress", setupStatus: "error", archived: false },
			false,
		), false);
	});

	it("setupStatus=preparing -> don't respawn (already in flight)", () => {
		// _recoverStuckSetups will mark it error first if interrupted.
		assert.equal(shouldRespawnTeamLead(
			{ id: "x", state: "in-progress", setupStatus: "preparing", archived: false },
			false,
		), false);
	});

	it("already has a team entry (live or restored) -> don't respawn", () => {
		// `restoreTeams` recreated a TeamEntry from disk; the team-lead
		// session may or may not be alive but at minimum the entry exists,
		// so the existing zombie-reviewer-sweep / lead-event resubscribe
		// will handle it.
		assert.equal(shouldRespawnTeamLead(
			{ id: "x", state: "in-progress", setupStatus: "ready", archived: false },
			true,
		), false);
	});

	it("todo state -> don't respawn (never started)", () => {
		// A goal that's been created but never had its team launched goes
		// through the createGoal flow, not boot recovery.
		assert.equal(shouldRespawnTeamLead(
			{ id: "x", state: "todo", setupStatus: "ready", archived: false },
			false,
		), false);
	});

	it("undefined state defaults to NOT respawning (defensive)", () => {
		assert.equal(shouldRespawnTeamLead(
			{ id: "x", setupStatus: "ready", archived: false },
			false,
		), false);
	});
});
