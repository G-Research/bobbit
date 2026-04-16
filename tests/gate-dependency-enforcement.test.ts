/**
 * Unit tests for gate dependency enforcement logic.
 *
 * Tests the actual checkGateDependencies() function imported from the server
 * source — the same pure function used by team-manager.ts spawnRole() and
 * server.ts team/prompt handler to enforce upstream gate ordering.
 *
 * Replaces the flaky E2E test (tests/e2e/gate-dependency-enforcement.spec.ts)
 * which had timing issues with verification completion.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkGateDependencies, type GateDef, type GateState } from "../src/server/agent/gate-dependency-check.js";

// ── Test workflow: design-doc → implementation → ready-to-merge ──────

const testWorkflowGates: GateDef[] = [
	{ id: "design-doc", name: "Design Doc", dependsOn: [] },
	{ id: "implementation", name: "Implementation", dependsOn: ["design-doc"] },
	{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["implementation"] },
];

describe("Gate Dependency Enforcement", () => {
	describe("team/spawn gate checks", () => {
		it("rejects when upstream gate is pending", () => {
			const gateStates: GateState[] = [
				{ gateId: "design-doc", status: "pending" },
				{ gateId: "implementation", status: "pending" },
				{ gateId: "ready-to-merge", status: "pending" },
			];

			const error = checkGateDependencies("implementation", testWorkflowGates, gateStates);
			assert.ok(error, "Should return an error when upstream is pending");
			assert.ok(error.includes("Upstream gate"), `Error should mention upstream gate: ${error}`);
			assert.ok(error.includes("design-doc"), `Error should name the blocking gate: ${error}`);
		});

		it("allows when upstream gate has passed", () => {
			const gateStates: GateState[] = [
				{ gateId: "design-doc", status: "passed" },
				{ gateId: "implementation", status: "pending" },
				{ gateId: "ready-to-merge", status: "pending" },
			];

			const error = checkGateDependencies("implementation", testWorkflowGates, gateStates);
			assert.equal(error, null, "Should allow when upstream gate passed");
		});

		it("rejects when any upstream in chain is pending", () => {
			// ready-to-merge depends on implementation, which depends on design-doc
			// Even if design-doc passed, implementation must also pass
			const gateStates: GateState[] = [
				{ gateId: "design-doc", status: "passed" },
				{ gateId: "implementation", status: "pending" },
				{ gateId: "ready-to-merge", status: "pending" },
			];

			const error = checkGateDependencies("ready-to-merge", testWorkflowGates, gateStates);
			assert.ok(error, "Should reject when immediate upstream is pending");
			assert.ok(error.includes("implementation"), `Error should name blocking gate: ${error}`);
		});

		it("allows when all upstream gates have passed", () => {
			const gateStates: GateState[] = [
				{ gateId: "design-doc", status: "passed" },
				{ gateId: "implementation", status: "passed" },
				{ gateId: "ready-to-merge", status: "pending" },
			];

			const error = checkGateDependencies("ready-to-merge", testWorkflowGates, gateStates);
			assert.equal(error, null, "Should allow when all upstream gates passed");
		});
	});

	describe("backward compatibility (no workflowGateId)", () => {
		it("allows spawn without workflowGateId", () => {
			const gateStates: GateState[] = [
				{ gateId: "design-doc", status: "pending" },
			];

			const error = checkGateDependencies(undefined, testWorkflowGates, gateStates);
			assert.equal(error, null, "Should allow when no gate is specified");
		});

		it("allows prompt without workflowGateId", () => {
			const gateStates: GateState[] = [
				{ gateId: "design-doc", status: "pending" },
				{ gateId: "implementation", status: "pending" },
			];

			const error = checkGateDependencies(undefined, testWorkflowGates, gateStates);
			assert.equal(error, null, "Should allow prompt when no gate is specified");
		});
	});

	describe("edge cases", () => {
		it("allows gate with no dependencies", () => {
			const gateStates: GateState[] = [
				{ gateId: "design-doc", status: "pending" },
			];

			// design-doc has no dependencies
			const error = checkGateDependencies("design-doc", testWorkflowGates, gateStates);
			assert.equal(error, null, "Should allow gate with empty dependsOn");
		});

		it("allows gate not found in workflow (unknown gate)", () => {
			const gateStates: GateState[] = [];

			const error = checkGateDependencies("nonexistent-gate", testWorkflowGates, gateStates);
			assert.equal(error, null, "Should allow unknown gate (not in workflow definition)");
		});

		it("rejects when upstream gate has failed status", () => {
			const gateStates: GateState[] = [
				{ gateId: "design-doc", status: "failed" },
			];

			const error = checkGateDependencies("implementation", testWorkflowGates, gateStates);
			assert.ok(error, "Should reject when upstream gate is failed (not passed)");
			assert.ok(error.includes("design-doc"), `Error should name blocking gate: ${error}`);
		});

		it("error message includes human-readable gate names", () => {
			const gateStates: GateState[] = [
				{ gateId: "design-doc", status: "pending" },
			];

			const error = checkGateDependencies("implementation", testWorkflowGates, gateStates);
			assert.ok(error);
			// Should include "Design Doc (design-doc)" format
			assert.ok(error.includes("Design Doc"), `Should include gate name: ${error}`);
			assert.ok(error.includes("design-doc"), `Should include gate id: ${error}`);
		});

		it("handles multiple unmet dependencies", () => {
			const multiDepGates: GateDef[] = [
				{ id: "a", name: "Gate A", dependsOn: [] },
				{ id: "b", name: "Gate B", dependsOn: [] },
				{ id: "c", name: "Gate C", dependsOn: ["a", "b"] },
			];
			const gateStates: GateState[] = [
				{ gateId: "a", status: "pending" },
				{ gateId: "b", status: "pending" },
				{ gateId: "c", status: "pending" },
			];

			const error = checkGateDependencies("c", multiDepGates, gateStates);
			assert.ok(error, "Should reject when multiple upstream gates are pending");
			assert.ok(error.includes("Gate A"), `Should mention gate A: ${error}`);
			assert.ok(error.includes("Gate B"), `Should mention gate B: ${error}`);
		});
	});
});
