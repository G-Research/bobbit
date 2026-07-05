/**
 * Browser E2E — the Remove Project button renders for the first normal project
 * in Settings → (project) → General → Danger Zone. Headquarters is anchored
 * first and immutable, so it is intentionally skipped for destructive removal.
 *
 * Pattern: navigate → happy path → assert removal in sidebar.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, registerProject } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HEADQUARTERS_PROJECT_ID = "headquarters";

function isHeadquartersProject(project: { id?: string; kind?: string }): boolean {
	return project.id === HEADQUARTERS_PROJECT_ID || project.kind === "headquarters";
}

async function setHeadquartersVisible(visible: boolean): Promise<void> {
	const res = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ showHeadquartersInProjectLists: visible }),
	});
	expect(res.ok, `showHeadquartersInProjectLists=${visible}`).toBeTruthy();
}

async function listVisibleProjects(): Promise<Array<{ id: string; name: string; hidden?: boolean; kind?: string }>> {
	const res = await apiFetch("/api/projects");
	if (!res.ok) return [];
	const body = await res.json();
	const list: Array<{ id: string; name: string; hidden?: boolean; kind?: string }> = Array.isArray(body) ? body : (body.projects ?? []);
	return list.filter(p => !p.hidden);
}

async function listNormalVisibleProjects(): Promise<Array<{ id: string; name: string; hidden?: boolean; kind?: string }>> {
	return (await listVisibleProjects()).filter((project) => !isHeadquartersProject(project));
}

test.describe("Settings → Remove Project (first normal position)", () => {
	test("first normal project shows Remove Project button and removing it succeeds", async ({ page }) => {
		await setHeadquartersVisible(true);

		// Drain pre-existing normal projects so we know the exact normal list ordering.
		for (const p of await listNormalVisibleProjects()) {
			await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
		}

		const tmpDirs: string[] = [];
		try {
			const dirA = mkdtempSync(join(tmpdir(), "bobbit-rm-first-a-"));
			const dirB = mkdtempSync(join(tmpdir(), "bobbit-rm-first-b-"));
			tmpDirs.push(dirA, dirB);

			const nameA = `rm-first-A-${Date.now()}`;
			const nameB = `rm-first-B-${Date.now()}`;
			const projA = await registerProject({ name: nameA, rootPath: dirA, seedWorkflows: false });
			const projB = await registerProject({ name: nameB, rootPath: dirB, seedWorkflows: false });

			const all = await listVisibleProjects();
			expect(all[0]?.id, "Headquarters should remain anchored first in visible project lists").toBe(HEADQUARTERS_PROJECT_ID);

			// Determine which normal project the client sees first after Headquarters.
			const normal = all.filter((project) => !isHeadquartersProject(project));
			const firstId = normal[0]?.id;
			expect(firstId, "first normal project id should be present").toBeTruthy();
			expect([projA.id, projB.id]).toContain(firstId);
			const firstName = firstId === projA.id ? nameA : nameB;
			const otherName = firstId === projA.id ? nameB : nameA;

			await openApp(page);

			// Navigate to the General tab of the first normal project.
			await navigateToHash(page, `#/settings/${firstId}/general`);
			await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });

			// The Remove Project button must be visible and enabled for the first normal project.
			const removeBtn = page.locator("button").filter({ hasText: "Remove Project" });
			await expect(removeBtn).toBeVisible({ timeout: 10_000 });
			await expect(removeBtn).toBeEnabled();

			// Watch for any error dialogs that would indicate a failed delete.
			// (Unrelated to the confirm-action dialog below — this only fires
			// for genuine native alert()/confirm() calls, and Remove Project no
			// longer uses either.)
			const errorDialogs: string[] = [];
			page.on("dialog", async d => {
				if (d.type() === "alert") errorDialogs.push(d.message());
				await d.dismiss().catch(() => {});
			});

			await removeBtn.click();

			// UX audit finding 1: Remove Project now opens the app's hardened
			// confirmAction dialog instead of native confirm() — confirm via its
			// stable class (dialogs.ts), not window.confirm stubbing.
			await expect(page.locator(".confirm-action-confirm-btn")).toBeVisible({ timeout: 5_000 });
			await page.locator(".confirm-action-confirm-btn").click();

			// The settings flow navigates away from the deleted project.
			await expect(page).toHaveURL(/#.*settings.*system/, { timeout: 5_000 });

			// The deleted project disappears from /api/projects and the sidebar; the other remains.
			await expect.poll(async () =>
				(await listNormalVisibleProjects()).map(p => p.name),
				{ timeout: 10_000 },
			).not.toContain(firstName);

			const remaining = (await listNormalVisibleProjects()).map(p => p.name);
			expect(remaining).toContain(otherName);
			const sidebar = page.locator(".sidebar-edge").first();
			await expect(sidebar.getByText(firstName)).not.toBeVisible({ timeout: 3_000 });
			expect(errorDialogs, "no error alerts should fire").toEqual([]);
		} finally {
			// Cleanup: remove normal projects still registered, but never immutable Headquarters.
			for (const p of await listNormalVisibleProjects()) {
				await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
			}
			await setHeadquartersVisible(true).catch(() => {});
			for (const d of tmpDirs) {
				try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
			}
		}
	});
});
