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
import { apiFetch, base, readE2ETokenAsync, registerProject } from "../e2e-setup.js";

// A retry could hide persistence, redaction, or project-isolation failures.
test.describe.configure({ mode: "serial", retries: 0 });

const PACK_ID = "hindsight";
const PROVIDER_ID = "memory";
const INITIAL_SECRET_SENTINEL = "settings-browser-private-value-4f7d";
const ROTATED_SECRET_SENTINEL = "settings-browser-private-value-rotation-93ce";

type Project = { id: string; name: string; rootPath: string };
type BrowserResponse = { status: number; text: string };

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

function assertNoSecrets(value: unknown): void {
	const serialized = JSON.stringify(value);
	for (const secret of [INITIAL_SECRET_SENTINEL, ROTATED_SECRET_SENTINEL]) expect(serialized).not.toContain(secret);
}

async function publicBrowserSurfaces(page: Page): Promise<unknown> {
	return page.evaluate(() => ({
		text: document.body.innerText,
		html: document.documentElement.outerHTML,
		attributes: Array.from(document.querySelectorAll("*"), element => Array.from(element.attributes, attribute => [attribute.name, attribute.value])),
		localStorage: Object.entries(localStorage),
		sessionStorage: Object.entries(sessionStorage),
	}));
}

test.describe("Market extension settings", () => {
	let projectA: Project | undefined;
	let projectB: Project | undefined;
	const projectRoots: string[] = [];

	test.beforeAll(async () => {
		// Hindsight ships as an enabled built-in. Resetting its public activation
		// state avoids a copied server-market fixture shadowing the pack under test.
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
		});
		expect(activation.status, `Hindsight built-in activation reset failed: ${await activation.clone().text()}`).toBe(200);
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
		await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
		}).catch(() => {});
		for (const root of projectRoots) fs.rmSync(root, { recursive: true, force: true });
	});

	test("direct Market route persists labelled Hindsight fields, redacts secrets, and isolates project activation", async ({ page }) => {
		if (!projectA || !projectB) throw new Error("fixture projects were not registered");
		const consoleMessages: string[] = [];
		page.on("console", message => consoleMessages.push(message.text()));

		// Authenticate directly into Market rather than booting the home route and
		// then reloading into Market. This still exercises the direct-route
		// bootstrap, while keeping the complete persistence journey within its
		// fixed end-to-end budget under concurrent browser load.
		const token = await readE2ETokenAsync();
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/market`);
		await expect(page.locator('[data-testid="market-installed-panel"]')).toBeVisible({ timeout: 20_000 });
		const card = page.locator(`[data-testid="market-installed-pack"][data-pack-name="${PACK_ID}"]`).first();
		await expect(card).toBeVisible({ timeout: 20_000 });

		await chooseProject(page, projectA);
		const rowA = providerRow(page);
		await expect(rowA.getByTestId("market-runtime-status")).toHaveText("Active");
		const formA = await openProviderSettings(page);

		// Native labels expose all five declared kinds. The boolean is toggled with
		// Space and Save with Enter, so the journey does not rely only on clicks.
		const url = formA.getByLabel("Hindsight URL");
		const apiKey = formA.getByLabel("API key", { exact: true });
		const bank = formA.getByLabel("Bank");
		const runtimeMode = formA.getByLabel("Runtime mode");
		const automaticRecall = formA.locator('[data-field-key="autoRecall"] input[type="checkbox"]');
		const recallBudget = formA.getByLabel("Recall budget");
		await expect(url).toHaveAttribute("type", "text");
		await expect(apiKey).toHaveAttribute("type", "password");
		// The DOM lookup key is metadata only; save reads the password directly
		// from this element without retaining the secret in application state.
		await expect(apiKey).toHaveAttribute("data-field-key", "apiKey");
		expect(await runtimeMode.evaluate(element => element.tagName)).toBe("SELECT");
		await expect(runtimeMode).toHaveValue("external");
		await expect(automaticRecall).toBeChecked();
		await expect(recallBudget).toHaveAttribute("type", "number");

		await url.fill("https://settings-a.invalid");
		await bank.fill("project-a-bank");
		await runtimeMode.selectOption("local");
		await runtimeMode.selectOption("external");
		await automaticRecall.focus();
		await page.keyboard.press("Space");
		await expect(automaticRecall).not.toBeChecked();
		await recallBudget.fill("1400");
		await apiKey.fill(INITIAL_SECRET_SENTINEL);

		const patchPath = `/api/projects/${encodeURIComponent(projectA.id)}/extension-settings/${PACK_ID}/provider/${PROVIDER_ID}`;
		const patchResponse = page.waitForResponse(response => response.url().endsWith(patchPath) && response.request().method() === "PATCH");
		const save = formA.getByTestId("market-settings-save");
		await expect(save).toBeEnabled();
		await save.focus();
		await page.keyboard.press("Enter");
		const saved = await patchResponse;
		expect(saved.status()).toBe(200);
		const savedBody = await saved.json();
		assertNoSecrets(savedBody);
		expect(savedBody.target.fields.find((field: { key: string }) => field.key === "apiKey")).toMatchObject({ type: "secret", secretSet: true });
		await expect(page.getByTestId("market-settings-status")).toContainText(`Settings saved for ${projectA.name}.`, { timeout: 15_000 });

		// A password replacement is the only draft change here. It must enable Save
		// without retaining either value in public application state.
		const savedForm = await openProviderSettings(page);
		const rotatedApiKey = savedForm.getByLabel("API key", { exact: true });
		const rotatedSave = savedForm.getByTestId("market-settings-save");
		await expect(savedForm.locator('[data-field-key="apiKey"]').getByTestId("market-settings-secret-state")).toHaveAttribute("data-state", "set");
		await expect(rotatedApiKey).toHaveValue("");
		await expect(rotatedSave).toBeDisabled();
		await rotatedApiKey.fill(ROTATED_SECRET_SENTINEL);
		await expect(rotatedSave).toBeEnabled();
		const rotateResponse = page.waitForResponse(response => response.url().endsWith(patchPath) && response.request().method() === "PATCH");
		await rotatedSave.click();
		const rotated = await rotateResponse;
		expect(rotated.status()).toBe(200);
		const rotatedBody = await rotated.json();
		assertNoSecrets(rotatedBody);
		expect(rotatedBody.target.fields.find((field: { key: string }) => field.key === "apiKey")).toMatchObject({ type: "secret", secretSet: true });
		assertNoSecrets(await publicBrowserSurfaces(page));

		// Reset removes the secret and all project overrides. Exercise the actual
		// per-field default action first: a required field with a declared default
		// must not gain a validation error when its project override is removed.
		const resetForm = await openProviderSettings(page);
		const bankField = resetForm.locator('[data-testid="market-settings-field"][data-field-key="bank"]');
		await bankField.getByTestId("market-settings-use-default").click();
		await expect(resetForm.getByLabel("Bank")).toHaveValue("");
		await expect(bankField.locator(".market-settings-field-error")).toHaveCount(0);

		// Reset then save through Market, rather than clearing the target through a
		// test-only browser API call. The response is the redacted UI PATCH result.
		await resetForm.getByTestId("market-settings-reset").click();
		const resetDialog = page.getByRole("button", { name: "Reset settings", exact: true });
		await expect(resetDialog).toBeVisible();
		await resetDialog.click();
		await expect(resetForm.getByLabel("Bank")).toHaveValue("");
		await expect(resetForm.locator(".market-settings-field-error")).toHaveCount(0);
		const resetSave = resetForm.getByTestId("market-settings-save");
		await expect(resetSave).toBeEnabled();
		const resetResponse = page.waitForResponse(response => response.url().endsWith(patchPath) && response.request().method() === "PATCH");
		await resetSave.click();
		const reset = await resetResponse;
		expect(reset.status()).toBe(200);
		const resetBody = await reset.json();
		assertNoSecrets(resetBody);
		const resetFields = resetBody.target.fields as Array<{ key: string; value?: unknown; source?: string; secretSet?: boolean }>;
		expect(resetFields.find(field => field.key === "apiKey")).toMatchObject({ secretSet: false });
		expect(resetFields.find(field => field.key === "bank")).toMatchObject({ value: "bobbit", source: "default" });
		expect(resetFields.find(field => field.key === "runtimeMode")).toMatchObject({ value: "external", source: "default" });
		expect(resetFields.find(field => field.key === "autoRecall")).toMatchObject({ value: true, source: "default" });
		expect(resetFields.find(field => field.key === "recallBudget")).toMatchObject({ value: 1200, source: "default" });
		await expect(page.getByTestId("market-settings-status")).toContainText(`Settings saved for ${projectA.name}.`, { timeout: 15_000 });
		assertNoSecrets(await publicBrowserSurfaces(page));

		// Reconfigure through the visible form so the reload/isolation assertion
		// retains an active Project A without bypassing the Market save path.
		const reconfigureForm = await openProviderSettings(page);
		await reconfigureForm.getByLabel("Hindsight URL").fill("https://settings-a.invalid");
		const reconfigureResponse = page.waitForResponse(response => response.url().endsWith(patchPath) && response.request().method() === "PATCH");
		await reconfigureForm.getByTestId("market-settings-save").click();
		const reconfigured = await reconfigureResponse;
		expect(reconfigured.status()).toBe(200);
		assertNoSecrets(await reconfigured.json());

		// A hard reload clears the local reset draft, then reconstructs the server
		// defaults and a redacted, empty secret input from the returned projection.
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/market/${projectA.id}/installed`);
		await chooseProject(page, projectA);
		const reloadedForm = await openProviderSettings(page);
		await expect(reloadedForm.getByLabel("API key", { exact: true })).toHaveValue("");
		await expect(reloadedForm.locator('[data-field-key="apiKey"]').getByTestId("market-settings-secret-state")).toHaveText("Not set");

		// Project B is a fresh projection: it must not flash A's URL or expose A's
		// secret presence. Disable B's provider and then prove A remains active.
		await chooseProject(page, projectB);
		const bSettings = await browserApi(page, { path: `/api/projects/${encodeURIComponent(projectB.id)}/extension-settings` });
		expect(bSettings.status, bSettings.text).toBe(200);
		expect(bSettings.text).not.toContain("https://settings-a.invalid");
		assertNoSecrets(bSettings.text);
		const formB = await openProviderSettings(page);
		await expect(formB.getByLabel("Hindsight URL")).toHaveValue("");
		await expect(formB.locator('[data-field-key="apiKey"]').getByTestId("market-settings-secret-state")).toHaveAttribute("data-state", "unset");
		await providerRow(page).getByTestId("market-settings-toggle").click();
		const enabledB = providerRow(page).getByTestId("market-project-provider-enabled");
		await expect(enabledB).toBeChecked();
		await enabledB.focus();
		await page.keyboard.press("Space");
		await expect(providerRow(page).getByTestId("market-runtime-status")).toHaveText("Disabled for project", { timeout: 15_000 });

		await chooseProject(page, projectA);
		await expect(providerRow(page).getByTestId("market-project-provider-enabled")).toBeChecked();
		await expect(providerRow(page).getByTestId("market-runtime-status")).toHaveText("Active");
		const isolatedAForm = await openProviderSettings(page);
		await expect(isolatedAForm.getByLabel("Hindsight URL")).toHaveValue("https://settings-a.invalid");
		await expect(isolatedAForm.locator('[data-field-key="apiKey"]').getByTestId("market-settings-secret-state")).toHaveAttribute("data-state", "unset");

		// The sentinel must be absent after the write from every public browser
		// surface: DOM/attributes, storage, API responses, and console output.
		assertNoSecrets(await publicBrowserSurfaces(page));
		assertNoSecrets(consoleMessages);
	});
});
