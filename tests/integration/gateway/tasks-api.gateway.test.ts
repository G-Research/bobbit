// Migrated from tests/e2e/tasks-api.spec.ts (v2-integration tier).
// A fresh goal per test is created + tracked through the scope() helper so it is
// torn down in afterEach; the leak guard asserts no entity residue at file end.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getGateway, type GatewayFixture } from "../../../tests/support/harnesses/shared/gateway.js";
import { createScope, type TestScope } from "../../../tests/support/harnesses/shared/scope.js";
import { assertNoLeaks, snapshotEntities } from "../../../tests/support/harnesses/shared/leak-detector.js";
import type { EntityCounts } from "../../../tests/support/harnesses/shared/gateway.js";

let gw: GatewayFixture;
let scope: TestScope;
let goalId: string;
let baseline: EntityCounts;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

beforeAll(async () => {
	gw = await getGateway();
	baseline = snapshotEntities(gw);
});

beforeEach(async () => {
	scope = createScope(gw);
	const goal = await scope.createGoal({
		title: "Test Goal " + Date.now(),
		spec: "Test spec",
		team: true,
		worktree: false,
	});
	goalId = goal.id ?? goal.goalId ?? goal.session?.goalId;
	expect(goalId).toBeTruthy();
});

afterEach(async () => { await scope.cleanup(); });
afterAll(() => { assertNoLeaks(baseline, snapshotEntities(gw)); });

describe("Task creation — no artifact enforcement", () => {
	it("waits for goal, gate, and task publication before successful creation responses", async () => {
		const ctx = gw.projectContextManager.getOrCreate(gw.defaultProjectId);
		expect(ctx).toBeTruthy();

		const goalBarrier = deferred();
		const gateBarrier = deferred();
		const originalGoalFlush = ctx.goalStore.flush.bind(ctx.goalStore);
		const originalGateFlush = ctx.gateStore.flush.bind(ctx.gateStore);
		const goalFlush = vi.spyOn(ctx.goalStore, "flush").mockImplementation(async () => {
			await goalBarrier.promise;
			return originalGoalFlush();
		});
		const gateFlush = vi.spyOn(ctx.gateStore, "flush").mockImplementation(async () => {
			await gateBarrier.promise;
			return originalGateFlush();
		});

		let createdGoalId: string | undefined;
		try {
			const createGoal = gw.api("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					projectId: gw.defaultProjectId,
					title: `Durable goal ${Date.now()}`,
					worktree: false,
					team: false,
				}),
			});
			await vi.waitFor(() => {
				expect(goalFlush).toHaveBeenCalledOnce();
				expect(gateFlush).toHaveBeenCalledOnce();
			});
			let goalResponded = false;
			void createGoal.then(() => { goalResponded = true; });
			await Promise.resolve();
			expect(goalResponded).toBe(false);

			goalBarrier.resolve();
			gateBarrier.resolve();
			const response = await createGoal;
			expect(response.status).toBe(201);
			createdGoalId = (await response.json()).id;
			scope.trackGoal(createdGoalId!);
		} finally {
			goalBarrier.resolve();
			gateBarrier.resolve();
			goalFlush.mockRestore();
			gateFlush.mockRestore();
			await Promise.all([originalGoalFlush(), originalGateFlush()]);
		}

		const taskBarrier = deferred();
		const originalTaskFlush = ctx.taskStore.flush.bind(ctx.taskStore);
		const taskFlush = vi.spyOn(ctx.taskStore, "flush").mockImplementation(async () => {
			await taskBarrier.promise;
			return originalTaskFlush();
		});
		try {
			const createTask = gw.api(`/api/goals/${createdGoalId}/tasks`, {
				method: "POST",
				body: JSON.stringify({ title: "Durable task", type: "implementation" }),
			});
			await vi.waitFor(() => expect(taskFlush).toHaveBeenCalledOnce());
			let taskResponded = false;
			void createTask.then(() => { taskResponded = true; });
			await Promise.resolve();
			expect(taskResponded).toBe(false);

			taskBarrier.resolve();
			const response = await createTask;
			expect(response.status).toBe(201);
		} finally {
			taskBarrier.resolve();
			taskFlush.mockRestore();
			await originalTaskFlush();
		}
	});

	it("allows any task type without artifact requirements", async () => {
		const resp = await gw.api(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Implement feature X", type: "implementation", spec: "Build the thing" }),
		});
		expect(resp.status).toBe(201);
		const task = await resp.json();
		expect(task.id).toBeTruthy();
	});

	it("accepts any task type string", async () => {
		const resp = await gw.api(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Custom type", type: "my-custom-type" }),
		});
		expect(resp.status).toBe(201);
	});
});
