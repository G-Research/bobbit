/**
 * Browser E2E — P4 Hindsight native config/status PANEL + entrypoints
 * (design docs/design/hindsight-panel-p4-implementation.md §7). Proves the
 * Hindsight pack's native panel is served END-TO-END by the built-in band with
 * NO manual install, and that it replaces store-seeding as the user-facing
 * configuration path:
 *
 *   1. OPEN — the command-palette launcher (`hindsight.palette`, a bare
 *      PanelTarget) opens `hindsight.panel` in the active session via the SAME
 *      `runLauncherEntrypoint` chain a palette click drives (design §7.2 #1
 *      explicitly sanctions the `__bobbitRunPackLauncher` hook). The status badge
 *      starts `data-state="dormant"` (not configured).
 *   2. CONFIGURE — type the in-process Hindsight stub URL into
 *      `hindsight-external-url` + `bobbit` into `hindsight-bank`, click
 *      `hindsight-save`. Config persists THROUGH the `config` route (validation +
 *      redaction server-side), never a client store write.
 *   3. STATUS — with the stub healthy, Save re-fetches `status` → the badge flips
 *      to `data-state="connected"`; `setHealthy(false)` + Refresh → `unreachable`;
 *      restore → `connected` again (the panel's read-only health projection).
 *   4. SEARCH — a query through `hindsight-search-input` → the `recall` route →
 *      the stub's seeded memories render as `hindsight-memory-result` cards
 *      (escaped via the lit toolkit). The stub records a `recall` against bank
 *      `bobbit`.
 *   5. PERSISTENCE — a full reload + the deep link `#/ext/hindsight` rehydrates
 *      the SAME singleton panel: config (external URL + bank) and the connected
 *      status come back from the routes, proving config persisted server-side.
 *
 * Stub: the existing in-process `tests/e2e/hindsight-stub.mjs` backs
 * `status.healthy` + `recall` (no network, deterministic). The gateway shares the
 * in-process pack-store singleton, so the panel's `config` POST and the stub URL
 * line up exactly the way the API spec's `seedConfig` does — except here config
 * flows THROUGH the panel.
 *
 * SKIP-GUARD (design §7.4): the suite stays green before this branch's pack
 * panel/entrypoints + build entry merge. A static `DEPS_READY` gates the source
 * files; a runtime check additionally skips if the built-in band does not serve
 * the panel contribution in this environment (e.g. dist not rebuilt).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { apiFetch, base, readE2ETokenAsync, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PACK = "hindsight";
const PANEL_ID = "hindsight.panel";
const PACK_SRC = path.resolve(__dirname, "..", "..", "..", "market-packs", PACK);
const STUB_PATH = path.resolve(__dirname, "..", "hindsight-stub.mjs");

// Static skip-guard (design §7.4): mirror hindsight-external.spec.ts. The pack
// panel source + descriptor + the stub must be present before this suite means
// anything. A runtime guard (below) additionally skips if the built-in band does
// not SERVE the contribution (dist not rebuilt with the panel entry).
const DEPS_READY =
	fs.existsSync(path.join(PACK_SRC, "lib", "HindsightPanel.js")) &&
	fs.existsSync(path.join(PACK_SRC, "panels", "hindsight-memory.yaml")) &&
	fs.existsSync(STUB_PATH);

// The pack-store config key the `config` route persists under (mirrors
// src/shared.ts::CONFIG_KEY / providerConfigStoreKey("memory")).
const CONFIG_KEY = "provider-config:memory";

const describe = DEPS_READY ? test.describe : test.describe.skip;

// ── stub typing (the .mjs is untyped; describe its shape locally) ────────────
interface RecordedCall { method: string; path: string; bank?: string; namespace?: string }
interface HindsightStub {
	url: string;
	calls: RecordedCall[];
	setHealthy(ok: boolean): void;
	seedMemories(bank: string, mem: { text: string; id?: string; score?: number; tags?: string[] }[]): void;
	close(): Promise<void>;
}

async function startStub(): Promise<HindsightStub> {
	// Indirect specifier so the typechecker does not resolve the untyped .mjs.
	const mod = await import(STUB_PATH as string);
	const start = mod.startHindsightStub ?? mod.default;
	return start({ port: 0 }) as Promise<HindsightStub>;
}

interface PackContributionsMeta {
	packId: string;
	panels?: { id: string; title?: string }[];
	entrypoints?: Array<{ id: string; kind: string; routeId?: string; listName: string }>;
	routeNames?: string[];
}

async function listContributions(): Promise<PackContributionsMeta[]> {
	const res = await apiFetch("/api/ext/contributions");
	if (!res.ok) return [];
	return ((await res.json()).packs ?? []) as PackContributionsMeta[];
}

interface HindsightContribution {
	paletteEntrypointId: string;
	routeId: string;
}

/** Runtime readiness: the built-in band must serve the panel + both entrypoints +
 *  the config/status/recall routes, AND the panel module must be fetchable. Returns
 *  the discovered palette entrypoint id + deep-link routeId, or null when the
 *  contribution is unavailable in this environment (→ skip). */
async function resolveHindsightContribution(): Promise<HindsightContribution | null> {
	const meta = (await listContributions()).find((p) => p.packId === PACK);
	if (!meta) return null;
	if (!meta.panels?.some((p) => p.id === PANEL_ID)) return null;
	const palette = meta.entrypoints?.find((e) => e.kind === "session-menu");
	const route = meta.entrypoints?.find((e) => e.kind === "route" && !!e.routeId);
	if (!palette || !route?.routeId) return null;
	for (const r of ["config", "status", "recall"]) {
		if (!meta.routeNames?.includes(r)) return null;
	}
	// The lazy panel module must be servable (catches a dist that lacks the panel
	// build entry even though the source files exist on disk).
	const panelRes = await apiFetch(`/api/ext/packs/${PACK}/panels/${encodeURIComponent(PANEL_ID)}`);
	if (!panelRes.ok) return null;
	return { paletteEntrypointId: palette.id, routeId: route.routeId };
}

/** The compound launcher key `runLauncherEntrypoint` dispatches on
 *  (`packId NUL entrypointId`) — the SAME key the command palette uses per item. */
function launcherKey(entrypointId: string): string {
	return `${PACK}\u0000${entrypointId}`;
}

async function reconcile(page: Page): Promise<void> {
	await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.()).catch(() => { /* race */ });
}

const panel = (page: Page) => page.locator('[data-testid="hindsight-panel"]').first();
const statusBadge = (page: Page) => page.locator('[data-testid="hindsight-status-badge"]').first();

/** Reset the persisted Hindsight config in the shared in-process pack store so a
 *  prior (or failed) run never leaks the stub URL into a sibling test. */
async function resetHindsightConfig(): Promise<void> {
	try {
		const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
		await getPackStore().put(PACK, CONFIG_KEY, {});
	} catch { /* best-effort */ }
}

/** Force-enable the built-in DEFAULT-DISABLED Hindsight pack at server scope so its
 *  panel + entrypoints + routes are SERVED regardless of worker ordering. A fresh
 *  server resolves a default-disabled pack DORMANT (contributions absent), which
 *  would make every panel test skip; PUT all-enabled records the force-enable
 *  marker. The pack then sits ENABLED-but-unconfigured = dormant, the exact initial
 *  state these panel tests expect (they configure within each test). */
async function forceEnableHindsight(): Promise<void> {
	await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK, disabled: {} }),
	}).catch(() => { /* best-effort */ });
}

/** Return the built-in Hindsight pack to its DEFAULT-DISABLED baseline (no stored
 *  activation record, no force-enable marker) so the enabled state cannot LEAK to
 *  sibling spec files sharing the worker's in-process gateway + server-scope
 *  activation store. PUT every catalogue entity disabled WHILE UNCONFIGURED equals
 *  the pack's default, so the server clears the record + drops the marker. Call
 *  AFTER resetHindsightConfig() so the pack is unconfigured. */
async function resetHindsightActivation(): Promise<void> {
	try {
		const res = await apiFetch(`/api/marketplace/pack-activation?scope=server&packName=${PACK}`);
		if (!res.ok) return;
		const cat = ((await res.json()).catalogue ?? {}) as Record<string, unknown>;
		const arr = (k: string): string[] =>
			Array.isArray(cat[k])
				? (cat[k] as Array<{ listName?: string } | string>).map((e) => (typeof e === "string" ? e : e.listName ?? "")).filter(Boolean)
				: [];
		const disabled = {
			roles: arr("roles"), tools: arr("tools"), skills: arr("skills"), entrypoints: arr("entrypoints"),
			providers: arr("providers"), hooks: arr("hooks"), mcp: arr("mcp"), piExtensions: arr("piExtensions"),
			runtimes: arr("runtimes"), workflows: arr("workflows"),
		};
		await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK, disabled }),
		});
	} catch { /* best-effort */ }
}

describe.configure({ mode: "serial" });

describe("Hindsight pack — native config/status panel (built-in band)", () => {
	let stub: HindsightStub;

	test.beforeAll(async () => {
		// Force-enable the default-disabled built-in pack BEFORE readiness resolves so
		// the panel/entrypoints/routes are served deterministically (else every test
		// skips). The pack stays dormant (unconfigured) for the panel tests.
		await forceEnableHindsight();
		await resetHindsightConfig();
		stub = await startStub();
	});

	test.afterAll(async () => {
		await resetHindsightConfig();
		// Return the pack to default-disabled so the enabled state cannot leak to
		// sibling spec files sharing this worker's gateway.
		await resetHindsightActivation();
		if (stub) await stub.close().catch(() => { /* ignore */ });
	});

	test("open via palette → configure → status connected → search → persists across reload", async ({ page }) => {
		const contribution = await resolveHindsightContribution();
		test.skip(
			!contribution,
			"Hindsight pack panel contribution is not served in this environment (panel/entrypoints/routes not built or not merged)",
		);
		const { paletteEntrypointId, routeId } = contribution!;

		// Seed recall results on the stub for the search assertion.
		const SEEDED_MEMORY = "Risky rollouts should always go behind a feature flag.";
		stub.seedMemories("bobbit", [{ text: SEEDED_MEMORY, id: "mem-flag", score: 0.93 }]);

		// ── Step 1: OPEN via the command-palette launcher. ──
		await openApp(page);
		const sid = await createSessionViaUI(page);
		expect(sid, "a session must be selected").toBeTruthy();
		await waitForSessionStatus(sid, "idle").catch(() => { /* best-effort */ });
		await reconcile(page);

		// Run the palette launcher exactly as a command-palette click would
		// (runLauncherEntrypoint → openPackPanel; design §7.2 #1). Poll-drive the
		// reconcile + launch so a still-in-flight entrypoint registration settles.
		await expect.poll(async () => {
			await reconcile(page);
			await page.evaluate((key) => (window as any).__bobbitRunPackLauncher?.(key), launcherKey(paletteEntrypointId)).catch(() => { /* race */ });
			return panel(page).count();
		}, { timeout: 20_000 }).toBeGreaterThan(0);
		await expect(panel(page), "the Hindsight panel must mount in the active session").toBeVisible({ timeout: 15_000 });

		// Mode selector is present (tolerate either the task or design-doc testid).
		await expect(
			page.locator('[data-testid="hindsight-mode"], [data-testid="hindsight-mode-select"]').first(),
			"the deployment-mode selector must render",
		).toBeVisible({ timeout: 10_000 });

		// Dormant before any config (the mount-time status GET returns configured:false).
		await expect(statusBadge(page), "an unconfigured panel starts dormant").toHaveAttribute("data-state", "dormant", { timeout: 15_000 });

		// ── Step 2 + 3: CONFIGURE external URL + bank → Save → status connected. ──
		await page.locator('[data-testid="hindsight-external-url"]').fill(stub.url);
		const bankInput = page.locator('[data-testid="hindsight-bank"]');
		await bankInput.fill("bobbit");
		await page.locator('[data-testid="hindsight-save"]').click();

		// Save POSTs `config` then re-fetches `status`; the healthy stub flips the
		// badge to connected. Outcome-based (the route POST URL is shared by GET+POST).
		await expect(statusBadge(page), "a healthy configured Hindsight reports connected").toHaveAttribute(
			"data-state",
			"connected",
			{ timeout: 20_000 },
		);

		// Health is a read-only projection: unhealthy stub + Refresh → unreachable,
		// restore → connected again.
		stub.setHealthy(false);
		await page.locator('[data-testid="hindsight-refresh"]').click();
		await expect(statusBadge(page), "an unreachable external Hindsight reports unreachable").toHaveAttribute(
			"data-state",
			"unreachable",
			{ timeout: 20_000 },
		);
		stub.setHealthy(true);
		await page.locator('[data-testid="hindsight-refresh"]').click();
		await expect(statusBadge(page), "restored health flips back to connected").toHaveAttribute(
			"data-state",
			"connected",
			{ timeout: 20_000 },
		);

		// ── Step 4: SEARCH renders the seeded memory via the recall route. ──
		const recallBefore = stub.calls.filter((c) => /\/memories\/recall$/.test(c.path)).length;
		await page.locator('[data-testid="hindsight-search-input"]').fill("how do we roll out risky changes?");
		await page.locator('[data-testid="hindsight-search-submit"]').click();

		const result = page.locator('[data-testid="hindsight-memory-result"]').filter({ hasText: SEEDED_MEMORY }).first();
		await expect(result, "the seeded memory must render as a result card").toBeVisible({ timeout: 20_000 });

		// The recall actually hit the stub, scoped to bank `bobbit`.
		await expect.poll(() => {
			const recalls = stub.calls.filter((c) => /\/memories\/recall$/.test(c.path));
			return recalls.length > recallBefore && recalls.every((c) => c.bank === "bobbit");
		}, { timeout: 10_000 }).toBe(true);

		// ── Step 5: PERSISTENCE across reload via the deep link #/ext/<routeId>. ──
		const token = await readE2ETokenAsync();
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sid}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await reconcile(page);

		// Navigate the bare deep link → the singleton panel re-opens + rehydrates from
		// the routes. Poll-drive the reconcile so a cold-load registration settles.
		await expect.poll(async () => {
			await reconcile(page);
			await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${routeId}`);
			return panel(page).count();
		}, { timeout: 20_000 }).toBeGreaterThan(0);
		await expect(panel(page), "the deep link must re-open the singleton panel").toBeVisible({ timeout: 15_000 });

		// Config rehydrated from the server-persisted record (external URL is NOT a
		// secret, so it is echoed; bank likewise).
		await expect(page.locator('[data-testid="hindsight-external-url"]'), "external URL persisted server-side").toHaveValue(stub.url, { timeout: 15_000 });
		await expect(page.locator('[data-testid="hindsight-bank"]'), "bank persisted server-side").toHaveValue("bobbit", { timeout: 15_000 });

		// Status rehydrates to connected (the stub is still healthy).
		await expect(statusBadge(page), "status rehydrates to connected after reload").toHaveAttribute(
			"data-state",
			"connected",
			{ timeout: 20_000 },
		);
	});

	test("managed mode exposes a REAL runtime-logs affordance that fetches the logs endpoint", async ({ page }) => {
		const contribution = await resolveHindsightContribution();
		test.skip(
			!contribution,
			"Hindsight pack panel contribution is not served in this environment (panel/entrypoints/routes not built or not merged)",
		);
		const { paletteEntrypointId } = contribution!;

		await openApp(page);
		const sid = await createSessionViaUI(page);
		expect(sid, "a session must be selected").toBeTruthy();
		await waitForSessionStatus(sid, "idle").catch(() => { /* best-effort */ });
		await reconcile(page);

		await expect.poll(async () => {
			await reconcile(page);
			await page.evaluate((key) => (window as any).__bobbitRunPackLauncher?.(key), launcherKey(paletteEntrypointId)).catch(() => { /* race */ });
			return panel(page).count();
		}, { timeout: 20_000 }).toBeGreaterThan(0);
		await expect(panel(page)).toBeVisible({ timeout: 15_000 });

		// Switch to a MANAGED deployment mode + supply the LLM key so the runtime is
		// `configured`, then Save. The logs affordance is managed-only.
		await page.locator('[data-testid="hindsight-mode"]').selectOption("managed");
		await page.locator('[data-testid="hindsight-llm-api-key"]').fill("sk-test-managed");
		await page.locator('[data-testid="hindsight-save"]').click();

		// The logs affordance is a REAL button (not static text), shown for managed modes.
		const logsBtn = page.locator('[data-testid="hindsight-logs-button"]');
		await expect(logsBtn, "managed mode shows a real View-logs button").toBeVisible({ timeout: 20_000 });

		// Clicking it must FETCH the server runtime-logs endpoint (proving it is not
		// dead text) and reveal the inline logs view.
		const [logsReq] = await Promise.all([
			page.waitForRequest(/\/api\/pack-runtimes\/[^/]+\/logs(\?|$)/, { timeout: 20_000 }),
			logsBtn.click(),
		]);
		expect(logsReq.url(), "the logs button hits GET /api/pack-runtimes/:id/logs?tail=").toMatch(/tail=\d+/);
		await expect(
			page.locator('[data-testid="hindsight-logs-view"]'),
			"the inline runtime-logs view opens",
		).toBeVisible({ timeout: 15_000 });
		// Either real log content or a graceful error/note renders — never static text.
		await expect(
			page.locator('[data-testid="hindsight-logs-pre"], [data-testid="hindsight-logs-error"]').first(),
		).toBeVisible({ timeout: 15_000 });
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// UX POLISH — design docs/design/hindsight-ux-polish.md + ...-implementation.md
// (Partition E). Extends the panel coverage with the seven required scenarios that
// live on the panel surface: the stale-form refresh REGRESSION (B1/B2 + dirty +
// discard), Open Hindsight UI, the guided-setup defaults/explanations + connection
// smoke test, and managed-mode NO-AUTO-START + explicit Start + progress. Runtime
// is MOCKED via registerPackRuntimeSupervisorFactory (no Docker); external data is
// the in-process hindsight stub. See the marketplace spec for the row-level states.
// ─────────────────────────────────────────────────────────────────────────────

// AJ-baked UI dashboard URL example (distinct from the API/data-plane URL) — mirrors
// the panel's EX_UI_URL copy; used to prove "Open Hindsight UI" opens THIS, never a
// value fabricated from the API URL.
const EX_UI_URL = "http://localhost:19177/banks/hermes?view=data";

/** Field locators (the config form). */
const f = {
	externalUrl: (p: Page) => p.locator('[data-testid="hindsight-external-url"]'),
	uiUrl: (p: Page) => p.locator('[data-testid="hindsight-ui-url"]'),
	bank: (p: Page) => p.locator('[data-testid="hindsight-bank"]'),
	timeout: (p: Page) => p.locator('[data-testid="hindsight-timeout"]'),
	namespace: (p: Page) => p.locator('[data-testid="hindsight-namespace"]'),
	autoRetain: (p: Page) => p.locator('[data-testid="hindsight-auto-retain"]'),
};

/** Seed the persisted Hindsight config in the shared in-process pack store OUT OF
 *  BAND — exactly the way another session/agent (or the `config` route) would land a
 *  record after the panel mounted. This is the trigger for the stale-form regression:
 *  the form must re-hydrate from THIS on a Refresh, and Save must never clobber it. */
async function seedHindsightConfig(overrides: Record<string, unknown>): Promise<void> {
	const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
	await getPackStore().put(PACK, CONFIG_KEY, overrides);
}

/** Open the Hindsight panel in a fresh session via the command-palette launcher
 *  (the same chain a palette click drives), mirroring the suite above. Returns the
 *  discovered contribution so the caller can deep-link if needed. Skips when the
 *  built-in band does not serve the panel contribution in this environment. */
async function mountHindsightPanel(page: Page): Promise<HindsightContribution> {
	const contribution = await resolveHindsightContribution();
	test.skip(
		!contribution,
		"Hindsight pack panel contribution is not served in this environment (panel/entrypoints/routes not built or not merged)",
	);
	const { paletteEntrypointId } = contribution!;
	await openApp(page);
	const sid = await createSessionViaUI(page);
	expect(sid, "a session must be selected").toBeTruthy();
	await waitForSessionStatus(sid, "idle").catch(() => { /* best-effort */ });
	await reconcile(page);
	await expect.poll(async () => {
		await reconcile(page);
		await page.evaluate((key) => (window as any).__bobbitRunPackLauncher?.(key), launcherKey(paletteEntrypointId)).catch(() => { /* race */ });
		return panel(page).count();
	}, { timeout: 20_000 }).toBeGreaterThan(0);
	await expect(panel(page), "the Hindsight panel must mount in the active session").toBeVisible({ timeout: 15_000 });
	return contribution!;
}

// ── Mocked managed runtime supervisor (NO Docker). Mutable status so a test can
//    drive stopped→running; records every control call so we can assert the
//    no-auto-start invariant (mount/select/save NEVER call start). Mirrors the shape
//    exercised by tests/e2e/marketplace-runtime-activation.spec.ts. `ports: []` in the
//    capability summary keeps the route runtime-context unresolved, so the panel's
//    managed badge stays a deterministic "starting" (never flips to running off a
//    fabricated base URL). ──
interface SupCall { op: "start" | "stop" | "restart" | "down"; }
const supCalls: SupCall[] = [];
let managedRuntimeStatus: "stopped" | "starting" | "running" | "unhealthy" | "docker-unavailable" = "stopped";
function rtStatus(status: string) {
	return { id: "hindsight:hindsight", packId: PACK, packName: PACK, runtimeId: "hindsight", status, mode: "managed-postgres", composeProject: "bobbit-pack-hindsight-test" };
}
const fakeSupervisor = {
	async list() { return [rtStatus(managedRuntimeStatus)]; },
	async status() { return rtStatus(managedRuntimeStatus); },
	async start() { supCalls.push({ op: "start" }); managedRuntimeStatus = "running"; return rtStatus("running"); },
	async stop() { supCalls.push({ op: "stop" }); managedRuntimeStatus = "stopped"; return rtStatus("stopped"); },
	async restart() { supCalls.push({ op: "restart" }); managedRuntimeStatus = "running"; return rtStatus("running"); },
	async down() { supCalls.push({ op: "down" }); managedRuntimeStatus = "stopped"; return rtStatus("stopped"); },
	async logs() { return "managed-runtime log line\n"; },
	async capabilitySummary() {
		return { ...rtStatus(managedRuntimeStatus), startPolicy: "on-enable", services: ["api", "db"], images: ["hindsight/api", "postgres"], ports: [], volumePath: "~/.hindsight", trust: "local" };
	},
};

describe("Hindsight pack — UX polish (panel)", () => {
	let stub: HindsightStub;

	test.beforeAll(async () => {
		const mod = await import("../../../dist/server/server.js");
		mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor as never);
		// See the first describe: enable the default-disabled pack so its contributions
		// are served before per-test readiness resolution.
		await forceEnableHindsight();
		stub = await startStub();
	});

	test.afterAll(async () => {
		const mod = await import("../../../dist/server/server.js");
		mod.registerPackRuntimeSupervisorFactory(null);
		await resetHindsightConfig();
		await resetHindsightActivation();
		if (stub) await stub.close().catch(() => { /* ignore */ });
	});

	test.beforeEach(async () => {
		// Clean slate per test — the config store is shared across the worker.
		await resetHindsightConfig();
		supCalls.length = 0;
		managedRuntimeStatus = "stopped";
	});

	// ── Headline B1: Refresh re-hydrates the FORM (not just the status card) from the
	//    persisted config; a dirty edit survives Refresh; Discard reverts. ──
	test("stale-form B1: Refresh re-hydrates the form from the persisted config; dirty edits survive; Discard reverts", async ({ page }) => {
		await mountHindsightPanel(page);

		// Dormant first-run: the form shows the mount-time DEFAULTS.
		await expect(statusBadge(page), "unconfigured panel starts dormant").toHaveAttribute("data-state", "dormant", { timeout: 15_000 });
		await expect(f.externalUrl(page)).toHaveValue("");
		await expect(f.bank(page)).toHaveValue("bobbit");
		await expect(f.timeout(page)).toHaveValue("1500");

		// Another agent / the route lands a good config AFTER mount.
		await seedHindsightConfig({ externalUrl: stub.url, bank: "hermes", timeoutMs: 15000 });

		// B1 — Refresh re-hydrates BOTH config + status: the FORM now reflects the
		// persisted values (not the stale defaults), and the badge flips to connected.
		await page.locator('[data-testid="hindsight-refresh"]').click();
		await expect(f.externalUrl(page), "Refresh re-seeds the external URL from the persisted config").toHaveValue(stub.url, { timeout: 15_000 });
		await expect(f.bank(page), "Refresh re-seeds the bank").toHaveValue("hermes");
		await expect(f.timeout(page), "Refresh re-seeds the timeout").toHaveValue("15000");
		await expect(statusBadge(page), "a healthy external Hindsight is connected").toHaveAttribute("data-state", "connected", { timeout: 20_000 });

		// A DIRTY edit must NOT be clobbered by a subsequent Refresh ("unless the user
		// has unsaved edits"). The unsaved banner appears.
		await f.bank(page).fill("edited-bank");
		await expect(page.locator('[data-testid="hindsight-unsaved"]'), "a dirty draft shows the unsaved-changes banner").toBeVisible();
		await page.locator('[data-testid="hindsight-refresh"]').click();
		await expect(f.bank(page), "Refresh preserves the in-progress edit").toHaveValue("edited-bank");
		await expect(page.locator('[data-testid="hindsight-unsaved"]')).toBeVisible();

		// Discard reverts the draft to the persisted config and clears the banner.
		await page.locator('[data-testid="hindsight-discard"]').click();
		await expect(f.bank(page), "Discard reverts to the persisted bank").toHaveValue("hermes");
		await expect(page.locator('[data-testid="hindsight-unsaved"]')).toHaveCount(0);
	});

	// ── Headline B2: the exact observed reproduction — a panel that mounted dormant
	//    and was NEVER refreshed must not clobber a config that landed server-side. ──
	test("stale-form B2: Save from a never-refreshed dormant form does NOT clobber a server-side config", async ({ page }) => {
		await mountHindsightPanel(page);
		await expect(statusBadge(page)).toHaveAttribute("data-state", "dormant", { timeout: 15_000 });

		// Another agent configures Hindsight while the form still shows dormant defaults.
		await seedHindsightConfig({ externalUrl: stub.url, bank: "hermes", timeoutMs: 15000 });

		// Press Save WITHOUT refreshing. The fix re-reads the live config first and
		// diffs against it, so the empty/default draft sends nothing that overwrites the
		// good record. Pre-fix this clobbered it back to bobbit/empty/1500.
		await page.locator('[data-testid="hindsight-save"]').click();

		// The good config survives: status connects to the seeded external Hindsight and
		// the form re-seeds from the live config (bank hermes, not bobbit).
		await expect(statusBadge(page), "the seeded config is preserved → connected").toHaveAttribute("data-state", "connected", { timeout: 20_000 });
		await expect(f.bank(page), "Save did not clobber the bank").toHaveValue("hermes", { timeout: 15_000 });
		await expect(f.externalUrl(page), "Save did not clobber the external URL").toHaveValue(stub.url);
		await expect(f.timeout(page), "Save did not clobber the timeout").toHaveValue("15000");
	});

	// ── Save with a dirty edit sends ONLY the changed key — untouched keys survive. ──
	test("stale-form B2: a dirty Save sends only the changed key and preserves untouched keys", async ({ page }) => {
		await mountHindsightPanel(page);
		await seedHindsightConfig({ externalUrl: stub.url, bank: "hermes", timeoutMs: 15000 });
		await page.locator('[data-testid="hindsight-refresh"]').click();
		await expect(f.bank(page)).toHaveValue("hermes", { timeout: 15_000 });

		// Change ONLY the bank, then Save.
		await f.bank(page).fill("project-bank");
		await page.locator('[data-testid="hindsight-save"]').click();

		// The bank is updated; the untouched external URL + timeout are preserved (not
		// reset to defaults — proving Save diffs against the live config, not a stale base).
		await expect(f.bank(page)).toHaveValue("project-bank", { timeout: 15_000 });
		await expect(f.externalUrl(page), "untouched external URL preserved").toHaveValue(stub.url);
		await expect(f.timeout(page), "untouched timeout preserved").toHaveValue("15000");
		await expect(statusBadge(page)).toHaveAttribute("data-state", "connected", { timeout: 20_000 });
		await expect(page.locator('[data-testid="hindsight-unsaved"]'), "a successful Save clears the dirty banner").toHaveCount(0);
	});

	// ── Headline B2 (the high-severity clobber): a panel that mounted dormant and was
	//    NEVER refreshed, where the user edits ONLY ONE field (autoRetain), must send
	//    JUST that field on Save — the stale untouched defaults (externalUrl/bank/timeout)
	//    must NOT clobber a config that landed server-side after mount. This is the case
	//    a diff-everything Save would still break even though the pre-save refresh runs:
	//    the dirty draft keeps the stale defaults, so every untouched field would diff
	//    against the fresh config and POST. Only TOUCHED-field gating prevents it. ──
	test("stale-form B2: a dirty single-field edit (autoRetain) never clobbers untouched server-side config", async ({ page }) => {
		await mountHindsightPanel(page);
		await expect(statusBadge(page)).toHaveAttribute("data-state", "dormant", { timeout: 15_000 });

		// The form shows the mount-time DEFAULTS; autoRetain defaults ON.
		await expect(f.externalUrl(page)).toHaveValue("");
		await expect(f.bank(page)).toHaveValue("bobbit");
		await expect(f.timeout(page)).toHaveValue("1500");
		await expect(f.autoRetain(page)).toBeChecked();

		// Another agent / the route lands a GOOD config AFTER mount (autoRetain on).
		await seedHindsightConfig({ externalUrl: stub.url, bank: "hermes", timeoutMs: 15000, autoRetain: true });

		// Edit ONLY autoRetain (toggle off) WITHOUT refreshing, then Save. The form still
		// holds the stale dormant defaults for every other field.
		await f.autoRetain(page).uncheck();
		await expect(page.locator('[data-testid="hindsight-unsaved"]'), "the single-field edit marks the draft dirty").toBeVisible();
		await page.locator('[data-testid="hindsight-save"]').click();

		// The good config SURVIVES: status connects to the seeded external Hindsight and the
		// untouched fields are preserved — only autoRetain changed (the field the user edited).
		await expect(statusBadge(page), "the seeded config is preserved → connected").toHaveAttribute("data-state", "connected", { timeout: 20_000 });
		await expect(f.externalUrl(page), "Save did not clobber the external URL").toHaveValue(stub.url, { timeout: 15_000 });
		await expect(f.bank(page), "Save did not clobber the bank").toHaveValue("hermes");
		await expect(f.timeout(page), "Save did not clobber the timeout").toHaveValue("15000");
		await expect(f.autoRetain(page), "the one edited field (autoRetain) is changed").not.toBeChecked();
		await expect(page.locator('[data-testid="hindsight-unsaved"]'), "a successful Save clears the dirty banner").toHaveCount(0);
	});

	// ── Open Hindsight UI — distinct from the API URL; link present only with a uiUrl. ──
	test("Open Hindsight UI: the link appears only when a UI URL is configured, with the exact href", async ({ page }) => {
		await mountHindsightPanel(page);

		// No UI URL configured → no Open-Hindsight-UI link.
		await expect(page.locator('[data-testid="hindsight-open-ui"]'), "no UI URL ⇒ no Open-UI link").toHaveCount(0);

		// Configure the API URL (data plane) AND a DISTINCT dashboard UI URL, then Save.
		await f.externalUrl(page).fill(stub.url);
		await f.uiUrl(page).fill(EX_UI_URL);
		await page.locator('[data-testid="hindsight-save"]').click();
		await expect(statusBadge(page)).toHaveAttribute("data-state", "connected", { timeout: 20_000 });

		const link = page.locator('[data-testid="hindsight-open-ui"]');
		await expect(link, "a configured UI URL surfaces the Open-Hindsight-UI link").toBeVisible({ timeout: 15_000 });
		await expect(link, "the link opens the UI URL verbatim (never fabricated from the API URL)").toHaveAttribute("href", EX_UI_URL);
		await expect(link).toHaveAttribute("target", "_blank");
		// The API URL and the UI URL are DISTINCT — the link is not the data-plane URL.
		expect(EX_UI_URL).not.toBe(stub.url);
	});

	// ── Guided setup: first-run shows the chooser + recommended-defaults explainer +
	//    ownership matrix; the connection smoke test reaches ok against a healthy stub. ──
	test("guided setup: first-run shows the chooser, defaults explainer + ownership matrix; the smoke test reaches ok", async ({ page }) => {
		await mountHindsightPanel(page);

		// First-run (dormant) auto-opens the guided setup with all three explainers.
		await expect(page.locator('[data-testid="hindsight-setup"]'), "first-run shows the guided setup").toBeVisible({ timeout: 15_000 });
		await expect(page.locator('[data-testid="hindsight-defaults-explainer"]'), "recommended-defaults explainer is shown").toBeVisible();
		await expect(page.locator('[data-testid="hindsight-ownership"]'), "the who-manages-what matrix is shown").toBeVisible();
		// The deployment chooser offers the four documented deployments incl. Hermes-local.
		await expect(page.locator('[data-testid="hindsight-deploy-external"]')).toBeVisible();
		await expect(page.locator('[data-testid="hindsight-deploy-hermes"]')).toBeVisible();
		await expect(page.locator('[data-testid="hindsight-deploy-managed"]')).toBeVisible();

		// Seed a healthy external config + a recallable memory so the smoke test passes,
		// then run the connection + recall smoke test from the setup card.
		await seedHindsightConfig({ externalUrl: stub.url, bank: "bobbit" });
		stub.seedMemories("bobbit", [{ text: "setup smoke probe", id: "smoke-1", score: 0.9 }]);

		await page.locator('[data-testid="hindsight-setup-test"]').click();
		const progress = page.locator('[data-testid="hindsight-setup-progress"]');
		await expect(progress, "the smoke-test renders a per-step progress list").toBeVisible({ timeout: 15_000 });
		// Both steps (connection health probe + recall smoke) reach ok against the stub.
		await expect.poll(async () => progress.locator('.hs-progress-row[data-state="ok"]').count(), { timeout: 20_000 }).toBe(2);
		await expect(progress.locator('.hs-progress-row[data-state="fail"]')).toHaveCount(0);
	});

	// ── Managed mode: NO auto-start. Selecting managed + Save persists config ONLY;
	//    Docker starts solely from the explicit, consent-gated Start button. ──
	test("managed mode: select + Save never starts Docker; explicit Start fires exactly one /start and shows progress", async ({ page }) => {
		await mountHindsightPanel(page);

		// Record EVERY runtime /start request the page issues (the no-auto-start probe).
		const startRequests: string[] = [];
		page.on("request", (r) => {
			if (/\/api\/pack-runtimes\/[^/]+\/start(\?|$)/.test(r.url())) startRequests.push(r.url());
		});

		// Select managed mode + provide the required LLM key, then Save (config ONLY).
		await page.locator('[data-testid="hindsight-mode"]').selectOption("managed");
		await page.locator('[data-testid="hindsight-llm-api-key"]').fill("sk-managed-test");
		await page.locator('[data-testid="hindsight-save"]').click();

		// The managed control card appears with an explicit Start button; the badge is
		// Stopped (configured, not running). Crucially: NOTHING started Docker.
		await expect(page.locator('[data-testid="hindsight-managed-card"]'), "managed mode shows the managed control card").toBeVisible({ timeout: 15_000 });
		// The badge reaching "stopped" proves Save's config-POST + the follow-up status
		// read both completed — so any (buggy) auto-start would already have fired.
		await expect(statusBadge(page), "managed + configured but not started ⇒ stopped").toHaveAttribute("data-state", "stopped", { timeout: 20_000 });
		expect(startRequests, "select + Save must NOT start Docker (no-auto-start invariant)").toHaveLength(0);
		expect(supCalls.filter((c) => c.op === "start"), "the supervisor.start must not be called by Save").toHaveLength(0);

		// Start is gated behind the consent acknowledgement.
		const startBtn = page.locator('[data-testid="hindsight-start-runtime"]');
		await expect(startBtn, "Start is disabled until consent is acknowledged").toBeDisabled();
		await page.locator('[data-testid="hindsight-managed-consent-ack"]').check();
		await expect(startBtn, "Start enables once required inputs + consent are present").toBeEnabled();

		// The explicit Start click is the ONLY Docker-starting path → exactly one /start.
		const [startReq] = await Promise.all([
			page.waitForRequest(/\/api\/pack-runtimes\/[^/]+\/start(\?|$)/, { timeout: 20_000 }),
			startBtn.click(),
		]);
		expect(startReq.url()).toMatch(/\/api\/pack-runtimes\/[^/]+\/start/);

		// Progress renders and the badge advances to Starting (driven by the explicit
		// start gesture + mocked runtime; never auto-resolved off a fabricated base URL).
		await expect(page.locator('[data-testid="hindsight-runtime-progress"]'), "the runtime progress list renders after Start").toBeVisible({ timeout: 15_000 });
		await expect(statusBadge(page), "the badge advances to starting after the explicit Start").toHaveAttribute("data-state", "starting", { timeout: 15_000 });

		// Exactly ONE start request total (no duplicate / retry storms). The badge
		// reaching "starting" gates on the start fetch + the follow-up status read, so
		// the request has already been observed by the listener.
		expect(startRequests, "exactly one explicit /start request").toHaveLength(1);
		expect(supCalls.filter((c) => c.op === "start"), "the supervisor.start fired exactly once").toHaveLength(1);
	});

	// ── Managed Start must use the PERSISTED config, never the unsaved draft. A user
	//    who switches external→managed and types an LLM key but has NOT saved must see
	//    Start disabled (with a Save-first hint) — an enabled Start there would dial the
	//    stale persisted (external) server config. ──
	test("managed Start stays disabled (Save-first) while the draft has unsaved edits", async ({ page }) => {
		await mountHindsightPanel(page);

		// Start from a configured, connected EXTERNAL deployment.
		await seedHindsightConfig({ externalUrl: stub.url, bank: "bobbit" });
		await page.locator('[data-testid="hindsight-refresh"]').click();
		await expect(statusBadge(page)).toHaveAttribute("data-state", "connected", { timeout: 20_000 });

		// Record any runtime /start the page issues — there must be NONE while disabled.
		const startRequests: string[] = [];
		page.on("request", (r) => {
			if (/\/api\/pack-runtimes\/[^/]+\/start(\?|$)/.test(r.url())) startRequests.push(r.url());
		});

		// Switch to managed + type an LLM key, but DON'T Save. Acknowledge consent so the
		// ONLY thing gating Start is the unsaved-edits guard.
		await page.locator('[data-testid="hindsight-mode"]').selectOption("managed");
		await page.locator('[data-testid="hindsight-llm-api-key"]').fill("sk-unsaved-managed");
		await expect(page.locator('[data-testid="hindsight-managed-card"]')).toBeVisible({ timeout: 15_000 });
		await page.locator('[data-testid="hindsight-managed-consent-ack"]').check();

		// Start MUST be disabled (persisted config is still external — no llmApiKeySet)
		// and a Save-first hint is shown instead.
		const startBtn = page.locator('[data-testid="hindsight-start-runtime"]');
		await expect(startBtn, "unsaved edits ⇒ Start disabled (would otherwise dial stale persisted config)").toBeDisabled();
		await expect(page.locator('[data-testid="hindsight-managed-save-first"]'), "a Save-first hint is shown while dirty").toBeVisible();

		// Saving persists the managed config (mode + llmApiKey); Start then enables
		// because the gate now reads a real persisted managed config — not the draft.
		await page.locator('[data-testid="hindsight-save"]').click();
		await expect(page.locator('[data-testid="hindsight-unsaved"]'), "Save clears the dirty banner").toHaveCount(0, { timeout: 15_000 });
		await expect(startBtn, "once saved + consent acked, Start enables").toBeEnabled({ timeout: 15_000 });
		await expect(page.locator('[data-testid="hindsight-managed-save-first"]'), "the Save-first hint clears once saved").toHaveCount(0);
		expect(startRequests, "no /start was ever issued while the gate was disabled").toHaveLength(0);
		expect(supCalls.filter((c) => c.op === "start"), "the supervisor.start was never called by the unsaved gate").toHaveLength(0);
	});

	// ── Save fail-fast: if the pre-save freshness GET fails, the Save must abort with a
	//    visible error and NEVER POST a body diffed against a stale snapshot. ──
	test("Save aborts with a visible error when the pre-save config refresh fails (no stale POST)", async ({ page }) => {
		await mountHindsightPanel(page);
		await expect(statusBadge(page)).toHaveAttribute("data-state", "dormant", { timeout: 15_000 });

		// Make a dirty edit so there is something to (attempt to) save.
		await f.bank(page).fill("attempted-bank");
		await expect(page.locator('[data-testid="hindsight-unsaved"]')).toBeVisible();

		// Fail ONLY the pre-save config GET; record any config POST (there must be none).
		const configPosts: string[] = [];
		await page.route("**/api/ext/route/config", async (route) => {
			let method = "";
			try { method = JSON.parse(route.request().postData() || "{}")?.init?.method || ""; } catch { /* ignore */ }
			if (String(method).toUpperCase() === "GET") {
				await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
				return;
			}
			configPosts.push(route.request().url());
			await route.continue();
		});

		await page.locator('[data-testid="hindsight-save"]').click();

		// A visible save error appears and the save was aborted BEFORE any POST.
		const err = page.locator('[data-testid="hindsight-config-error"]');
		await expect(err, "a failed pre-save refresh surfaces a visible save error").toBeVisible({ timeout: 15_000 });
		await expect(err).toContainText(/verify the current configuration/i);
		expect(configPosts, "no config POST is sent when the freshness refresh fails").toHaveLength(0);

		// The dirty edit is preserved so the user can retry once connectivity returns.
		await expect(f.bank(page), "the unsaved edit is preserved after the aborted save").toHaveValue("attempted-bank");
		await page.unroute("**/api/ext/route/config");
	});
});
