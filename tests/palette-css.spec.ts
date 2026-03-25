import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file:///${path.resolve("tests/fixtures/palette-css.html").replace(/\\/g, "/")}`;

/** Helper: get a CSS custom property value from :root */
async function getCssVar(page: any, varName: string): Promise<string> {
	return page.evaluate(
		(v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(),
		varName
	);
}

/** Helper: set palette and optionally dark mode */
async function setPalette(page: any, id: string | null, dark = false): Promise<void> {
	await page.evaluate(
		({ id, dark }: { id: string | null; dark: boolean }) => {
			if (id) document.documentElement.dataset.palette = id;
			else delete document.documentElement.dataset.palette;
			if (dark) document.documentElement.classList.add("dark");
			else document.documentElement.classList.remove("dark");
		},
		{ id, dark }
	);
}

test.describe("palette CSS custom properties", () => {
	test("default (forest) palette values are applied", async ({ page }) => {
		await page.goto(FIXTURE);
		const val = await getCssVar(page, "--notif-system-bg");
		expect(val).toContain("100");
		expect(val).toContain("120");
		expect(val).toContain("160");
	});

	test("default (forest) theme vars are applied", async ({ page }) => {
		await page.goto(FIXTURE);
		// --primary should contain oklch with hue ~148
		const primary = await getCssVar(page, "--primary");
		expect(primary).toContain("oklch");
		expect(primary).toContain("148");
	});

	test("ocean palette overrides theme and notification vars", async ({ page }) => {
		await page.goto(FIXTURE);
		await setPalette(page, "ocean");
		const notif = await getCssVar(page, "--notif-system-bg");
		expect(notif).toContain("60");
		expect(notif).toContain("120");
		expect(notif).toContain("190");
		const primary = await getCssVar(page, "--primary");
		expect(primary).toContain("230");
	});

	test("dusk palette overrides theme and notification vars", async ({ page }) => {
		await page.goto(FIXTURE);
		await setPalette(page, "dusk");
		const primary = await getCssVar(page, "--primary");
		expect(primary).toContain("300");
		const accent = await getCssVar(page, "--user-msg-accent");
		expect(accent).toContain("160");
		expect(accent).toContain("90");
		expect(accent).toContain("180");
	});

	test("ember palette overrides theme vars", async ({ page }) => {
		await page.goto(FIXTURE);
		await setPalette(page, "ember");
		const primary = await getCssVar(page, "--primary");
		expect(primary).toContain("65");
		const accent = await getCssVar(page, "--user-msg-accent");
		expect(accent).toContain("190");
		expect(accent).toContain("140");
	});

	test("rose palette overrides theme vars", async ({ page }) => {
		await page.goto(FIXTURE);
		await setPalette(page, "rose");
		const primary = await getCssVar(page, "--primary");
		expect(primary).toContain("0.38");
		expect(primary).toContain("10");
		const accent = await getCssVar(page, "--user-msg-accent");
		expect(accent).toContain("190");
		expect(accent).toContain("80");
		expect(accent).toContain("90");
	});

	test("slate palette uses low chroma", async ({ page }) => {
		await page.goto(FIXTURE);
		await setPalette(page, "slate");
		const primary = await getCssVar(page, "--primary");
		expect(primary).toContain("0.04");
		expect(primary).toContain("260");
	});

	test("sand palette overrides theme vars", async ({ page }) => {
		await page.goto(FIXTURE);
		await setPalette(page, "sand");
		const primary = await getCssVar(page, "--primary");
		expect(primary).toContain("85");
	});

	test("teal palette overrides theme vars", async ({ page }) => {
		await page.goto(FIXTURE);
		await setPalette(page, "teal");
		const primary = await getCssVar(page, "--primary");
		expect(primary).toContain("195");
	});

	test("copper palette overrides theme vars", async ({ page }) => {
		await page.goto(FIXTURE);
		await setPalette(page, "copper");
		const primary = await getCssVar(page, "--primary");
		expect(primary).toContain("50");
		const accent = await getCssVar(page, "--user-msg-accent");
		expect(accent).toContain("180");
		expect(accent).toContain("120");
	});

	test("mono palette overrides custom properties", async ({ page }) => {
		await page.goto(FIXTURE);
		await setPalette(page, "mono");
		const accent = await getCssVar(page, "--user-msg-accent");
		expect(accent).toContain("156");
		expect(accent).toContain("163");
		expect(accent).toContain("175");
		// Primary should have zero chroma
		const primary = await getCssVar(page, "--primary");
		expect(primary).toContain("oklch");
		expect(primary).toContain("0.38");
	});

	test("removing palette resets to forest defaults", async ({ page }) => {
		await page.goto(FIXTURE);
		await setPalette(page, "ocean");
		let val = await getCssVar(page, "--user-msg-accent");
		expect(val).toContain("50");
		expect(val).toContain("120");
		expect(val).toContain("190");
		// Remove palette
		await setPalette(page, null);
		val = await getCssVar(page, "--user-msg-accent");
		expect(val).toContain("80");
		expect(val).toContain("140");
		expect(val).toContain("80");
	});

	test("computed styles on elements change with palette", async ({ page }) => {
		await page.goto(FIXTURE);
		let bg = await page.evaluate(() =>
			getComputedStyle(document.getElementById("system-box")!).backgroundColor
		);
		expect(bg).toContain("100");

		await setPalette(page, "ocean");
		bg = await page.evaluate(() =>
			getComputedStyle(document.getElementById("system-box")!).backgroundColor
		);
		expect(bg).toContain("60");
	});

	test("dark mode overrides work for ocean palette", async ({ page }) => {
		await page.goto(FIXTURE);
		await setPalette(page, "ocean", true);
		const primary = await getCssVar(page, "--primary");
		// Dark mode ocean primary: oklch(0.72 0.12 230)
		expect(primary).toContain("0.72");
		expect(primary).toContain("230");
		const bg = await getCssVar(page, "--background");
		expect(bg).toContain("0.21");
	});

	test("dark mode overrides work for mono palette", async ({ page }) => {
		await page.goto(FIXTURE);
		await setPalette(page, "mono", true);
		const primary = await getCssVar(page, "--primary");
		expect(primary).toContain("0.72");
		const bg = await getCssVar(page, "--background");
		expect(bg).toContain("0.21");
	});
});
