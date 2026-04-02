/**
 * E2E tests for workflow editor phase grouping and enhanced step fields.
 *
 * Covers:
 * - agent-qa verification type selection and UI behavior
 * - Phase grouping display with phase headers
 * - Optional checkbox and label field
 * - Add Phase button
 * - Save and reload persistence of all new fields
 * - Phase compaction on save
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const WF_ID = `test-wf-phases-${Date.now()}`;

/** Create a workflow with steps in multiple phases for testing. */
async function createTestWorkflow(overrides?: {
	id?: string;
	gates?: any[];
}): Promise<void> {
	const id = overrides?.id ?? WF_ID;
	const gates = overrides?.gates ?? [
		{
			id: "gate-1",
			name: "Gate 1",
			dependsOn: [],
			verify: [
				{ name: "Lint check", type: "command", run: "echo lint", phase: 0 },
				{ name: "Code review", type: "llm-review", prompt: "Review the code", phase: 0 },
				{ name: "Integration test", type: "command", run: "echo integration", phase: 1 },
			],
		},
	];
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({ id, name: "Test Phases Workflow", description: "For E2E testing", gates }),
	});
	expect(res.status).toBe(201);
}

/** Delete the test workflow (cleanup). */
async function deleteTestWorkflow(id?: string): Promise<void> {
	await apiFetch(`/api/workflows/${id ?? WF_ID}`, { method: "DELETE" }).catch(() => {});
}

/** Navigate to the workflow edit page and expand the first gate. */
async function navigateToEditAndExpandGate(page: import("@playwright/test").Page): Promise<void> {
	// Navigate to workflows list — this triggers loadWorkflowPageData()
	await navigateToHash(page, "#/workflows");
	// Wait for the test workflow row to appear in the list
	const wfRow = page.locator(".wf-row").filter({ hasText: "Test Phases Workflow" }).first();
	await expect(wfRow).toBeVisible({ timeout: 10_000 });
	// Click the row to enter edit mode
	await wfRow.click();
	// Wait for the edit form — the workflow name input
	await expect(page.locator("input[placeholder='Workflow name']").first()).toBeVisible({ timeout: 10_000 });
	// Expand the first gate by clicking its header
	const gateHeader = page.locator(".wf-gate-header").first();
	await gateHeader.click();
	// Wait for gate body to be visible
	await expect(page.locator(".wf-gate-body").first()).toBeVisible({ timeout: 5_000 });
}

test.describe("Workflow editor phases", () => {
	test.afterEach(async () => {
		await deleteTestWorkflow();
	});

	test("agent-qa type shows prompt textarea and hides run input", async ({ page }) => {
		await createTestWorkflow({
			gates: [
				{
					id: "gate-1",
					name: "Gate 1",
					dependsOn: [],
					verify: [
						{ name: "Test step", type: "command", run: "echo test", phase: 0 },
					],
				},
			],
		});
		await openApp(page);
		await navigateToEditAndExpandGate(page);

		// Expand the first verification step
		const stepHeader = page.locator(".wf-vstep-collapsed-header").first();
		await stepHeader.click();
		await expect(page.locator(".wf-vstep-body").first()).toBeVisible({ timeout: 5_000 });

		// Verify the step starts as "command" type with a run input visible
		const typeSelect = page.locator(".wf-vstep-body select.wf-select").first();
		await expect(typeSelect).toHaveValue("command");
		await expect(page.locator(".wf-vstep-body input[placeholder='Command to run...']").first()).toBeVisible();

		// Change the type to agent-qa
		await typeSelect.selectOption("agent-qa");

		// Verify the prompt textarea appears
		await expect(
			page.locator(".wf-vstep-body textarea[placeholder='QA test prompt...']").first(),
		).toBeVisible({ timeout: 5_000 });

		// Verify the command run input is no longer visible
		await expect(
			page.locator(".wf-vstep-body input[placeholder='Command to run...']").first(),
		).not.toBeVisible();

		// Verify the "Expect" select is not visible (only shown for command type)
		const expectSelects = page.locator(".wf-vstep-body").first().locator("select.wf-select");
		// There should only be 1 select now (the type select), not 2
		// The expect select should not be present for agent-qa
		const selectCount = await expectSelects.count();
		expect(selectCount).toBe(1); // only the type select
	});

	test("phase grouping displays phase headers", async ({ page }) => {
		await createTestWorkflow();
		await openApp(page);
		await navigateToEditAndExpandGate(page);

		// Verify phase group headers are visible
		const phaseHeaders = page.locator(".wf-phase-header");
		await expect(phaseHeaders.first()).toBeVisible({ timeout: 5_000 });

		// Should have Phase 0 and Phase 1 headers
		await expect(page.getByText("Phase 0", { exact: false }).first()).toBeVisible();
		await expect(page.getByText("Phase 1", { exact: false }).first()).toBeVisible();

		// Phase 0 should have 2 steps (Lint check, Code review)
		const phase0Group = page.locator(".wf-phase-group").first();
		const phase0Steps = phase0Group.locator(".wf-vstep-card");
		await expect(phase0Steps).toHaveCount(2);

		// Phase 1 should have 1 step (Integration test)
		const phase1Group = page.locator(".wf-phase-group").nth(1);
		const phase1Steps = phase1Group.locator(".wf-vstep-card");
		await expect(phase1Steps).toHaveCount(1);
	});

	test("optional checkbox shows label input and persists", async ({ page }) => {
		await createTestWorkflow({
			gates: [
				{
					id: "gate-1",
					name: "Gate 1",
					dependsOn: [],
					verify: [
						{ name: "QA step", type: "agent-qa", prompt: "Run QA", phase: 0 },
					],
				},
			],
		});
		await openApp(page);
		await navigateToEditAndExpandGate(page);

		// Expand the step
		const stepHeader = page.locator(".wf-vstep-collapsed-header").first();
		await stepHeader.click();
		await expect(page.locator(".wf-vstep-body").first()).toBeVisible({ timeout: 5_000 });

		// Find and check the Optional checkbox
		const optionalCheckbox = page.locator(".wf-vstep-optional-row input[type='checkbox']").first();
		await expect(optionalCheckbox).toBeVisible({ timeout: 5_000 });
		await optionalCheckbox.check();

		// Verify label input appears
		const labelInput = page.locator(".wf-vstep-optional-row input.wf-input").first();
		await expect(labelInput).toBeVisible({ timeout: 5_000 });

		// Type a label
		await labelInput.fill("Enable QA Testing");

		// Save the workflow
		const saveBtn = page.locator("button").filter({ hasText: "Save" }).first();
		await saveBtn.click();

		// Wait for save to complete (button re-enables or URL stays the same)
		await page.waitForResponse(
			resp => resp.url().includes("/api/workflows") && resp.ok(),
			{ timeout: 10_000 },
		);

		// Navigate away and back to verify persistence
		await navigateToHash(page, "#/workflows");
		await expect(page.locator(".wf-container")).toBeVisible({ timeout: 5_000 });

		await navigateToEditAndExpandGate(page);

		// Re-expand the step
		const stepHeaderReload = page.locator(".wf-vstep-collapsed-header").first();
		await stepHeaderReload.click();
		await expect(page.locator(".wf-vstep-body").first()).toBeVisible({ timeout: 5_000 });

		// Verify the optional checkbox is still checked
		const optionalCheckboxReload = page.locator(".wf-vstep-optional-row input[type='checkbox']").first();
		await expect(optionalCheckboxReload).toBeChecked();

		// Verify the label value is preserved
		const labelInputReload = page.locator(".wf-vstep-optional-row input.wf-input").first();
		await expect(labelInputReload).toHaveValue("Enable QA Testing");
	});

	test("Add Phase button creates new phase group", async ({ page }) => {
		await createTestWorkflow({
			gates: [
				{
					id: "gate-1",
					name: "Gate 1",
					dependsOn: [],
					verify: [
						{ name: "Step 1", type: "command", run: "echo ok", phase: 0 },
					],
				},
			],
		});
		await openApp(page);
		await navigateToEditAndExpandGate(page);

		// Count initial phase groups
		const initialPhaseGroups = page.locator(".wf-phase-group");
		const initialCount = await initialPhaseGroups.count();

		// Click the Add Phase button
		const addPhaseBtn = page.locator("button").filter({ hasText: /Add Phase/i }).first();
		await expect(addPhaseBtn).toBeVisible({ timeout: 5_000 });
		await addPhaseBtn.click();

		// Verify a new phase group appeared
		await expect(page.locator(".wf-phase-group")).toHaveCount(initialCount + 1);

		// The new phase should have a header with the next phase number
		const phaseHeaders = page.locator(".wf-phase-header");
		const lastHeader = phaseHeaders.last();
		await expect(lastHeader).toBeVisible();
		await expect(lastHeader).toContainText("Phase");
	});

	test("save and reload preserves phases, types, and optional fields", async ({ page }) => {
		// Create workflow with all the new features: phases, agent-qa, optional+label
		await createTestWorkflow({
			gates: [
				{
					id: "gate-1",
					name: "Gate 1",
					dependsOn: [],
					verify: [
						{ name: "Lint", type: "command", run: "echo lint", phase: 0 },
						{
							name: "QA Test",
							type: "agent-qa",
							prompt: "Run QA",
							phase: 1,
							optional: true,
							label: "Enable QA",
						},
					],
				},
			],
		});
		await openApp(page);
		await navigateToEditAndExpandGate(page);

		// Verify phase grouping
		await expect(page.locator(".wf-phase-group")).toHaveCount(2, { timeout: 5_000 });

		// Expand the QA Test step (second step, in phase 1)
		// Find the step that says "QA Test" or "agent-qa"
		const qaStepHeader = page.locator(".wf-vstep-collapsed-header").filter({ hasText: "QA Test" }).first();
		await qaStepHeader.click();

		// Verify the step type is agent-qa
		const stepBody = page.locator(".wf-vstep-card.vstep-expanded .wf-vstep-body").first();
		await expect(stepBody).toBeVisible({ timeout: 5_000 });

		const typeSelect = stepBody.locator("select.wf-select").first();
		await expect(typeSelect).toHaveValue("agent-qa");

		// Verify prompt textarea is shown
		await expect(stepBody.locator("textarea")).toBeVisible();

		// Verify optional is checked and label is present
		const optionalCheckbox = stepBody.locator(".wf-vstep-optional-row input[type='checkbox']").first();
		await expect(optionalCheckbox).toBeChecked();

		const labelInput = stepBody.locator(".wf-vstep-optional-row input.wf-input").first();
		await expect(labelInput).toHaveValue("Enable QA");

		// Also verify via API that the workflow data is correct
		const resp = await apiFetch(`/api/workflows/${WF_ID}`);
		expect(resp.status).toBe(200);
		const data = await resp.json();
		const steps = data.gates[0].verify;
		expect(steps).toHaveLength(2);
		expect(steps[0].phase ?? 0).toBe(0);
		expect(steps[0].type).toBe("command");
		expect(steps[1].phase ?? 0).toBe(1);
		expect(steps[1].type).toBe("agent-qa");
		expect(steps[1].optional).toBe(true);
		expect(steps[1].label).toBe("Enable QA");
	});

	test("phase compaction renumbers gaps on save", async ({ page }) => {
		// Create workflow with non-contiguous phases (0 and 2, skip 1)
		await createTestWorkflow({
			gates: [
				{
					id: "gate-1",
					name: "Gate 1",
					dependsOn: [],
					verify: [
						{ name: "Step A", type: "command", run: "echo a", phase: 0 },
						{ name: "Step B", type: "command", run: "echo b", phase: 2 },
					],
				},
			],
		});
		await openApp(page);
		await navigateToEditAndExpandGate(page);

		// Save the workflow — compaction should renumber phases to 0, 1
		const saveBtn = page.locator("button").filter({ hasText: "Save" }).first();
		await saveBtn.click();

		// Wait for save
		await page.waitForResponse(
			resp => resp.url().includes("/api/workflows") && resp.ok(),
			{ timeout: 10_000 },
		);

		// Verify via API that phases were compacted
		const resp = await apiFetch(`/api/workflows/${WF_ID}`);
		expect(resp.status).toBe(200);
		const data = await resp.json();
		const steps = data.gates[0].verify;
		expect(steps).toHaveLength(2);
		expect(steps[0].phase ?? 0).toBe(0);
		expect(steps[1].phase ?? 0).toBe(1); // was 2, now compacted to 1
	});

	test("empty phase can be removed", async ({ page }) => {
		await createTestWorkflow({
			gates: [
				{
					id: "gate-1",
					name: "Gate 1",
					dependsOn: [],
					verify: [
						{ name: "Step 1", type: "command", run: "echo ok", phase: 0 },
					],
				},
			],
		});
		await openApp(page);
		await navigateToEditAndExpandGate(page);

		// Count initial phase groups (should be 1 — phase 0 with Step 1)
		const initialCount = await page.locator(".wf-phase-group").count();

		// Add a new empty phase
		const addPhaseBtn = page.locator("button").filter({ hasText: /Add Phase/i }).first();
		await addPhaseBtn.click();

		// Wait for the new phase group to appear
		await expect(page.locator(".wf-phase-group")).toHaveCount(initialCount + 1, { timeout: 5_000 });

		// Find the delete button on the empty phase header and click it
		const deleteBtn = page.locator(".wf-phase-delete").last();
		await expect(deleteBtn).toBeVisible({ timeout: 5_000 });
		await deleteBtn.click();

		// Verify we're back to the initial count (empty phase removed)
		await expect(page.locator(".wf-phase-group")).toHaveCount(initialCount, { timeout: 5_000 });
	});

	test("steps without phase field default to phase 0", async ({ page }) => {
		// Create workflow with steps that have no phase field
		await createTestWorkflow({
			gates: [
				{
					id: "gate-1",
					name: "Gate 1",
					dependsOn: [],
					verify: [
						{ name: "No phase step", type: "command", run: "echo ok" },
						// no phase field — should default to phase 0
					],
				},
			],
		});
		await openApp(page);
		await navigateToEditAndExpandGate(page);

		// Verify the step appears in a phase group
		const phaseGroups = page.locator(".wf-phase-group");
		await expect(phaseGroups.first()).toBeVisible({ timeout: 5_000 });

		// The step should be in phase 0
		await expect(page.getByText("Phase 0", { exact: false }).first()).toBeVisible();

		// The step card should be inside the phase group
		const phase0Steps = phaseGroups.first().locator(".wf-vstep-card");
		await expect(phase0Steps).toHaveCount(1);
	});
});
