/**
 * API-only sidebar data-path coverage migrated out of browser E2E.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	startTeam,
	teardownTeam,
	waitForSessionStatus,
} from "./e2e-setup.js";

test.describe("Sidebar API data paths", () => {
	const goalIds: string[] = [];

	test.afterAll(async () => {
		for (const gid of goalIds) {
			await teardownTeam(gid).catch(() => {});
			await deleteGoal(gid).catch(() => {});
		}
	});

	test("on-demand agents endpoint returns archived team lead after teardown", async () => {
		const goal = await createGoal({
			title: "ChildLoad API",
			worktree: false,
			team: true,
		});
		goalIds.push(goal.id);

		const teamLeadId = await startTeam(goal.id);
		await waitForSessionStatus(teamLeadId, "idle");
		await teardownTeam(goal.id);

		const agentsResp = await apiFetch(`/api/goals/${goal.id}/team/agents?include=archived`);
		expect(agentsResp.status).toBe(200);
		const agentsBody = await agentsResp.json();
		const archivedAgent = (agentsBody.agents as any[]).find((a: any) => a.sessionId === teamLeadId);

		expect(archivedAgent, "archived team lead should be returned by on-demand agents endpoint").toBeTruthy();
		expect(archivedAgent.status).toBe("archived");
	});
});
