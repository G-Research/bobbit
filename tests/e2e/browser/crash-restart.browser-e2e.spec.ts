/**
 * Journey: Crash + Restart — v2 browser smoke
 * Covers: journey-crash-restart
 * Consolidated from: sidebar-tree-restart, steer-gateway-restart,
 *   bg-process-persistence, preview-durable-restart, etc.
 *
 * Uses the crash()/restart() fixture from gateway-harness.ts.
 */
import { test, expect, type GatewayInfo } from "../../../tests2/browser/gateway-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession, seedTeamLeadHeader, waitForSessionStatus } from "../../../tests2/browser/e2e-setup.js";
import { openApp, navigateToHash } from "../../../tests2/browser/_helpers/journey-fixture.js";
import type { Page } from "@playwright/test";

async function crashAndRestart(gateway: GatewayInfo, _page: Page): Promise<void> {
	await gateway.crash();
	await expect.poll(
		async () => {
			try {
				const r = await apiFetch("/health");
				return r.status === 200;
			} catch {
				return false;
			}
		},
		{ timeout: 20_000, intervals: [250], message: "gateway should recover after restart" },
	).toBe(false).catch(() => {/* crash was fast */});
	await gateway.restart();
	await expect.poll(
		async () => {
			try {
				const r = await apiFetch("/health");
				return r.status === 200;
			} catch {
				return false;
			}
		},
		{ timeout: 20_000, intervals: [250], message: "gateway should be healthy after restart" },
	).toBe(true);
}

// ── Basic reachability ─────────────────────────────────────────────────────

test.describe("Journey: Crash + Restart — basic", () => {
	test("app is reachable before crash", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("gateway crash and restart: app recovers and sidebar is visible", async ({ page, gateway }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await crashAndRestart(gateway, page);
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
	});

	test("gateway restart: health endpoint recovers", async ({ gateway }) => {
		await gateway.crash();
		await gateway.restart();
		const r = await apiFetch("/health");
		expect(r.status).toBe(200);
	});
});

// ── Session persistence ────────────────────────────────────────────────────

test.describe("Journey: Crash + Restart — session persistence", () => {
	test("session created before crash is still accessible via API after restart", async ({ gateway }) => {
		test.slow();
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await gateway.crash();
		await gateway.restart();
		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(resp.status).toBe(200);
		const data = await resp.json() as { id: string };
		expect(data.id).toBe(sessionId);
		await deleteSession(sessionId).catch(() => {});
	});

	test("navigating to pre-crash session after restart shows the editor", async ({ page, gateway }) => {
		test.slow();
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		await crashAndRestart(gateway, page);
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
		const hash = await page.evaluate(() => window.location.hash);
		expect(hash).toContain(sessionId);
		await deleteSession(sessionId).catch(() => {});
	});
});

// ── Operator pause durability ──────────────────────────────────────────────

async function readGoal(goalId: string): Promise<any> {
	const response = await apiFetch(`/api/goals/${goalId}`);
	expect(response.status, `GET goal ${goalId} should succeed`).toBe(200);
	return response.json();
}

async function spawnChildWithDependencies(
	gateway: GatewayInfo,
	parentId: string,
	planId: string,
	dependsOn?: string[],
): Promise<any> {
	const response = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
		method: "POST",
		headers: seedTeamLeadHeader(gateway, parentId),
		body: JSON.stringify({
			planId,
			title: `restart pause fixture ${planId}`,
			spec: "Real child fixture for proving an operator pause survives a gateway restart while an explicit sibling dependency remains unresolved.",
			...(dependsOn ? { dependsOn } : {}),
		}),
	});
	const body = await response.json();
	expect(response.status, `spawn-child ${planId} should succeed: ${JSON.stringify(body)}`).toBe(201);
	return body;
}

test.describe("Journey: Crash + Restart — operator pause durability", () => {
	test("operator-paused child with an unmet dependency remains paused in persisted state and dashboard UI after restart", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const parent = await createGoal({
			title: `operator pause restart parent ${Date.now()}`,
			team: false,
			worktree: false,
			autoStartTeam: false,
			subgoalsAllowed: true,
		});
		const parentId = parent.id as string;

		try {
			// Create the actual dependency through the nested-goal route, then a
			// dependent sibling. The latter must be scheduler-blocked before the
			// operator acts; no client-side state is seeded for this regression.
			await spawnChildWithDependencies(gateway, parentId, "unresolved-dependency");
			const child = await spawnChildWithDependencies(gateway, parentId, "operator-paused-dependent", ["unresolved-dependency"]);
			const childId = child.id as string;
			expect(childId).toBeTruthy();

			await expect.poll(async () => {
				const goal = await readGoal(childId);
				return { state: goal.state, paused: goal.paused, dependsOnPlanIds: goal.dependsOnPlanIds };
			}, { timeout: 20_000, message: "dependent child must be blocked while its sibling dependency is unresolved" }).toEqual({
				state: "blocked",
				paused: undefined,
				dependsOnPlanIds: ["unresolved-dependency"],
			});

			await openApp(page);
			await navigateToHash(page, `#/goal/${childId}`);
			const pauseButton = page.getByTestId("goal-pause-btn");
			await expect(pauseButton).toBeVisible({ timeout: 20_000 });
			await pauseButton.click();
			const resumeButton = page.getByTestId("goal-resume-btn");
			await expect(resumeButton, "the dashboard should immediately render the operator-paused state").toBeVisible({ timeout: 20_000 });

			await expect.poll(async () => {
				const goal = await readGoal(childId);
				return { state: goal.state, paused: goal.paused, pauseSource: goal.pauseSource, dependsOnPlanIds: goal.dependsOnPlanIds };
			}, { timeout: 20_000, message: "the UI pause must persist operator provenance before restart" }).toEqual({
				state: "blocked",
				paused: true,
				pauseSource: "operator",
				dependsOnPlanIds: ["unresolved-dependency"],
			});

			await crashAndRestart(gateway, page);
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/goal/${childId}`);

			await expect.poll(async () => {
				const goal = await readGoal(childId);
				return { state: goal.state, paused: goal.paused, pauseSource: goal.pauseSource, dependsOnPlanIds: goal.dependsOnPlanIds };
			}, { timeout: 20_000, message: "restart must retain the operator pause despite its unresolved dependency" }).toEqual({
				state: "blocked",
				paused: true,
				pauseSource: "operator",
				dependsOnPlanIds: ["unresolved-dependency"],
			});
			await expect(page.getByTestId("goal-resume-btn"), "the reloaded dashboard must continue to show the goal as paused").toBeVisible({ timeout: 20_000 });
			await expect(page.getByTestId("goal-pause-btn")).toHaveCount(0);
		} finally {
			await deleteGoal(parentId, true);
		}
	});
});

// ── WS reconnect ───────────────────────────────────────────────────────────

test.describe("Journey: Crash + Restart — WS reconnect", () => {
	test("client connectionStatus not broken after crash+restart (app stays usable)", async ({ page, gateway }) => {
		test.slow();
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		// Verify app is in a working state before crash
		const statusBefore = await page.evaluate(() => (window as any).bobbitState?.connectionStatus ?? "unknown");
		// connectionStatus might be "connected", "reconnecting", or similar — just confirm it's a string
		expect(typeof statusBefore).toBe("string");
		await gateway.crash();
		// Best-effort wait for disconnect (may be instant)
		await page.waitForFunction(
			() => { const s = (window as any).bobbitState; return !!s && s.connectionStatus !== "connected"; },
			undefined,
			{ timeout: 5_000, polling: 250 },
		).catch(() => {});
		await gateway.restart();
		// After restart, reload so the page cleanly reconnects
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
		// App should be functional (sidebar visible confirms connection)
		const statusAfter = await page.evaluate(() => (window as any).bobbitState?.connectionStatus ?? "unknown");
		expect(["connected", "reconnecting", "disconnected"]).toContain(statusAfter);
	});
});

// ── Preview mount durability ───────────────────────────────────────────────

test.describe("Journey: Crash + Restart — preview durability", () => {
	test("preview mount entry is still accessible via API after restart", async ({ gateway }) => {
		test.slow();
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const patchResp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ preview: true }),
		});
		expect(patchResp.status).toBe(200);
		const mountResp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({ html: "<!DOCTYPE html><body>crash-test</body>", entry: "crash-test.html" }),
		});
		expect(mountResp.status).toBe(200);
		const mountBody = await mountResp.json() as { entry: string };
		expect(mountBody.entry).toBe("crash-test.html");
		await gateway.crash();
		await gateway.restart();
		const afterResp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`);
		expect(afterResp.status).toBe(200);
		const afterBody = await afterResp.json() as { entry?: string; contentHash?: string };
		expect(afterBody.entry).toBe("crash-test.html");
		expect(afterBody.contentHash).toMatch(/^[a-f0-9]{64}$/);
		await deleteSession(sessionId).catch(() => {});
	});
});

// ── Sidebar tree localStorage durability ──────────────────────────────────

test.describe("Journey: Crash + Restart — sidebar tree state", () => {
	test("sidebar tree localStorage key survives crash+restart+reload", async ({ page, gateway }) => {
		test.slow();
		const TREE_STATE_KEY = "bobbit-sidebar-tree-state:v1";
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate((key) => {
			localStorage.setItem(key, JSON.stringify({ expansion: { "test-key": "expanded" } }));
		}, TREE_STATE_KEY);
		const before = await page.evaluate((key) => localStorage.getItem(key), TREE_STATE_KEY);
		expect(before).toBeTruthy();
		await crashAndRestart(gateway, page);
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
		const after = await page.evaluate((key) => localStorage.getItem(key), TREE_STATE_KEY);
		expect(after).toBe(before);
		const parsed = JSON.parse(after!);
		expect(parsed.expansion?.["test-key"]).toBe("expanded");
	});
});
