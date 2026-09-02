/** Full-stack smoke for an inline-only bespoke workflow proposal.
 * Library-workflow selector/customise/revert matrices live in the canonical proposals journey. */
import { test, expect, type GatewayInfo } from "../../e2e/gateway-harness.js";
import { apiFetch, deleteGoal } from "../../e2e/e2e-setup.js";
import { openApp, createSessionViaUI } from "../../e2e/ui/ui-helpers.js";

const INLINE_WORKFLOW = {
	id: "bespoke-inline-e2e",
	name: "Bespoke Inline E2E",
	description: "Inline workflow seeded through a goal proposal draft.",
	gates: [
		{ id: "issue-analysis", name: "Issue Analysis", dependsOn: [], verify: [{ name: "issue-check", type: "command", run: "echo issue" }] },
		{ id: "implementation", name: "Implementation", dependsOn: ["issue-analysis"], verify: [{ name: "implementation-check", type: "command", run: "echo implementation" }] },
		{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["implementation"], verify: [{ name: "merge-check", type: "command", run: "echo merge" }] },
	],
};

function capabilityHeaders(gateway: GatewayInfo, sessionId: string): Record<string, string> {
	const secret = gateway.sessionManager?.sessionSecretStore?.getOrCreateSecret(sessionId);
	expect(secret).toEqual(expect.any(String));
	return { "X-Bobbit-Session-Secret": secret! };
}

async function seedInlineProposal(gateway: GatewayInfo, sessionId: string): Promise<void> {
	const response = await apiFetch(`/api/sessions/${sessionId}/proposal/goal/seed`, {
		method: "POST",
		headers: capabilityHeaders(gateway, sessionId),
		body: JSON.stringify({ args: {
			title: "Inline Workflow Seed Only Goal",
			spec: "A goal proposal seeded with only an inline workflow and no registered workflow id.",
			inlineWorkflow: INLINE_WORKFLOW,
		} }),
	});
	expect(response.status, await response.text()).toBe(200);
}

test.describe("goal proposal workflow tab smoke", () => {
	test("an inline-only bespoke workflow hydrates both pickers and submits its workflow body", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		await openApp(page);
		const sessionId = await createSessionViaUI(page);
		await seedInlineProposal(gateway, sessionId);
		await page.reload({ waitUntil: "domcontentloaded" });

		const title = page.locator("input[placeholder='Goal title']").first();
		await expect(title).toHaveValue("Inline Workflow Seed Only Goal", { timeout: 20_000 });
		const goalSelect = page.locator("[data-testid='goal-proposal-panel-goal'] select").first();
		await expect(goalSelect).toHaveValue(INLINE_WORKFLOW.id, { timeout: 10_000 });

		await page.getByTestId("goal-proposal-tab-workflow").click();
		const workflowSelect = page.getByTestId("goal-proposal-workflow-select");
		await expect(workflowSelect).toHaveValue(INLINE_WORKFLOW.id);
		await expect(workflowSelect.locator("option:checked")).toHaveText("Bespoke (3 Gates)");
		await expect(page.getByTestId("goal-proposal-workflow-error")).toHaveCount(0);

		await page.getByTestId("goal-proposal-tab-goal").click();
		const create = page.getByRole("button", { name: "Create Goal" }).first();
		await expect(create).toBeEnabled();
		const responsePromise = page.waitForResponse(response =>
			response.request().method() === "POST" && new URL(response.url()).pathname === "/api/goals",
		);
		await create.click();
		const response = await responsePromise;
		expect(response.status()).toBe(201);
		const requestBody = response.request().postDataJSON();
		expect(requestBody.workflow).toMatchObject({ id: INLINE_WORKFLOW.id });
		expect(requestBody.workflow.gates).toHaveLength(3);
		expect(requestBody.workflowId).toBeUndefined();
		const created = await response.json();
		await deleteGoal(created.id);
	});
});
