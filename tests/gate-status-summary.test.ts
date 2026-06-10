import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGateStatusSummary } from "../src/server/gate-status-summary.js";
import type { GateState } from "../src/server/agent/gate-store.js";
import type { ActiveVerification } from "../src/server/agent/verification-harness.js";

function gate(status: GateState["status"], gateId = "implementation"): GateState {
	return {
		goalId: "goal-1",
		gateId,
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

	it("reports bypassed and bypassedCount counts", () => {
		const summary = buildGateStatusSummary({
			workflow: { gates: [
				{ id: "design-doc", name: "Design Doc", dependsOn: [] },
				{ id: "implementation", name: "Implementation", dependsOn: ["design-doc"] },
			] },
			gates: [gate("passed", "design-doc"), gate("bypassed", "implementation")],
			activeVerifications: [],
		});

		assert.equal(summary.passed, 1, "bypassed must NOT be counted as passed");
		assert.equal(summary.bypassed, 1);
		assert.equal(summary.bypassedCount, 1);
		assert.equal(summary.total, 2);
		// Badge numerator = passed + bypassed = 2/2 (red ! semantics on client).
		assert.equal(summary.passed + summary.bypassed, summary.total);
		const impl = summary.gates.find(g => g.gateId === "implementation");
		assert.equal(impl?.status, "bypassed");
		assert.equal(impl?.effectiveStatus, "bypassed");
	});

	it("reports zero bypassed when no gate is bypassed", () => {
		const summary = buildGateStatusSummary({
			workflow: { gates: [{ id: "implementation", name: "Implementation", dependsOn: [] }] },
			gates: [gate("passed")],
			activeVerifications: [],
		});
		assert.equal(summary.bypassed, 0);
		assert.equal(summary.bypassedCount, 0);
	});
});
