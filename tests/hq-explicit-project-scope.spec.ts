import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/hq-explicit-project-scope-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "hq-explicit-project-scope-bundle.js");

const SKILLS_SRC = path.resolve("src/app/skills-page.ts");
const SETTINGS_SRC = path.resolve("src/app/settings-page.ts");
const CONFIG_SCOPE_SRC = path.resolve("src/app/config-scope.ts");
const HEADQUARTERS_SRC = path.resolve("src/app/headquarters.ts");

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, SKILLS_SRC, SETTINGS_SRC, CONFIG_SCOPE_SRC, HEADQUARTERS_SRC],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__hqExplicitScopeReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__resetHqExplicitScopeFixture());
}

async function renderSkills(page: Page, scope: string): Promise<void> {
	await page.evaluate((s) => (window as any).__renderHqExplicitSkills(s), scope);
}

async function renderSettings(page: Page, hash: string): Promise<void> {
	await page.evaluate((h) => (window as any).__renderHqExplicitSettings(h), hash);
}

async function fetchLog(page: Page): Promise<Array<{ url: string; method: string; body: unknown }>> {
	return await page.evaluate(() => (window as any).__getHqExplicitFetchLog());
}

async function clearFetchLog(page: Page): Promise<void> {
	await page.evaluate(() => (window as any).__clearHqExplicitFetchLog());
}

async function waitForFetch(page: Page, urlPattern: RegExp, method = "GET"): Promise<void> {
	await page.waitForFunction(
		({ source, flags, method }) => {
			const re = new RegExp(source, flags);
			return (window as any).__getHqExplicitFetchLog().some((entry: any) => entry.method === method && re.test(entry.url));
		},
		{ source: urlPattern.source, flags: urlPattern.flags, method },
		{ timeout: 10_000 },
	);
}

test.describe("Headquarters explicit projectId UI calls", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("Headquarters Skills loads and refreshes details with projectId=headquarters", async ({ page }) => {
		await renderSkills(page, "system");
		await waitForFetch(page, /^\/api\/slash-skills\/details\?projectId=headquarters$/);
		await expect(page.getByText("/hq-skill")).toBeVisible();

		let log = await fetchLog(page);
		expect(log.some((entry) => entry.url === "/api/slash-skills/details" && entry.method === "GET")).toBe(false);

		await clearFetchLog(page);
		await page.getByRole("button", { name: /Skill Directories/ }).click();
		await page.getByPlaceholder("~/my-skills or /absolute/path").fill("/fixture/custom-skills");
		await page.getByRole("button", { name: /^Add$/ }).click();
		await waitForFetch(page, /^\/api\/project-config$/, "PUT");
		await waitForFetch(page, /^\/api\/slash-skills\/details\?projectId=headquarters$/);

		log = await fetchLog(page);
		expect(log.some((entry) => entry.url === "/api/slash-skills/details" && entry.method === "GET")).toBe(false);
	});

	test("normal project Skills loads details with the normal project id", async ({ page }) => {
		await renderSkills(page, "proj-1");
		await waitForFetch(page, /^\/api\/slash-skills\/details\?projectId=proj-1$/);
		await expect(page.getByText("/project-skill")).toBeVisible();
	});

	test("Headquarters Config Directories loads with projectId=headquarters", async ({ page }) => {
		await renderSettings(page, "#/settings/system/directories");
		await waitForFetch(page, /^\/api\/config-directories\?projectId=headquarters$/);
		await expect(page.getByText("/fixture/.bobbit/headquarters/config/skills")).toBeVisible();
	});

	test("normal project Config Directories loads with the normal project id", async ({ page }) => {
		await renderSettings(page, "#/settings/proj-1/directories");
		await waitForFetch(page, /^\/api\/config-directories\?projectId=proj-1$/);
		await expect(page.getByText("/fixture/project/.bobbit/config/skills")).toBeVisible();
	});
});
