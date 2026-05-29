/**
 * Browser E2E reproducer for cross-surface gate status desynchronization.
 *
 * Pins the active-verification case where the dashboard and widget-local rows
 * can see a running verification, but shared sidebar/widget badge state remains
 * derived from a stale/incomplete gate summary cache.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId, deleteGoal, deleteSession, startTeam, teardownTeam, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const GATE_ID = "slow-gate";
const VERIFY_TITLE = "0 of 1 gates passed — verifying 1";
const SHARED_CACHE_ERROR = "GATE_STATUS_CROSS_SURFACE_ACTIVE: shared gate status cache must expose verifying=true and verifyingCount=1";
const SLOW_CMD = `node -e "setTimeout(()=>process.exit(0),30000)"`;

type SlowWorkflowSetup = {
	workflowId: string;
	projectId: string;
	goalId: string;
};

function makeWorkflowId(): string {
	return `gate-status-cross-surface-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createSlowWorkflow(): Promise<{ workflowId: string; projectId: string }> {
	const projectId = await defaultProjectId();
	if (!projectId) throw new Error("gate-status-cross-surface requires a default project");
	const workflowId = makeWorkflowId();

	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			projectId,
			id: workflowId,
			name: "Gate Status Cross Surface Active",
			description: "One slow command gate for cross-surface active verification status coverage.",
			gates: [
				{
					id: GATE_ID,
					name: "Slow Gate",
					dependsOn: [],
					verify: [
						{ name: "Slow verification", type: "command", run: SLOW_CMD },
					],
				},
			],
		}),
	});
	if (res.status !== 201) {
		throw new Error(`createSlowWorkflow expected 201, got ${res.status}: ${await res.text()}`);
	}

	const readRes = await apiFetch(`/api/workflows/${encodeURIComponent(workflowId)}?projectId=${encodeURIComponent(projectId)}`);
	if (readRes.status !== 200) {
		throw new Error(`createSlowWorkflow read-after-write expected 200, got ${readRes.status}: ${await readRes.text()}`);
	}

	return { workflowId, projectId };
}

async function deleteSlowWorkflow(workflowId: string, projectId: string): Promise<void> {
	await apiFetch(`/api/workflows/${encodeURIComponent(workflowId)}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => { /* best-effort */ });
}

async function createSlowWorkflowGoal(): Promise<SlowWorkflowSetup> {
	const setup = await createSlowWorkflow();
	try {
		const goal = await createGoal({
			title: `Gate Status Cross Surface Active ${Date.now()}`,
			workflowId: setup.workflowId,
			projectId: setup.projectId,
			worktree: false,
			team: true,
			autoStartTeam: false,
		});
		return { ...setup, goalId: goal.id };
	} catch (err) {
		await deleteSlowWorkflow(setup.workflowId, setup.projectId);
		throw err;
	}
}

async function cleanupSlowWorkflowGoal(setup: SlowWorkflowSetup | undefined, teamLeadId: string | undefined): Promise<void> {
	if (!setup) return;
	await apiFetch(`/api/goals/${setup.goalId}/gates/${GATE_ID}/cancel-verification`, { method: "POST" }).catch(() => { /* best-effort */ });
	if (teamLeadId) await deleteSession(teamLeadId).catch(() => { /* best-effort */ });
	await teardownTeam(setup.goalId).catch(() => { /* best-effort */ });
	await deleteGoal(setup.goalId).catch(() => { /* best-effort */ });
	await deleteSlowWorkflow(setup.workflowId, setup.projectId);
}

async function openSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
}

async function openDashboardGates(page: Page, goalId: string): Promise<void> {
	await navigateToHash(page, `#/goal/${goalId}?tab=gates`);
	await expect(page.locator(`[data-testid="goal-dashboard-gate-row"][data-gate-id="${GATE_ID}"]`)).toBeVisible({ timeout: 20_000 });
}

async function signalSlowGate(goalId: string): Promise<void> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/signal`, {
		method: "POST",
		body: JSON.stringify({ content: "# Slow Gate\n\nStart the slow verification." }),
	});
	const text = await res.text();
	expect(res.status, `signal ${GATE_ID} failed: ${res.status} ${text}`).toBe(201);
}

async function waitForActiveVerification(goalId: string): Promise<void> {
	await expect.poll(async () => {
		const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
		if (!res.ok) return null;
		const body = await res.json();
		const active = Array.isArray(body?.verifications) ? body.verifications : [];
		return active.some((v: any) => v?.gateId === GATE_ID && v?.overallStatus === "running");
	}, { timeout: 10_000, message: "slow gate verification should be active before UI assertions" }).toBe(true);
}

async function expectInitialSharedGateBadge(page: Page, goalId: string): Promise<void> {
	await expect.poll(async () => readSharedGateSummary(page, goalId), {
		timeout: 15_000,
		message: "initial shared gate status cache should expose 0/1 before signalling",
	}).toMatchObject({ passed: 0, total: 1 });
	await expect(page.locator(`[data-nav-id="goal:${goalId}"] span[title="0 of 1 gates passed"]`).first())
		.toBeVisible({ timeout: 15_000 });
}

async function ensureGoalWidgetPopoverOpen(page: Page): Promise<void> {
	const dropdown = page.locator("#goal-status-dropdown").first();
	if (await dropdown.isVisible().catch(() => false)) return;
	await page.locator("[data-testid='goal-status-widget-pill']").first().click();
	await expect(dropdown).toBeVisible({ timeout: 10_000 });
}

async function expectWidgetLocalRunning(page: Page): Promise<void> {
	await ensureGoalWidgetPopoverOpen(page);
	const row = page.locator(`[data-testid="goal-widget-gate"][data-gate-id="${GATE_ID}"]`).first();
	await expect(row).toBeVisible({ timeout: 15_000 });
	await expect(row.locator("[data-testid='goal-widget-gate-running-dot']"), "widget-local gate row should show the active running verification").toBeVisible({ timeout: 15_000 });
}

async function expectDashboardRunning(page: Page): Promise<void> {
	const row = page.locator(`[data-testid="goal-dashboard-gate-row"][data-gate-id="${GATE_ID}"]`).first();
	await expect(row, "dashboard gate row should show the active running verification").toHaveAttribute("data-gate-status", "running", { timeout: 20_000 });
}

async function readSharedGateSummary(page: Page, goalId: string): Promise<any> {
	return page.evaluate((id) => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		const cached = state?.gateStatusCache?.get?.(id);
		if (!cached) return null;
		return {
			passed: cached.passed,
			total: cached.total,
			verifying: cached.verifying,
			verifyingCount: cached.verifyingCount,
			awaitingSignoffCount: cached.awaitingSignoffCount,
		};
	}, goalId);
}

async function expectSharedGateVerifying(page: Page, goalId: string): Promise<void> {
	await expect.poll(async () => readSharedGateSummary(page, goalId), {
		timeout: 15_000,
		message: SHARED_CACHE_ERROR,
	}).toMatchObject({ verifying: true, verifyingCount: 1 });
}

async function expectSharedGateBadgesVerifying(page: Page, goalId: string): Promise<void> {
	await expect(page.locator(`[data-nav-id="goal:${goalId}"] span[title="${VERIFY_TITLE}"]`).first(), "sidebar gate badge should expose verifying title")
		.toBeVisible({ timeout: 15_000 });
	const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
	await expect(pill.locator(`span[title="${VERIFY_TITLE}"]`).first(), "widget pill shared badge should expose verifying title")
		.toBeVisible({ timeout: 15_000 });
	await ensureGoalWidgetPopoverOpen(page);
	await expect(page.locator(`#goal-status-dropdown span[title="${VERIFY_TITLE}"]`).first(), "widget popover shared badge should expose verifying title")
		.toBeVisible({ timeout: 15_000 });
}

async function expectWidgetPillRerendersOnCacheUpdate(page: Page, goalId: string): Promise<void> {
	await page.evaluate((id) => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		state.gateStatusCache.set(id, {
			passed: 0,
			total: 1,
			verifying: true,
			verifyingCount: 1,
			awaitingSignoffCount: 0,
			awaitingHumanSignoff: false,
			runningGateIds: ["slow-gate"],
			gates: [{ gateId: "slow-gate", status: "pending", effectiveStatus: "running", running: true, awaitingSignoffCount: 0 }],
		});
		window.dispatchEvent(new CustomEvent("bobbit-gate-status-event", { detail: { type: "gate_status_cache_updated", goalId: id } }));
	}, goalId);
	await expect(page.locator("[data-testid='goal-status-widget-pill']").first().locator(`span[title="${VERIFY_TITLE}"]`).first(), "widget pill must rerender when the shared gate summary cache updates")
		.toBeVisible({ timeout: 5_000 });
	await page.evaluate((id) => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		state.gateStatusCache.set(id, {
			passed: 0,
			total: 1,
			verifying: false,
			verifyingCount: 0,
			awaitingSignoffCount: 0,
			awaitingHumanSignoff: false,
			runningGateIds: [],
			gates: [{ gateId: "slow-gate", status: "pending", effectiveStatus: "pending", running: false, awaitingSignoffCount: 0 }],
		});
		window.dispatchEvent(new CustomEvent("bobbit-gate-status-event", { detail: { type: "gate_status_cache_updated", goalId: id } }));
	}, goalId);
	await expect(page.locator("[data-testid='goal-status-widget-pill']").first().locator(`span[title="${VERIFY_TITLE}"]`).first())
		.toHaveCount(0, { timeout: 5_000 });
}

test.describe("Gate status cross-surface active verification", () => {
	test("active verification state is shared across dashboard, sidebar, widget pill/popover, and reload — GATE_STATUS_CROSS_SURFACE_ACTIVE", async ({ page, context }) => {
		test.setTimeout(90_000);
		let setup: SlowWorkflowSetup | undefined;
		let teamLeadId: string | undefined;
		let dashboardPage: Page | undefined;
		try {
			setup = await createSlowWorkflowGoal();
			teamLeadId = await startTeam(setup.goalId);
			await waitForSessionStatus(teamLeadId, "idle", 30_000);

			await openApp(page);
			await openSession(page, teamLeadId);
			await expect(page.locator("[data-testid='goal-status-widget-pill']").first()).toBeVisible({ timeout: 15_000 });
			await expectInitialSharedGateBadge(page, setup.goalId);
			await expectWidgetPillRerendersOnCacheUpdate(page, setup.goalId);

			dashboardPage = await context.newPage();
			await openApp(dashboardPage);
			await openDashboardGates(dashboardPage, setup.goalId);

			await signalSlowGate(setup.goalId);
			await waitForActiveVerification(setup.goalId);

			await expectDashboardRunning(dashboardPage);
			await expectWidgetLocalRunning(page);

			// Exercise rehydration while the 30s command verification is still active.
			await page.reload({ waitUntil: "domcontentloaded" });
			await openSession(page, teamLeadId);
			await expect(page.locator("[data-testid='goal-status-widget-pill']").first()).toBeVisible({ timeout: 15_000 });
			await expectDashboardRunning(dashboardPage);
			await expectWidgetLocalRunning(page);

			await expectSharedGateVerifying(page, setup.goalId);
			await expectSharedGateBadgesVerifying(page, setup.goalId);
		} finally {
			if (dashboardPage) await dashboardPage.close().catch(() => { /* best-effort */ });
			await cleanupSlowWorkflowGoal(setup, teamLeadId);
		}
	});
});
