/**
 * boot-respawn for sessionless in-progress goals — Boot-respawn for sessionless in-progress goals.
 *
 * `resubscribeTeamEvents` now ends with `_bootRespawnSessionlessGoals`,
 * which walks every non-archived goal in `state: "in-progress",
 * setupStatus: "ready", team: true` and respawns a fresh team-lead for any
 * that have no team entry in `this.teams`.
 *
 * Wraps each respawn in try/catch — one bad goal must not block the rest.
 *
 * This test pins the predicate (the four-conjunct filter) via source-grep,
 * and exercises the iteration logic against a constructed goal set in
 * isolation (full team startup is too heavy for a unit test — the source
 * grep is the load-bearing assertion).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("boot-respawn for sessionless in-progress goals — source-grep guard", () => {
	const SOURCE = path.resolve(import.meta.dirname, "..", "src", "server", "agent", "team-manager.ts");
	const text = fs.readFileSync(SOURCE, "utf-8");

	it("declares _bootRespawnSessionlessGoals", () => {
		assert.match(text, /_bootRespawnSessionlessGoals/, "the helper must be named (greppable)");
	});

	it("is invoked from resubscribeTeamEvents", () => {
		// Find the method definition (not a comment mention).
		const defIdx = text.search(/(?:^|\n)\s*resubscribeTeamEvents\s*\(/);
		assert.ok(defIdx > 0, "resubscribeTeamEvents method definition must exist");
		const window = text.slice(defIdx, defIdx + 8_000);
		assert.match(window, /_bootRespawnSessionlessGoals\(\)/);
	});

	it("checks the four-conjunct predicate (archived, state, setupStatus, team)", () => {
		const helperIdx = text.lastIndexOf("_bootRespawnSessionlessGoals");
		const window = text.slice(helperIdx, helperIdx + 4_000);
		assert.match(window, /goal\.archived/, "predicate must check archived");
		assert.match(window, /goal\.state/, "predicate must check state");
		assert.match(window, /goal\.setupStatus/, "predicate must check setupStatus");
		assert.match(window, /goal\.team/, "predicate must check team flag");
		// AND the in-memory teams map check (skip if a live team entry exists).
		assert.match(window, /this\.teams\.has\(goal\.id\)/, "predicate must skip goals that already have a team entry");
	});

	it("wraps the respawn call in try/catch so one bad goal doesn't block boot", () => {
		const helperIdx = text.lastIndexOf("_bootRespawnSessionlessGoals");
		const window = text.slice(helperIdx, helperIdx + 4_000);
		assert.match(window, /try\s*\{/);
		assert.match(window, /catch\s*\(\s*err/);
	});

	it("logs an actionable line when respawning", () => {
		const helperIdx = text.lastIndexOf("_bootRespawnSessionlessGoals");
		const window = text.slice(helperIdx, helperIdx + 4_000);
		assert.match(window, /respawning team-lead/i);
	});
});

describe("boot-respawn for sessionless in-progress goals — predicate iteration logic (mirror)", () => {
	type Goal = {
		id: string;
		title: string;
		archived?: boolean;
		state?: string;
		setupStatus?: string;
		team?: boolean;
	};

	function shouldRespawn(goal: Goal, teamsHas: (id: string) => boolean): boolean {
		if (goal.archived) return false;
		if (goal.state !== "in-progress") return false;
		if (goal.setupStatus !== "ready") return false;
		if (!goal.team) return false;
		if (teamsHas(goal.id)) return false;
		return true;
	}

	const teams = new Set<string>();
	const teamsHas = (id: string) => teams.has(id);

	it("respawns a goal that matches every conjunct", () => {
		const goal: Goal = { id: "g1", title: "g1", state: "in-progress", setupStatus: "ready", team: true };
		assert.equal(shouldRespawn(goal, teamsHas), true);
	});

	it("skips an archived goal", () => {
		const goal: Goal = { id: "g2", title: "g2", archived: true, state: "in-progress", setupStatus: "ready", team: true };
		assert.equal(shouldRespawn(goal, teamsHas), false);
	});

	it("skips a goal in a non-in-progress state", () => {
		assert.equal(shouldRespawn({ id: "g3", title: "g3", state: "complete", setupStatus: "ready", team: true }, teamsHas), false);
		assert.equal(shouldRespawn({ id: "g4", title: "g4", state: "todo", setupStatus: "ready", team: true }, teamsHas), false);
	});

	it("skips a goal whose worktree setup is not ready", () => {
		assert.equal(shouldRespawn({ id: "g5", title: "g5", state: "in-progress", setupStatus: "preparing", team: true }, teamsHas), false);
		assert.equal(shouldRespawn({ id: "g6", title: "g6", state: "in-progress", setupStatus: "error", team: true }, teamsHas), false);
	});

	it("skips a non-team goal", () => {
		assert.equal(shouldRespawn({ id: "g7", title: "g7", state: "in-progress", setupStatus: "ready", team: false }, teamsHas), false);
	});

	it("skips a goal that already has a live team entry", () => {
		teams.add("g8");
		assert.equal(shouldRespawn({ id: "g8", title: "g8", state: "in-progress", setupStatus: "ready", team: true }, teamsHas), false);
		teams.delete("g8");
	});
});
