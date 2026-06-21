import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	readE2ETokenAsync,
	startTeam,
	teardownTeam,
	waitForSessionStatus,
	base,
} from "../e2e-setup.js";
import { navigateToHash, openApp } from "./ui-helpers.js";

test.describe.configure({ mode: "serial" });

const PACK_ID = "experiment-runner";
const DEFAULT_ROUTE_ID = "experiment-runner";
const FORBIDDEN_ERRORS = /NO_EFFECTIVE_GOAL|SPAWN_GOAL_UNAVAILABLE|PARENT_MISMATCH|PACK_ROUTE|WORKFLOW_(?:REQUIRED|NOT_FOUND|INVALID)|workflow route error/i;

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

async function listContributions(): Promise<PackContributionsMeta[]> {
	const res = await apiFetch("/api/ext/contributions");
	const text = await res.text();
	expect(res.ok, `/api/ext/contributions should be reachable: ${text}`).toBe(true);
	return (JSON.parse(text) as { packs?: PackContributionsMeta[] }).packs ?? [];
}

function skipWhenPackAbsent(testInfo: TestInfo, packs: PackContributionsMeta[]): never {
	const packIds = packs.map((p) => p.packId).sort().join(", ") || "<none>";
	const reason = `${PACK_ID} is not present in /api/ext/contributions for this gateway; optional smoke journey skipped. Seen packs: ${packIds}`;
	testInfo.annotations.push({ type: "skip", description: reason });
	test.skip(true, reason);
	throw new Error(reason);
}

function assertContributionShape(pack: PackContributionsMeta): { panelId: string; routeId: string } {
	const panels = pack.panels ?? [];
	const entrypoints = pack.entrypoints ?? [];
	const routeNames = pack.routeNames ?? [];
	const panelId = panels.find((p) => p.id === "experiment-runner.panel")?.id ?? panels[0]?.id;
	const routeId = entrypoints.find((e) => e.kind === "route")?.routeId ?? DEFAULT_ROUTE_ID;

	expect(panelId, "Experiment Runner must contribute a panel").toBeTruthy();
	expect(panels.some((p) => p.id === "experiment-runner.panel" && /experiments/i.test(p.title ?? ""))).toBe(true);
	expect(entrypoints.some((e) => e.kind === "session-menu" && /new experiment/i.test(e.label ?? e.listName ?? ""))).toBe(true);
	expect(entrypoints.some((e) => e.kind === "composer-slash" && /experiments?/i.test(e.label ?? e.listName ?? e.id))).toBe(true);
	expect(entrypoints.some((e) => e.kind === "route" && (e.routeId === DEFAULT_ROUTE_ID || e.routeId === routeId))).toBe(true);
	expect(routeNames).toEqual(expect.arrayContaining([
		"defineExperiment",
		"launch",
		"poll",
		"collect",
		"aggregate",
		"saveMetrics",
		"saveDashboard",
		"report",
	]));

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
}

async function expectLauncherSurfaces(page: Page, routeId: string): Promise<void> {
	const trigger = page.locator('[data-testid="session-actions-trigger"]').first();
	await expect(trigger, "goal session header must expose the session menu").toBeVisible({ timeout: 10_000 });
	await trigger.click();
	await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
	await expect(
		page.locator('sidebar-actions-popover [role="menuitem"]', { hasText: /new experiment/i }).first(),
		"Experiment Runner must contribute the New experiment session-menu launcher",
	).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press("Escape");

	const textarea = page.locator("textarea").first();
	await textarea.fill("/Exp");
	await expect(
		page.locator('[data-testid^="slash-command-"]').filter({ hasText: /experiments?|experiment-runner/i }).first(),
		"Experiment Runner must contribute the Experiments composer slash launcher",
	).toBeVisible({ timeout: 10_000 });
	await textarea.fill("");

	await navigateToHash(page, `#/ext/${routeId}`);
	await expect(page.locator("body")).toContainText(/Experiments|Experiment Runner/i, { timeout: 20_000 });
	await expect(page.locator("body"), "A/B comparison should be the visible default/recommended path").toContainText(/A\/?B|A-B|comparison/i);
	await expect(page.locator("body"), "Autoresearch should be present as an opt-in guarded mode").toContainText(/Autoresearch/i);
	await expect(page.locator("body"), "Autoresearch must advertise opt-in/hard-cap guardrails").toContainText(/opt-in|hard caps|required|guardrail/i);
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
	return goals.filter((g) => g.parentGoalId === parentGoalId && String(g.spawnedFromPlanId ?? "").startsWith(`${experimentId}:`));
}

function minimalExperimentDefinition(experimentId: string, parentGoalId: string) {
	return {
		experimentId,
		title: "E2E Experiment Runner smoke",
		mode: "ab",
		parentGoalId,
		runnable: {
			kind: "spec",
			spec: "Minimal safe smoke-test arm. Do not edit files. Finish quickly with one sentence: Smoke arm complete.",
		},
		variants: [
			{
				armId: "baseline",
				label: "baseline",
				metadata: {
					experiment: { userMetrics: { metric: 1, smokeBaselineMarker: 101 } },
					smokeTreatment: { arm: "baseline", marker: "smoke-baseline-101" },
				},
			},
			{
				armId: "variant-b",
				label: "variant-b",
				metadata: {
					experiment: { userMetrics: { metric: 2, smokeVariantMarker: 202 } },
					smokeTreatment: { arm: "variant-b", marker: "smoke-variant-b-202" },
				},
			},
		],
		repeats: 1,
		maxConcurrency: 1,
		perRunBudget: 0.05,
		sameCompletionBar: false,
		metrics: [
			{ metricId: "command.metric", aggregation: "median" },
			{ metricId: "cost.totalUsd", aggregation: "median", directionOverride: "min" },
		],
		dashboard: {
			widgets: [
				{ id: "smoke-summary", type: "summary-cards", title: "Smoke summary", bind: { metricIds: ["command.metric", "cost.totalUsd"] } },
			],
		},
	};
}

test.describe("Experiment Runner optional smoke journey", () => {
	test("deep link + launchers + bounded A/B route lifecycle", async ({ page }, testInfo) => {
		test.setTimeout(180_000);

		const packs = await listContributions();
		const pack = packs.find((p) => p.packId === PACK_ID) ?? skipWhenPackAbsent(testInfo, packs);
		const { panelId, routeId } = assertContributionShape(pack);

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

			await openGoalSession(page, teamLeadId);
			await expectLauncherSurfaces(page, routeId);
			await expectNoForbiddenErrors(page, consoleMessages.join("\n"), "launcher/deep-link UI");

			surfaceToken = await mintSurfaceToken(teamLeadId, panelId);
			experimentId = `e2e-smoke-${Date.now().toString(36)}`;

			const arGuard = await callExperimentRoute(teamLeadId, surfaceToken, "defineExperiment", {
				experimentId: `${experimentId}-ar-guard`,
				mode: "autoresearch",
				title: "Autoresearch guard probe",
				runnable: { kind: "spec", spec: "Do not run; this validates guardrails only." },
				objective: { metricId: "command.metric", direction: "max" },
				stop: { plateauK: 1 },
				perRunBudget: 0.05,
			});
			routeResponses.push(arGuard.body);
			expect(arGuard.body.error, "Autoresearch must remain opt-in and reject missing finite hard caps").toBe("AR_UNCAPPED");

			const defined = await callExperimentRoute(teamLeadId, surfaceToken, "defineExperiment", minimalExperimentDefinition(experimentId, parentGoalId));
			routeResponses.push(defined.body);
			expect(defined.body.error).toBeUndefined();
			expect(defined.body.experimentId).toBe(experimentId);
			expect(defined.body.projection?.mode).toBe("ab");
			expect(defined.body.projection?.arms).toBe(2);

			const launched = await callExperimentRoute(teamLeadId, surfaceToken, "launch", { experimentId });
			routeResponses.push(launched.body);
			expect(launched.body.error).toBeUndefined();
			expect(launched.body.launched).toHaveLength(2);

			const children = await findExperimentChildren(parentGoalId, experimentId);
			expect(children, "A/B launch must create exactly one child goal per arm").toHaveLength(2);
			childGoalIds = children.map((g) => g.id as string);
			const byArm = new Map(children.map((g) => [g.metadata?.experiment?.armId, g]));
			expect([...byArm.keys()].sort()).toEqual(["baseline", "variant-b"]);
			expect(byArm.get("baseline")?.metadata?.smokeTreatment).toEqual({ arm: "baseline", marker: "smoke-baseline-101" });
			expect(byArm.get("variant-b")?.metadata?.smokeTreatment).toEqual({ arm: "variant-b", marker: "smoke-variant-b-202" });
			expect(byArm.get("baseline")?.metadata?.experiment?.budget).toBe(0.05);
			expect(byArm.get("variant-b")?.metadata?.experiment?.budget).toBe(0.05);

			for (const name of ["poll", "collect", "aggregate", "report"] as const) {
				const result = await callExperimentRoute(teamLeadId, surfaceToken, name, { experimentId });
				routeResponses.push(result.body);
				expect(result.body.error, `${name} should not return a route error`).toBeUndefined();
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
			expect((await callExperimentRoute(teamLeadId, surfaceToken, "saveMetrics", { experimentId, metrics: editedMetrics })).body).toEqual({ ok: true });
			expect((await callExperimentRoute(teamLeadId, surfaceToken, "saveDashboard", { experimentId, dashboard: editedDashboard })).body).toEqual({ ok: true });

			const token = await readE2ETokenAsync();
			await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/ext/${routeId}?experimentId=${encodeURIComponent(experimentId)}&view=report`, { waitUntil: "domcontentloaded" });
			await expect(page.locator("body")).toContainText(/Experiments|Experiment Runner/i, { timeout: 20_000 });
			surfaceToken = await mintSurfaceToken(teamLeadId, panelId);
			const persisted = await callExperimentRoute(teamLeadId, surfaceToken, "getExperiment", { experimentId });
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
