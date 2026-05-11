/**
 * Pure-function tests for `findOrphanTeamEntries` — the helper that powers
 * the boot-time consistency sweep in `team-manager.ts::restoreTeams`.
 *
 * Regression context: a team-lead session can be auto-archived on boot when
 * its `.jsonl` is missing (`session-manager.ts:2552/2560`), then permanently
 * purged 7 days later by `purgeExpiredArchives`. Pre-fix the team-store
 * entry stayed put with a pointer at the dead session id, and on the next
 * boot `restoreTeams` loaded the entry into `this.teams`. `startTeam()`
 * then threw "Team already active" because `this.teams.has(goalId)` was
 * true — the goal was permanently stuck at "No agents — Start Team" with
 * a non-functional button.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	findOrphanTeamEntries,
	canPurgeTeamLeadSession,
	type TeamEntryRef,
} from "../src/server/agent/team-store-consistency.ts";

describe("findOrphanTeamEntries", () => {
	it("returns entries whose teamLeadSessionId is missing from the session store", () => {
		const entries: TeamEntryRef[] = [
			{ goalId: "g-stuck", teamLeadSessionId: "dead-session" },
			{ goalId: "g-healthy", teamLeadSessionId: "live-session" },
		];
		const hasSession = (id: string) => id === "live-session";
		assert.deepEqual(findOrphanTeamEntries(entries, hasSession), ["g-stuck"]);
	});

	it("treats archived-but-still-on-disk sessions as present (hasSession lookup is by id, not by live state)", () => {
		// The caller passes a predicate that returns true for any record in
		// SessionStore (archived OR live). Only fully-purged ids are missing.
		const entries: TeamEntryRef[] = [{ goalId: "g", teamLeadSessionId: "archived-session" }];
		const hasSession = (id: string) => id === "archived-session";
		assert.deepEqual(findOrphanTeamEntries(entries, hasSession), []);
	});

	it("skips entries with no teamLeadSessionId (nothing to validate)", () => {
		const entries: TeamEntryRef[] = [
			{ goalId: "g-no-lead", teamLeadSessionId: undefined },
			{ goalId: "g-null-lead", teamLeadSessionId: null },
			{ goalId: "g-empty", teamLeadSessionId: "" },
		];
		const hasSession = (_: string) => false;
		assert.deepEqual(findOrphanTeamEntries(entries, hasSession), []);
	});

	it("flags multiple orphans across many entries (real-world repro)", () => {
		// Mirrors the user's actual data: 4 teams, 2 orphans
		const entries: TeamEntryRef[] = [
			{ goalId: "g-f7c3a1d5", teamLeadSessionId: "live-1" },
			{ goalId: "g-225e4d3d", teamLeadSessionId: "dead-1" },    // Audit subgoals branch
			{ goalId: "g-eed06d11", teamLeadSessionId: "dead-2" },    // Extract generic fixes
			{ goalId: "g-e5b398a4", teamLeadSessionId: "live-2" },
		];
		const liveIds = new Set(["live-1", "live-2"]);
		const hasSession = (id: string) => liveIds.has(id);
		assert.deepEqual(findOrphanTeamEntries(entries, hasSession).sort(), ["g-225e4d3d", "g-eed06d11"]);
	});

	it("is empty for an entirely healthy state", () => {
		const entries: TeamEntryRef[] = [
			{ goalId: "g1", teamLeadSessionId: "s1" },
			{ goalId: "g2", teamLeadSessionId: "s2" },
		];
		const hasSession = (_: string) => true;
		assert.deepEqual(findOrphanTeamEntries(entries, hasSession), []);
	});

	it("handles empty input", () => {
		assert.deepEqual(findOrphanTeamEntries([], () => true), []);
	});
});

describe("canPurgeTeamLeadSession — the safety guard that protects active team-leads", () => {
	// Regression context: the user's "Audit subgoals branch" + "Extract generic
	// fixes" team-leads were destroyed because `purgeOneSession` ran on them
	// while the team-store still referenced them as the live team-lead and the
	// owning goal was NOT archived. The .jsonl + session record were lost
	// irrecoverably. This guard refuses the purge in that exact shape.

	it("refuses to purge a team-lead session referenced by a NON-archived goal", () => {
		const ps = { role: "team-lead", id: "sess-1", teamGoalId: "goal-1" };
		const v = canPurgeTeamLeadSession(ps, () => "sess-1", () => false);
		assert.equal(v.allow, false);
		if (!v.allow) assert.match(v.reason, /team-store still references|teardownTeam/);
	});

	it("ALLOWS purge when the owning goal IS archived (teardownTeam should already have run)", () => {
		const ps = { role: "team-lead", id: "sess-1", teamGoalId: "goal-1" };
		const v = canPurgeTeamLeadSession(ps, () => "sess-1", () => true);
		assert.equal(v.allow, true);
	});

	it("ALLOWS purge when the team-store points at a DIFFERENT session (this one already torn down)", () => {
		const ps = { role: "team-lead", id: "sess-stale", teamGoalId: "goal-1" };
		const v = canPurgeTeamLeadSession(ps, () => "sess-current", () => false);
		assert.equal(v.allow, true);
	});

	it("ALLOWS purge when the team-store has no entry for the goal at all", () => {
		const ps = { role: "team-lead", id: "sess-1", teamGoalId: "goal-1" };
		const v = canPurgeTeamLeadSession(ps, () => undefined, () => false);
		assert.equal(v.allow, true);
	});

	it("ALLOWS purge for non-team-lead sessions (no team-store invariant to protect)", () => {
		const coder = { role: "coder", id: "sess-1", teamGoalId: "goal-1" };
		const reviewer = { role: "reviewer", id: "sess-2", teamGoalId: "goal-1" };
		assert.equal(canPurgeTeamLeadSession(coder, () => "sess-1", () => false).allow, true);
		assert.equal(canPurgeTeamLeadSession(reviewer, () => "sess-2", () => false).allow, true);
	});

	it("ALLOWS purge when the session has no teamGoalId (not in a team)", () => {
		const ps = { role: "team-lead", id: "sess-1" };
		const v = canPurgeTeamLeadSession(ps, () => "sess-1", () => false);
		assert.equal(v.allow, true);
	});

	it("treats null and undefined team-store ref the same — both allow purge", () => {
		const ps = { role: "team-lead", id: "sess-1", teamGoalId: "goal-1" };
		assert.equal(canPurgeTeamLeadSession(ps, () => null, () => false).allow, true);
		assert.equal(canPurgeTeamLeadSession(ps, () => undefined, () => false).allow, true);
	});

	it("real-world repro: user's two doomed team-leads would have been protected", () => {
		// Mirrors the actual data inspected on the user's disk: two team-leads
		// (audit-subgoals = 20dba486, extract-fixes = cab3eb25) of NON-archived
		// goals, both referenced by team-store entries, both about to be purged
		// by the immediate-DELETE path. The guard refuses both.
		const audit = { role: "team-lead", id: "20dba486", teamGoalId: "225e4d3d" };
		const fixes = { role: "team-lead", id: "cab3eb25", teamGoalId: "eed06d11" };
		const teamLeadByGoal = (gid: string) => ({ "225e4d3d": "20dba486", "eed06d11": "cab3eb25" })[gid];
		const archivedByGoal = (_: string) => false;
		assert.equal(canPurgeTeamLeadSession(audit, teamLeadByGoal, archivedByGoal).allow, false);
		assert.equal(canPurgeTeamLeadSession(fixes, teamLeadByGoal, archivedByGoal).allow, false);
	});
});
