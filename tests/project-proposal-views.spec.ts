/**
 * Render unit tests for the new project-proposal three-tab panel views
 * (G1 visuals): componentsView, workflowsView, diffView.
 *
 * Bundles src/app/project-proposal-views.ts via esbuild and exercises it in
 * a file:// Playwright fixture page (no server needed).
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/project-proposal-views.html");
const BUNDLE = path.resolve("tests/fixtures/project-proposal-views-bundle.js");
const ENTRY = path.resolve("tests/fixtures/project-proposal-views-entry.ts");
const SRC = path.resolve("src/app/project-proposal-views.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(SRC).mtimeMs);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;

test.beforeEach(async ({ page }) => {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true);
});

test("componentsView renders one card per component with data-only badge for command-less components", async ({ page }) => {
	await page.evaluate(() => {
		const tpl = (window as any).componentsView([
			{ name: "api", repo: ".", commands: { build: "npm run build", test: "npm test" } },
			{ name: "docs", repo: "docs" }, // no commands → data-only
		]);
		(window as any).renderInto("host", tpl);
	});
	await expect(page.locator('[data-testid="component-card-api"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="component-card-docs"]')).toHaveCount(1);
	// data-only badge appears on docs but not api.
	await expect(page.locator('[data-testid="component-card-docs"] [data-testid="data-only-badge"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="component-card-api"] [data-testid="data-only-badge"]')).toHaveCount(0);
});

test("componentsView empty state", async ({ page }) => {
	await page.evaluate(() => {
		const tpl = (window as any).componentsView([]);
		(window as any).renderInto("host", tpl);
	});
	await expect(page.locator('#host')).toContainText("No components proposed");
});

test("workflowsView renders one card per workflow with gate count", async ({ page }) => {
	await page.evaluate(() => {
		const wfs = {
			feature: {
				id: "feature",
				name: "Feature",
				description: "Full feature flow",
				gates: [
					{ id: "design-doc", name: "Design", content: true, verify: [{ name: "Design review", type: "llm-review", role: "architect", prompt: "Review the design." }] },
					{ id: "implementation", name: "Impl", depends_on: ["design-doc"], description: "Ralph loop", verify: [
						{ name: "Build", type: "command", phase: 0, component: "api", command: "build" },
						{ name: "Type check", type: "command", phase: 1, component: "api", command: "check" },
					] },
					{ id: "ready-to-merge", name: "Ready", depends_on: ["implementation"] },
				],
			},
			"quick-fix": { id: "quick-fix", name: "Quick fix", gates: [{ id: "implementation", name: "Impl" }] },
		};
		const tpl = (window as any).workflowsView(wfs, [{ name: "api", repo: "." }]);
		(window as any).renderInto("host", tpl);
	});
	await expect(page.locator('[data-testid="workflow-card-feature"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="workflow-card-quick-fix"]')).toHaveCount(1);
	// Gate nodes for the feature flow (3 gates).
	await expect(page.locator('[data-testid="workflow-card-feature"] [data-testid^="gate-node-"]')).toHaveCount(3);
	// Depends-on pill on the impl gate references its upstream gate id.
	await expect(page.locator('[data-testid="workflow-card-feature"] [data-testid="gate-node-implementation"]')).toContainText("design-doc");
});

test("viewTabs renders Components / Workflows / Settings", async ({ page }) => {
	await page.evaluate(() => {
		const tpl = (window as any).viewTabs("components", () => {}, {});
		(window as any).renderInto("host", tpl);
	});
	await expect(page.locator('[data-testid="view-tab-components"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="view-tab-workflows"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="view-tab-settings"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="view-tab-diff"]')).toHaveCount(0);
});

test("viewTabs renders count badges next to Components and Workflows", async ({ page }) => {
	await page.evaluate(() => {
		const tpl = (window as any).viewTabs("components", () => {}, { components: 3, workflows: 2 });
		(window as any).renderInto("host", tpl);
	});
	await expect(page.locator('[data-testid="view-tab-count-components"]')).toContainText("3");
	await expect(page.locator('[data-testid="view-tab-count-workflows"]')).toContainText("2");
});
