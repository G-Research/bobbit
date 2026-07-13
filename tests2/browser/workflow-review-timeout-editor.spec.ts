// v2-native browser journey for type-aware workflow review timeouts.

import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/goal-workflow-editor-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "workflow-review-timeout-editor-bundle.js");
const WORKFLOW_SRC = path.resolve("src/app/workflow-page.ts");
const API_SRC = path.resolve("src/app/api.ts");
const STATE_SRC = path.resolve("src/app/state.ts");
const CONFIG_SCOPE_SRC = path.resolve("src/app/config-scope.ts");

type FixtureWorkflow = {
	id: string;
	name: string;
	description: string;
	gates: Array<{ id: string; name: string; dependsOn: string[]; verify?: Array<Record<string, unknown>> }>;
};

function workflowWithStep(step: Record<string, unknown>): FixtureWorkflow {
	return {
		id: "review-timeout-workflow",
		name: "Review Timeout Workflow",
		description: "Disposable workflow timeout fixture",
		gates: [{ id: "review-gate", name: "Review gate", dependsOn: [], verify: [step] }],
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

async function loadWorkflow(page: Page, workflow: FixtureWorkflow): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__goalWorkflowEditorReady === true, null, { timeout: 10_000 });
	await page.evaluate((wf) => (window as any).__loadGoalWorkflowFixture(wf), workflow);
	await expect(page.locator("input[placeholder='Workflow name']").first()).toHaveValue(workflow.name, { timeout: 10_000 });

	const gateHeader = page.locator(".wf-gate-header").first();
	if (!(await page.locator(".wf-gate-body").first().isVisible())) await gateHeader.click();
	const stepHeader = page.locator(".wf-vstep-collapsed-header").first();
	await stepHeader.click();
	await expect(page.locator(".wf-vstep-body").first()).toBeVisible();
}

async function openAdvanced(page: Page): Promise<void> {
	const stepBody = page.locator(".wf-vstep-body").first();
	if (!(await stepBody.isVisible())) {
		await page.locator(".wf-vstep-collapsed-header").first().click();
	}
	await expect(stepBody).toBeVisible();

	const details = page.locator("details.wf-vstep-advanced").first();
	if (!(await details.evaluate((node: HTMLDetailsElement) => node.open))) {
		await details.locator("summary").click();
	}
	await expect(page.getByTestId("wf-step-timeout")).toBeVisible();
}

async function putBodies(page: Page): Promise<any[]> {
	return page.evaluate(() => {
		const log = (window as any).__goalWorkflowFetchLog();
		return log.filter((entry: any) => entry.method === "PUT").map((entry: any) => entry.body);
	});
}

async function save(page: Page): Promise<any> {
	const before = (await putBodies(page)).length;
	await page.locator("button").filter({ hasText: "Save" }).first().click();
	await expect.poll(async () => (await putBodies(page)).length, { timeout: 5_000 }).toBe(before + 1);
	return (await putBodies(page)).at(-1);
}

test("workflow editor explains and preserves review-agent per-turn timeout rules", async ({ page }) => {
	await loadWorkflow(page, workflowWithStep({
		name: "Timeout step",
		type: "command",
		run: "echo ok",
		phase: 0,
	}));
	await openAdvanced(page);

	const stepBody = page.locator(".wf-vstep-body").first();
	const typeSelect = page.getByTestId("wf-step-type");
	const timeoutField = () => page.getByTestId("wf-step-timeout");
	const timeoutHint = () => timeoutField().locator("xpath=ancestor::div[contains(@class,'wf-field')][1]").locator(".wf-field-hint");

	await expect(timeoutField()).toHaveAttribute("placeholder", "300");
	await expect(timeoutHint()).toContainText(/300s|300 seconds/i);
	await expect(timeoutHint()).toContainText(/unit.*1200|1200.*unit/i);

	await typeSelect.selectOption("llm-review");
	await openAdvanced(page);
	await expect(timeoutField()).toHaveAttribute("placeholder", "1200");
	await expect(timeoutHint()).toContainText(/attempt.*reminder.*recovery/i);
	await expect(timeoutHint()).toContainText(/provider backoff.*excluded/i);
	await stepBody.getByTestId("wf-step-prompt").fill("Review the timeout contract");

	await typeSelect.selectOption("agent-qa");
	await openAdvanced(page);
	await expect(timeoutField()).toHaveAttribute("placeholder", "1200");
	await expect(timeoutHint()).toContainText(/1200/);
	await expect(timeoutHint()).toContainText(/qa_max_duration_minutes|component.*duration|derived/i);
	await expect(timeoutHint()).toContainText(/explicit.*shorter|shorter.*explicit/i);
	await stepBody.getByTestId("wf-step-prompt").fill("Exercise timeout recovery");

	await timeoutField().fill("45");
	const saved = await save(page);
	expect(saved.gates[0].verify[0]).toMatchObject({ type: "agent-qa", timeout: 45 });

	// Reconstruct the editor from the persisted PUT body, exercising the same
	// load/render path as a page reload without leaking a server override.
	await loadWorkflow(page, {
		id: "review-timeout-workflow",
		name: saved.name,
		description: saved.description,
		gates: saved.gates,
	});
	await openAdvanced(page);
	await expect(page.getByTestId("wf-step-timeout")).toHaveValue("45");

	// Invalid zero is normalized to omitted; a positive fraction is normalized
	// to its integer editor representation.
	await page.getByTestId("wf-step-timeout").fill("0");
	const zeroBody = await save(page);
	expect(zeroBody.gates[0].verify[0].timeout).toBeUndefined();
	await openAdvanced(page);
	await page.getByTestId("wf-step-timeout").fill("3.8");
	const fractionBody = await save(page);
	expect(fractionBody.gates[0].verify[0].timeout).toBe(3);

	// Switching to human sign-off hides the field and strips the stale timeout
	// rather than silently serializing an inapplicable review setting.
	await openAdvanced(page);
	await expect(page.getByTestId("wf-step-timeout")).toHaveValue("3");
	await page.getByTestId("wf-step-type").selectOption("human-signoff");
	await expect(page.getByTestId("wf-step-timeout")).toHaveCount(0);
	await stepBody.getByTestId("wf-step-prompt").fill("Approve the timeout contract");
	await stepBody.getByTestId("wf-step-label").fill("Approve timeout contract");
	const signoffBody = await save(page);
	expect(signoffBody.gates[0].verify[0].type).toBe("human-signoff");
	expect(signoffBody.gates[0].verify[0].timeout).toBeUndefined();
});
