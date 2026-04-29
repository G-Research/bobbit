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
		store = new GateStore(path.join(TEST_DIR, "state"));
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

// ===========================================================================
// Mission/owner-kind generalisation (mission-orchestration §5)
// ===========================================================================

describe("GateStore — owner kind generalisation", () => {
	let store: InstanceType<typeof GateStore>;

	beforeEach(() => {
		ensureStateDir();
		store = new GateStore(path.join(TEST_DIR, "state"));
	});

	afterEach(() => {
		clearGates();
	});

	it("legacy goalId methods still work and default to ownerKind=goal", () => {
		store.initGatesForGoal("goal-1", ["a"]);
		const g = store.getGate("goal-1", "a")!;
		assert.equal(g.gateId, "a");
		assert.equal(g.goalId, "goal-1");
		assert.equal(g.ownerKind, "goal");
		assert.equal(g.ownerId, "goal-1");
	});

	it("mission-keyed initGatesFor / getGateFor / getGatesFor work", () => {
		store.initGatesFor("mission", "mission-1", ["charter", "plan-review", "goal-plan"]);
		const gates = store.getGatesFor("mission", "mission-1");
		assert.equal(gates.length, 3);
		assert.ok(gates.every(g => g.ownerKind === "mission"));
		assert.ok(gates.every(g => g.ownerId === "mission-1"));
		assert.equal(store.getGateFor("mission", "mission-1", "charter")!.status, "pending");
	});

	it("mission and goal with same id do not collide", () => {
		// Compose key includes kind, so a goal and a mission with the same id
		// keep distinct gate streams.
		store.initGatesForGoal("shared-id", ["a"]);
		store.initGatesFor("mission", "shared-id", ["a"]);
		store.updateGateStatus("shared-id", "a", "passed");
		assert.equal(store.getGate("shared-id", "a")!.status, "passed");
		assert.equal(store.getGateFor("mission", "shared-id", "a")!.status, "pending");
	});

	it("updateGateStatusFor / ContentFor / MetadataFor mutate mission gates", () => {
		store.initGatesFor("mission", "m1", ["charter"]);
		store.updateGateStatusFor("mission", "m1", "charter", "passed");
		store.updateGateContentFor("mission", "m1", "charter", "# Charter", 1);
		store.updateGateMetadataFor("mission", "m1", "charter", { plan_version: "1" });
		const g = store.getGateFor("mission", "m1", "charter")!;
		assert.equal(g.status, "passed");
		assert.equal(g.currentContent, "# Charter");
		assert.equal(g.currentContentVersion, 1);
		assert.deepEqual(g.currentMetadata, { plan_version: "1" });
	});

	it("removeGatesFor only removes the targeted owner", () => {
		store.initGatesForGoal("goal-1", ["a", "b"]);
		store.initGatesFor("mission", "m1", ["charter", "plan-review"]);
		store.removeGatesFor("mission", "m1");
		assert.equal(store.getGatesFor("mission", "m1").length, 0);
		assert.equal(store.getGatesForGoal("goal-1").length, 2);
	});

	it("cascadeResetFor resets mission downstream gates", () => {
		const wf = makeWorkflow([
			gate("charter"),
			gate("plan-review", ["charter"]),
			gate("goal-plan", ["plan-review"]),
		]);
		store.initGatesFor("mission", "m1", ["charter", "plan-review", "goal-plan"]);
		store.updateGateStatusFor("mission", "m1", "charter", "passed");
		store.updateGateStatusFor("mission", "m1", "plan-review", "passed");
		store.updateGateStatusFor("mission", "m1", "goal-plan", "passed");

		store.cascadeResetFor("mission", "m1", "charter", wf);

		assert.equal(store.getGateFor("mission", "m1", "charter")!.status, "passed");
		assert.equal(store.getGateFor("mission", "m1", "plan-review")!.status, "pending");
		assert.equal(store.getGateFor("mission", "m1", "goal-plan")!.status, "pending");
	});

	it("recordSignal accepts mission-owned signal and routes to right gate", () => {
		store.initGatesFor("mission", "m1", ["charter"]);
		store.recordSignal({
			id: "sig-m-1",
			gateId: "charter",
			ownerKind: "mission",
			ownerId: "m1",
			goalId: "m1", // mirrored
			sessionId: "s1",
			timestamp: Date.now(),
			commitSha: "deadbeef",
			content: "charter v1",
			contentVersion: 1,
			verification: { status: "running", steps: [] },
		});
		const g = store.getGateFor("mission", "m1", "charter")!;
		assert.equal(g.signals.length, 1);
		assert.equal(g.signals[0].ownerKind, "mission");
		assert.equal(g.signals[0].ownerId, "m1");
	});

	it("updateSignalVerification works regardless of owner kind", () => {
		store.initGatesForGoal("goal-1", ["a"]);
		store.initGatesFor("mission", "m1", ["charter"]);
		store.recordSignal({
			id: "sig-g", gateId: "a", goalId: "goal-1", sessionId: "s",
			timestamp: 0, commitSha: "x",
			verification: { status: "running", steps: [] },
		});
		store.recordSignal({
			id: "sig-m", gateId: "charter",
			ownerKind: "mission", ownerId: "m1", goalId: "m1",
			sessionId: "s", timestamp: 0, commitSha: "x",
			verification: { status: "running", steps: [] },
		});
		store.updateSignalVerification("sig-m", { status: "passed", steps: [] });
		assert.equal(store.getGateFor("mission", "m1", "charter")!.signals[0].verification.status, "passed");
		assert.equal(store.getGate("goal-1", "a")!.signals[0].verification.status, "running");
	});

	it("mixed file with both kinds round-trips through save+load", () => {
		store.initGatesForGoal("goal-1", ["a"]);
		store.initGatesFor("mission", "m1", ["charter"]);
		store.updateGateStatus("goal-1", "a", "passed");
		store.updateGateStatusFor("mission", "m1", "charter", "failed");

		// Reload from disk
		const reloaded = new GateStore(path.join(TEST_DIR, "state"));
		assert.equal(reloaded.getGate("goal-1", "a")!.status, "passed");
		assert.equal(reloaded.getGateFor("mission", "m1", "charter")!.status, "failed");
		// And mission gates not visible via legacy goal API
		assert.equal(reloaded.getGate("m1", "charter"), undefined);
	});

	it("lazy migration: legacy on-disk records (no ownerKind) load as goal-owned", () => {
		// Hand-write a legacy gates.json — only goalId, no ownerKind/ownerId.
		const legacy = [
			{
				gateId: "design-doc",
				goalId: "goal-legacy",
				status: "passed",
				signals: [
					{
						id: "sig-legacy",
						gateId: "design-doc",
						goalId: "goal-legacy",
						sessionId: "s",
						timestamp: 1,
						commitSha: "abc",
						verification: { status: "passed", steps: [] },
					},
				],
				updatedAt: 1,
			},
		];
		fs.writeFileSync(GATES_FILE, JSON.stringify(legacy));

		const loaded = new GateStore(path.join(TEST_DIR, "state"));
		// Legacy API still works
		const g = loaded.getGate("goal-legacy", "design-doc");
		assert.ok(g, "legacy record should be loadable via getGate");
		assert.equal(g!.status, "passed");
		// Hydrated to canonical form
		assert.equal(g!.ownerKind, "goal");
		assert.equal(g!.ownerId, "goal-legacy");
		// And via new API
		assert.equal(loaded.getGateFor("goal", "goal-legacy", "design-doc")!.status, "passed");
		// Signals also hydrated
		assert.equal(g!.signals[0].ownerKind, "goal");
		assert.equal(g!.signals[0].ownerId, "goal-legacy");
	});

	it("on-save the new ownerKind/ownerId fields are written", () => {
		store.initGatesFor("mission", "m-save", ["charter"]);
		store.updateGateStatusFor("mission", "m-save", "charter", "passed");
		const raw = JSON.parse(fs.readFileSync(GATES_FILE, "utf-8"));
		const rec = raw.find((g: any) => g.gateId === "charter" && g.ownerId === "m-save");
		assert.ok(rec, "mission gate should be persisted");
		assert.equal(rec.ownerKind, "mission");
		assert.equal(rec.ownerId, "m-save");
		// goalId mirrored for forward compatibility / legacy reads
		assert.equal(rec.goalId, "m-save");
	});

	it("onStatusChange callback fires with (kind, ownerId, gateId) for both kinds", () => {
		const calls: Array<{ kind: string; ownerId: string; gateId: string }> = [];
		store.onStatusChange = (kind, ownerId, gateId) => {
			calls.push({ kind, ownerId, gateId });
		};
		store.initGatesForGoal("g1", ["a"]);
		store.initGatesFor("mission", "m1", ["charter"]);
		store.updateGateStatus("g1", "a", "passed");
		store.updateGateStatusFor("mission", "m1", "charter", "failed");
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[0], { kind: "goal", ownerId: "g1", gateId: "a" });
		assert.deepEqual(calls[1], { kind: "mission", ownerId: "m1", gateId: "charter" });
	});
});

after(() => {
	try { fs.rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
});
