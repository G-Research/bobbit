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
import { findOrphanTeamEntries, type TeamEntryRef } from "../src/server/agent/team-store-consistency.ts";

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
