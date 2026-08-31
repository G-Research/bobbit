// v2-native browser journey for type-aware workflow review timeouts.

import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../../../tests2/browser/fixtures/build-bundle.js";

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

function workflowShell(page: Page) {
	return page.locator(".wf-container").filter({ has: page.getByTestId("workflow-editor") });
}

function workflowEditor(page: Page) {
	return workflowShell(page).getByTestId("workflow-editor");
}

function verifyStep(page: Page) {
	return workflowEditor(page).getByTestId("wf-vstep-card");
}

function saveButton(page: Page) {
	return workflowShell(page).getByRole("button", { name: "Save", exact: true });
}

async function loadWorkflow(page: Page, workflow: FixtureWorkflow): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__goalWorkflowEditorReady === true, null, { timeout: 10_000 });
	await page.evaluate((wf) => (window as any).__loadGoalWorkflowFixture(wf), workflow);

	const editor = workflowEditor(page);
	await expect(editor).toHaveAttribute("data-workflow-id", workflow.id, { timeout: 10_000 });
	await expect(editor.locator("input[placeholder='Workflow name']")).toHaveValue(workflow.name);

	const gateHeader = editor.locator(".wf-gate-header").first();
	const gateBody = editor.locator(".wf-gate-body").first();
	if (!(await gateBody.isVisible())) await gateHeader.click();
	const stepHeader = verifyStep(page).locator(".wf-vstep-collapsed-header");
	await stepHeader.click();
	await expect(verifyStep(page).locator(".wf-vstep-body")).toBeVisible();
}

async function openAdvanced(page: Page): Promise<void> {
	const step = verifyStep(page);
	const stepBody = step.locator(".wf-vstep-body");
	if (!(await stepBody.isVisible())) {
		await step.locator(".wf-vstep-collapsed-header").click();
	}
	await expect(stepBody).toBeVisible();

	const details = step.locator("details.wf-vstep-advanced");
	if (!(await details.evaluate((node: HTMLDetailsElement) => node.open))) {
		await details.locator("summary").click();
	}
	await expect(step.getByTestId("wf-step-timeout")).toBeVisible();
}

async function putBodies(page: Page): Promise<any[]> {
	return page.evaluate(() => {
		const log = (window as any).__goalWorkflowFetchLog();
		return log.filter((entry: any) => entry.method === "PUT").map((entry: any) => entry.body);
	});
}

/**
 * Save completion is a DOM lifecycle, not merely the fixture's synchronous
 * fetch log entry. Observe the current editor's Save → Saving… → Save cycle
 * before clicking, so a re-render cannot close Advanced after it is reopened.
 */
async function armSaveCompletion(page: Page): Promise<void> {
	await page.evaluate(() => {
		const editor = document.querySelector<HTMLElement>("[data-testid='workflow-editor']");
		const nav = editor?.closest<HTMLElement>(".wf-container")?.querySelector<HTMLElement>(".wf-nav-right");
		if (!nav) throw new Error("workflow editor save controls are unavailable");

		let sawSaving = false;
		(window as any).__workflowTimeoutSaveComplete = new Promise<void>((resolve) => {
			const observer = new MutationObserver((records) => {
				for (const record of records) {
					if (record.type === "characterData") {
						sawSaving ||= record.oldValue?.trim() === "Saving…" || record.target.textContent?.trim() === "Saving…";
						continue;
					}
					for (const node of [...record.addedNodes, ...record.removedNodes]) {
						sawSaving ||= node.textContent?.trim() === "Saving…";
					}
				}
				const button = [...nav.querySelectorAll<HTMLButtonElement>("button")]
					.find((candidate) => candidate.textContent?.trim() === "Save");
				if (sawSaving && button && !button.disabled) {
					observer.disconnect();
					resolve();
				}
			});
			observer.observe(nav, {
				childList: true,
				subtree: true,
				characterData: true,
				characterDataOldValue: true,
				attributes: true,
				attributeFilter: ["disabled"],
			});
		});
	});
}

async function save(page: Page): Promise<any> {
	await armSaveCompletion(page);
	await saveButton(page).click();
	await page.evaluate(() => (window as any).__workflowTimeoutSaveComplete);
	return (await putBodies(page)).at(-1);
}

test("invalid verification edits preserve the active timeout input until a structural change", async ({ page }) => {
	await loadWorkflow(page, workflowWithStep({
		name: "",
		type: "llm-review",
		prompt: "Review the workflow editor",
		phase: 0,
	}));
	await openAdvanced(page);

	const step = verifyStep(page);
	const timeout = () => step.getByTestId("wf-step-timeout");
	const typeSelect = step.getByTestId("wf-step-type");

	// A locally invalid step must surface feedback without issuing a PUT.
	await saveButton(page).click();
	await expect(step.getByTestId("wf-step-name-error")).toBeVisible();
	await expect(timeout()).toBeVisible();
	await expect(step.locator("details.wf-vstep-advanced")).toHaveJSProperty("open", true);
	expect(await putBodies(page)).toEqual([]);

	await timeout().focus();
	await page.evaluate(() => {
		(window as any).__activeTimeoutInput = document.querySelector("[data-testid='wf-step-timeout']");
	});
	await timeout().fill("45");
	await expect(timeout()).toHaveValue("45");
	const preserved = await page.evaluate(() => {
		const timeout = document.querySelector<HTMLInputElement>("[data-testid='wf-step-timeout']");
		const advanced = document.querySelector<HTMLDetailsElement>("details.wf-vstep-advanced");
		return {
			sameNode: timeout === (window as any).__activeTimeoutInput,
			focused: document.activeElement === timeout,
			advancedOpen: advanced?.open,
		};
	});
	expect(preserved).toEqual({ sameNode: true, focused: true, advancedOpen: true });
	expect(await putBodies(page)).toEqual([]);

	// Type selection is structural: it intentionally re-renders and removes
	// timeout state when moving to a type that cannot use it.
	await typeSelect.selectOption("human-signoff");
	await expect(timeout()).toHaveCount(0);
	await step.getByTestId("wf-step-name").fill("Approval");
	await step.getByTestId("wf-step-label").fill("Approve workflow editor");
	const saved = await save(page);
	expect(saved.gates[0].verify[0]).toMatchObject({
		name: "Approval",
		type: "human-signoff",
		label: "Approve workflow editor",
	});
	expect(saved.gates[0].verify[0].timeout).toBeUndefined();
});

test("workflow editor explains and preserves review-agent per-turn timeout rules", async ({ page }) => {
	await loadWorkflow(page, workflowWithStep({
		name: "Timeout step",
		type: "command",
		run: "echo ok",
		phase: 0,
	}));
	await openAdvanced(page);

	const stepBody = verifyStep(page).locator(".wf-vstep-body");
	const typeSelect = verifyStep(page).getByTestId("wf-step-type");
	const timeoutField = () => verifyStep(page).getByTestId("wf-step-timeout");
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
	await expect(timeoutField()).toHaveValue("45");

	// Invalid zero is normalized to omitted; a positive fraction is normalized
	// to its integer editor representation.
	await timeoutField().fill("0");
	const zeroBody = await save(page);
	expect(zeroBody.gates[0].verify[0].timeout).toBeUndefined();
	await openAdvanced(page);
	await timeoutField().fill("3.8");
	const fractionBody = await save(page);
	expect(fractionBody.gates[0].verify[0].timeout).toBe(3);

	// Switching to human sign-off hides the field and strips the stale timeout
	// rather than silently serializing an inapplicable review setting.
	await openAdvanced(page);
	await expect(timeoutField()).toHaveValue("3");
	await typeSelect.selectOption("human-signoff");
	await expect(timeoutField()).toHaveCount(0);
	await stepBody.getByTestId("wf-step-prompt").fill("Approve the timeout contract");
	await stepBody.getByTestId("wf-step-label").fill("Approve timeout contract");
	const signoffBody = await save(page);
	expect(signoffBody.gates[0].verify[0].type).toBe("human-signoff");
	expect(signoffBody.gates[0].verify[0].timeout).toBeUndefined();
});
