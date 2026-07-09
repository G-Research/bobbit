/**
 * Browser E2E — "Hide/Disable PR & Hindsight" acceptance journey.
 *
 * Part 1 (pr-walkthrough default-OFF, still toggleable) + Part 2 (hindsight fully
 * hidden) from the goal spec. This is the FRESH-STATE counterpart to
 * pr-walkthrough-pack.spec.ts (which persists an explicit `{ enabled: true }`
 * baseline to exercise the LIVE feature): here we START from NO stored activation
 * override and prove the shipped default is OFF, then drive the marketplace master
 * toggle ON → reload-persist → OFF.
 *
 * pr-walkthrough is a ships-disabled-by-default built-in pack
 * (`PackManifest.defaultDisabled`). With no stored activation override it resolves
 * NOTHING: no /api/ext/contributions entry (panel/entrypoints/routes), no reviewer
 * tools in /api/tools, and its deep-link (#/ext/pr-walkthrough) surfaces the
 * "feature unavailable" empty state. It STILL shows a row + master toggle in the
 * Market "Built-in" group (the UI lists built-in rows from the RAW enumerator, not
 * the active-filtered band), and flipping that toggle persists `{ enabled: true }`
 * at server scope so all contributions light up — surviving a full reload.
 *
 * hindsight was dropped from the FIRST_PARTY_PACKS allowlist, so it must NOT appear
 * as a built-in row and must NOT be present as a builtin in /api/marketplace/installed.
 *
 * Coverage:
 *   J-1. FRESH DEFAULT-OFF — no contributions, no reviewer tools, deep-link
 *        unavailable, master toggle rendered + UNCHECKED. Hindsight absent from the
 *        built-in group + the installed list.
 *   J-2. ENABLE via master toggle → contributions + tools resolve, toggle checked.
 *   J-3. RELOAD persists enabled — after a full reload the toggle is still checked
 *        and the contributions remain resolved.
 *   J-4. DISABLE via master toggle → contributions gone again, toggle unchecked.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, base, readE2ETokenAsync, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI, navigateToHash } from "./ui-helpers.js";

// Within-file serial: the single journey below mutates shared server-scope
// activation state; keep it isolated from any sibling test that may be added.
test.describe.configure({ mode: "serial" });

const PACK = "pr-walkthrough";
const HINDSIGHT = "hindsight";
const PANEL_ID = "pr-walkthrough.panel";
const PRW_TOOL_NAMES = ["readonly_bash", "read_pr_walkthrough_bundle", "submit_pr_walkthrough_yaml"] as const;

interface PackContributionsMeta {
	packId: string;
	packName: string;
	panels: { id: string; title?: string }[];
	entrypoints: Array<{ id: string; kind: string; routeId?: string; listName: string; label?: string }>;
	routeNames: string[];
}

async function listContributions(): Promise<PackContributionsMeta[]> {
	const res = await apiFetch("/api/ext/contributions");
	expect(res.ok).toBe(true);
	return (await res.json()).packs as PackContributionsMeta[];
}

async function listToolNames(): Promise<string[]> {
	const res = await apiFetch("/api/tools");
	expect(res.ok).toBe(true);
	return ((await res.json()).tools as Array<{ name: string }>).map((t) => t.name);
}

async function listInstalled(): Promise<Array<{ packName: string; scope: string; builtin?: boolean }>> {
	const res = await apiFetch("/api/marketplace/installed");
	expect(res.ok).toBe(true);
	return (await res.json()).installed as Array<{ packName: string; scope: string; builtin?: boolean }>;
}

/** Clear the server-scope activation override so the pack falls back to its
 *  shipped manifest default (default-OFF for pr-walkthrough). An empty disabled
 *  set carries NO `{ enabled: true }` sentinel, so the pack resolves nothing. */
async function clearPrWalkthroughActivation(): Promise<void> {
	await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK, disabled: {} }),
	});
}

async function prwContributionMeta(): Promise<PackContributionsMeta | undefined> {
	return (await listContributions()).find((p) => p.packId === PACK);
}

async function expectPrwContributionsAbsent(): Promise<void> {
	await expect
		.poll(async () => ((await prwContributionMeta()) ? "present" : "absent"), { timeout: 10_000 })
		.toBe("absent");
	const names = new Set(await listToolNames());
	for (const tool of PRW_TOOL_NAMES) {
		expect(names.has(tool), `reviewer tool ${tool} must NOT resolve while the pack is OFF`).toBe(false);
	}
}

async function expectPrwContributionsPresent(): Promise<void> {
	await expect
		.poll(async () => {
			const meta = await prwContributionMeta();
			if (!meta) return "absent";
			const hasPanel = meta.panels?.some((p) => p.id === PANEL_ID);
			const hasRoutes = ["bundle", "publish"].every((r) => meta.routeNames?.includes(r));
			const hasLauncher = meta.entrypoints?.some((e) => e.kind === "session-menu" && e.label === "PR Walkthrough");
			return hasPanel && hasRoutes && hasLauncher ? "full" : "partial";
		}, { timeout: 15_000 })
		.toBe("full");
	await expect
		.poll(async () => {
			const names = new Set(await listToolNames());
			return PRW_TOOL_NAMES.every((t) => names.has(t)) ? "all" : "missing";
		}, { timeout: 15_000 })
		.toBe("all");
}

test.beforeEach(async () => {
	// Fresh state: drop any stored override so the pack sits at its shipped
	// default-OFF. Best-effort — the endpoint 404s only if the pack is missing.
	await clearPrWalkthroughActivation().catch(() => {});
});

test.afterEach(async () => {
	// Leave the shared server-scope state at the shipped default so a failed run
	// never pins the pack ON for the next test on this worker gateway.
	await clearPrWalkthroughActivation().catch(() => {});
});

test.describe("pr-walkthrough default-OFF journey + hindsight hidden", () => {
	test("J — fresh default-off → enable via master toggle → reload persists → disable; hindsight absent", async ({ page }) => {
		const masterToggle = `[data-testid="market-toggle-pack-${PACK}"]`;

		// ── J-1: FRESH DEFAULT-OFF. No contributions, no reviewer tools. ──
		await expectPrwContributionsAbsent();

		// The built-in pack is NOT force-resolved as a builtin in the installed list
		// while OFF? It still LISTS (raw enumerator) — but hindsight must be gone.
		const installed = await listInstalled();
		expect(
			installed.some((p) => p.packName === HINDSIGHT && p.builtin),
			"hindsight must NOT appear as a built-in pack in /api/marketplace/installed",
		).toBe(false);
		expect(
			installed.some((p) => p.packName === PACK && p.builtin),
			"pr-walkthrough must still LIST as a built-in row (toggleable) even while OFF",
		).toBe(true);

		await openApp(page);
		const sid = await createSessionViaUI(page);
		await waitForSessionStatus(sid, "idle").catch(() => { /* best-effort */ });

		// The deep-link resolves to the "feature unavailable" empty state — the route
		// is not registered while the pack is OFF (no panel, no crash).
		await navigateToHash(page, `#/ext/${PACK}`);
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.()).catch(() => {});
		const unavailable = page.locator('[data-testid="ext-route-unavailable"]');
		await expect(unavailable, "the disabled deep-link must show the unavailable empty state").toBeVisible({ timeout: 15_000 });
		await expect(page.locator('[data-testid="prw-panel-root"]')).toHaveCount(0);

		// ── Market "Built-in" group: pr-walkthrough row present + master toggle OFF;
		//    hindsight row absent. ──
		await navigateToHash(page, "#/market");
		const builtinGroup = page.locator('[data-testid="market-builtin-group"]');
		await expect(builtinGroup, "the Market Installed tab must show a Built-in group").toBeVisible({ timeout: 20_000 });
		const prwCard = builtinGroup
			.locator('[data-testid="market-installed-pack"][data-builtin="true"][data-pack-name="pr-walkthrough"]')
			.first();
		await expect(prwCard, "the built-in PR walkthrough card must render even while default-OFF").toBeVisible({ timeout: 15_000 });
		await expect(
			builtinGroup.locator('[data-testid="market-installed-pack"][data-pack-name="hindsight"]'),
			"hindsight must NOT render a row in the built-in group",
		).toHaveCount(0);

		const toggle = prwCard.locator(masterToggle);
		await expect(toggle, "the pr-walkthrough master toggle must render").toBeVisible({ timeout: 15_000 });
		await expect(toggle, "a fresh (override-free) pr-walkthrough must be OFF by default").not.toBeChecked();

		// ── J-2: ENABLE via the master toggle → contributions + tools resolve. ──
		let put = page.waitForResponse(
			(r) => r.url().includes("/api/marketplace/pack-activation") && r.request().method() === "PUT",
		);
		await toggle.click();
		await put;
		await expect(toggle, "the master toggle must flip ON").toBeChecked();
		await expectPrwContributionsPresent();

		// ── J-3: RELOAD persists enabled. ──
		const token = await readE2ETokenAsync();
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/market`);
		const builtinGroup2 = page.locator('[data-testid="market-builtin-group"]');
		await expect(builtinGroup2).toBeVisible({ timeout: 20_000 });
		const prwCard2 = builtinGroup2
			.locator('[data-testid="market-installed-pack"][data-builtin="true"][data-pack-name="pr-walkthrough"]')
			.first();
		await expect(prwCard2).toBeVisible({ timeout: 15_000 });
		const toggle2 = prwCard2.locator(masterToggle);
		await expect(toggle2, "enabled state must survive a reload (toggle stays ON)").toBeChecked({ timeout: 15_000 });
		await expectPrwContributionsPresent();

		// ── J-4: DISABLE via the master toggle → contributions gone again. ──
		put = page.waitForResponse(
			(r) => r.url().includes("/api/marketplace/pack-activation") && r.request().method() === "PUT",
		);
		await toggle2.click();
		await put;
		await expect(toggle2, "the master toggle must flip back OFF").not.toBeChecked();
		await expectPrwContributionsAbsent();
	});
});
