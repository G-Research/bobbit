/**
 * Unit tests for the pure dependsOn-validation helper.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	validateDependsOn,
	validatePlanDependsOn,
} from "../src/server/agent/depends-on-validation.ts";

describe("validateDependsOn (single-step)", () => {
	it("ok when dependsOn is empty/undefined", () => {
		assert.deepEqual(
			validateDependsOn({ planId: "x", dependsOn: undefined, knownPlanIds: [] }),
			{ ok: true },
		);
		assert.deepEqual(
			validateDependsOn({ planId: "x", dependsOn: [], knownPlanIds: [] }),
			{ ok: true },
		);
	});

	it("rejects self-dependency", () => {
		const r = validateDependsOn({ planId: "x", dependsOn: ["x"], knownPlanIds: ["x"] });
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.equal(r.code, "SELF_DEPENDENCY");
			assert.equal(r.planId, "x");
		}
	});

	it("rejects unknown planId references", () => {
		const r = validateDependsOn({ planId: "x", dependsOn: ["a", "b"], knownPlanIds: ["a"] });
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.equal(r.code, "UNKNOWN_PLAN_ID");
			assert.deepEqual(r.missing, ["b"]);
		}
	});

	it("ok when all deps are known and no self-dep", () => {
		assert.deepEqual(
			validateDependsOn({ planId: "x", dependsOn: ["a", "b"], knownPlanIds: ["a", "b"] }),
			{ ok: true },
		);
	});

	it("self-dep takes precedence over unknown-ref reporting", () => {
		const r = validateDependsOn({ planId: "x", dependsOn: ["x", "missing"], knownPlanIds: [] });
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.code, "SELF_DEPENDENCY");
	});
});

describe("validatePlanDependsOn (multi-step plan)", () => {
	it("ok when no deps anywhere", () => {
		assert.deepEqual(
			validatePlanDependsOn([
				{ planId: "a" },
				{ planId: "b" },
			]),
			{ ok: true },
		);
	});

	it("ok on a chain a → b → c", () => {
		assert.deepEqual(
			validatePlanDependsOn([
				{ planId: "a" },
				{ planId: "b", dependsOn: ["a"] },
				{ planId: "c", dependsOn: ["b"] },
			]),
			{ ok: true },
		);
	});

	it("ok on a diamond", () => {
		assert.deepEqual(
			validatePlanDependsOn([
				{ planId: "a" },
				{ planId: "b", dependsOn: ["a"] },
				{ planId: "c", dependsOn: ["a"] },
				{ planId: "d", dependsOn: ["b", "c"] },
			]),
			{ ok: true },
		);
	});

	it("rejects self-dep", () => {
		const r = validatePlanDependsOn([
			{ planId: "a", dependsOn: ["a"] },
		]);
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.code, "SELF_DEPENDENCY");
	});

	it("rejects unknown planId reference", () => {
		const r = validatePlanDependsOn([
			{ planId: "a", dependsOn: ["nonexistent"] },
		]);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.equal(r.code, "UNKNOWN_PLAN_ID");
			assert.deepEqual(r.missing, ["nonexistent"]);
		}
	});

	it("rejects 2-cycle", () => {
		const r = validatePlanDependsOn([
			{ planId: "a", dependsOn: ["b"] },
			{ planId: "b", dependsOn: ["a"] },
		]);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.equal(r.code, "DEPENDS_ON_CYCLE");
			assert.ok(r.path.includes("a"));
			assert.ok(r.path.includes("b"));
		}
	});

	it("rejects 3-cycle", () => {
		const r = validatePlanDependsOn([
			{ planId: "a", dependsOn: ["c"] },
			{ planId: "b", dependsOn: ["a"] },
			{ planId: "c", dependsOn: ["b"] },
		]);
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.code, "DEPENDS_ON_CYCLE");
	});

	it("self-dep detected before cycle", () => {
		const r = validatePlanDependsOn([
			{ planId: "a", dependsOn: ["a"] },
			{ planId: "b", dependsOn: ["a"] },
		]);
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.code, "SELF_DEPENDENCY");
	});

	it("unknown ref detected before cycle", () => {
		const r = validatePlanDependsOn([
			{ planId: "a", dependsOn: ["zzz"] },
			{ planId: "b", dependsOn: ["a"] },
		]);
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.code, "UNKNOWN_PLAN_ID");
	});

	it("collects ALL missing refs (deduped)", () => {
		const r = validatePlanDependsOn([
			{ planId: "a", dependsOn: ["x", "y"] },
			{ planId: "b", dependsOn: ["x"] },
		]);
		assert.equal(r.ok, false);
		if (!r.ok && r.code === "UNKNOWN_PLAN_ID") {
			assert.deepEqual(r.missing.sort(), ["x", "y"]);
		}
	});

	it("rejects duplicate planIds (not silently collapsed)", () => {
		const r = validatePlanDependsOn([
			{ planId: "a" },
			{ planId: "a", dependsOn: [] },
			{ planId: "b" },
		]);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.equal(r.code, "DUPLICATE_PLAN_ID");
			assert.equal(r.planId, "a");
		}
	});

	it("duplicate planId detected before self-dep / unknown-ref / cycle", () => {
		// Even though the second 'a' has a self-dep, the duplicate is reported first.
		const r = validatePlanDependsOn([
			{ planId: "a" },
			{ planId: "a", dependsOn: ["a"] },
		]);
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.code, "DUPLICATE_PLAN_ID");
	});

	it("a valid plan with all-unique planIds still passes", () => {
		assert.deepEqual(
			validatePlanDependsOn([
				{ planId: "a" },
				{ planId: "b", dependsOn: ["a"] },
				{ planId: "c", dependsOn: ["a", "b"] },
			]),
			{ ok: true },
		);
	});
});
