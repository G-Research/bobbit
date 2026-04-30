/**
 * New Goal dialog — inline workflow / roles YAML parse + inline error.
 *
 * Drives the dialog from a file:// fixture (no server). Verifies:
 *   1. Pasting malformed YAML into the inline-workflow textarea renders
 *      the inline error and disables the Create button.
 *   2. Fixing the YAML clears the error and re-enables Create.
 *   3. Submitting with valid inline YAML resolves with parsed objects on
 *      `inlineWorkflow` / `inlineRoles`.
 *   4. The same flow works for the inline-roles textarea.
 *
 * See `docs/design/nested-goals.md` §10.4 + §7 + Phase 6 task 6.3.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/inline-workflow-validation.html");
const BUNDLE = path.resolve("tests/fixtures/inline-workflow-validation-bundle.js");
const ENTRY = path.resolve("tests/fixtures/inline-workflow-validation-entry.ts");
const DIALOGS_SRC = path.resolve("src/app/dialogs.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(DIALOGS_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				"--alias:pdfjs-dist=./tests/fixtures/empty-shim",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;
const PROJECT_ID = "test-project-inline-validation";

test.beforeEach(async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 1024 });
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
});

async function openDialog(page: any) {
	await page.evaluate((projectId: string) => {
		const p = (window as any).__showNewGoalDialog({ projectId });
		p.then((r: unknown) => { (window as any).__lastResult = r; });
		(window as any).__dialogPromise = p;
	}, PROJECT_ID);
	await page.waitForSelector("[data-testid='goal-spec-textarea']");
	// Open Advanced disclosure so the inline textareas are reachable.
	await page.locator("[data-testid='advanced-disclosure'] summary").click();
	await page.waitForSelector("[data-testid='inline-workflow-yaml']");
}

async function clickCreate(page: any): Promise<void> {
	await page.evaluate(() => {
		const btns = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
		for (const b of btns) {
			if ((b.textContent || "").trim() === "Create" && !b.disabled) {
				b.click();
				return;
			}
		}
	});
}

test.describe("New Goal dialog — inline YAML validation", () => {
	test("malformed inline-workflow YAML shows inline error and disables Create", async ({ page }) => {
		await openDialog(page);
		await page.locator("[data-testid='goal-title' i], input[placeholder='Goal title']").first().fill("Test goal");

		// Malformed YAML — unbalanced indentation / bracket. The yaml parser
		// throws; our handler surfaces the message under the textarea.
		const broken = "id: bad\ngates:\n  - id: charter\n    dependsOn: [unterminated";
		await page.locator("[data-testid='inline-workflow-yaml']").fill(broken);

		await expect(page.locator("[data-testid='inline-workflow-error']")).toBeVisible();
		// Some non-empty error text was rendered.
		const errText = (await page.locator("[data-testid='inline-workflow-error']").textContent()) || "";
		expect(errText.trim().length).toBeGreaterThan(0);

		// Create button is disabled.
		const createDisabled = await page.evaluate(() => {
			const btns = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
			return btns.find(b => (b.textContent || "").trim() === "Create")?.disabled === true;
		});
		expect(createDisabled).toBe(true);
	});

	test("fixing the YAML clears the error and re-enables Create", async ({ page }) => {
		await openDialog(page);
		await page.locator("input[placeholder='Goal title']").first().fill("Test goal");

		// Start with bad YAML.
		await page.locator("[data-testid='inline-workflow-yaml']").fill("id: bad\ngates: [unterm");
		await expect(page.locator("[data-testid='inline-workflow-error']")).toBeVisible();

		// Replace with a valid inline workflow.
		const good = `id: my-flow
name: My Flow
gates:
  - id: charter
    name: Charter
  - id: ready-to-merge
    name: Ready
    dependsOn: [charter]`;
		await page.locator("[data-testid='inline-workflow-yaml']").fill(good);

		await expect(page.locator("[data-testid='inline-workflow-error']")).toHaveCount(0);
		const createDisabled = await page.evaluate(() => {
			const btns = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
			return btns.find(b => (b.textContent || "").trim() === "Create")?.disabled === true;
		});
		expect(createDisabled).toBe(false);
	});

	test("malformed inline-roles YAML shows error and disables Create", async ({ page }) => {
		await openDialog(page);
		await page.locator("input[placeholder='Goal title']").first().fill("Test goal");

		// Top-level array (not a mapping) → inline error.
		await page.locator("[data-testid='inline-roles-yaml']").fill("- coder\n- tester");
		await expect(page.locator("[data-testid='inline-roles-error']")).toBeVisible();

		const createDisabled = await page.evaluate(() => {
			const btns = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
			return btns.find(b => (b.textContent || "").trim() === "Create")?.disabled === true;
		});
		expect(createDisabled).toBe(true);
	});

	test("submitting with valid inline YAML resolves with parsed objects", async ({ page }) => {
		await openDialog(page);
		await page.locator("input[placeholder='Goal title']").first().fill("Test goal");

		const wf = `id: my-flow
name: My Flow
gates:
  - id: charter
    name: Charter
  - id: ready-to-merge
    name: Ready
    dependsOn: [charter]`;
		await page.locator("[data-testid='inline-workflow-yaml']").fill(wf);

		const roles = `coder:
  label: Coder
  promptTemplate: You are a coder.
  accessory: hat`;
		await page.locator("[data-testid='inline-roles-yaml']").fill(roles);

		// Both errors gone.
		await expect(page.locator("[data-testid='inline-workflow-error']")).toHaveCount(0);
		await expect(page.locator("[data-testid='inline-roles-error']")).toHaveCount(0);

		await clickCreate(page);

		// Wait for the dialog promise to resolve and stash __lastResult.
		await page.waitForFunction(() => (window as any).__lastResult !== undefined, null, { timeout: 5000 });
		const result = await page.evaluate(() => (window as any).__readLastResult());

		expect(result).toBeTruthy();
		expect(result.title).toBe("Test goal");
		expect(result.inlineWorkflow).toEqual({
			id: "my-flow",
			name: "My Flow",
			gates: [
				{ id: "charter", name: "Charter" },
				{ id: "ready-to-merge", name: "Ready", dependsOn: ["charter"] },
			],
		});
		expect(result.inlineRoles).toEqual({
			coder: { label: "Coder", promptTemplate: "You are a coder.", accessory: "hat" },
		});
		// Raw YAML preserved for caller round-tripping.
		expect(typeof result.inlineWorkflowYaml).toBe("string");
		expect(result.inlineWorkflowYaml.length).toBeGreaterThan(0);
	});

	test("empty inline textareas resolve with undefined parsed values (still valid submit)", async ({ page }) => {
		await openDialog(page);
		await page.locator("input[placeholder='Goal title']").first().fill("Test goal");
		// Trigger a re-render so the Create button reflects the filled title
		// (the title input handler is intentionally non-rendering; spec textarea
		// fill drives the same render the multi-phase banner relies on).
		await page.locator("[data-testid='goal-spec-textarea']").fill("x");

		// Leave both inline textareas empty; no errors should render.
		await expect(page.locator("[data-testid='inline-workflow-error']")).toHaveCount(0);
		await expect(page.locator("[data-testid='inline-roles-error']")).toHaveCount(0);

		await clickCreate(page);
		await page.waitForFunction(() => (window as any).__lastResult !== undefined, null, { timeout: 5000 });
		const result = await page.evaluate(() => (window as any).__readLastResult());
		expect(result).toBeTruthy();
		expect(result.inlineWorkflow).toBeUndefined();
		expect(result.inlineRoles).toBeUndefined();
	});
});
