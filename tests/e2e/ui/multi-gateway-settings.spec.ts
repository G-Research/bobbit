/**
 * Browser E2E for the Slice D gateway list editor (Settings → Models tab).
 *
 * See docs/design/multi-gateway-providers.md §7 + §11. Covers the full editor
 * surface end-to-end against TWO self-hosted in-process stub gateways (no LAN
 * dependency, per the NO-NETWORK constraint):
 *   - add an `openai-compatible` row and an `aigw` row (name / url / type) + Save;
 *   - the exclusivity warning banner appears whenever an ENABLED `aigw` row
 *     exists and disappears when it is disabled (purely client-side, pre-Save);
 *   - the model picker reflects the saved gateways: in merged mode the
 *     `openai-compatible` provider + built-ins are present, and in exclusive
 *     mode (enabled `aigw`) ONLY `aigw` models are surfaced (built-ins +
 *     openai-compatible suppressed);
 *   - persistence: a full page reload restores rows + enabled state from
 *     GET /api/aigw/gateways;
 *   - removal cleanup: removing a row + Save drops its provider from /api/models.
 *
 * Discovery runs server-side (model-registry → discoverGatewayModels), so the
 * stub servers only need to be reachable from the in-process gateway (Node),
 * not from the browser. The two stubs expose DISJOINT model id sets so the
 * picker assertions are deterministic per-provider.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import { apiFetch } from "../e2e-setup.js";
import http from "node:http";
import type { Page } from "@playwright/test";

type Stub = { server: http.Server; url: string };

/** Start a tiny OpenAI-compatible stub serving GET /v1/models + a canned completion. */
async function startStub(modelIds: string[]): Promise<Stub> {
	const server = http.createServer((req, res) => {
		res.setHeader("Content-Type", "application/json");
		if (req.url?.endsWith("/v1/models")) {
			res.end(JSON.stringify({ data: modelIds.map((id) => ({ id, object: "model" })) }));
		} else {
			res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as { port: number }).port;
	return { server, url: `http://127.0.0.1:${port}` };
}

const MODELS_TAB = "#/settings/system/models";
const editor = "[data-testid='gateways-editor']";
const rowsSel = "[data-testid='gateway-row']";
const warning = "[data-testid='gateway-exclusivity-warning']";
const saveBtn = "[data-testid='gateways-save-btn']";

// Disjoint model id sets — one per provider — so picker rows are unambiguous.
const LLAMA_MODEL = "qwen-coder-medium";   // only the llama-swap (openai-compatible) stub serves this
const AIGW_MODEL = "gpt-aigw-only";        // only the aigw stub serves this

const modelItem = (id: string) => `[data-model-item][data-model-id="${id}"]`;

/**
 * Open the model picker from the Session default-model row and wait for it to
 * load. The `<agent-model-selector>` host is a zero-size element (the modal
 * portals its content to the body), so we wait on a rendered model ROW becoming
 * visible rather than the host itself.
 */
async function openPicker(page: Page): Promise<void> {
	await page.locator("[data-row-label='Session'] button[title='Choose model']").first().click();
	// Wait for the list to finish loading (the "Loading models..." placeholder clears).
	await expect(page.locator(`${modelItem(LLAMA_MODEL)}, ${modelItem(AIGW_MODEL)}`).first()).toBeVisible({ timeout: 10_000 });
}

/** Close the model picker deterministically so the next open() doesn't stack dialogs. */
async function closePicker(page: Page): Promise<void> {
	await page.evaluate(() => {
		document.querySelectorAll("agent-model-selector").forEach((el) => {
			const close = (el as unknown as { close?: () => void }).close;
			if (typeof close === "function") close.call(el);
			else el.remove();
		});
	});
	await expect(page.locator("agent-model-selector")).toHaveCount(0, { timeout: 10_000 });
}

async function readModels(): Promise<Array<{ provider: string; id: string }>> {
	const res = await apiFetch("/api/models");
	expect(res.ok).toBe(true);
	return res.json();
}

test.describe("Settings → Models → AI Gateways list editor (§7)", () => {
	test("add/save, exclusivity warning, picker providers, persistence, removal", async ({ page }) => {
		test.setTimeout(120_000);

		const llama = await startStub([LLAMA_MODEL]);
		const aigw = await startStub([AIGW_MODEL, "aws/us.anthropic.claude-sonnet-4-6"]);

		// Always leave the worker's gateway prefs clean for sibling specs.
		const resetGateways = async () => {
			await apiFetch("/api/aigw/gateways", { method: "PUT", body: JSON.stringify({ gateways: [] }) }).catch(() => {});
		};

		try {
			await resetGateways();
			await openApp(page);
			await navigateToHash(page, MODELS_TAB);
			await expect(page.locator(editor)).toBeVisible({ timeout: 15_000 });

			// ── Add an openai-compatible row (llama-swap) ──
			await page.locator("[data-testid='gateways-add-btn']").click();
			await expect(page.locator(rowsSel)).toHaveCount(1);
			const row0 = page.locator(rowsSel).nth(0);
			await row0.locator("[data-testid='gateway-name-input']").fill("llama-swap");
			await row0.locator("[data-testid='gateway-url-input']").fill(llama.url);
			// type defaults to openai-compatible.
			await expect(row0.locator("[data-testid='gateway-type-select']")).toHaveValue("openai-compatible");

			// ── Add an aigw row (must be named exactly "aigw") ──
			await page.locator("[data-testid='gateways-add-btn']").click();
			await expect(page.locator(rowsSel)).toHaveCount(2);
			const row1 = page.locator(rowsSel).nth(1);
			await row1.locator("[data-testid='gateway-name-input']").fill("aigw");
			await row1.locator("[data-testid='gateway-url-input']").fill(aigw.url);
			await row1.locator("[data-testid='gateway-type-select']").selectOption("aigw");

			// Enabling an aigw-type row (default enabled) → exclusivity warning shows.
			await expect(page.locator(warning)).toBeVisible();
			// Uncheck the aigw row → warning disappears (purely client-side, pre-Save).
			await row1.locator("[data-testid='gateway-enabled-checkbox']").uncheck();
			await expect(page.locator(warning)).toHaveCount(0);
			// Re-check → warning reappears.
			await row1.locator("[data-testid='gateway-enabled-checkbox']").check();
			await expect(page.locator(warning)).toBeVisible();

			// ── MERGED mode: save with the aigw row DISABLED ──
			await row1.locator("[data-testid='gateway-enabled-checkbox']").uncheck();
			await expect(page.locator(warning)).toHaveCount(0);
			await page.locator(saveBtn).click();
			await expect(page.locator(saveBtn)).toHaveText("Save", { timeout: 15_000 });
			await expect(page.locator("[data-testid='gateways-error']")).toHaveCount(0);

			// /api/models (merged): llama-swap present, no aigw, built-ins present.
			let models = await readModels();
			expect(models.some((m) => m.provider === "llama-swap" && m.id === LLAMA_MODEL)).toBe(true);
			expect(models.some((m) => m.provider === "aigw")).toBe(false);
			expect(models.some((m) => m.provider !== "llama-swap")).toBe(true); // built-ins survive in merged mode

			// Picker UI shows the llama-swap model with its provider badge.
			await openPicker(page);
			await expect(page.locator(modelItem(LLAMA_MODEL))).toBeVisible({ timeout: 10_000 });
			await expect(page.locator(modelItem(LLAMA_MODEL))).toContainText("llama-swap");
			await closePicker(page);

			// ── EXCLUSIVE mode: enable the aigw row + Save ──
			await page.locator(rowsSel).nth(1).locator("[data-testid='gateway-enabled-checkbox']").check();
			await expect(page.locator(warning)).toBeVisible();
			await page.locator(saveBtn).click();
			await expect(page.locator(saveBtn)).toHaveText("Save", { timeout: 15_000 });
			await expect(page.locator("[data-testid='gateways-error']")).toHaveCount(0);

			// /api/models (exclusive): ONLY provider "aigw" — built-ins + llama-swap suppressed.
			models = await readModels();
			expect(models.length).toBeGreaterThan(0);
			expect(models.every((m) => m.provider === "aigw")).toBe(true);
			expect(models.some((m) => m.id === AIGW_MODEL)).toBe(true);
			expect(models.some((m) => m.provider === "llama-swap")).toBe(false);

			// Picker UI (exclusive): aigw model present, llama-swap absent.
			await openPicker(page);
			await expect(page.locator(modelItem(AIGW_MODEL))).toBeVisible({ timeout: 10_000 });
			await expect(page.locator(modelItem(LLAMA_MODEL))).toHaveCount(0);
			await closePicker(page);

			// ── Persistence: full reload restores both rows + enabled state ──
			await page.reload();
			await navigateToHash(page, MODELS_TAB);
			await expect(page.locator(editor)).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(rowsSel)).toHaveCount(2);
			// Order is preserved by the server list, so row0=llama-swap, row1=aigw.
			const llamaRow = page.locator(rowsSel).nth(0);
			const aigwRow = page.locator(rowsSel).nth(1);
			await expect(llamaRow.locator("[data-testid='gateway-name-input']")).toHaveValue("llama-swap");
			await expect(aigwRow.locator("[data-testid='gateway-name-input']")).toHaveValue("aigw");
			await expect(llamaRow.locator("[data-testid='gateway-enabled-checkbox']")).toBeChecked();
			await expect(aigwRow.locator("[data-testid='gateway-enabled-checkbox']")).toBeChecked();
			await expect(aigwRow.locator("[data-testid='gateway-type-select']")).toHaveValue("aigw");
			// aigw still enabled after reload → warning restored.
			await expect(page.locator(warning)).toBeVisible();

			// ── Removal cleanup ──
			// Disable aigw first (back to merged) so the removed openai-compatible
			// provider's disappearance is observable in /api/models.
			await aigwRow.locator("[data-testid='gateway-enabled-checkbox']").uncheck();
			await llamaRow.locator("[data-testid='gateway-remove-btn']").click();
			await expect(page.locator(rowsSel)).toHaveCount(1);
			await page.locator(saveBtn).click();
			await expect(page.locator(saveBtn)).toHaveText("Save", { timeout: 15_000 });

			models = await readModels();
			expect(models.some((m) => m.provider === "llama-swap")).toBe(false);
			expect(models.some((m) => m.provider === "aigw")).toBe(false); // aigw disabled too
		} finally {
			await resetGateways();
			await new Promise<void>((r) => llama.server.close(() => r()));
			await new Promise<void>((r) => aigw.server.close(() => r()));
		}
	});
});
