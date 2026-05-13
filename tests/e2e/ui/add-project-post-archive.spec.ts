/**
 * Reproducing test for the "post-archive routing" bug.
 *
 * After the user clicks the archive CTA in the add-project preflight panel
 * and the archive completes successfully, clicking **Continue** should route
 * to the project assistant (treating the directory as first-time setup),
 * NOT auto-import a project.
 *
 * Today, `/api/projects/detect` returns `hasBobbit: true` based on the mere
 * presence of a `.bobbit/` directory entry, and `/api/projects/archive-bobbit`
 * re-scaffolds an empty `.bobbit/config/` + `.bobbit/state/` after archiving.
 * So `hasBobbit` stays true post-archive and `doContinue` takes the Path A
 * auto-import branch in `src/app/dialogs.ts`, never opening the assistant.
 *
 * Pass condition for this spec: after Continue, the URL hash navigates to a
 * `#/session/<id>` route (the project assistant), as it does in
 * `add-project-flow.spec.ts::"non-empty directory without .bobbit opens
 * project assistant"`. The spec must FAIL on current master (no `#/session/`
 * route — instead an auto-import happens or the dialog routes elsewhere) and
 * PASS once `hasBobbit` is fixed to check `.bobbit/config/project.yaml`.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function uniqueDir(label: string): string {
	const dir = join(
		tmpdir(),
		`bobbit-e2e-postarchive-${label}-${process.env.E2E_PORT}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function preflightAvailable(): Promise<boolean> {
	try {
		const res = await apiFetch("/api/projects/preflight?path=" + encodeURIComponent(tmpdir()));
		return res.status !== 404;
	} catch {
		return false;
	}
}

test.describe("Add Project — post-archive routes to assistant", () => {
	test.afterEach(async () => {
		// Clean up any projects leaked into the gateway registry — mirrors
		// the cleanup pattern in add-project-flow.spec.ts and
		// add-project-preflight.spec.ts. Important here because if the bug
		// triggers an auto-import we want the leaked project gone before the
		// next spec runs.
		const res = await apiFetch("/api/projects");
		const data = await res.json();
		const projects = data.projects || data || [];
		for (const p of projects) {
			if (p.name === "default") continue;
			await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("after archiving an existing .bobbit/, Continue opens the project assistant (not auto-import)", async ({ page }, testInfo) => {
		if (!(await preflightAvailable())) testInfo.skip(true, "preflight endpoint unavailable");

		// Seed: non-empty .bobbit/ but NO project.yaml. This is the "ghost
		// .bobbit/" shape: presence of the directory but no configured project.
		const dir = uniqueDir("ghost");
		mkdirSync(join(dir, ".bobbit"), { recursive: true });
		writeFileSync(join(dir, ".bobbit", "some-file.txt"), "leftover from a previous install\n");
		// Add a top-level file so the dir isn't trivially empty either.
		writeFileSync(join(dir, "README.md"), "# Test\n");

		await openApp(page);
		await page.locator("button").filter({ hasText: "Add Project" }).first().click();
		const pathInput = page.locator('input[placeholder="/path/to/project"]');
		await expect(pathInput).toBeVisible({ timeout: 5_000 });
		await pathInput.fill(dir);

		// Wait for the preflight panel and the archive CTA to surface.
		await expect(page.locator('[data-testid="preflight-panel"]')).toBeVisible({ timeout: 8_000 });
		const existingRow = page.locator(
			'[data-testid="preflight-check"][data-check-id="bobbit.existing"]',
		);
		await expect(existingRow).toBeVisible({ timeout: 5_000 });
		const cta = page.locator('[data-testid="preflight-archive-cta"]');
		await expect(cta).toBeVisible();
		await cta.click();

		// Confirm the archive.
		await expect(page.locator('[data-testid="archive-confirm"]')).toBeVisible({ timeout: 5_000 });
		await page.locator('[data-testid="confirm-archive-bobbit"]').click();

		// Wait for the archive to materialise on disk so we know the server
		// completed the operation (and re-scaffolded empty config/ + state/).
		await expect
			.poll(() => existsSync(join(dir, ".bobbit-archive-001")), { timeout: 10_000 })
			.toBe(true);

		// Post-archive shape: .bobbit/ still exists (empty config/ + state/),
		// but project.yaml does NOT exist. This is exactly the case the bug
		// misclassifies as "auto-import me".
		expect(existsSync(join(dir, ".bobbit", "config", "project.yaml"))).toBe(false);

		// Wait for the bobbit.existing row to disappear or stop being a fail
		// — i.e. preflight settled after the archive POST. The panel re-runs
		// automatically; if the CTA is gone, we're good to click Continue.
		await expect(page.locator('[data-testid="preflight-archive-cta"]')).toHaveCount(0, {
			timeout: 10_000,
		});

		// Click Continue. The user just explicitly chose to "start fresh",
		// so the dialog MUST route to the project assistant — a new session
		// with hash `#/session/<id>`.
		const cont = page.locator("button").filter({ hasText: "Continue" }).first();
		await expect(cont).toBeEnabled();
		await cont.click();

		// Dialog closes either way.
		await expect(pathInput).not.toBeVisible({ timeout: 10_000 });

		// Snapshot the URL hash + the projects list to figure out which
		// branch the dialog took. We assert a stable, grep-able message so
		// the failure shows up cleanly in --reporter=json output.
		const hash = await page.evaluate(() => window.location.hash);
		const isAssistantSession = /^#\/session\//.test(hash);

		const projectsRes = await apiFetch("/api/projects");
		const projectsData = await projectsRes.json();
		const projects = projectsData.projects || projectsData || [];
		const autoImported = projects.find(
			(p: { rootPath?: string }) => p.rootPath === dir,
		);
		const wasAutoImported = Boolean(autoImported && !autoImported.provisional);

		// The reproducing assertion. On current master, `hasBobbit` stays true
		// post-archive → Path A auto-import → `wasAutoImported === true`,
		// `isAssistantSession === false`. After the fix, the opposite holds.
		expect(
			{ isAssistantSession, wasAutoImported, hash },
			"post-archive Continue must open the project assistant (#/session/...) and must NOT auto-import; this is the post-archive routing bug",
		).toEqual({ isAssistantSession: true, wasAutoImported: false, hash: expect.stringMatching(/^#\/session\//) });

		// Best-effort cleanup of the temp dir.
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	});
});
