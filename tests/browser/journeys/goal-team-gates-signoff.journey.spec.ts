/**
 * Journey: Gate-card sign-off review handoff — v2 browser smoke
 */
import {
  test,
  expect,
  openApp,
  navigateToHash,
  createGoal,
  deleteGoal,
  apiFetch,
  defaultProjectId,
  createSession,
  deleteSession,
  waitForSessionStatus,
} from "../../../tests2/browser/_helpers/journey-fixture.js";

// Browser journey for the gate-card human sign-off handoff. The transcript is
// seeded with a real gate_inspect response from the running gateway so the test
// exercises the production renderer, shared launcher, review workspace, and
// sign-off endpoint without asking the mock LLM to synthesize a tool call.
test.describe("Journey: gate-card sign-off review handoff", () => {
	const GATE_ID = "release-approval";
	const GATE_NAME = "Release Approval";
	const STEP_NAME = "approve-release";
	const STEP_LABEL = "Approve release checklist";
	const SIGNAL_CONTENT = "# Release checklist\n\nAll release checks passed for the browser journey.";

	function workflowId(): string {
		return `gate-card-signoff-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	async function createSignoffWorkflow(id: string, projectId: string): Promise<void> {
		const response = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				projectId,
				id,
				name: "Gate Card Sign-off Journey",
				description: "Human sign-off workflow for the gate-card browser journey.",
				gates: [{
					id: GATE_ID,
					name: GATE_NAME,
					dependsOn: [],
					content: true,
					verify: [{
						name: STEP_NAME,
						type: "human-signoff",
						label: STEP_LABEL,
						prompt: "Review the submitted release checklist and approve or reject it.",
					}],
				}],
			}),
		});
		expect(response.status, `workflow creation failed: ${await response.clone().text().catch(() => "")}`).toBe(201);
	}

	async function waitForActionableInspect(goalId: string, signalId: string): Promise<any> {
		let latest: any = null;
		await expect.poll(async () => {
			const response = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/inspect?section=verification&mode=full`);
			if (!response.ok) return false;
			latest = await response.json();
			const step = latest?.steps?.find((candidate: any) => candidate?.name === STEP_NAME);
			return latest?.signalId === signalId && latest?.active === true && step?.awaitingHuman === true;
		}, {
			timeout: 15_000,
			message: "human sign-off inspect snapshot should become actionable",
		}).toBe(true);
		return latest;
	}

	function seedInspectCard(gateway: any, sessionId: string, snapshot: any): void {
		const session = gateway.sessionManager?.getSession(sessionId);
		const mockAgent = session?.rpcClient?._agent;
		if (!mockAgent || !Array.isArray(mockAgent.conversationMessages)) {
			throw new Error("gate-card sign-off journey requires the in-process mock agent transcript");
		}
		const toolCallId = `gate-inspect-signoff-${snapshot.signalId}`;
		const input = { gate_id: GATE_ID, section: "verification", mode: "full" };
		const now = Date.now();
		mockAgent.conversationMessages = [
			{
				id: `${toolCallId}-assistant`,
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "gate_inspect", arguments: input, input }],
				timestamp: now,
			},
			{
				id: `${toolCallId}-result`,
				role: "toolResult",
				toolCallId,
				toolName: "gate_inspect",
				isError: false,
				content: [{ type: "text", text: JSON.stringify(snapshot) }],
				timestamp: now + 1,
			},
		];
	}

	test("Start Review opens the submitted gate content with sign-off controls and approval hides the matching launcher", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const priorHumanSignoffSkip = process.env.BOBBIT_HUMAN_SIGNOFF_SKIP;
		process.env.BOBBIT_HUMAN_SIGNOFF_SKIP = "0";
		const id = workflowId();
		const projectId = await defaultProjectId();
		expect(projectId, "gate-card sign-off journey requires a default project").toBeTruthy();
		let goalId = "";
		let sessionId = "";
		try {
			await createSignoffWorkflow(id, projectId as string);
			const goalTitle = `Gate Card Sign-off ${Date.now()}`;
			const goal = await createGoal({
				title: goalTitle,
				workflowId: id,
				projectId,
			});
			goalId = goal.id as string;
			sessionId = await createSession({ goalId, projectId });
			await waitForSessionStatus(sessionId, "idle", 30_000);

			const signalResponse = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/signal`, {
				method: "POST",
				body: JSON.stringify({ content: SIGNAL_CONTENT }),
			});
			expect(signalResponse.status, `gate signal failed: ${await signalResponse.clone().text().catch(() => "")}`).toBe(201);
			const signalId = (await signalResponse.json()).signal.id as string;
			const inspectSnapshot = await waitForActionableInspect(goalId, signalId);
			expect(inspectSnapshot.steps.find((step: any) => step.name === STEP_NAME)).toMatchObject({
				type: "human-signoff",
				awaitingHuman: true,
				humanLabel: STEP_LABEL,
			});
			seedInspectCard(gateway, sessionId, inspectSnapshot);

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });

			const gateCard = page.locator('[data-tool-name="gate_inspect"]').first();
			await expect(gateCard, "real gate_inspect tool card should render").toBeVisible({ timeout: 20_000 });
			const launcher = gateCard.getByRole("button", { name: `Start review: ${STEP_LABEL}`, exact: true });
			await expect(launcher).toBeVisible({ timeout: 15_000 });
			await launcher.click();

			const expectedTitle = `Sign-off: ${goalTitle} / ${GATE_NAME} / ${STEP_LABEL}`;
			const reviewTab = page.locator(".goal-tab-pill[data-panel-tab-kind='review']").filter({ hasText: expectedTitle });
			await expect(reviewTab, "Start Review should open the matching sign-off document tab").toBeVisible({ timeout: 20_000 });
			const reviewPane = page.locator("review-pane");
			await expect(reviewPane).toBeVisible({ timeout: 15_000 });
			await expect(page.locator("review-document").getByText("All release checks passed for the browser journey.").first()).toBeVisible({ timeout: 15_000 });
			await expect(reviewPane.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
			await expect(reviewPane.getByRole("button", { name: "Reject", exact: true })).toBeVisible();

			await reviewPane.getByRole("button", { name: "Approve", exact: true }).click();
			await expect(launcher, "matching sign-off resolution should remove the gate-card launcher").toHaveCount(0, { timeout: 15_000 });
			await expect(reviewTab, "resolved sign-off document should close").toHaveCount(0, { timeout: 15_000 });
			await expect.poll(async () => {
				const response = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}`);
				return response.ok ? (await response.json()).status : null;
			}, { timeout: 15_000, message: "Approve should resolve the real gate verification" }).toBe("passed");
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			if (goalId) await deleteGoal(goalId, true).catch(() => {});
			await apiFetch(`/api/workflows/${id}?projectId=${encodeURIComponent(projectId as string)}`, { method: "DELETE" }).catch(() => {});
			if (priorHumanSignoffSkip === undefined) delete process.env.BOBBIT_HUMAN_SIGNOFF_SKIP;
			else process.env.BOBBIT_HUMAN_SIGNOFF_SKIP = priorHumanSignoffSkip;
		}
	});
});
