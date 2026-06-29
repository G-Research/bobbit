/**
 * Browser E2E coverage for the goal-proposal modal's Workflow tab.
 *
 * The Workflow tab presents a workflow <select> (synced to the Goal tab's
 * picker) plus a Customise/Revert toggle. The chosen workflow renders beneath
 * in read-only inspector form; pressing "Customise for this goal" swaps it for
 * the editor and turns the button into "Revert to project definition".
 *
 * Scenarios per AGENTS.md "E2E coverage requirement":
 *   1. Navigation — open the proposal, switch to the Workflow tab; the select
 *      and the Customise button are visible (no left-hand workflow list).
 *   2. Happy path — Customise → editor appears, button flips to Revert.
 *   3. Cleanup/undo — Revert → editor disappears (inspector returns), button
 *      flips back to Customise.
 *   4. Sync — the Workflow-tab select mirrors the Goal-tab select value.
 */
import type { Locator } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, deleteGoal } from "../e2e-setup.js";
import { openApp, sendMessage, createSessionViaUI } from "./ui-helpers.js";

const INLINE_WORKFLOW_ID = "bespoke-inline-e2e";
const INLINE_WORKFLOW_GATE_COUNT = 3;
const INLINE_WORKFLOW_LABEL = `Bespoke (${INLINE_WORKFLOW_GATE_COUNT} Gates)`;

const INLINE_WORKFLOW_FRONTMATTER = `inlineWorkflow:
  id: ${INLINE_WORKFLOW_ID}
  name: Bespoke Inline E2E
  description: Inline workflow seeded through a goal proposal draft.
  gates:
    - id: issue-analysis
      name: Issue Analysis
      dependsOn: []
      verify:
        - name: issue-check
          type: command
          run: echo issue
    - id: implementation
      name: Implementation
      dependsOn:
        - issue-analysis
      verify:
        - name: implementation-check
          type: command
          run: echo implementation
    - id: ready-to-merge
      name: Ready to Merge
      dependsOn:
        - implementation
      verify:
        - name: merge-check
          type: command
          run: echo merge`;

async function selectedOptionText(locator: Locator): Promise<string> {
	return locator.evaluate((el) => {
		const select = el as HTMLSelectElement;
		return (select.selectedOptions.item(0)?.textContent ?? "").trim();
	});
}

async function seedInlineWorkflowGoalProposal(sessionId: string): Promise<void> {
	const seedResp = await apiFetch(`/api/sessions/${sessionId}/proposal/goal/seed`, {
		method: "POST",
		body: JSON.stringify({
			args: {
				title: "Inline Workflow Label Goal",
				workflow: "general",
				spec: "A goal proposal whose workflow is replaced with an inline workflow draft.",
			},
		}),
	});
	const seedText = await seedResp.text();
	expect(seedResp.status, `seed initial goal proposal: ${seedText}`).toBe(200);

	const editResp = await apiFetch(`/api/sessions/${sessionId}/proposal/goal/edit`, {
		method: "POST",
		body: JSON.stringify({
			old_text: "workflow: general",
			new_text: `workflow: ${INLINE_WORKFLOW_ID}\n${INLINE_WORKFLOW_FRONTMATTER}`,
		}),
	});
	const editText = await editResp.text();
	expect(editResp.status, `replace library workflow with inline workflow: ${editText}`).toBe(200);
}

/** The harness may default subgoals on/off; the Workflow tab is independent. */
async function ensureSubgoals(value: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: value }),
	});
	expect(resp.status).toBe(200);
}

test.describe("Goal proposal — Workflow tab", () => {
	test.afterEach(async () => { await ensureSubgoals(true); });

	test("inline workflow proposals show a Bespoke selected option in both workflow pickers", async ({ page }) => {
		test.setTimeout(90_000);
		await ensureSubgoals(true);
		await openApp(page);
		const sessionId = await createSessionViaUI(page);
		await seedInlineWorkflowGoalProposal(sessionId);
		// Reload so the UI rehydrates from the server-side draft after the edit;
		// otherwise the live proposal merge may preserve the initial library workflow id.
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("Inline Workflow Label Goal", { timeout: 10_000 });
		await expect.poll(
			() => page.evaluate(() => {
				const fields = (window as any).bobbitState?.activeProposals?.goal?.fields;
				return {
					workflow: fields?.workflow ?? null,
					inlineId: fields?.inlineWorkflow?.id ?? null,
					gateCount: fields?.inlineWorkflow?.gates?.length ?? 0,
				};
			}),
			{ timeout: 10_000, message: "inline workflow proposal should hydrate with an inline workflow id" },
		).toEqual({ workflow: INLINE_WORKFLOW_ID, inlineId: INLINE_WORKFLOW_ID, gateCount: INLINE_WORKFLOW_GATE_COUNT });

		const goalSelect = page.locator("[data-testid='goal-proposal-panel-goal'] select").first();
		await expect(goalSelect).toBeVisible({ timeout: 10_000 });
		const goalInitialLabel = await selectedOptionText(goalSelect);
		const goalInitialValue = await goalSelect.inputValue();

		await page.locator("[data-testid='goal-proposal-tab-workflow']").click();
		const workflowSelect = page.locator("[data-testid='goal-proposal-workflow-select']");
		await expect(workflowSelect).toBeVisible({ timeout: 10_000 });

		const initialLabels = {
			goal: goalInitialLabel,
			workflow: await selectedOptionText(workflowSelect),
			goalValue: goalInitialValue,
			workflowValue: await workflowSelect.inputValue(),
		};
		expect(
			initialLabels,
			"BESPOKE_INLINE_WORKFLOW_LABEL: Goal and Workflow tab selects must show the inline workflow as Bespoke (N Gates)",
		).toEqual({
			goal: INLINE_WORKFLOW_LABEL,
			workflow: INLINE_WORKFLOW_LABEL,
			goalValue: INLINE_WORKFLOW_ID,
			workflowValue: INLINE_WORKFLOW_ID,
		});

		// The inline workflow editor supports adding gates; the selected Bespoke
		// label should track the draft gate count before the proposal is accepted.
		await expect(page.locator("[data-testid='workflow-editor']")).toBeVisible({ timeout: 10_000 });
		await page.getByRole("button", { name: /Add Gate/i }).click();
		const updatedLabel = `Bespoke (${INLINE_WORKFLOW_GATE_COUNT + 1} Gates)`;
		await expect.poll(
			() => selectedOptionText(workflowSelect),
			{ timeout: 5_000, message: "BESPOKE_INLINE_WORKFLOW_LABEL_UPDATE: Workflow tab label must update after Add Gate" },
		).toBe(updatedLabel);
		await page.locator("[data-testid='goal-proposal-tab-goal']").click();
		await expect(goalSelect).toBeVisible({ timeout: 5_000 });
		const goalUpdatedLabel = await selectedOptionText(goalSelect);
		await page.locator("[data-testid='goal-proposal-tab-workflow']").click();
		await expect(workflowSelect).toBeVisible({ timeout: 5_000 });
		expect(
			{
				goal: goalUpdatedLabel,
				workflow: await selectedOptionText(workflowSelect),
			},
			"BESPOKE_INLINE_WORKFLOW_LABEL_UPDATE: Bespoke label must reflect edited inline gate count",
		).toEqual({ goal: updatedLabel, workflow: updatedLabel });
	});

	test("inline workflow proposals remain creatable when the workflow cache is empty", async ({ page }) => {
		test.setTimeout(90_000);
		let workflowListRequests = 0;
		await page.route(/\/api\/workflows(?:\?.*)?$/, async (route, req) => {
			if (req.method() === "GET") {
				workflowListRequests += 1;
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ workflows: [] }),
				});
				return;
			}
			await route.continue();
		});

		await ensureSubgoals(true);
		await openApp(page);
		const sessionId = await createSessionViaUI(page);
		await seedInlineWorkflowGoalProposal(sessionId);
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("Inline Workflow Label Goal", { timeout: 10_000 });
		await expect.poll(
			() => page.evaluate(() => {
				const fields = (window as any).bobbitState?.activeProposals?.goal?.fields;
				return {
					workflow: fields?.workflow ?? null,
					inlineId: fields?.inlineWorkflow?.id ?? null,
					gateCount: fields?.inlineWorkflow?.gates?.length ?? 0,
				};
			}),
			{ timeout: 10_000, message: "inline workflow proposal should hydrate while workflow cache is empty" },
		).toEqual({ workflow: INLINE_WORKFLOW_ID, inlineId: INLINE_WORKFLOW_ID, gateCount: INLINE_WORKFLOW_GATE_COUNT });
		await expect.poll(() => workflowListRequests, { timeout: 10_000 }).toBeGreaterThan(0);

		const goalSelect = page.locator("[data-testid='goal-proposal-panel-goal'] select").first();
		await expect(goalSelect).toBeVisible({ timeout: 10_000 });
		const goalLabel = await selectedOptionText(goalSelect);
		const goalValue = await goalSelect.inputValue();
		expect(
			goalLabel,
			"BESPOKE_INLINE_WORKFLOW_EMPTY_CACHE_LABEL: Goal tab must render the inline workflow option even with an empty project workflow cache",
		).toBe(INLINE_WORKFLOW_LABEL);
		await expect(page.locator("[data-testid='goal-form-no-workflows-banner']")).toHaveCount(0);

		await page.locator("[data-testid='goal-proposal-tab-workflow']").click();
		const workflowSelect = page.locator("[data-testid='goal-proposal-workflow-select']");
		await expect(workflowSelect).toBeVisible({ timeout: 10_000 });
		expect(
			{
				goal: goalLabel,
				workflow: await selectedOptionText(workflowSelect),
				goalValue,
				workflowValue: await workflowSelect.inputValue(),
			},
			"BESPOKE_INLINE_WORKFLOW_EMPTY_CACHE_LABEL: Goal and Workflow tabs must agree when project workflows are empty",
		).toEqual({
			goal: INLINE_WORKFLOW_LABEL,
			workflow: INLINE_WORKFLOW_LABEL,
			goalValue: INLINE_WORKFLOW_ID,
			workflowValue: INLINE_WORKFLOW_ID,
		});

		await page.locator("[data-testid='goal-proposal-tab-goal']").click();
		const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
		await expect(createBtn).toBeVisible({ timeout: 5_000 });
		await expect(createBtn, "inline workflow proposals should not be disabled by the empty-workflows guard").toBeEnabled();

		const createPromise = page.waitForResponse(
			(resp) => resp.url().includes("/api/goals") && resp.request().method() === "POST",
			{ timeout: 15_000 },
		).catch((err: Error) => err);
		await createBtn.click();
		await expect(
			page.getByText("This project has no workflows yet").first(),
			"BESPOKE_INLINE_WORKFLOW_EMPTY_CACHE_SUBMIT: Create Goal must not be blocked by the empty-workflows guard when an inline workflow is present",
		).not.toBeVisible({ timeout: 1_000 });
		const createResp = await createPromise;
		if (createResp instanceof Error) throw createResp;
		const body = createResp.request().postDataJSON?.() ?? JSON.parse(createResp.request().postData() || "{}");
		expect(
			body,
			"BESPOKE_INLINE_WORKFLOW_EMPTY_CACHE_SUBMIT: Create Goal must submit the inline workflow body instead of a workflowId",
		).toMatchObject({
			workflow: {
				id: INLINE_WORKFLOW_ID,
				gates: expect.arrayContaining([
					expect.objectContaining({ id: "issue-analysis" }),
					expect.objectContaining({ id: "implementation" }),
					expect.objectContaining({ id: "ready-to-merge" }),
				]),
			},
		});
		expect(body.workflow.gates).toHaveLength(INLINE_WORKFLOW_GATE_COUNT);
		expect(body.workflowId).toBeUndefined();
		expect(createResp.status()).toBe(201);
		const created = await createResp.json();
		expect(created?.id).toBeTruthy();
		await deleteGoal(created.id);
	});

	test("customise/revert toggle drives the editor, and the select syncs with the Goal tab @smoke", async ({ page }) => {
		await ensureSubgoals(true);
		await openApp(page);
		await createSessionViaUI(page);

		// Mock agent emits a propose_goal titled "E2E Test Goal".
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		// --- Navigation: open the Workflow tab. ---
		const workflowTab = page.locator("[data-testid='goal-proposal-tab-workflow']");
		await expect(workflowTab).toBeVisible({ timeout: 10_000 });
		await workflowTab.click();

		const select = page.locator("[data-testid='goal-proposal-workflow-select']");
		await expect(select).toBeVisible({ timeout: 10_000 });
		// The old left-hand workflow list must be gone.
		await expect(page.locator("[data-testid='goal-proposal-panel-workflow'] .wf-row")).toHaveCount(0);

		const customise = page.locator("[data-testid='goal-proposal-workflow-customize']");
		await expect(customise).toBeVisible({ timeout: 10_000 });
		await expect(customise).toHaveText("Customise for this goal");

		// --- Happy path: Customise → editor + Revert button. ---
		await customise.click();
		const revert = page.locator("[data-testid='goal-proposal-workflow-reset']");
		await expect(revert).toBeVisible({ timeout: 10_000 });
		await expect(revert).toHaveText("Revert to project definition");
		// The Customise button is no longer shown while customising.
		await expect(page.locator("[data-testid='goal-proposal-workflow-customize']")).toHaveCount(0);

		// --- Cleanup/undo: Revert → back to inspector + Customise button. ---
		await revert.click();
		await expect(page.locator("[data-testid='goal-proposal-workflow-customize']"))
			.toBeVisible({ timeout: 10_000 });
		await expect(page.locator("[data-testid='goal-proposal-workflow-reset']")).toHaveCount(0);

		// --- Sync: the Workflow-tab select shares _proposalWorkflowId with the
		// Goal tab, so its value survives a round-trip through the Goal tab. ---
		const tabValue = await select.inputValue();
		await page.locator("[data-testid='goal-proposal-tab-goal']").click();
		await expect(page.locator("[data-testid='goal-proposal-panel-goal']"))
			.toBeVisible({ timeout: 5_000 });
		await page.locator("[data-testid='goal-proposal-tab-workflow']").click();
		await expect(select).toHaveValue(tabValue, { timeout: 5_000 });
	});
});
