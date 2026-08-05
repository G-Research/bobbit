// v2-native browser coverage for workflow-authored verification failure guidance.

import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const PROJECT_ENTRY = path.resolve("tests/ui-fixtures/goal-workflow-editor-entry.ts");
const WORKFLOW_SRC = path.resolve("src/app/workflow-page.ts");
const API_SRC = path.resolve("src/app/api.ts");
const STATE_SRC = path.resolve("src/app/state.ts");
const CONFIG_SCOPE_SRC = path.resolve("src/app/config-scope.ts");
const SAFE_MARKDOWN_SRC = path.resolve("src/ui/lazy/safe-markdown-block.ts");
const LIT_SRC = path.resolve("node_modules/lit/index.js");

const GUIDANCE = "Inspect the **retained trace** first.\n\nRe-run only the failing journey.";
const CUSTOM_GUIDANCE = "Check the **custom goal logs** before retrying.";

type FixtureWorkflow = {
	id: string;
	name: string;
	description: string;
	gates: Array<{
		id: string;
		name: string;
		dependsOn: string[];
		verify: Array<Record<string, unknown>>;
	}>;
};

function workflow(failureGuidance?: string): FixtureWorkflow {
	return {
		id: "failure-guidance-workflow",
		name: "Failure Guidance Workflow",
		description: "Focused failure guidance fixture",
		gates: [{
			id: "browser-gate",
			name: "Browser gate",
			dependsOn: [],
			verify: [{
				name: "Browser journey",
				type: "command",
				run: "npm run test:browser",
				...(failureGuidance === undefined ? {} : { failureGuidance }),
			}],
		}],
	};
}

function sourceImport(from: string, target: string): string {
	const relative = path.relative(path.dirname(from), target)
		.replace(/\\/g, "/")
		.replace(/\.ts$/, ".js");
	return relative.startsWith(".") ? relative : `./${relative}`;
}

function embedFixtureSource(entry: string): string {
	const litImport = JSON.stringify(sourceImport(entry, LIT_SRC));
	const workflowImport = JSON.stringify(sourceImport(entry, WORKFLOW_SRC));
	const stateImport = JSON.stringify(sourceImport(entry, STATE_SRC));
	const safeMarkdownImport = JSON.stringify(sourceImport(entry, SAFE_MARKDOWN_SRC));
	return `
		import { html, render } from ${litImport};
		import { clearWorkflowEditorController, renderWorkflowEditor, renderWorkflowInspector } from ${workflowImport};
		import { setRenderApp } from ${stateImport};
		import ${safeMarkdownImport};

		let projectWorkflow;
		let inlineWorkflow = null;
		let customizing = false;
		const clone = (value) => JSON.parse(JSON.stringify(value));

		function draw() {
			const current = inlineWorkflow || projectWorkflow;
			render(html\`
				<button data-testid="fixture-customize" @click=\${() => {
					inlineWorkflow = clone(projectWorkflow);
					customizing = true;
					clearWorkflowEditorController();
					draw();
				}}>Customise for this goal</button>
				<div data-testid="fixture-surface">
					\${customizing
						? renderWorkflowEditor({
							workflow: current,
							scope: "goal-draft",
							onChange: (next) => { inlineWorkflow = clone(next); },
						})
						: renderWorkflowInspector({ workflow: current, scope: "goal-draft" })}
				</div>
			\`, document.getElementById("app"));
		}

		setRenderApp(draw);
		window.__loadFailureGuidanceEmbed = (next) => {
			projectWorkflow = clone(next);
			inlineWorkflow = null;
			customizing = false;
			clearWorkflowEditorController();
			draw();
		};
		window.__failureGuidanceInlineWorkflow = () => clone(inlineWorkflow);
		window.__failureGuidanceEmbedReady = true;
	`;
}

function buildProjectBundle(testInfo: TestInfo): string {
	const bundle = testInfo.outputPath("fixture-bundles", "workflow-failure-guidance-project-bundle.js");
	buildBundle({
		entry: PROJECT_ENTRY,
		outfile: bundle,
		deps: [PROJECT_ENTRY, WORKFLOW_SRC, API_SRC, STATE_SRC, CONFIG_SCOPE_SRC],
	});
	return bundle;
}

function buildEmbedBundle(testInfo: TestInfo): string {
	const entry = testInfo.outputPath("fixture-bundles", "workflow-failure-guidance-embed-entry.ts");
	const bundle = testInfo.outputPath("fixture-bundles", "workflow-failure-guidance-embed-bundle.js");
	fs.mkdirSync(path.dirname(entry), { recursive: true });
	fs.writeFileSync(entry, embedFixtureSource(entry));
	buildBundle({
		entry,
		outfile: bundle,
		deps: [entry, WORKFLOW_SRC, API_SRC, STATE_SRC, CONFIG_SCOPE_SRC, SAFE_MARKDOWN_SRC, LIT_SRC],
	});
	return bundle;
}

function editor(page: Page): Locator {
	return page.getByTestId("workflow-editor");
}

function step(page: Page): Locator {
	return editor(page).getByTestId("wf-vstep-card").first();
}

async function expandGateAndStep(page: Page): Promise<void> {
	const gate = editor(page).locator(".wf-gate-card").first();
	const gateBody = gate.locator(".wf-gate-body");
	if (!(await gateBody.isVisible())) await gate.locator(".wf-gate-header").click();
	const stepBody = step(page).locator(".wf-vstep-body");
	if (!(await stepBody.isVisible())) await step(page).locator(".wf-vstep-collapsed-header").click();
	await expect(stepBody).toBeVisible();
}

async function loadProjectWorkflow(page: Page, value: FixtureWorkflow, projectBundle: string): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: projectBundle });
	await page.waitForFunction(() => (window as any).__goalWorkflowEditorReady === true);
	await page.evaluate((wf) => (window as any).__loadGoalWorkflowFixture(wf), value);
	await expect(editor(page)).toHaveAttribute("data-workflow-id", value.id);
	await expandGateAndStep(page);
}

async function lastPutBody(page: Page): Promise<any> {
	return page.evaluate(() => (window as any).__goalWorkflowFetchLog()
		.filter((entry: any) => entry.method === "PUT").at(-1)?.body ?? null);
}

async function save(page: Page): Promise<any> {
	await page.locator(".wf-nav-right").getByRole("button", { name: "Save", exact: true }).click();
	await expect.poll(() => lastPutBody(page)).not.toBeNull();
	return lastPutBody(page);
}

test("authors, type-switches, saves, reloads, and clears failure guidance", async ({ page }, testInfo) => {
	const projectBundle = buildProjectBundle(testInfo);
	await loadProjectWorkflow(page, workflow(), projectBundle);

	const guidance = step(page).getByTestId("wf-step-failure-guidance");
	const hint = step(page).getByTestId("wf-step-failure-guidance-hint");
	await expect(step(page).getByLabel("Failure guidance", { exact: true })).toBeVisible();
	await expect(guidance).toHaveAttribute("rows", "3");
	await expect(guidance).toHaveAttribute("placeholder", "Explain how to diagnose and remediate this step…");
	await expect(hint).toHaveText("Sent to the team lead only if this step fails. Markdown is supported. Guidance is advisory and does not reset or revisit gates.");
	await expect(guidance).toHaveAttribute("aria-describedby", await hint.getAttribute("id") as string);

	await guidance.fill(GUIDANCE);
	await step(page).getByTestId("wf-step-type").selectOption("llm-review");
	await expect(step(page).getByTestId("wf-step-failure-guidance")).toHaveValue(GUIDANCE);
	await step(page).getByTestId("wf-step-prompt").fill("Review the browser journey");

	const saved = await save(page);
	expect(saved.gates[0].verify[0]).toMatchObject({
		type: "llm-review",
		prompt: "Review the browser journey",
		failureGuidance: GUIDANCE,
	});

	await loadProjectWorkflow(page, {
		...saved,
		id: "failure-guidance-workflow",
	}, projectBundle);
	await expect(step(page).getByTestId("wf-step-failure-guidance")).toHaveValue(GUIDANCE);

	await step(page).getByTestId("wf-step-failure-guidance").fill("  \n  ");
	const cleared = await save(page);
	expect(cleared.gates[0].verify[0].failureGuidance).toBeUndefined();
});

test("goal customisation round-trips guidance and the inspector keeps it in default-closed details", async ({ page }, testInfo) => {
	const embedBundle = buildEmbedBundle(testInfo);
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: embedBundle });
	await page.waitForFunction(() => (window as any).__failureGuidanceEmbedReady === true);
	await page.evaluate((wf) => (window as any).__loadFailureGuidanceEmbed(wf), workflow(GUIDANCE));

	const inspector = page.getByTestId("workflow-inspector");
	await expect(inspector).toBeVisible();
	const collapsedHeader = inspector.locator(".wf-vstep-collapsed-header").first();
	await expect(collapsedHeader).not.toContainText("retained trace");

	const gate = inspector.locator(".wf-gate-card").first();
	await gate.locator(".wf-gate-header").click();
	await collapsedHeader.click();
	const details = inspector.getByTestId("wf-step-failure-guidance-details");
	await expect(details).toHaveJSProperty("open", false);
	await expect(details.locator("summary")).toHaveText("Failure guidance");
	await details.locator("summary").focus();
	await details.locator("summary").press("Enter");
	await expect(details).toHaveJSProperty("open", true);
	await expect.poll(() => details.locator("markdown-block").evaluate((node: any) => node.textContent || ""))
		.toContain("Inspect the retained trace first.");
	await expect.poll(() => details.locator("markdown-block strong").textContent())
		.toBe("retained trace");

	await page.getByTestId("fixture-customize").click();
	await expandGateAndStep(page);
	const customField = step(page).getByTestId("wf-step-failure-guidance");
	await expect(customField).toHaveValue(GUIDANCE);
	await customField.fill(CUSTOM_GUIDANCE);
	await step(page).getByTestId("wf-step-type").selectOption("agent-qa");
	await expect(step(page).getByTestId("wf-step-failure-guidance")).toHaveValue(CUSTOM_GUIDANCE);
	await expect.poll(() => page.evaluate(() => (window as any).__failureGuidanceInlineWorkflow()
		.gates[0].verify[0].failureGuidance)).toBe(CUSTOM_GUIDANCE);
});
