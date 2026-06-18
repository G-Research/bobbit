/**
 * API E2E coverage for Remove Boot Respawn.
 *
 * A goal that was deliberately made teamless by /team/teardown must remain
 * teamless across a gateway restart. Restart restoration may restore existing
 * active teams, but it must not create a new team lead for this sessionless goal.
 */
import { test, expect, type GatewayInfo } from "./gateway-harness.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	startTeam,
	teardownTeam,
	waitForHealth,
	waitForSessionStatus,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

interface TeamState {
	teamLeadSessionId?: string;
	agents?: Array<{ sessionId?: string; status?: string; role?: string }>;
}

async function readActiveTeam(goalId: string): Promise<TeamState | null> {
	const resp = await apiFetch(`/api/goals/${goalId}/team`);
	if (resp.status === 404) return null;
	const text = await resp.text();
	if (resp.status !== 200) {
		throw new Error(`GET /team expected 200 or 404, got ${resp.status}: ${text}`);
	}
	return JSON.parse(text) as TeamState;
}

async function readActiveAgents(goalId: string): Promise<Array<{ sessionId?: string; status?: string; role?: string }>> {
	const resp = await apiFetch(`/api/goals/${goalId}/team/agents`);
	if (resp.status === 404) return [];
	const text = await resp.text();
	if (resp.status !== 200) {
		throw new Error(`GET /team/agents expected 200 or 404, got ${resp.status}: ${text}`);
	}
	const body = JSON.parse(text) as { agents?: Array<{ sessionId?: string; status?: string; role?: string }> };
	return body.agents ?? [];
}

async function waitForNoActiveTeam(goalId: string, label: string): Promise<void> {
	await pollUntil(async () => {
		const team = await readActiveTeam(goalId);
		if (team?.teamLeadSessionId) return null;
		const agents = await readActiveAgents(goalId);
		return agents.length === 0 ? true : null;
	}, { timeoutMs: 10_000, intervalMs: 100, label });
}

async function assertNoTeamRecreated(goalId: string, previousLeadId: string, durationMs = 2_000): Promise<void> {
	const deadline = Date.now() + durationMs;
	while (Date.now() < deadline) {
		const team = await readActiveTeam(goalId);
		if (team?.teamLeadSessionId) {
			throw new Error(
				`BOOT_RESPAWN_E2E_TEAM_RECREATED: restart created team lead ${team.teamLeadSessionId} ` +
				`for torn-down goal ${goalId}; previous torn-down lead was ${previousLeadId}`,
			);
		}
		const agents = await readActiveAgents(goalId);
		if (agents.length > 0) {
			throw new Error(
				`BOOT_RESPAWN_E2E_AGENTS_RECREATED: restart created active agents for torn-down goal ${goalId}: ` +
				JSON.stringify(agents),
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function restartCrashedGateway(gateway: GatewayInfo): Promise<void> {
	await gateway.restart();
	await waitForHealth(10_000);
}

test.describe.serial("Remove Boot Respawn restart coverage", () => {
	test.setTimeout(60_000);

	test("teardown keeps a goal teamless across restart and manual Start Team still succeeds", async ({ gateway }) => {
		let goalId: string | undefined;
		let serverOnline = true;

		const goal = await createGoal({
			title: `Remove Boot Respawn restart ${Date.now()}`,
			worktree: false,
			team: true,
			autoStartTeam: false,
			spec: "Remove Boot Respawn E2E: this goal starts manually, is torn down, survives a gateway restart as teamless, then starts manually again.",
		});
		goalId = goal.id;

		try {
			const firstLeadId = await startTeam(goalId);
			await waitForSessionStatus(firstLeadId, "idle");
			const beforeTeardown = await readActiveTeam(goalId);
			expect(beforeTeardown?.teamLeadSessionId).toBe(firstLeadId);

			await teardownTeam(goalId);
			await waitForNoActiveTeam(goalId, "team torn down before restart");

			await gateway.crash();
			serverOnline = false;
			await gateway.restart();
			serverOnline = true;
			await waitForHealth(10_000);

			await assertNoTeamRecreated(goalId, firstLeadId);
			expect(await readActiveTeam(goalId), "manual Start Team should remain available after restart").toBeNull();
			expect(await readActiveAgents(goalId), "no active team agents should be recreated after restart").toEqual([]);

			const secondLeadId = await startTeam(goalId);
			expect(secondLeadId).toBeTruthy();
			expect(secondLeadId).not.toBe(firstLeadId);
			await waitForSessionStatus(secondLeadId, "idle");

			const afterManualStart = await readActiveTeam(goalId);
			expect(afterManualStart?.teamLeadSessionId).toBe(secondLeadId);
		} finally {
			if (!serverOnline) {
				await restartCrashedGateway(gateway).catch(() => {});
			}
			if (goalId) {
				await teardownTeam(goalId).catch(() => {});
				await deleteGoal(goalId).catch(() => {});
			}
		}
	});
});
