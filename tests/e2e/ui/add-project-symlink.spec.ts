/**
 * Add-Project symlink-confirm flow (browser E2E).
 *
 * Server contract under test (POST /api/projects):
 *  - When the supplied `rootPath` resolves through a symlink to a different
 *    canonical path AND the body does NOT carry `acceptCanonical: true`,
 *    the server responds 400 with
 *      { error, code: "symlink_root", rootPath, canonical }
 *  - When the body carries `acceptCanonical: true`, the server stores the
 *    project at the canonical path.
 *
 * UI contract under test:
 *  - After the user types a symlinked path and clicks Continue, a confirm
 *    modal appears showing both paths (data-testid="symlink-confirm" with
 *    "symlink-rootpath" and "symlink-canonical" children).
 *  - Clicking Cancel closes only the confirm modal, returns to the add-project
 *    dialog, and does not register either path.
 *  - Clicking "Use canonical path" (data-testid="confirm-use-canonical")
 *    re-submits with acceptCanonical:true and the project lands at the
 *    canonical path.
 *  - Reload preserves the project.
 *
 * Skipped on Windows when symlinkSync requires admin (EPERM).
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function uniqueDir(label: string): string {
	const dir = join(tmpdir(), `bobbit-e2e-symlink-${label}-${process.env.E2E_PORT}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Build canonical + symlink dirs. Returns null on systems where creating
 *  symlinks requires elevated privileges (Windows non-admin). */
function makeSymlinkPair(label: string): { canonical: string; link: string } | null {
	const root = uniqueDir(label);
	let canonical = join(root, "canonical");
	const link = join(root, "link");
	mkdirSync(canonical, { recursive: true });
	// Canonicalize via realpath so the value we compare against matches what
	// the server stores (the server resolves symlinks during register).
	canonical = realpathSync(canonical);
	// Write a sentinel file so directory has content.
	writeFileSync(join(canonical, "marker.txt"), "x");
	try {
		symlinkSync(canonical, link, "dir");
	} catch (e: any) {
		// EPERM on Windows without dev-mode/admin → skip.
		try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
		return null;
	}
	// Sanity: realpath(link) must differ from link for the test to be meaningful.
	let real = link;
	try { real = realpathSync(link); } catch { /* ignore */ }
	if (real === link) {
		try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
		return null;
	}
	return { canonical, link };
}

test.describe("Add Project — symlink confirm flow", () => {

	test.afterEach(async () => {
		// Clean up any projects this spec created.
		const res = await apiFetch("/api/projects");
		const data = await res.json();
		const projects = data.projects || data || [];
		for (const p of projects) {
			if (p.name === "default") continue;
			await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("symlinked rootPath confirm handles cancel, canonical storage, and reload persistence", async ({ page }) => {
		const pair = makeSymlinkPair("confirm-cancel");
		test.skip(!pair, "Cannot create symlinks on this platform (EPERM). Skipping.");
		const { canonical, link } = pair!;

		await openApp(page);

		// Open Add-Project dialog.
		await page.locator("button").filter({ hasText: "Add Project" }).first().click();
		const pathInput = page.locator('input[placeholder="/path/to/project"]');
		await expect(pathInput).toBeVisible({ timeout: 5_000 });

		// Need .bobbit/config/project.yaml to trigger Path A (auto-import → registerProject).
		// Without it, /api/projects/detect returns hasBobbit=false (since commit 54d5b710
		// project.yaml is the source of truth) and doContinue takes Path B (project assistant),
		// so the symlink check in registerProject never runs.
		mkdirSync(join(canonical, ".bobbit", "config"), { recursive: true });
		mkdirSync(join(canonical, ".bobbit", "state"), { recursive: true });
		writeFileSync(join(canonical, ".bobbit", "config", "project.yaml"), "name: test\n");

		// Type the symlinked path and open the confirm modal.
		await pathInput.fill(link);
		await page.locator("button").filter({ hasText: "Continue" }).first().click();

		// Confirm modal appears with both paths visible.
		const symlinkConfirm = page.locator('[data-testid="symlink-confirm"]');
		await expect(symlinkConfirm).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-testid="symlink-rootpath"]')).toContainText(link);
		await expect(page.locator('[data-testid="symlink-canonical"]')).toContainText(canonical);

		// Cancel closes only the confirm dialog and does not register either path.
		await page.locator("button").filter({ hasText: "Cancel" }).last().click();
		await expect(symlinkConfirm).not.toBeVisible({ timeout: 5_000 });
		await expect(pathInput).toBeVisible();
		const cancelRes = await apiFetch("/api/projects");
		const cancelData = await cancelRes.json();
		const cancelProjects = cancelData.projects || cancelData || [];
		const cancelStored = cancelProjects.find((p: any) => p.rootPath === canonical || p.rootPath === link);
		expect(cancelStored).toBeFalsy();

		// Continue again from the same add-project dialog and accept the canonical path.
		await pathInput.fill(link);
		await page.locator("button").filter({ hasText: "Continue" }).first().click();
		await expect(symlinkConfirm).toBeVisible({ timeout: 10_000 });
		await page.locator('[data-testid="confirm-use-canonical"]').click();

		// Both dialogs close → path input no longer visible.
		await expect(pathInput).not.toBeVisible({ timeout: 10_000 });

		// Verify via API: project stored under the canonical path.
		await expect(async () => {
			const res = await apiFetch("/api/projects");
			const data = await res.json();
			const projects = data.projects || data || [];
			const stored = projects.find((p: any) => p.rootPath === canonical);
			expect(stored).toBeTruthy();
			// And no row stored under the symlink path.
			const linkRow = projects.find((p: any) => p.rootPath === link);
			expect(linkRow).toBeFalsy();
		}).toPass({ timeout: 10_000 });

		// Persistence across reload.
		await page.reload();
		await openApp(page);
		const res2 = await apiFetch("/api/projects");
		const data2 = await res2.json();
		const projects2 = data2.projects || data2 || [];
		const stored2 = projects2.find((p: any) => p.rootPath === canonical);
		expect(stored2).toBeTruthy();
	});
});
