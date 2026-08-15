// v2-native browser journey — listed in tests-map.json `v2Native` and `journeys`.
/**
 * A pause is orchestration, not a failed product verification. This journey
 * keeps a command and human review live together, pauses them, and verifies
 * that one durable goal-pause cancellation is rendered consistently after a
 * reload before an operator explicitly re-signals exactly once.
 */
import {
	test,
	expect,
	apiFetch,
	createGoal,
	deleteGoal,
	defaultProjectId,
	deleteSession,
	openApp,
	navigateToHash,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";
import { startTeam, teardownTeam } from "../e2e-setup.js";

const GATE_ID = "multi-phase-cancellation";
const SLOW_COMMAND = `node -e "setTimeout(() => process.exit(0), 30000)"`;

type Fixture = { workflowId: string; projectId: string; goalId: string };

function workflowId(): string {
	return `gate-cancellation-journey-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createFixture(): Promise<Fixture> {
	const projectId = await defaultProjectId();
	if (!projectId) throw new Error("gate-cancellation journey requires a default project");
	const id = workflowId();
	const createWorkflow = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			projectId,
			id,
			name: "Paused verification cancellation journey",
			gates: [{
				id: GATE_ID,
				name: "Multi-phase verification",
				dependsOn: [],
				verify: [
					{ name: "Long running command", type: "command", run: SLOW_COMMAND, phase: 0 },
					{ name: "Operator review", type: "human-signoff", label: "Review paused verification", prompt: "Review while command runs", phase: 0 },
				],
			}],
		}),
	});
	expect(createWorkflow.status, `workflow fixture failed: ${await createWorkflow.clone().text()}`).toBe(201);
	try {
		const goal = await createGoal({
			title: `Paused gate cancellation ${Date.now()}`,
			workflowId: id,
			projectId,
			team: true,
			autoStartTeam: false,
			worktree: false,
		});
		return { workflowId: id, projectId, goalId: goal.id as string };
	} catch (error) {
		await apiFetch(`/api/workflows/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
		throw error;
	}
}

async function gate(fixture: Fixture): Promise<any> {
	const response = await apiFetch(`/api/goals/${fixture.goalId}/gates/${GATE_ID}`);
	expect(response.status).toBe(200);
	return response.json();
}

async function signal(fixture: Fixture, content: string): Promise<Response> {
	return apiFetch(`/api/goals/${fixture.goalId}/gates/${GATE_ID}/signal`, {
		method: "POST",
		body: JSON.stringify({ content }),
	});
}

async function waitForBothLiveSteps(fixture: Fixture): Promise<void> {
	await expect.poll(async () => {
		const response = await apiFetch(`/api/goals/${fixture.goalId}/verifications/active`);
		if (!response.ok) return false;
		const active = (await response.json()).verifications?.find((entry: any) => entry.gateId === GATE_ID);
		return active?.overallStatus === "running"
			&& active.steps?.some((step: any) => step.name === "Long running command" && step.status === "running")
			&& active.steps?.some((step: any) => step.name === "Operator review" && (step.status === "running" || step.awaitingHuman));
	}, { timeout: 20_000, message: "command and human review must both be live before pause" }).toBe(true);
}

async function expectCancelledAudit(fixture: Fixture): Promise<any> {
	let result: any;
	await expect.poll(async () => {
		const state = await gate(fixture);
		const verification = state.signals?.at(-1)?.verification;
		result = { state, verification };
		return verification?.status;
	}, { timeout: 20_000, message: "pause must publish a durable cancelled, never failed, verification" }).toBe("cancelled");
	expect(result.verification).toMatchObject({
		status: "cancelled",
		cancellation: { cause: "goal-pause", requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
		steps: [
			expect.objectContaining({ name: "Long running command", status: "cancelled", cancellation: { cause: "goal-pause" } }),
			expect.objectContaining({ name: "Operator review", status: "cancelled", cancellation: { cause: "goal-pause" } }),
		],
	});
	expect(result.state.status, "paused orchestration cancellation must leave the gate pending, not failed").toBe("pending");
	return result.verification;
}

async function expectCauseAcrossSurfaces(page: any, goalId: string): Promise<void> {
	const cancelledCause = /cancelled[\s\S]*goal[ -]?pause|goal[ -]?pause[\s\S]*cancelled/i;
	const failed = /failed/i;
	const dashboardRow = page.locator(`[data-testid="goal-dashboard-gate-row"][data-gate-id="${GATE_ID}"]`).first();
	await expect(dashboardRow, "dashboard uses pending gate status after pause").toHaveAttribute("data-gate-status", "pending");
	await expect(dashboardRow, "dashboard renders the durable cancellation cause").toContainText(cancelledCause);
	await expect(dashboardRow).not.toContainText(failed);

	const sidebar = page.locator(`[data-nav-id="goal:${goalId}"]`).first();
	await expect(sidebar, "sidebar renders the cancellation cause without a failed badge").toContainText(cancelledCause);
	await expect(sidebar).not.toContainText(failed);

	const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
	await expect(pill).toBeVisible({ timeout: 15_000 });
	await pill.click();
	const widget = page.locator(`#goal-status-dropdown [data-testid="goal-widget-gate"][data-gate-id="${GATE_ID}"]`).first();
	await expect(widget, "widget renders the same cancellation cause").toContainText(cancelledCause);
	await expect(widget).toHaveAttribute("data-gate-status", "pending");
	await expect(widget).not.toContainText(failed);

	await expect(page.locator("agent-interface, .agent-interface, main").first(), "transcript notification is neutral and cause-labelled").toContainText(cancelledCause);
}

test.describe("Journey: pause cancels verification without failing the gate", () => {
	test("pause, reload, resume, and explicitly re-signal exactly once across dashboard/sidebar/widget/transcript", async ({ page }) => {
		test.setTimeout(90_000);
		let fixture: Fixture | undefined;
		let teamLeadId: string | undefined;
		try {
			fixture = await createFixture();
			teamLeadId = await startTeam(fixture.goalId);
			await waitForSessionStatus(teamLeadId, "idle", 30_000);
			await openApp(page);
			await navigateToHash(page, `#/session/${teamLeadId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });

			const first = await signal(fixture, "Start the command and human review.");
			expect(first.status).toBe(201);
			await waitForBothLiveSteps(fixture);

			const pause = await apiFetch(`/api/goals/${fixture.goalId}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false }),
			});
			expect(pause.status, `pause request failed: ${await pause.clone().text()}`).toBe(200);
			await expectCancelledAudit(fixture);

			await navigateToHash(page, `#/goal/${fixture.goalId}?tab=gates`);
			await expect(page.locator(`[data-testid="goal-dashboard-gate-row"][data-gate-id="${GATE_ID}"]`).first()).toBeVisible({ timeout: 20_000 });
			await expectCauseAcrossSurfaces(page, fixture.goalId);
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/goal/${fixture.goalId}?tab=gates`);
			await expectCauseAcrossSurfaces(page, fixture.goalId);

			const resume = await apiFetch(`/api/goals/${fixture.goalId}/resume`, { method: "POST", body: JSON.stringify({ cascade: false }) });
			expect(resume.status, `resume request failed: ${await resume.clone().text()}`).toBe(200);
			const beforeExplicitResignal = await gate(fixture);
			expect(beforeExplicitResignal.signals, "resume must not implicitly requeue a stale generation").toHaveLength(1);

			const second = await signal(fixture, "Explicit, deterministic re-signal after resume.");
			expect(second.status, "one explicit re-signal is eligible after cancellation").toBe(201);
			if (!fixture) throw new Error("CANCELLATION_FIXTURE_REQUIRED: fixture must exist before polling the re-signal");
			const reSignalledFixture = fixture;
			await expect.poll(() => gate(reSignalledFixture).then(state => state.signals?.length ?? 0), {
				timeout: 15_000,
				message: "explicit resume action creates exactly one new signal generation",
			}).toBe(2);
			await waitForBothLiveSteps(reSignalledFixture);
		} finally {
			if (fixture) await apiFetch(`/api/goals/${fixture.goalId}/gates/${GATE_ID}/cancel-verification`, { method: "POST" }).catch(() => {});
			if (fixture) await teardownTeam(fixture.goalId).catch(() => {});
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			if (fixture) await deleteGoal(fixture.goalId, true).catch(() => {});
			if (fixture) await apiFetch(`/api/workflows/${encodeURIComponent(fixture.workflowId)}?projectId=${encodeURIComponent(fixture.projectId)}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
