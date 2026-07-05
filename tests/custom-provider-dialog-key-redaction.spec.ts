/**
 * Browser fixture test for <custom-provider-dialog> — client half of the
 * custom-provider API-key redaction contract (server half pinned by
 * tests/e2e/custom-provider-key-redaction.spec.ts).
 *
 * The server never returns stored keys on any read path (GET redacts to
 * `hasApiKey: boolean`), so the edit dialog must:
 *   - show a BLANK key field with a "Key set — leave blank to keep"
 *     placeholder when a key is stored (it has nothing to prefill — and must
 *     never render a raw or masked key value);
 *   - OMIT `apiKey` from the save payload when the field is untouched
 *     (server preserves the stored key);
 *   - send the typed value when the user enters a replacement key;
 *   - send `apiKey: null` when the user explicitly clears the stored key.
 *
 * This dialog is now reachable at Settings → Models → Custom Providers (see
 * tests/e2e/ui/custom-providers-settings.spec.ts for the full-app navigation
 * + happy-path browser E2E). This fixture stays as a fast, no-gateway
 * complement: it drives the real `<custom-provider-dialog>` element + real
 * wire payloads via a file:// bundle, without booting a gateway.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/custom-provider-dialog.html");
const BUNDLE = path.resolve("tests/fixtures/custom-provider-dialog-bundle.js");
const ENTRY = path.resolve("tests/fixtures/custom-provider-dialog-entry.ts");
const SRC = path.resolve("src/ui/dialogs/CustomProviderDialog.ts");

// Fake key only — never a real credential in tests.
const FAKE_KEY = "sk-fake-fixture-key-000001";

test.beforeAll(() => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(SRC).mtimeMs);
	const stale = fs.existsSync(BUNDLE) && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!fs.existsSync(BUNDLE) || stale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;

// The fixture has no app stylesheet, so DialogBase's modal renders without its
// constrained/positioned layout and buttons can land outside the viewport.
// Click buttons through the DOM (by exact trimmed label) instead of
// Playwright's viewport-checked click.
async function jsClickButton(page: any, label: string) {
	await page.evaluate((text: string) => {
		const buttons = Array.from(document.querySelectorAll("custom-provider-dialog button"));
		const btn = buttons.find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
		if (!btn) throw new Error(`Button not found: ${text}`);
		btn.click();
	}, label);
}

const EDIT_PROVIDER = {
	id: "prov-1",
	name: "My Remote API",
	type: "openai-completions",
	baseUrl: "https://api.example.invalid",
	hasApiKey: true, // what the redacted GET response carries — never the key itself
	models: [{ id: "model-a", name: "model-a" }],
};

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	await page.waitForFunction(() => !!customElements.get("custom-provider-dialog"), null, { timeout: 10_000 });
}

async function openDialog(page: any, provider: unknown) {
	await page.evaluate((p: any) => (window as any).CustomProviderDialog.open(p, undefined), provider);
	await expect(page.locator("custom-provider-dialog")).toBeVisible();
}

function keyInput(page: any) {
	return page.locator('custom-provider-dialog [data-testid="api-key-field"] input[type="password"]');
}

async function saveAndGetPayload(page: any): Promise<any> {
	await jsClickButton(page, "Save");
	await page.waitForFunction(
		() => (window as any).__fetchCalls.some((c: any) => /\/api\/custom-providers$/.test(c.url) && c.method === "POST"),
		null,
		{ timeout: 10_000 },
	);
	const call = await page.evaluate(() =>
		(window as any).__fetchCalls.find((c: any) => /\/api\/custom-providers$/.test(c.url) && c.method === "POST"),
	);
	return JSON.parse(call.body);
}

test.describe("<custom-provider-dialog> key redaction contract", () => {
	test("editing a provider with a stored key shows a BLANK field with keep-blank placeholder (never a key value)", async ({ page }) => {
		await gotoAndWait(page);
		await openDialog(page, EDIT_PROVIDER);

		const input = keyInput(page);
		await expect(input).toHaveValue("");
		await expect(input).toHaveAttribute("placeholder", "Key set — leave blank to keep");
		const hint = page.locator('custom-provider-dialog [data-testid="stored-key-hint"]');
		await expect(hint).toContainText("An API key is stored for this provider.");
		await expect(hint.locator("button", { hasText: "Clear stored key" })).toBeVisible();
	});

	test("save with the key field untouched OMITS apiKey (server preserves the stored key)", async ({ page }) => {
		await gotoAndWait(page);
		await openDialog(page, EDIT_PROVIDER);

		// Unrelated edit: rename the provider.
		await page.locator("custom-provider-dialog input").first().fill("Renamed Provider");

		const payload = await saveAndGetPayload(page);
		expect(payload.name).toBe("Renamed Provider");
		expect(payload.id).toBe("prov-1");
		expect("apiKey" in payload, "untouched key field must not appear in the payload at all").toBe(false);
	});

	test("typing a new key sends it in the save payload", async ({ page }) => {
		await gotoAndWait(page);
		await openDialog(page, EDIT_PROVIDER);

		await keyInput(page).fill(FAKE_KEY);

		const payload = await saveAndGetPayload(page);
		expect(payload.apiKey).toBe(FAKE_KEY);
	});

	test("'Clear stored key' → save sends apiKey: null; 'Keep stored key' undoes it", async ({ page }) => {
		await gotoAndWait(page);
		await openDialog(page, EDIT_PROVIDER);

		const hint = page.locator('custom-provider-dialog [data-testid="stored-key-hint"]');
		await jsClickButton(page, "Clear stored key");
		await expect(hint).toContainText("Stored key will be removed on save.");
		// Placeholder no longer claims a key will be kept.
		await expect(keyInput(page)).toHaveAttribute("placeholder", "Leave empty if not required");

		// Undo restores the keep state.
		await jsClickButton(page, "Keep stored key");
		await expect(hint).toContainText("An API key is stored for this provider.");

		// Clear again and save: explicit null on the wire.
		await jsClickButton(page, "Clear stored key");
		const payload = await saveAndGetPayload(page);
		expect(payload.apiKey).toBeNull();
	});

	test("new provider (no stored key): typed key is sent, no stored-key hint shown", async ({ page }) => {
		await gotoAndWait(page);
		await openDialog(page, undefined);

		await expect(page.locator('custom-provider-dialog [data-testid="stored-key-hint"]')).toHaveCount(0);
		await expect(keyInput(page)).toHaveAttribute("placeholder", "Leave empty if not required");

		await page.locator("custom-provider-dialog input").first().fill("Fresh Provider");
		// Base URL is the second text input.
		await page.locator("custom-provider-dialog input:not([type=password])").nth(1).fill("https://api.example.invalid");
		await keyInput(page).fill(FAKE_KEY);

		const payload = await saveAndGetPayload(page);
		expect(payload.name).toBe("Fresh Provider");
		expect(payload.apiKey).toBe(FAKE_KEY);
	});

	test("editing the base URL surfaces 'Key required to test a changed URL' until a key is typed", async ({ page }) => {
		// Auto-discovery type so the Test Connection block (which hosts the
		// hint) renders. The server's anti-exfiltration guard only applies the
		// stored key to the SAVED baseUrl, so a changed URL needs a typed key.
		const ollamaProvider = {
			id: "prov-ollama",
			name: "Local Ollama",
			type: "ollama",
			baseUrl: "http://localhost:11434",
			hasApiKey: true,
		};
		await gotoAndWait(page);
		await openDialog(page, ollamaProvider);

		const hint = page.locator('custom-provider-dialog [data-testid="changed-url-key-hint"]');
		await expect(hint).toHaveCount(0);

		// Change the base URL: hint appears.
		await page.locator("custom-provider-dialog input:not([type=password])").nth(1).fill("http://attacker.example.invalid:11434");
		await expect(hint).toContainText("Key required to test a changed URL");

		// Typing a key satisfies it: hint disappears.
		await keyInput(page).fill(FAKE_KEY);
		await expect(hint).toHaveCount(0);
	});
});
