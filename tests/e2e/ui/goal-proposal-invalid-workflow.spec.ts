/**
 * Browser E2E for Requirement 2 — the workflow dropdown must stay in sync with
 * form state when a goal proposal names a workflow the project does NOT have.
 *
 * Root cause (see design doc): the workflow <select> binds `.value` to the
 * proposed workflow id. When that id isn't among the project's configured
 * workflows the browser visually falls back to the first option, but the
 * underlying form state (`_proposalWorkflowId` inline / `_selectedWorkflowId`
 * assistant) keeps the phantom value. Re-selecting the displayed option fires
 * no `change` event, so Create submits the invalid workflow and the server
 * rejects it.
 *
 * Fix: normalize an empty/phantom proposed workflow id to the first available
 * workflow once the list is loaded, so the displayed option and the underlying
 * state always agree. These tests pin that behaviour for BOTH panels:
 *   • inline goal-proposal panel (regular session)  → `_proposalWorkflowId`
 *   • assistant preview panel (goal-assistant flow) → `_selectedWorkflowId`
 *
 * The phantom id is injected client-side (not via the seed endpoint) because
 * the server now validates proposed workflows (Requirement 1) — so the only
 * way an invalid id reaches the UI in isolation is via the in-memory state the
 * normalization is meant to repair.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

const PHANTOM_WORKFLOW = "__does_not_exist_wf__";

/** Helper: open goal assistant, send GOAL_PROPOSAL, wait for title input. */
async function openGoalAssistantProposal(page: import("@playwright/test").Page) {
	test.setTimeout(90_000);
	await openApp(page);
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await expect(newGoalBtn).toBeEnabled({ timeout: 10_000 });
	const sessionCreated = page.waitForResponse(
		(resp) => resp.url().includes("/api/sessions") && resp.request().method() === "POST" && resp.ok(),
		{ timeout: 60_000 },
	);
	await newGoalBtn.click();
	await sessionCreated;
	await page.waitForURL(/#\/session\//, { timeout: 10_000 });
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 10_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 10_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
}

/** Helper: open regular session, send GOAL_PROPOSAL, wait for proposal panel. */
async function openRegularSessionProposal(page: import("@playwright/test").Page) {
	test.setTimeout(90_000);
	await openApp(page);
	await createSessionViaUI(page);
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 15_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
}

/** Helper: find the last created goal matching a title via API. */
async function findGoalByTitle(title: string) {
	const resp = await apiFetch("/api/goals");
	const data = await resp.json();
	const goals = data.goals || data;
	return (goals as any[]).find((g: any) => g.title === title);
}

/** Helper: delete a goal by ID (best-effort). */
async function deleteGoal(goalId: string) {
	await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {});
}

/** Read the <option> values of the panel's workflow select, in DOM order. */
async function workflowOptionValues(page: import("@playwright/test").Page): Promise<string[]> {
	const select = page.locator(".goal-preview-panel select").first();
	await expect(select).toBeVisible({ timeout: 10_000 });
	return select.locator("option").evaluateAll((opts) =>
		(opts as HTMLOptionElement[]).map((o) => o.value),
	);
}

test.describe("Goal proposal with invalid workflow (dropdown desync)", () => {
	test("inline goal-proposal panel normalizes a phantom workflow to a valid default", async ({ page }) => {
		await openRegularSessionProposal(page);

		const options = await workflowOptionValues(page);
		expect(options.length, "harness project must expose multiple workflows").toBeGreaterThan(1);
		expect(options, "expected a 'feature' workflow to switch to").toContain("feature");
		// Pick a target distinct from whatever the default-fallback would be.
		const target = options.find((id) => id !== options[0]) ?? "feature";

		// Inject a phantom workflow into the live proposal slot the inline panel
		// syncs from, then force a re-render. `syncProposalFormState` re-keys on
		// the changed workflow field and must normalize the phantom away.
		await page.evaluate((phantom) => {
			const st = (window as any).__bobbitState;
			const slot = st?.activeProposals?.goal;
			if (slot?.fields) slot.fields.workflow = phantom;
			(window as any).__bobbitRenderApp?.();
		}, PHANTOM_WORKFLOW);

		const select = page.locator(".goal-preview-panel select").first();
		// The displayed option must be a real configured workflow, never the
		// phantom and never empty (an empty value is the desync symptom: no
		// option matched so the <select> reports selectedIndex -1 / value "").
		await expect.poll(async () => select.inputValue(), { timeout: 5_000 }).not.toBe("");
		const fallbackValue = await select.inputValue();
		expect(options).toContain(fallbackValue);
		expect(fallbackValue).not.toBe(PHANTOM_WORKFLOW);

		// Now the user picks a specific valid workflow. Create must submit THAT
		// id (not the phantom the agent proposed).
		await select.selectOption(target);
		await expect.poll(async () => select.inputValue(), { timeout: 5_000 }).toBe(target);

		const createRequest = page.waitForRequest(
			(req) => req.url().includes("/api/goals") && req.method() === "POST",
			{ timeout: 15_000 },
		);
		await page.locator("button").filter({ hasText: "Create Goal" }).first().click();
		const req = await createRequest;
		const body = JSON.parse(req.postData() || "{}");
		expect(body.workflowId).toBe(target);

		await expect(page).toHaveURL(/#\/goal(-dashboard)?\//, { timeout: 15_000 });
		const created = await findGoalByTitle("E2E Test Goal");
		if (created) {
			expect(created.workflowId).toBe(target);
			await deleteGoal(created.id);
		}
	});

	test("assistant preview panel normalizes a phantom workflow to a valid default", async ({ page }) => {
		await openGoalAssistantProposal(page);

		const options = await workflowOptionValues(page);
		expect(options.length, "harness project must expose multiple workflows").toBeGreaterThan(1);
		expect(options, "expected a 'feature' workflow to switch to").toContain("feature");
		const target = options.find((id) => id !== options[0]) ?? "feature";

		// The assistant panel holds its selection in imperative module state
		// (`_selectedWorkflowId`), set via `setSelectedWorkflowId` when a goal
		// proposal arrives. Simulate the agent proposing a workflow the project
		// doesn't have, then re-render.
		await page.evaluate((phantom) => {
			(window as any).__bobbitSetSelectedWorkflowId?.(phantom);
			(window as any).__bobbitRenderApp?.();
		}, PHANTOM_WORKFLOW);

		const select = page.locator(".goal-preview-panel select").first();
		await expect.poll(async () => select.inputValue(), { timeout: 5_000 }).not.toBe("");
		const fallbackValue = await select.inputValue();
		expect(options).toContain(fallbackValue);
		expect(fallbackValue).not.toBe(PHANTOM_WORKFLOW);

		await select.selectOption(target);
		await expect.poll(async () => select.inputValue(), { timeout: 5_000 }).toBe(target);

		const createRequest = page.waitForRequest(
			(req) => req.url().includes("/api/goals") && req.method() === "POST",
			{ timeout: 15_000 },
		);
		await page.locator("button").filter({ hasText: "Create Goal" }).first().click();
		const req = await createRequest;
		const body = JSON.parse(req.postData() || "{}");
		expect(body.workflowId).toBe(target);

		await expect(page).toHaveURL(/#\/goal(-dashboard)?\//, { timeout: 15_000 });
		const created = await findGoalByTitle("E2E Test Goal");
		if (created) {
			expect(created.workflowId).toBe(target);
			await deleteGoal(created.id);
		}
	});
});
