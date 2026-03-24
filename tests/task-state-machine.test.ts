/**
 * Unit tests for TaskManager state machine, sub-task logic, and dependency cycles.
 * Uses BOBBIT_DIR temp dir for isolated TaskStore.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate from real state
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "task-sm-test-"));
process.env.BOBBIT_DIR = TEST_DIR;

const TASKS_FILE = path.join(TEST_DIR, "state", "tasks.json");

function clearTasks() {
	try { fs.unlinkSync(TASKS_FILE); } catch { /* ignore */ }
}

function ensureStateDir() {
	fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });
	fs.writeFileSync(TASKS_FILE, "[]", "utf-8");
}

// Import after env var is set
const { TaskManager } = await import("../src/server/agent/task-manager.ts");

describe("TaskManager State Machine", () => {
	let mgr: InstanceType<typeof TaskManager>;

	beforeEach(() => {
		ensureStateDir();
		mgr = new TaskManager();
	});

	afterEach(() => {
		clearTasks();
	});

	// --- Valid transitions ---

	describe("valid state transitions", () => {
		it("todo → in-progress", () => {
			const task = mgr.createTask("g1", "Task", "implementation");
			assert.equal(task.state, "todo");
			mgr.updateTask(task.id, { state: "in-progress" });
			assert.equal(mgr.getTask(task.id)!.state, "in-progress");
		});

		it("todo → skipped", () => {
			const task = mgr.createTask("g1", "Task", "implementation");
			mgr.updateTask(task.id, { state: "skipped" });
			assert.equal(mgr.getTask(task.id)!.state, "skipped");
			assert.ok(mgr.getTask(task.id)!.completedAt);
		});

		it("in-progress → complete", () => {
			const task = mgr.createTask("g1", "Task", "implementation");
			mgr.updateTask(task.id, { state: "in-progress" });
			mgr.updateTask(task.id, { state: "complete" });
			assert.equal(mgr.getTask(task.id)!.state, "complete");
			assert.ok(mgr.getTask(task.id)!.completedAt);
		});

		it("in-progress → blocked", () => {
			const task = mgr.createTask("g1", "Task", "implementation");
			mgr.updateTask(task.id, { state: "in-progress" });
			mgr.updateTask(task.id, { state: "blocked" });
			assert.equal(mgr.getTask(task.id)!.state, "blocked");
		});

		it("in-progress → todo", () => {
			const task = mgr.createTask("g1", "Task", "implementation");
			mgr.updateTask(task.id, { state: "in-progress" });
			mgr.updateTask(task.id, { state: "todo" });
			assert.equal(mgr.getTask(task.id)!.state, "todo");
		});

		it("blocked → in-progress", () => {
			const task = mgr.createTask("g1", "Task", "implementation");
			mgr.updateTask(task.id, { state: "in-progress" });
			mgr.updateTask(task.id, { state: "blocked" });
			mgr.updateTask(task.id, { state: "in-progress" });
			assert.equal(mgr.getTask(task.id)!.state, "in-progress");
		});

		it("blocked → skipped", () => {
			const task = mgr.createTask("g1", "Task", "implementation");
			mgr.updateTask(task.id, { state: "in-progress" });
			mgr.updateTask(task.id, { state: "blocked" });
			mgr.updateTask(task.id, { state: "skipped" });
			assert.equal(mgr.getTask(task.id)!.state, "skipped");
		});
	});

	// --- Invalid transitions ---

	describe("invalid state transitions", () => {
		it("complete → in-progress throws", () => {
			const task = mgr.createTask("g1", "Task", "impl");
			mgr.updateTask(task.id, { state: "in-progress" });
			mgr.updateTask(task.id, { state: "complete" });
			assert.throws(() => {
				mgr.updateTask(task.id, { state: "in-progress" });
			}, /Invalid state transition/);
		});

		it("complete → todo throws", () => {
			const task = mgr.createTask("g1", "Task", "impl");
			mgr.updateTask(task.id, { state: "in-progress" });
			mgr.updateTask(task.id, { state: "complete" });
			assert.throws(() => {
				mgr.updateTask(task.id, { state: "todo" });
			}, /Invalid state transition/);
		});

		it("skipped → in-progress throws", () => {
			const task = mgr.createTask("g1", "Task", "impl");
			mgr.updateTask(task.id, { state: "skipped" });
			assert.throws(() => {
				mgr.updateTask(task.id, { state: "in-progress" });
			}, /Invalid state transition/);
		});

		it("todo → complete throws (must go through in-progress)", () => {
			const task = mgr.createTask("g1", "Task", "impl");
			assert.throws(() => {
				mgr.updateTask(task.id, { state: "complete" });
			}, /Invalid state transition/);
		});

		it("todo → blocked throws", () => {
			const task = mgr.createTask("g1", "Task", "impl");
			assert.throws(() => {
				mgr.updateTask(task.id, { state: "blocked" });
			}, /Invalid state transition/);
		});
	});

	// --- Sub-task completion gating ---

	describe("sub-task completion gating", () => {
		it("cannot complete parent with incomplete sub-tasks", () => {
			const parent = mgr.createTask("g1", "Parent", "impl");
			mgr.createTask("g1", "Child", "impl", { parentTaskId: parent.id });
			mgr.updateTask(parent.id, { state: "in-progress" });
			assert.throws(() => {
				mgr.updateTask(parent.id, { state: "complete" });
			}, /sub-task.*incomplete/i);
		});

		it("can complete parent when all sub-tasks are complete", () => {
			const parent = mgr.createTask("g1", "Parent", "impl");
			const child = mgr.createTask("g1", "Child", "impl", { parentTaskId: parent.id });
			mgr.updateTask(parent.id, { state: "in-progress" });
			mgr.updateTask(child.id, { state: "in-progress" });
			mgr.updateTask(child.id, { state: "complete" });
			mgr.updateTask(parent.id, { state: "complete" });
			assert.equal(mgr.getTask(parent.id)!.state, "complete");
		});

		it("can complete parent when sub-tasks are skipped", () => {
			const parent = mgr.createTask("g1", "Parent", "impl");
			const child = mgr.createTask("g1", "Child", "impl", { parentTaskId: parent.id });
			mgr.updateTask(parent.id, { state: "in-progress" });
			mgr.updateTask(child.id, { state: "skipped" });
			mgr.updateTask(parent.id, { state: "complete" });
			assert.equal(mgr.getTask(parent.id)!.state, "complete");
		});
	});

	// --- Sub-task depth limit ---

	describe("sub-task depth limit", () => {
		it("rejects sub-tasks of sub-tasks (max 1 level)", () => {
			const parent = mgr.createTask("g1", "Parent", "impl");
			const child = mgr.createTask("g1", "Child", "impl", { parentTaskId: parent.id });
			assert.throws(() => {
				mgr.createTask("g1", "Grandchild", "impl", { parentTaskId: child.id });
			}, /cannot have sub-tasks/i);
		});

		it("rejects nonexistent parent", () => {
			assert.throws(() => {
				mgr.createTask("g1", "Child", "impl", { parentTaskId: "nonexistent" });
			}, /not found/);
		});

		it("rejects cross-goal sub-task", () => {
			const parent = mgr.createTask("g1", "Parent", "impl");
			assert.throws(() => {
				mgr.createTask("g2", "Child", "impl", { parentTaskId: parent.id });
			}, /same goal/);
		});
	});

	// --- assignTask ---

	describe("assignTask", () => {
		it("auto-transitions todo → in-progress", () => {
			const task = mgr.createTask("g1", "Task", "impl");
			mgr.assignTask(task.id, "session-1");
			const t = mgr.getTask(task.id)!;
			assert.equal(t.state, "in-progress");
			assert.equal(t.assignedSessionId, "session-1");
		});

		it("auto-transitions parent when sub-task starts", () => {
			const parent = mgr.createTask("g1", "Parent", "impl");
			const child = mgr.createTask("g1", "Child", "impl", { parentTaskId: parent.id });
			mgr.assignTask(child.id, "session-1");
			assert.equal(mgr.getTask(parent.id)!.state, "in-progress");
			assert.equal(mgr.getTask(child.id)!.state, "in-progress");
		});

		it("does not change state if already in-progress", () => {
			const task = mgr.createTask("g1", "Task", "impl");
			mgr.updateTask(task.id, { state: "in-progress" });
			mgr.assignTask(task.id, "session-2");
			assert.equal(mgr.getTask(task.id)!.state, "in-progress");
			assert.equal(mgr.getTask(task.id)!.assignedSessionId, "session-2");
		});

		it("returns false for nonexistent task", () => {
			assert.equal(mgr.assignTask("nonexistent", "session-1"), false);
		});
	});

	// --- Dependency cycle detection ---

	describe("dependency cycle detection", () => {
		it("rejects direct circular dependency A → B → A", () => {
			const a = mgr.createTask("g1", "A", "impl");
			const b = mgr.createTask("g1", "B", "impl", { dependsOn: [a.id] });
			assert.throws(() => {
				mgr.updateTask(a.id, { dependsOn: [b.id] });
			}, /Circular dependency/);
		});

		it("rejects transitive circular dependency A → B → C → A", () => {
			const a = mgr.createTask("g1", "A", "impl");
			const b = mgr.createTask("g1", "B", "impl", { dependsOn: [a.id] });
			const c = mgr.createTask("g1", "C", "impl", { dependsOn: [b.id] });
			assert.throws(() => {
				mgr.updateTask(a.id, { dependsOn: [c.id] });
			}, /Circular dependency/);
		});
	});

	// --- Dependency reference validation ---

	describe("dependency validation", () => {
		it("rejects dependsOn referencing nonexistent task", () => {
			assert.throws(() => {
				mgr.createTask("g1", "Task", "impl", { dependsOn: ["nonexistent"] });
			}, /not found/);
		});

		it("deduplicates dependsOn", () => {
			const a = mgr.createTask("g1", "A", "impl");
			const b = mgr.createTask("g1", "B", "impl", { dependsOn: [a.id, a.id, a.id] });
			assert.equal(b.dependsOn!.length, 1);
		});

		it("self-references in dependsOn are removed on update", () => {
			const a = mgr.createTask("g1", "A", "impl");
			const b = mgr.createTask("g1", "B", "impl");
			mgr.updateTask(b.id, { dependsOn: [a.id, b.id] });
			const updated = mgr.getTask(b.id)!;
			assert.ok(!updated.dependsOn!.includes(b.id));
			assert.ok(updated.dependsOn!.includes(a.id));
		});
	});

	// --- Task creation ---

	describe("createTask", () => {
		it("creates with correct defaults", () => {
			const task = mgr.createTask("g1", "Test Task", "implementation");
			assert.ok(task.id);
			assert.equal(task.goalId, "g1");
			assert.equal(task.title, "Test Task");
			assert.equal(task.type, "implementation");
			assert.equal(task.state, "todo");
			assert.ok(task.createdAt);
			assert.ok(task.updatedAt);
		});

		it("accepts any task type string", () => {
			const task = mgr.createTask("g1", "Custom", "my-custom-type");
			assert.equal(task.type, "my-custom-type");
		});

		it("accepts spec and workflowGateId", () => {
			const task = mgr.createTask("g1", "Task", "impl", {
				spec: "Build it",
				workflowGateId: "implementation",
			});
			assert.equal(task.spec, "Build it");
			assert.equal(task.workflowGateId, "implementation");
		});
	});

	// --- transitionTask ---

	describe("transitionTask", () => {
		it("transitions todo → in-progress", () => {
			const task = mgr.createTask("g1", "Task", "impl");
			mgr.transitionTask(task.id, "in-progress");
			assert.equal(mgr.getTask(task.id)!.state, "in-progress");
		});

		it("returns false for nonexistent task", () => {
			assert.equal(mgr.transitionTask("nonexistent", "in-progress"), false);
		});

		it("throws for invalid transition", () => {
			const task = mgr.createTask("g1", "Task", "impl");
			assert.throws(() => {
				mgr.transitionTask(task.id, "complete");
			}, /Invalid state transition/);
		});
	});

	// --- completeTask ---

	describe("completeTask", () => {
		it("sets completedAt timestamp", () => {
			const task = mgr.createTask("g1", "Task", "impl");
			mgr.updateTask(task.id, { state: "in-progress" });
			const before = Date.now();
			mgr.completeTask(task.id);
			const t = mgr.getTask(task.id)!;
			assert.equal(t.state, "complete");
			assert.ok(t.completedAt! >= before);
		});

		it("returns false for nonexistent task", () => {
			assert.equal(mgr.completeTask("nonexistent"), false);
		});
	});

	// --- deleteTask ---

	describe("deleteTask", () => {
		it("cascades to delete sub-tasks", () => {
			const parent = mgr.createTask("g1", "Parent", "impl");
			const child1 = mgr.createTask("g1", "Child 1", "impl", { parentTaskId: parent.id });
			const child2 = mgr.createTask("g1", "Child 2", "impl", { parentTaskId: parent.id });
			mgr.deleteTask(parent.id);
			assert.equal(mgr.getTask(parent.id), undefined);
			assert.equal(mgr.getTask(child1.id), undefined);
			assert.equal(mgr.getTask(child2.id), undefined);
		});

		it("returns false for nonexistent task", () => {
			assert.equal(mgr.deleteTask("nonexistent"), false);
		});
	});

	// --- deleteTasksForGoal ---

	describe("deleteTasksForGoal", () => {
		it("removes all tasks for a goal", () => {
			mgr.createTask("g1", "A", "impl");
			mgr.createTask("g1", "B", "impl");
			mgr.createTask("g2", "C", "impl");
			mgr.deleteTasksForGoal("g1");
			assert.equal(mgr.getTasksForGoal("g1").length, 0);
			assert.equal(mgr.getTasksForGoal("g2").length, 1);
		});
	});
});

// Cleanup temp dir
import { after } from "node:test";
after(() => {
	try { fs.rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
});
