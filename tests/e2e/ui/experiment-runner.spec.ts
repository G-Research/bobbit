/**
 * Browser E2E — the experiment-runner market pack PANEL + entrypoints (design
 * docs/design/experiment-runner-panel-ux.md §12). Installed via the marketplace
 * (it is NOT a built-in band pack), mirroring tests/e2e/ui/artifacts-pack.spec.ts
 * for install/uninstall and tests/e2e/ui/pr-walkthrough-pack.spec.ts for the
 * reconcile + deep-link + pack-store seeding patterns.
 *
 * Coverage:
 *   1. INSTALL → contributions (panel + the canonical routes + 3 entrypoints) →
 *      deep-link opens the panel at MODE-SELECT, defaulting to A/B (autoresearch
 *      carries the opt-in warning eyebrow).
 *   2. A/B VALIDATION — identical variants + zero budget block launch; making them
 *      distinct + setting a per-run budget enables it; the projection strip shows
 *      the run count + bounded cost.
 *   3. AUTORESEARCH GUARDRAILS — switching to autoresearch shows the danger banner;
 *      launch stays blocked until ≥1 cap, ≥1 stop, and the explicit ack are set;
 *      the draft persists across a reload.
 *   4. DASHBOARD — a seeded experiment renders the comparison; editing the
 *      dashboard spec adds a widget that re-renders from the stored outcomes (no
 *      re-run); toggling a metric re-renders; UNINSTALL drops the panel +
 *      entrypoints and the stale deep-link no-ops.
 */
import { fileURLToPath } from "node:url";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, base, readE2ETokenAsync } from "../e2e-setup.js";
import { openApp, createSessionViaUI } from "./ui-helpers.js";

test.describe.configure({ mode: "serial" });

const SOURCE_DIR = fileURLToPath(new URL("../../../market-packs", import.meta.url));
const PACK = "experiment-runner";
const PANEL_ID = "experiment-runner.panel";
const ROUTE_ID = "experiment-runner";
const CANONICAL_ROUTES = [
	"defineExperiment", "projectCost", "launch", "poll", "collect", "aggregate",
	"iterate", "listExperiments", "getExperiment", "saveMetrics", "saveDashboard",
	"report", "listMetrics", "listWidgets", "cancel",
];

const tid = (id: string) => `[data-testid="${id}"]`;

async function installPack(): Promise<void> {
	const addRes = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE_DIR }),
	});
	const addBody = await addRes.text();
	expect([201, 409].includes(addRes.status), addBody).toBe(true);
	let sourceId: string;
	if (addRes.status === 201) {
		sourceId = (JSON.parse(addBody) as { source: { id: string } }).source.id;
	} else {
		const res = await apiFetch("/api/marketplace/sources");
		const sources = ((await res.json()).sources ?? []) as Array<{ id: string; url?: string }>;
		sourceId = (sources.find((s) => s.url === SOURCE_DIR) ?? sources[0]).id;
	}
	const instRes = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK, scope: "server" }),
	});
	const instBody = await instRes.text();
	expect(instRes.status, instBody).toBe(201);
}

async function uninstallPack(): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK }),
	}).catch(() => {});
}

async function cleanup(): Promise<void> {
	await uninstallPack();
	try {
		const res = await apiFetch("/api/marketplace/sources");
		for (const s of ((await res.json()).sources ?? []) as Array<{ id: string; builtin?: boolean }>) {
			if (s.builtin) continue;
			await apiFetch(`/api/marketplace/sources/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => {});
		}
	} catch { /* ignore */ }
}

interface PackContributionsMeta {
	packId: string;
	panels: { id: string }[];
	entrypoints: Array<{ id: string; kind: string; routeId?: string }>;
	routeNames?: string[];
}

async function listContributions(): Promise<PackContributionsMeta[]> {
	const res = await apiFetch("/api/ext/contributions");
	expect(res.ok).toBe(true);
	return (await res.json()).packs as PackContributionsMeta[];
}

/** Open the app, create a session, and force a pack-contribution reconcile so the
 *  freshly-installed panel + entrypoints register without a reload. */
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

test.afterEach(async () => {
	await cleanup();
});

test("install → panel + routes + entrypoints register; deep-link opens mode-select defaulting to A/B", async ({ page }) => {
	await installPack();

	const meta = (await listContributions()).find((p) => p.packId === PACK);
	expect(meta, "the experiment-runner pack must contribute").toBeTruthy();
	expect(meta?.panels?.some((p) => p.id === PANEL_ID)).toBe(true);
	expect(meta?.entrypoints?.map((e) => e.id) ?? []).toEqual(
		expect.arrayContaining(["experiment-runner.open", "experiment-runner.palette", "experiment-runner.route"]),
	);
	expect(meta?.entrypoints?.some((e) => e.kind === "route" && e.routeId === ROUTE_ID)).toBe(true);
	if (meta?.routeNames) expect(meta.routeNames).toEqual(expect.arrayContaining(CANONICAL_ROUTES));

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
	await installPack();
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
	await installPack();
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

test("dashboard renders a seeded A/B experiment; editing the spec re-renders without a re-run; uninstall reconciles", async ({ page }) => {
	await installPack();

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

	// UNINSTALL → panel + entrypoints dropped; the deep-link no longer resolves.
	const delRes = await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK }),
	});
	expect(delRes.status).toBe(204);
	await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
	await expect.poll(async () => {
		const meta = (await listContributions()).find((p) => p.packId === PACK);
		return meta ? (meta.panels?.length ?? 0) + (meta.entrypoints?.length ?? 0) : 0;
	}, { timeout: 15_000 }).toBe(0);
	await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${ROUTE_ID}?experimentId=${experimentId}&view=dashboard`);
	await expect.poll(async () => {
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
		return page.locator(tid("experiment-runner-panel-root")).count();
	}, { timeout: 15_000 }).toBe(0);
});
