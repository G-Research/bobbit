import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { GateStore, type GateStatusCommit } from "../../src/server/agent/gate-store.js";
import { TaskManager } from "../../src/server/agent/task-manager.js";
import {
	TaskStore,
	type PersistedTask,
	type TaskCommittedFact,
} from "../../src/server/agent/task-store.js";
import type { Workflow } from "../../src/server/agent/workflow-store.js";
import { createMemFs } from "../harness/mem-fs.js";

function workflow(): Workflow {
	return {
		id: "workflow",
		name: "Workflow",
		description: "",
		createdAt: 0,
		updatedAt: 0,
		gates: [
			{ id: "root", name: "Root", dependsOn: [] },
			{ id: "child", name: "Child", dependsOn: ["root"] },
		],
	};
}

describe("task committed facts", () => {
	it("publishes bounded facts after persistence, suppresses no-ops, and reports automatic parent transitions", async () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/host-task-facts");
		memfs.mkdirSync(stateDir, { recursive: true });
		const store = new TaskStore(stateDir, memfs, { persistence: "json" });
		const manager = new TaskManager(store);
		const facts: TaskCommittedFact[] = [];
		store.onCommittedFact = fact => facts.push(fact as TaskCommittedFact);

		const parent = manager.createTask("goal-1", "Parent", "implementation");
		const child = manager.createTask("goal-1", "Child", "testing", { parentTaskId: parent.id });
		expect(facts).toEqual([]);
		await store.flush();
		expect(facts.map(fact => fact.kind)).toEqual(["taskCreated", "taskCreated"]);

		facts.length = 0;
		const parentRevisionBefore = parent.updatedAt;
		const childRevisionBefore = child.updatedAt;
		expect(manager.updateTask(parent.id, { title: parent.title, state: parent.state })).toBe(true);
		expect(parent.updatedAt).toBe(parentRevisionBefore);
		manager.assignTask(child.id, "session-1");
		expect(facts).toEqual([]);
		await store.flush();

		expect(facts).toEqual([
			expect.objectContaining({
				kind: "taskUpdated", taskId: child.id, goalId: "goal-1",
				state: "in-progress", changedFields: ["assignedSessionId"],
			}),
			expect.objectContaining({
				kind: "taskStateChanged", taskId: child.id, previousState: "todo", state: "in-progress",
			}),
			expect.objectContaining({
				kind: "taskStateChanged", taskId: parent.id, previousState: "todo", state: "in-progress",
			}),
		]);
		expect(child.updatedAt).toBeGreaterThan(childRevisionBefore);
		expect(parent.updatedAt).toBeGreaterThan(parentRevisionBefore);
		expect(facts.every(fact => fact.revision === (fact.taskId === child.id ? child.updatedAt : parent.updatedAt))).toBe(true);

		facts.length = 0;
		manager.assignTask(child.id, "session-1");
		await store.flush();
		expect(facts).toEqual([]);
	});

	it("does not report a fact when the strict publication fails", async () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/host-task-fact-failure");
		memfs.mkdirSync(stateDir, { recursive: true });
		const store = new TaskStore(stateDir, memfs, { persistence: "json" });
		const facts: TaskCommittedFact[] = [];
		store.onCommittedFact = fact => facts.push(fact as TaskCommittedFact);
		const task: PersistedTask = {
			id: "task-1", goalId: "goal-1", title: "Task", type: "testing", state: "todo",
			createdAt: 1, updatedAt: 1,
		};
		const originalRename = memfs.promises.rename.bind(memfs.promises);
		(memfs.promises as typeof memfs.promises & { rename: typeof memfs.promises.rename }).rename = vi.fn(async () => {
			throw new Error("TASK_FACT_PERSISTENCE_FAILED");
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(store.putCommitted(task, [{
			kind: "taskCreated", taskId: task.id, goalId: task.goalId,
			type: task.type, state: task.state, revision: task.updatedAt,
		}])).rejects.toThrow("TASK_FACT_PERSISTENCE_FAILED");
		expect(facts).toEqual([]);
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
		(memfs.promises as typeof memfs.promises & { rename: typeof memfs.promises.rename }).rename = originalRename;
	});
});

describe("gate committed status facts", () => {
	it("centralizes real persisted transitions with a stable monotonic revision", async () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/host-gate-facts");
		memfs.mkdirSync(stateDir, { recursive: true });
		const store = new GateStore(stateDir, memfs, { persistence: "json" });
		const commits: GateStatusCommit[] = [];
		store.onStatusCommitted = commit => commits.push(commit as GateStatusCommit);
		store.initGatesForGoal("goal-1", ["root", "child"]);
		await store.flush();

		store.recordSignal({
			id: "signal-1", gateId: "root", goalId: "goal-1", sessionId: "session-1",
			timestamp: 1, commitSha: "abc", verification: { status: "running", steps: [] },
		});
		store.updateGateStatus("goal-1", "root", "passed");
		expect(commits).toEqual([]);
		await store.flush();
		expect(commits).toEqual([{
			goalId: "goal-1", gateId: "root", previousStatus: "pending", status: "passed", revision: 1,
		}]);

		store.updateGateStatus("goal-1", "root", "passed");
		await store.flush();
		expect(commits).toHaveLength(1);

		store.updateGateStatus("goal-1", "child", "passed");
		await store.flush();
		store.cascadeReset("goal-1", "root", workflow());
		await store.flush();
		expect(commits.at(-1)).toEqual({
			goalId: "goal-1", gateId: "child", previousStatus: "passed", status: "pending", revision: 2,
		});

		store.bypassGate("goal-1", "root", { whyBypassed: "approved", whoAmI: "reviewer" });
		await store.flush();
		expect(commits.at(-1)).toEqual({
			goalId: "goal-1", gateId: "root", previousStatus: "passed", status: "bypassed", revision: 2,
		});

		store.reconcileGatesForGoal("goal-1", ["root", "child"], ["root"]);
		await store.flush();
		expect(commits.at(-1)).toEqual({
			goalId: "goal-1", gateId: "root", previousStatus: "bypassed", status: "pending", revision: 3,
		});

		const reopened = new GateStore(stateDir, memfs, { persistence: "json" });
		expect(reopened.getGate("goal-1", "root")?.statusRevision).toBe(3);
		expect(reopened.getGate("goal-1", "child")?.statusRevision).toBe(2);
	});

	it("holds restored in-memory reset facts until the strict recovery fence commits", async () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/host-gate-reset-facts");
		memfs.mkdirSync(stateDir, { recursive: true });
		const store = new GateStore(stateDir, memfs, { persistence: "json" });
		const commits: GateStatusCommit[] = [];
		store.onStatusCommitted = commit => commits.push(commit as GateStatusCommit);
		store.initGatesForGoal("goal-1", ["root", "child"]);
		store.updateGateStatus("goal-1", "root", "passed");
		store.updateGateStatus("goal-1", "child", "passed");
		await store.flush();
		commits.length = 0;

		await store.resetGateAndDependentsInMemory("goal-1", "root", workflow());
		expect(commits).toEqual([]);
		await store.resetGateAndDependentsStrict("goal-1", "root", workflow());
		expect(commits).toEqual([
			{ goalId: "goal-1", gateId: "root", previousStatus: "passed", status: "pending", revision: 2 },
			{ goalId: "goal-1", gateId: "child", previousStatus: "passed", status: "pending", revision: 2 },
		]);
	});
});
