/**
 * Browser journey for the public, project-scoped extension-settings contract.
 *
 * It installs the real Hindsight schema in the isolated gateway's server scope,
 * then drives Market as two independent projects. The secret sentinel is never
 * included in test names, titles, or fixture files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, base, registerProject } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

// A retry could hide persistence, redaction, or project-isolation failures.
test.describe.configure({ mode: "serial", retries: 0 });

const PACK_ID = "hindsight";
const PROVIDER_ID = "memory";
const SECRET_SENTINEL = "settings-browser-private-value-4f7d";

type Project = { id: string; name: string; rootPath: string };
type BrowserResponse = { status: number; text: string };

function installHindsightFixture(bobbitDir: string): string {
	const source = path.resolve(import.meta.dirname, "../../../market-packs/hindsight");
	const destination = path.join(bobbitDir, "config", "market-packs", PACK_ID);
	fs.rmSync(destination, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.cpSync(source, destination, { recursive: true });
	fs.writeFileSync(path.join(destination, ".pack-meta.yaml"), [
		"sourceUrl: e2e",
		"sourceRef: local",
		"commit: test",
		`packName: ${PACK_ID}`,
		"version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'",
		"updatedAt: '2026-01-01T00:00:00.000Z'",
		"scope: server",
	].join("\n") + "\n");
	return destination;
}

/** Real authenticated request from the rendered application's own origin. */
async function browserApi(page: Page, request: { path: string; method?: string; body?: unknown }): Promise<BrowserResponse> {
	return page.evaluate(async ({ path, method, body }) => {
		const token = localStorage.getItem("gateway.token");
		const response = await fetch(path, {
			method: method ?? "GET",
			credentials: "include",
			headers: {
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, text: await response.text() };
	}, request);
}

async function chooseProject(page: Page, project: Project): Promise<void> {
	const scope = page.locator(`[data-testid="market-project-scope"][data-project-id="${project.id}"]`);
	await expect(scope).toBeVisible({ timeout: 15_000 });
	await scope.click();
	await expect(scope).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
	await expect(page.locator(`[data-testid="market-project-runtime"][data-project-id="${project.id}"][data-pack-id="${PACK_ID}"]`)).toBeVisible({ timeout: 15_000 });
}

function providerRow(page: Page) {
	return page.locator(`[data-testid="market-project-provider-row"][data-contribution-id="${PROVIDER_ID}"]`);
}

async function openProviderSettings(page: Page) {
	const row = providerRow(page);
	const configure = row.getByTestId("market-settings-toggle");
	await expect(configure).toBeVisible({ timeout: 15_000 });
	// Keyboard activation confirms the expandable control is a real button.
	await configure.focus();
	await page.keyboard.press("Enter");
	const form = row.getByTestId("market-settings-form");
	await expect(form).toBeVisible({ timeout: 15_000 });
	return form;
}

function assertNoSecret(value: unknown): void {
	expect(JSON.stringify(value)).not.toContain(SECRET_SENTINEL);
}

test.describe("Market extension settings", () => {
	let packDir: string | undefined;
	let projectA: Project | undefined;
	let projectB: Project | undefined;
	const projectRoots: string[] = [];

	test.beforeAll(async ({ gateway }) => {
		packDir = installHindsightFixture(gateway.bobbitDir);
		const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "extension-settings-browser-a-"));
		const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "extension-settings-browser-b-"));
		projectRoots.push(rootA, rootB);
		const timestamp = Date.now();
		projectA = await registerProject({ name: `Settings browser A ${timestamp}`, rootPath: rootA, seedWorkflows: false }) as Project;
		projectB = await registerProject({ name: `Settings browser B ${timestamp}`, rootPath: rootB, seedWorkflows: false }) as Project;
	});

	test.afterAll(async () => {
		for (const project of [projectA, projectB]) {
			if (project) await apiFetch(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" }).catch(() => {});
		}
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
		for (const root of projectRoots) fs.rmSync(root, { recursive: true, force: true });
	});

	test("direct Market route persists labelled Hindsight fields, redacts secrets, and isolates project activation", async ({ page }) => {
		if (!projectA || !projectB) throw new Error("fixture projects were not registered");
		const consoleMessages: string[] = [];
		page.on("console", message => consoleMessages.push(message.text()));

		// Authenticate once, then use the direct Market hash route rather than a
		// sidebar click. This pins route bootstrap and its background settings load.
		await openApp(page);
		await page.goto(`${base()}/#/market`);
		await expect(page.locator('[data-testid="market-installed-panel"]')).toBeVisible({ timeout: 20_000 });
		const card = page.locator(`[data-testid="market-installed-pack"][data-pack-name="${PACK_ID}"]`).first();
		await expect(card).toBeVisible({ timeout: 20_000 });

		await chooseProject(page, projectA);
		const rowA = providerRow(page);
		await expect(rowA.getByTestId("market-runtime-status")).toHaveText("Needs configuration");
		const formA = await openProviderSettings(page);

		// Native labels expose all five declared kinds. The boolean is toggled with
		// Space and Save with Enter, so the journey does not rely only on clicks.
		const url = formA.getByLabel("Hindsight URL");
		const apiKey = formA.getByLabel("API key");
		const bank = formA.getByLabel("Bank");
		const recallScope = formA.getByLabel("Recall scope");
		const automaticRecall = formA.locator('[data-field-key="autoRecall"] input[type="checkbox"]');
		const recallBudget = formA.getByLabel("Recall budget");
		await expect(url).toHaveAttribute("type", "text");
		await expect(apiKey).toHaveAttribute("type", "password");
		// The DOM lookup key is metadata only; save reads the password directly
		// from this element without retaining the secret in application state.
		await expect(apiKey).toHaveAttribute("data-field-key", "apiKey");
		expect(await recallScope.evaluate(element => element.tagName)).toBe("SELECT");
		await expect(automaticRecall).toBeChecked();
		await expect(recallBudget).toHaveAttribute("type", "number");

		await url.fill("https://settings-a.invalid");
		await bank.fill("project-a-bank");
		await recallScope.selectOption("project");
		await automaticRecall.focus();
		await page.keyboard.press("Space");
		await expect(automaticRecall).not.toBeChecked();
		await recallBudget.fill("1400");
		await apiKey.fill(SECRET_SENTINEL);

		const patchPath = `/api/projects/${encodeURIComponent(projectA.id)}/extension-settings/${PACK_ID}/provider/${PROVIDER_ID}`;
		const patchResponse = page.waitForResponse(response => response.url().endsWith(patchPath) && response.request().method() === "PATCH");
		const save = formA.getByTestId("market-settings-save");
		await expect(save).toBeEnabled();
		await save.focus();
		await page.keyboard.press("Enter");
		const saved = await patchResponse;
		expect(saved.status()).toBe(200);
		const savedBody = await saved.json();
		assertNoSecret(savedBody);
		expect(savedBody.target.fields.find((field: { key: string }) => field.key === "apiKey")).toMatchObject({ type: "secret", secretSet: true });
		await expect(page.getByTestId("market-settings-status")).toContainText(`Settings saved for ${projectA.name}.`, { timeout: 15_000 });

		// Reopen after save: the status proves presence, while the password field is
		// blank. The direct GET is separately checked for response redaction.
		const savedForm = await openProviderSettings(page);
		await expect(savedForm.getByTestId("market-settings-secret-state")).toHaveAttribute("data-state", "set");
		await expect(savedForm.getByLabel("API key")).toHaveValue("");
		const projectASettings = await browserApi(page, { path: `/api/projects/${encodeURIComponent(projectA.id)}/extension-settings` });
		expect(projectASettings.status, projectASettings.text).toBe(200);
		assertNoSecret(projectASettings.text);

		// A hard reload keeps the direct route and reconstructs a redacted, empty
		// secret input rather than rehydrating a password draft.
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/market/${projectA.id}/installed`);
		await chooseProject(page, projectA);
		const reloadedForm = await openProviderSettings(page);
		await expect(reloadedForm.getByLabel("API key")).toHaveValue("");
		await expect(reloadedForm.getByTestId("market-settings-secret-state")).toHaveText("Stored for this project");

		// Project B is a fresh projection: it must not flash A's URL or expose A's
		// secret presence. Disable B's provider and then prove A remains active.
		await chooseProject(page, projectB);
		const bSettings = await browserApi(page, { path: `/api/projects/${encodeURIComponent(projectB.id)}/extension-settings` });
		expect(bSettings.status, bSettings.text).toBe(200);
		expect(bSettings.text).not.toContain("https://settings-a.invalid");
		assertNoSecret(bSettings.text);
		const formB = await openProviderSettings(page);
		await expect(formB.getByLabel("Hindsight URL")).toHaveValue("");
		await expect(formB.getByTestId("market-settings-secret-state")).toHaveAttribute("data-state", "unset");
		await providerRow(page).getByTestId("market-settings-toggle").click();
		const enabledB = providerRow(page).getByTestId("market-project-provider-enabled");
		await expect(enabledB).toBeChecked();
		await enabledB.focus();
		await page.keyboard.press("Space");
		await expect(providerRow(page).getByTestId("market-runtime-status")).toHaveText("Disabled for project", { timeout: 15_000 });

		await chooseProject(page, projectA);
		await expect(providerRow(page).getByTestId("market-runtime-status")).toHaveText("Active");
		const isolatedAForm = await openProviderSettings(page);
		await expect(isolatedAForm.getByLabel("Hindsight URL")).toHaveValue("https://settings-a.invalid");
		await expect(isolatedAForm.getByTestId("market-settings-secret-state")).toHaveAttribute("data-state", "set");

		// The sentinel must be absent after the write from every public browser
		// surface: DOM/attributes, storage, API responses, and console output.
		const browserSurfaces = await page.evaluate(() => ({
			text: document.body.innerText,
			html: document.documentElement.outerHTML,
			attributes: Array.from(document.querySelectorAll("*"), element => Array.from(element.attributes, attribute => [attribute.name, attribute.value])),
			localStorage: Object.entries(localStorage),
			sessionStorage: Object.entries(sessionStorage),
		}));
		assertNoSecret(browserSurfaces);
		assertNoSecret(consoleMessages);
	});
});
