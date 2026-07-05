// SWARM-W4.3: pinning tests for the swarm-topology decision seam's pure
// helpers, v1 rule table, and DecisionClassifier wrapper. See
// src/server/agent/swarm-topology-classifier.ts's header comment for the
// full design/scope (observe-only; route consult result is discarded).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DECISION_POINTS } from "../src/server/agent/decision-types.ts";
import {
	SWARM_TOPOLOGY_POINT,
	SWARM_TOPOLOGY_KIND,
	SWARM_TOPOLOGY_CLASSIFIER_ID,
	classifySwarmTopology,
	isSwarmTopologyArg,
	swarmTopologyClassifier,
} from "../src/server/agent/swarm-topology-classifier.ts";

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

describe("classifySwarmTopology (SWARM-W4.3 deterministic rule table)", () => {
	const baseArg = { goalId: "g1", spec: "fix the bug", hasVerifyCommand: true };

	it("selects best-of-N when requestedFanOut >= 2 and a deterministic verifier exists", () => {
		assert.deepEqual(classifySwarmTopology({ ...baseArg, requestedFanOut: 2 }), {
			kind: "select",
			choice: { topology: "best-of-n", fanOut: 2, earlyKill: false },
			confidence: 1,
			rationale: "matched deterministic rule 'best-of-n-with-verifier': caller already wants fan-out and a deterministic verifier exists",
		});
	});

	it("carries through the caller-requested fan-out in the observe-only choice", () => {
		const decision = classifySwarmTopology({ ...baseArg, requestedFanOut: 5 });
		assert.equal(decision.kind, "select");
		assert.deepEqual((decision as { choice: unknown }).choice, { topology: "best-of-n", fanOut: 5, earlyKill: false });
	});

	it("abstains when fan-out is requested but no deterministic verifier exists", () => {
		assert.deepEqual(classifySwarmTopology({ ...baseArg, hasVerifyCommand: false, requestedFanOut: 2 }), { kind: "abstain" });
		assert.deepEqual(classifySwarmTopology({ ...baseArg, hasVerifyCommand: false, requestedFanOut: 8 }), { kind: "abstain" });
	});

	it("abstains when requestedFanOut is missing or below 2", () => {
		assert.deepEqual(classifySwarmTopology(baseArg), { kind: "abstain" });
		assert.deepEqual(classifySwarmTopology({ ...baseArg, requestedFanOut: 1 }), { kind: "abstain" });
	});

	it("does not inspect spec text or use text heuristics", () => {
		const decision = classifySwarmTopology({ ...baseArg, spec: "solo tiny typo fix, definitely no swarm words", requestedFanOut: 2 });
		assert.equal(decision.kind, "select");
		assert.deepEqual((decision as { choice: unknown }).choice, { topology: "best-of-n", fanOut: 2, earlyKill: false });

		assert.deepEqual(
			classifySwarmTopology({ ...baseArg, spec: "fan out to many agents and verify everything", requestedFanOut: undefined }),
			{ kind: "abstain" },
		);
	});
});

describe("swarmTopologyClassifier (DecisionClassifier wrapper)", () => {
	const ctx = { sessionId: "sess-1", cwd: "/tmp", goalId: "g1" };

	it("has the expected built-in classifier id", () => {
		assert.equal(swarmTopologyClassifier.id, SWARM_TOPOLOGY_CLASSIFIER_ID);
	});

	it("registers at (goal-create, swarm-topology)", () => {
		assert.equal(SWARM_TOPOLOGY_POINT, "goal-create");
		assert.equal(SWARM_TOPOLOGY_KIND, "swarm-topology");
	});

	it("reads hasVerifyCommand/requestedFanOut and selects best-of-N", async () => {
		const decision = await swarmTopologyClassifier.evaluate(ctx, {
			goalId: "g1",
			spec: "fix the bug",
			hasVerifyCommand: true,
			requestedFanOut: 3,
		});
		assert.equal(decision.kind, "select");
		assert.deepEqual((decision as { choice: unknown }).choice, { topology: "best-of-n", fanOut: 3, earlyKill: false });
	});

	it("abstains for a malformed arg (wrong type) rather than throwing", async () => {
		const decision = await swarmTopologyClassifier.evaluate(ctx, {
			goalId: "g1",
			spec: "fix the bug",
			hasVerifyCommand: true,
			requestedFanOut: "3",
		});
		assert.deepEqual(decision, { kind: "abstain" });
	});

	it("abstains for a null/undefined arg rather than throwing", async () => {
		assert.deepEqual(await swarmTopologyClassifier.evaluate(ctx, undefined), { kind: "abstain" });
		assert.deepEqual(await swarmTopologyClassifier.evaluate(ctx, null), { kind: "abstain" });
	});
});
