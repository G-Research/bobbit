/**
 * Unit tests for the pure sweep helpers in team-store-consistency.ts.
 *
 * CON-06: `findUntrackedTeamLeadSessions` is the crash-window counterpart to
 * `findOrphanTeamEntries` — it walks goals (not team-store entries) looking
 * for a live team-lead session that the team-store has never heard of. See
 * team-manager.ts::restoreTeams "[CON-06] Pass 2.5" for the live wiring.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	findOrphanTeamEntries,
	findUntrackedTeamLeadSessions,
} from "../src/server/agent/team-store-consistency.ts";

describe("findOrphanTeamEntries", () => {
	it("flags entries whose teamLeadSessionId has no matching session", () => {
		const orphans = findOrphanTeamEntries(
			[
				{ goalId: "g1", teamLeadSessionId: "s1" },
				{ goalId: "g2", teamLeadSessionId: "s2" },
				{ goalId: "g3", teamLeadSessionId: null },
			],
			(id) => id === "s1",
		);
		assert.deepEqual(orphans, ["g2"]);
	});
});

describe("findUntrackedTeamLeadSessions", () => {
	it("adopts a team-mode, non-archived goal whose team-lead session exists but has no team-store entry", () => {
		const goals = [{ id: "goal-1", team: true, archived: false }];
		const result = findUntrackedTeamLeadSessions(
			goals,
			() => false, // no team-store entry for any goal
			(goalId) => (goalId === "goal-1" ? { id: "sess-lead-1", role: "team-lead", teamGoalId: "goal-1" } : undefined),
		);
		assert.deepEqual(result, [{ goalId: "goal-1", teamLeadSessionId: "sess-lead-1" }]);
	});

	it("skips goals that already have a team-store entry", () => {
		const goals = [{ id: "goal-1", team: true, archived: false }];
		const result = findUntrackedTeamLeadSessions(
			goals,
			(goalId) => goalId === "goal-1", // tracked
			(goalId) => ({ id: "sess-lead-1", role: "team-lead", teamGoalId: goalId }),
		);
		assert.deepEqual(result, []);
	});

	it("skips goals with no matching team-lead session (nothing to adopt)", () => {
		const goals = [{ id: "goal-1", team: true, archived: false }];
		const result = findUntrackedTeamLeadSessions(goals, () => false, () => undefined);
		assert.deepEqual(result, []);
	});

	it("skips non-team-mode goals", () => {
		const goals = [{ id: "goal-1", team: false, archived: false }];
		const result = findUntrackedTeamLeadSessions(
			goals,
			() => false,
			(goalId) => ({ id: "sess-lead-1", role: "team-lead", teamGoalId: goalId }),
		);
		assert.deepEqual(result, []);
	});

	it("skips archived goals — teardown/completion, not a live crash orphan", () => {
		const goals = [{ id: "goal-1", team: true, archived: true }];
		const result = findUntrackedTeamLeadSessions(
			goals,
			() => false,
			(goalId) => ({ id: "sess-lead-1", role: "team-lead", teamGoalId: goalId }),
		);
		assert.deepEqual(result, []);
	});

	it("skips ARCHIVED lead sessions — teardownTeam archives the lead then removes the entry; adopting it would resurrect a dismissed team", () => {
		// Post-teardownTeam state: goal still team+unarchived, no team-store
		// entry, lead session archived=true. NOT a crash orphan — must not
		// be adopted even if the caller forgot to pre-filter archived leads.
		const goals = [{ id: "goal-1", team: true, archived: false }];
		const result = findUntrackedTeamLeadSessions(
			goals,
			() => false,
			(goalId) => ({ id: "sess-lead-1", role: "team-lead", teamGoalId: goalId, archived: true }),
		);
		assert.deepEqual(result, []);
	});
});
