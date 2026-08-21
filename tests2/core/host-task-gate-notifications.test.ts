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
import { HostNotificationDispatcher } from "../../src/server/extension-host/host-notification-dispatcher.js";
import type { HostNotification } from "../../src/shared/extension-host/host-hooks.js";
import { createMemFs } from "../harness/mem-fs.js";

function captureDispatchedTasks(store: TaskStore): {
	notifications: HostNotification[];
	dispatcher: HostNotificationDispatcher;
} {
	const notifications: HostNotification[] = [];
	let nextId = 0;
	const dispatcher = new HostNotificationDispatcher({
		idGenerator: () => `task-notification-${++nextId}`,
		now: () => 1_000,
	});
	store.onCommittedFact = fact => {
		const common = {
			projectId: "project-a",
			aggregateId: fact.taskId,
			aggregateRevision: fact.revision,
		};
		let notification: HostNotification | undefined;
		switch (fact.kind) {
			case "taskCreated":
				notification = dispatcher.publish("taskCreated", { ...common, payload: {
					taskId: fact.taskId,
					goalId: fact.goalId,
					type: fact.type,
					state: fact.state,
					...(fact.parentTaskId ? { parentTaskId: fact.parentTaskId } : {}),
				} });
				break;
			case "taskUpdated":
				notification = dispatcher.publish("taskUpdated", { ...common, payload: {
					taskId: fact.taskId,
					goalId: fact.goalId,
					state: fact.state,
					changedFields: fact.changedFields,
				} });
				break;
			case "taskStateChanged":
				notification = dispatcher.publish("taskStateChanged", { ...common, payload: {
					taskId: fact.taskId,
					goalId: fact.goalId,
					previousState: fact.previousState,
					state: fact.state,
				} });
				break;
		}
		if (notification) notifications.push(notification);
	};
	return { notifications, dispatcher };
}

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

	it("omits baseSha and branch while the real dispatcher accepts internal-only task updates", async () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/host-task-public-projection");
		memfs.mkdirSync(stateDir, { recursive: true });
		const store = new TaskStore(stateDir, memfs, { persistence: "json" });
		const manager = new TaskManager(store);
		const { notifications, dispatcher } = captureDispatchedTasks(store);
		const task = manager.createTask("goal-1", "Task", "implementation");
		await store.flush();
		notifications.length = 0;

		manager.updateTask(task.id, {
			title: "Public title",
			spec: "private task body",
			baseSha: "private-base-sha",
			branch: "private-checkout-branch",
			headSha: "public-head-sha",
		});
		await store.flush();
		manager.updateTask(task.id, {
			baseSha: "next-private-base-sha",
			branch: "next-private-checkout-branch",
		});
		await store.flush();

		expect(notifications.map(notification => notification.payload)).toEqual([
			{ taskId: task.id, goalId: "goal-1", state: "todo", changedFields: ["headSha", "spec", "title"] },
			{ taskId: task.id, goalId: "goal-1", state: "todo", changedFields: [] },
		]);
		expect(JSON.stringify(notifications)).not.toContain("baseSha");
		expect(JSON.stringify(notifications)).not.toContain("branch");
		expect(JSON.stringify(notifications)).not.toContain("private-checkout");
		expect(JSON.stringify(notifications)).not.toContain("private task body");
		expect(dispatcher.getDiagnostics().filter(row => row.code === "invalid_payload")).toEqual([]);
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
