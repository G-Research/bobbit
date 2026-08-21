import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectContext } from "../../src/server/agent/project-context.js";
import type { RegisteredProject } from "../../src/server/agent/project-registry.js";
import { TaskManager } from "../../src/server/agent/task-manager.js";
import {
	HostNotificationDispatcher,
	type HostNotificationDeliveryAdapter,
} from "../../src/server/extension-host/host-notification-dispatcher.js";
import type { HostNotification } from "../../src/shared/extension-host/host-hooks.js";
import { wireProjectHostNotificationBoundaries } from "../../src/server/server.js";
import { createMemFs } from "../harness/mem-fs.js";

const contexts: ProjectContext[] = [];

afterEach(async () => {
	await Promise.allSettled(contexts.splice(0).map(context => context.close()));
});

function project(id: string): RegisteredProject {
	return {
		id,
		name: id,
		rootPath: path.resolve(`/memfs/${id}`),
		createdAt: 1,
		kind: "normal",
		colorLight: "oklch(0.6 0.1 250)",
		colorDark: "oklch(0.7 0.1 250)",
	};
}

function context(id: string): ProjectContext {
	const fs = createMemFs();
	const registered = project(id);
	fs.mkdirSync(registered.rootPath, { recursive: true });
	const ctx = new ProjectContext(registered, {
		fsImpl: fs,
		goalPersistence: "json",
		taskPersistence: "json",
		gatePersistence: "json",
	});
	contexts.push(ctx);
	return ctx;
}

async function settleFanout(): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe("gateway-owned host hook boundaries", () => {
	it("routes project store commits through one canonical dispatcher without replacing legacy callbacks", async () => {
		const delivered: HostNotification[] = [];
		const adapter: HostNotificationDeliveryAdapter = {
			consumer: "browser",
			deliver: notification => { delivered.push(notification); },
		};
		const dispatcher = new HostNotificationDispatcher({
			adapters: [adapter],
			idGenerator: (() => { let id = 0; return () => `notification-${++id}`; })(),
			now: (() => { let now = 100; return () => ++now; })(),
		});
		const ctx = context("project-a");
		let legacyCreates = 0;
		ctx.goalStore.onGoalCreated = () => { legacyCreates++; };
		ctx.setHostNotificationDispatcher(dispatcher);
		wireProjectHostNotificationBoundaries(ctx);

		await ctx.goalStore.putStrict({
			id: "goal-1",
			title: "Goal",
			cwd: ctx.project.rootPath,
			state: "todo",
			spec: "",
			createdAt: 10,
			updatedAt: 10,
			setupStatus: "ready",
			projectId: ctx.project.id,
		});
		expect(await ctx.goalManager.updateGoal("goal-1", { state: "complete" })).toBe(true);

		const tasks = new TaskManager(ctx.taskStore);
		const task = tasks.createTask("goal-1", "Implement", "implementation");
		tasks.updateTask(task.id, { state: "in-progress", title: "Implement safely" });
		await ctx.taskStore.flush();

		ctx.gateStore.initGatesForGoal("goal-1", ["implementation"]);
		ctx.gateStore.updateGateStatus("goal-1", "implementation", "passed");
		await ctx.gateStore.flush();
		ctx.projectConfigStore.set("build_command", "npm run build");
		await settleFanout();

		expect(legacyCreates).toBe(1);
		expect(delivered.map(notification => notification.name)).toEqual([
			"goalCreated",
			"goalUpdated",
			"goalCompleted",
			"taskCreated",
			"taskUpdated",
			"taskStateChanged",
			"gateStatusChanged",
			"settingsChanged",
		]);
		expect(delivered.every(notification => notification.projectId === "project-a")).toBe(true);
		expect(delivered.find(notification => notification.name === "gateStatusChanged")).toMatchObject({
			aggregate: { id: "goal-1:implementation", revision: 1 },
			payload: { goalId: "goal-1", gateId: "implementation", previousStatus: "pending", status: "passed" },
		});
		expect(delivered.find(notification => notification.name === "settingsChanged")?.payload).toEqual({
			target: "project",
			changedKeys: ["commands"],
		});
	});
});
