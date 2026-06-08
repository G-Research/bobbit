/**
 * Goal form tooltip E2E tests — verify ⓘ tooltip icons on optional step toggles.
 *
 * Field-level workflow metadata is covered in tests/e2e/goal-workflow-api.spec.ts;
 * this browser spec keeps the real assistant/form render path only once.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, sendMessage } from "./ui-helpers.js";
import { apiFetch } from "../e2e-setup.js";

test.describe.configure({ timeout: 90_000 });

/**
 * Configure qa_start_command on the default project so the goal form's
 * "Enable QA Testing" tooltip shows the real workflow description rather than
 * the "Configure qa_start_command in project settings..." fallback.
 */
test.beforeAll(async () => {
	const projectsResp = await apiFetch("/api/projects");
	const projects = await projectsResp.json();
	if (projects.length === 0) return;
	const projectId = projects[0].id;
	const structuredResp = await apiFetch(`/api/projects/${projectId}/structured`).catch(() => null);
	if (!structuredResp || !structuredResp.ok) return;
	const data = await structuredResp.json();
	const comps = Array.isArray(data.components) ? data.components : [];
	if (comps.length === 0) return;
	comps[0].config = { ...(comps[0].config || {}), qa_start_command: "echo ready" };
	await apiFetch(`/api/projects/${projectId}/config`, {
		method: "PUT",
		body: JSON.stringify({ components: comps }),
	});
});

async function openGoalForm(page: import("@playwright/test").Page) {
	await openApp(page);

	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await expect(newGoalBtn).toBeEnabled({ timeout: 10_000 });
	await newGoalBtn.click();

	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 45_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 25_000 });
}

test.describe("Step description tooltips", () => {
	test("optional step tooltip renders workflow description and styling", async ({ page }) => {
		await openGoalForm(page);

		// Switch explicitly so the assertion is independent of the mock proposal's
		// default workflow/options payload.
		const workflowSelect = page.locator(".goal-preview-panel select").first();
		await expect(workflowSelect).toBeVisible({ timeout: 5_000 });
		await workflowSelect.selectOption("feature");
		await expect(workflowSelect).toHaveValue("feature", { timeout: 5_000 });

		const qaLabel = page.locator(".goal-preview-panel label", { hasText: "Enable QA Testing" }).first();
		await expect(qaLabel).toBeVisible({ timeout: 5_000 });
		const tooltipIcon = qaLabel.locator("span.cursor-help").first();
		await expect(tooltipIcon).toBeVisible({ timeout: 5_000 });
		await expect(tooltipIcon).toHaveText("ⓘ");

		// Full YAML text is pinned in the API spec; this browser assertion proves
		// the real form wires that description into the title attribute.
		await expect(tooltipIcon).toHaveAttribute("title", /QA agent/i, { timeout: 10_000 });
		await expect(tooltipIcon).toHaveAttribute("title", /ephemeral server/i);
		await expect(tooltipIcon).toHaveClass(/text-\[9px\]/);
		await expect(tooltipIcon).toHaveClass(/text-muted-foreground/);
		await expect(tooltipIcon).toHaveClass(/cursor-help/);
	});
});
