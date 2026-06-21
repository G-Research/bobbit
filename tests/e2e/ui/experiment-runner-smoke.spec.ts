import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	startTeam,
	teardownTeam,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { navigateToHash, openApp } from "./ui-helpers.js";

test.describe.configure({ mode: "serial" });

const PACK_ID = "experiment-runner";
const DEFAULT_ROUTE_ID = "experiment-runner";
const SOURCE_DIR = fileURLToPath(new URL("../../fixtures/market-sources/experiment-runner-smoke-src", import.meta.url));
const FORBIDDEN_ERRORS = /NO_EFFECTIVE_GOAL|SPAWN_GOAL_UNAVAILABLE|PARENT_MISMATCH|PACK_ROUTE|WORKFLOW_(?:REQUIRED|NOT_FOUND|INVALID)|workflow route error/i;
// Pack-schema route names are lowercase-token identifiers; these fixture names
// correspond to the Experiment Runner contract routes (defineExperiment,
// saveMetrics, saveDashboard, getExperiment, listMetrics, listWidgets, etc.).
const REQUIRED_ROUTE_NAMES = [
	"defineexperiment",
	"launch",
	"poll",
	"collect",
	"aggregate",
	"savemetrics",
	"savedashboard",
	"report",
	"getexperiment",
	"listmetrics",
	"listwidgets",
	"cancel",
];

type ContributionEntryPoint = {
	id: string;
	kind: string;
	routeId?: string;
	listName?: string;
	label?: string;
	target?: { panelId?: string };
};

type PackContributionsMeta = {
	packId: string;
	packName?: string;
	panels?: Array<{ id: string; title?: string }>;
	entrypoints?: ContributionEntryPoint[];
	routeNames?: string[];
};

type RouteCallResult = { status: number; body: any; text: string };

async function cleanupFixtureInstall(): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK_ID }),
	}).catch(() => {});
	try {
		const res = await apiFetch("/api/marketplace/sources");
		for (const source of ((await res.json()).sources ?? []) as Array<{ id: string }>) {
			await apiFetch(`/api/marketplace/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" }).catch(() => {});
		}
	} catch { /* best-effort cleanup */ }
}

async function installExperimentRunnerFixture(): Promise<void> {
	await cleanupFixtureInstall();
	const addRes = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE_DIR }),
	});
	const addBody = await addRes.text();
	expect(addRes.status, addBody).toBe(201);
	const sourceId = (JSON.parse(addBody) as { source: { id: string } }).source.id;

	const installRes = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK_ID, scope: "server" }),
	});
	const installBody = await installRes.text();
	expect(installRes.status, installBody).toBe(201);
}

async function listContributions(): Promise<PackContributionsMeta[]> {
	const res = await apiFetch("/api/ext/contributions");
	const text = await res.text();
	expect(res.ok, `/api/ext/contributions should be reachable: ${text}`).toBe(true);
	return (JSON.parse(text) as { packs?: PackContributionsMeta[] }).packs ?? [];
}

function assertContributionShape(pack: PackContributionsMeta): { panelId: string; routeId: string } {
	const panels = pack.panels ?? [];
	const entrypoints = pack.entrypoints ?? [];
	const routeNames = pack.routeNames ?? [];
	const panelId = panels.find((p) => p.id === "experiment-runner.panel")?.id ?? panels[0]?.id;
	const routeId = entrypoints.find((e) => e.kind === "route")?.routeId ?? DEFAULT_ROUTE_ID;

	expect(panelId, "Experiment Runner must contribute a panel").toBe("experiment-runner.panel");
	expect(panels.some((p) => p.id === "experiment-runner.panel" && /experiments/i.test(p.title ?? ""))).toBe(true);
	expect(entrypoints.some((e) => e.kind === "session-menu" && /new experiment/i.test(e.label ?? e.listName ?? ""))).toBe(true);
	expect(entrypoints.some((e) => e.kind === "composer-slash" && /experiments?/i.test(e.label ?? e.listName ?? e.id))).toBe(true);
	expect(entrypoints.some((e) => e.kind === "route" && e.routeId === DEFAULT_ROUTE_ID)).toBe(true);
	expect(routeNames).toEqual(expect.arrayContaining(REQUIRED_ROUTE_NAMES));

	return { panelId, routeId };
}

async function expectNoForbiddenErrors(page: Page, body: unknown, context: string): Promise<void> {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	expect(text, `${context} must not surface parent-goal/spawn/workflow errors`).not.toMatch(FORBIDDEN_ERRORS);
	await expect(page.locator('[data-testid="header-toast"], [role="alert"], [role="status"]').filter({ hasText: FORBIDDEN_ERRORS })).toHaveCount(0);
}

async function openGoalSession(page: Page, sessionId: string): Promise<void> {
	await openApp(page);
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.()).catch(() => {});
	await page.evaluate(() => (window as any).__bobbitReconcilePackEntrypoints?.()).catch(() => {});
}

async function exerciseLauncherSurfaces(page: Page, routeId: string): Promise<void> {
	const panel = page.getByTestId("experiment-runner-panel");
	const trigger = page.locator('[data-testid="session-actions-trigger"]').first();
	await expect(trigger, "goal session header must expose the session menu").toBeVisible({ timeout: 10_000 });
	await trigger.click();
	await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
	const menuItem = page.locator('sidebar-actions-popover [role="menuitem"]', { hasText: /new experiment/i }).first();
	await expect(menuItem, "Experiment Runner must contribute the New experiment session-menu launcher").toBeVisible({ timeout: 10_000 });
	await menuItem.click();
	await expect(panel, "session-menu launcher should open the Experiments panel").toBeVisible({ timeout: 20_000 });

	const textarea = page.locator("textarea").first();
	await textarea.fill("/Exp");
	const command = page.locator('[data-testid^="slash-command-"]').filter({ hasText: /experiments?|experiment-runner/i }).first();
	await expect(command, "Experiment Runner must contribute the Experiments composer slash launcher").toBeVisible({ timeout: 10_000 });
	await command.click();
	await textarea.press("Enter");
	await expect(panel, "composer /Experiments launcher should open the Experiments panel").toBeVisible({ timeout: 20_000 });

	await navigateToHash(page, `#/ext/${routeId}`);
	await expect(panel, "deep link should open the Experiments panel").toBeVisible({ timeout: 20_000 });
	await expect(panel, "A/B comparison should be the visible default/recommended path").toContainText(/A\/B comparison/i);
	await expect(panel, "Autoresearch must remain opt-in with hard caps").toContainText(/Autoresearch is opt-in.*hard caps/i);
}

async function mintSurfaceToken(sessionId: string, panelId: string): Promise<string> {
	const res = await apiFetch("/api/ext/surface-token", {
		method: "POST",
		headers: { "x-bobbit-session-id": sessionId },
		body: JSON.stringify({
			sessionId,
			packId: PACK_ID,
			contributionKind: "panel",
			contributionId: panelId,
		}),
	});
	const text = await res.text();
	expect(res.status, `surface-token mint failed: ${text}`).toBe(200);
	return (JSON.parse(text) as { token: string }).token;
}

async function callExperimentRoute(sessionId: string, surfaceToken: string, name: string, body: Record<string, unknown> = {}): Promise<RouteCallResult> {
	const res = await apiFetch(`/api/ext/route/${encodeURIComponent(name)}`, {
		method: "POST",
		headers: { "x-bobbit-session-id": sessionId },
		body: JSON.stringify({
			sessionId,
			surfaceToken,
			init: { method: "POST", body },
		}),
	});
	const text = await res.text();
	let parsed: any = {};
	try {
		parsed = text ? JSON.parse(text) : {};
	} catch {
		parsed = { raw: text };
	}
	expect(res.status, `${name} route HTTP failure: ${text}`).toBe(200);
	return { status: res.status, body: parsed, text };
}

async function findExperimentChildren(parentGoalId: string, experimentId: string): Promise<any[]> {
	const res = await apiFetch("/api/goals");
	expect(res.ok).toBe(true);
	const payload = await res.json();
	const goals = (payload.goals ?? payload) as any[];
	return goals.filter((g) => g.parentGoalId === parentGoalId && g.metadata?.experiment?.id === experimentId);
}

test.afterEach(async () => {
	await cleanupFixtureInstall();
});

test.describe("Experiment Runner smoke journey", () => {
	test("fixture install + launchers + UI-driven bounded A/B lifecycle", async ({ page, gateway }) => {
		test.setTimeout(180_000);

		await installExperimentRunnerFixture();
		const packs = await listContributions();
		const pack = packs.find((p) => p.packId === PACK_ID);
		expect(pack, `${PACK_ID} fixture must be present after local marketplace install`).toBeTruthy();
		const { panelId, routeId } = assertContributionShape(pack!);

		let parentGoalId: string | undefined;
		let teamLeadId: string | undefined;
		let surfaceToken = "";
		let experimentId = "";
		let childGoalIds: string[] = [];
		const routeResponses: unknown[] = [];
		const consoleMessages: string[] = [];
		page.on("console", (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`));

		try {
			const parent = await createGoal({
				title: `Experiment Runner E2E smoke ${Date.now()}`,
				spec: "Parent goal for the Experiment Runner browser E2E smoke journey. It exists only to provide an effective parent goal for child experiment arms.",
				team: false,
				worktree: false,
				subgoalsAllowed: true,
				maxNestingDepth: 2,
			});
			parentGoalId = parent.id as string;
			teamLeadId = await startTeam(parentGoalId);
			await waitForSessionStatus(teamLeadId, "idle", 45_000).catch(() => {});
			const teamLeadSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(teamLeadId);

			await openGoalSession(page, teamLeadId);
			await exerciseLauncherSurfaces(page, routeId);
			await expectNoForbiddenErrors(page, consoleMessages.join("\n"), "launcher/deep-link UI");

			surfaceToken = await mintSurfaceToken(teamLeadId, panelId);
			experimentId = `e2e-smoke-${Date.now().toString(36)}`;

			const arGuard = await callExperimentRoute(teamLeadId, surfaceToken, "defineexperiment", {
				experimentId: `${experimentId}-ar-guard`,
				mode: "autoresearch",
				title: "Autoresearch guard probe",
				parentGoalId,
				teamLeadSecret,
				runnable: { kind: "spec", spec: "Do not run; this validates guardrails only." },
				objective: { metricId: "command.metric", direction: "max" },
				stop: { plateauK: 1 },
				perRunBudget: 0.05,
			});
			routeResponses.push(arGuard.body);
			expect(arGuard.body.error, "Autoresearch must reject missing finite hard caps").toBe("AR_UNCAPPED");

			await page.getByTestId("exp-experiment-id").fill(experimentId);
			await page.getByTestId("exp-parent-goal-id").fill(parentGoalId);
			await page.getByTestId("exp-session-secret").fill(teamLeadSecret);
			await page.getByTestId("exp-define-button").click();
			await expect(page.getByTestId("exp-status")).toContainText(/Definition ready: 2 arms/i, { timeout: 20_000 });
			await page.getByTestId("exp-launch-button").click();
			await expect(page.getByTestId("exp-status")).toContainText(/Launch complete: 2 child goals/i, { timeout: 30_000 });

			const children = await findExperimentChildren(parentGoalId, experimentId);
			expect(children, "A/B launch must create exactly one child goal per arm").toHaveLength(2);
			childGoalIds = children.map((g) => g.id as string);
			const byArm = new Map(children.map((g) => [g.metadata?.experiment?.armId, g]));
			expect([...byArm.keys()].sort()).toEqual(["baseline", "variant-b"]);
			expect(byArm.get("baseline")?.metadata?.smokeTreatment).toEqual({ arm: "baseline", marker: "smoke-baseline-101" });
			expect(byArm.get("variant-b")?.metadata?.smokeTreatment).toEqual({ arm: "variant-b", marker: "smoke-variant-b-202" });
			expect(byArm.get("baseline")?.metadata?.experiment?.budget).toBe(0.05);
			expect(byArm.get("variant-b")?.metadata?.experiment?.budget).toBe(0.05);

			for (const name of ["poll", "collect", "aggregate"] as const) {
				await page.getByTestId(`exp-${name}`).click();
				await expect(page.getByTestId("exp-status")).toContainText(new RegExp(`${name} complete`, "i"), { timeout: 20_000 });
			}

			const editedMetrics = [
				{ metricId: "cost.totalUsd", aggregation: "median", directionOverride: "min" },
				{ metricId: "time.wallClockMs", aggregation: "median", directionOverride: "min" },
			];
			const editedDashboard = {
				widgets: [
					{ id: "edited-summary", type: "summary-cards", title: "Edited smoke summary", bind: { metricIds: ["cost.totalUsd", "time.wallClockMs"] } },
					{ id: "edited-raw", type: "raw-drilldown", title: "Edited raw", bind: { metricIds: ["cost.totalUsd"] } },
				],
			};
			await page.getByTestId("exp-metrics-json").fill(JSON.stringify(editedMetrics, null, 2));
			await page.getByTestId("exp-save-metrics").click();
			await expect(page.getByTestId("exp-status")).toContainText(/Metric spec saved/i, { timeout: 20_000 });
			await page.getByTestId("exp-dashboard-json").fill(JSON.stringify(editedDashboard, null, 2));
			await page.getByTestId("exp-save-dashboard").click();
			await expect(page.getByTestId("exp-status")).toContainText(/Dashboard spec saved/i, { timeout: 20_000 });
			await page.getByTestId("exp-report-button").click();
			await expect(page.getByTestId("exp-report")).toContainText(/Experiment Runner Smoke Report/i, { timeout: 20_000 });
			await expect(page.getByTestId("exp-report")).toContainText(/Edited smoke summary/i);
			await expect(page.getByTestId("exp-report")).toContainText(/time\.wallClockMs/i);

			// Reopen after a real page reload, then revisit the extension deep link with the
			// active goal session restored so the panel host can reload persisted specs.
			await openGoalSession(page, teamLeadId);
			await navigateToHash(page, `#/ext/${routeId}?experimentId=${encodeURIComponent(experimentId)}&view=report`);
			await expect(page.getByTestId("experiment-runner-panel")).toBeVisible({ timeout: 20_000 });
			await expect(page.getByTestId("experiment-runner-panel")).toContainText(/Edited smoke summary/i, { timeout: 20_000 });
			surfaceToken = await mintSurfaceToken(teamLeadId, panelId);
			const persisted = await callExperimentRoute(teamLeadId, surfaceToken, "getexperiment", { experimentId });
			expect(persisted.body.metrics.map((m: any) => m.metricId)).toEqual(["cost.totalUsd", "time.wallClockMs"]);
			expect(persisted.body.dashboard.widgets.map((w: any) => w.id)).toEqual(["edited-summary", "edited-raw"]);
			const editedReport = await callExperimentRoute(teamLeadId, surfaceToken, "report", { experimentId });
			routeResponses.push(persisted.body, editedReport.body);
			expect(editedReport.body.error).toBeUndefined();
			expect(editedReport.body.html?.length ?? 0).toBeGreaterThan(100);
			expect(editedReport.body.model?.metrics?.map((m: any) => m.metricId)).toEqual(["cost.totalUsd", "time.wallClockMs"]);

			const cancelled = await callExperimentRoute(teamLeadId, surfaceToken, "cancel", { experimentId });
			routeResponses.push(cancelled.body);
			expect(cancelled.body.error).toBeUndefined();

			for (const [i, response] of routeResponses.entries()) {
				await expectNoForbiddenErrors(page, response, `route response #${i + 1}`);
			}
			await expectNoForbiddenErrors(page, consoleMessages.join("\n"), "browser console");
		} finally {
			for (const childGoalId of childGoalIds) await teardownTeam(childGoalId).catch(() => {});
			for (const childGoalId of childGoalIds) await deleteGoal(childGoalId).catch(() => {});
			if (parentGoalId) await teardownTeam(parentGoalId).catch(() => {});
			if (parentGoalId) await deleteGoal(parentGoalId).catch(() => {});
		}
	});
});
