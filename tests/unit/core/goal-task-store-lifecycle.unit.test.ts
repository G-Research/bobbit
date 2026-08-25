import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { ProjectContext } from "../../../src/server/agent/project-context.js";
import { ProjectContextManager } from "../../../src/server/agent/project-context-manager.js";
import { recoverPreMigrationData } from "../../../src/server/agent/state-migration.js";

const roots: string[] = [];

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-store-lifecycle-"));
	roots.push(root);
	return root;
}

function managerWith(contexts: Array<{ project: { id: string }; close: () => Promise<void> }>): any {
	const manager: any = Object.create(ProjectContextManager.prototype);
	manager.contexts = new Map(contexts.map((context) => [context.project.id, context]));
	manager.contextTopologyVersion = contexts.length;
	return manager;
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Goal/Task native store lifecycle", () => {
	it("keeps generic pre-migration recovery away from store-owned goal/task sources", () => {
		const stateDir = tempRoot();
		const goalRecovery = path.join(stateDir, "goals.json.pre-migration");
		const taskRecovery = path.join(stateDir, "tasks.json.pre-migration");
		const sessionRecovery = path.join(stateDir, "sessions.json.pre-migration");
		const tombstoneFile = path.join(stateDir, ".deletion-tombstones.json");
		const goalBytes = JSON.stringify([{ id: "goal-old", title: "historical" }]);
		const taskBytes = JSON.stringify([{ id: "task-old", goalId: "goal-old" }]);
		const tombstoneBytes = JSON.stringify({ "goals.json": ["goal-deleted"] });
		fs.writeFileSync(goalRecovery, goalBytes);
		fs.writeFileSync(taskRecovery, taskBytes);
		fs.writeFileSync(sessionRecovery, JSON.stringify([{ id: "session-old" }]));
		fs.writeFileSync(tombstoneFile, tombstoneBytes);

		recoverPreMigrationData(stateDir);

		assert.equal(fs.existsSync(path.join(stateDir, "goals.json")), false);
		assert.equal(fs.existsSync(path.join(stateDir, "tasks.json")), false);
		assert.equal(fs.readFileSync(goalRecovery, "utf8"), goalBytes);
		assert.equal(fs.readFileSync(taskRecovery, "utf8"), taskBytes);
		assert.equal(fs.readFileSync(tombstoneFile, "utf8"), tombstoneBytes);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "sessions.json"), "utf8")), [{ id: "session-old" }]);
	});

	it("shares one idempotent context close and attempts every resource after failures", async () => {
		const calls: string[] = [];
		const goalError = new Error("goal close failed");
		const gateError = new Error("gate close failed");
		const context: any = Object.create(ProjectContext.prototype);
		context.planMutationStore = { stopSweep: async () => { calls.push("sweep"); } };
		context.gateResetCoordinator = { recovery: Promise.resolve() };
		context.goalStore = { close: async () => { calls.push("goal"); throw goalError; } };
		context.taskStore = { close: async () => { calls.push("task"); } };
		context.gateStore = { close: async () => { calls.push("gate"); throw gateError; } };
		context.sessionStore = { flushAsync: async () => { calls.push("session"); } };
		context.costTracker = { flush: () => { calls.push("cost"); } };
		context.bgProcessStore = { flush: () => { calls.push("bg"); } };
		context.searchIndex = { close: async () => { calls.push("search"); } };

		const first = ProjectContext.prototype.close.call(context);
		const second = ProjectContext.prototype.close.call(context);
		assert.strictEqual(first, second);
		await assert.rejects(first, (error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.deepEqual(error.errors, [goalError, gateError]);
			return true;
		});
		assert.deepEqual(new Set(calls), new Set(["sweep", "goal", "task", "gate", "session", "cost", "bg", "search"]));
		assert.equal(calls.filter((call) => call === "goal").length, 1);
	});

	it("disposes GoalStore and TaskStore when a later native constructor fails", () => {
		const projectRoot = tempRoot();
		const stateDir = path.join(projectRoot, ".bobbit", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		const gateDb = new Database(path.join(stateDir, "gates.sqlite"));
		gateDb.pragma("user_version = 2");
		gateDb.close();
		const project = {
			id: "constructor-cleanup",
			name: "Constructor cleanup",
			rootPath: projectRoot,
			createdAt: Date.now(),
			colorLight: "#000000",
			colorDark: "#ffffff",
		} as any;

		assert.throws(
			() => new ProjectContext(project, { goalPersistence: "sqlite", taskPersistence: "sqlite", gatePersistence: "sqlite" }),
			/schema 2/i,
		);

		// Windows refuses this rename if either earlier SQLite store leaked its handle.
		const movedStateDir = `${stateDir}-released`;
		fs.renameSync(stateDir, movedStateDir);
		assert.equal(fs.existsSync(movedStateDir), true);
	});

	it("closeAll waits for every sibling, cleans topology, then propagates failures", async () => {
		const calls: string[] = [];
		const firstError = new Error("first close failed");
		const secondError = new Error("second close failed");
		const manager = managerWith([
			{ project: { id: "first" }, close: async () => { calls.push("first"); throw firstError; } },
			{ project: { id: "healthy" }, close: async () => { calls.push("healthy"); } },
			{ project: { id: "second" }, close: async () => { calls.push("second"); throw secondError; } },
		]);
		const topologyBefore = manager.contextTopologyVersion;

		await assert.rejects(manager.closeAll(), (error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.deepEqual(error.errors, [firstError, secondError]);
			return true;
		});
		assert.deepEqual(calls, ["first", "healthy", "second"]);
		assert.equal(manager.contexts.size, 0);
		assert.equal(manager.contextTopologyVersion, topologyBefore + 1);
	});

	it("remove cleans topology after close failure and preserves the failure", async () => {
		const closeError = new Error("durability barrier failed");
		let closeCalls = 0;
		const context = {
			project: { id: "broken" },
			close: async () => { closeCalls++; throw closeError; },
		};
		const manager = managerWith([context]);
		const topologyBefore = manager.contextTopologyVersion;

		await assert.rejects(manager.remove("broken"), (error: unknown) => error === closeError);
		assert.equal(closeCalls, 1);
		assert.equal(manager.contexts.has("broken"), false);
		assert.equal(manager.contextTopologyVersion, topologyBefore + 1);
	});
});
