/**
 * Phase 5 — `POST /api/goals/:id/spawn-child` validates explicit
 * `dependsOn` references against the parent's existing children's
 * `spawnedFromPlanId`s before stamping `dependsOnPlanIds` on the new child.
 *
 * The HTTP route is exercised at the E2E layer (`tests/e2e/...`); this
 * spec covers the pure validator path used by the route handler — same
 * pattern as `api-goals-plan-mutation.test.ts` for the PATCH route.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	validateDependsOn,
	validatePlanDependsOn,
} from "../src/server/agent/depends-on-validation.ts";

describe("POST /api/goals/:id/spawn-child — dependsOn validation", () => {
	it("ok when no dependsOn supplied", () => {
		const r = validateDependsOn({ planId: "new", knownPlanIds: ["a", "b"] });
		assert.deepEqual(r, { ok: true });
	});

	it("400 SELF_DEPENDENCY when dependsOn includes own planId", () => {
		const r = validateDependsOn({ planId: "x", dependsOn: ["x"], knownPlanIds: ["a"] });
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.code, "SELF_DEPENDENCY");
	});

	it("400 UNKNOWN_PLAN_ID when referenced sibling not yet spawned", () => {
		const r = validateDependsOn({ planId: "new", dependsOn: ["nonexistent"], knownPlanIds: ["a"] });
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.equal(r.code, "UNKNOWN_PLAN_ID");
			assert.deepEqual(r.missing, ["nonexistent"]);
		}
	});

	it("happy path: dependsOn matches a sibling planId", () => {
		const r = validateDependsOn({ planId: "new", dependsOn: ["a"], knownPlanIds: ["a", "b"] });
		assert.deepEqual(r, { ok: true });
	});

	it("DEPENDS_ON_CYCLE detected by full-graph validator (cross-call)", () => {
		// Reconstruct what the spawn-child handler does: build the implied DAG
		// from existing siblings + the new step, then run validatePlanDependsOn.
		// If sibling A already lists B as a dep, attempting to spawn B with
		// deps=[A] would close a cycle.
		const r = validatePlanDependsOn([
			{ planId: "a", dependsOn: ["b"] }, // existing sibling
			{ planId: "b", dependsOn: ["a"] }, // new step being spawned
		]);
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.code, "DEPENDS_ON_CYCLE");
	});
});
