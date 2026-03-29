/**
 * Unit tests for WorkflowManager DAG validation and CRUD logic.
 * Uses an in-memory mock WorkflowStore — no disk I/O.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { WorkflowManager } from "../src/server/agent/workflow-manager.ts";
import type { Workflow, WorkflowGate } from "../src/server/agent/workflow-store.ts";

// ---------------------------------------------------------------------------
// In-memory mock WorkflowStore
// ---------------------------------------------------------------------------

class MockWorkflowStore {
	private workflows = new Map<string, Workflow>();

	put(workflow: Workflow): void {
		this.workflows.set(workflow.id, workflow);
	}
	get(id: string): Workflow | undefined {
		return this.workflows.get(id);
	}
	remove(id: string): void {
		this.workflows.delete(id);
	}
	getAll(): Workflow[] {
		return Array.from(this.workflows.values());
	}
	update(id: string, updates: Partial<Omit<Workflow, "id" | "createdAt">>): boolean {
		const existing = this.workflows.get(id);
		if (!existing) return false;
		Object.assign(existing, updates, { updatedAt: Date.now() });
		return true;
	}
	reload(): void { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gate(id: string, name: string, dependsOn: string[] = []): WorkflowGate {
	return { id, name, dependsOn };
}

let store: MockWorkflowStore;
let mgr: WorkflowManager;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkflowManager", () => {
	beforeEach(() => {
		store = new MockWorkflowStore();
		mgr = new WorkflowManager(store as any);
	});

	// --- Valid DAGs ---

	describe("valid DAGs", () => {
		it("accepts a single gate with no dependencies", () => {
			const wf = mgr.createWorkflow({
				id: "simple",
				name: "Simple",
				gates: [gate("a", "Gate A")],
			});
			assert.equal(wf.id, "simple");
			assert.equal(wf.gates.length, 1);
		});

		it("accepts a linear chain A → B → C", () => {
			const wf = mgr.createWorkflow({
				id: "linear",
				name: "Linear",
				gates: [
					gate("a", "A"),
					gate("b", "B", ["a"]),
					gate("c", "C", ["b"]),
				],
			});
			assert.equal(wf.gates.length, 3);
		});

		it("accepts a diamond DAG (A → B,C → D)", () => {
			const wf = mgr.createWorkflow({
				id: "diamond",
				name: "Diamond",
				gates: [
					gate("a", "A"),
					gate("b", "B", ["a"]),
					gate("c", "C", ["a"]),
					gate("d", "D", ["b", "c"]),
				],
			});
			assert.equal(wf.gates.length, 4);
		});

		it("accepts fan-out (A → B, A → C, A → D)", () => {
			const wf = mgr.createWorkflow({
				id: "fanout",
				name: "Fan Out",
				gates: [
					gate("a", "A"),
					gate("b", "B", ["a"]),
					gate("c", "C", ["a"]),
					gate("d", "D", ["a"]),
				],
			});
			assert.equal(wf.gates.length, 4);
		});

		it("accepts fan-in (B,C,D → E)", () => {
			const wf = mgr.createWorkflow({
				id: "fanin",
				name: "Fan In",
				gates: [
					gate("b", "B"),
					gate("c", "C"),
					gate("d", "D"),
					gate("e", "E", ["b", "c", "d"]),
				],
			});
			assert.equal(wf.gates.length, 4);
		});
	});

	// --- Circular dependency detection ---

	describe("circular dependency detection", () => {
		it("rejects A → B → A cycle", () => {
			assert.throws(() => {
				mgr.createWorkflow({
					id: "cycle-2",
					name: "Cycle",
					gates: [
						gate("a", "A", ["b"]),
						gate("b", "B", ["a"]),
					],
				});
			}, /Circular dependency/);
		});

		it("rejects A → B → C → A cycle", () => {
			assert.throws(() => {
				mgr.createWorkflow({
					id: "cycle-3",
					name: "Cycle",
					gates: [
						gate("a", "A", ["c"]),
						gate("b", "B", ["a"]),
						gate("c", "C", ["b"]),
					],
				});
			}, /Circular dependency/);
		});

		it("rejects self-referencing gate", () => {
			assert.throws(() => {
				mgr.createWorkflow({
					id: "self-ref",
					name: "Self Ref",
					gates: [gate("a", "A", ["a"])],
				});
			}, /depends on itself/);
		});
	});

	// --- Duplicate gate IDs ---

	describe("duplicate gate IDs", () => {
		it("rejects duplicate gate IDs within a workflow", () => {
			assert.throws(() => {
				mgr.createWorkflow({
					id: "dup-gates",
					name: "Dup",
					gates: [
						gate("same", "Gate A"),
						gate("same", "Gate B"),
					],
				});
			}, /Duplicate gate ID/);
		});
	});

	// --- Unknown dependsOn ---

	describe("unknown dependsOn references", () => {
		it("rejects dependsOn referencing nonexistent gate", () => {
			assert.throws(() => {
				mgr.createWorkflow({
					id: "unknown-dep",
					name: "Unknown",
					gates: [gate("a", "A", ["nonexistent"])],
				});
			}, /unknown/);
		});
	});

	// --- Empty gates ---

	describe("empty gates", () => {
		it("rejects empty gates array", () => {
			assert.throws(() => {
				mgr.createWorkflow({
					id: "empty",
					name: "Empty",
					gates: [],
				});
			}, /at least one gate/);
		});
	});

	// --- Missing workflow fields ---

	describe("missing workflow fields", () => {
		it("rejects missing workflow name", () => {
			assert.throws(() => {
				mgr.createWorkflow({
					id: "no-name",
					name: "",
					gates: [gate("a", "A")],
				});
			}, /name/i);
		});

		it("rejects missing workflow id", () => {
			assert.throws(() => {
				mgr.createWorkflow({
					id: "",
					name: "No ID",
					gates: [gate("a", "A")],
				});
			}, /id/i);
		});

		it("rejects missing gate name", () => {
			assert.throws(() => {
				mgr.createWorkflow({
					id: "no-gate-name",
					name: "Test",
					gates: [{ id: "a", name: "", dependsOn: [] }],
				});
			}, /must have a name/);
		});
	});

	// --- ID pattern validation ---

	describe("ID pattern validation", () => {
		it("rejects uppercase workflow ID", () => {
			assert.throws(() => {
				mgr.createWorkflow({
					id: "MyWorkflow",
					name: "Test",
					gates: [gate("a", "A")],
				});
			}, /lowercase/);
		});

		it("rejects workflow ID with spaces", () => {
			assert.throws(() => {
				mgr.createWorkflow({
					id: "my workflow",
					name: "Test",
					gates: [gate("a", "A")],
				});
			}, /lowercase/);
		});

		it("rejects gate ID with uppercase", () => {
			assert.throws(() => {
				mgr.createWorkflow({
					id: "test-wf",
					name: "Test",
					gates: [{ id: "GateA", name: "Gate A", dependsOn: [] }],
				});
			}, /lowercase/);
		});

		it("accepts single-character ID", () => {
			const wf = mgr.createWorkflow({
				id: "a",
				name: "Single",
				gates: [gate("b", "B")],
			});
			assert.equal(wf.id, "a");
		});

		it("accepts alphanumeric-hyphens ID", () => {
			const wf = mgr.createWorkflow({
				id: "my-workflow-123",
				name: "Test",
				gates: [gate("a", "A")],
			});
			assert.equal(wf.id, "my-workflow-123");
		});
	});

	// --- Duplicate workflow ID ---

	describe("duplicate workflow ID", () => {
		it("rejects creating a workflow with an existing ID", () => {
			mgr.createWorkflow({
				id: "existing",
				name: "First",
				gates: [gate("a", "A")],
			});
			assert.throws(() => {
				mgr.createWorkflow({
					id: "existing",
					name: "Second",
					gates: [gate("a", "A")],
				});
			}, /already exists/);
		});
	});

	// --- CRUD operations ---

	describe("CRUD", () => {
		it("getWorkflow returns created workflow", () => {
			mgr.createWorkflow({
				id: "test",
				name: "Test",
				gates: [gate("a", "A")],
			});
			const wf = mgr.getWorkflow("test");
			assert.ok(wf);
			assert.equal(wf.name, "Test");
		});

		it("getWorkflow returns undefined for nonexistent", () => {
			assert.equal(mgr.getWorkflow("nope"), undefined);
		});

		it("listWorkflows returns all workflows", () => {
			mgr.createWorkflow({ id: "a", name: "A", gates: [gate("x", "X")] });
			mgr.createWorkflow({ id: "b", name: "B", gates: [gate("y", "Y")] });
			const list = mgr.listWorkflows();
			assert.equal(list.length, 2);
		});

		it("updateWorkflow changes name", () => {
			mgr.createWorkflow({ id: "test", name: "Old", gates: [gate("a", "A")] });
			const result = mgr.updateWorkflow("test", { name: "New" });
			assert.equal(result, true);
			assert.equal(mgr.getWorkflow("test")!.name, "New");
		});

		it("updateWorkflow returns false for nonexistent", () => {
			assert.equal(mgr.updateWorkflow("nope", { name: "X" }), false);
		});

		it("updateWorkflow validates new gates", () => {
			mgr.createWorkflow({ id: "test", name: "Test", gates: [gate("a", "A")] });
			assert.throws(() => {
				mgr.updateWorkflow("test", { gates: [] });
			}, /at least one gate/);
		});

		it("deleteWorkflow removes it", () => {
			mgr.createWorkflow({ id: "test", name: "Test", gates: [gate("a", "A")] });
			assert.equal(mgr.deleteWorkflow("test"), true);
			assert.equal(mgr.getWorkflow("test"), undefined);
		});

		it("deleteWorkflow returns false for nonexistent", () => {
			assert.equal(mgr.deleteWorkflow("nope"), false);
		});
	});

});
