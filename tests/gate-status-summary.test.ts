import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGateStatusSummary } from "../src/server/gate-status-summary.js";
import type { GateState } from "../src/server/agent/gate-store.js";
import type { ActiveVerification } from "../src/server/agent/verification-harness.js";

function gate(status: GateState["status"]): GateState {
	return {
		goalId: "goal-1",
		gateId: "implementation",
		status,
		signals: [],
		updatedAt: Date.now(),
	};
}

describe("buildGateStatusSummary", () => {
	it("overlays active verification on an already-passed gate", () => {
		const active: ActiveVerification = {
			goalId: "goal-1",
			gateId: "implementation",
			signalId: "signal-2",
			overallStatus: "running",
			startedAt: Date.now(),
			steps: [{ name: "Slow verification", type: "command", status: "running", startedAt: Date.now() }],
		};

		const summary = buildGateStatusSummary({
			workflow: { gates: [{ id: "implementation", name: "Implementation", dependsOn: [] }] },
			gates: [gate("passed")],
			activeVerifications: [active],
		});

		assert.equal(summary.passed, 1);
		assert.equal(summary.total, 1);
		assert.equal(summary.verifying, true);
		assert.equal(summary.verifyingCount, 1);
		assert.deepEqual(summary.runningGateIds, ["implementation"]);
		assert.equal(summary.gates[0]?.status, "passed");
		assert.equal(summary.gates[0]?.effectiveStatus, "running");
		assert.equal(summary.gates[0]?.running, true);
	});
});
