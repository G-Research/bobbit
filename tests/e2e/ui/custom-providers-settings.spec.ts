/**
 * Browser E2E for Settings → Models → Custom Providers.
 *
 * Bug this pins: <custom-provider-dialog> / the custom-providers list (formerly
 * <providers-models-tab>) had ZERO render references anywhere in the real app
 * — a user literally could not reach custom-provider management from the UI,
 * even though the underlying REST API worked. This spec drives the REAL
 * navigation path a user takes, using NVIDIA NIM + a manual model with a
 * context-window override as the acceptance scenario (the concrete ask that
 * motivated this lane).
 *
 * Covers: navigation from Settings root, add-provider happy path, Test
 * Connection (success), persistence across reload, edit without retyping the
 * stored key, and delete/cleanup. Test-Connection auth-failure/unreachable
 * classification is covered at the API layer by
 * tests/e2e/custom-provider-test-connection.spec.ts (this file adds one
 * browser-level check that the distinct message actually renders).
 */
import http from "node:http";
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const FAKE_KEY = "sk-fake-e2e-nim-key-000001";

function startMockNimServer(modelIds: string[], expectedKey: string): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		if (req.url?.endsWith("/v1/models")) {
			if (req.headers["authorization"] !== `Bearer ${expectedKey}`) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Unauthorized" }));
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: modelIds.map((id) => ({ id, object: "model" })) }));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port;
			resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
		});
	});
}

async function openModelsSettings(page: Parameters<typeof openApp>[0]) {
	await navigateToHash(page, "#/settings/system/models");
	const section = page.getByTestId("custom-providers-section");
	await expect(section, "Settings → Models must render the Custom Providers section (the navigation gap this PR fixes)").toBeVisible({ timeout: 10_000 });
	return section;
}

async function cleanupProvidersByName(name: string): Promise<void> {
	const res = await apiFetch("/api/custom-providers");
	if (!res.ok) return;
	const configs = await res.json();
	for (const c of configs) {
		if (c.name === name) {
			await apiFetch(`/api/custom-providers/${encodeURIComponent(c.id)}`, { method: "DELETE" });
		}
	}
}

test.describe("Settings → Models → Custom Providers (navigation + full lifecycle)", () => {
	test("add NVIDIA NIM provider, test connection, add discovered model with contextWindow override, persists across reload, edit without retyping key, delete", async ({ page }) => {
		const PROVIDER_NAME = "NVIDIA NIM (e2e)";
		await cleanupProvidersByName(PROVIDER_NAME);
		const mock = await startMockNimServer(["z-ai/glm-5.2", "z-ai/glm-4.7"], FAKE_KEY);

		try {
			await openApp(page);
			await openModelsSettings(page);

			// Nothing configured yet — sanity that we're really on the real
			// section (not a stale/mocked one).
			await expect(page.getByTestId("custom-providers-empty")).toBeVisible();

			// ── Add Provider → OpenAI Completions Compatible (NIM's API shape) ──
			await page.locator('[data-testid="custom-providers-section"] [role="combobox"]').click();
			await page.getByRole("option", { name: "OpenAI Completions Compatible" }).click();

			const dialog = page.locator('[data-testid="custom-provider-dialog-content"]');
			await expect(dialog).toBeVisible();

			await dialog.locator("input").first().fill(PROVIDER_NAME);
			await dialog.locator("input:not([type=password])").nth(1).fill(mock.url);
			await dialog.locator('[data-testid="api-key-field"] input[type=password]').fill(FAKE_KEY);

			// ── Test Connection: honest probe against the real remote /v1/models ──
			await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
			const discovered = dialog.locator('[data-testid="discovered-models"]');
			await expect(discovered, "Test Connection must report the actual discovered model count").toBeVisible({ timeout: 10_000 });
			await expect(discovered).toContainText("Discovered 2 models");

			// ── Add the discovered z-ai/glm-5.2 model, then set its context-window override ──
			await discovered.locator("li", { hasText: "z-ai/glm-5.2" }).getByRole("button", { name: "+ Add" }).click();
			// Only one model was added, so the row is unambiguous — hasText can't be
			// used to disambiguate anyway since input VALUES aren't part of textContent.
			const row = dialog.locator('[data-testid="manual-model-row"]');
			await expect(row).toHaveCount(1);
			await expect(row.locator('input').first()).toHaveValue("z-ai/glm-5.2");
			await row.locator('[data-testid="manual-model-context-window"] input').fill("200000");

			const savePost = page.waitForResponse((resp) => resp.url().endsWith("/api/custom-providers") && resp.request().method() === "POST");
			await dialog.getByRole("button", { name: "Save", exact: true }).click();
			await savePost;
			await expect(dialog).toHaveCount(0, { timeout: 10_000 });

			// ── Card shows up in the list ──
			const card = page.locator("custom-provider-card", { hasText: PROVIDER_NAME });
			await expect(card).toBeVisible({ timeout: 10_000 });

			// ── Persistence across reload ──
			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await openModelsSettings(page);
			const cardAfterReload = page.locator("custom-provider-card", { hasText: PROVIDER_NAME });
			await expect(cardAfterReload, "custom provider must survive a reload (persisted server-side, not just in-memory)").toBeVisible({ timeout: 10_000 });

			// ── Edit without retyping the key: stored-key hint + blank field ──
			await cardAfterReload.getByRole("button", { name: "Edit", exact: true }).click();
			const editDialog = page.locator('[data-testid="custom-provider-dialog-content"]');
			await expect(editDialog).toBeVisible();
			await expect(editDialog.locator('[data-testid="api-key-field"] input[type=password]')).toHaveValue("");
			await expect(editDialog.locator('[data-testid="stored-key-hint"]')).toContainText("An API key is stored for this provider.");
			// The context-window override round-tripped through save + reload.
			const editRow = editDialog.locator('[data-testid="manual-model-row"]');
			await expect(editRow).toHaveCount(1);
			await expect(editRow.locator('input').first()).toHaveValue("z-ai/glm-5.2");
			await expect(editRow.locator('[data-testid="manual-model-context-window"] input')).toHaveValue("200000");

			// Unrelated edit (rename) — must not require retyping the key.
			await editDialog.locator("input").first().fill(`${PROVIDER_NAME} renamed`);
			const editPost = page.waitForResponse((resp) => resp.url().endsWith("/api/custom-providers") && resp.request().method() === "POST");
			await editDialog.getByRole("button", { name: "Save", exact: true }).click();
			await editPost;
			await expect(editDialog).toHaveCount(0, { timeout: 10_000 });

			const renamedCard = page.locator("custom-provider-card", { hasText: `${PROVIDER_NAME} renamed` });
			await expect(renamedCard).toBeVisible({ timeout: 10_000 });
			// Confirm the server still has the key stored (rename must not have wiped it).
			const configs = await (await apiFetch("/api/custom-providers")).json();
			const stored = configs.find((c: any) => c.name === `${PROVIDER_NAME} renamed`);
			expect(stored?.hasApiKey).toBe(true);
			expect(stored?.models?.find((m: any) => m.id === "z-ai/glm-5.2")?.contextWindow).toBe(200000);

			// ── Delete / cleanup ──
			page.once("dialog", (d) => d.accept());
			const deleteReq = page.waitForResponse((resp) => resp.url().includes("/api/custom-providers/") && resp.request().method() === "DELETE");
			await renamedCard.getByRole("button", { name: "Delete", exact: true }).click();
			await deleteReq;
			await expect(page.locator("custom-provider-card", { hasText: PROVIDER_NAME })).toHaveCount(0, { timeout: 10_000 });
		} finally {
			await mock.close();
			await cleanupProvidersByName(PROVIDER_NAME);
			await cleanupProvidersByName(`${PROVIDER_NAME} renamed`);
		}
	});

	test("Test Connection surfaces authentication failure distinctly (not a silent empty list)", async ({ page }) => {
		const PROVIDER_NAME = "NIM auth-fail (e2e)";
		const mock = await startMockNimServer(["some-model"], FAKE_KEY);
		try {
			await openApp(page);
			await openModelsSettings(page);

			await page.locator('[data-testid="custom-providers-section"] [role="combobox"]').click();
			await page.getByRole("option", { name: "OpenAI Completions Compatible" }).click();

			const dialog = page.locator('[data-testid="custom-provider-dialog-content"]');
			await dialog.locator("input").first().fill(PROVIDER_NAME);
			await dialog.locator("input:not([type=password])").nth(1).fill(mock.url);
			await dialog.locator('[data-testid="api-key-field"] input[type=password]').fill("sk-definitely-wrong-key");

			await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
			const errorMessage = dialog.locator("error-details");
			await expect(errorMessage, "auth failure must surface an explicit error, not a silent empty list").toBeVisible({ timeout: 10_000 });
			await expect(errorMessage).toContainText("Authentication failed");
			await expect(dialog.locator('[data-testid="discovered-models"]')).toHaveCount(0);

			await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		} finally {
			await mock.close();
			await cleanupProvidersByName(PROVIDER_NAME);
		}
	});
});
