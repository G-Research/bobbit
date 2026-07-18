import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { TaskStore, type PersistedTask } from "../../src/server/agent/task-store.ts";
import { ProjectContextManager } from "../../src/server/agent/project-context-manager.ts";

function task(id: string, assignedSessionId?: string): PersistedTask {
	return {
		id,
		goalId: "goal-1",
		title: id,
		type: "implementation",
		state: "todo",
		assignedSessionId,
		createdAt: 1,
		updatedAt: 1,
	};
}

function inMemoryTaskStore(initial: PersistedTask[] = []): TaskStore {
	const store: any = Object.create(TaskStore.prototype);
	store.tasks = new Map(initial.map((value) => [value.id, value]));
	store.generation = 0;
	store.save = () => {};
	return store;
}

function fakeContext(id: string, initialTasks: PersistedTask[] = []) {
	return {
		project: { id },
		taskStore: inMemoryTaskStore(initialTasks),
		close: async () => {},
	};
}

function contextManager(initialContexts: any[] = []): any {
	const manager: any = Object.create(ProjectContextManager.prototype);
	manager.contexts = new Map(initialContexts.map((ctx) => [ctx.project.id, ctx]));
	manager.contextTopologyVersion = initialContexts.length;
	manager.taskGenerationToken = 0;
	manager.lastObservedTaskGenerationSum = 0;
	manager.lastObservedTaskTopologyVersion = 0;
	return manager;
}

function addContext(manager: any, context: any): void {
	manager.contexts.set(context.project.id, context);
	manager.contextTopologyVersion++;
}

describe("TaskStore mutation generation", () => {
	it("starts at zero for loaded rows and advances once per mutation path", () => {
		const store = inMemoryTaskStore([task("loaded")]);

		assert.equal(store.getGeneration(), 0, "loading persisted rows must not count as a mutation");
		store.put(task("put"));
		assert.equal(store.getGeneration(), 1);
		store.remove("put");
		assert.equal(store.getGeneration(), 2);
		store.removeMany(["loaded"]);
		assert.equal(store.getGeneration(), 3);
		store.removeMany([]);
		assert.equal(store.getGeneration(), 3, "an empty bulk removal performs no mutation");
	});
});

describe("ProjectContextManager task generation token", () => {
	it("is stable without changes and advances after task assignment mutations", () => {
		const ctx = fakeContext("alpha");
		const manager = contextManager([ctx]);
		const initial = manager.getTaskGeneration();

		assert.equal(manager.getTaskGeneration(), initial);
		ctx.taskStore.put(task("assigned", "session-1"));
		const afterPut = manager.getTaskGeneration();
		assert.ok(afterPut > initial);
		assert.equal(manager.getTaskGeneration(), afterPut);
	});

	it("advances when adding a zero-generation context with loaded tasks", () => {
		const manager = contextManager([fakeContext("alpha")]);
		const beforeAdd = manager.getTaskGeneration();
		const beta = fakeContext("beta", [task("persisted", "session-2")]);

		addContext(manager, beta);

		assert.equal(beta.taskStore.getGeneration(), 0);
		assert.ok(beta.taskStore.get("persisted"));
		assert.ok(manager.getTaskGeneration() > beforeAdd, "topology must invalidate even when the raw generation sum is unchanged");
	});

	it("never reuses a token across context removal and same-id re-addition", () => {
		const firstContext = fakeContext("alpha", [task("persisted")]);
		const manager = contextManager([firstContext]);
		firstContext.taskStore.put(task("new"));
		const beforeRemove = manager.getTaskGeneration();

		manager.remove("alpha");
		const afterRemove = manager.getTaskGeneration();
		assert.ok(afterRemove > beforeRemove);

		const replacement = fakeContext("alpha", [task("persisted")]);
		addContext(manager, replacement);
		assert.equal(replacement.taskStore.getGeneration(), 0, "a replacement context has a fresh local generation");
		assert.ok(replacement.taskStore.get("persisted"));
		assert.ok(manager.getTaskGeneration() > afterRemove, "same-id re-addition must receive a fresh aggregate token");
	});

	it("advances when closeAll removes the initialized topology", async () => {
		const manager = contextManager([fakeContext("alpha")]);
		const beforeClose = manager.getTaskGeneration();

		await manager.closeAll();
		assert.ok(manager.getTaskGeneration() > beforeClose);
	});
});
