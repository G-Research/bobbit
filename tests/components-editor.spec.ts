/**
 * Settings → Components editor (Phase 4b) — round-trip & PUT-payload helpers.
 *
 * Exercises pure helpers from src/app/components-editor.ts via a file://
 * fixture (no server needed). Acceptance criterion 7.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/components-editor.html");
const BUNDLE = path.resolve("tests/fixtures/components-editor-bundle.js");
const ENTRY = path.resolve("tests/fixtures/components-editor-entry.ts");
const SRC = path.resolve("src/app/components-editor.ts");

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

test("componentToEditState turns a normal component into editable rows", async ({ page }) => {
	const result = await page.evaluate(() => (window as any).componentToEditState({
		name: "api",
		repo: "api",
		relativePath: "packages/api",
		worktreeSetupCommand: "npm ci",
		commands: { build: "npm run build", test: "npm test" },
	}));
	expect(result.name).toBe("api");
	expect(result.repo).toBe("api");
	expect(result.relative_path).toBe("packages/api");
	expect(result.worktree_setup_command).toBe("npm ci");
	expect(result.commands).toEqual([
		{ key: "build", value: "npm run build" },
		{ key: "test", value: "npm test" },
	]);
});

test("componentToEditState gives a no-commands component an empty commands list", async ({ page }) => {
	const result = await page.evaluate(() => (window as any).componentToEditState({
		name: "fixtures",
		repo: "fixtures",
	}));
	expect(result.commands).toEqual([]);
});

test("editStateToComponent strips empty rows", async ({ page }) => {
	const result = await page.evaluate(() => (window as any).editStateToComponent({
		name: "web",
		repo: "web",
		relative_path: "",
		worktree_setup_command: "",
		commands: [
			{ key: "build", value: "npm run build" },
			{ key: "", value: "ignored" },
			{ key: "test", value: "  " },
		],
	}));
	expect(result).toEqual({ name: "web", repo: "web", commands: { build: "npm run build" } });
});

test("editStateToComponent omits commands when the list is empty (data-only)", async ({ page }) => {
	const result = await page.evaluate(() => (window as any).editStateToComponent({
		name: "shared",
		repo: "shared",
		commands: [],
	}));
	expect(result).toEqual({ name: "shared", repo: "shared" });
	expect(result.commands).toBeUndefined();
});

test("editStateToComponent defaults missing repo to '.'", async ({ page }) => {
	const result = await page.evaluate(() => (window as any).editStateToComponent({
		name: "main",
		repo: "",
		commands: [],
	}));
	expect(result.repo).toBe(".");
});

test("buildSavePayload composes the structured PUT body (no worktree_root — General tab owns it)", async ({ page }) => {
	const result = await page.evaluate(() => (window as any).buildSavePayload(
		[
			{ name: "main", repo: ".", commands: [{ key: "build", value: "npm run build" }] },
			{ name: "fixtures", repo: "fixtures", commands: [] },
		],
		{ general: { name: "General", gates: [] } },
	));
	expect(result.components).toHaveLength(2);
	expect(result.components[0]).toEqual({ name: "main", repo: ".", commands: { build: "npm run build" } });
	expect(result.components[1]).toEqual({ name: "fixtures", repo: "fixtures" });
	expect(result.workflows).toEqual({ general: { name: "General", gates: [] } });
	expect(result.worktree_root).toBeUndefined();
});

test("round-trip: clearing commands turns a component data-only", async ({ page }) => {
	const result = await page.evaluate(() => {
		const w = window as any;
		const initial = { name: "x", repo: "x", commands: { build: "npm run build" } };
		const edit = w.componentToEditState(initial);
		const out1 = w.editStateToComponent({ ...edit, commands: [] });
		const out2 = w.editStateToComponent(edit);
		return { out1, out2 };
	});
	expect(result.out1).toEqual({ name: "x", repo: "x" });
	expect(result.out2).toEqual({ name: "x", repo: "x", commands: { build: "npm run build" } });
});
