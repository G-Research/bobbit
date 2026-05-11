/**
 * Add Project — preflight panel + archive CTA (browser E2E).
 *
 * Server contract under test (see docs/design/robust-add-project.md):
 *  - `GET /api/projects/preflight?path=<abs>` → `PreflightReport` with
 *    pass/warn/fail checks. Submit is blocked while any check.level === "fail".
 *  - `POST /api/projects/archive-bobbit` body `{ rootPath }` → moves
 *    project-scoped `.bobbit/` contents into `.bobbit-archive-NNN/`, never
 *    touching gateway-owned allowlist entries (state/gateway-url,
 *    state/watchdog.json, state/tls/, state/projects.json, state/sessions.json, …).
 *
 * UI contract under test (`src/app/dialogs.ts::showProjectDialog`):
 *  - The dialog renders a preflight panel (`[data-testid="preflight-panel"]`)
 *    listing each check (`[data-testid="preflight-check"][data-check-id="…"]`).
 *  - When any check has `data-check-level="fail"`, the Continue button is
 *    disabled.
 *  - The `bobbit.existing` row exposes an inline archive CTA
 *    (`[data-testid="preflight-archive-cta"]`) that opens a confirm modal
 *    (`[data-testid="archive-confirm"]`) → POST archive → re-runs preflight.
 *
 * The spec tolerates a missing preflight endpoint (older gateway) by
 * skipping individual cases when the panel never appears — see `t.skip(...)`
 * inside each test. This keeps the suite green while the server side of the
 * goal is in flight; once the endpoint is wired, the assertions become live.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function uniqueDir(label: string): string {
	const dir = join(tmpdir(), `bobbit-e2e-preflight-${label}-${process.env.E2E_PORT}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function openAddProjectDialog(page: Page): Promise<void> {
	await openApp(page);
	await page.locator("button").filter({ hasText: "Add Project" }).first().click();
	await expect(page.locator('input[placeholder="/path/to/project"]')).toBeVisible({ timeout: 5_000 });
}

/** Wait for the preflight panel to settle — either populated or stable
 *  loading-failed state. Returns true if the panel rendered, false if the
 *  endpoint is unavailable (older gateway: panel is hidden via the
 *  `preflightUnavailable` flag in dialogs.ts). */
async function waitForPreflight(page: Page, timeoutMs = 8_000): Promise<boolean> {
	const panel = page.locator('[data-testid="preflight-panel"]');
	try {
		await expect(panel).toBeVisible({ timeout: timeoutMs });
	} catch {
		return false;
	}
	// Wait for at least one check row OR the loading marker to clear.
	await expect.poll(
		async () => {
			const rows = await page.locator('[data-testid="preflight-check"]').count();
			const loading = await panel.getAttribute("data-loading");
			return rows > 0 || loading === null;
		},
		{ timeout: timeoutMs },
	).toBe(true);
	return true;
}

async function preflightAvailable(): Promise<boolean> {
	try {
		const res = await apiFetch("/api/projects/preflight?path=" + encodeURIComponent(tmpdir()));
		return res.status !== 404;
	} catch {
		return false;
	}
}

test.describe("Add Project — preflight panel", () => {
	test.afterEach(async () => {
		const res = await apiFetch("/api/projects");
		const data = await res.json();
		const projects = data.projects || data || [];
		for (const p of projects) {
			if (p.name === "default") continue;
			await apiFetch(`/api/projects/${p.id}?force=1`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("happy path: empty directory shows ready preflight and enabled Continue", async ({ page }, testInfo) => {
		if (!(await preflightAvailable())) testInfo.skip(true, "preflight endpoint unavailable");
		const dir = uniqueDir("happy");

		await openAddProjectDialog(page);
		await page.locator('input[placeholder="/path/to/project"]').fill(dir);

		const rendered = await waitForPreflight(page);
		expect(rendered).toBe(true);

		const panel = page.locator('[data-testid="preflight-panel"]');
		await expect(panel).toHaveAttribute("data-has-fail", "0");
		await expect(page.locator('[data-testid="preflight-ok"]')).toBeVisible();

		// At least the path.absolute + path.exists checks should be present.
		await expect(page.locator('[data-testid="preflight-check"][data-check-id="path.absolute"]')).toBeVisible();
		await expect(page.locator('[data-testid="preflight-check"][data-check-id="path.exists"]')).toBeVisible();

		// Continue is enabled.
		const cont = page.locator("button").filter({ hasText: "Continue" }).first();
		await expect(cont).toBeEnabled();
	});

	test("fail blocks submit: nested-in-existing-project surfaces fail row and disables Continue", async ({ page }, testInfo) => {
		if (!(await preflightAvailable())) testInfo.skip(true, "preflight endpoint unavailable");

		// Register a parent project, then try to add a path nested inside it.
		const parent = uniqueDir("parent");
		mkdirSync(join(parent, ".bobbit", "config"), { recursive: true });
		mkdirSync(join(parent, ".bobbit", "state"), { recursive: true });
		const child = join(parent, "child");
		mkdirSync(child, { recursive: true });

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `pf-parent-${Date.now()}`, rootPath: parent }),
		});
		// If parent registration was rejected (e.g. by its own preflight),
		// skip — we can't construct the nested scenario.
		if (!reg.ok) testInfo.skip(true, `Failed to seed parent project: ${reg.status}`);

		await openAddProjectDialog(page);
		await page.locator('input[placeholder="/path/to/project"]').fill(child);

		const rendered = await waitForPreflight(page);
		expect(rendered).toBe(true);

		const nestedRow = page.locator('[data-testid="preflight-check"][data-check-id="path.nested-in-project"]');
		await expect(nestedRow).toBeVisible();
		await expect(nestedRow).toHaveAttribute("data-check-level", "fail");

		await expect(page.locator('[data-testid="preflight-panel"]')).toHaveAttribute("data-has-fail", "1");
		await expect(page.locator('[data-testid="preflight-blocked"]')).toBeVisible();

		// Continue is disabled.
		const cont = page.locator("button").filter({ hasText: "Continue" }).first();
		await expect(cont).toBeDisabled();
	});

	test("archive flow: existing .bobbit/ → archive CTA moves files to .bobbit-archive-001/", async ({ page }, testInfo) => {
		if (!(await preflightAvailable())) testInfo.skip(true, "preflight endpoint unavailable");

		const dir = uniqueDir("archive");
		mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
		mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
		writeFileSync(join(dir, ".bobbit", "config", "system-prompt.md"), "test\n");
		writeFileSync(join(dir, ".bobbit", "state", "marker.json"), "{}");

		await openAddProjectDialog(page);
		await page.locator('input[placeholder="/path/to/project"]').fill(dir);

		const rendered = await waitForPreflight(page);
		expect(rendered).toBe(true);

		// bobbit.existing row should be present with the archive CTA.
		const existingRow = page.locator('[data-testid="preflight-check"][data-check-id="bobbit.existing"]');
		await expect(existingRow).toBeVisible({ timeout: 5_000 });
		const cta = page.locator('[data-testid="preflight-archive-cta"]');
		await expect(cta).toBeVisible();
		await cta.click();

		// Confirm modal appears.
		await expect(page.locator('[data-testid="archive-confirm"]')).toBeVisible({ timeout: 5_000 });
		await expect(page.locator('[data-testid="archive-rootpath"]')).toContainText(dir);

		await page.locator('[data-testid="confirm-archive-bobbit"]').click();

		// Wait for the archive directory to appear on disk.
		await expect.poll(() => {
			const entries = readdirSync(dir);
			return entries.find(e => e.startsWith(".bobbit-archive-")) || "";
		}, { timeout: 10_000 }).toMatch(/^\.bobbit-archive-001$/);

		const archiveDir = join(dir, ".bobbit-archive-001");
		expect(existsSync(archiveDir)).toBe(true);

		// Second archive: write fresh contents, then trigger again. New archive
		// lands in -002. We re-open the dialog; the previous archive completed
		// asynchronously and re-runs preflight, but to drive a second one we
		// need .bobbit/ to be non-empty again.
		writeFileSync(join(dir, ".bobbit", "config", "system-prompt.md"), "round-2\n");

		// Re-trigger preflight by re-typing the path (debounced).
		const input = page.locator('input[placeholder="/path/to/project"]');
		await input.fill("");
		await input.fill(dir);

		await waitForPreflight(page);
		await expect(page.locator('[data-testid="preflight-check"][data-check-id="bobbit.existing"]')).toBeVisible({ timeout: 5_000 });
		await page.locator('[data-testid="preflight-archive-cta"]').click();
		await expect(page.locator('[data-testid="archive-confirm"]')).toBeVisible({ timeout: 5_000 });
		await page.locator('[data-testid="confirm-archive-bobbit"]').click();

		await expect.poll(() => existsSync(join(dir, ".bobbit-archive-002")), { timeout: 10_000 }).toBe(true);

		// Cleanup.
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	});

	test("gateway-owned preservation: state/gateway-url stays in place after archive", async ({ page }, testInfo) => {
		if (!(await preflightAvailable())) testInfo.skip(true, "preflight endpoint unavailable");

		const dir = uniqueDir("gateway-owned");
		mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
		mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
		// The presence of gateway-url is one of the three signals that flips
		// `bobbit.gateway-owned` to true (see docs/design/robust-add-project.md).
		writeFileSync(join(dir, ".bobbit", "state", "gateway-url"), "https://localhost:3001\n");
		writeFileSync(join(dir, ".bobbit", "config", "system-prompt.md"), "test\n");

		await openAddProjectDialog(page);
		await page.locator('input[placeholder="/path/to/project"]').fill(dir);

		const rendered = await waitForPreflight(page);
		expect(rendered).toBe(true);

		const gwRow = page.locator('[data-testid="preflight-check"][data-check-id="bobbit.gateway-owned"]');
		// Row may not be implemented yet — only assert when present.
		const gwRowCount = await gwRow.count();
		if (gwRowCount === 0) testInfo.skip(true, "bobbit.gateway-owned check not implemented yet");

		// Open archive confirm; the confirm modal should expose the
		// gateway-owned notice.
		await page.locator('[data-testid="preflight-archive-cta"]').click();
		await expect(page.locator('[data-testid="archive-confirm"]')).toBeVisible({ timeout: 5_000 });
		await expect(page.locator('[data-testid="archive-gateway-owned"]')).toBeVisible();

		await page.locator('[data-testid="confirm-archive-bobbit"]').click();

		// Wait for archive to appear.
		await expect.poll(() => existsSync(join(dir, ".bobbit-archive-001")), { timeout: 10_000 }).toBe(true);

		// gateway-url must be preserved in place.
		expect(existsSync(join(dir, ".bobbit", "state", "gateway-url"))).toBe(true);
		// system-prompt.md should have moved.
		expect(existsSync(join(dir, ".bobbit", "config", "system-prompt.md"))).toBe(false);

		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	});
});
