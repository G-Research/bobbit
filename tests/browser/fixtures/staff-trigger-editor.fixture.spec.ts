import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { createRunArtifactDirectory } from "../../support/harnesses/shared/run-isolation.js";
import { buildBundle } from "../../support/helpers/browser/fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/staff-trigger-editor-entry.ts");
const BUNDLE_DIR = createRunArtifactDirectory("staff-trigger-editor-fixture");
const BUNDLE = path.join(BUNDLE_DIR, "bundle.js");

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__staffTriggerEditorReady === true, null, { timeout: 10_000 });
}

test.beforeAll(() => {
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, path.resolve("src/app/staff-page.ts"), path.resolve("src/app/api.ts")],
	});
});

test("goal lifecycle triggers expose required-prompt validation and persist the edited trigger", async ({ page }) => {
	await loadFixture(page);
	await page.getByTestId("staff-edit-tabs").getByRole("button", { name: "Triggers" }).click();
	const panel = page.getByTestId("staff-triggers-tab-panel");
	await panel.getByRole("button", { name: "+ Add trigger" }).click();

	const select = panel.getByTestId("trigger-type-select");
	await expect(select.locator("option")).toHaveCount(5);
	await expect(select.locator('option[value="goal_created"]')).toHaveCount(1);
	await expect(select.locator('option[value="goal_archived"]')).toHaveCount(1);
	await select.selectOption("goal_created");

	await expect(panel.getByText("Wake prompt (required)")).toBeVisible();
	await expect(panel.getByText("Goal triggers require a non-empty wake prompt.")).toBeVisible();
	const save = page.getByRole("button", { name: "Save Changes" });
	await expect(save).toBeDisabled();

	await panel.getByTestId("trigger-prompt-0").fill("Investigate the newly created goal.");
	await expect(save).toBeEnabled();
	await save.click();
	await expect.poll(() => page.evaluate(() => (window as any).__staffTriggerPutBody?.triggers)).toEqual([
		expect.objectContaining({
			type: "goal_created",
			prompt: "Investigate the newly created goal.",
		}),
	]);
});
