/**
 * Browser E2E — splash screen with Headquarters plus another visible project
 * opens a project picker popover anchored at the "Quick Session" button.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HEADQUARTERS_PROJECT_ID = "headquarters";
const HEADQUARTERS_NAME = "Headquarters";

function uniqueDir(tag: string): string {
	const dir = join(tmpdir(), `bobbit-e2e-splash-${tag}-${process.env.E2E_PORT}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function setHeadquartersVisible(visible: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ showHeadquartersInProjectLists: visible }),
	});
	expect(resp.ok, `showHeadquartersInProjectLists=${visible}`).toBeTruthy();
}

// The gateway-harness is worker-scoped: any extra project registered here
// persists into later specs on the same worker and can trip single-project
// flows (unexpected project pickers). Track and delete them after each test.
const _createdProjectIds: string[] = [];
const _createdSessionIds: string[] = [];

test.describe("Splash screen — Headquarters plus another project", () => {
	test.beforeEach(async () => {
		await setHeadquartersVisible(true);
	});

	test.afterEach(async () => {
		for (const id of _createdSessionIds.splice(0)) {
			await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		}
		for (const id of _createdProjectIds.splice(0)) {
			if (id !== HEADQUARTERS_PROJECT_ID) await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
		}
		await setHeadquartersVisible(true).catch(() => {});
	});

	test("clicking 'Quick Session' opens project picker; selecting a project creates a session bound to it", async ({ page }) => {
		await openApp(page);

		// Register another project so Headquarters + normal project yields picker mode.
		const projectName = `second-project-${Date.now()}`;
		const dir = uniqueDir("p2");
		const resp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: projectName, rootPath: dir, upsert: true }),
		});
		expect(resp.ok).toBeTruthy();
		const project = await resp.json();
		_createdProjectIds.push(project.id);

		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });

		const splashLabel = page.locator('[data-testid="splash-new-session-label"]').first();
		await expect(splashLabel).toBeVisible({ timeout: 10_000 });
		await expect(splashLabel).toContainText("Quick Session");

		// Click → picker appears.
		await splashLabel.click();
		const picker = page.locator('[data-testid="splash-project-picker"]');
		await expect(picker).toBeVisible({ timeout: 5_000 });

		const items = picker.locator('[data-testid="splash-project-picker-item"]');
		expect(await items.count()).toBeGreaterThanOrEqual(2);
		await expect(items.first(), "Headquarters should be anchored first in the splash picker").toContainText(HEADQUARTERS_NAME);

		const sessionCreated = page.waitForResponse((response) =>
			response.url().includes("/api/sessions") && response.request().method() === "POST",
			{ timeout: 20_000 },
		);
		await items.filter({ hasText: projectName }).first().click();
		const sessionResp = await sessionCreated;
		expect(sessionResp.ok(), `session creation should succeed: ${sessionResp.status()}`).toBe(true);
		const requestBody = sessionResp.request().postDataJSON?.() ?? JSON.parse(sessionResp.request().postData() || "{}");
		expect(requestBody.projectId).toBe(project.id);
		const session = await sessionResp.json();
		if (session.id) _createdSessionIds.push(session.id);
	});

	test("picker closes on Escape", async ({ page }) => {
		await openApp(page);
		const projectName = `third-project-${Date.now()}`;
		const dir = uniqueDir("p3");
		const resp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: projectName, rootPath: dir, upsert: true }),
		});
		expect(resp.ok).toBeTruthy();
		_createdProjectIds.push((await resp.json()).id);
		await page.reload();
		const splashLabel = page.locator('[data-testid="splash-new-session-label"]').first();
		await expect(splashLabel).toBeVisible({ timeout: 10_000 });
		await expect(splashLabel).toContainText("Quick Session");
		await splashLabel.click();
		const picker = page.locator('[data-testid="splash-project-picker"]');
		await expect(picker).toBeVisible({ timeout: 5_000 });
		await page.keyboard.press("Escape");
		await expect(picker).toBeHidden({ timeout: 5_000 });
	});
});
