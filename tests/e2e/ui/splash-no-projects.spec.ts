/**
 * Browser E2E — when Headquarters is hidden and no normal projects are visible,
 * the splash does not regress to the old forced "New Project" gate. It offers a
 * Quick Session in the internally resolvable Headquarters workspace plus Show
 * Headquarters/Add Project recovery actions.
 *
 * Pattern: navigate → happy path → persistence → cleanup.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

const HEADQUARTERS_PROJECT_ID = "headquarters";

async function setHeadquartersVisible(visible: boolean): Promise<void> {
	const res = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ showHeadquartersInProjectLists: visible }),
	});
	expect(res.ok, `showHeadquartersInProjectLists=${visible}`).toBeTruthy();
}

async function listVisibleProjects(): Promise<Array<{ id: string; name: string; kind?: string }>> {
	const res = await apiFetch("/api/projects");
	expect(res.ok, "GET /api/projects").toBeTruthy();
	const body = await res.json();
	return Array.isArray(body) ? body : (body.projects ?? []);
}

async function prepareHiddenHeadquartersWithNoUserProjects(): Promise<void> {
	// Delete normal projects but never try to remove immutable Headquarters.
	for (const project of await listVisibleProjects()) {
		if (project.id === HEADQUARTERS_PROJECT_ID || project.kind === "headquarters") continue;
		await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
	}
	await setHeadquartersVisible(false);
	await expect.poll(async () => (await listVisibleProjects()).map((project) => project.id), {
		timeout: 10_000,
		message: "no normal projects should remain visible while Headquarters is hidden",
	}).toEqual([]);
}

const createdSessions = new Set<string>();

test.describe("Splash screen — hidden Headquarters with no visible projects", () => {
	test.afterEach(async () => {
		for (const id of Array.from(createdSessions)) {
			await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		}
		createdSessions.clear();
		await setHeadquartersVisible(true).catch(() => {});
	});

	test("shows Quick Session recovery instead of forcing New Project", async ({ page }) => {
		await prepareHiddenHeadquartersWithNoUserProjects();
		await openApp(page);

		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });

		const fallback = page.locator('[data-testid="headquarters-hidden-fallback"]').first();
		await expect(fallback).toBeVisible({ timeout: 10_000 });
		await expect(fallback).toContainText("Headquarters is hidden from project lists.");
		await expect(page.getByRole("button", { name: "Quick Session in Headquarters" }).first()).toBeVisible();
		await expect(page.getByRole("button", { name: "Show Headquarters" }).first()).toBeVisible();
		await expect(page.getByRole("button", { name: /Add Project/i }).first()).toBeVisible();

		await expect(page.locator('[data-testid="splash-new-session-label"]')).toHaveCount(0);
		await expect(page.getByText("New Project", { exact: true })).toHaveCount(0);

		const sessionCreated = page.waitForResponse((response) =>
			response.url().includes("/api/sessions") && response.request().method() === "POST",
			{ timeout: 20_000 },
		);
		await page.getByRole("button", { name: "Quick Session in Headquarters" }).first().click();
		const sessionResp = await sessionCreated;
		expect(sessionResp.ok(), `Quick Session should succeed: ${sessionResp.status()}`).toBe(true);
		const requestBody = sessionResp.request().postDataJSON?.() ?? JSON.parse(sessionResp.request().postData() || "{}");
		expect(requestBody.projectId).toBe(HEADQUARTERS_PROJECT_ID);
		const session = await sessionResp.json();
		if (session.id) createdSessions.add(session.id);
	});

	test("persistence — reload still shows hidden-Headquarters recovery", async ({ page }) => {
		await prepareHiddenHeadquartersWithNoUserProjects();
		await openApp(page);

		await expect(page.locator('[data-testid="headquarters-hidden-fallback"]').first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByRole("button", { name: "Quick Session in Headquarters" }).first()).toBeVisible();
		await expect(page.locator('[data-testid="splash-new-session-label"]')).toHaveCount(0);

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator('[data-testid="headquarters-hidden-fallback"]').first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByRole("button", { name: "Quick Session in Headquarters" }).first()).toBeVisible();
		await expect(page.locator('[data-testid="splash-new-session-label"]')).toHaveCount(0);
	});
});
