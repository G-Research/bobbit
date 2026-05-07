/**
 * Unit tests for plan-node-state (Phase 5a, tier-based child resolution).
 *
 * tier-based child resolution — tier preference for resolving a Plan-tab node when multiple
 * children share a planId. Tier order:
 *   1. Live in-progress (non-paused)
 *   2. Archived + state=complete (success terminal)
 *   3. Live other
 *   4. Archived + state!=complete
 * Within tier: most-recent createdAt wins.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolvePlanNodeChild,
	type PlanNodeChild,
} from "../src/app/plan-node-state.ts";

function c(over: Partial<PlanNodeChild> & { id: string; createdAt: number }): PlanNodeChild {
	return {
		id: over.id,
		parentGoalId: over.parentGoalId ?? "root",
		spawnedFromPlanId: over.spawnedFromPlanId ?? "p1",
		state: over.state ?? "todo",
		archived: over.archived,
		paused: over.paused,
		createdAt: over.createdAt,
	};
}

describe("plan-node-state — tier preference", () => {
	it("Tier 1 (live in-progress) wins over Tier 2 (archived+complete)", () => {
		const r = resolvePlanNodeChild("p1", [
			c({ id: "tier2", state: "complete", archived: true, createdAt: 200 }),
			c({ id: "tier1", state: "in-progress", archived: false, createdAt: 100 }),
		]);
		assert.equal(r.child?.id, "tier1");
		assert.equal(r.state, "in-progress");
	});

	it("Tier 2 (archived+complete) wins over Tier 3 (live todo)", () => {
		const r = resolvePlanNodeChild("p1", [
			c({ id: "tier3", state: "todo", archived: false, createdAt: 200 }),
			c({ id: "tier2", state: "complete", archived: true, createdAt: 100 }),
		]);
		assert.equal(r.child?.id, "tier2");
		assert.equal(r.state, "complete");
	});

	it("Tier 3 (live other) wins over Tier 4 (archived+shelved)", () => {
		const r = resolvePlanNodeChild("p1", [
			c({ id: "tier4", state: "shelved", archived: true, createdAt: 200 }),
			c({ id: "tier3", state: "todo", archived: false, createdAt: 100 }),
		]);
		assert.equal(r.child?.id, "tier3");
		assert.equal(r.state, "todo");
	});

	it("most-recent createdAt wins within the same tier", () => {
		const r = resolvePlanNodeChild("p1", [
			c({ id: "old", state: "in-progress", archived: false, createdAt: 100 }),
			c({ id: "new", state: "in-progress", archived: false, createdAt: 200 }),
		]);
		assert.equal(r.child?.id, "new");
	});

	it("ignores candidates whose spawnedFromPlanId doesn't match", () => {
		const r = resolvePlanNodeChild("p1", [
			c({ id: "match", spawnedFromPlanId: "p1", state: "in-progress", createdAt: 100 }),
			c({ id: "other", spawnedFromPlanId: "p2", state: "in-progress", createdAt: 200 }),
		]);
		assert.equal(r.child?.id, "match");
	});
});

describe("plan-node-state — derived state", () => {
	it("no candidates → state=todo, child=undefined", () => {
		const r = resolvePlanNodeChild("p1", []);
		assert.equal(r.state, "todo");
		assert.equal(r.child, undefined);
	});

	it("single live in-progress (non-paused) → in-progress", () => {
		const r = resolvePlanNodeChild("p1", [
			c({ id: "x", state: "in-progress", archived: false, createdAt: 1 }),
		]);
		assert.equal(r.state, "in-progress");
	});

	it("single archived+complete → complete", () => {
		const r = resolvePlanNodeChild("p1", [
			c({ id: "x", state: "complete", archived: true, createdAt: 1 }),
		]);
		assert.equal(r.state, "complete");
	});

	it("single live shelved → failed (Tier 3, derived)", () => {
		const r = resolvePlanNodeChild("p1", [
			c({ id: "x", state: "shelved", archived: false, createdAt: 1 }),
		]);
		assert.equal(r.state, "failed");
	});

	it("single live paused → paused (Tier 3, derived)", () => {
		const r = resolvePlanNodeChild("p1", [
			c({ id: "x", state: "todo", archived: false, paused: true, createdAt: 1 }),
		]);
		assert.equal(r.state, "paused");
	});

	it("sole live in-progress+paused → paused (Tier 3, not Tier 1)", () => {
		// tier-based child resolution: paused excludes from Tier 1; Tier 3 derives "paused".
		const r = resolvePlanNodeChild("p1", [
			c({ id: "x", state: "in-progress", archived: false, paused: true, createdAt: 1 }),
		]);
		assert.equal(r.state, "paused");
	});

	it("non-paused live in-progress beats live in-progress+paused (Tier 1 vs Tier 3)", () => {
		// The non-paused one is Tier 1; the paused one is Tier 3 → Tier 1 wins.
		const r = resolvePlanNodeChild("p1", [
			c({ id: "paused", state: "in-progress", archived: false, paused: true, createdAt: 200 }),
			c({ id: "active", state: "in-progress", archived: false, paused: false, createdAt: 100 }),
		]);
		assert.equal(r.child?.id, "active");
		assert.equal(r.state, "in-progress");
	});

	it("archived shelved alone → failed (Tier 4)", () => {
		const r = resolvePlanNodeChild("p1", [
			c({ id: "x", state: "shelved", archived: true, createdAt: 1 }),
		]);
		assert.equal(r.state, "failed");
	});

	it("archived todo (non-complete) alone → failed (Tier 4)", () => {
		const r = resolvePlanNodeChild("p1", [
			c({ id: "x", state: "todo", archived: true, createdAt: 1 }),
		]);
		assert.equal(r.state, "failed");
	});

	it("live complete (rare) → complete (Tier 3, derived)", () => {
		const r = resolvePlanNodeChild("p1", [
			c({ id: "x", state: "complete", archived: false, createdAt: 1 }),
		]);
		assert.equal(r.state, "complete");
	});
});
