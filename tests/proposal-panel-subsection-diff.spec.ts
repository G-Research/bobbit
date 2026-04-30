/**
 * Sub-section YAML diff for project proposals (Phase 4b).
 * Uses a file:// fixture that bundles src/ui/components/ProjectProposalPanel.ts.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/proposal-panel-subsection-diff.html");
const BUNDLE = path.resolve("tests/fixtures/proposal-panel-subsection-diff-bundle.js");
const ENTRY = path.resolve("tests/fixtures/proposal-panel-subsection-diff-entry.ts");
const SRC = path.resolve("src/ui/components/ProjectProposalPanel.ts");

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

test("identical YAML → all sections unchanged", async ({ page }) => {
	const result = await page.evaluate(() => {
		const yaml = `name: foo\nbuild_command: npm run build\n`;
		return (window as any).diffProjectYaml(yaml, yaml);
	});
	expect(result.changedCount).toBe(0);
	for (const section of result.sections) {
		expect(section.status).toBe("unchanged");
	}
});

test("workflows-only edit produces a single changed section", async ({ page }) => {
	const result = await page.evaluate(() => {
		const oldYaml = `name: foo\nbuild_command: npm run build\nworkflows:\n  general:\n    name: General\n    gates: []\n`;
		const newYaml = `name: foo\nbuild_command: npm run build\nworkflows:\n  general:\n    name: General Updated\n    gates: []\n`;
		return (window as any).diffProjectYaml(oldYaml, newYaml);
	});
	expect(result.changedCount).toBe(1);
	const changed = result.sections.find((s: any) => s.status === "changed");
	expect(changed?.key).toBe("workflows");
	const unchangedKeys = result.sections.filter((s: any) => s.status === "unchanged").map((s: any) => s.key);
	expect(unchangedKeys).toContain("name");
	expect(unchangedKeys).toContain("build_command");
});

test("components added → status 'added' and 'unchanged' for unrelated keys", async ({ page }) => {
	const result = await page.evaluate(() => {
		const oldYaml = `name: foo\nbuild_command: npm run build\n`;
		const newYaml = `name: foo\nbuild_command: npm run build\ncomponents:\n  - name: foo\n    repo: .\n`;
		return (window as any).diffProjectYaml(oldYaml, newYaml);
	});
	expect(result.changedCount).toBe(1);
	const added = result.sections.find((s: any) => s.key === "components");
	expect(added?.status).toBe("added");
	expect(added?.oldYaml).toBe("");
	expect(added?.newYaml).toContain("name: foo");
});

test("components removed → status 'removed'", async ({ page }) => {
	const result = await page.evaluate(() => {
		const oldYaml = `name: foo\ncomponents:\n  - name: foo\n    repo: .\n`;
		const newYaml = `name: foo\n`;
		return (window as any).diffProjectYaml(oldYaml, newYaml);
	});
	const removed = result.sections.find((s: any) => s.key === "components");
	expect(removed?.status).toBe("removed");
});

test("renderProjectProposalDiff omits unchanged sections from the unified diff", async ({ page }) => {
	const text = await page.evaluate(() => {
		const oldYaml = `name: foo\nbuild_command: npm run build\nworkflows:\n  general:\n    name: General\n`;
		const newYaml = `name: foo\nbuild_command: npm run build\nworkflows:\n  general:\n    name: New\n`;
		return (window as any).renderProjectProposalDiff(oldYaml, newYaml);
	});
	expect(text).toContain("workflows (changed)");
	expect(text).not.toContain("build_command (unchanged)");
	expect(text).not.toContain("name (unchanged)");
});

test("known structural keys (workflows, components) get a stable order", async ({ page }) => {
	const keys = await page.evaluate(() => {
		const oldYaml = `zzz: 1\nworkflows: {}\nbuild_command: x\ncomponents: []\nname: foo\nworktree_root: /tmp\n`;
		const newYaml = `zzz: 2\nworkflows: { general: { name: G } }\nbuild_command: y\ncomponents: [{ name: a, repo: . }]\nname: bar\nworktree_root: /opt\n`;
		return (window as any).diffProjectYaml(oldYaml, newYaml).sections.map((s: any) => s.key);
	});
	// known order: name, rootPath, worktree_root, components, workflows, then alphabetical
	expect(keys.indexOf("name")).toBeLessThan(keys.indexOf("worktree_root"));
	expect(keys.indexOf("worktree_root")).toBeLessThan(keys.indexOf("components"));
	expect(keys.indexOf("components")).toBeLessThan(keys.indexOf("workflows"));
	expect(keys.indexOf("workflows")).toBeLessThan(keys.indexOf("zzz"));
	expect(keys.indexOf("build_command")).toBeLessThan(keys.indexOf("zzz"));
});
