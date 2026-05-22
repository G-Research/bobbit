import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/search-preview-archive-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "search-preview-archive-bundle.js");
const AGENT_INTERFACE_SRC = path.resolve("src/ui/components/AgentInterface.ts");
const CHOOSER_SRC = path.resolve("src/ui/components/ContinueSessionChooser.ts");
const GATEWAY_FETCH_SRC = path.resolve("src/app/gateway-fetch.ts");

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__archiveFixtureReady === true, null, { timeout: 10_000 });
}

async function renderArchived(page: Page, opts: Record<string, unknown> = {}): Promise<void> {
	await page.evaluate((fixtureOpts) => (window as any).__renderArchivedFixture(fixtureOpts), opts);
}

async function archivedFetchLog(page: Page): Promise<Array<{ url: string; method: string; body: unknown }>> {
	return await page.evaluate(() => (window as any).__getArchivedFetchLog());
}

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, AGENT_INTERFACE_SRC, CHOOSER_SRC, GATEWAY_FETCH_SRC],
	});
});

test.describe("Archived session footer fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("proposal drafts surface Resubmit and Continue actions", async ({ page }) => {
		for (const type of ["goal", "role"]) {
			await renderArchived(page, { sessionId: `archived-${type}`, proposalTypes: [type], assistantType: type });
			const footer = page.locator("[data-continue-archived-footer]");
			await expect(footer).toBeVisible({ timeout: 10_000 });
			const resubmit = footer.locator("[data-action='resubmit-proposal']");
			await expect(resubmit).toBeVisible({ timeout: 10_000 });
			await expect(resubmit).toHaveAttribute("data-proposal-type", type);
			await expect(footer.locator("[data-action='continue-archived']")).toBeVisible();
		}
	});

	test("no draft shows only Continue, and Cancel closes the chooser", async ({ page }) => {
		await renderArchived(page, { proposalTypes: [] });
		const footer = page.locator("[data-continue-archived-footer]");
		await expect(footer).toBeVisible({ timeout: 10_000 });
		await expect(footer.locator("[data-action='continue-archived']")).toBeVisible();
		await expect(footer.locator("[data-action='resubmit-proposal']")).toHaveCount(0);

		await footer.locator("[data-action='continue-archived']").click();
		const chooser = page.locator("continue-session-chooser");
		await expect(chooser).toBeVisible({ timeout: 5_000 });
		await expect(chooser.locator("[data-proposal-carryover]")).toHaveCount(0);
		await expect(chooser.locator("[data-mode]")).toHaveCount(0);
		await chooser.locator("[data-action='cancel']").click();
		await expect(chooser).toHaveCount(0);
	});

	test("Continue carries proposal context, POSTs, and navigates to the new session", async ({ page }) => {
		await renderArchived(page, {
			sessionId: "archived-source",
			proposalTypes: ["goal"],
			continueId: "continued-target",
			assistantType: "goal",
		});

		const footer = page.locator("[data-continue-archived-footer]");
		await expect(footer).toBeVisible({ timeout: 10_000 });
		await footer.locator("[data-action='continue-archived']").click();

		const chooser = page.locator("continue-session-chooser");
		await expect(chooser).toBeVisible({ timeout: 5_000 });
		await expect(chooser.locator("[data-proposal-carryover]")).toContainText("carried over");
		await chooser.locator("[data-action='continue']").click();

		await expect.poll(async () => page.evaluate(() => window.location.hash), { timeout: 5_000 })
			.toBe("#/session/continued-target");
		await expect.poll(async () => (await archivedFetchLog(page)).map(e => `${e.method} ${e.url}`))
			.toContain("POST /api/sessions/archived-source/continue");
	});

	test("scope gates hide the archived footer for unsupported sessions", async ({ page }) => {
		for (const opts of [
			{ goalId: "goal-1" },
			{ delegateOf: "parent-1" },
			{ teamGoalId: "team-1" },
			{ projectId: "missing-project", knownProject: false },
			{ projectId: null },
		]) {
			await renderArchived(page, opts);
			await expect(page.locator("[data-continue-archived-footer]")).toHaveCount(0);
		}
	});

	test("persisted archived model renders in a read-only footer", async ({ page }) => {
		await renderArchived(page, { modelId: "claude-sonnet-4-20250514" });

		const footerModel = page.locator('[data-testid="footer-model-id"]');
		await expect(footerModel).toBeVisible({ timeout: 10_000 });
		await expect(footerModel).toHaveText("claude-sonnet-4-20250514");
		await expect(footerModel).not.toHaveText("claude-opus-4-6");
		await expect(page.locator("message-editor")).toHaveCount(0);
		await expect(page.getByRole("button", { name: /Continue in New Session/i })).toBeVisible();
	});
});
