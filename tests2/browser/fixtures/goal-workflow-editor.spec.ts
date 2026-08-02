import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/goal-workflow-editor-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "goal-workflow-editor-bundle.js");
const WORKFLOW_SRC = path.resolve("src/app/workflow-page.ts");
const API_SRC = path.resolve("src/app/api.ts");
const STATE_SRC = path.resolve("src/app/state.ts");
const CONFIG_SCOPE_SRC = path.resolve("src/app/config-scope.ts");

type FixtureWorkflow = {
	id: string;
	name: string;
	description: string;
	gates: Array<{
		id: string;
		name: string;
		dependsOn: string[];
		verify?: Array<Record<string, unknown>>;
	}>;
};

function workflowWithSteps(verify: Array<Record<string, unknown>>): FixtureWorkflow {
	return {
		id: "fixture-workflow",
		name: "Fixture Workflow",
		description: "Workflow editor fixture",
		gates: [{ id: "gate-1", name: "Gate 1", dependsOn: [], verify }],
	};
}

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, WORKFLOW_SRC, API_SRC, STATE_SRC, CONFIG_SCOPE_SRC],
	});
});

async function loadWorkflow(page: Page, workflow: FixtureWorkflow | FixtureWorkflow[]): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__goalWorkflowEditorReady === true, null, { timeout: 10_000 });
	await page.evaluate((wf) => (window as any).__loadGoalWorkflowFixture(wf), workflow);
	const firstWorkflow = Array.isArray(workflow) ? workflow[0] : workflow;
	await expect(page.locator("input[placeholder='Workflow name']").first()).toHaveValue(firstWorkflow.name, { timeout: 10_000 });
}

async function loadNewWorkflowEditor(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__goalWorkflowEditorReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__loadGoalWorkflowFixture(null));
	await page.getByRole("button", { name: "create one by hand" }).click();
	await expect(page.locator("input[placeholder='e.g. bug-fix']")).toBeVisible();
}

function saveButton(page: Page): Locator {
	return page.locator(".wf-nav-right button").last();
}

async function expandFirstGate(page: Page): Promise<void> {
	const gateHeader = page.locator(".wf-gate-header").first();
	await expect(gateHeader).toBeVisible({ timeout: 5_000 });
	if (!(await page.locator(".wf-gate-body").first().isVisible())) {
		await gateHeader.click();
	}
	await expect(page.locator(".wf-gate-body").first()).toBeVisible({ timeout: 5_000 });
}

async function expandStep(page: Page, text: string | RegExp = /.*/): Promise<void> {
	const header = page.locator(".wf-vstep-collapsed-header").filter({ hasText: text }).first();
	await expect(header).toBeVisible({ timeout: 5_000 });
	await header.click();
	await expect(page.locator(".wf-vstep-body").first()).toBeVisible({ timeout: 5_000 });
}

async function lastPutBody(page: Page): Promise<any> {
	return await page.evaluate(() => {
		const log = (window as any).__goalWorkflowFetchLog();
		return log.filter((entry: any) => entry.method === "PUT").at(-1)?.body ?? null;
	});
}

test.describe("Goal/workflow editor fixture", () => {
	test("agent-qa type shows prompt textarea and hides command-only controls", async ({ page }) => {
		await loadWorkflow(page, workflowWithSteps([
			{ name: "Test step", type: "command", run: "echo test", phase: 0 },
		]));
		await expandFirstGate(page);
		await expandStep(page, "Test step");

		const stepBody = page.locator(".wf-vstep-body").first();
		const typeSelect = stepBody.locator("select.wf-select").first();
		await expect(typeSelect).toHaveValue("command");
		await expect(stepBody.locator("input[placeholder='Command to run...']").first()).toBeVisible();

		await typeSelect.selectOption("agent-qa");

		await expect(stepBody.locator("textarea[placeholder='QA test prompt...']").first()).toBeVisible({ timeout: 5_000 });
		await expect(stepBody.locator("input[placeholder='Command to run...']").first()).not.toBeVisible();
		await expect(stepBody.locator("select.wf-select")).toHaveCount(1);
	});

	test("free-form command run hint advertises supported variables only", async ({ page }) => {
		await loadWorkflow(page, workflowWithSteps([
			{ name: "Run step", type: "command", run: "echo test", phase: 0 },
		]));
		await expandFirstGate(page);
		await expandStep(page, "Run step");

		const hint = page.locator("[data-testid='wf-step-run-hint']").first();
		await expect(hint).toBeVisible({ timeout: 5_000 });
		await expect(hint).toContainText("{{baseBranch}}");
		const hintText = await hint.textContent();
		expect(hintText).not.toContain("{{master}}");
		expect(hintText).not.toContain("{{project.");
	});

	test("phase grouping renders headers and defaults missing phase to phase 0", async ({ page }) => {
		await loadWorkflow(page, workflowWithSteps([
			{ name: "No phase step", type: "command", run: "echo default" },
			{ name: "Lint check", type: "command", run: "echo lint", phase: 0 },
			{ name: "Integration test", type: "command", run: "echo integration", phase: 1 },
		]));
		await expandFirstGate(page);

		await expect(page.locator(".wf-phase-group")).toHaveCount(2, { timeout: 5_000 });
		await expect(page.getByText("Phase 0", { exact: false }).first()).toBeVisible();
		await expect(page.getByText("Phase 1", { exact: false }).first()).toBeVisible();
		await expect(page.locator(".wf-phase-group").first().locator(".wf-vstep-card")).toHaveCount(2);
		await expect(page.locator(".wf-phase-group").nth(1).locator(".wf-vstep-card")).toHaveCount(1);
	});

	test("optional checkbox reveals label input and save payload preserves optional fields", async ({ page }) => {
		await loadWorkflow(page, workflowWithSteps([
			{ name: "QA step", type: "agent-qa", prompt: "Run QA", phase: 0 },
		]));
		await expandFirstGate(page);
		await expandStep(page, "QA step");

		const stepBody = page.locator(".wf-vstep-body").first();
		const optionalCheckbox = stepBody.locator(".wf-vstep-optional-row input[type='checkbox']").first();
		await expect(optionalCheckbox).toBeVisible({ timeout: 5_000 });
		await optionalCheckbox.check();

		const labelInput = stepBody.locator(".wf-vstep-optional-row input.wf-input").first();
		await expect(labelInput).toBeVisible({ timeout: 5_000 });
		await labelInput.fill("Enable QA Testing");

		await page.locator("button").filter({ hasText: "Save" }).first().click();
		await expect.poll(() => lastPutBody(page), { timeout: 5_000 }).not.toBeNull();

		const body = await lastPutBody(page);
		// Optional-step toggle labels live in `optionalLabel` after the
		// label/optionalLabel split (Re-attempt: Sign-Off Gates). `label`
		// is now exclusively the `human-signoff` card title.
		expect(body.gates[0].verify[0]).toMatchObject({
			name: "QA step",
			type: "agent-qa",
			optional: true,
			optionalLabel: "Enable QA Testing",
		});
		expect(body.gates[0].verify[0].label).toBeUndefined();
	});

	test("Add Phase creates a removable empty phase group", async ({ page }) => {
		await loadWorkflow(page, workflowWithSteps([
			{ name: "Step 1", type: "command", run: "echo ok", phase: 0 },
		]));
		await expandFirstGate(page);

		const initialCount = await page.locator(".wf-phase-group").count();
		await page.locator("button").filter({ hasText: /Add Phase/i }).first().click();
		await expect(page.locator(".wf-phase-group")).toHaveCount(initialCount + 1, { timeout: 5_000 });

		const deleteBtn = page.locator(".wf-phase-delete").last();
		await expect(deleteBtn).toBeVisible({ timeout: 5_000 });
		await deleteBtn.click();
		await expect(page.locator(".wf-phase-group")).toHaveCount(initialCount, { timeout: 5_000 });
	});

	test("save compacts non-contiguous phase numbers in the PUT payload", async ({ page }) => {
		await loadWorkflow(page, workflowWithSteps([
			{ name: "Step A", type: "command", run: "echo a", phase: 0 },
			{ name: "Step B", type: "command", run: "echo b", phase: 2 },
		]));

		await page.locator("button").filter({ hasText: "Save" }).first().click();
		await expect.poll(() => lastPutBody(page), { timeout: 5_000 }).not.toBeNull();

		const body = await lastPutBody(page);
		expect(body.gates[0].verify.map((step: any) => step.phase ?? 0)).toEqual([0, 1]);
	});

	test("preserves mutable edits after a held create while saving the server-created ID", async ({ page }) => {
		await loadNewWorkflowEditor(page);
		const workflowId = page.locator("input[placeholder='e.g. bug-fix']");
		const workflowName = page.locator("input[placeholder='Workflow name']");
		await workflowId.fill("submitted-workflow-id");
		await workflowName.fill("Submitted workflow name");

		const createRequest = page.evaluate(() =>
			(window as any).__holdNextWorkflowCreate("server-created-workflow-id"),
		);
		await saveButton(page).click();
		const capturedCreate = await createRequest;
		expect(capturedCreate).toMatchObject({
			url: "/api/workflows?projectId=fixture-project",
			method: "POST",
			body: { id: "submitted-workflow-id", name: "Submitted workflow name" },
		});
		await expect(saveButton(page)).toHaveText("Saving…");

		await workflowId.fill("post-submit-id-must-not-persist");
		await workflowName.fill("Mutable name after create submit");
		await page.evaluate(() => (window as any).__releaseHeldWorkflowCreate());

		const persistedWorkflowId = page.locator(".wf-identity-row").first().locator("input[disabled]");
		await expect(persistedWorkflowId).toBeDisabled();
		await expect(persistedWorkflowId).toHaveValue("server-created-workflow-id");
		await expect(workflowName).toHaveValue("Mutable name after create submit");
		await expect(saveButton(page)).toHaveText("Save");
		await expect(saveButton(page)).toBeEnabled();

		const updateRequest = page.evaluate(() => (window as any).__waitForNextWorkflowUpdate());
		await saveButton(page).click();
		const capturedUpdate = await updateRequest;
		expect(capturedUpdate).toMatchObject({
			url: "/api/workflows/server-created-workflow-id?projectId=fixture-project",
			method: "PUT",
			body: { name: "Mutable name after create submit" },
		});
		const requests = await page.evaluate(() => (window as any).__goalWorkflowFetchLog());
		expect(requests.filter((request: any) => request.method === "POST")).toHaveLength(1);
	});

	test("preserves a newer draft when a held PUT refresh omits its target", async ({ page }) => {
		await loadWorkflow(page, workflowWithSteps([]));
		const workflowName = page.locator("input[placeholder='Workflow name']");
		const updateRequest = page.evaluate(() => (window as any).__holdNextWorkflowUpdate());

		await saveButton(page).click();
		const capturedUpdate = await updateRequest;
		expect(capturedUpdate).toMatchObject({
			url: "/api/workflows/fixture-workflow?projectId=fixture-project",
			method: "PUT",
			body: { name: "Fixture Workflow" },
		});
		await expect(saveButton(page)).toHaveText("Saving…");

		await workflowName.fill("Mutable name after update submit");
		await page.evaluate(() => (window as any).__omitNextWorkflowList());
		await page.evaluate(() => (window as any).__releaseHeldWorkflowUpdate());

		await expect(page.locator(".wf-identity-row").first().locator("input[disabled]")).toHaveValue("fixture-workflow");
		await expect(workflowName).toHaveValue("Mutable name after update submit");
		await expect(saveButton(page)).toHaveText("Save");
		await expect(saveButton(page)).toBeEnabled();

		const nextUpdate = page.evaluate(() => (window as any).__waitForNextWorkflowUpdate());
		await saveButton(page).click();
		await expect(nextUpdate).resolves.toMatchObject({
			url: "/api/workflows/fixture-workflow?projectId=fixture-project",
			method: "PUT",
			body: { name: "Mutable name after update submit" },
		});
	});

	test("ignores a held response after navigation installs another workflow draft", async ({ page }) => {
		const workflowA = { ...workflowWithSteps([]), id: "workflow-a", name: "Workflow A" };
		const workflowB = { ...workflowWithSteps([]), id: "workflow-b", name: "Workflow B" };
		await loadWorkflow(page, [workflowA, workflowB]);
		const updateRequest = page.evaluate(() => (window as any).__holdNextWorkflowUpdate());

		await saveButton(page).click();
		const capturedUpdate = await updateRequest;
		expect(capturedUpdate).toMatchObject({ url: "/api/workflows/workflow-a?projectId=fixture-project" });
		await page.locator(".wf-back").click();
		await page.locator(".wf-row[data-workflow-id='workflow-b']").click();
		const workflowName = page.locator("input[placeholder='Workflow name']");
		await expect(workflowName).toHaveValue("Workflow B");

		const listFetch = page.evaluate(() => (window as any).__waitForNextWorkflowListFetch());
		await page.evaluate(() => (window as any).__releaseHeldWorkflowUpdate());
		await listFetch;
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

		await expect(page.locator(".wf-identity-row").first().locator("input[disabled]")).toHaveValue("workflow-b");
		await expect(workflowName).toHaveValue("Workflow B");
		await expect(saveButton(page)).toHaveText("Save");
	});
});
