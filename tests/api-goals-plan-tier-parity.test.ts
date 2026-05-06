/**
 * R-004 — `GET /api/goals/:id/plan` tier-resolution parity with the
 * harness's `resolvePlanStepChild`.
 *
 * The route used to inline a 4-tier copy of the resolver; this regression
 * test pins that the route now delegates to
 * `verificationHarness.resolvePlanStepChild` so the renderer / server /
 * harness three-way agreement (Lesson 4.22) has exactly one source.
 *
 * We exercise the resolver across the same fixture shapes that
 * `runSubgoalStep-tier-resolution.test.ts` uses (live-active,
 * archived-complete, live-other, archived-other, rescue) and assert the
 * resolver returns the expected child + tier for each.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFixture } from "./helpers/run-subgoal-step-fixture.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("GET /plan ↔ resolvePlanStepChild parity", () => {
	it("Tier 1 — live in-progress wins", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());
		const planId = "p1";
		fx.goalStore.put({
			id: "live", title: "X", cwd: fx.tmpRoot,
			state: "in-progress", spec: "", createdAt: 100, updatedAt: 100,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
		} as any);
		fx.goalStore.put({
			id: "shelved", title: "X", cwd: fx.tmpRoot,
			state: "complete", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			archived: true, archivedAt: 2,
		} as any);
		const r = fx.harness.resolvePlanStepChild(fx.parent.id, planId);
		assert.equal(r.source, "live-active");
		assert.equal(r.child?.id, "live");
	});

	it("Tier 2 — archived complete when no live in-progress", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());
		const planId = "p2";
		fx.goalStore.put({
			id: "done", title: "X", cwd: fx.tmpRoot,
			state: "complete", spec: "", createdAt: 100, updatedAt: 100,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			archived: true, archivedAt: 200,
		} as any);
		const r = fx.harness.resolvePlanStepChild(fx.parent.id, planId);
		assert.equal(r.source, "archived-complete");
		assert.equal(r.child?.id, "done");
	});

	it("Tier 3 — live other (todo) when no live-active or archived-complete", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());
		const planId = "p3";
		fx.goalStore.put({
			id: "todo1", title: "X", cwd: fx.tmpRoot,
			state: "todo", spec: "", createdAt: 100, updatedAt: 100,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
		} as any);
		const r = fx.harness.resolvePlanStepChild(fx.parent.id, planId);
		assert.equal(r.source, "live-other");
		assert.equal(r.child?.id, "todo1");
	});

	it("Tier 4 — archived non-complete (shelved dupe)", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());
		const planId = "p4";
		fx.goalStore.put({
			id: "shelved", title: "X", cwd: fx.tmpRoot,
			state: "shelved" as any, spec: "", createdAt: 100, updatedAt: 100,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			archived: true, archivedAt: 200,
		} as any);
		const r = fx.harness.resolvePlanStepChild(fx.parent.id, planId);
		assert.equal(r.source, "archived-other");
		assert.equal(r.child?.id, "shelved");
	});

	it("Tier 5 — rescue by (parentGoalId, title) when planId unset; back-fills planId", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());
		const planId = "p5";
		fx.goalStore.put({
			id: "orphan", title: "RESCUE-ME", cwd: fx.tmpRoot,
			state: "in-progress", spec: "", createdAt: 100, updatedAt: 100,
			parentGoalId: fx.parent.id,
			// No spawnedFromPlanId — that's why we hit the rescue tier.
		} as any);
		const r = fx.harness.resolvePlanStepChild(fx.parent.id, planId, { expectedTitle: "RESCUE-ME" });
		assert.equal(r.source, "rescue");
		assert.equal(r.child?.id, "orphan");
		// Back-fill is fire-and-forget; await microtasks so it lands.
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(fx.goalStore.get("orphan")?.spawnedFromPlanId, planId);
	});

	it("none — returns no child when nothing matches", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());
		const r = fx.harness.resolvePlanStepChild(fx.parent.id, "nope");
		assert.equal(r.source, "none");
		assert.equal(r.child, undefined);
	});

	it("invariant: /plan route delegates to the harness resolver (no inline fallback)", () => {
		// Compile-time / source-level pin: any future PR that re-introduces an
		// inline `tier1 = matches.filter(...)` block in server.ts's GET /plan
		// handler would diverge from the harness again. We assert source-level
		// presence of the delegated call so the regression is caught before
		// runtime.
		const src = fs.readFileSync(path.resolve(__dirname, "../src/server/server.ts"), "utf8");
		// The route must call `verificationHarness.resolvePlanStepChild(`.
		assert.ok(
			src.includes("verificationHarness.resolvePlanStepChild("),
			"GET /plan must delegate to verificationHarness.resolvePlanStepChild — see R-004",
		);
		// And NOT carry a 4-tier inline copy.
		const inlineMarker = "matches.filter(g => !g.archived && g.state === \"in-progress\")";
		assert.ok(
			!src.includes(inlineMarker),
			"Inline 4-tier resolver shape detected in server.ts — route must call the harness instead (R-004 regression)",
		);
	});
});
