/**
 * Unit tests for GateStore logic: init, status updates, cascade reset,
 * gate removal, and dependency checking.
 * Uses BOBBIT_DIR temp dir for isolated GateStore.
 */
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate from real state
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gate-store-test-"));
process.env.BOBBIT_DIR = TEST_DIR;

const GATES_FILE = path.join(TEST_DIR, "state", "gates.json");

function clearGates() {
	try { fs.unlinkSync(GATES_FILE); } catch { /* ignore */ }
}

function ensureStateDir() {
	fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });
	clearGates();
}

// Import after env var is set
const { GateStore } = await import("../src/server/agent/gate-store.ts");
import type { Workflow, WorkflowGate } from "../src/server/agent/workflow-store.ts";

// Helper to build a minimal workflow for cascadeReset
function makeWorkflow(gates: WorkflowGate[]): Workflow {
	return {
		id: "test-wf",
		name: "Test",
		description: "",
		gates,
		createdAt: 0,
		updatedAt: 0,
	};
}

function gate(id: string, dependsOn: string[] = []): WorkflowGate {
	return { id, name: id, dependsOn };
}

describe("GateStore", () => {
	let store: InstanceType<typeof GateStore>;

	beforeEach(() => {
		ensureStateDir();
		store = new GateStore();
	});

	afterEach(() => {
		clearGates();
	});

	// --- initGatesForGoal ---

	describe("initGatesForGoal", () => {
		it("creates pending gates for a goal", () => {
			store.initGatesForGoal("goal-1", ["design-doc", "implementation", "ready"]);
			const gates = store.getGatesForGoal("goal-1");
			assert.equal(gates.length, 3);
			assert.ok(gates.every(g => g.status === "pending"));
			assert.ok(gates.every(g => g.goalId === "goal-1"));
		});

		it("does not overwrite existing gates", () => {
			store.initGatesForGoal("goal-1", ["a"]);
			store.updateGateStatus("goal-1", "a", "passed");
			store.initGatesForGoal("goal-1", ["a", "b"]);
			// 'a' should still be passed, 'b' should be pending
			assert.equal(store.getGate("goal-1", "a")!.status, "passed");
			assert.equal(store.getGate("goal-1", "b")!.status, "pending");
		});

		it("handles empty gate list", () => {
			store.initGatesForGoal("goal-1", []);
			assert.equal(store.getGatesForGoal("goal-1").length, 0);
		});
	});

	// --- getGate ---

	describe("getGate", () => {
		it("returns undefined for nonexistent gate", () => {
			assert.equal(store.getGate("goal-1", "nonexistent"), undefined);
		});

		it("returns gate for existing", () => {
			store.initGatesForGoal("goal-1", ["a"]);
			const g = store.getGate("goal-1", "a");
			assert.ok(g);
			assert.equal(g.gateId, "a");
			assert.equal(g.goalId, "goal-1");
		});
	});

	// --- updateGateStatus ---

	describe("updateGateStatus", () => {
		it("changes gate status", () => {
			store.initGatesForGoal("goal-1", ["a"]);
			store.updateGateStatus("goal-1", "a", "passed");
			assert.equal(store.getGate("goal-1", "a")!.status, "passed");
		});

		it("updates updatedAt timestamp", () => {
			store.initGatesForGoal("goal-1", ["a"]);
			const before = Date.now();
			store.updateGateStatus("goal-1", "a", "failed");
			const g = store.getGate("goal-1", "a")!;
			assert.ok(g.updatedAt >= before);
		});

		it("is a no-op for nonexistent gate", () => {
			store.updateGateStatus("goal-1", "nonexistent", "passed");
			// Should not throw
			assert.equal(store.getGate("goal-1", "nonexistent"), undefined);
		});
	});

	// --- cascadeReset ---

	describe("cascadeReset", () => {
		it("resets direct dependents to pending", () => {
			// A → B → C
			const wf = makeWorkflow([
				gate("a"),
				gate("b", ["a"]),
				gate("c", ["b"]),
			]);
			store.initGatesForGoal("goal-1", ["a", "b", "c"]);
			store.updateGateStatus("goal-1", "a", "passed");
			store.updateGateStatus("goal-1", "b", "passed");
			store.updateGateStatus("goal-1", "c", "passed");

			// Re-signal gate A — B and C should reset
			store.cascadeReset("goal-1", "a", wf);

			assert.equal(store.getGate("goal-1", "a")!.status, "passed"); // not reset
			assert.equal(store.getGate("goal-1", "b")!.status, "pending");
			assert.equal(store.getGate("goal-1", "c")!.status, "pending");
		});

		it("resets transitive dependents in diamond DAG", () => {
			// A → B, A → C, B+C → D
			const wf = makeWorkflow([
				gate("a"),
				gate("b", ["a"]),
				gate("c", ["a"]),
				gate("d", ["b", "c"]),
			]);
			store.initGatesForGoal("goal-1", ["a", "b", "c", "d"]);
			store.updateGateStatus("goal-1", "a", "passed");
			store.updateGateStatus("goal-1", "b", "passed");
			store.updateGateStatus("goal-1", "c", "passed");
			store.updateGateStatus("goal-1", "d", "passed");

			store.cascadeReset("goal-1", "a", wf);

			assert.equal(store.getGate("goal-1", "a")!.status, "passed");
			assert.equal(store.getGate("goal-1", "b")!.status, "pending");
			assert.equal(store.getGate("goal-1", "c")!.status, "pending");
			assert.equal(store.getGate("goal-1", "d")!.status, "pending");
		});

		it("does not affect unrelated gates", () => {
			// A → B, C (independent)
			const wf = makeWorkflow([
				gate("a"),
				gate("b", ["a"]),
				gate("c"),
			]);
			store.initGatesForGoal("goal-1", ["a", "b", "c"]);
			store.updateGateStatus("goal-1", "a", "passed");
			store.updateGateStatus("goal-1", "b", "passed");
			store.updateGateStatus("goal-1", "c", "passed");

			store.cascadeReset("goal-1", "a", wf);

			assert.equal(store.getGate("goal-1", "c")!.status, "passed"); // unaffected
			assert.equal(store.getGate("goal-1", "b")!.status, "pending"); // dependent
		});

		it("handles no dependents gracefully", () => {
			// A (leaf node)
			const wf = makeWorkflow([gate("a")]);
			store.initGatesForGoal("goal-1", ["a"]);
			store.updateGateStatus("goal-1", "a", "passed");

			// Should not throw
			store.cascadeReset("goal-1", "a", wf);
			assert.equal(store.getGate("goal-1", "a")!.status, "passed");
		});

		it("only resets gates that are not already pending", () => {
			const wf = makeWorkflow([
				gate("a"),
				gate("b", ["a"]),
			]);
			store.initGatesForGoal("goal-1", ["a", "b"]);
			store.updateGateStatus("goal-1", "a", "passed");
			// b stays pending

			store.cascadeReset("goal-1", "a", wf);
			assert.equal(store.getGate("goal-1", "b")!.status, "pending");
		});
	});

	// --- updateGateContent ---

	describe("updateGateContent", () => {
		it("sets content and version", () => {
			store.initGatesForGoal("goal-1", ["a"]);
			store.updateGateContent("goal-1", "a", "# Design", 1);
			const g = store.getGate("goal-1", "a")!;
			assert.equal(g.currentContent, "# Design");
			assert.equal(g.currentContentVersion, 1);
		});
	});

	// --- updateGateMetadata ---

	describe("updateGateMetadata", () => {
		it("sets metadata", () => {
			store.initGatesForGoal("goal-1", ["a"]);
			store.updateGateMetadata("goal-1", "a", { test_command: "npm test" });
			const g = store.getGate("goal-1", "a")!;
			assert.deepEqual(g.currentMetadata, { test_command: "npm test" });
		});
	});

	// --- removeGoalGates ---

	describe("removeGoalGates", () => {
		it("removes all gates for a goal", () => {
			store.initGatesForGoal("goal-1", ["a", "b", "c"]);
			store.initGatesForGoal("goal-2", ["x", "y"]);
			store.removeGoalGates("goal-1");
			assert.equal(store.getGatesForGoal("goal-1").length, 0);
			assert.equal(store.getGatesForGoal("goal-2").length, 2);
		});

		it("handles nonexistent goal gracefully", () => {
			store.removeGoalGates("nonexistent");
			// Should not throw
		});
	});

	// --- recordSignal ---

	describe("recordSignal", () => {
		it("appends signal to gate history", () => {
			store.initGatesForGoal("goal-1", ["a"]);
			store.recordSignal({
				id: "sig-1",
				gateId: "a",
				goalId: "goal-1",
				sessionId: "s1",
				timestamp: Date.now(),
				commitSha: "abc123",
				content: "test content",
				contentVersion: 1,
				verification: { status: "running", steps: [] },
			});
			const g = store.getGate("goal-1", "a")!;
			assert.equal(g.signals.length, 1);
			assert.equal(g.signals[0].id, "sig-1");
		});
	});

	// --- Gate dependency checking helper ---

	describe("upstream gate dependency checking", () => {
		it("all upstream gates passed → dependency met", () => {
			const wf = makeWorkflow([
				gate("design-doc"),
				gate("implementation", ["design-doc"]),
			]);
			store.initGatesForGoal("goal-1", ["design-doc", "implementation"]);
			store.updateGateStatus("goal-1", "design-doc", "passed");

			// Check if implementation's upstream deps are all passed
			const implGate = wf.gates.find(g => g.id === "implementation")!;
			const allPassed = implGate.dependsOn.every(depId => {
				const dep = store.getGate("goal-1", depId);
				return dep?.status === "passed";
			});
			assert.equal(allPassed, true);
		});

		it("upstream gate pending → dependency not met", () => {
			const wf = makeWorkflow([
				gate("design-doc"),
				gate("implementation", ["design-doc"]),
			]);
			store.initGatesForGoal("goal-1", ["design-doc", "implementation"]);
			// design-doc stays pending

			const implGate = wf.gates.find(g => g.id === "implementation")!;
			const allPassed = implGate.dependsOn.every(depId => {
				const dep = store.getGate("goal-1", depId);
				return dep?.status === "passed";
			});
			assert.equal(allPassed, false);
		});

		it("multiple upstream gates — all must pass", () => {
			const wf = makeWorkflow([
				gate("a"),
				gate("b"),
				gate("c", ["a", "b"]),
			]);
			store.initGatesForGoal("goal-1", ["a", "b", "c"]);
			store.updateGateStatus("goal-1", "a", "passed");
			// b stays pending

			const cGate = wf.gates.find(g => g.id === "c")!;
			const allPassed = cGate.dependsOn.every(depId => {
				const dep = store.getGate("goal-1", depId);
				return dep?.status === "passed";
			});
			assert.equal(allPassed, false);
		});

		it("gate with no dependencies → always met", () => {
			const wf = makeWorkflow([gate("a")]);
			store.initGatesForGoal("goal-1", ["a"]);

			const aGate = wf.gates.find(g => g.id === "a")!;
			const allPassed = aGate.dependsOn.every(depId => {
				const dep = store.getGate("goal-1", depId);
				return dep?.status === "passed";
			});
			assert.equal(allPassed, true); // empty array → every() returns true
		});
	});
});

after(() => {
	try { fs.rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
});
