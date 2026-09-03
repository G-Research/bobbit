/**
 * Journey: Crash + Restart — v2 browser smoke
 * Covers: journey-crash-restart
 * Consolidated from: sidebar-tree-restart, steer-gateway-restart,
 *   bg-process-persistence, preview-durable-restart, etc.
 *
 * Uses the crash()/restart() fixture from gateway-harness.ts. Generic durable
 * state is bundled around two restarts; live reconnect remains covered by the
 * stories-resilience and background-process persistence journeys.
 */
import { test, expect, type GatewayInfo } from "../../../tests/support/harnesses/browser/gateway-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession, seedTeamLeadHeader, waitForSessionStatus } from "../../../tests/support/harnesses/browser/e2e-setup.js";
import { openApp, navigateToHash } from "../../../tests/support/helpers/browser/journeys/journey-fixture.js";

async function crashAndRestart(gateway: GatewayInfo): Promise<void> {
	await gateway.crash();
	await expect.poll(
		async () => {
			try {
				const response = await apiFetch("/health");
				return response.status === 200;
			} catch {
				return false;
			}
		},
		{ timeout: 20_000, intervals: [250], message: "gateway should stop before restart" },
	).toBe(false);
	await gateway.restart();
	await expect.poll(
		async () => {
			try {
				const response = await apiFetch("/health");
				return response.status === 200;
			} catch {
				return false;
			}
		},
		{ timeout: 20_000, intervals: [250], message: "gateway should be healthy after restart" },
	).toBe(true);
}

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

test.describe("Journey: Crash + Restart", () => {
	test("API state remains durable across a gateway restart", async ({ gateway }) => {
		test.setTimeout(120_000);
		const cleanup = { sessionIds: [] as string[] };
		let sessionId = "";

		try {
			await test.step("create a session and preview mount before crash", async () => {
				sessionId = await createSession();
				cleanup.sessionIds.push(sessionId);
				await waitForSessionStatus(sessionId, "idle");

				const patchResponse = await apiFetch(`/api/sessions/${sessionId}`, {
					method: "PATCH",
					body: JSON.stringify({ preview: true }),
				});
				expect(patchResponse.status).toBe(200);
				const mountResponse = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
					method: "POST",
					body: JSON.stringify({ html: "<!DOCTYPE html><body>crash-test</body>", entry: "crash-test.html" }),
				});
				expect(mountResponse.status).toBe(200);
				const mountBody = await mountResponse.json() as { entry: string };
				expect(mountBody.entry).toBe("crash-test.html");
			});

			await test.step("crash and restart the gateway in strict order", async () => {
				await crashAndRestart(gateway);
				const healthResponse = await apiFetch("/health");
				expect(healthResponse.status).toBe(200);
			});

			await test.step("session identity remains accessible through the API", async () => {
				const response = await apiFetch(`/api/sessions/${sessionId}`);
				expect(response.status).toBe(200);
				const data = await response.json() as { id: string };
				expect(data.id).toBe(sessionId);
			});

			await test.step("preview entry and content hash remain accessible through the API", async () => {
				const response = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`);
				expect(response.status).toBe(200);
				const body = await response.json() as { entry?: string; contentHash?: string };
				expect(body.entry).toBe("crash-test.html");
				expect(body.contentHash).toMatch(/^[a-f0-9]{64}$/);
			});
		} finally {
			for (const id of cleanup.sessionIds.reverse()) {
				await deleteSession(id).catch(() => {});
			}
		}
	});

	test("browser and operator-paused state remain durable across a gateway restart", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const cleanup = {
			sessionIds: [] as string[],
			goalIds: [] as string[],
		};
		const treeStateKey = "bobbit-sidebar-tree-state:v1";
		let parentId = "";
		let childId = "";
		let sessionId = "";
		let treeStateNodeKey = "";
		let treeStateBefore: string | null = null;

		try {
			await test.step("create a blocked child and persist an operator pause before crash", async () => {
				const parent = await createGoal({
					title: `operator pause restart parent ${Date.now()}`,
					team: false,
					worktree: false,
					autoStartTeam: false,
					subgoalsAllowed: true,
				});
				parentId = parent.id as string;
				cleanup.goalIds.push(parentId);

				await spawnChildWithDependencies(gateway, parentId, "unresolved-dependency");
				const child = await spawnChildWithDependencies(gateway, parentId, "operator-paused-dependent", ["unresolved-dependency"]);
				childId = child.id as string;
				expect(childId).toBeTruthy();
				treeStateNodeKey = `sidebar-tree/v1/goal/${childId}`;

				await expect.poll(async () => {
					const goal = await readGoal(childId);
					return { state: goal.state, paused: goal.paused, dependsOnPlanIds: goal.dependsOnPlanIds };
				}, { timeout: 20_000, message: "dependent child must be blocked while its sibling dependency is unresolved" }).toEqual({
					state: "blocked",
					paused: undefined,
					dependsOnPlanIds: ["unresolved-dependency"],
				});

				await openApp(page);
				await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
				await navigateToHash(page, `#/goal/${childId}`);
				const pauseButton = page.getByTestId("goal-pause-btn");
				await expect(pauseButton).toBeVisible({ timeout: 20_000 });
				await pauseButton.click();
				await expect(page.getByTestId("goal-resume-btn"), "the dashboard should immediately render the operator-paused state").toBeVisible({ timeout: 20_000 });

				await expect.poll(async () => {
					const goal = await readGoal(childId);
					return { state: goal.state, paused: goal.paused, pauseSource: goal.pauseSource, dependsOnPlanIds: goal.dependsOnPlanIds };
				}, { timeout: 20_000, message: "the UI pause must persist operator provenance before restart" }).toEqual({
					state: "blocked",
					paused: true,
					pauseSource: "operator",
					dependsOnPlanIds: ["unresolved-dependency"],
				});
			});

			await test.step("create a session and prove the pre-crash editor and browser state", async () => {
				sessionId = await createSession();
				cleanup.sessionIds.push(sessionId);
				await waitForSessionStatus(sessionId, "idle");
				await navigateToHash(page, `#/session/${sessionId}`);
				await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

				const connectionStatus = await page.evaluate(() => (window as any).bobbitState?.connectionStatus ?? "unknown");
				expect(typeof connectionStatus).toBe("string");
				await page.waitForLoadState("networkidle");
				await page.evaluate(({ storageKey, nodeKey }) => {
					const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{\"version\":1,\"expansion\":{}}") as {
						version: number;
						expansion: Record<string, "expanded" | "collapsed">;
						explicitRevealDepthByProject?: Record<string, number>;
					};
					stored.version = 1;
					stored.expansion ??= {};
					stored.expansion[nodeKey] = "expanded";
					stored.expansion = Object.fromEntries(Object.entries(stored.expansion).sort(([a], [b]) => a.localeCompare(b)));
					localStorage.setItem(storageKey, JSON.stringify(stored));
				}, { storageKey: treeStateKey, nodeKey: treeStateNodeKey });
				treeStateBefore = await page.evaluate((key) => localStorage.getItem(key), treeStateKey);
				expect(treeStateBefore).toBeTruthy();
			});

			await test.step("crash and restart the gateway before reloading the browser", async () => {
				await crashAndRestart(gateway);
				await page.reload({ waitUntil: "domcontentloaded" });
			});

			await test.step("the shell and pre-crash session editor recover after reload", async () => {
				await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
				await navigateToHash(page, `#/session/${sessionId}`);
				await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
				const hash = await page.evaluate(() => window.location.hash);
				expect(hash).toContain(sessionId);
				const connectionStatus = await page.evaluate(() => (window as any).bobbitState?.connectionStatus ?? "unknown");
				expect(["connected", "reconnecting", "disconnected"]).toContain(connectionStatus);
			});

			await test.step("the blocked child retains operator pause provenance and Resume UI", async () => {
				await expect.poll(async () => {
					const goal = await readGoal(childId);
					return { state: goal.state, paused: goal.paused, pauseSource: goal.pauseSource, dependsOnPlanIds: goal.dependsOnPlanIds };
				}, { timeout: 20_000, message: "restart must retain the operator pause despite its unresolved dependency" }).toEqual({
					state: "blocked",
					paused: true,
					pauseSource: "operator",
					dependsOnPlanIds: ["unresolved-dependency"],
				});
				await navigateToHash(page, `#/goal/${childId}`);
				await expect(page.getByTestId("goal-resume-btn"), "the reloaded dashboard must continue to show the goal as paused").toBeVisible({ timeout: 20_000 });
				await expect(page.getByTestId("goal-pause-btn")).toHaveCount(0);
			});

			await test.step("sidebar tree localStorage state survives restart and reload", async () => {
				const treeStateAfter = await page.evaluate((key) => localStorage.getItem(key), treeStateKey);
				expect(treeStateAfter).toBe(treeStateBefore);
				const parsed = JSON.parse(treeStateAfter!);
				expect(parsed.expansion?.[treeStateNodeKey]).toBe("expanded");
			});
		} finally {
			for (const id of cleanup.sessionIds.reverse()) {
				await deleteSession(id).catch(() => {});
			}
			for (const id of cleanup.goalIds.reverse()) {
				await deleteGoal(id, true).catch(() => {});
			}
		}
	});
});
