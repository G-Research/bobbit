/**
 * Unit tests for MissionStore + plan validation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionStore, validatePlan, ulid, type MissionPlan, type PersistedMission } from "../src/server/agent/mission-store.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mission-store-"));
}

function makeMission(id: string, overrides: Partial<PersistedMission> = {}): PersistedMission {
	const now = Date.now();
	return {
		id,
		projectId: "proj-1",
		projects: ["proj-1"],
		title: "Test mission",
		spec: "# Spec",
		state: "planning",
		createdAt: now,
		updatedAt: now,
		workflowId: "mission",
		divergencePolicy: "strict",
		maxConcurrentGoals: 3,
		...overrides,
	};
}

describe("MissionStore — CRUD", () => {
	it("persists and loads missions across instances", () => {
		const dir = tmpDir();
		const a = new MissionStore(dir);
		a.put(makeMission("m1"));
		a.put(makeMission("m2", { title: "Two" }));

		const b = new MissionStore(dir);
		assert.equal(b.getAll().length, 2);
		assert.equal(b.get("m2")?.title, "Two");
	});

	it("update merges fields and refreshes updatedAt", () => {
		const s = new MissionStore(tmpDir());
		s.put(makeMission("m1", { updatedAt: 1 }));
		const before = s.get("m1")!.updatedAt;
		s.update("m1", { title: "New", maxConcurrentGoals: 5 });
		const after = s.get("m1")!;
		assert.equal(after.title, "New");
		assert.equal(after.maxConcurrentGoals, 5);
		assert.ok(after.updatedAt > before);
	});

	it("archive flags the mission and excludes it from getLive", () => {
		const s = new MissionStore(tmpDir());
		s.put(makeMission("m1"));
		s.put(makeMission("m2"));
		s.archive("m1");
		assert.deepEqual(s.getLive().map(m => m.id), ["m2"]);
		assert.deepEqual(s.getArchived().map(m => m.id), ["m1"]);
	});

	it("getForProject filters by projectId", () => {
		const s = new MissionStore(tmpDir());
		s.put(makeMission("m1", { projectId: "p1", projects: ["p1"] }));
		s.put(makeMission("m2", { projectId: "p2", projects: ["p2"] }));
		assert.deepEqual(s.getForProject("p1").map(m => m.id), ["m1"]);
	});

	it("generation counter bumps on every mutation", () => {
		const s = new MissionStore(tmpDir());
		const g0 = s.getGeneration();
		s.put(makeMission("m1"));
		const g1 = s.getGeneration();
		assert.ok(g1 > g0);
		s.update("m1", { title: "x" });
		assert.ok(s.getGeneration() > g1);
	});
});

describe("MissionStore — plan helpers", () => {
	const plan: MissionPlan = {
		goals: [
			{ planId: "p1", title: "First", spec: "...", workflowId: "feature" },
			{ planId: "p2", title: "Second", spec: "...", workflowId: "feature" },
		],
		dependencies: [{ from: "p1", to: "p2" }],
		rationale: "test",
		estimatedConcurrency: 1,
		version: 1,
	};

	it("setPlan / freezePlan store and stamp", () => {
		const s = new MissionStore(tmpDir());
		s.put(makeMission("m1"));
		s.setPlan("m1", plan);
		assert.equal(s.get("m1")!.plan?.version, 1);
		assert.equal(s.get("m1")!.planFrozenAt, undefined);
		s.freezePlan("m1");
		assert.ok(s.get("m1")!.planFrozenAt && s.get("m1")!.planFrozenAt! > 0);
	});

	it("attachGoalToPlanNode writes goalId + spawnedAt", () => {
		const s = new MissionStore(tmpDir());
		s.put(makeMission("m1"));
		s.setPlan("m1", plan);
		assert.equal(s.attachGoalToPlanNode("m1", "p1", "goal-abc"), true);
		const node = s.get("m1")!.plan!.goals.find(g => g.planId === "p1")!;
		assert.equal(node.goalId, "goal-abc");
		assert.ok(node.spawnedAt);
	});

	it("attachGoalToPlanNode returns false for unknown nodes", () => {
		const s = new MissionStore(tmpDir());
		s.put(makeMission("m1"));
		s.setPlan("m1", plan);
		assert.equal(s.attachGoalToPlanNode("m1", "missing", "g"), false);
		assert.equal(s.attachGoalToPlanNode("nope", "p1", "g"), false);
	});

	it("updatePlanNodeState patches provided fields only", () => {
		const s = new MissionStore(tmpDir());
		s.put(makeMission("m1"));
		s.setPlan("m1", plan);
		s.updatePlanNodeState("m1", "p2", { state: "in-progress", failedAttempts: 1 });
		const node = s.get("m1")!.plan!.goals.find(g => g.planId === "p2")!;
		assert.equal(node.state, "in-progress");
		assert.equal(node.failedAttempts, 1);
	});

	it("update with null clears optional field", () => {
		const s = new MissionStore(tmpDir());
		s.put(makeMission("m1", { pausedAt: 12345, pausedReason: "x", planFrozenAt: 999 }));
		assert.equal(s.get("m1")!.pausedAt, 12345);
		s.update("m1", { pausedAt: null, pausedReason: null });
		const after = s.get("m1")!;
		assert.equal(after.pausedAt, undefined);
		assert.equal(after.pausedReason, undefined);
		assert.equal(after.planFrozenAt, 999, "untouched fields remain");
	});

	it("updatePlanNodeState with null clears node field", () => {
		const s = new MissionStore(tmpDir());
		s.put(makeMission("m1"));
		s.setPlan("m1", plan);
		s.updatePlanNodeState("m1", "p1", { mergedAt: 5000, failedAttempts: 2 });
		assert.equal(s.get("m1")!.plan!.goals[0].mergedAt, 5000);
		s.updatePlanNodeState("m1", "p1", { mergedAt: null });
		const node = s.get("m1")!.plan!.goals[0];
		assert.equal(node.mergedAt, undefined);
		assert.equal(node.failedAttempts, 2, "untouched fields remain");
	});
});

describe("validatePlan", () => {
	it("accepts a valid DAG", () => {
		const result = validatePlan({
			goals: [
				{ planId: "a", title: "A", spec: "", workflowId: "feature" },
				{ planId: "b", title: "B", spec: "", workflowId: "feature" },
				{ planId: "c", title: "C", spec: "", workflowId: "feature" },
			],
			dependencies: [{ from: "a", to: "b" }, { from: "a", to: "c" }],
			rationale: "",
			estimatedConcurrency: 2,
			version: 1,
		});
		assert.equal(result.ok, true);
	});

	it("rejects cycles", () => {
		const result = validatePlan({
			goals: [
				{ planId: "a", title: "A", spec: "", workflowId: "feature" },
				{ planId: "b", title: "B", spec: "", workflowId: "feature" },
			],
			dependencies: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
			rationale: "",
			estimatedConcurrency: 1,
			version: 1,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /[Cc]ycle/);
	});

	it("rejects edges referencing unknown nodes", () => {
		const result = validatePlan({
			goals: [{ planId: "a", title: "A", spec: "", workflowId: "feature" }],
			dependencies: [{ from: "a", to: "ghost" }],
			rationale: "",
			estimatedConcurrency: 1,
			version: 1,
		});
		assert.equal(result.ok, false);
	});

	it("rejects duplicate planIds", () => {
		const result = validatePlan({
			goals: [
				{ planId: "a", title: "A", spec: "", workflowId: "feature" },
				{ planId: "a", title: "A again", spec: "", workflowId: "feature" },
			],
			dependencies: [],
			rationale: "",
			estimatedConcurrency: 1,
			version: 1,
		});
		assert.equal(result.ok, false);
	});
});

describe("ulid", () => {
	it("returns a 26-char Crockford-base32 id", () => {
		const id = ulid();
		assert.equal(id.length, 26);
		assert.match(id, /^[0-9A-HJKMNP-TV-Z]+$/);
	});

	it("ids are roughly time-ordered (prefix monotonic)", () => {
		const a = ulid(1700000000000);
		const b = ulid(1700000000001);
		assert.ok(a.slice(0, 10) <= b.slice(0, 10));
	});
});
