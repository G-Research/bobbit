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

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	findOrphanTeamEntries,
	canPurgeTeamLeadSession,
	pickCanonicalTeamLeadJsonl,
	reconstructTeamLeadSessionRecord,
	reconstructAgentSessionRecord,
	scanSlugDirForJsonlsAt,
	slugDirNameForCwd,
	isStaleRecoveredTeamLeadTitle,
	prettyRoleName,
	parseAgentWorktreeName,
	discoverAgentsForGoal,
	type TeamEntryRef,
	type CandidateJsonl,
} from "../src/server/agent/team-store-consistency.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

describe("slugDirNameForCwd — agent sessions slug encoding", () => {
	it("encodes a normal absolute path", () => {
		assert.equal(
			slugDirNameForCwd("/Users/aj/Documents/dev/bobbit-subgoals-wt/goal-audit-subg-225e4d3d"),
			"--Users-aj-Documents-dev-bobbit-subgoals-wt-goal-audit-subg-225e4d3d--",
		);
	});

	it("preserves existing dashes inside path components", () => {
		assert.equal(slugDirNameForCwd("/a/b-c-d/e"), "--a-b-c-d-e--");
	});

	it("strips leading slashes before wrapping", () => {
		assert.equal(slugDirNameForCwd("//foo/bar"), "--foo-bar--");
	});
});

describe("pickCanonicalTeamLeadJsonl — mtime-first, size as tiebreaker", () => {
	it("picks the file with the latest mtime even if a larger sibling exists", () => {
		// Mirrors the "Extract generic fixes" case on the user's disk: a
		// short-lived 354 KB sibling jsonl from a failed restart attempt is
		// LARGER than the team-lead's canonical 245 KB transcript, but the
		// canonical file has the latest mtime. Size-first would pick wrong.
		const candidates: CandidateJsonl[] = [
			{ jsonlPath: "/x/a.jsonl", size: 354_000, mtime: 100, agentSessionId: "a", agentStartedAtIso: "2026-05-08T11:42:56Z" },
			{ jsonlPath: "/x/b.jsonl", size: 245_000, mtime: 200, agentSessionId: "b", agentStartedAtIso: "2026-05-08T10:54:09Z" },
		];
		const chosen = pickCanonicalTeamLeadJsonl(candidates);
		assert.equal(chosen?.jsonlPath, "/x/b.jsonl");
	});

	it("falls back to size when mtimes are equal", () => {
		const candidates: CandidateJsonl[] = [
			{ jsonlPath: "/x/small.jsonl", size: 1024, mtime: 100, agentSessionId: "s", agentStartedAtIso: "i" },
			{ jsonlPath: "/x/big.jsonl",   size: 999_999, mtime: 100, agentSessionId: "b", agentStartedAtIso: "i" },
		];
		assert.equal(pickCanonicalTeamLeadJsonl(candidates)?.jsonlPath, "/x/big.jsonl");
	});

	it("returns null on empty input", () => {
		assert.equal(pickCanonicalTeamLeadJsonl([]), null);
	});

	it("single candidate is trivially canonical", () => {
		const only: CandidateJsonl = { jsonlPath: "/x/only.jsonl", size: 1, mtime: 1, agentSessionId: "x", agentStartedAtIso: "i" };
		assert.equal(pickCanonicalTeamLeadJsonl([only])?.jsonlPath, "/x/only.jsonl");
	});

	it("real-world repro for 'Audit subgoals branch': 12 candidates, picks the 3.65 MB one with latest mtime", () => {
		// Numbers taken from the user's actual disk inspection.
		const candidates: CandidateJsonl[] = [
			{ jsonlPath: "/x/main.jsonl",  size: 3_651_800, mtime: 1747242000000, agentSessionId: "019dfee7", agentStartedAtIso: "2026-05-06T20:07:47Z" },
			{ jsonlPath: "/x/short1.jsonl", size: 52_500,   mtime: 1746998000000, agentSessionId: "019dfeef", agentStartedAtIso: "2026-05-06T20:17:05Z" },
			{ jsonlPath: "/x/short2.jsonl", size: 58_400,   mtime: 1746997000000, agentSessionId: "019dfeef-dd3d", agentStartedAtIso: "2026-05-06T20:17:05Z" },
		];
		assert.equal(pickCanonicalTeamLeadJsonl(candidates)?.agentSessionId, "019dfee7");
	});
});

describe("reconstructTeamLeadSessionRecord — fields the boot recovery writes back", () => {
	it("produces a complete PersistedSession-shape record for a recoverable team-lead", () => {
		const r = reconstructTeamLeadSessionRecord({
			teamLeadSessionId: "20dba486-26e8-417d-b6dc-013094da0153",
			goal: {
				id: "225e4d3d-c656-43fe-a05c-4d6ab8c252a8",
				title: "Audit subgoals branch",
				projectId: "f8c621ad-9af5-4312-b997-72c07968b87a",
				worktreePath: "/Users/aj/Documents/dev/bobbit-subgoals-wt/goal-audit-subg-225e4d3d",
				repoPath: "/Users/aj/Documents/dev/bobbit-subgoals",
				branch: "goal/audit-subg-225e4d3d",
				sandboxed: false,
			},
			chosenJsonl: {
				jsonlPath: "/Users/aj/.bobbit/agent/sessions/X/Y.jsonl",
				size: 3_651_800,
				mtime: 1747242000000,
				agentSessionId: "019dfee7-578f-7773-8e32-9e1ba838a4ad",
				agentStartedAtIso: "2026-05-06T20:07:47.343Z",
			},
		});
		assert.ok(r);
		assert.equal(r!.id, "20dba486-26e8-417d-b6dc-013094da0153");
		assert.equal(r!.role, "team-lead");
		assert.equal(r!.teamGoalId, "225e4d3d-c656-43fe-a05c-4d6ab8c252a8");
		assert.equal(r!.agentSessionFile, "/Users/aj/.bobbit/agent/sessions/X/Y.jsonl");
		assert.equal(r!.cwd, "/Users/aj/Documents/dev/bobbit-subgoals-wt/goal-audit-subg-225e4d3d");
		assert.equal(r!.worktreePath, "/Users/aj/Documents/dev/bobbit-subgoals-wt/goal-audit-subg-225e4d3d");
		assert.equal(r!.repoPath, "/Users/aj/Documents/dev/bobbit-subgoals");
		assert.equal(r!.branch, "goal/audit-subg-225e4d3d");
		assert.equal(r!.projectId, "f8c621ad-9af5-4312-b997-72c07968b87a");
		assert.equal(r!.archived, false);
		assert.equal(r!.accessory, "crown");
		assert.match(r!.title, /Audit subgoals branch.*recovered/);
		// createdAt should equal the .jsonl's first-line timestamp.
		assert.equal(r!.createdAt, Date.parse("2026-05-06T20:07:47.343Z"));
		// lastActivity should equal the file's last-write timestamp.
		assert.equal(r!.lastActivity, 1747242000000);
	});

	it("returns null when the goal has no worktreePath (can't reconstruct cwd)", () => {
		const r = reconstructTeamLeadSessionRecord({
			teamLeadSessionId: "s",
			goal: { id: "g" },
			chosenJsonl: { jsonlPath: "/x.jsonl", size: 1, mtime: 1, agentSessionId: "a", agentStartedAtIso: "2026-05-01T00:00:00Z" },
		});
		assert.equal(r, null);
	});

	it("falls back to Date.now() when the .jsonl's first-line timestamp is unparseable", () => {
		const before = Date.now();
		const r = reconstructTeamLeadSessionRecord({
			teamLeadSessionId: "s",
			goal: { id: "g", worktreePath: "/some/wt" },
			chosenJsonl: { jsonlPath: "/x.jsonl", size: 1, mtime: 1, agentSessionId: "a", agentStartedAtIso: "not-a-date" },
		});
		const after = Date.now();
		assert.ok(r);
		assert.ok(r!.createdAt >= before && r!.createdAt <= after);
	});

	it("uses '(recovered)' suffix in title (so users can tell it's not the original session)", () => {
		const r = reconstructTeamLeadSessionRecord({
			teamLeadSessionId: "s",
			goal: { id: "g", title: "Audit X", worktreePath: "/wt" },
			chosenJsonl: { jsonlPath: "/x.jsonl", size: 1, mtime: 1, agentSessionId: "a", agentStartedAtIso: "2026-05-01T00:00:00Z" },
		});
		assert.match(r!.title, /\(recovered\)/);
	});

	it("handles goal with no title (uses '(recovered)' as placeholder)", () => {
		const r = reconstructTeamLeadSessionRecord({
			teamLeadSessionId: "s",
			goal: { id: "g", worktreePath: "/wt" },
			chosenJsonl: { jsonlPath: "/x.jsonl", size: 1, mtime: 1, agentSessionId: "a", agentStartedAtIso: "2026-05-01T00:00:00Z" },
		});
		assert.ok(r);
		assert.match(r!.title, /Team Lead:.*\(recovered\)/);
	});

	it("uses the injected funName in the title shape, matching bobbit's normal 'Team Lead: <fun-name>' format", () => {
		const r = reconstructTeamLeadSessionRecord({
			teamLeadSessionId: "s",
			goal: { id: "g", title: "Audit X", worktreePath: "/wt" },
			chosenJsonl: { jsonlPath: "/x.jsonl", size: 1, mtime: 1, agentSessionId: "a", agentStartedAtIso: "2026-05-01T00:00:00Z" },
			funName: "Jira Springer",
		});
		assert.equal(r!.title, "Team Lead: Jira Springer (recovered)");
	});

	it("marks the record as archived when the underlying goal is archived (so the sidebar shows it under archived sessions)", () => {
		const r = reconstructTeamLeadSessionRecord({
			teamLeadSessionId: "s",
			goal: { id: "g", title: "Sub", worktreePath: "/wt", archived: true },
			chosenJsonl: { jsonlPath: "/x.jsonl", size: 1, mtime: 1234567890, agentSessionId: "a", agentStartedAtIso: "2026-05-01T00:00:00Z" },
			funName: "Beans",
		});
		assert.equal(r!.archived, true);
		assert.equal(r!.archivedAt, 1234567890);
	});

	it("leaves archivedAt undefined when goal is live", () => {
		const r = reconstructTeamLeadSessionRecord({
			teamLeadSessionId: "s",
			goal: { id: "g", title: "Live", worktreePath: "/wt", archived: false },
			chosenJsonl: { jsonlPath: "/x.jsonl", size: 1, mtime: 100, agentSessionId: "a", agentStartedAtIso: "2026-05-01T00:00:00Z" },
		});
		assert.equal(r!.archived, false);
		assert.equal(r!.archivedAt, undefined);
	});
});

// ── End-to-end recovery flow against a real temp file system ─────────────────
//
// This suite proves the chain works for both the user's actual scenarios:
//
//   1. Parent team-lead disappeared but team-store entry survived → orphan
//      recovery (reconstructed via team-store pointer + slug-dir lookup).
//
//   2. Subgoal team-lead disappeared AND team-store entry was lost too →
//      fully-orphan recovery (reconstructed via goal record + slug-dir lookup,
//      with a fresh session id).
//
// Both pass through `scanSlugDirForJsonlsAt` + `pickCanonicalTeamLeadJsonl` +
// `reconstructTeamLeadSessionRecord`. The boot wiring in `team-manager.ts`
// calls these in sequence; this test exercises the same sequence against a
// real fs.

describe("End-to-end recovery against a real slug-dir on disk", () => {
	let tmpRoot: string;
	let sessionsDir: string;
	beforeEach(() => {
		tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "team-recovery-")));
		sessionsDir = path.join(tmpRoot, "agent-sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
	});

	/** Helper: lay down a fake .jsonl with a valid session-start first line. */
	function makeJsonl(opts: { dir: string; name: string; cwd: string; agentId: string; startedAt: string; size?: number; mtimeMs?: number }) {
		const full = path.join(opts.dir, opts.name);
		const first = JSON.stringify({ type: "session", version: 3, id: opts.agentId, cwd: opts.cwd, timestamp: opts.startedAt });
		// Pad to requested size (after first line + newline).
		const targetSize = opts.size ?? 1024;
		const tail = "x".repeat(Math.max(0, targetSize - first.length - 1));
		fs.writeFileSync(full, first + "\n" + tail, "utf-8");
		if (opts.mtimeMs != null) {
			const t = opts.mtimeMs / 1000;
			fs.utimesSync(full, t, t);
		}
		return full;
	}

	it("scans a slug-dir with multiple .jsonls and matches the picker's canonical choice (the user's audit-subgoals shape)", () => {
		const cwd = "/Users/aj/Documents/dev/bobbit-subgoals-wt/goal-audit-subg-225e4d3d";
		const slugDir = path.join(sessionsDir, slugDirNameForCwd(cwd));
		fs.mkdirSync(slugDir, { recursive: true });
		// The "canonical" file — bigger AND most recent (mirrors the actual
		// 3.65 MB / latest-mtime file on the user's disk).
		makeJsonl({ dir: slugDir, name: "2026-05-06T20-07-47-343Z_canonical.jsonl", cwd, agentId: "019dfee7-canonical", startedAt: "2026-05-06T20:07:47.343Z", size: 8192, mtimeMs: 2_000_000_000_000 });
		// Sibling files from failed restarts — older mtimes, smaller.
		makeJsonl({ dir: slugDir, name: "2026-05-06T20-17-05-834Z_stale1.jsonl", cwd, agentId: "stale1", startedAt: "2026-05-06T20:17:05Z", size: 512, mtimeMs: 1_999_000_000_000 });
		makeJsonl({ dir: slugDir, name: "2026-05-06T20-17-05-853Z_stale2.jsonl", cwd, agentId: "stale2", startedAt: "2026-05-06T20:17:05Z", size: 512, mtimeMs: 1_998_000_000_000 });

		const candidates = scanSlugDirForJsonlsAt(sessionsDir, cwd, fs, path.join);
		assert.equal(candidates.length, 3, "all three valid candidates should be returned");
		const chosen = pickCanonicalTeamLeadJsonl(candidates);
		assert.ok(chosen);
		assert.equal(chosen!.agentSessionId, "019dfee7-canonical");
	});

	it("ignores .jsonls whose first-line cwd doesn't match (defensive — should not happen but the filter is cheap)", () => {
		const cwd = "/some/wt";
		const slugDir = path.join(sessionsDir, slugDirNameForCwd(cwd));
		fs.mkdirSync(slugDir, { recursive: true });
		makeJsonl({ dir: slugDir, name: "ours.jsonl", cwd, agentId: "ours", startedAt: "2026-05-01T00:00:00Z" });
		makeJsonl({ dir: slugDir, name: "alien.jsonl", cwd: "/elsewhere", agentId: "alien", startedAt: "2026-05-01T00:00:00Z" });

		const candidates = scanSlugDirForJsonlsAt(sessionsDir, cwd, fs, path.join);
		assert.equal(candidates.length, 1);
		assert.equal(candidates[0].agentSessionId, "ours");
	});

	it("returns empty when the slug-dir doesn't exist (recovery is a no-op for goals with no surviving data)", () => {
		const candidates = scanSlugDirForJsonlsAt(sessionsDir, "/never/created", fs, path.join);
		assert.deepEqual(candidates, []);
	});

	it("ignores files that aren't .jsonl", () => {
		const cwd = "/wt";
		const slugDir = path.join(sessionsDir, slugDirNameForCwd(cwd));
		fs.mkdirSync(slugDir, { recursive: true });
		makeJsonl({ dir: slugDir, name: "valid.jsonl", cwd, agentId: "v", startedAt: "2026-05-01T00:00:00Z" });
		fs.writeFileSync(path.join(slugDir, "notes.txt"), "irrelevant", "utf-8");
		fs.writeFileSync(path.join(slugDir, "data.json"), "{}", "utf-8");
		const candidates = scanSlugDirForJsonlsAt(sessionsDir, cwd, fs, path.join);
		assert.equal(candidates.length, 1);
		assert.equal(candidates[0].agentSessionId, "v");
	});

	it("end-to-end: parent goal recovery — orphan team-store pointer + surviving .jsonl produces a complete reconstructed record", () => {
		// Mirrors the user's "Audit subgoals branch" case exactly.
		const cwd = "/Users/aj/Documents/dev/bobbit-subgoals-wt/goal-audit-subg-225e4d3d";
		const slugDir = path.join(sessionsDir, slugDirNameForCwd(cwd));
		fs.mkdirSync(slugDir, { recursive: true });
		const jsonlPath = makeJsonl({
			dir: slugDir, name: "main.jsonl", cwd, agentId: "019dfee7-578f-7773-8e32-9e1ba838a4ad",
			startedAt: "2026-05-06T20:07:47.343Z", size: 3_651_800, mtimeMs: Date.parse("2026-05-09T17:04:37Z"),
		});

		const candidates = scanSlugDirForJsonlsAt(sessionsDir, cwd, fs, path.join);
		const chosen = pickCanonicalTeamLeadJsonl(candidates);
		assert.ok(chosen);
		const record = reconstructTeamLeadSessionRecord({
			teamLeadSessionId: "20dba486-26e8-417d-b6dc-013094da0153",
			goal: {
				id: "225e4d3d-c656-43fe-a05c-4d6ab8c252a8",
				title: "Audit subgoals branch",
				projectId: "f8c621ad",
				worktreePath: cwd,
				repoPath: "/Users/aj/Documents/dev/bobbit-subgoals",
				branch: "goal/audit-subg-225e4d3d",
				archived: false,
			},
			chosenJsonl: chosen!,
			funName: "Princess Leia",
		});
		assert.ok(record);
		assert.equal(record!.id, "20dba486-26e8-417d-b6dc-013094da0153");
		assert.equal(record!.agentSessionFile, jsonlPath);
		assert.equal(record!.title, "Team Lead: Princess Leia (recovered)");
		assert.equal(record!.role, "team-lead");
		assert.equal(record!.archived, false);
	});

	it("end-to-end: archived subgoal recovery — no team-store entry, no session record, surviving .jsonl produces an archived record", () => {
		// Mirrors the 18 archived subgoals under "Audit subgoals branch".
		const cwd = "/wt/goal-subgoals-experimental";
		const slugDir = path.join(sessionsDir, slugDirNameForCwd(cwd));
		fs.mkdirSync(slugDir, { recursive: true });
		makeJsonl({ dir: slugDir, name: "main.jsonl", cwd, agentId: "abc", startedAt: "2026-05-03T10:00:00Z", size: 65_536, mtimeMs: Date.parse("2026-05-03T15:30:00Z") });

		const candidates = scanSlugDirForJsonlsAt(sessionsDir, cwd, fs, path.join);
		const chosen = pickCanonicalTeamLeadJsonl(candidates);
		const record = reconstructTeamLeadSessionRecord({
			teamLeadSessionId: "freshly-generated-uuid",
			goal: { id: "subgoal-1", title: "Subgoals experimental toggle", worktreePath: cwd, archived: true },
			chosenJsonl: chosen!,
			funName: "Calcifer",
		});
		assert.ok(record);
		assert.equal(record!.archived, true);
		assert.equal(record!.archivedAt, Date.parse("2026-05-03T15:30:00Z"));
		assert.equal(record!.title, "Team Lead: Calcifer (recovered)");
		assert.equal(record!.teamGoalId, "subgoal-1");
	});

	it("end-to-end: discovers agent slug-dirs for a team-lead goal and recovers each as an attributable agent session", () => {
		// User's "Subgoals experimental toggle" had this exact agent layout:
		// 2 coders + 1 docs-writer, all worktree-sibling slug-dirs alongside the
		// team-lead's slug-dir.
		const wtParent = "/Users/aj/Documents/dev/bobbit-subgoals-wt";
		const teamLeadWt = `${wtParent}/goal-subgoals-e-d4554c66`;
		// Make the team-lead's own slug-dir + .jsonl
		const tlSlugDir = path.join(sessionsDir, slugDirNameForCwd(teamLeadWt));
		fs.mkdirSync(tlSlugDir, { recursive: true });
		makeJsonl({ dir: tlSlugDir, name: "tl.jsonl", cwd: teamLeadWt, agentId: "tl", startedAt: "2026-05-03T10:00:00Z", size: 1024 });
		// Plus 3 agent worktrees as siblings
		const agents = [
			{ name: "goal-goal-subgoals-e-d4554c66-coder-20592a9e", role: "coder", id: "20592a9e" },
			{ name: "goal-goal-subgoals-e-d4554c66-coder-e1bd868b", role: "coder", id: "e1bd868b" },
			{ name: "goal-goal-subgoals-e-d4554c66-docs-writer-18af2949", role: "docs-writer", id: "18af2949" },
		];
		for (const a of agents) {
			const cwd = `${wtParent}/${a.name}`;
			const agentSlug = path.join(sessionsDir, slugDirNameForCwd(cwd));
			fs.mkdirSync(agentSlug, { recursive: true });
			makeJsonl({ dir: agentSlug, name: "main.jsonl", cwd, agentId: a.id, startedAt: "2026-05-03T11:00:00Z", size: 16_384, mtimeMs: Date.parse("2026-05-03T12:00:00Z") });
		}

		const discovered = discoverAgentsForGoal(sessionsDir, teamLeadWt, fs, path.join, path.dirname, path.basename);
		assert.equal(discovered.length, 3, "should discover all 3 agent worktrees");

		// Verify each: role parsed, agent worktree path resolved, candidate .jsonl present
		const byRole = new Map<string, typeof discovered[number]>();
		for (const d of discovered) byRole.set(`${d.role}:${d.agentId}`, d);
		assert.ok(byRole.has("coder:20592a9e"));
		assert.ok(byRole.has("coder:e1bd868b"));
		assert.ok(byRole.has("docs-writer:18af2949"));
		for (const d of discovered) {
			assert.equal(d.candidates.length, 1, `agent ${d.role}-${d.agentId} should have 1 jsonl`);
		}

		// Reconstruct an agent record
		const d = discovered[0];
		const record = reconstructAgentSessionRecord({
			newSessionId: "fresh-uuid",
			role: d.role,
			funName: "Beans",
			teamLeadSessionId: "tl-session-id",
			goal: { id: "subgoal-1", projectId: "proj", repoPath: "/repo", archived: true },
			agentWorktreePath: d.agentWorktreePath,
			chosenJsonl: d.candidates[0],
		});
		assert.equal(record.role, "coder");
		assert.equal(record.teamGoalId, "subgoal-1");
		assert.equal(record.teamLeadSessionId, "tl-session-id");
		assert.equal(record.archived, true);
		assert.match(record.title, /^Coder: Beans \(recovered\)$/);
	});
});

describe("isStaleRecoveredTeamLeadTitle — detect old-shape titles for one-shot rename", () => {
	it("matches 'Team Lead: <goal.title> (recovered)' exactly", () => {
		assert.equal(isStaleRecoveredTeamLeadTitle("Team Lead: Audit subgoals branch (recovered)", "Audit subgoals branch"), true);
	});

	it("does NOT match a fun-name title (idempotent on re-runs)", () => {
		assert.equal(isStaleRecoveredTeamLeadTitle("Team Lead: Calcifer (recovered)", "Audit subgoals branch"), false);
	});

	it("does NOT match a non-recovered title", () => {
		assert.equal(isStaleRecoveredTeamLeadTitle("Team Lead: Jira Springer", "Audit subgoals branch"), false);
	});

	it("safe with missing title or goalTitle", () => {
		assert.equal(isStaleRecoveredTeamLeadTitle(undefined, "x"), false);
		assert.equal(isStaleRecoveredTeamLeadTitle("anything", undefined), false);
		assert.equal(isStaleRecoveredTeamLeadTitle(undefined, undefined), false);
	});

	it("trims goalTitle for comparison (defensive)", () => {
		assert.equal(isStaleRecoveredTeamLeadTitle("Team Lead: Audit X (recovered)", "  Audit X  "), true);
	});
});

describe("prettyRoleName — title-case role for session title", () => {
	it("capitalises single-word role", () => {
		assert.equal(prettyRoleName("coder"), "Coder");
	});

	it("hyphenated role: title-case each part", () => {
		assert.equal(prettyRoleName("code-reviewer"), "Code Reviewer");
		assert.equal(prettyRoleName("docs-writer"), "Docs Writer");
	});

	it("'qa' segment is uppercased (special-case for QA Tester etc.)", () => {
		assert.equal(prettyRoleName("qa-tester"), "QA Tester");
	});
});

describe("parseAgentWorktreeName — extract role + id from agent worktree dir", () => {
	const teamLeadName = "goal-audit-subg-225e4d3d";

	it("parses simple coder worktree", () => {
		const r = parseAgentWorktreeName("goal-goal-audit-subg-225e4d3d-coder-ad801c01", teamLeadName);
		assert.deepEqual(r, { role: "coder", agentId: "ad801c01" });
	});

	it("parses hyphenated qa-tester role", () => {
		const r = parseAgentWorktreeName("goal-goal-audit-subg-225e4d3d-qa-tester-f381c7bb", teamLeadName);
		assert.deepEqual(r, { role: "qa-tester", agentId: "f381c7bb" });
	});

	it("parses hyphenated code-reviewer role", () => {
		const r = parseAgentWorktreeName("goal-goal-audit-subg-225e4d3d-code-reviewer-e6897153", teamLeadName);
		assert.deepEqual(r, { role: "code-reviewer", agentId: "e6897153" });
	});

	it("parses docs-writer role", () => {
		const r = parseAgentWorktreeName("goal-goal-audit-subg-225e4d3d-docs-writer-f9209006", teamLeadName);
		assert.deepEqual(r, { role: "docs-writer", agentId: "f9209006" });
	});

	it("returns null for the team-lead worktree itself (doesn't match agent shape)", () => {
		assert.equal(parseAgentWorktreeName("goal-audit-subg-225e4d3d", teamLeadName), null);
	});

	it("returns null for unrelated sibling dirs", () => {
		assert.equal(parseAgentWorktreeName("goal-unrelated-12345678", teamLeadName), null);
		assert.equal(parseAgentWorktreeName("notes.txt", teamLeadName), null);
	});

	it("requires 8 hex chars at the end (rejects partial / non-hex ids)", () => {
		assert.equal(parseAgentWorktreeName("goal-goal-audit-subg-225e4d3d-coder-12345", teamLeadName), null);
		assert.equal(parseAgentWorktreeName("goal-goal-audit-subg-225e4d3d-coder-notvalid", teamLeadName), null);
	});
});

// ──────────────────────────────────────────────────────────────────────────
// Session sidecar tests — `src/server/agent/session-sidecar.ts`.
//
// Regression context: pre-sidecar, boot recovery for sessions lost from
// `sessions.json` had to invent a fresh bobbit session id and roll a
// fun-name title because the only surviving artifact was the agent's
// `.jsonl`. The bobbit-owned `.bobbit.json` sidecar carries the original
// metadata so recoveries become exact instead of best-effort.
// ──────────────────────────────────────────────────────────────────────────

import {
	sidecarPathFor,
	writeSessionSidecar,
	readSessionSidecar,
	reconcileRecoveredSessionWithSidecar,
	buildSessionSidecar,
	type SessionSidecar,
} from "../src/server/agent/session-sidecar.ts";

describe("session-sidecar", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-sidecar-"));
	});

	it("sidecarPathFor strips .jsonl and appends .bobbit.json next to it", () => {
		const out = sidecarPathFor("/foo/bar/--slug--/abc-123.jsonl");
		assert.equal(out, path.normalize("/foo/bar/--slug--/abc-123.bobbit.json"));
	});

	it("sidecarPathFor defensively appends .bobbit.json when input lacks .jsonl", () => {
		const out = sidecarPathFor("/foo/bar/oddly-named");
		assert.equal(out, path.normalize("/foo/bar/oddly-named.bobbit.json"));
	});

	it("writeSessionSidecar writes atomically — no partial file visible mid-write", () => {
		// We can't truly simulate a crash, but we CAN observe that the target
		// path is only created via rename: write a sidecar, snapshot the dir,
		// then write again and confirm no .tmp- files survive.
		const jsonl = path.join(tmpDir, "abc.jsonl");
		fs.writeFileSync(jsonl, "");
		const meta: SessionSidecar = {
			version: 1,
			bobbitSessionId: "bob-1",
			agentSessionId: "agent-1",
			role: "coder",
			title: "Coder: Jira",
			createdAt: 1700000000000,
		};
		writeSessionSidecar(jsonl, meta);
		const entries1 = fs.readdirSync(tmpDir);
		// Only the .jsonl and the final .bobbit.json — no .tmp- leftover.
		assert.ok(entries1.includes("abc.jsonl"));
		assert.ok(entries1.includes("abc.bobbit.json"));
		assert.ok(!entries1.some((n) => n.includes(".tmp-")));
		// Re-write with different content; still no tmp leftover.
		writeSessionSidecar(jsonl, { ...meta, title: "Coder: Jira (updated)" });
		const entries2 = fs.readdirSync(tmpDir);
		assert.ok(!entries2.some((n) => n.includes(".tmp-")));
		const re = readSessionSidecar(jsonl);
		assert.equal(re?.title, "Coder: Jira (updated)");
	});

	it("writeSessionSidecar is idempotent — re-writing identical content yields identical content", () => {
		const jsonl = path.join(tmpDir, "abc.jsonl");
		fs.writeFileSync(jsonl, "");
		const meta: SessionSidecar = {
			version: 1,
			bobbitSessionId: "bob-2",
			agentSessionId: "agent-2",
			role: "coder",
			title: "T",
			createdAt: 1,
		};
		writeSessionSidecar(jsonl, meta);
		const first = fs.readFileSync(sidecarPathFor(jsonl), "utf-8");
		writeSessionSidecar(jsonl, meta);
		const second = fs.readFileSync(sidecarPathFor(jsonl), "utf-8");
		assert.equal(first, second);
	});

	it("readSessionSidecar returns null when the file is absent", () => {
		const jsonl = path.join(tmpDir, "missing.jsonl");
		assert.equal(readSessionSidecar(jsonl), null);
	});

	it("readSessionSidecar returns null when version is not 1 (forward-compat)", () => {
		const jsonl = path.join(tmpDir, "abc.jsonl");
		fs.writeFileSync(sidecarPathFor(jsonl), JSON.stringify({
			version: 2,
			bobbitSessionId: "x",
			agentSessionId: "y",
			role: "coder",
			title: "T",
			createdAt: 1,
		}));
		assert.equal(readSessionSidecar(jsonl), null);
	});

	it("readSessionSidecar returns null on JSON parse error", () => {
		const jsonl = path.join(tmpDir, "abc.jsonl");
		fs.writeFileSync(sidecarPathFor(jsonl), "{not json");
		assert.equal(readSessionSidecar(jsonl), null);
	});

	it("readSessionSidecar returns null when required fields are missing", () => {
		const jsonl = path.join(tmpDir, "abc.jsonl");
		fs.writeFileSync(sidecarPathFor(jsonl), JSON.stringify({ version: 1, bobbitSessionId: "x" }));
		assert.equal(readSessionSidecar(jsonl), null);
	});

	it("reconcileRecoveredSessionWithSidecar overrides reconstructed fields", () => {
		const reconstructed = {
			id: "fresh-uuid-from-heuristic",
			title: "Team Lead: Calcifer (recovered)",
			role: "team-lead",
			teamGoalId: "g-1",
			createdAt: 999,
			cwd: "/wt/foo",
		};
		const sidecar: SessionSidecar = {
			version: 1,
			bobbitSessionId: "original-bob-id",
			agentSessionId: "agent-xyz",
			role: "team-lead",
			teamGoalId: "g-1",
			teamLeadSessionId: undefined,
			title: "Team Lead: Jira Springer",
			createdAt: 100,
			accessory: "crown",
			modelProvider: "anthropic",
			modelId: "claude-sonnet-4",
		};
		const out = reconcileRecoveredSessionWithSidecar(reconstructed, sidecar);
		assert.equal(out.id, "original-bob-id");
		assert.equal(out.title, "Team Lead: Jira Springer");
		assert.equal(out.createdAt, 100);
		assert.equal(out.accessory, "crown");
		assert.equal(out.modelProvider, "anthropic");
		assert.equal(out.modelId, "claude-sonnet-4");
		// Original record fields preserved when sidecar doesn't override them.
		assert.equal((out as Record<string, unknown>).cwd, "/wt/foo");
	});

	it("e2e: write sidecar, simulate .jsonl-only recovery, reconciled record matches sidecar", () => {
		const jsonl = path.join(tmpDir, "real.jsonl");
		fs.writeFileSync(jsonl, "");
		const sidecar = buildSessionSidecar({
			id: "real-bob-id",
			role: "coder",
			title: "Coder: Jira",
			createdAt: 1700000000000,
			teamGoalId: "g-7",
			teamLeadSessionId: "lead-1",
			accessory: "tools",
			modelProvider: "anthropic",
			modelId: "claude-sonnet-4",
		}, "agent-7", "lead-1");
		writeSessionSidecar(jsonl, sidecar);
		// Simulate heuristic recovery producing a fresh-but-wrong record.
		const reconstructed = {
			id: "FRESH-WRONG-UUID",
			title: "Coder: Random Name (recovered)",
			role: "coder",
			teamGoalId: "g-7",
			teamLeadSessionId: "lead-1",
			createdAt: 9999999999999,
			cwd: "/wt/agent",
		};
		const read = readSessionSidecar(jsonl);
		assert.ok(read);
		const finalRecord = reconcileRecoveredSessionWithSidecar(reconstructed, read!);
		assert.equal(finalRecord.id, "real-bob-id");
		assert.equal(finalRecord.title, "Coder: Jira");
		assert.equal(finalRecord.createdAt, 1700000000000);
		assert.equal((finalRecord as Record<string, unknown>).accessory, "tools");
		assert.equal((finalRecord as Record<string, unknown>).modelProvider, "anthropic");
		assert.equal((finalRecord as Record<string, unknown>).modelId, "claude-sonnet-4");
	});

	it("buildSessionSidecar fills version, defaults role to 'general', and normalises nullables", () => {
		const sc = buildSessionSidecar({
			id: "x",
			title: "T",
			createdAt: 1,
			// no role
		}, "agent-x");
		assert.equal(sc.version, 1);
		assert.equal(sc.role, "general");
		assert.equal(sc.delegateOf, null);
		assert.equal(sc.spawnedBySessionId, null);
		assert.equal(sc.accessory, null);
	});
});
