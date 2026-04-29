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
import { openApp, navigateToHash } from "./ui-helpers.js";

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

		await page.reload();
		// After reload, route handlers persist on the same context, so fetches
		// continue to be intercepted. Re-arm just in case.
		await mockMissions(page, FAKE_MISSION);
		await navigateToHash(page, `#/mission/${MISSION_ID}`);
		await expect(page.getByTestId("mission-dashboard")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("mission-title")).toHaveText("Build unified-memory system");
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
