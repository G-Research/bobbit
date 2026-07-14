import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/verification-timeout-remediation-entry.ts");
const INSPECT_SRC = path.resolve("src/ui/tools/renderers/GateInspectRenderer.ts");
const LIVE_SRC = path.resolve("src/ui/tools/renderers/GateVerificationLive.ts");
const RENDERERS_DIR = path.resolve("src/ui/tools/renderers");
const DIALOGS_DIR = path.resolve("src/ui/dialogs");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "verification-timeout-remediation-bundle.js");

const GOAL_PUT = "/api/goals/goal-timeout-fixture/workflow";
const PROJECT_GET_PUT = "/api/workflows/timeout-workflow?projectId=fixture-project";
const CUSTOMIZE_POST = "/api/workflows/timeout-workflow/customize?projectId=fixture-project";

type RequestLogEntry = { url: string; method: string; body: any };

test.describe.configure({ retries: 0 });

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function withTargetTimeout(workflow: any, seconds: number): any {
	const patched = clone(workflow);
	const gate = patched.gates.find((candidate: any) => candidate.id === "review-findings");
	const step = gate.verify.find((candidate: any) => candidate.name === "LLM review");
	step.timeout = seconds;
	return patched;
}

function withoutResolutionMetadata(workflow: any): any {
	const copy = clone(workflow);
	delete copy.origin;
	delete copy.overrides;
	return copy;
}

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		// Directory mtimes also invalidate when the implementation adds the lazy dialog/helper.
		deps: [ENTRY, INSPECT_SRC, LIVE_SRC, RENDERERS_DIR, DIALOGS_DIR],
	});
});

async function loadFixture(page: Page, options: { goalPutError?: string } = {}): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__timeoutRemediationReady === true, null, { timeout: 10_000 });
	await page.evaluate((resetOptions) => (window as any).__timeoutFixtureReset(resetOptions), options);
}

async function requests(page: Page): Promise<RequestLogEntry[]> {
	return page.evaluate(() => (window as any).__timeoutFixtureRequests());
}

async function fixtureState(page: Page): Promise<{ activeWorkflow: any; projectWorkflow: any; projectCustomized: boolean }> {
	return page.evaluate(() => (window as any).__timeoutFixtureState());
}

async function openDialog(page: Page, surfaceTestId = "inspect-surface"): Promise<Locator> {
	await page.getByTestId(surfaceTestId).getByRole("button", { name: "Change timeout", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	return dialog;
}

function timeoutInput(dialog: Locator): Locator {
	return dialog.getByRole("spinbutton", { name: /timeout|seconds/i });
}

function thisGoalScope(dialog: Locator): Locator {
	return dialog.getByRole("checkbox", { name: /^This goal$/i });
}

function futureScope(dialog: Locator): Locator {
	return dialog.getByRole("checkbox", { name: /Future goals.*Fixture Project/i });
}

function saveButton(dialog: Locator): Locator {
	return dialog.getByRole("button", { name: /save|update timeout/i });
}

async function submitAndWaitFor(page: Page, dialog: Locator, expectedMutationCount: number): Promise<void> {
	await saveButton(dialog).click();
	await expect.poll(async () => (await requests(page)).filter((entry) => entry.method !== "GET").length, {
		timeout: 5_000,
	}).toBe(expectedMutationCount);
}

test("structured timeout markers drive inspect/live presentation and picker validation", async ({ page }) => {
	await loadFixture(page);

	for (const surfaceId of ["inspect-surface", "live-surface"]) {
		const surface = page.getByTestId(surfaceId);
		const card = surface.locator("div.border.border-border.rounded").filter({ hasText: "LLM review" });
		await expect(card).toHaveCount(1);
		await expect(card.getByText("Timed out", { exact: true })).toBeVisible();
		await expect(card).toContainText("7.0s elapsed");
		await expect(card).toContainText("7s limit");
		await expect(card).toContainText("opaque reviewer payload zxq-4711");
		await expect(card).not.toContainText("91.2s");
		await expect(card).not.toContainText("✗");
		await expect(surface).toContainText("1 failed");
		await expect(surface.getByRole("button", { name: "Change timeout", exact: true })).toBeVisible();
	}

	const dialog = await openDialog(page);
	const input = timeoutInput(dialog);
	const current = thisGoalScope(dialog);
	const future = futureScope(dialog);

	await expect(input).toHaveValue("7");
	await expect(input).toHaveAttribute("type", "number");
	await expect(input).toHaveAttribute("min", "1");
	await expect(input).toHaveAttribute("step", "1");
	await expect(current).toBeChecked();
	await expect(future).not.toBeChecked();

	await current.uncheck();
	await saveButton(dialog).click();
	await expect(dialog.getByRole("alert")).toContainText(/select at least one|choose.*scope/i);

	await current.check();
	for (const invalid of ["", "0", "1.5"]) {
		await input.fill(invalid);
		await saveButton(dialog).click();
		await expect(dialog.getByRole("alert")).toContainText(/positive|whole|integer|at least 1/i);
	}

	const mutations = (await requests(page)).filter((entry) => entry.method !== "GET");
	expect(mutations).toEqual([]);
});

test("both scopes update complete independent definitions and customize before the future PUT", async ({ page }) => {
	await loadFixture(page);
	const before = await fixtureState(page);
	const dialog = await openDialog(page);

	await futureScope(dialog).check();
	await timeoutInput(dialog).fill("45");
	await submitAndWaitFor(page, dialog, 3);

	const log = await requests(page);
	const goalPut = log.find((entry) => entry.method === "PUT" && entry.url === GOAL_PUT);
	const projectPut = log.find((entry) => entry.method === "PUT" && entry.url === PROJECT_GET_PUT);
	expect(goalPut, "current-goal workflow PUT").toBeTruthy();
	expect(projectPut, "future-goal project workflow PUT").toBeTruthy();
	expect(goalPut!.body).toEqual(withTargetTimeout(before.activeWorkflow, 45));
	expect(withoutResolutionMetadata(projectPut!.body)).toEqual(withTargetTimeout(before.projectWorkflow, 45));

	const customizeIndex = log.findIndex((entry) => entry.method === "POST" && entry.url === CUSTOMIZE_POST);
	const projectPutIndex = log.findIndex((entry) => entry.method === "PUT" && entry.url === PROJECT_GET_PUT);
	expect(customizeIndex).toBeGreaterThanOrEqual(0);
	expect(projectPutIndex).toBeGreaterThan(customizeIndex);

	await expect(dialog.getByText(/This goal.*updated|Updated.*this goal/i)).toBeVisible();
	await expect(dialog.getByText(/Future goals.*updated|Updated.*future goals/i)).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeVisible();
});

test("future-only updates the project workflow without mutating the active goal snapshot", async ({ page }) => {
	await loadFixture(page);
	const before = await fixtureState(page);
	const dialog = await openDialog(page, "live-surface");

	await thisGoalScope(dialog).uncheck();
	await futureScope(dialog).check();
	await timeoutInput(dialog).fill("60");
	await submitAndWaitFor(page, dialog, 2);

	const log = await requests(page);
	expect(log.some((entry) => entry.method === "PUT" && entry.url === GOAL_PUT)).toBe(false);
	const projectPut = log.find((entry) => entry.method === "PUT" && entry.url === PROJECT_GET_PUT);
	expect(projectPut, "future-goal project workflow PUT").toBeTruthy();
	expect(withoutResolutionMetadata(projectPut!.body)).toEqual(withTargetTimeout(before.projectWorkflow, 60));

	const after = await fixtureState(page);
	expect(after.activeWorkflow).toEqual(before.activeWorkflow);
	expect(after.projectWorkflow).toEqual(withTargetTimeout(before.projectWorkflow, 60));
	await expect(dialog.getByText(/Future goals.*updated|Updated.*future goals/i)).toBeVisible();
});

test("a partial server failure stays inline while the successful scope remains visible and retryable", async ({ page }) => {
	const serverMessage = "Workflow cannot modify gates with active verifications";
	await loadFixture(page, { goalPutError: serverMessage });
	const dialog = await openDialog(page);

	await futureScope(dialog).check();
	await timeoutInput(dialog).fill("50");
	await submitAndWaitFor(page, dialog, 3);

	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("alert")).toContainText(serverMessage);
	await expect(dialog.getByText(/Future goals.*updated|Updated.*future goals/i)).toBeVisible();
	await expect(saveButton(dialog)).toBeEnabled();

	const log = await requests(page);
	expect(log.filter((entry) => entry.method === "PUT" && entry.url === GOAL_PUT)).toHaveLength(1);
	expect(log.filter((entry) => entry.method === "PUT" && entry.url === PROJECT_GET_PUT)).toHaveLength(1);
});
