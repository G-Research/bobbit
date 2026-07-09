// Migrated from tests/e2e/tasks-api.spec.ts (v2-integration tier).
// A fresh goal per test is created + tracked through the scope() helper so it is
// torn down in afterEach; the leak guard asserts no entity residue at file end.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getGateway, type GatewayFixture } from "../harness/gateway.js";
import { createScope, type TestScope } from "../harness/scope.js";
import { assertNoLeaks, snapshotEntities } from "../harness/leak-detector.js";
import type { EntityCounts } from "../harness/gateway.js";

let gw: GatewayFixture;
let scope: TestScope;
let goalId: string;
let baseline: EntityCounts;

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
