// Browser coverage for command-step plaintext environment overrides.

import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/goal-workflow-editor-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "workflow-command-environment-bundle.js");

const DEPS = [
	ENTRY,
	path.resolve("src/app/workflow-page.ts"),
	path.resolve("src/app/api.ts"),
	path.resolve("src/app/state.ts"),
	path.resolve("src/app/config-scope.ts"),
];

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: DEPS });
});

async function load(page: Page, step: Record<string, unknown>): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__goalWorkflowEditorReady === true);
	await page.evaluate((verify) => (window as any).__loadGoalWorkflowFixture({
		id: "command-environment",
		name: "Command environment",
		description: "Fixture",
		gates: [{ id: "verify", name: "Verify", dependsOn: [], verify: [verify] }],
	}), step);
	const editor = page.getByTestId("workflow-editor");
	const gate = editor.locator(".wf-gate-header").first();
	if (!(await editor.locator(".wf-gate-body").first().isVisible())) await gate.click();
	await openStepEnvironment(page);
}

/** Reopen both disclosures after a step-type rerender before using its fields. */
async function openStepEnvironment(page: Page): Promise<void> {
	const card = page.getByTestId("wf-vstep-card");
	const body = card.locator(".wf-vstep-body");
	if (!(await body.isVisible())) await card.locator(".wf-vstep-collapsed-header").click();
	await expect(body).toBeVisible();

	const advanced = card.locator("details.wf-vstep-advanced");
	if (!(await advanced.evaluate((node: HTMLDetailsElement) => node.open))) await advanced.locator("summary").click();
	await expect(card.getByTestId("wf-step-environment")).toBeVisible();
}

async function saveBody(page: Page): Promise<any> {
	const priorPutCount = await page.evaluate(() => (window as any).__goalWorkflowFetchLog()
		.filter((entry: any) => entry.method === "PUT").length);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect.poll(async () => page.evaluate(() => (window as any).__goalWorkflowFetchLog()
		.filter((entry: any) => entry.method === "PUT").length)).toBeGreaterThan(priorPutCount);
	return page.evaluate(() => (window as any).__goalWorkflowFetchLog()
		.filter((entry: any) => entry.method === "PUT").at(-1).body);
}

test("command environment overrides are literal, validate, round-trip, and are removed for non-command steps", async ({ page }) => {
	await load(page, { name: "Run", type: "command", run: "echo ok" });
	const card = page.getByTestId("wf-vstep-card");
	const environment = card.getByTestId("wf-step-environment");

	await expect(environment).toContainText("Environment overrides (0)");
	await expect(environment.getByTestId("wf-step-env-precedence")).toContainText("Step override → Bobbit process environment");
	await expect(environment).toContainText("Stored as plaintext");
	await environment.getByTestId("wf-step-env-add").click();
	await environment.getByTestId("wf-step-env-key").fill("EMPTY_VALUE");
	await expect(environment.getByTestId("wf-step-env-value")).toHaveValue("");

	const saved = await saveBody(page);
	expect(saved.gates[0].verify[0].env).toEqual({ EMPTY_VALUE: "" });

	await load(page, saved.gates[0].verify[0]);
	await expect(page.getByTestId("wf-step-env-key")).toHaveValue("EMPTY_VALUE");
	await expect(page.getByTestId("wf-step-env-value")).toHaveValue("");

	await card.getByTestId("wf-step-type").selectOption("llm-review");
	await expect(card.getByTestId("wf-step-environment")).toHaveCount(0);
	await card.getByTestId("wf-step-prompt").fill("Review it");
	const nonCommand = await saveBody(page);
	expect(nonCommand.gates[0].verify[0].env).toBeUndefined();

	await card.getByTestId("wf-step-type").selectOption("command");
	await openStepEnvironment(page);
	await card.getByTestId("wf-step-env-add").click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(card.getByText("Variable name is required.")).toBeVisible();
});

test("environment row drafts retain sequential edits, duplicate rows, and repeated adds", async ({ page }) => {
	await load(page, { name: "Run", type: "command", run: "echo ok" });
	const environment = page.getByTestId("wf-step-environment");

	// The empty-state and populated-state actions both append a distinct row.
	await environment.getByTestId("wf-step-env-add").click();
	await environment.getByTestId("wf-step-env-add").click();
	const keys = environment.getByTestId("wf-step-env-key");
	const values = environment.getByTestId("wf-step-env-value");
	await expect(keys).toHaveCount(2);

	await keys.nth(0).fill("FIRST");
	await values.nth(0).fill("one");
	await keys.nth(1).fill("SECOND");
	await values.nth(1).fill("two");
	await expect(keys.nth(0)).toHaveValue("FIRST");
	await expect(values.nth(0)).toHaveValue("one");
	await expect(keys.nth(1)).toHaveValue("SECOND");
	await expect(values.nth(1)).toHaveValue("two");

	await page.setViewportSize({ width: 600, height: 800 });
	const responsive = await environment.getByTestId("wf-step-env-row").first().evaluate((row) => ({
		columns: getComputedStyle(row).gridTemplateColumns,
		right: row.getBoundingClientRect().right,
		viewportRight: document.documentElement.clientWidth,
	}));
	expect(responsive.columns.trim().split(/\s+/)).toHaveLength(1);
	expect(responsive.right).toBeLessThanOrEqual(responsive.viewportRight);

	const saved = await saveBody(page);
	expect(saved.gates[0].verify[0].env).toEqual({ FIRST: "one", SECOND: "two" });
	await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

	// Renaming into an exact duplicate must keep both rows so both can be fixed.
	await keys.nth(1).fill("FIRST");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(environment.getByText(/duplicates “FIRST”/)).toHaveCount(2);
	await expect(keys).toHaveCount(2);
	await expect(keys.nth(0)).toHaveValue("FIRST");
	await expect(keys.nth(1)).toHaveValue("FIRST");

	// Repairing the duplicate serializes the ordered draft rather than a stale row.
	await keys.nth(1).fill("SECOND");
	const repaired = await saveBody(page);
	expect(repaired.gates[0].verify[0].env).toEqual({ FIRST: "one", SECOND: "two" });
	await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

	await page.getByTestId("wf-step-type").selectOption("llm-review");
	await expect(page.getByTestId("wf-step-environment")).toHaveCount(0);
	await page.getByTestId("wf-step-prompt").fill("Review it");
	const nonCommand = await saveBody(page);
	expect(nonCommand.gates[0].verify[0].env).toBeUndefined();
});
