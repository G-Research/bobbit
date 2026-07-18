import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, it } from "vitest";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";
import type { PersistedTask } from "../../src/server/agent/task-store.ts";

const suiteRoot = makeTmpDir("task-generation-");
process.env.BOBBIT_DIR = path.join(suiteRoot, "bobbit-home");
fs.mkdirSync(process.env.BOBBIT_DIR, { recursive: true });

const { TaskStore } = await import("../../src/server/agent/task-store.ts");
const { ProjectRegistry } = await import("../../src/server/agent/project-registry.ts");
const { ProjectContextManager } = await import("../../src/server/agent/project-context-manager.ts");

type ContextManager = InstanceType<typeof ProjectContextManager>;
const contextManagers: ContextManager[] = [];

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

function makeContextManager(projectNames: string[]): {
	manager: ContextManager;
	projects: Map<string, { id: string; rootPath: string }>;
} {
	const registryDir = makeTmpDir("task-generation-registry-");
	const registry = new ProjectRegistry(registryDir);
	const projects = new Map<string, { id: string; rootPath: string }>();
	for (const name of projectNames) {
		const rootPath = makeTmpDir(`task-generation-${name}-`);
		const registered = registry.register(name, rootPath);
		projects.set(name, { id: registered.id, rootPath });
	}
	const manager = new ProjectContextManager(registry);
	contextManagers.push(manager);
	return { manager, projects };
}

afterAll(async () => {
	await Promise.allSettled(contextManagers.map((manager) => manager.closeAll()));
	// remove() closes its detached context asynchronously; let those close jobs
	// settle before deleting shared test state.
	await new Promise((resolve) => setTimeout(resolve, 20));
	try { fs.rmSync(suiteRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("TaskStore mutation generation", () => {
	it("starts at zero after load and advances once per mutation path", () => {
		const stateDir = makeTmpDir("task-store-generation-");
		fs.writeFileSync(path.join(stateDir, "tasks.json"), JSON.stringify([task("loaded")]));
		const store = new TaskStore(stateDir);

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
		const { manager, projects } = makeContextManager(["alpha"]);
		const ctx = manager.getOrCreate(projects.get("alpha")!.id)!;
		const initial = manager.getTaskGeneration();

		assert.equal(manager.getTaskGeneration(), initial);
		ctx.taskStore.put(task("assigned", "session-1"));
		const afterPut = manager.getTaskGeneration();
		assert.ok(afterPut > initial);
		assert.equal(manager.getTaskGeneration(), afterPut);
	});

	it("advances when adding a zero-generation context with persisted tasks", () => {
		const { manager, projects } = makeContextManager(["alpha", "beta"]);
		manager.getOrCreate(projects.get("alpha")!.id);
		const beforeAdd = manager.getTaskGeneration();

		const beta = projects.get("beta")!;
		const betaStateDir = path.join(beta.rootPath, ".bobbit", "state");
		fs.mkdirSync(betaStateDir, { recursive: true });
		fs.writeFileSync(path.join(betaStateDir, "tasks.json"), JSON.stringify([task("persisted", "session-2")]));
		const betaContext = manager.getOrCreate(beta.id)!;

		assert.equal(betaContext.taskStore.getGeneration(), 0);
		assert.ok(betaContext.taskStore.get("persisted"));
		assert.ok(manager.getTaskGeneration() > beforeAdd, "topology must invalidate even when the raw generation sum is unchanged");
	});

	it("never reuses a token across context removal and same-id re-addition", () => {
		const { manager, projects } = makeContextManager(["alpha"]);
		const projectId = projects.get("alpha")!.id;
		const firstContext = manager.getOrCreate(projectId)!;
		firstContext.taskStore.put(task("persisted"));
		const beforeRemove = manager.getTaskGeneration();

		manager.remove(projectId);
		const afterRemove = manager.getTaskGeneration();
		assert.ok(afterRemove > beforeRemove);

		const replacement = manager.getOrCreate(projectId)!;
		assert.equal(replacement.taskStore.getGeneration(), 0, "a replacement context reloads with a fresh local generation");
		assert.ok(replacement.taskStore.get("persisted"));
		const afterReAdd = manager.getTaskGeneration();
		assert.ok(afterReAdd > afterRemove, "same-id re-addition must receive a fresh aggregate token");
	});

	it("advances when closeAll removes the initialized topology", async () => {
		const { manager, projects } = makeContextManager(["alpha"]);
		manager.getOrCreate(projects.get("alpha")!.id);
		const beforeClose = manager.getTaskGeneration();

		await manager.closeAll();
		assert.ok(manager.getTaskGeneration() > beforeClose);
	});
});
