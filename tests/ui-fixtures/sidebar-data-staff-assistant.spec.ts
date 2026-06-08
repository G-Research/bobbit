import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/sidebar-data-staff-assistant-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "sidebar-data-staff-assistant-bundle.js");

const STATE_SRC = path.resolve("src/app/state.ts");

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, STATE_SRC] });
});

async function load(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__staffAssistantSidebarReady === true, null, { timeout: 10_000 });
}

test.describe("getSidebarData — staff-creation assistant visibility", () => {
	test("staff-creation assistant appears in Sessions bucket; staff-agent session does not", async ({ page }) => {
		await load(page);
		const ids = await page.evaluate(() => (window as any).__staffAssistantSidebar.ungroupedIds());

		// The ephemeral staff-creation assistant must be visible alongside the
		// goal assistant and plain sessions.
		expect(ids).toContain("staff-creation-assistant");
		expect(ids).toContain("goal-creation-assistant");
		expect(ids).toContain("plain-session");

		// The real staff-agent permanent session stays out of the Sessions bucket
		// (it renders under the dedicated Staff header).
		expect(ids).not.toContain("staff-agent-session");
	});
});
