/**
 * Sec-2 — request-size caps for the plan/spawn endpoints.
 *
 * The PATCH /plan and POST /spawn-child handlers reject oversized bodies with
 * a clear 400 (PLAN_TOO_LARGE / SPEC_TOO_LONG / WORKFLOW_TOO_LARGE /
 * ROLES_TOO_LARGE) BEFORE any classification or persistence work runs, so a
 * single huge body cannot exhaust memory/CPU. These tests pin the pure
 * size-check helpers the handlers delegate to.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	MAX_PROPOSED_STEPS,
	MAX_SPEC_LENGTH,
	MAX_INLINE_JSON_BYTES,
	checkPlanRequestSize,
	checkSpecSize,
	checkInlineJsonSize,
} from "../src/server/agent/nested-goal-routes.ts";

function step(planId: string, spec = "spec"): Record<string, unknown> {
	return { planId, title: `t-${planId}`, phase: 1, spec, subgoal: { planId, title: `t-${planId}`, spec } };
}

describe("checkPlanRequestSize (PATCH /plan)", () => {
	it("accepts a normal-sized plan", () => {
		const steps = Array.from({ length: 10 }, (_, i) => step(`p${i}`));
		assert.equal(checkPlanRequestSize(steps).ok, true);
	});

	it("accepts exactly MAX_PROPOSED_STEPS", () => {
		const steps = Array.from({ length: MAX_PROPOSED_STEPS }, (_, i) => step(`p${i}`));
		assert.equal(checkPlanRequestSize(steps).ok, true);
	});

	it("rejects more than MAX_PROPOSED_STEPS with PLAN_TOO_LARGE", () => {
		const steps = Array.from({ length: MAX_PROPOSED_STEPS + 1 }, (_, i) => step(`p${i}`));
		const r = checkPlanRequestSize(steps);
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.code, "PLAN_TOO_LARGE");
		assert.equal(r.limit, MAX_PROPOSED_STEPS);
		assert.equal(r.actual, MAX_PROPOSED_STEPS + 1);
	});

	it("rejects an oversized top-level step spec with SPEC_TOO_LONG", () => {
		const big = "x".repeat(MAX_SPEC_LENGTH + 1);
		const r = checkPlanRequestSize([step("a", big)]);
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.code, "SPEC_TOO_LONG");
		assert.equal(r.actual, MAX_SPEC_LENGTH + 1);
	});

	it("rejects an oversized nested subgoal.spec with SPEC_TOO_LONG", () => {
		const big = "y".repeat(MAX_SPEC_LENGTH + 5);
		const bad = { planId: "a", title: "t", phase: 1, subgoal: { planId: "a", title: "t", spec: big } };
		const r = checkPlanRequestSize([bad]);
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.code, "SPEC_TOO_LONG");
	});

	it("accepts a spec exactly at MAX_SPEC_LENGTH", () => {
		assert.equal(checkPlanRequestSize([step("a", "z".repeat(MAX_SPEC_LENGTH))]).ok, true);
	});
});

describe("checkSpecSize (spawn-child)", () => {
	it("accepts a normal spec", () => {
		assert.equal(checkSpecSize("a real task description").ok, true);
	});

	it("accepts a spec exactly at MAX_SPEC_LENGTH", () => {
		assert.equal(checkSpecSize("a".repeat(MAX_SPEC_LENGTH)).ok, true);
	});

	it("rejects an oversized spec with SPEC_TOO_LONG", () => {
		const r = checkSpecSize("a".repeat(MAX_SPEC_LENGTH + 1));
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.code, "SPEC_TOO_LONG");
		assert.equal(r.limit, MAX_SPEC_LENGTH);
		assert.equal(r.actual, MAX_SPEC_LENGTH + 1);
	});
});

describe("checkInlineJsonSize (spawn-child inline workflow/roles)", () => {
	it("treats undefined/null as ok (no inline blob)", () => {
		assert.equal(checkInlineJsonSize(undefined, "workflow").ok, true);
		assert.equal(checkInlineJsonSize(null, "roles").ok, true);
	});

	it("accepts a small inline workflow", () => {
		assert.equal(checkInlineJsonSize({ id: "wf", gates: [] }, "workflow").ok, true);
	});

	it("rejects an oversized inline workflow with WORKFLOW_TOO_LARGE", () => {
		const huge = { id: "wf", blob: "w".repeat(MAX_INLINE_JSON_BYTES + 10) };
		const r = checkInlineJsonSize(huge, "workflow");
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.code, "WORKFLOW_TOO_LARGE");
		assert.ok(r.actual > MAX_INLINE_JSON_BYTES);
	});

	it("rejects an oversized inline roles blob with ROLES_TOO_LARGE", () => {
		const huge = { reviewer: { prompt: "r".repeat(MAX_INLINE_JSON_BYTES + 10) } };
		const r = checkInlineJsonSize(huge, "roles");
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.code, "ROLES_TOO_LARGE");
	});

	it("rejects a non-serializable inline blob (circular) with a clear code", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const r = checkInlineJsonSize(circular, "workflow");
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.code, "WORKFLOW_TOO_LARGE");
	});
});
