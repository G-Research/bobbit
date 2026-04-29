/**
 * Mission orchestration UI smoke tests.
 *
 * The mission backend (server-side REST routes) is implemented in a separate
 * coder's branch. These tests use `page.route` to mock the `/api/missions*`
 * endpoints so the UI can be exercised independently. They cover the
 * canonical browser-E2E pattern (per AGENTS.md):
 *   1. Navigation to /mission/:id renders the dashboard skeleton.
 *   2. New Mission dialog opens, accepts input, and posts to the backend.
 *   3. Reload persistence — direct hash navigation works after F5.
 *   4. Sidebar Missions subgroup renders when the project has missions.
 *
 * If the backend lands and the response shapes match the contract, the same
 * tests should pass against the live server with the route handlers removed.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, waitForHealth } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MISSION_ID = "11111111-1111-1111-1111-111111111111";

const FAKE_MISSION = {
	id: MISSION_ID,
	projectId: "" as string, // filled in per-test from the live project
	projects: [] as string[],
	title: "Build unified-memory system",
	spec: "## Charter\n\nThe goal is to build the unified memory subsystem.",
	state: "planning" as const,
	createdAt: Date.now(),
	updatedAt: Date.now(),
	workflowId: "mission",
	divergencePolicy: "strict" as const,
	maxConcurrentGoals: 3,
	plan: {
		goals: [
			{ planId: "01HZ0", title: "Schema migration", spec: "Migrate schema", workflowId: "feature" },
			{ planId: "01HZ1", title: "API endpoints", spec: "Build endpoints", workflowId: "feature" },
			{ planId: "01HZ2", title: "UI integration", spec: "Wire UI", workflowId: "feature" },
		],
		dependencies: [
			{ from: "01HZ0", to: "01HZ1" },
			{ from: "01HZ1", to: "01HZ2" },
		],
		rationale: "Schema first, then API, then UI.",
		estimatedConcurrency: 1,
		version: 1,
	},
};

async function mockMissions(page: import("@playwright/test").Page, mission: typeof FAKE_MISSION) {
	const handler = async (route: import("@playwright/test").Route, request: import("@playwright/test").Request) => {
		const url = new URL(request.url());
		const path = url.pathname;
		const method = request.method();

		// LIST
		if (path === "/api/missions" && method === "GET") {
			await route.fulfill({
				status: 200, contentType: "application/json",
				body: JSON.stringify({ missions: [mission] }),
			});
			return;
		}
		// CREATE
		if (path === "/api/missions" && method === "POST") {
			const body = JSON.parse(request.postData() || "{}");
			const created = { ...mission, ...body, id: MISSION_ID };
			await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(created) });
			return;
		}
		// DETAIL
		if (path === `/api/missions/${MISSION_ID}` && method === "GET") {
			await route.fulfill({
				status: 200, contentType: "application/json",
				body: JSON.stringify({
					mission,
					plan: mission.plan,
					children: [],
					gates: [],
				}),
			});
			return;
		}
		// GATES
		if (path === `/api/missions/${MISSION_ID}/gates` && method === "GET") {
			await route.fulfill({
				status: 200, contentType: "application/json",
				body: JSON.stringify({
					gates: [
						{ gateId: "charter", name: "Mission Charter", status: "passed" },
						{ gateId: "plan-review", name: "Plan Review", status: "verifying" },
						{ gateId: "goal-plan", name: "Goal Plan Approval", status: "pending" },
					],
				}),
			});
			return;
		}
		// fallthrough: 404
		await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
	};
	await page.route("**/api/missions", handler);
	await page.route("**/api/missions?**", handler);
	await page.route("**/api/missions/**", handler);
}

test.describe("Mission UI (mocked backend)", () => {
	test("mission dashboard renders header, DAG and gates @smoke", async ({ page }) => {
		await mockMissions(page, FAKE_MISSION);
		await openApp(page);
		await navigateToHash(page, `#/mission/${MISSION_ID}`);

		await expect(page.getByTestId("mission-dashboard")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId("mission-title")).toHaveText("Build unified-memory system");
		await expect(page.getByTestId("mission-state-pill")).toContainText(/planning/i);
		await expect(page.getByTestId("mission-dag-svg")).toBeVisible();
		await expect(page.getByTestId("mission-gates-list")).toBeVisible();
		// 3 gates present
		await expect(page.getByTestId("mission-gates-list").locator("li")).toHaveCount(3);

		// Plan tab toggles
		await page.getByTestId("mission-tab-plan").click();
		await expect(page.getByTestId("mission-plan-tab")).toBeVisible();
		await expect(page.getByTestId("planned-goal-card")).toHaveCount(3);
	});

	test("dashboard persists after reload (direct hash navigation)", async ({ page }) => {
		await mockMissions(page, FAKE_MISSION);
		await openApp(page);
		await navigateToHash(page, `#/mission/${MISSION_ID}`);
		await expect(page.getByTestId("mission-dashboard")).toBeVisible({ timeout: 10_000 });

		// page.route handlers persist across reload on the same page object,
		// so the existing mocks remain active for the post-reload fetches.
		await page.reload();
		// Wait for the app shell to finish booting before asserting on the
		// dashboard — otherwise on a slow reload we race the SPA's route
		// resolution and time out before the dashboard mounts.
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId("mission-dashboard")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("mission-title")).toHaveText("Build unified-memory system");
	});

	test("plan approval signals goal-plan gate @smoke", async ({ page }) => {
		let signalRequestBody: string | null = null;
		let signalRequestCount = 0;
		const mission = FAKE_MISSION;

		const handler = async (
			route: import("@playwright/test").Route,
			request: import("@playwright/test").Request,
		) => {
			const url = new URL(request.url());
			const path = url.pathname;
			const method = request.method();

			if (path === `/api/missions/${MISSION_ID}/gates/goal-plan/signal` && method === "POST") {
				signalRequestCount++;
				signalRequestBody = request.postData();
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ ok: true }),
				});
				return;
			}
			if (path === "/api/missions" && method === "GET") {
				await route.fulfill({
					status: 200, contentType: "application/json",
					body: JSON.stringify({ missions: [mission] }),
				});
				return;
			}
			if (path === `/api/missions/${MISSION_ID}` && method === "GET") {
				await route.fulfill({
					status: 200, contentType: "application/json",
					body: JSON.stringify({
						mission, plan: mission.plan, children: [], gates: [],
					}),
				});
				return;
			}
			if (path === `/api/missions/${MISSION_ID}/gates` && method === "GET") {
				await route.fulfill({
					status: 200, contentType: "application/json",
					body: JSON.stringify({
						gates: [
							{ gateId: "charter", name: "Mission Charter", status: "passed" },
							{ gateId: "plan-review", name: "Plan Review", status: "passed" },
							{ gateId: "goal-plan", name: "Goal Plan Approval", status: "pending" },
						],
					}),
				});
				return;
			}
			await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
		};
		await page.route("**/api/missions", handler);
		await page.route("**/api/missions?**", handler);
		await page.route("**/api/missions/**", handler);

		await openApp(page);
		await navigateToHash(page, `#/mission/${MISSION_ID}`);
		await expect(page.getByTestId("mission-dashboard")).toBeVisible({ timeout: 10_000 });

		await page.getByTestId("mission-tab-plan").click();
		const btn = page.getByTestId("mission-approve-plan-btn");
		await expect(btn).toBeVisible();
		await expect(btn).toBeEnabled();
		await btn.click();

		const toast = page.getByTestId("mission-toast");
		await expect(toast).toBeVisible({ timeout: 5_000 });
		await expect(toast).toHaveAttribute("data-kind", "success");

		expect(signalRequestCount).toBeGreaterThanOrEqual(1);
		expect(signalRequestBody).not.toBeNull();
		const parsed = JSON.parse(signalRequestBody!);
		expect(typeof parsed.content).toBe("string");
		expect(parsed.content).toContain("Approved Plan");
		expect(parsed.content).toContain("Schema migration");
	});

	test("Commander session embedded in dashboard @smoke", async ({ page }) => {
		const COMMANDER_ID = "abc-session";
		const missionWithCommander = { ...FAKE_MISSION, commanderSessionId: COMMANDER_ID };

		const handler = async (
			route: import("@playwright/test").Route,
			request: import("@playwright/test").Request,
		) => {
			const url = new URL(request.url());
			const path = url.pathname;
			const method = request.method();

			if (path === "/api/missions" && method === "GET") {
				await route.fulfill({
					status: 200, contentType: "application/json",
					body: JSON.stringify({ missions: [missionWithCommander] }),
				});
				return;
			}
			if (path === `/api/missions/${MISSION_ID}` && method === "GET") {
				await route.fulfill({
					status: 200, contentType: "application/json",
					body: JSON.stringify({
						mission: missionWithCommander,
						plan: missionWithCommander.plan,
						children: [],
						gates: [],
						commanderSessionId: COMMANDER_ID,
					}),
				});
				return;
			}
			if (path === `/api/missions/${MISSION_ID}/gates` && method === "GET") {
				await route.fulfill({
					status: 200, contentType: "application/json",
					body: JSON.stringify({ gates: [] }),
				});
				return;
			}
			await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
		};
		await page.route("**/api/missions", handler);
		await page.route("**/api/missions?**", handler);
		await page.route("**/api/missions/**", handler);

		await openApp(page);
		await navigateToHash(page, `#/mission/${MISSION_ID}`);
		await expect(page.getByTestId("mission-dashboard")).toBeVisible({ timeout: 10_000 });

		// Embed wrapper present and tagged with the session id.
		const embed = page.getByTestId("mission-commander-embed");
		await expect(embed).toBeVisible();
		await expect(embed).toHaveAttribute("data-session-id", COMMANDER_ID);

		// The actual <agent-interface> custom element is mounted inside the
		// embed wrapper and carries the session id as a stable attribute.
		const ai = page.locator(`agent-interface[data-session-id="${COMMANDER_ID}"]`);
		await expect(ai).toHaveCount(1);

		// The legacy navigate-away link is replaced by the embed; the
		// "Open full →" affordance remains available alongside it.
		await expect(page.getByTestId("mission-commander-link")).toHaveCount(0);
		await expect(page.getByTestId("mission-commander-open-link")).toBeVisible();

		// Placeholder is hidden when the session id is set.
		await expect(page.getByTestId("mission-commander-placeholder")).toHaveCount(0);
	});

	test("Commander placeholder shown when session not yet created", async ({ page }) => {
		// commanderSessionId omitted — mission still being created.
		await mockMissions(page, FAKE_MISSION);
		await openApp(page);
		await navigateToHash(page, `#/mission/${MISSION_ID}`);
		await expect(page.getByTestId("mission-dashboard")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId("mission-commander-placeholder")).toBeVisible();
		await expect(page.getByTestId("mission-commander-embed")).toHaveCount(0);
	});

	test("new mission button creates a mission-assistant session @smoke", async ({ page }) => {
		await waitForHealth();
		// Register a project so the per-project Missions subgroup renders with a + button.
		const rootPath = join(tmpdir(), `bobbit-mission-asst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(rootPath, { recursive: true });
		const projResp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `mission-asst-proj`, rootPath }),
		});
		expect(projResp.status).toBe(201);
		const proj = await projResp.json();

		// Stub mission detail/list so the dashboard mocks earlier tests don't matter.
		// We only assert the assistant session creation here, not the dashboard.
		try {
			// Capture the POST /api/sessions request body so we can assert
			// it carries `assistantType: "mission"`. We don't intercept the
			// response — the live server should accept it and create a session.
			const seenBodies: string[] = [];
			await page.route("**/api/sessions", async (route, request) => {
				if (request.method() === "POST") {
					const body = request.postData() || "";
					seenBodies.push(body);
				}
				await route.continue();
			});

			await openApp(page);

			// Wait for the per-project + mission button. There is one per project that has a Missions subgroup.
			// At this point no missions exist, so the subgroup may be hidden — use the project-row in sidebar.
			// Force the missions subgroup to appear by creating one mission first via API.
			const createResp = await apiFetch("/api/missions", {
				method: "POST",
				body: JSON.stringify({
					projectId: proj.id,
					title: "Seed mission",
					spec: "Seed.",
				}),
			});
			expect([200, 201]).toContain(createResp.status);

			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 20_000 });

			// Click the + button for missions in this project.
			const btn = page.locator(`[data-testid="new-mission-btn"]`).first();
			await expect(btn).toBeVisible({ timeout: 15_000 });
			await btn.click();

			// Wait for a POST /api/sessions to fire with assistantType: "mission".
			await expect.poll(() => seenBodies.some(b => {
				try { return JSON.parse(b)?.assistantType === "mission"; } catch { return false; }
			}), { timeout: 10_000 }).toBeTruthy();

			const missionBody = seenBodies.map(b => { try { return JSON.parse(b); } catch { return {}; } }).find(b => b.assistantType === "mission");
			expect(missionBody.assistantType).toBe("mission");
			expect(missionBody.projectId).toBe(proj.id);
			expect(typeof missionBody.cwd).toBe("string");
		} finally {
			await apiFetch(`/api/projects/${proj.id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("Restart planning button POSTs /plan/restart and reloads detail @smoke", async ({ page }) => {
		let restartCount = 0;
		const mission = FAKE_MISSION;

		const handler = async (
			route: import("@playwright/test").Route,
			request: import("@playwright/test").Request,
		) => {
			const url = new URL(request.url());
			const path = url.pathname;
			const method = request.method();

			if (path === `/api/missions/${MISSION_ID}/plan/restart` && method === "POST") {
				restartCount++;
				await route.fulfill({
					status: 200, contentType: "application/json",
					body: JSON.stringify({ ok: true }),
				});
				return;
			}
			if (path === "/api/missions" && method === "GET") {
				await route.fulfill({
					status: 200, contentType: "application/json",
					body: JSON.stringify({ missions: [mission] }),
				});
				return;
			}
			if (path === `/api/missions/${MISSION_ID}` && method === "GET") {
				await route.fulfill({
					status: 200, contentType: "application/json",
					body: JSON.stringify({ mission, plan: mission.plan, children: [], gates: [] }),
				});
				return;
			}
			if (path === `/api/missions/${MISSION_ID}/gates` && method === "GET") {
				await route.fulfill({
					status: 200, contentType: "application/json",
					body: JSON.stringify({ gates: [] }),
				});
				return;
			}
			await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
		};
		await page.route("**/api/missions", handler);
		await page.route("**/api/missions?**", handler);
		await page.route("**/api/missions/**", handler);

		// Auto-confirm the native confirm() dialog raised by onRestartPlanning.
		page.on("dialog", d => d.accept());

		await openApp(page);
		await navigateToHash(page, `#/mission/${MISSION_ID}`);
		await expect(page.getByTestId("mission-dashboard")).toBeVisible({ timeout: 10_000 });

		const btn = page.getByTestId("mission-restart-planning-btn");
		await expect(btn).toBeVisible();
		await btn.click();

		const toast = page.getByTestId("mission-toast");
		await expect(toast).toBeVisible({ timeout: 5_000 });
		await expect(toast).toHaveAttribute("data-kind", "success");
		expect(restartCount).toBeGreaterThanOrEqual(1);
	});

	test("sidebar renders Commander session row nested under mission @smoke", async ({ page }) => {
		const COMMANDER_ID = "sidebar-commander-id";

		await openApp(page);

		// Mutate the in-memory app state directly to inject a mission + its
		// Commander session against the active project. Done this way (rather
		// than mocking GET /api/missions) so the mission's `projectId` lines
		// up with the real bucket the sidebar projects renderer uses.
		await page.evaluate(({ missionId, cmdId }) => {
			const w = window as any;
			if (!w.bobbitState) throw new Error("bobbitState not exposed");
			const projectId = w.bobbitState.projects[0]?.id;
			if (!projectId) throw new Error("no project loaded");
			w.bobbitState.gatewaySessions.push({
				id: cmdId,
				title: "Commander",
				role: "commander",
				accessory: "flag",
				status: "idle",
				createdAt: Date.now(),
				lastActivity: Date.now(),
				projectId,
			});
			w.bobbitState.missions.push({
				id: missionId,
				projectId,
				projects: [projectId],
				title: "Sidebar Mission",
				spec: "",
				state: "planning",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				workflowId: "mission",
				divergencePolicy: "strict",
				maxConcurrentGoals: 3,
				commanderSessionId: cmdId,
			});
		}, { missionId: MISSION_ID, cmdId: COMMANDER_ID });

		// Trigger a re-render so the mission appears in the sidebar. We do
		// this by toggling the hash (forcing the router to re-resolve); a
		// no-op hashchange triggers renderApp().
		await navigateToHash(page, "#/");

		// Force a render cycle by dispatching a custom event the app listens
		// to on hashchange. Simplest: trigger window-level event dispatch via
		// the sidebar's known re-render path — click the project header.
		await page.evaluate(() => { (window as any).bobbitRenderApp?.(); });

		const missionGroup = page.locator(`[data-testid="mission-group"][data-mission-id="${MISSION_ID}"]`);
		await expect(missionGroup).toBeVisible({ timeout: 10_000 });

		// Expand if not already.
		const expandSpan = missionGroup.locator("span").filter({ hasText: /▸|▾/ }).first();
		const content = await expandSpan.textContent();
		if (content?.includes("▸")) {
			await expandSpan.click();
		}

		// Commander row appears under the mission.
		const commanderRow = missionGroup.locator(`[data-testid="mission-commander-row"]`);
		await expect(commanderRow).toBeVisible({ timeout: 5_000 });
		await expect(commanderRow.locator(`[data-session-id="${COMMANDER_ID}"]`)).toBeVisible();
	});

	test("renders error state for unknown mission id", async ({ page }) => {
		// Route returns 404 for the detail endpoint, mission not in list.
		const handler = async (route: import("@playwright/test").Route) => {
			await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
		};
		await page.route("**/api/missions", handler);
		await page.route("**/api/missions?**", handler);
		await page.route("**/api/missions/**", handler);
		await openApp(page);
		await navigateToHash(page, `#/mission/${MISSION_ID}`);
		await expect(page.getByTestId("mission-dashboard-error")).toBeVisible({ timeout: 10_000 });
	});
});
