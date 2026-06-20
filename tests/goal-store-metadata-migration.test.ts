/**
 * Unit tests for goal-store load-time metadata migration.
 *
 * Pins the contract in `src/server/agent/goal-store.ts::load`:
 *  - absent metadata stays absent (no backfill);
 *  - a valid plain-object metadata survives a load round-trip;
 *  - malformed metadata (non-object / array / null) is dropped;
 *  - legacy per-goal `worktreeSetupCommand` / `worktreeSetupTimeoutMs` are
 *    dropped on load (superseded by metadata + goalProvisioned hook).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";

function writeGoals(dir: string, goals: Array<Record<string, unknown>>): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "goals.json"), JSON.stringify(goals, null, 2), "utf-8");
}

describe("goal-store metadata migration", () => {
	let tmp: string;
	before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-meta-")); });
	after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

	function freshDir(name: string): string {
		const d = path.join(tmp, name);
		fs.mkdirSync(d, { recursive: true });
		return d;
	}

	it("keeps a valid plain-object metadata", () => {
		const dir = freshDir("valid");
		writeGoals(dir, [{ id: "g1", title: "t", metadata: { "bobbit.disabledTools": ["x"] } }]);
		const g = new GoalStore(dir).get("g1") as PersistedGoal;
		assert.deepEqual(g.metadata, { "bobbit.disabledTools": ["x"] });
	});

	it("leaves absent metadata absent (no backfill)", () => {
		const dir = freshDir("absent");
		writeGoals(dir, [{ id: "g1", title: "t" }]);
		const g = new GoalStore(dir).get("g1") as PersistedGoal;
		assert.equal(g.metadata, undefined);
	});

	it("drops malformed metadata (array, scalar, null)", () => {
		const dir = freshDir("malformed");
		writeGoals(dir, [
			{ id: "arr", title: "t", metadata: ["nope"] },
			{ id: "scalar", title: "t", metadata: "nope" },
			{ id: "null", title: "t", metadata: null },
		]);
		const store = new GoalStore(dir);
		assert.equal((store.get("arr") as PersistedGoal).metadata, undefined);
		assert.equal((store.get("scalar") as PersistedGoal).metadata, undefined);
		assert.equal((store.get("null") as PersistedGoal).metadata, undefined);
	});

	it("drops legacy per-goal worktree setup fields on load", () => {
		const dir = freshDir("legacy");
		writeGoals(dir, [{
			id: "g1",
			title: "t",
			worktreeSetupCommand: "echo hi",
			worktreeSetupTimeoutMs: 5000,
		}]);
		const g = new GoalStore(dir).get("g1") as PersistedGoal & {
			worktreeSetupCommand?: unknown;
			worktreeSetupTimeoutMs?: unknown;
		};
		assert.equal(g.worktreeSetupCommand, undefined);
		assert.equal(g.worktreeSetupTimeoutMs, undefined);
	});
});
