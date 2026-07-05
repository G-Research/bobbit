// SWARM-W4.2: pinning tests for the swarm-topology decision seam's pure
// helpers — `isSwarmTopologyArg` and the (point, kind) pair constants. See
// src/server/agent/swarm-topology-classifier.ts's header comment for the
// full design/scope (this wave ships the seam harness only; no production
// classifier is registered).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DECISION_POINTS } from "../src/server/agent/decision-types.ts";
import { SWARM_TOPOLOGY_POINT, SWARM_TOPOLOGY_KIND, isSwarmTopologyArg } from "../src/server/agent/swarm-topology-classifier.ts";

describe("SWARM_TOPOLOGY_POINT / SWARM_TOPOLOGY_KIND", () => {
	it("is (goal-create, swarm-topology) per the design doc's §3.2 seam", () => {
		assert.equal(SWARM_TOPOLOGY_POINT, "goal-create");
		assert.equal(SWARM_TOPOLOGY_KIND, "swarm-topology");
	});

	it("'goal-create' is registered in DECISION_POINTS", () => {
		assert.ok(DECISION_POINTS.includes("goal-create"), "goal-create must be a valid DecisionPoint");
	});

	it("does not remove or rename any pre-existing DecisionPoint (session-spawn, tool-call, etc.)", () => {
		for (const point of ["user-prompt-submit", "agent-prompt", "tool-call", "turn-boundary", "compaction", "session-spawn"]) {
			assert.ok(DECISION_POINTS.includes(point as any), `expected pre-existing point ${point} to still be registered`);
		}
	});
});

describe("isSwarmTopologyArg", () => {
	it("accepts a well-formed arg with goalId + spec + hasVerifyCommand", () => {
		assert.equal(isSwarmTopologyArg({ goalId: "g1", spec: "fix the bug", hasVerifyCommand: true }), true);
	});

	it("accepts an arg with the optional requestedFanOut present", () => {
		assert.equal(isSwarmTopologyArg({ goalId: "g1", spec: "fix the bug", hasVerifyCommand: true, requestedFanOut: 5 }), true);
	});

	it("rejects a missing goalId", () => {
		assert.equal(isSwarmTopologyArg({ spec: "x", hasVerifyCommand: true }), false);
	});

	it("rejects a missing spec", () => {
		assert.equal(isSwarmTopologyArg({ goalId: "g1", hasVerifyCommand: true }), false);
	});

	it("rejects a non-boolean hasVerifyCommand", () => {
		assert.equal(isSwarmTopologyArg({ goalId: "g1", spec: "x", hasVerifyCommand: "yes" }), false);
	});

	it("rejects a non-number requestedFanOut when present", () => {
		assert.equal(isSwarmTopologyArg({ goalId: "g1", spec: "x", hasVerifyCommand: true, requestedFanOut: "5" }), false);
	});

	it("rejects null/undefined/non-object values", () => {
		assert.equal(isSwarmTopologyArg(null), false);
		assert.equal(isSwarmTopologyArg(undefined), false);
		assert.equal(isSwarmTopologyArg("g1"), false);
		assert.equal(isSwarmTopologyArg(42), false);
	});
});
