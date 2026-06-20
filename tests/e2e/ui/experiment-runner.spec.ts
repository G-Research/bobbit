/**
 * Browser E2E — the experiment-runner FIRST-PARTY BUILT-IN pack PANEL +
 * entrypoints (design docs/design/experiment-runner-panel-ux.md §12). The pack
 * ships as a built-in (FIRST_PARTY_PACKS in scripts/copy-builtin-packs.mjs,
 * alongside pr-walkthrough/hindsight) BUT — unlike the others — it ships
 * present-but-DISABLED by default (opt-in): the server boot seed
 * (src/server/agent/builtin-pack-defaults.ts) writes a server-scope
 * pack_activation entry disabling all of its entrypoints, so its launchers +
 * the #/ext/experiment-runner deep-link are absent until the user flips the
 * Market "Built-in" toggle on. Enabling clears the DisabledRefs; a durable
 * marker keeps it enabled across restarts.
 *
 * Coverage:
 *   0. OPT-IN DEFAULT — the pack is PRESENT (in /api/marketplace/installed flagged
 *      builtin:true) but DISABLED by the boot seed: GET pack-activation shows the
 *      entrypoints disabled, /api/ext/contributions exposes 0 entrypoints, and the
 *      deep-link resolves to the "feature unavailable" empty state (no panel).
 *   1. ENABLE — flipping the Market Built-in toggle on (PUT pack-activation, server
 *      scope, cleared disabled refs) restores the panel + the 15 routes + the 3
 *      entrypoints; the deep-link opens the panel at MODE-SELECT defaulting to A/B
 *      (autoresearch carries the opt-in warning eyebrow).
 *   2. A/B VALIDATION — identical variants + zero budget block launch; making them
 *      distinct + setting a per-run budget enables it; the projection strip shows
 *      the run count + bounded cost.
 *   3. AUTORESEARCH GUARDRAILS — switching to autoresearch shows the danger banner;
 *      launch stays blocked until ≥1 cap, ≥1 stop, and the explicit ack are set;
 *      the draft persists across a reload; a fully-capped launch advances the loop
 *      beyond iteration 0.
 *   4. DASHBOARD — a seeded experiment renders the comparison; editing the
 *      dashboard spec adds a widget that re-renders from the stored outcomes (no
 *      re-run); toggling a metric re-renders.
 *   5. DISABLE / RE-ENABLE + NON-REMOVABLE — toggling the pack's entrypoints off in
 *      the Market "Built-in" group removes the launcher + the #/ext/experiment-runner
 *      deep-link (which then shows the empty state); toggling back on restores the
 *      panel; the state survives a reload; the built-in pack cannot be uninstalled
 *      (DELETE /installed → 403).
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, base, readE2ETokenAsync } from "../e2e-setup.js";
import { openApp, createSessionViaUI, navigateToHash } from "./ui-helpers.js";

test.describe.configure({ mode: "serial" });

const PACK = "experiment-runner";
const PANEL_ID = "experiment-runner.panel";
const ROUTE_ID = "experiment-runner";
const CANONICAL_ROUTES = [
	"defineExperiment", "projectCost", "launch", "poll", "collect", "aggregate",
	"iterate", "listExperiments", "getExperiment", "saveMetrics", "saveDashboard",
	"report", "listMetrics", "listWidgets", "cancel",
];
const ENTRYPOINT_LIST_NAMES = ["experiment-runner-open", "experiment-runner-palette", "experiment-runner-route"];
// The session-menu LAUNCHER ("New experiment") — its listName is the entrypoint
// file basename; the activation toggle is keyed by listName.
const SESSION_MENU_LIST_NAME = "experiment-runner-palette";
const SESSION_MENU_LABEL = "New experiment";

const tid = (id: string) => `[data-testid="${id}"]`;

interface PackContributionsMeta {
	packId: string;
	panels: { id: string }[];
	entrypoints: Array<{ id: string; kind: string; routeId?: string; listName: string; label?: string }>;
	routeNames?: string[];
}

async function listContributions(): Promise<PackContributionsMeta[]> {
	const res = await apiFetch("/api/ext/contributions");
	expect(res.ok).toBe(true);
	return (await res.json()).packs as PackContributionsMeta[];
}

async function listInstalled(): Promise<Array<{ packName: string; scope: string; builtin?: boolean }>> {
	const res = await apiFetch("/api/marketplace/installed");
	expect(res.ok).toBe(true);
	return (await res.json()).installed as Array<{ packName: string; scope: string; builtin?: boolean }>;
}

async function getActivation(): Promise<{ disabled?: { entrypoints?: string[] } }> {
	const res = await apiFetch(`/api/marketplace/pack-activation?scope=server&packName=${PACK}`);
	expect(res.ok).toBe(true);
	return (await res.json()) as { disabled?: { entrypoints?: string[] } };
}

/** ENABLE the opt-in built-in: clear its DisabledRefs (the Market "Built-in"
 *  toggle path). Mirrors marketplace-page.ts's enable payload. */
async function enablePack(): Promise<void> {
	await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK, disabled: { roles: [], tools: [], skills: [], entrypoints: [] } }),
	});
}

/** DISABLE the pack: disable all of its entrypoints (matches the boot-seed shape
 *  and the user toggling every entrypoint off). */
async function disablePack(): Promise<void> {
	await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK, disabled: { roles: [], tools: [], skills: [], entrypoints: [...ENTRYPOINT_LIST_NAMES] } }),
	});
}

/** Open the app, create a session, and force a pack-contribution reconcile so the
 *  built-in panel + entrypoints register without a reload. */
async function openWithPack(page: import("@playwright/test").Page): Promise<void> {
	await page.setViewportSize({ width: 1400, height: 1000 });
	await openApp(page);
	await createSessionViaUI(page);
	await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers());
}

/** Navigate the experiment-runner deep-link and wait for the panel to mount. */
async function openPanelDeepLink(page: import("@playwright/test").Page, query = ""): Promise<void> {
	const hash = `#/ext/${ROUTE_ID}${query}`;
	await page.evaluate((h) => { window.location.hash = h; }, hash);
	await expect(page.locator(tid("experiment-runner-panel-root")).first()).toBeVisible({ timeout: 20_000 });
}

// Each test restores the seeded opt-in default (disabled) on the way OUT, so the
// "ships disabled by default" assertion is deterministic even on a serial retry
// (the worker-scoped gateway — and its persisted server-scope activation — are
// reused across retries). Functional tests ENABLE the pack at their top.
test.afterEach(async () => {
	await disablePack().catch(() => {});
});

test("ships present-but-disabled by default (opt-in); deep-link shows the unavailable empty state", async ({ page }) => {
	// The boot seed (src/server/agent/builtin-pack-defaults.ts) disables every
	// entrypoint at server scope, so the pack is PRESENT but OFF until enabled.
	const activation = await getActivation();
	expect(activation.disabled?.entrypoints ?? [], "the boot seed must disable all 3 entrypoints by default").toEqual(
		expect.arrayContaining(ENTRYPOINT_LIST_NAMES),
	);

	// It still appears in the Installed list flagged builtin:true (present, not removed).
	const builtinRow = (await listInstalled()).find((p) => p.packName === PACK && p.builtin);
	expect(builtinRow, "the built-in pack must appear in the Installed list flagged builtin").toBeTruthy();
	expect(builtinRow?.scope).toBe("server");

	// No entrypoints are contributed while disabled (the panel + routes survive —
	// they are not entrypoints — but the launchers + deep-link are gone).
	const meta = (await listContributions()).find((p) => p.packId === PACK);
	expect(meta, "the built-in pack metadata must still resolve while disabled").toBeTruthy();
	expect(meta?.entrypoints?.length ?? 0, "disabled-by-default ⇒ 0 entrypoints contributed").toBe(0);

	// The deep-link resolves to the dismissible "feature unavailable" empty state.
	await openWithPack(page);
	await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${ROUTE_ID}`);
	const unavailable = page.locator('[data-testid="ext-route-unavailable"]');
	await expect(unavailable).toBeVisible({ timeout: 15_000 });
	await expect(unavailable).toContainText("unavailable");
	await expect(page.locator(tid("experiment-runner-panel-root"))).toHaveCount(0);
});

test("enable via the Market Built-in toggle: built-in band contributes panel + 15 routes + 3 entrypoints; deep-link opens mode-select defaulting to A/B", async ({ page }) => {
	// ENABLE — flip the Market Built-in toggle on (clear DisabledRefs).
	await enablePack();
	const meta = (await listContributions()).find((p) => p.packId === PACK);
	expect(meta, "the built-in experiment-runner pack must be resolved with NO install").toBeTruthy();
	expect(meta?.panels?.some((p) => p.id === PANEL_ID)).toBe(true);
	expect(meta?.routeNames, "all 15 canonical routes must be contributed").toEqual(expect.arrayContaining(CANONICAL_ROUTES));
	expect(meta?.entrypoints?.map((e) => e.id) ?? []).toEqual(
		expect.arrayContaining(["experiment-runner.open", "experiment-runner.palette", "experiment-runner.route"]),
	);
	expect((meta?.entrypoints ?? []).map((e) => e.listName)).toEqual(expect.arrayContaining(ENTRYPOINT_LIST_NAMES));
	expect(meta?.entrypoints?.some((e) => e.kind === "route" && e.routeId === ROUTE_ID)).toBe(true);
	expect(meta?.entrypoints?.some((e) => e.kind === "session-menu" && e.label === SESSION_MENU_LABEL)).toBe(true);

	// The built-in pack appears in the Installed list flagged builtin:true.
	const builtinRow = (await listInstalled()).find((p) => p.packName === PACK && p.builtin);
	expect(builtinRow, "the built-in pack must appear in the Installed list flagged builtin").toBeTruthy();
	expect(builtinRow?.scope).toBe("server");

	await openWithPack(page);
	await openPanelDeepLink(page);

	const root = page.locator(tid("experiment-runner-panel-root")).first();
	await expect(root).toHaveAttribute("data-view", "mode-select");
	await expect(page.locator(tid("experiment-runner-view-mode-select"))).toBeVisible();
	const ab = page.locator(tid("experiment-runner-mode-ab"));
	const auto = page.locator(tid("experiment-runner-mode-autoresearch"));
	await expect(ab).toBeVisible();
	await expect(ab).toContainText(/Recommended/i);
	await expect(auto).toContainText(/opt-in/i);

	// Picking A/B advances to the define form in A/B mode.
	await ab.click();
	await expect(page.locator(tid("experiment-runner-view-define"))).toBeVisible();
	await expect(root).toHaveAttribute("data-mode", "ab");
});

test("A/B define: identical variants + missing budget block launch; distinct + budget enables it", async ({ page }) => {
	await enablePack();
	await openWithPack(page);
	await openPanelDeepLink(page);
	await page.locator(tid("experiment-runner-mode-ab")).click();
	await expect(page.locator(tid("experiment-runner-view-define"))).toBeVisible();

	await page.locator(tid("experiment-runner-name")).fill("sweep");
	await page.locator(tid("experiment-runner-body")).fill("echo '{\"metric\":\"score\",\"value\":1}'");

	const review = page.locator(tid("experiment-runner-review-launch"));
	// No per-run budget yet → cost shows the prompt and launch is disabled.
	await expect(page.locator(tid("experiment-runner-cost"))).toContainText(/set a per-run budget/i);
	await expect(review).toBeDisabled();

	// Make the two default variants identical (clear both metadata) → identical-variant error.
	await expect(page.locator(tid("experiment-runner-error"))).toContainText(/identical/i);

	// Distinguish variant-b via a metadata treatment, then set a per-run budget.
	const secondVariant = page.locator(tid("experiment-runner-variant-row")).nth(1);
	const kv = secondVariant.locator(tid("experiment-runner-variant-metadata"));
	await kv.locator("input.exp-kv-key").first().fill("temperature");
	await kv.locator("input.exp-kv-val").first().fill("0.9");
	await page.locator(tid("experiment-runner-per-run-budget")).fill("0.8");

	await expect(page.locator(tid("experiment-runner-run-count"))).toContainText("2 variants × 3 repeats = 6 runs");
	await expect(page.locator(tid("experiment-runner-cost"))).toContainText(/≤ \$4\.80/);
	await expect(review).toBeEnabled();

	// Confirm view shows the bounded fan-out plan.
	await review.click();
	await expect(page.locator(tid("experiment-runner-view-confirm"))).toBeVisible();
	await expect(page.locator(tid("experiment-runner-launch"))).toContainText(/Launch 6 runs/);
});

test("autoresearch refuses to start uncapped; draft persists across reload", async ({ page }) => {
	await enablePack();
	await openWithPack(page);
	await openPanelDeepLink(page);

	// Pick autoresearch → danger banner + define form.
	await page.locator(tid("experiment-runner-mode-autoresearch")).click();
	await expect(page.locator(tid("experiment-runner-autoresearch-banner"))).toBeVisible();

	await page.locator(tid("experiment-runner-name")).fill("optimize");
	await page.locator(tid("experiment-runner-body")).fill("echo '{\"metric\":\"objective.value\",\"value\":0.5}'");
	await page.locator(tid("experiment-runner-per-iter-budget")).fill("2");

	const review = page.locator(tid("experiment-runner-review-launch"));
	const checklist = page.locator(tid("experiment-runner-guardrail-checklist"));

	// No cap yet → checklist demands a hard cap; launch disabled.
	await expect(checklist).toContainText(/hard cap/i);
	await expect(review).toBeDisabled();

	// Add a max-iterations cap → checklist now demands a stop condition.
	await page.locator(tid("experiment-runner-cap-max-iterations")).fill("10");
	await expect(checklist).toContainText(/stop condition/i);
	await expect(review).toBeDisabled();

	// Add a plateau stop → still blocked until the danger ack is ticked.
	await page.locator(tid("experiment-runner-stop-plateau")).fill("3");
	await expect(review).toBeDisabled();
	await page.locator(tid("experiment-runner-confirm-ack")).check();
	await expect(review).toBeEnabled();

	// Reload → the autoresearch draft rehydrates from the pack store.
	const token = await readE2ETokenAsync();
	const sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
	await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sid}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
	await openPanelDeepLink(page);
	await expect(page.locator(tid("experiment-runner-panel-root")).first()).toHaveAttribute("data-mode", "autoresearch");
	await expect(page.locator(tid("experiment-runner-name"))).toHaveValue("optimize");
	await expect(page.locator(tid("experiment-runner-cap-max-iterations"))).toHaveValue("10");
});

test("autoresearch launches successfully via iterate (not the A/B-only launch route) and lands on the dashboard", async ({ page }) => {
	// Regression for panel doLaunch fix #1: autoresearch used to call the A/B-only
	// `launch` route, which returns LAUNCH_AB_ONLY, surfaced as a launch error and
	// never navigated. The panel must branch to `iterate` and reach the dashboard.
	await enablePack();
	await openWithPack(page);
	await openPanelDeepLink(page);

	await page.locator(tid("experiment-runner-mode-autoresearch")).click();
	await expect(page.locator(tid("experiment-runner-autoresearch-banner"))).toBeVisible();

	// Fill a fully-capped, stop-conditioned, acknowledged autoresearch definition.
	await page.locator(tid("experiment-runner-name")).fill("optimize-launch");
	await page.locator(tid("experiment-runner-body")).fill("echo '{\"metric\":\"objective.value\",\"value\":0.5}'");
	await page.locator(tid("experiment-runner-per-iter-budget")).fill("2");
	await page.locator(tid("experiment-runner-cap-max-iterations")).fill("3");
	await page.locator(tid("experiment-runner-stop-plateau")).fill("2");
	await page.locator(tid("experiment-runner-confirm-ack")).check();

	const review = page.locator(tid("experiment-runner-review-launch"));
	await expect(review).toBeEnabled();
	await review.click();

	// Confirm view → launch.
	await expect(page.locator(tid("experiment-runner-view-confirm"))).toBeVisible();
	const launch = page.locator(tid("experiment-runner-launch"));
	await expect(launch).toContainText(/Launch loop/i);
	await launch.click();

	// The panel navigates to the dashboard (it did NOT stall on a launch error).
	await expect(page.locator(tid("experiment-runner-view-dashboard"))).toBeVisible({ timeout: 20_000 });
	// No A/B-only error surfaced — the autoresearch branch went through `iterate`.
	const launchError = page.locator(tid("experiment-runner-launch-error"));
	await expect(launchError).toHaveCount(0);
});

test("autoresearch dashboard reflects a loop that advanced beyond iteration 0 (≥2 ledger entries + stop reason)", async ({ page }) => {
	// Regression for fix #1: the autoresearch loop must continue past the first
	// candidate (a prior terminal-state bug flipped the experiment to "done" after
	// iteration 0). The dashboard must surface a MULTI-iteration ledger and the
	// deterministic stop — not just a single iteration-0 row. Seed the pack store
	// directly (same in-process pack-store singleton the gateway serves).
	const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
	const experimentId = "seed-ar-1";
	const def = {
		experimentId, title: "seeded optimize", mode: "autoresearch",
		runnable: { kind: "agent", spec: "optimize the thing" },
		objective: { metricId: "objective.value", direction: "max" },
		caps: { maxIterations: 10 }, stop: { plateauK: 2 }, perRunBudget: 1,
		metrics: [{ metricId: "objective.value", primary: true }],
	};
	// A candidate run per iteration: improves (1→2) then plateaus (2, 2).
	const mkRun = (iteration: number, objective: number, decision: "accepted" | "rejected") => ({
		experimentId, runId: `iter-${iteration}`, armId: `iter-${iteration}`, iteration,
		runKey: `${experimentId}:iter-${iteration}`, status: "collected",
		completionBar: "passed", verified: true,
		metrics: { "objective.value": objective }, cost: { costUsd: 0.1 },
		candidate: { decision },
	});
	const ledger = [
		{ iteration: 0, runId: "iter-0", candidate: {}, objective: 1, decision: "accepted", bestObjectiveAfter: 1, reason: "improved & passed" },
		{ iteration: 1, runId: "iter-1", candidate: {}, objective: 2, decision: "accepted", bestObjectiveAfter: 2, reason: "improved & passed" },
		{ iteration: 2, runId: "iter-2", candidate: {}, objective: 2, decision: "rejected", bestObjectiveAfter: 2, reason: "regressed" },
		{ iteration: 3, runId: "iter-3", candidate: {}, objective: 2, decision: "rejected", bestObjectiveAfter: 2, reason: "regressed" },
	];
	const store = getPackStore();
	await store.put(PACK, `exp/${experimentId}`, def);
	// Stopped (NOT running) so the dashboard renders deterministically without
	// driving a real spawn through the loop.
	await store.put(PACK, `exp/${experimentId}/state`, { status: "done", stopped: { reason: "plateau over K=2" } });
	await store.put(PACK, `exp/${experimentId}/metrics`, def.metrics);
	await store.put(PACK, `exp/${experimentId}/ledger`, ledger);
	for (const r of [mkRun(0, 1, "accepted"), mkRun(1, 2, "accepted"), mkRun(2, 2, "rejected"), mkRun(3, 2, "rejected")]) {
		await store.put(PACK, `exp/${experimentId}/run/${r.runId}`, r);
	}
	await store.put(PACK, "index/experiments", [experimentId]);

	await enablePack();
	await openWithPack(page);
	await openPanelDeepLink(page, `?experimentId=${experimentId}&view=dashboard`);

	await expect(page.locator(tid("experiment-runner-view-dashboard"))).toBeVisible({ timeout: 20_000 });
	await expect(page.locator(tid("experiment-runner-dashboard-body"))).toBeVisible({ timeout: 20_000 });

	// The ledger widget shows MULTIPLE iterations (the loop advanced beyond #0).
	const ledgerRows = page.locator(`${tid("experiment-runner-widget")}[data-widget-type="ledger-table"] tbody tr`);
	await expect.poll(async () => ledgerRows.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

	// The deterministic stop is surfaced on the objective curve.
	const body = page.locator(tid("experiment-runner-dashboard-body"));
	await expect(body).toContainText(/Stopped:/i);
	await expect(body).toContainText(/plateau/i);
});

test("dashboard renders a seeded A/B experiment; editing the spec re-renders without a re-run; toggling a metric re-renders", async ({ page }) => {
	// Seed the pack registry directly (same in-process pack-store singleton the
	// gateway serves) so the dashboard has outcomes to render without a real run.
	const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
	const experimentId = "seed-ab-1";
	const def = {
		experimentId, title: "seeded sweep", mode: "ab",
		runnable: { kind: "command", body: "echo 1" },
		variants: [
			{ armId: "baseline", label: "baseline", metadata: {} },
			{ armId: "hi-temp", label: "hi-temp", metadata: { temperature: 0.9 } },
		],
		repeats: 2, sameCompletionBar: true,
		metrics: [
			{ metric: "gates.passRate", aggregation: "median", direction: "higher-better", primary: true, collect: true },
			{ metric: "cost.totalUsd", aggregation: "median", direction: "lower-better", collect: true },
		],
	};
	const mkRun = (armId: string, repeat: number, pass: number, cost: number) => ({
		experimentId, runId: `${armId}-${repeat}`, armId, repeat,
		runKey: `${experimentId}:${armId}:${repeat}`, status: "collected",
		completionBar: "passed", verified: true,
		metrics: { "gates.passRate": pass, "cost.totalUsd": cost },
		cost: { totalUsd: cost },
	});
	const store = getPackStore();
	await store.put(PACK, `exp/${experimentId}`, def);
	await store.put(PACK, `exp/${experimentId}/state`, { status: "complete" });
	await store.put(PACK, `exp/${experimentId}/metrics`, def.metrics);
	for (const r of [mkRun("baseline", 0, 0.6, 0.4), mkRun("baseline", 1, 0.7, 0.5), mkRun("hi-temp", 0, 0.9, 0.6), mkRun("hi-temp", 1, 0.85, 0.55)]) {
		await store.put(PACK, `exp/${experimentId}/run/${r.runId}`, r);
	}
	await store.put(PACK, "index/experiments", { experiments: [{ experimentId, title: def.title, mode: "ab", status: "complete" }] });

	await enablePack();
	await openWithPack(page);
	await openPanelDeepLink(page, `?experimentId=${experimentId}&view=dashboard`);

	await expect(page.locator(tid("experiment-runner-view-dashboard"))).toBeVisible({ timeout: 20_000 });
	await expect(page.locator(tid("experiment-runner-dashboard-body"))).toBeVisible({ timeout: 20_000 });
	// The comparison widget renders both variant arms from the stored outcomes.
	await expect(page.locator(`${tid("experiment-runner-comparison-arm")}[data-arm="baseline"]`)).toBeVisible({ timeout: 15_000 });
	await expect(page.locator(`${tid("experiment-runner-comparison-arm")}[data-arm="hi-temp"]`)).toBeVisible();

	// Edit the dashboard spec — add an objective-curve widget (NOT in the default
	// A/B layout); it re-renders from the already-stored outcomes (no launch/poll).
	await expect(page.locator(`${tid("experiment-runner-widget")}[data-widget-type="objective-curve"]`)).toHaveCount(0);
	await page.locator(tid("experiment-runner-edit-dashboard")).click();
	await expect(page.locator(tid("experiment-runner-dashboard-editor"))).toBeVisible();
	await page.locator(tid("experiment-runner-add-widget-type")).selectOption("objective-curve");
	await page.locator(tid("experiment-runner-add-widget")).click();
	await page.locator(tid("experiment-runner-save-dashboard")).click();
	await expect(page.locator(`${tid("experiment-runner-widget")}[data-widget-type="objective-curve"]`).first()).toBeVisible({ timeout: 15_000 });

	// Toggle a metric off via the dashboard metrics editor → re-renders from the
	// stored outcomes (re-extract, no re-run).
	const metricsPanel = page.locator(tid("experiment-runner-metrics-panel"));
	await metricsPanel.locator("summary").click();
	const metricToggle = metricsPanel.locator(`${tid("experiment-runner-dash-metric-collect")}[data-metric="cost.totalUsd"]`).first();
	await expect(metricToggle).toBeVisible({ timeout: 10_000 });
	await expect(metricToggle).toBeChecked();
	const saveMetrics = page.waitForResponse((r) => /\/api\/ext\/route\/saveMetrics\b/.test(r.url()) && r.request().method() === "POST");
	await metricToggle.click();
	await saveMetrics;
	await expect(metricToggle).not.toBeChecked();
	// The dashboard still renders the comparison arms after the metric edit.
	await expect(page.locator(`${tid("experiment-runner-comparison-arm")}[data-arm="baseline"]`)).toBeVisible({ timeout: 15_000 });
});

test("built-in disable/re-enable removes & restores the launcher + deep-link; pack is non-removable", async ({ page }) => {
	// Start from the ENABLED state (opt-in toggle on), then exercise disable→re-enable.
	await enablePack();
	await openWithPack(page);

	// ── DISABLE via the Market built-in group → launcher + deep-link gone. ──
	await navigateToHash(page, "#/market");
	const builtinGroup = page.locator('[data-testid="market-builtin-group"]');
	await expect(builtinGroup, "the Market Installed tab must show a Built-in group").toBeVisible({ timeout: 15_000 });
	const card = builtinGroup.locator(`[data-testid="market-installed-pack"][data-builtin="true"][data-pack-name="${PACK}"]`).first();
	await expect(card, "the built-in experiment-runner card must render").toBeVisible({ timeout: 15_000 });
	// The built-in pack has no Uninstall control.
	await expect(card.locator('[data-testid="market-uninstall-pack"]')).toHaveCount(0);

	// The pack exposes its three entrypoint toggles (no tools/roles/skills).
	for (const kind of ["Session menu", "Slash", "Route"]) {
		await expect(card.getByText(kind, { exact: true }), `entrypoint kind ${kind} must be visible`).toBeVisible();
	}
	const sessionMenuToggle = card.locator(`[data-testid="market-toggle-entrypoint-${SESSION_MENU_LIST_NAME}"]`);
	await expect(sessionMenuToggle, "the built-in pack's entrypoint toggles must render").toBeVisible({ timeout: 15_000 });

	// Disable every entrypoint.
	for (const listName of ENTRYPOINT_LIST_NAMES) {
		const toggle = card.locator(`[data-testid="market-toggle-entrypoint-${listName}"]`);
		await expect(toggle).toBeVisible({ timeout: 10_000 });
		if (await toggle.isChecked()) {
			const put = page.waitForResponse((r) => r.url().includes("/api/marketplace/pack-activation") && r.request().method() === "PUT");
			await toggle.click();
			await put;
		}
	}

	// The deep-link no longer resolves to a registered route → the dismissible
	// "feature unavailable" empty state (no panel, no crash).
	await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
	await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${ROUTE_ID}`);
	await expect.poll(async () => {
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
		return page.locator(tid("experiment-runner-panel-root")).count();
	}, { timeout: 15_000 }).toBe(0);
	const unavailable = page.locator('[data-testid="ext-route-unavailable"]');
	await expect(unavailable).toBeVisible({ timeout: 10_000 });
	await expect(unavailable).toContainText("unavailable");
	await page.locator('[data-testid="ext-route-unavailable-dismiss"]').click();
	await expect(unavailable).toHaveCount(0);
	// The entrypoints are dropped from the contribution registry, but the panel +
	// routes survive (they are not entrypoints).
	await expect.poll(async () => {
		const meta = (await listContributions()).find((p) => p.packId === PACK);
		return meta?.entrypoints?.length ?? 0;
	}, { timeout: 10_000 }).toBe(0);
	const metaAfterDisable = (await listContributions()).find((p) => p.packId === PACK);
	expect(metaAfterDisable?.panels?.some((p) => p.id === PANEL_ID), "entrypoint disable must not remove the pack panel").toBe(true);
	expect(metaAfterDisable?.routeNames, "entrypoint disable must not remove pack routes").toEqual(expect.arrayContaining(CANONICAL_ROUTES));

	// Disabled state survives a reload (server-scope override is persisted).
	const token = await readE2ETokenAsync();
	await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/market`);
	const group2 = page.locator('[data-testid="market-builtin-group"]');
	await expect(group2).toBeVisible({ timeout: 20_000 });
	const card2 = group2.locator(`[data-testid="market-installed-pack"][data-builtin="true"][data-pack-name="${PACK}"]`).first();
	await expect(card2).toBeVisible({ timeout: 15_000 });
	const sessionMenuToggleAfterReload = card2.locator(`[data-testid="market-toggle-entrypoint-${SESSION_MENU_LIST_NAME}"]`);
	await expect(sessionMenuToggleAfterReload).toBeVisible({ timeout: 15_000 });
	await expect(sessionMenuToggleAfterReload, "disable must survive reload (toggle stays off)").not.toBeChecked();
	await expect.poll(async () => {
		const meta = (await listContributions()).find((p) => p.packId === PACK);
		return meta?.entrypoints?.length ?? 0;
	}, { timeout: 10_000 }).toBe(0);

	// ── RE-ENABLE → the launcher + deep-link are restored. ──
	for (const listName of ENTRYPOINT_LIST_NAMES) {
		const toggle = card2.locator(`[data-testid="market-toggle-entrypoint-${listName}"]`);
		await expect(toggle).toBeVisible({ timeout: 10_000 });
		if (!(await toggle.isChecked())) {
			const put = page.waitForResponse((r) => r.url().includes("/api/marketplace/pack-activation") && r.request().method() === "PUT");
			await toggle.click();
			await put;
		}
	}
	await expect.poll(async () => {
		const meta = (await listContributions()).find((p) => p.packId === PACK);
		return meta?.entrypoints?.some((e) => e.kind === "session-menu" && e.label === SESSION_MENU_LABEL) ? "ok" : "no";
	}, { timeout: 10_000 }).toBe("ok");
	// The deep-link resolves again from a CLEAN context.
	const sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
	if (sid) {
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sid}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	} else {
		await openWithPack(page);
	}
	await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
	await openPanelDeepLink(page);
	await expect(page.locator(tid("experiment-runner-panel-root")).first()).toHaveAttribute("data-view", "mode-select");

	// ── NON-REMOVABLE — the built-in pack cannot be uninstalled. ──
	const delPack = await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK }),
	});
	expect(delPack.status, "the built-in pack must not be uninstallable").toBe(403);
});
