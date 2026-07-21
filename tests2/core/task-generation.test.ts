import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { TaskStore, type PersistedTask } from "../../src/server/agent/task-store.ts";
import { ProjectContextManager } from "../../src/server/agent/project-context-manager.ts";
import { ProjectContext } from "../../src/server/agent/project-context.ts";

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

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
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

	it("never reuses a token across context removal and same-id re-addition", async () => {
		const firstContext = fakeContext("alpha", [task("persisted")]);
		const manager = contextManager([firstContext]);
		firstContext.taskStore.put(task("new"));
		const beforeRemove = manager.getTaskGeneration();

		await manager.remove("alpha");
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

describe("ProjectContext lifecycle barriers", () => {
	it("close awaits stopSweep before flushing or closing later resources", async () => {
		const sweepGate = deferred<void>();
		const order: string[] = [];
		const context: any = Object.create(ProjectContext.prototype);
		context.planMutationStore = {
			stopSweep: async () => {
				order.push("stopSweep:start");
				await sweepGate.promise;
				order.push("stopSweep:end");
			},
		};
		context.sessionStore = { flush: () => { order.push("session:flush"); } };
		context.costTracker = { flush: () => { order.push("cost:flush"); } };
		context.bgProcessStore = { flush: () => { order.push("bg:flush"); } };
		context.searchIndex = { close: async () => { order.push("search:close"); } };

		let closeSettled = false;
		const closing = ProjectContext.prototype.close.call(context).then(() => { closeSettled = true; });
		assert.deepEqual(order, ["stopSweep:start"]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(closeSettled, false);
		assert.deepEqual(order, ["stopSweep:start"], "no later resource closes before the sweep barrier");

		sweepGate.resolve(undefined);
		await closing;
		assert.deepEqual(order, [
			"stopSweep:start",
			"stopSweep:end",
			"session:flush",
			"cost:flush",
			"bg:flush",
			"search:close",
		]);
	});

	it("ProjectContextManager.remove keeps the context visible until close settles", async () => {
		const closeGate = deferred<void>();
		const context = fakeContext("alpha");
		const order: string[] = [];
		let closeCalls = 0;
		context.close = async () => {
			closeCalls++;
			order.push("close:start");
			await closeGate.promise;
			order.push("close:end");
		};
		const manager = contextManager([context]);
		const topologyBefore = manager.contextTopologyVersion;

		let removeSettled = false;
		const removing = manager.remove("alpha").then(() => { removeSettled = true; });
		assert.equal(closeCalls, 1);
		assert.equal(manager.contexts.has("alpha"), true);
		assert.equal(manager.contextTopologyVersion, topologyBefore);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(removeSettled, false);

		closeGate.resolve(undefined);
		await removing;
		assert.deepEqual(order, ["close:start", "close:end"]);
		assert.equal(manager.contexts.has("alpha"), false);
		assert.equal(manager.contextTopologyVersion, topologyBefore + 1);

		await manager.remove("alpha");
		assert.equal(closeCalls, 1, "removing an absent context is idempotent");
		assert.equal(manager.contextTopologyVersion, topologyBefore + 1);
	});
});
