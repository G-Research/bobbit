/**
 * Phase 1 — Nested goals data model: PersistedGoal extensions.
 *
 * Verifies:
 *   - Round-trip persistence of every new optional field.
 *   - Lazy migration: pre-Phase-1 goals.json files load without crashing,
 *     missing fields read as `undefined` (no backfill at the data layer).
 *   - update() can stamp the new fields.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-store-nesting-"));
});

function makeGoal(id: string, extra: Partial<PersistedGoal> = {}): PersistedGoal {
	return {
		id,
		title: `Goal ${id}`,
		cwd: "/tmp/goal",
		state: "todo",
		spec: "",
		createdAt: 1000,
		updatedAt: 1000,
		...extra,
	};
}

describe("GoalStore — nested goal fields round-trip", () => {
	it("persists parentGoalId and rootGoalId across reload", () => {
		const s1 = new GoalStore(tmpDir);
		s1.put(makeGoal("child", { parentGoalId: "parent-1", rootGoalId: "root-1" }));
		const s2 = new GoalStore(tmpDir);
		const reloaded = s2.get("child");
		assert.ok(reloaded);
		assert.equal(reloaded.parentGoalId, "parent-1");
		assert.equal(reloaded.rootGoalId, "root-1");
	});

	it("persists mergeTarget across reload", () => {
		const s1 = new GoalStore(tmpDir);
		s1.put(makeGoal("g1", { mergeTarget: "master" }));
		s1.put(makeGoal("g2", { mergeTarget: "parent" }));
		const s2 = new GoalStore(tmpDir);
		assert.equal(s2.get("g1")?.mergeTarget, "master");
		assert.equal(s2.get("g2")?.mergeTarget, "parent");
	});

	it("persists divergencePolicy + maxConcurrentChildren across reload", () => {
		const s1 = new GoalStore(tmpDir);
		s1.put(makeGoal("root", {
			divergencePolicy: "balanced",
			maxConcurrentChildren: 5,
		}));
		const s2 = new GoalStore(tmpDir);
		const reloaded = s2.get("root");
		assert.equal(reloaded?.divergencePolicy, "balanced");
		assert.equal(reloaded?.maxConcurrentChildren, 5);
	});

	it("persists acceptanceCriteria array across reload", () => {
		const s1 = new GoalStore(tmpDir);
		s1.put(makeGoal("g1", { acceptanceCriteria: ["foo", "bar", "baz"] }));
		const s2 = new GoalStore(tmpDir);
		assert.deepEqual(s2.get("g1")?.acceptanceCriteria, ["foo", "bar", "baz"]);
	});

	it("persists spawnedFromPlanId across reload", () => {
		const s1 = new GoalStore(tmpDir);
		s1.put(makeGoal("g1", { spawnedFromPlanId: "plan-step-7" }));
		const s2 = new GoalStore(tmpDir);
		assert.equal(s2.get("g1")?.spawnedFromPlanId, "plan-step-7");
	});

	it("persists paused + replanCount across reload", () => {
		const s1 = new GoalStore(tmpDir);
		s1.put(makeGoal("g1", { paused: true, replanCount: 3 }));
		const s2 = new GoalStore(tmpDir);
		const reloaded = s2.get("g1");
		assert.equal(reloaded?.paused, true);
		assert.equal(reloaded?.replanCount, 3);
	});

	it("update() can stamp new fields after creation", () => {
		const s1 = new GoalStore(tmpDir);
		s1.put(makeGoal("g1"));
		s1.update("g1", { spawnedFromPlanId: "plan-x", paused: true });
		const s2 = new GoalStore(tmpDir);
		const reloaded = s2.get("g1");
		assert.equal(reloaded?.spawnedFromPlanId, "plan-x");
		assert.equal(reloaded?.paused, true);
	});

	it("supports the all-fields combo round-trip (paused=true, replanCount=3, criteria, parent/root)", () => {
		const s1 = new GoalStore(tmpDir);
		s1.put(makeGoal("g1", {
			parentGoalId: "abc",
			rootGoalId: "root",
			mergeTarget: "parent",
			divergencePolicy: "strict",
			maxConcurrentChildren: 8,
			acceptanceCriteria: ["foo", "bar"],
			spawnedFromPlanId: "plan-1",
			paused: true,
			replanCount: 3,
		}));
		const s2 = new GoalStore(tmpDir);
		const r = s2.get("g1");
		assert.ok(r);
		assert.equal(r.parentGoalId, "abc");
		assert.equal(r.rootGoalId, "root");
		assert.equal(r.mergeTarget, "parent");
		assert.equal(r.divergencePolicy, "strict");
		assert.equal(r.maxConcurrentChildren, 8);
		assert.deepEqual(r.acceptanceCriteria, ["foo", "bar"]);
		assert.equal(r.spawnedFromPlanId, "plan-1");
		assert.equal(r.paused, true);
		assert.equal(r.replanCount, 3);
	});
});

describe("GoalStore — lazy migration of pre-Phase-1 goals.json", () => {
	it("loads a legacy file with no nesting fields without crashing; missing fields are undefined", () => {
		// Simulate a goals.json written before Phase 1 — legacy fields only.
		const legacyGoal = {
			id: "legacy-1",
			title: "Legacy goal",
			cwd: "/tmp/legacy",
			state: "in-progress",
			spec: "old spec",
			createdAt: 1,
			updatedAt: 2,
			team: true,
			workflowId: "general",
		};
		fs.mkdirSync(tmpDir, { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "goals.json"), JSON.stringify([legacyGoal], null, 2), "utf-8");

		// Construct a fresh store — load() must not throw.
		const store = new GoalStore(tmpDir);
		const loaded = store.get("legacy-1");
		assert.ok(loaded, "legacy goal should load");
		assert.equal(loaded.title, "Legacy goal");
		assert.equal(loaded.state, "in-progress");
		// Every nesting field must read as undefined — NO backfill at the
		// data layer (defaults are computed at use sites).
		assert.equal(loaded.parentGoalId, undefined);
		assert.equal(loaded.rootGoalId, undefined);
		assert.equal(loaded.mergeTarget, undefined);
		assert.equal(loaded.divergencePolicy, undefined);
		assert.equal(loaded.maxConcurrentChildren, undefined);
		assert.equal(loaded.acceptanceCriteria, undefined);
		assert.equal(loaded.spawnedFromPlanId, undefined);
		assert.equal(loaded.paused, undefined);
		assert.equal(loaded.replanCount, undefined);
	});

	it("preserves unknown fields on a legacy record alongside missing nesting fields", () => {
		// Belt-and-braces: a legacy file with a kitchen-sink goal still loads.
		const legacyGoals = [
			{
				id: "a",
				title: "A",
				cwd: "/tmp/a",
				state: "todo",
				spec: "",
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: "b",
				title: "B",
				cwd: "/tmp/b",
				state: "complete",
				spec: "done",
				createdAt: 2,
				updatedAt: 2,
				archived: true,
				archivedAt: 999,
			},
		];
		fs.mkdirSync(tmpDir, { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "goals.json"), JSON.stringify(legacyGoals, null, 2), "utf-8");

		const store = new GoalStore(tmpDir);
		const a = store.get("a");
		const b = store.get("b");
		assert.ok(a);
		assert.ok(b);
		assert.equal(a.parentGoalId, undefined);
		assert.equal(b.parentGoalId, undefined);
		assert.equal(b.archived, true);
		assert.equal(b.archivedAt, 999);
	});
});
