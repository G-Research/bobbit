/**
 * Browser E2E — Hindsight Marketplace MULTI-PROJECT override surface (the
 * follow-up deferred from the "Hindsight Marketplace UI" PR, whose per-project
 * override section pinned its target to `state.projects[0]` with no way to
 * address any other project).
 *
 * This spec pins the multi-project contract:
 *
 *   1. PROJECT PICKER — the override sub-section carries an explicit project
 *      select (Headquarters excluded, mirroring the sidebar's HQ filtering); the
 *      selection is persisted and survives a full page reload.
 *   2. PER-PROJECT BANK + SCOPE — the override saves `bank` + `recallScope` for
 *      the SELECTED project only; switching projects re-seeds the fields from
 *      that project's own overlay (isolation), and the saved values persist
 *      across reload. The bank picker is fed by the pack's `banks` route.
 *   3. NO-RUNTIME GRACEFUL — with no configured/reachable Hindsight runtime the
 *      override section still renders: the bank picker degrades to a free-text
 *      input, the `banks` route is probed exactly ONCE per form open (dormant-
 *      safe 200, never a 404 storm — the same probe-only-when-needed discipline
 *      as renderRuntimeRow's `if (checked)` capability gate), and the overlay
 *      write still works.
 *
 * External data is the in-process `hindsight-stub.mjs`; no Docker, no managed
 * supervisor (external mode only).
 *
 * SKIP-GUARD: mirrors hindsight-marketplace.spec.ts — a static STACK_READY over
 * the pack-contribution files PLUS a static marker for the multi-project UI
 * (`market-hindsight-override-project`), so the suite stays green-by-skip on
 * branches where this UI hasn't merged yet.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI, navigateToHash } from "./ui-helpers.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PACK = "hindsight";
const PACK_SRC = path.resolve(__dirname, "..", "..", "..", "market-packs", PACK);
const STUB_PATH = path.resolve(__dirname, "..", "hindsight-stub.mjs");
const CONFIG_KEY = "provider-config:memory";
const PROJECT_CONFIG_KEY_PREFIX = "provider-config:memory:project:";

const MARKETPLACE_PAGE_SRC = path.resolve(__dirname, "..", "..", "..", "src", "app", "marketplace-page.ts");
function multiProjectUiImplemented(): boolean {
	try {
		const src = fs.readFileSync(MARKETPLACE_PAGE_SRC, "utf-8");
		return src.includes('data-testid="market-hindsight-override-project"') && src.includes('data-testid="market-hindsight-override-bank"');
	} catch {
		return false;
	}
}

const STACK_READY =
	fs.existsSync(path.join(PACK_SRC, "lib", "routes.mjs")) &&
	fs.existsSync(STUB_PATH) &&
	multiProjectUiImplemented();

const describe = STACK_READY ? test.describe : test.describe.skip;

interface HindsightStub {
	url: string;
	setHealthy(ok: boolean): void;
	seedMemories(bank: string, mem: { text: string; id?: string; score?: number; tags?: string[] }[]): void;
	close(): Promise<void>;
}
async function startStub(): Promise<HindsightStub> {
	const mod = await import(STUB_PATH as string);
	const start = mod.startHindsightStub ?? mod.default;
	return start({ port: 0 }) as Promise<HindsightStub>;
}

/** Runtime readiness: the `banks` + `config` routes must be served here. */
async function routesReady(): Promise<boolean> {
	const res = await apiFetch("/api/ext/contributions");
	if (!res.ok) return false;
	const packs = ((await res.json()).packs ?? []) as Array<{ packId: string; routeNames?: string[] }>;
	const meta = packs.find((p) => p.packId === PACK);
	if (!meta) return false;
	return ["config", "status", "banks"].every((r) => meta.routeNames?.includes(r));
}

async function putHindsightConfig(overrides: Record<string, unknown>): Promise<void> {
	const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
	await getPackStore().put(PACK, CONFIG_KEY, overrides);
}

async function clearProjectOverride(projectId: string): Promise<void> {
	const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
	await getPackStore().put(PACK, `${PROJECT_CONFIG_KEY_PREFIX}${projectId}`, {});
}

async function registerProject(name: string): Promise<string> {
	const rootPath = path.join(os.tmpdir(), `bobbit-e2e-hs-mp-${name}-${Date.now()}`);
	fs.mkdirSync(rootPath, { recursive: true });
	const res = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name: `e2e-hs-mp-${name}-${Date.now()}`, rootPath }),
	});
	expect(res.status, "the extra project registers").toBe(201);
	return ((await res.json()) as { id: string }).id;
}

async function openWithSession(page: Page): Promise<void> {
	await openApp(page);
	const sid = await createSessionViaUI(page);
	expect(sid, "a session must be selected so the marketplace can read pack status").toBeTruthy();
	await waitForSessionStatus(sid, "idle").catch(() => { /* best-effort */ });
}

async function openMarketRow(page: Page): Promise<ReturnType<Page["locator"]>> {
	await navigateToHash(page, "#/roles");
	await navigateToHash(page, "#/market");
	await expect(page.locator('[data-testid="market-installed-panel"]')).toBeVisible({ timeout: 15_000 });
	await page.locator('[data-testid="market-tab-installed"]').click();
	const row = page.locator('[data-testid="market-installed-pack"][data-pack-name="hindsight"]').first();
	await expect(row, "the built-in Hindsight row is present").toBeVisible({ timeout: 15_000 });
	return row;
}

/** Open the inline Configure form and return the override sub-section locator. */
async function openOverrideSection(page: Page): Promise<{ row: ReturnType<Page["locator"]>; override: ReturnType<Page["locator"]> }> {
	const row = await openMarketRow(page);
	await row.locator('[data-testid="market-hindsight-configure"]').click();
	await expect(row.locator('[data-testid="market-hindsight-config-form"] [data-testid="market-hindsight-form-mode"]')).toBeVisible({ timeout: 15_000 });
	const override = row.locator('[data-testid="market-hindsight-override"]');
	await expect(override, "the per-project override section is shown").toBeVisible({ timeout: 15_000 });
	return { row, override };
}

const overrideProject = (override: ReturnType<Page["locator"]>) => override.locator('[data-testid="market-hindsight-override-project"]');
const overrideScope = (override: ReturnType<Page["locator"]>) => override.locator('[data-testid="market-hindsight-override-recallscope"]');
const overrideBankSelect = (override: ReturnType<Page["locator"]>) => override.locator('select[data-testid="market-hindsight-override-bank"]');
const overrideBankInput = (override: ReturnType<Page["locator"]>) => override.locator('input[data-testid="market-hindsight-override-bank"]');
const overrideSave = (override: ReturnType<Page["locator"]>) => override.locator('[data-testid="market-hindsight-override-save"]');
const overrideResult = (override: ReturnType<Page["locator"]>) => override.locator('[data-testid="market-hindsight-override-result"]');

async function saveOverride(override: ReturnType<Page["locator"]>): Promise<void> {
	await overrideSave(override).click();
	await expect(overrideResult(override), "the override save reports a result").toContainText("Saved", { timeout: 20_000 });
}

test.describe.configure({ mode: "serial" });

describe("Hindsight pack — Marketplace multi-project override (project picker + per-project bank)", () => {
	let stub: HindsightStub;
	let ready = false;
	let projectA = "";
	let projectB = "";

	test.beforeAll(async () => {
		stub = await startStub();
		// Two banks served by the runtime — the bank picker must list BOTH.
		stub.seedMemories("hermes", [{ text: "seed hermes" }]);
		stub.seedMemories("alpha", [{ text: "seed alpha" }]);
		projectA = await registerProject("a");
		projectB = await registerProject("b");
		ready = await routesReady();
	});

	test.afterAll(async () => {
		await putHindsightConfig({});
		if (projectA) await clearProjectOverride(projectA).catch(() => { /* ignore */ });
		if (projectB) await clearProjectOverride(projectB).catch(() => { /* ignore */ });
		if (stub) await stub.close().catch(() => { /* ignore */ });
	});

	test.beforeEach(async () => {
		await putHindsightConfig({});
		await clearProjectOverride(projectA);
		await clearProjectOverride(projectB);
		stub.setHealthy(true);
	});

	test("project picker: per-project bank/scope override saves for the SELECTED project, persists across reload, and stays isolated per project", async ({ page }) => {
		test.skip(!ready, "Hindsight config/status/banks routes not served in this environment");
		await putHindsightConfig({ externalUrl: stub.url, bank: "hermes" });

		await openWithSession(page);
		let { row, override } = await openOverrideSection(page);

		// 1. The project picker is present and lists BOTH registered projects
		//    (Headquarters excluded — its option value never appears).
		const picker = overrideProject(override);
		await expect(picker, "the override section carries a project picker").toBeVisible({ timeout: 15_000 });
		const optionValues = await picker.locator("option").evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
		expect(optionValues, "both registered projects are selectable").toEqual(expect.arrayContaining([projectA, projectB]));
		expect(optionValues, "Headquarters is not an override target").not.toContain("headquarters");

		// 2. Target project B; the bank picker lists the banks the runtime serves.
		await picker.selectOption(projectB);
		const bankSel = overrideBankSelect(override);
		await expect(bankSel, "with a reachable runtime the bank control is a picker").toBeVisible({ timeout: 15_000 });
		const bankOptions = await bankSel.locator("option").evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
		expect(bankOptions, "the bank picker is fed by the runtime's banks route").toEqual(expect.arrayContaining(["hermes", "alpha"]));

		// 3. Save a per-project bank + scope override for project B.
		await bankSel.selectOption("alpha");
		await overrideScope(override).selectOption("all");
		await saveOverride(override);
		await expect(row.locator('[data-testid="market-hindsight-override-active"]'), "the override badge follows the selected project").toBeVisible({ timeout: 20_000 });

		// 4. Reload: the SELECTION persists (project B still targeted) and the
		//    saved override values read back for it.
		await page.reload();
		({ row, override } = await openOverrideSection(page));
		await expect(overrideProject(override), "the picked project persists across reload").toHaveValue(projectB, { timeout: 15_000 });
		await expect(overrideBankSelect(override), "the saved bank override persists across reload").toHaveValue("alpha", { timeout: 15_000 });
		await expect(overrideScope(override), "the saved recall-scope override persists across reload").toHaveValue("all", { timeout: 15_000 });

		// 5. Isolation: project A carries NO overlay — switching re-seeds to inherit.
		await overrideProject(override).selectOption(projectA);
		await expect(overrideScope(override), "project A inherits (no overlay)").toHaveValue("", { timeout: 15_000 });
		await expect(override.locator('[data-testid="market-hindsight-override-bank"]'), "project A's bank inherits (no overlay)").toHaveValue("", { timeout: 15_000 });

		// ... and switching back re-seeds project B's own values.
		await overrideProject(override).selectOption(projectB);
		await expect(overrideScope(override), "project B's overlay re-seeds on switch-back").toHaveValue("all", { timeout: 15_000 });
		await expect(override.locator('[data-testid="market-hindsight-override-bank"]'), "project B's bank re-seeds on switch-back").toHaveValue("alpha", { timeout: 15_000 });

		// 6. Cleanup/undo: clearing both fields removes the overlay and the badge.
		await overrideBankSelect(override).selectOption("");
		await overrideScope(override).selectOption("");
		await saveOverride(override);
		await expect(row.locator('[data-testid="market-hindsight-override-active"]'), "clearing the override removes the badge").toBeHidden({ timeout: 20_000 });
	});

	test("no configured runtime: the override degrades gracefully — ONE dormant-safe banks probe (no 404 storm), free-text bank fallback, overlay still writable", async ({ page }) => {
		test.skip(!ready, "Hindsight config/status/banks routes not served in this environment");
		// beforeEach left Hindsight UNCONFIGURED — no runtime is reachable for any project.

		const banksProbes: number[] = [];
		page.on("response", (res) => {
			if (res.url().includes(`/api/ext/pack-route/${PACK}/banks`)) banksProbes.push(res.status());
		});

		await openWithSession(page);
		const { row, override } = await openOverrideSection(page);
		await expect(row.locator('[data-testid="market-hindsight-state"]'), "an unconfigured row stays Disabled").toHaveAttribute("data-state", "disabled", { timeout: 20_000 });

		// The bank control degrades to a free-text input (no bank list to pick from).
		const bankInput = overrideBankInput(override);
		await expect(bankInput, "with no runtime the bank control is a free-text input").toBeVisible({ timeout: 15_000 });

		// The overlay write path still works without a runtime.
		await bankInput.fill("scratch-bank");
		await saveOverride(override);

		// Probe discipline: the banks route was hit EXACTLY once for this form
		// open, and the read was dormant-safe (HTTP 200 — never a 404 storm).
		expect(banksProbes.length, "the banks route is probed exactly once per form open").toBe(1);
		expect(banksProbes[0], "the dormant banks probe is a graceful 200").toBe(200);

		// Cleanup/undo: once saved, the stored bank anchors the picker (a stored
		// override must never silently disappear from its own control), so the
		// free-text input legitimately becomes a select — clear through it.
		const bankAfterSave = overrideBankSelect(override);
		await expect(bankAfterSave, "the saved free-text bank now anchors the picker").toBeVisible({ timeout: 15_000 });
		await bankAfterSave.selectOption("");
		await saveOverride(override);
	});
});
