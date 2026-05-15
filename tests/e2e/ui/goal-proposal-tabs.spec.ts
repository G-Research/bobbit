/**
 * Browser E2E — Goal proposal modal Goal / Workflow / Roles tabs.
 *
 * This spec pins the runtime contract of the tabbed proposal modal that
 * replaces the silently-dropped raw-YAML `<details>` editors (regression
 * `46e21256`). The corresponding source pins live in
 * `tests/source-pin-merge-invariants.test.ts`; this spec covers the live
 * UX surface and submit semantics.
 *
 * Acceptance coverage:
 *   1. Modal renders the three tabs (`goal-proposal-tab-goal/workflow/roles`)
 *      and the matching `goal-proposal-panel-*` `role="tabpanel"`s, with
 *      `aria-selected` switching on click. Tab state persists across
 *      re-renders (the parent picker change triggers a renderApp()).
 *   2. Workflow tab list selection is bidirectionally bound to the Goal
 *      tab's `<select>` workflow picker.
 *   3. Workflow tab inspector uses the SHARED renderer from workflow-page
 *      (`data-testid="workflow-inspector"` is the shared parity hook; the
 *      same export is consumed by both modal and Workflows page).
 *   4. Roles tab inspector uses the SHARED role renderer from
 *      role-manager-page (`data-testid="role-editor"` + `data-scope`
 *      reflects the goal-draft scope).
 *   5. Customising the workflow makes the createGoal POST body carry
 *      `workflow: {...}` (and omits `workflowId`).
 *   6. Customising a role makes the createGoal POST body carry an
 *      `inlineRoles` subset keyed by the role name.
 *   7. A proposal seeded with `inlineWorkflow` + `inlineRoles` hydrates
 *      into the Workflow/Roles tabs and survives a hard reload.
 *
 * Parity-DOM-equality limitation: the main Workflows page currently
 * mounts the EDITOR (`renderEditView`) when a workflow is selected, not
 * the read-only inspector. A full inner-HTML equality assertion across
 * the two surfaces is therefore not meaningful for the inspector — the
 * shared-renderer pin is enforced via the unique `data-testid` produced
 * by the single exported function. Source-pin tests cover the static
 * shape.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { apiFetch, createSession, deleteSession } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const SAMPLE_INLINE_WORKFLOW = {
	id: "modal-tabs-e2e-wf",
	name: "Modal Tabs E2E Workflow",
	description: "ephemeral workflow for proposal-modal tabs e2e",
	gates: [
		{ id: "gather", name: "Gather Inputs", dependsOn: [] },
		{ id: "review", name: "Review", dependsOn: ["gather"] },
		{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["review"] },
	],
};

const SAMPLE_INLINE_ROLES = {
	"coder": {
		name: "coder",
		label: "Coder (customized e2e)",
		accessory: "magnifying-glass",
		toolPolicies: { gate_signal: "never" },
		promptTemplate: "Customized coder for goal-draft scope. {{AGENT_ID}}",
	},
};

async function seedGoalProposal(
	sessionId: string,
	args: Record<string, unknown>,
): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/proposal/goal/seed`, {
		method: "POST",
		body: JSON.stringify({ args }),
	});
	expect(resp.status, "seed proposal must succeed").toBe(200);
	const body = await resp.json();
	expect(body.ok).toBe(true);
}

async function openSession(page: Page, sessionId: string): Promise<void> {
	await openApp(page);
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

async function waitForProposalForm(page: Page, expectedTitle: string): Promise<void> {
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 15_000 });
	await expect(titleInput).toHaveValue(expectedTitle, { timeout: 10_000 });
}

async function findGoalByTitle(title: string): Promise<any | undefined> {
	const resp = await apiFetch("/api/goals");
	const data = await resp.json();
	const goals = data.goals || data;
	return (goals as any[]).find((g: any) => g.title === title);
}

async function deleteGoalIfExists(goalId: string | undefined): Promise<void> {
	if (!goalId) return;
	await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => {});
}

test.describe("Proposal modal tabs — Goal / Workflow / Roles", () => {
	test("three tabs render with correct testids/roles, click switches aria-selected, state persists across re-render", async ({ page }) => {
		test.setTimeout(60_000);
		const title = `Modal tabs render ${Date.now()}`;
		const sessionId = await createSession();
		try {
			await seedGoalProposal(sessionId, {
				title,
				spec: "Verify three tabs render and selection persists.",
			});
			await openSession(page, sessionId);
			await waitForProposalForm(page, title);

			const goalTab = page.locator("[data-testid='goal-proposal-tab-goal']").first();
			const wfTab = page.locator("[data-testid='goal-proposal-tab-workflow']").first();
			const rolesTab = page.locator("[data-testid='goal-proposal-tab-roles']").first();
			await expect(goalTab).toBeVisible();
			await expect(wfTab).toBeVisible();
			await expect(rolesTab).toBeVisible();

			// Tablist + initial aria state.
			await expect(page.locator("[role='tablist'][aria-label='Goal proposal sections']").first())
				.toBeVisible();
			await expect(goalTab).toHaveAttribute("aria-selected", "true");
			await expect(wfTab).toHaveAttribute("aria-selected", "false");
			await expect(rolesTab).toHaveAttribute("aria-selected", "false");

			// Goal panel is the visible tabpanel.
			await expect(page.locator("[data-testid='goal-proposal-panel-goal']").first()).toBeVisible();

			// Switch to Workflow tab.
			await wfTab.click();
			await expect(wfTab).toHaveAttribute("aria-selected", "true");
			await expect(goalTab).toHaveAttribute("aria-selected", "false");
			const wfPanel = page.locator("[data-testid='goal-proposal-panel-workflow']").first();
			await expect(wfPanel).toBeVisible();
			await expect(wfPanel).toHaveAttribute("role", "tabpanel");

			// Trigger a re-render via the Goal-tab–owned title change.
			// The active tab must remain Workflow.
			await goalTab.click();
			const titleInput = page.locator("input[placeholder='Goal title']").first();
			await titleInput.fill(title + " edited");
			await wfTab.click();
			await expect(wfTab).toHaveAttribute("aria-selected", "true");
			// Force a state change by toggling auto-start; tab must persist.
			const autoStart = page.locator("[data-testid='goal-form-auto-start']").first();
			if (await autoStart.count() > 0) await autoStart.click();
			await expect(wfTab).toHaveAttribute("aria-selected", "true");
			await expect(wfPanel).toBeVisible();

			// Switch to Roles tab.
			await rolesTab.click();
			await expect(rolesTab).toHaveAttribute("aria-selected", "true");
			await expect(wfTab).toHaveAttribute("aria-selected", "false");
			const rolesPanel = page.locator("[data-testid='goal-proposal-panel-roles']").first();
			await expect(rolesPanel).toBeVisible();
			await expect(rolesPanel).toHaveAttribute("role", "tabpanel");

			// Footer Dismiss/Create remain visible on every tab.
			await expect(page.locator("button").filter({ hasText: "Create Goal" }).first()).toBeVisible();
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("workflow tab list selection is bidirectionally bound to Goal-tab workflow picker", async ({ page }) => {
		test.setTimeout(60_000);
		const title = `Modal tabs wf binding ${Date.now()}`;
		const sessionId = await createSession();
		try {
			await seedGoalProposal(sessionId, {
				title,
				spec: "Workflow picker binding test.",
			});
			await openSession(page, sessionId);
			await waitForProposalForm(page, title);

			// Need at least 2 workflows for the binding to be meaningful.
			const wfPicker = page.locator("[data-testid='goal-proposal-panel-goal'] select").first();
			await expect(wfPicker).toBeVisible({ timeout: 10_000 });
			const wfIds: string[] = await wfPicker.evaluate((el: HTMLSelectElement) =>
				Array.from(el.options).map(o => o.value),
			);
			test.skip(wfIds.length < 2, "Need at least two workflows for binding test");

			const initialSelected = await wfPicker.inputValue();
			const otherId = wfIds.find((v) => v !== initialSelected)!;

			// Switch to Workflow tab and click the OTHER workflow row.
			await page.locator("[data-testid='goal-proposal-tab-workflow']").first().click();
			const wfPanel = page.locator("[data-testid='goal-proposal-panel-workflow']").first();
			await expect(wfPanel).toBeVisible();

			const otherRow = wfPanel.locator(`.wf-row[data-workflow-id='${otherId}']`).first();
			await expect(otherRow).toBeVisible({ timeout: 5_000 });
			await otherRow.click();

			// Inspector should now reflect the new workflow id.
			await expect(
				wfPanel.locator("[data-testid='workflow-inspector']").first(),
			).toHaveAttribute("data-workflow-id", otherId);

			// Goal-tab picker must now reflect the new selection.
			await page.locator("[data-testid='goal-proposal-tab-goal']").first().click();
			await expect(wfPicker).toHaveValue(otherId);

			// Now drive the opposite direction: change picker to initial,
			// confirm the Workflow tab row highlight reflects it.
			await wfPicker.selectOption(initialSelected);
			await page.locator("[data-testid='goal-proposal-tab-workflow']").first().click();
			await expect(
				wfPanel.locator("[data-testid='workflow-inspector']").first(),
			).toHaveAttribute("data-workflow-id", initialSelected);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("workflow inspector uses the shared renderer (parity hook)", async ({ page }) => {
		test.setTimeout(60_000);
		const title = `Modal workflow inspector ${Date.now()}`;
		const sessionId = await createSession();
		try {
			await seedGoalProposal(sessionId, { title, spec: "Inspector parity hook." });
			await openSession(page, sessionId);
			await waitForProposalForm(page, title);

			await page.locator("[data-testid='goal-proposal-tab-workflow']").first().click();
			const wfPanel = page.locator("[data-testid='goal-proposal-panel-workflow']").first();
			await expect(wfPanel).toBeVisible();

			const inspector = wfPanel.locator("[data-testid='workflow-inspector']").first();
			await expect(inspector).toBeVisible({ timeout: 10_000 });

			// Inspector exposes the canonical shared-renderer DOM hooks.
			await expect(inspector).toHaveClass(/wf-inspector/);
			const wfId = await inspector.getAttribute("data-workflow-id");
			expect(wfId, "data-workflow-id must be set").toBeTruthy();
			// Picker on Goal tab must agree on the workflow id.
			await page.locator("[data-testid='goal-proposal-tab-goal']").first().click();
			const wfPicker = page.locator("[data-testid='goal-proposal-panel-goal'] select").first();
			expect(await wfPicker.inputValue()).toBe(wfId);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("role inspector uses the shared renderer (parity hook) and reflects goal-draft scope", async ({ page }) => {
		test.setTimeout(60_000);
		const title = `Modal role inspector ${Date.now()}`;
		const sessionId = await createSession();
		try {
			await seedGoalProposal(sessionId, { title, spec: "Role inspector parity hook." });
			await openSession(page, sessionId);
			await waitForProposalForm(page, title);

			await page.locator("[data-testid='goal-proposal-tab-roles']").first().click();
			const rolesPanel = page.locator("[data-testid='goal-proposal-panel-roles']").first();
			await expect(rolesPanel).toBeVisible();

			// Wait for role list to populate (the modal lazy-loads /api/roles).
			const firstRow = rolesPanel.locator(".role-row").first();
			await expect(firstRow).toBeVisible({ timeout: 15_000 });

			// Pick a known role row.
			const roleName = await firstRow.getAttribute("data-role-name");
			expect(roleName, "first role row must have data-role-name").toBeTruthy();
			await firstRow.click();

			// Inspector is the shared `renderRoleEditor` with readOnly=true,
			// exposed via data-testid="role-editor" + data-scope="goal-draft".
			const inspector = rolesPanel.locator("[data-testid='role-editor']").first();
			await expect(inspector).toBeVisible({ timeout: 10_000 });
			await expect(inspector).toHaveAttribute("data-scope", "goal-draft");
			await expect(inspector).toHaveAttribute("data-role-name", roleName!);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("role inspector tabs are interactive: Prompt / Tool Access / Model can be switched read-only", async ({ page }) => {
		test.setTimeout(60_000);
		const title = `Modal role inspector tabs ${Date.now()}`;
		const sessionId = await createSession();
		try {
			await seedGoalProposal(sessionId, { title, spec: "Role inspector tabs interactive." });
			await openSession(page, sessionId);
			await waitForProposalForm(page, title);

			await page.locator("[data-testid='goal-proposal-tab-roles']").first().click();
			const rolesPanel = page.locator("[data-testid='goal-proposal-panel-roles']").first();
			await expect(rolesPanel).toBeVisible();

			const firstRow = rolesPanel.locator(".role-row").first();
			await expect(firstRow).toBeVisible({ timeout: 15_000 });
			await firstRow.click();

			const inspector = rolesPanel.locator("[data-testid='role-editor']").first();
			await expect(inspector).toBeVisible({ timeout: 10_000 });

			// Initially the Prompt tab is active.
			const promptTab = inspector.locator(".roles-tab", { hasText: "Prompt" }).first();
			const toolsTab = inspector.locator(".roles-tab", { hasText: "Tool Access" }).first();
			const modelTab = inspector.locator("[data-testid='roles-tab-model']").first();
			await expect(promptTab).toHaveClass(/roles-tab--active/);

			// Click Tool Access: active class moves, tool list becomes visible.
			await toolsTab.click();
			await expect(toolsTab).toHaveClass(/roles-tab--active/);
			await expect(promptTab).not.toHaveClass(/roles-tab--active/);
			await expect(inspector.locator(".roles-access-list").first()).toBeVisible();
			// All tool-access selects are disabled in the read-only inspector.
			const firstSelect = inspector.locator(".roles-access-row-select").first();
			if (await firstSelect.count() > 0) {
				await expect(firstSelect).toBeDisabled();
			}

			// Click Model: model tab content renders.
			await modelTab.click();
			await expect(modelTab).toHaveClass(/roles-tab--active/);
			await expect(toolsTab).not.toHaveClass(/roles-tab--active/);
			await expect(inspector.locator("[data-testid='roles-model-tab']").first()).toBeVisible();

			// Back to Prompt: textarea is read-only (cannot mutate).
			await promptTab.click();
			await expect(promptTab).toHaveClass(/roles-tab--active/);
			const promptEditor = inspector.locator(".roles-prompt-editor").first();
			await expect(promptEditor).toBeVisible();
			await expect(promptEditor).toHaveAttribute("readonly", "");
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("workflow inspector and editor share gate markup (single renderer path)", async ({ page }) => {
		test.setTimeout(90_000);
		const title = `Modal wf parity ${Date.now()}`;
		const sessionId = await createSession();
		try {
			await seedGoalProposal(sessionId, { title, spec: "Workflow inspector / editor parity." });
			await openSession(page, sessionId);
			await waitForProposalForm(page, title);

			await page.locator("[data-testid='goal-proposal-tab-workflow']").first().click();
			const wfPanel = page.locator("[data-testid='goal-proposal-panel-workflow']").first();
			await expect(wfPanel).toBeVisible();
			const inspector = wfPanel.locator("[data-testid='workflow-inspector']").first();
			await expect(inspector).toBeVisible({ timeout: 10_000 });

			// 1) The inspector must render gate cards via the SHARED renderer
			//    (`renderGateEditor`) — canonical `.wf-gate-card` class, not a
			//    forked hand-rolled fragment. Inspector inputs are disabled.
			const inspectorGates = inspector.locator(".wf-gate-card");
			const inspectorCount = await inspectorGates.count();
			expect(inspectorCount, "inspector must render shared .wf-gate-card markup").toBeGreaterThan(0);
			// Inspector identity inputs (Name field) are disabled.
			const inspectorName = inspector.locator(".wf-edit-identity input.wf-input").nth(1);
			if (await inspectorName.count() > 0) {
				await expect(inspectorName).toBeDisabled();
			}
			const inspectorNames: string[] = [];
			for (let i = 0; i < inspectorCount; i++) {
				const nm = (await inspectorGates.nth(i).locator(".wf-gate-name").first().textContent()) || "";
				inspectorNames.push(nm.trim());
			}
			const inspectorWfId = await inspector.getAttribute("data-workflow-id");
			expect(inspectorWfId).toBeTruthy();

			// 2) Customize → same workflow, same shared renderer (renderEditView),
			//    but readOnly:false. testid flips to `workflow-editor`. The gate
			//    name sequence must be byte-identical — proving both surfaces
			//    share a single rendering path.
			const customizeBtn = wfPanel.locator("[data-testid='goal-proposal-workflow-customize']").first();
			await expect(customizeBtn).toBeVisible({ timeout: 10_000 });
			await customizeBtn.click();
			const editor = wfPanel.locator("[data-testid='workflow-editor']").first();
			await expect(editor).toBeVisible({ timeout: 5_000 });
			const editorGates = editor.locator(".wf-gate-card");
			await expect(editorGates.first()).toBeVisible({ timeout: 5_000 });
			const editorCount = await editorGates.count();
			expect(editorCount, "editor must render shared .wf-gate-card markup").toBe(inspectorCount);
			const editorNames: string[] = [];
			for (let i = 0; i < editorCount; i++) {
				const nm = (await editorGates.nth(i).locator(".wf-gate-name").first().textContent()) || "";
				editorNames.push(nm.trim());
			}
			expect(editorNames, "gate name sequence must match across inspector and editor (shared renderer)")
				.toEqual(inspectorNames);
			// In edit mode, identity inputs must be enabled (single renderer
			// honours the readOnly flag).
			const editorName = editor.locator(".wf-edit-identity input.wf-input").nth(1);
			if (await editorName.count() > 0) {
				await expect(editorName).toBeEnabled();
			}

			// 3) Reset → back to inspector. Same gate names again, testid flips
			//    back to workflow-inspector. Confirms the renderer is genuinely
			//    the same code path — only the readOnly bit differs.
			const resetBtn = wfPanel.locator("[data-testid='goal-proposal-workflow-reset']").first();
			await resetBtn.click();
			const inspector2 = wfPanel.locator("[data-testid='workflow-inspector']").first();
			await expect(inspector2).toBeVisible({ timeout: 5_000 });
			await expect(inspector2).toHaveAttribute("data-workflow-id", inspectorWfId!);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("customising the workflow sends `workflow` (not just workflowId) on createGoal", async ({ page }) => {
		test.setTimeout(60_000);
		const title = `Modal wf custom ${Date.now()}`;
		const sessionId = await createSession();
		let createdGoalId: string | undefined;
		try {
			await seedGoalProposal(sessionId, { title, spec: "Customize workflow → inline." });
			await openSession(page, sessionId);
			await waitForProposalForm(page, title);

			await page.locator("[data-testid='goal-proposal-tab-workflow']").first().click();
			const wfPanel = page.locator("[data-testid='goal-proposal-panel-workflow']").first();
			await expect(wfPanel).toBeVisible();

			// Click Customize.
			const customizeBtn = wfPanel
				.locator("[data-testid='goal-proposal-workflow-customize']")
				.first();
			await expect(customizeBtn).toBeVisible({ timeout: 10_000 });
			await customizeBtn.click();

			// Editor mounts; Reset button replaces Customize.
			await expect(
				wfPanel.locator("[data-testid='goal-proposal-workflow-reset']").first(),
			).toBeVisible({ timeout: 5_000 });
			await expect(
				wfPanel.locator("[data-testid='workflow-editor']").first(),
			).toBeVisible({ timeout: 5_000 });

			// Intercept POST /api/goals to capture the body.
			let captured: any = null;
			page.on("request", (req) => {
				if (
					req.url().includes("/api/goals") &&
					!req.url().includes("/api/goals/") &&
					req.method() === "POST"
				) {
					try { captured = JSON.parse(req.postData() || "null"); } catch {}
				}
			});

			const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
			await expect(createBtn).toBeEnabled({ timeout: 5_000 });
			const respPromise = page.waitForResponse(
				resp => resp.url().includes("/api/goals")
					&& resp.request().method() === "POST"
					&& resp.ok(),
				{ timeout: 20_000 },
			);
			await createBtn.click();
			await respPromise;

			expect(captured, "POST /api/goals body must be captured").toBeTruthy();
			expect(captured.workflow, "customised workflow must be inlined").toBeTruthy();
			expect(typeof captured.workflow).toBe("object");
			expect(captured.workflow.id, "inline workflow must carry an id").toBeTruthy();
			// When workflow is inlined, workflowId is omitted.
			expect(captured.workflowId, "workflowId omitted when workflow inlined").toBeFalsy();

			// Cleanup.
			await expect.poll(
				async () => (await findGoalByTitle(title))?.id,
				{ timeout: 10_000 },
			).toBeTruthy();
			createdGoalId = (await findGoalByTitle(title))?.id;
		} finally {
			await deleteGoalIfExists(createdGoalId);
			await deleteSession(sessionId);
		}
	});

	test("customising a role sends `inlineRoles` subset on createGoal", async ({ page }) => {
		test.setTimeout(60_000);
		const title = `Modal role custom ${Date.now()}`;
		const sessionId = await createSession();
		let createdGoalId: string | undefined;
		try {
			await seedGoalProposal(sessionId, { title, spec: "Customize role → inlineRoles subset." });
			await openSession(page, sessionId);
			await waitForProposalForm(page, title);

			await page.locator("[data-testid='goal-proposal-tab-roles']").first().click();
			const rolesPanel = page.locator("[data-testid='goal-proposal-panel-roles']").first();
			await expect(rolesPanel).toBeVisible();

			const firstRow = rolesPanel.locator(".role-row").first();
			await expect(firstRow).toBeVisible({ timeout: 15_000 });
			const roleName = await firstRow.getAttribute("data-role-name");
			expect(roleName).toBeTruthy();
			await firstRow.click();

			// Click "Customize for this goal".
			const customizeBtn = rolesPanel
				.locator("[data-testid='goal-proposal-role-customize']")
				.first();
			await expect(customizeBtn).toBeVisible({ timeout: 10_000 });
			await customizeBtn.click();
			await expect(
				rolesPanel.locator("[data-testid='goal-proposal-role-reset']").first(),
			).toBeVisible({ timeout: 5_000 });

			// Row should mark itself customized.
			await expect(
				rolesPanel.locator(`.role-row[data-role-name='${roleName}'].role-row--customized`).first(),
			).toBeVisible({ timeout: 5_000 });

			// Intercept POST /api/goals.
			let captured: any = null;
			page.on("request", (req) => {
				if (
					req.url().includes("/api/goals") &&
					!req.url().includes("/api/goals/") &&
					req.method() === "POST"
				) {
					try { captured = JSON.parse(req.postData() || "null"); } catch {}
				}
			});

			const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
			await expect(createBtn).toBeEnabled({ timeout: 5_000 });
			const respPromise = page.waitForResponse(
				resp => resp.url().includes("/api/goals")
					&& resp.request().method() === "POST"
					&& resp.ok(),
				{ timeout: 20_000 },
			);
			await createBtn.click();
			await respPromise;

			expect(captured, "POST /api/goals body must be captured").toBeTruthy();
			expect(captured.inlineRoles, "inlineRoles must be forwarded").toBeTruthy();
			expect(typeof captured.inlineRoles).toBe("object");
			expect(Object.keys(captured.inlineRoles)).toContain(roleName!);
			// Subset semantics: only customised roles forwarded — not the
			// whole library.
			expect(Object.keys(captured.inlineRoles).length).toBeLessThan(50);

			await expect.poll(
				async () => (await findGoalByTitle(title))?.id,
				{ timeout: 10_000 },
			).toBeTruthy();
			createdGoalId = (await findGoalByTitle(title))?.id;
		} finally {
			await deleteGoalIfExists(createdGoalId);
			await deleteSession(sessionId);
		}
	});

	test("seeded inlineWorkflow + inlineRoles hydrate into tabs and survive reload", async ({ page }) => {
		test.setTimeout(90_000);
		const title = `Modal inline hydrate ${Date.now()}`;
		const sessionId = await createSession();
		try {
			await seedGoalProposal(sessionId, {
				title,
				spec: "Hydrate inlineWorkflow + inlineRoles into tabs and survive reload.",
				inlineWorkflow: SAMPLE_INLINE_WORKFLOW,
				inlineRoles: SAMPLE_INLINE_ROLES,
			});
			await openSession(page, sessionId);
			await waitForProposalForm(page, title);

			// Workflow tab: editor should already be open (customised),
			// inspector replaced. Reset button present.
			await page.locator("[data-testid='goal-proposal-tab-workflow']").first().click();
			const wfPanel = page.locator("[data-testid='goal-proposal-panel-workflow']").first();
			await expect(wfPanel).toBeVisible();
			await expect(
				wfPanel.locator("[data-testid='goal-proposal-workflow-reset']").first(),
			).toBeVisible({ timeout: 10_000 });
			await expect(
				wfPanel.locator("[data-testid='workflow-editor']").first(),
			).toBeVisible({ timeout: 5_000 });

			// Roles tab: the customised role row carries the customized marker
			// and the inspector reflects goal-draft scope.
			await page.locator("[data-testid='goal-proposal-tab-roles']").first().click();
			const rolesPanel = page.locator("[data-testid='goal-proposal-panel-roles']").first();
			await expect(rolesPanel).toBeVisible();
			await expect(
				rolesPanel.locator(".role-row[data-role-name='coder'].role-row--customized").first(),
			).toBeVisible({ timeout: 15_000 });

			// Hard reload — modal state must rehydrate from the persisted
			// proposal draft.
			await page.reload();
			await waitForProposalForm(page, title);

			await page.locator("[data-testid='goal-proposal-tab-workflow']").first().click();
			await expect(
				page.locator("[data-testid='goal-proposal-panel-workflow'] [data-testid='goal-proposal-workflow-reset']").first(),
			).toBeVisible({ timeout: 15_000 });

			await page.locator("[data-testid='goal-proposal-tab-roles']").first().click();
			await expect(
				page.locator("[data-testid='goal-proposal-panel-roles'] .role-row[data-role-name='coder'].role-row--customized").first(),
			).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("switching the Goal-tab workflow picker after customizing clears the inline workflow (sends workflowId, not workflow)", async ({ page }) => {
		// Regression guard: previously, customising workflow A and then
		// changing the Goal-tab picker to B left `_proposalInlineWorkflow`
		// stale. Submit would ship the A-shaped inline workflow alongside
		// a workflowId that no longer matched. Picker change must reset the
		// customisation, matching the Workflow-tab list-select behaviour.
		test.setTimeout(60_000);
		const title = `Modal picker resets custom ${Date.now()}`;
		const sessionId = await createSession();
		let createdGoalId: string | undefined;
		try {
			await seedGoalProposal(sessionId, { title, spec: "Picker switch clears inline workflow." });
			await openSession(page, sessionId);
			await waitForProposalForm(page, title);

			const wfPicker = page.locator("[data-testid='goal-proposal-panel-goal'] select").first();
			await expect(wfPicker).toBeVisible({ timeout: 10_000 });
			const wfIds: string[] = await wfPicker.evaluate((el: HTMLSelectElement) =>
				Array.from(el.options).map(o => o.value),
			);
			test.skip(wfIds.length < 2, "Need at least two workflows for picker-reset test");
			const initialId = await wfPicker.inputValue();
			const otherId = wfIds.find((v) => v !== initialId)!;

			// Customize workflow A.
			await page.locator("[data-testid='goal-proposal-tab-workflow']").first().click();
			const wfPanel = page.locator("[data-testid='goal-proposal-panel-workflow']").first();
			await expect(wfPanel).toBeVisible();
			const customizeBtn = wfPanel.locator("[data-testid='goal-proposal-workflow-customize']").first();
			await expect(customizeBtn).toBeVisible({ timeout: 10_000 });
			await customizeBtn.click();
			await expect(
				wfPanel.locator("[data-testid='goal-proposal-workflow-reset']").first(),
			).toBeVisible({ timeout: 5_000 });
			await expect(
				wfPanel.locator("[data-testid='workflow-editor']").first(),
			).toBeVisible({ timeout: 5_000 });

			// Switch Goal-tab picker to B.
			await page.locator("[data-testid='goal-proposal-tab-goal']").first().click();
			await wfPicker.selectOption(otherId);
			await expect(wfPicker).toHaveValue(otherId);

			// Workflow tab should now show the (read-only) inspector for B
			// with Customize available again — NOT an editor for A.
			await page.locator("[data-testid='goal-proposal-tab-workflow']").first().click();
			await expect(
				wfPanel.locator("[data-testid='goal-proposal-workflow-customize']").first(),
			).toBeVisible({ timeout: 5_000 });
			await expect(
				wfPanel.locator("[data-testid='goal-proposal-workflow-reset']").first(),
			).toHaveCount(0);
			await expect(
				wfPanel.locator("[data-testid='workflow-editor']").first(),
			).toHaveCount(0);
			await expect(
				wfPanel.locator("[data-testid='workflow-inspector']").first(),
			).toHaveAttribute("data-workflow-id", otherId);

			// Submit and assert the payload carries workflowId B (not inline).
			let captured: any = null;
			page.on("request", (req) => {
				if (
					req.url().includes("/api/goals") &&
					!req.url().includes("/api/goals/") &&
					req.method() === "POST"
				) {
					try { captured = JSON.parse(req.postData() || "null"); } catch {}
				}
			});
			const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
			await expect(createBtn).toBeEnabled({ timeout: 5_000 });
			const respPromise = page.waitForResponse(
				resp => resp.url().includes("/api/goals")
					&& resp.request().method() === "POST"
					&& resp.ok(),
				{ timeout: 20_000 },
			);
			await createBtn.click();
			await respPromise;

			expect(captured, "POST /api/goals body must be captured").toBeTruthy();
			expect(captured.workflowId, "workflowId must reflect the newly-picked workflow").toBe(otherId);
			expect(captured.workflow, "stale inline workflow must NOT be forwarded").toBeFalsy();

			await expect.poll(
				async () => (await findGoalByTitle(title))?.id,
				{ timeout: 10_000 },
			).toBeTruthy();
			createdGoalId = (await findGoalByTitle(title))?.id;
		} finally {
			await deleteGoalIfExists(createdGoalId);
			await deleteSession(sessionId);
		}
	});

	test("role inspector Model tab is fully read-only — no picker / clear / test controls", async ({ page }) => {
		// Pin: when the role inspector is in readOnly mode, the Model tab
		// must render a static summary, NOT the editable renderModelRow
		// (which exposes a model picker, clear button, and Test action).
		test.setTimeout(60_000);
		const title = `Modal role model readonly ${Date.now()}`;
		const sessionId = await createSession();
		try {
			await seedGoalProposal(sessionId, { title, spec: "Role inspector Model tab read-only." });
			await openSession(page, sessionId);
			await waitForProposalForm(page, title);

			await page.locator("[data-testid='goal-proposal-tab-roles']").first().click();
			const rolesPanel = page.locator("[data-testid='goal-proposal-panel-roles']").first();
			await expect(rolesPanel).toBeVisible();

			const firstRow = rolesPanel.locator(".role-row").first();
			await expect(firstRow).toBeVisible({ timeout: 15_000 });
			await firstRow.click();

			const inspector = rolesPanel.locator("[data-testid='role-editor']").first();
			await expect(inspector).toBeVisible({ timeout: 10_000 });

			const modelTab = inspector.locator("[data-testid='roles-tab-model']").first();
			await modelTab.click();
			await expect(modelTab).toHaveClass(/roles-tab--active/);

			// Read-only summary present.
			await expect(
				inspector.locator("[data-testid='roles-model-readonly']").first(),
			).toBeVisible({ timeout: 5_000 });

			// No editable model-row controls inside the inspector's Model tab.
			await expect(
				inspector.locator("[data-testid='model-row']"),
			).toHaveCount(0);
		} finally {
			await deleteSession(sessionId);
		}
	});
});
