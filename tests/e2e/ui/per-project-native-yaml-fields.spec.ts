/**
 * Browser E2E for per-project Settings tab editing of the native-YAML fields:
 *   - sandbox_tokens (toggle enabled in the Tokens editor on the General tab)
 *   - qa_env         (currently no dedicated UI — exercised via the same
 *                     `PUT /api/projects/:id/config` endpoint the Settings
 *                     page targets, while authenticated through the page;
 *                     see "Production-UI gap" note below)
 *
 * Each test:
 *   1. Navigate to the project settings tab.
 *   2. Make the edit through the UI (sandbox_tokens) or REST (qa_env).
 *   3. Save.
 *   4. Reload and assert the change persists in the UI / GET response.
 *   5. Read .bobbit/config/project.yaml under the project rootPath and
 *      assert the field is native YAML (no escaped JSON, no
 *      JSON.stringify-style strings).
 *   6. Cleanup by toggling/clearing the change.
 *
 * Production-UI gap (flagged, not fixed by this test file):
 *   `qa_env` has no dedicated editor in `src/app/settings-page.ts` (it is
 *   excluded from the Commands tab key list at HIDDEN_KEYS line ~2307).
 *   Per the task constraints we do NOT modify production code; the
 *   reload-persistence + native-YAML check below drives the same code
 *   path Settings would call (`PUT /api/projects/:id/config`) and verifies
 *   the on-disk format. A real UI for qa_env should be added in a
 *   follow-up goal.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, readE2EToken, base } from "../e2e-setup.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "@playwright/test";

async function registerProject(name: string): Promise<{ id: string; rootPath: string; cleanup: () => void }> {
	const rootPath = mkdtempSync(join(tmpdir(), "bobbit-e2e-nyaml-"));
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath, upsert: true }),
	});
	expect([200, 201]).toContain(resp.status);
	const project = await resp.json();
	return {
		id: project.id,
		rootPath,
		cleanup: () => {
			apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			try { rmSync(rootPath, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

async function openApp(page: Page, hash?: string): Promise<void> {
	const token = readE2EToken();
	await page.goto(`${base()}/?token=${encodeURIComponent(token)}`);
	await expect(
		page.getByRole("button", { name: "Settings", exact: true }),
	).toBeVisible({ timeout: 15_000 });
	if (hash) {
		await page.evaluate((h) => { window.location.hash = h; }, hash);
	}
}

function readProjectYaml(rootPath: string): string {
	return readFileSync(join(rootPath, ".bobbit", "config", "project.yaml"), "utf-8");
}

/**
 * Assert the on-disk YAML uses native YAML for a migrated field —
 * no JSON.stringify-style escaped values like:
 *   sandbox_tokens: '[{"key":"X","enabled":true}]'
 * or backslash-escaped:
 *   sandbox_tokens: "[{\"key\":\"X\",\"enabled\":true}]"
 */
function assertNoEscapedJsonForField(yamlText: string, field: string): void {
	const lines = yamlText.split(/\r?\n/);
	for (const line of lines) {
		const m = new RegExp(`^${field}:\\s*(.*)$`).exec(line);
		if (!m) continue;
		const rhs = m[1].trim();
		// Native YAML for our shapes either has nothing on the same line
		// (block style follows), or a `{}` / `[]` empty literal. An RHS
		// that begins with a quote followed by `[` or `{` is the legacy
		// JSON-string form and should never appear after the migration.
		expect(rhs, `${field} must not be a JSON-encoded string on disk`).not.toMatch(/^['"]\s*[\[{]/);
		// And no backslash-escaped quotes anywhere on this line.
		expect(line, `${field} must not contain backslash-escaped quotes`).not.toMatch(/\\"/);
	}
}

test.describe("Per-project native-YAML field editing", () => {
	test("sandbox_tokens: toggle Add token + enabled in Settings persists across reload and writes native YAML", async ({ page }) => {
		const { id, rootPath, cleanup } = await registerProject(`e2e-nyaml-st-${Date.now()}`);
		try {
			await openApp(page, `/settings/${id}/general`);

			// Wait for the Tokens section to render. Token entries only
			// initialize once host tokens have loaded — the editor briefly
			// shows "Detecting..." before the rows or Add-token button appear.
			await expect(page.getByText("Tokens", { exact: true })).toBeVisible({ timeout: 15_000 });
			const addTokenBtn = page.getByRole("button", { name: /Add token/ });
			await expect(addTokenBtn).toBeVisible({ timeout: 15_000 });

			// Capture how many token rows currently exist so we can target
			// our newly-added one even if host tokens (e.g. GITHUB_TOKEN) are
			// already auto-listed.
			const tokenKeyInputs = page.locator("input[placeholder='ENV_VAR']");
			const initialCount = await tokenKeyInputs.count();

			// Click Add token; a new empty row appears with placeholder ENV_VAR.
			await addTokenBtn.click();
			await expect(tokenKeyInputs).toHaveCount(initialCount + 1, { timeout: 5_000 });

			const tokenName = `BOBBIT_E2E_TOKEN_${Date.now()}`;
			const newKeyInput = tokenKeyInputs.nth(initialCount);
			await newKeyInput.fill(tokenName);

			// Locate the row by walking up from the key input — the [value=]
			// attribute selector doesn't reliably match Lit's property-bound
			// .value, so anchor by ancestor of the input we just filled.
			const row = newKeyInput.locator("xpath=ancestor::div[contains(@class,'h-8')][1]");
			const enabledCheckbox = row.locator("input[type='checkbox']").first();
			await expect(enabledCheckbox).toBeChecked(); // default true

			// Toggle disabled, then re-enable — exercises both transitions.
			await enabledCheckbox.uncheck();
			await expect(enabledCheckbox).not.toBeChecked();
			await enabledCheckbox.check();
			await expect(enabledCheckbox).toBeChecked();

			// Save. The save button appears on the General tab once there
			// are pending changes. Wait for the underlying PUT response so
			// we don't race the 2-second "Saved." toast that may flash and clear.
			const saveBtn = page.getByRole("button", { name: "Save", exact: true });
			await expect(saveBtn).toBeVisible({ timeout: 5_000 });
			const saveResp = page.waitForResponse(
				(r) => r.url().includes(`/api/projects/${id}/config`) && r.request().method() === "PUT" && r.status() === 200,
				{ timeout: 15_000 },
			);
			await saveBtn.click();
			await saveResp;

			// Reload and confirm the token row persists in the UI.
			await page.reload();
			await expect(
				page.getByRole("button", { name: "Settings", exact: true }),
			).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText("Tokens", { exact: true })).toBeVisible({ timeout: 15_000 });
			// After reload, find the token row whose key input has our token name.
			// Use evaluate to locate by property value (Lit binds .value as a property).
			const foundIndex = await page.locator("input[placeholder='ENV_VAR']").evaluateAll(
				(els, name) => els.findIndex((el) => (el as HTMLInputElement).value === name),
				tokenName,
			);
			expect(foundIndex, `token row for ${tokenName} should exist after reload`).toBeGreaterThanOrEqual(0);

			// On-disk YAML uses native form for sandbox_tokens.
			const yamlText = readProjectYaml(rootPath);
			expect(yamlText).toMatch(/sandbox_tokens:/);
			assertNoEscapedJsonForField(yamlText, "sandbox_tokens");
			// Native shape: a YAML list whose items have `key:` and `enabled:`.
			expect(yamlText).toMatch(new RegExp(`-\\s+key:\\s+${tokenName}`));
			expect(yamlText).toMatch(/enabled:\s+(true|false)/);
			// `value:` is never persisted (secrets live in secrets.json).
			expect(yamlText).not.toMatch(/^\s*value:/m);

			// Cleanup: remove the token row through the UI to undo the change.
			const reloadedKeyInput = page.locator("input[placeholder='ENV_VAR']").nth(foundIndex);
			const reloadedRow = reloadedKeyInput.locator("xpath=ancestor::div[contains(@class,'h-8')][1]");
			await reloadedRow.locator("button[title='Remove']").click();
			const saveAfterRemove = page.getByRole("button", { name: "Save", exact: true });
			await expect(saveAfterRemove).toBeVisible({ timeout: 5_000 });
			const saveResp2 = page.waitForResponse(
				(r) => r.url().includes(`/api/projects/${id}/config`) && r.request().method() === "PUT" && r.status() === 200,
				{ timeout: 15_000 },
			);
			await saveAfterRemove.click();
			await saveResp2;
		} finally {
			cleanup();
		}
	});

	test("qa_env: top-level PUT is rejected (moved to components[].config)", async ({ page }) => {
		// After the component-config migration, `qa_env` (and the other six
		// legacy top-level qa_* keys) are rejected at the top level of
		// `PUT /api/projects/:id/config`. The Settings page no longer
		// surfaces qa_env directly; per-component config is the new home.
		const { id, cleanup } = await registerProject(`e2e-nyaml-qe-${Date.now()}`);
		try {
			await openApp(page, `/settings/${id}/project`);
			await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 15_000 });

			const putResp = await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({ qa_env: { FOO: "bar" } }),
			});
			expect(putResp.status).toBe(400);
			const body = await putResp.json();
			expect(body.error).toMatch(/components\[\]\.config\[\]/);
		} finally {
			cleanup();
		}
	});
});
