/**
 * Retained end-to-end metadata proposal smoke.
 *
 * metadataRowsToObject/objectToRows matrices are unit-tested, proposal tab state
 * is covered by the goal-tabs fixture, and server validation/inheritance is
 * covered by gateway tests. This journey keeps the one real assistant → UI →
 * goal-store → reload boundary.
 */
import { test, expect } from "../../support/harnesses/browser/gateway-harness.js";
import {
	apiFetch,
	defaultProjectId,
	deleteGoal,
} from "../../support/harnesses/browser/e2e-setup.js";
import {
	openApp,
	sendMessage,
	createGoalAssistantViaUI,
} from "../../support/helpers/browser/fixtures/ui-helpers.js";

test.describe("Goal proposal metadata — retained full-stack smoke", () => {
	test("agent-seeded proposal controls create an edited metadata-bearing goal that survives reload", async ({ page }) => {
		test.setTimeout(120_000);
		const projectId = await defaultProjectId();
		let goalId = "";

		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: true }),
		});
		if (projectId) {
			const structuredResponse = await apiFetch(`/api/projects/${projectId}/structured`);
			if (structuredResponse.ok) {
				const structured = await structuredResponse.json();
				const components = Array.isArray(structured.components) ? structured.components : [];
				if (components.length > 0) {
					components[0].config = { ...(components[0].config || {}), qa_start_command: "echo ready" };
					await apiFetch(`/api/projects/${projectId}/config`, {
						method: "PUT",
						body: JSON.stringify({ components }),
					});
				}
			}
		}

		try {
			await openApp(page);
			await createGoalAssistantViaUI(page, { timeout: 60_000 });
			await sendMessage(page, "Please GOAL_PROPOSAL_METADATA now");
			await expect(page.locator("input[placeholder='Goal title']").first()).toHaveValue("E2E Test Goal", { timeout: 20_000 });

			// The real proposal exposes every cross-cutting control without leaking
			// metadata into the default Goal panel.
			await expect(page.getByTestId("goal-proposal-tab-goal")).toHaveAttribute("aria-selected", "true");
			await expect(page.getByTestId("goal-proposal-panel-goal").getByTestId("goal-form-metadata")).toHaveCount(0);

			// Workflow selection and optional-step opt-in live in the Goal panel;
			// the Workflow tab owns inline workflow inspection/editing.
			const workflowSelect = page.getByTestId("goal-proposal-panel-goal").locator("select").first();
			await workflowSelect.selectOption("feature");
			const qaLabel = page.getByTestId("goal-proposal-panel-goal").locator("label", { hasText: "Enable QA Testing" }).first();
			const qaToggle = qaLabel.locator("input[type='checkbox'].toggle-switch");
			await expect(qaLabel.locator("span.cursor-help")).toHaveAttribute("title", /QA agent.*ephemeral server/i);
			await qaToggle.check();

			await page.getByTestId("goal-proposal-tab-subgoals").click();
			await expect(page.getByTestId("goal-form-parent-picker")).toBeVisible();
			await page.getByTestId("goal-proposal-tab-metadata").click();
			const metadataPanel = page.getByTestId("goal-proposal-panel-metadata");
			await expect(metadataPanel.getByTestId("goal-form-metadata")).toBeVisible();
			await expect(metadataPanel.getByTestId("goal-metadata-row")).toHaveCount(2);
			const seededKeys = await metadataPanel.getByTestId("goal-metadata-key")
				.evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
			const memoryIndex = seededKeys.indexOf("hindsight.memory.enabled");
			const disabledToolsIndex = seededKeys.indexOf("bobbit.disabledTools");
			expect(memoryIndex).toBeGreaterThanOrEqual(0);
			expect(disabledToolsIndex).toBeGreaterThanOrEqual(0);
			await metadataPanel.getByTestId("goal-metadata-value").nth(memoryIndex).fill("true");
			await metadataPanel.getByTestId("goal-metadata-remove").nth(disabledToolsIndex).click();
			await expect(metadataPanel.getByTestId("goal-metadata-row")).toHaveCount(1);
			await expect(metadataPanel.getByTestId("goal-metadata-key").first()).toHaveValue("hindsight.memory.enabled");
			await metadataPanel.getByTestId("goal-metadata-add").click();
			await expect(metadataPanel.getByTestId("goal-metadata-row")).toHaveCount(2);
			await metadataPanel.getByTestId("goal-metadata-key").nth(1).fill("experiment.flavor");
			await metadataPanel.getByTestId("goal-metadata-value").nth(1).fill("treatment");

			await page.getByTestId("goal-proposal-tab-goal").click();
			await page.getByTestId("goal-proposal-tab-metadata").click();
			await expect.poll(() => metadataPanel.getByTestId("goal-metadata-key")
				.evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).toEqual([
				"hindsight.memory.enabled",
				"experiment.flavor",
			]);

			const createResponse = page.waitForResponse(response =>
				response.request().method() === "POST"
				&& /\/api\/goals$/.test(new URL(response.url()).pathname)
				&& response.ok(),
			);
			await page.getByRole("button", { name: "Create Goal", exact: true }).click();
			goalId = String((await (await createResponse).json()).id || "");
			expect(goalId).not.toBe("");
			await expect(page).toHaveURL(/#\/goal(-dashboard)?\//, { timeout: 15_000 });

			const readGoal = async () => (await (await apiFetch(`/api/goals/${goalId}`)).json());
			let created = await readGoal();
			expect(created.metadata).toEqual({
				"hindsight.memory.enabled": true,
				"experiment.flavor": "treatment",
			});
			expect(created.enabledOptionalSteps).toContain("QA testing");

			await page.reload();
			created = await readGoal();
			expect(created.metadata["hindsight.memory.enabled"]).toBe(true);
			expect(created.metadata["experiment.flavor"]).toBe("treatment");
			expect(created.metadata["bobbit.disabledTools"]).toBeUndefined();
		} finally {
			if (goalId) await deleteGoal(goalId, true).catch(() => {});
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ subgoalsEnabled: true }),
			}).catch(() => {});
		}
	});
});
