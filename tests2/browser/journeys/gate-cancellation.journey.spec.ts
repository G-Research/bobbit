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
const PHASE_ZERO_COMMAND = "Completed phase command";
const HUMAN_SIGNOFF_LABEL = "Review paused verification";

type Fixture = {
	workflowId: string;
	projectId: string;
	goalId: string;
	phaseZeroMarker: string;
	commandReadyMarker: string;
};

function fastCommand(outputMarker: string): string {
	return `node -e "console.log('${outputMarker}')"`;
}

function slowCommand(readyMarker: string): string {
	// The marker is observed through the command's live log before pausing, so
	// the journey cannot mistake its seeded phase-0 state for process ownership.
	return `node -e "console.log('${readyMarker}'); setInterval(() => {}, 1000)"`;
}

function workflowId(): string {
	return `gate-cancellation-journey-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createFixture(): Promise<Fixture> {
	const projectId = await defaultProjectId();
	if (!projectId) throw new Error("gate-cancellation journey requires a default project");
	const id = workflowId();
	const phaseZeroMarker = `gate-cancellation-phase-zero-complete-${id}`;
	const commandReadyMarker = `gate-cancellation-command-ready-${id}`;
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
					{ name: PHASE_ZERO_COMMAND, type: "command", run: fastCommand(phaseZeroMarker), phase: 0 },
					{ name: "Long running command", type: "command", run: slowCommand(commandReadyMarker), phase: 1 },
					{ name: "Operator review", type: "human-signoff", label: HUMAN_SIGNOFF_LABEL, prompt: "Review while command runs", phase: 1 },
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
		return { workflowId: id, projectId, goalId: goal.id as string, phaseZeroMarker, commandReadyMarker };
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

async function waitForCompletedPhaseAndOwnedCommandAndAwaitingHuman(fixture: Fixture): Promise<void> {
	await expect.poll(async () => {
		const activeResponse = await apiFetch(`/api/goals/${fixture.goalId}/verifications/active`);
		const inspectResponse = await apiFetch(`/api/goals/${fixture.goalId}/gates/${GATE_ID}/inspect?section=verification`);
		if (!activeResponse.ok || !inspectResponse.ok) return false;

		const active = (await activeResponse.json()).verifications?.find((entry: any) => entry.gateId === GATE_ID);
		const inspected = await inspectResponse.json();
		const completedPhase = active?.steps?.find((step: any) => step.name === PHASE_ZERO_COMMAND);
		const inspectedCompletedPhase = inspected.steps?.find((step: any) => step.name === PHASE_ZERO_COMMAND);
		const command = active?.steps?.find((step: any) => step.name === "Long running command");
		const operatorReview = active?.steps?.find((step: any) => step.name === "Operator review");
		const inspectedCommand = inspected.steps?.find((step: any) => step.name === "Long running command");

		return active?.overallStatus === "running"
			// Phase 0 must be durably complete with output before phase 1 starts.
			&& completedPhase?.status === "passed" && completedPhase?.passed === true
			&& inspectedCompletedPhase?.status === "passed" && inspectedCompletedPhase?.passed === true
			&& inspectedCompletedPhase?.output?.includes(fixture.phaseZeroMarker)
			&& command?.status === "running"
			// The active record supplies durable command ownership while the
			// inspection snapshot reads its live stdout marker.
			&& typeof command.pid === "number" && command.pid > 0
			&& typeof command.outFile === "string" && command.outFile.length > 0
			&& inspectedCommand?.status === "running"
			&& inspectedCommand?.output?.includes(fixture.commandReadyMarker)
			&& operatorReview?.awaitingHuman === true
			&& operatorReview?.humanLabel === HUMAN_SIGNOFF_LABEL;
	}, { timeout: 20_000, message: "phase 0 must pass with output before phase 1 owns both a live command and awaiting human review" }).toBe(true);
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
	});
	const steps = result.verification.steps;
	expect(steps).toHaveLength(3);
	expect(steps.find((step: any) => step.name === PHASE_ZERO_COMMAND)).toMatchObject({
		name: PHASE_ZERO_COMMAND,
		status: "passed",
		passed: true,
		output: expect.stringContaining(fixture.phaseZeroMarker),
	});
	const interruptedSteps = steps.filter((step: any) => step.status === "cancelled");
	expect(interruptedSteps).toHaveLength(2);
	expect(interruptedSteps).toEqual(expect.arrayContaining([
		expect.objectContaining({ name: "Long running command", cancellation: expect.objectContaining({ cause: "goal-pause" }) }),
		expect.objectContaining({ name: "Operator review", cancellation: expect.objectContaining({ cause: "goal-pause" }) }),
	]));
	expect(result.state.status, "paused orchestration cancellation must leave the gate pending, not failed").toBe("pending");
	return result.verification;
}

async function expectCauseAcrossSurfaces(page: any, goalId: string, teamLeadId: string): Promise<void> {
	const cancelledCause = /cancelled[\s\S]*goal[ -]?pause|goal[ -]?pause[\s\S]*cancelled/i;
	const failed = /failed/i;
	const dashboardRow = page.locator(`[data-testid="goal-dashboard-gate-row"][data-gate-id="${GATE_ID}"]`).first();
	await expect(dashboardRow, "dashboard uses pending gate status after pause").toHaveAttribute("data-gate-status", "pending");
	await expect(dashboardRow, "dashboard renders the durable cancellation cause").toContainText(cancelledCause);
	await expect(dashboardRow).not.toContainText(failed);
	if (await dashboardRow.getAttribute("data-expanded") !== "true") await dashboardRow.click();
	const cancelledSignal = page.locator(`[data-testid="goal-dashboard-signal-entry"][data-signal-status="cancelled"]`).first();
	await expect(cancelledSignal).toBeVisible({ timeout: 15_000 });
	if (!await cancelledSignal.locator(".signal-entry__body").isVisible()) await cancelledSignal.locator(".signal-entry__header").click();
	const cancellationSummary = cancelledSignal.locator(".verify-cards__header-status").first();
	await expect(cancellationSummary, "dashboard cancellation summary preserves the completed phase and counts only unfinished rows as interrupted").toContainText(/1 passed,\s*2 interrupted/i);
	await expect(cancellationSummary).toContainText(cancelledCause);
	await expect(cancellationSummary).not.toContainText(failed);

	const sidebar = page.locator(`[data-nav-id="goal:${goalId}"]`).first();
	await expect(sidebar, "sidebar renders the cancellation cause without a failed badge").toContainText(cancelledCause);
	await expect(sidebar).not.toContainText(failed);

	await navigateToHash(page, `#/session/${teamLeadId}`);
	await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });

	const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
	await expect(pill).toBeVisible({ timeout: 15_000 });
	await expect(pill, "widget status pill renders the durable cancellation cause").toContainText(cancelledCause);
	await expect(pill).not.toContainText(failed);
	await pill.click();
	const widget = page.locator(`#goal-status-dropdown [data-testid="goal-widget-gate"][data-gate-id="${GATE_ID}"]`).first();
	await expect(widget).toHaveAttribute("data-gate-status", "pending");
	await expect(widget).not.toContainText(failed);

	await expect(page.locator("agent-interface, .agent-interface, main").first(), "transcript notification is neutral and cause-labelled").toContainText(cancelledCause);
}

test.describe("Journey: pause cancels verification without failing the gate", () => {
	test("pause, reload, resume, and explicitly re-signal exactly once across dashboard/sidebar/widget/transcript", async ({ page }) => {
		test.setTimeout(60_000);
		const priorHumanSignoffSkip = process.env.BOBBIT_HUMAN_SIGNOFF_SKIP;
		// `human-signoff` reads this live when the step executes; force the
		// required operator-review ownership state instead of accepting a skip.
		process.env.BOBBIT_HUMAN_SIGNOFF_SKIP = "0";
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
			await waitForCompletedPhaseAndOwnedCommandAndAwaitingHuman(fixture);

			const pause = await apiFetch(`/api/goals/${fixture.goalId}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false }),
			});
			expect(pause.status, `pause request failed: ${await pause.clone().text()}`).toBe(200);
			await expectCancelledAudit(fixture);

			await navigateToHash(page, `#/goal/${fixture.goalId}?tab=gates`);
			await expect(page.locator(`[data-testid="goal-dashboard-gate-row"][data-gate-id="${GATE_ID}"]`).first()).toBeVisible({ timeout: 20_000 });
			await expectCauseAcrossSurfaces(page, fixture.goalId, teamLeadId);
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/goal/${fixture.goalId}?tab=gates`);
			await expectCauseAcrossSurfaces(page, fixture.goalId, teamLeadId);

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
			await waitForCompletedPhaseAndOwnedCommandAndAwaitingHuman(reSignalledFixture);
			expect((await gate(reSignalledFixture)).signals, "the explicit re-signal remains the only new generation").toHaveLength(2);
		} finally {
			if (fixture) await apiFetch(`/api/goals/${fixture.goalId}/gates/${GATE_ID}/cancel-verification`, { method: "POST" }).catch(() => {});
			if (fixture) await teardownTeam(fixture.goalId).catch(() => {});
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			if (fixture) await deleteGoal(fixture.goalId, true).catch(() => {});
			if (fixture) await apiFetch(`/api/workflows/${encodeURIComponent(fixture.workflowId)}?projectId=${encodeURIComponent(fixture.projectId)}`, { method: "DELETE" }).catch(() => {});
			if (priorHumanSignoffSkip === undefined) delete process.env.BOBBIT_HUMAN_SIGNOFF_SKIP;
			else process.env.BOBBIT_HUMAN_SIGNOFF_SKIP = priorHumanSignoffSkip;
		}
	});
});
