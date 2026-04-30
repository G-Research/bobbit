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
	// Step badges by type.
	await expect(page.locator('[data-testid="step-badge-llm-review"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="step-badge-command"]')).toHaveCount(2);
	// Depends-on annotation — scope to feature card (quick-fix also has an `implementation` gate id).
	await expect(page.locator('[data-testid="workflow-card-feature"] [data-testid="gate-node-implementation"]')).toContainText("depends on design-doc");
	// Ralph-loop description surfaces on the impl gate.
	await expect(page.locator('[data-testid="workflow-card-feature"] [data-testid="gate-node-implementation"]')).toContainText("Ralph loop");
});

test("diffView shows added / changed / removed sections for components and workflows", async ({ page }) => {
	await page.evaluate(() => {
		const prev = {
			components: [{ name: "api", repo: "." }, { name: "old", repo: "old" }],
			workflows: {
				general: { id: "general", gates: [{ id: "design-doc" }, { id: "implementation" }] },
				removed: { id: "removed", gates: [] },
			},
		};
		const cur = {
			components: [
				{ name: "api", repo: ".", commands: { build: "npm run build" } }, // changed
				{ name: "docs", repo: "docs" },                                    // added
			],
			workflows: {
				general: { id: "general", gates: [{ id: "design-doc" }, { id: "implementation" }, { id: "ready-to-merge" }] }, // gate added
				feature: { id: "feature", gates: [] }, // workflow added
			},
		};
		const tpl = (window as any).diffView(prev, cur);
		(window as any).renderInto("host", tpl);
	});

	// Components: 1 added (docs), 1 changed (api), 1 removed (old).
	await expect(page.locator('[data-testid="diff-component-added"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="diff-component-changed"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="diff-component-removed"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="diff-component-added"]')).toContainText("docs");
	await expect(page.locator('[data-testid="diff-component-removed"]')).toContainText("old");

	// Workflows: 1 added (feature), 1 changed (general gate added), 1 removed (removed).
	await expect(page.locator('[data-testid="diff-workflow-added"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="diff-workflow-changed"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="diff-workflow-removed"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="diff-workflow-added"]')).toContainText("feature");
	await expect(page.locator('[data-testid="diff-workflow-removed"]')).toContainText("removed");
	// Changed workflow expansion mentions the new gate id.
	await expect(page.locator('[data-testid="diff-workflow-changed"]')).toContainText("ready-to-merge");
});

test("diffView empty state when previous is null", async ({ page }) => {
	await page.evaluate(() => {
		const tpl = (window as any).diffView(null, { components: [], workflows: {} });
		(window as any).renderInto("host", tpl);
	});
	await expect(page.locator('[data-testid="diff-empty"]')).toContainText("first proposal");
});

test("viewTabs disables the Diff tab when no diff is available", async ({ page }) => {
	await page.evaluate(() => {
		const tpl = (window as any).viewTabs("components", () => {}, false);
		(window as any).renderInto("host", tpl);
	});
	await expect(page.locator('[data-testid="view-tab-components"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="view-tab-workflows"]')).toHaveCount(1);
	const diffDisabled = await page.locator('[data-testid="view-tab-diff"]').isDisabled();
	expect(diffDisabled).toBe(true);
});
