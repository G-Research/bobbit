/**
 * Browser E2E — the Remove Project button renders for every project in the
 * Settings → (project) → General → Danger Zone, regardless of its position
 * in the project list. Previously the project at index 0 was excluded.
 *
 * Pattern: navigate → happy path → assert removal in sidebar.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function listVisibleProjects(): Promise<Array<{ id: string; name: string; hidden?: boolean }>> {
	const res = await apiFetch("/api/projects");
	if (!res.ok) return [];
	const body = await res.json();
	const list: Array<{ id: string; name: string; hidden?: boolean }> = Array.isArray(body) ? body : (body.projects ?? []);
	return list.filter(p => !p.hidden);
}

test.describe("Settings → Remove Project (any position)", () => {
	test("first project in list shows Remove Project button and removing it succeeds", async ({ page }) => {
		// Drain any pre-existing projects so we know the exact list ordering.
		for (const p of await listVisibleProjects()) {
			await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
		}

		const tmpDirs: string[] = [];
		try {
			const dirA = mkdtempSync(join(tmpdir(), "bobbit-rm-first-a-"));
			const dirB = mkdtempSync(join(tmpdir(), "bobbit-rm-first-b-"));
			tmpDirs.push(dirA, dirB);

			const nameA = `rm-first-A-${Date.now()}`;
			const nameB = `rm-first-B-${Date.now()}`;
			const projA = await apiFetch("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: nameA, rootPath: dirA }),
			}).then(r => r.json());
			const projB = await apiFetch("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: nameB, rootPath: dirB }),
			}).then(r => r.json());

			// Determine which project the client sees at index 0 — that is the
			// one the old `isDefault` gate excluded. Server returns the registry
			// list in insertion order; the client mirrors it.
			const all = await listVisibleProjects();
			const firstId = all[0]?.id;
			expect(firstId, "projects[0].id should be present").toBeTruthy();
			expect([projA.id, projB.id]).toContain(firstId);
			const firstName = firstId === projA.id ? nameA : nameB;
			const otherName = firstId === projA.id ? nameB : nameA;

			await openApp(page);

			// Navigate to the General tab of the first project.
			await navigateToHash(page, `#/settings/${firstId}/general`);
			await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });

			// The Remove Project button must be visible and enabled — this is
			// the regression: previously it was hidden for state.projects[0].
			const removeBtn = page.locator("button").filter({ hasText: "Remove Project" });
			await expect(removeBtn).toBeVisible({ timeout: 10_000 });
			await expect(removeBtn).toBeEnabled();

			// Stub window.confirm so the click proceeds.
			await page.evaluate(() => { (window as any).confirm = () => true; });

			// Watch for any error dialogs that would indicate a failed delete.
			const errorDialogs: string[] = [];
			page.on("dialog", async d => {
				if (d.type() === "alert") errorDialogs.push(d.message());
				await d.dismiss().catch(() => {});
			});

			await removeBtn.click();

			// The deleted project disappears from /api/projects; the other remains.
			await expect.poll(async () =>
				(await listVisibleProjects()).map(p => p.name),
				{ timeout: 10_000 },
			).not.toContain(firstName);

			const remaining = (await listVisibleProjects()).map(p => p.name);
			expect(remaining).toContain(otherName);
			expect(errorDialogs, "no error alerts should fire").toEqual([]);
		} finally {
			// Cleanup: remove anything still registered.
			for (const p of await listVisibleProjects()) {
				await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
			}
			for (const d of tmpDirs) {
				try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
			}
		}
	});
});
