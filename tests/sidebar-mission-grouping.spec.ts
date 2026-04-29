/**
 * SB-Mission: Sidebar grouping for mission-owned sessions and goals.
 *
 * Regression: under project AGENT-MEMORY, the Commander session "Planning
 * Progress" appeared BOTH inside its mission row AND in the project's
 * general "Sessions" list. Mission Commander sessions and child-goal
 * team-lead/sub-sessions belong only under their owning mission.
 *
 * This test mirrors `src/app/state.ts::getSidebarData()`'s mission-aware
 * filtering via a file:// fixture so it runs without booting the gateway.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/sidebar-mission-grouping.html")}`;

test.describe("Sidebar mission grouping", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
	});

	test("Commander session (s.missionId set) is excluded from ungroupedSessions", async ({ page }) => {
		const result = await page.evaluate(() => {
			const state = {
				gatewaySessions: [
					// Commander session for the mission — should be filtered out.
					{ id: "commander-1", missionId: "m1", createdAt: 1, status: "idle" },
					// Plain session — should remain in ungroupedSessions.
					{ id: "plain-1", createdAt: 2, status: "idle" },
				],
				goals: [],
				missions: [{ id: "m1", state: "planning", archived: false, projectId: "p1" }],
				staffList: [],
			};
			return (window as any).__missionGrouping.buildSidebar(state);
		});

		const ids = result.ungroupedSessions.map((s: any) => s.id);
		expect(ids).toContain("plain-1");
		expect(ids).not.toContain("commander-1");
	});

	test("Child-goal session (transitive via goal.missionId) is NOT in ungrouped (already excluded by goalId)", async ({ page }) => {
		// Sessions with `goalId` are already excluded from ungrouped by the
		// existing rule. We mainly assert the goal itself is not in liveGoals.
		const result = await page.evaluate(() => {
			const state = {
				gatewaySessions: [
					{ id: "team-lead-of-child", goalId: "child-goal", createdAt: 1, status: "idle" },
				],
				goals: [
					{ id: "child-goal", title: "Child", missionId: "m1", archived: false, createdAt: 1 },
					{ id: "standalone-goal", title: "Standalone", archived: false, createdAt: 2 },
				],
				missions: [{ id: "m1", state: "planning", archived: false, projectId: "p1" }],
				staffList: [],
			};
			return (window as any).__missionGrouping.buildSidebar(state);
		});

		// Child goal is mission-owned → excluded from liveGoals.
		const goalIds = result.liveGoals.map((g: any) => g.id);
		expect(goalIds).toContain("standalone-goal");
		expect(goalIds).not.toContain("child-goal");
	});

	test("Archived child goal is excluded from archivedGoals (mission-owned)", async ({ page }) => {
		const result = await page.evaluate(() => {
			const state = {
				gatewaySessions: [],
				goals: [
					{ id: "archived-child", missionId: "m1", archived: true, createdAt: 1 },
					{ id: "archived-standalone", archived: true, createdAt: 2 },
				],
				missions: [{ id: "m1", state: "complete", archived: false, projectId: "p1" }],
				staffList: [],
			};
			return (window as any).__missionGrouping.buildSidebar(state);
		});

		const ids = result.archivedGoals.map((g: any) => g.id);
		expect(ids).toContain("archived-standalone");
		expect(ids).not.toContain("archived-child");
	});

	test("Reviewer session for a child goal is filtered when goal.missionId is set", async ({ page }) => {
		const result = await page.evaluate(() => {
			const state = {
				gatewaySessions: [
					// teamGoalId-only session (verification reviewer for a child goal).
					{ id: "reviewer-1", teamGoalId: "child-goal", createdAt: 1, status: "idle" },
				],
				goals: [
					{ id: "child-goal", missionId: "m1", archived: false, createdAt: 1 },
				],
				missions: [{ id: "m1", state: "planning", archived: false, projectId: "p1" }],
				staffList: [],
			};
			return (window as any).__missionGrouping.buildSidebar(state);
		});
		// teamGoalId already excludes from ungrouped by the original rule.
		expect(result.ungroupedSessions.map((s: any) => s.id)).toEqual([]);
	});

	test("Standalone sessions and goals are NOT filtered when there is no mission", async ({ page }) => {
		const result = await page.evaluate(() => {
			const state = {
				gatewaySessions: [
					{ id: "plain-1", createdAt: 1, status: "idle" },
					{ id: "plain-2", createdAt: 2, status: "idle" },
				],
				goals: [
					{ id: "g1", archived: false, createdAt: 1 },
					{ id: "g2", archived: false, createdAt: 2 },
				],
				missions: [],
				staffList: [],
			};
			return (window as any).__missionGrouping.buildSidebar(state);
		});

		expect(result.ungroupedSessions.map((s: any) => s.id)).toEqual(["plain-1", "plain-2"]);
		expect(result.liveGoals.map((g: any) => g.id)).toEqual(["g1", "g2"]);
	});

	test("isMissionOwnedSession: direct missionId wins", async ({ page }) => {
		const result = await page.evaluate(() => {
			const goalsById = new Map();
			return (window as any).__missionGrouping.isMissionOwnedSession({ id: "x", missionId: "m1" }, goalsById);
		});
		expect(result).toBe(true);
	});

	test("isMissionOwnedSession: transitive via goal.missionId", async ({ page }) => {
		const result = await page.evaluate(() => {
			const goalsById = new Map([["g1", { id: "g1", missionId: "m1" }]]);
			return (window as any).__missionGrouping.isMissionOwnedSession({ id: "x", goalId: "g1" }, goalsById);
		});
		expect(result).toBe(true);
	});

	test("isMissionOwnedSession: standalone goal returns false", async ({ page }) => {
		const result = await page.evaluate(() => {
			const goalsById = new Map([["g1", { id: "g1" }]]);
			return (window as any).__missionGrouping.isMissionOwnedSession({ id: "x", goalId: "g1" }, goalsById);
		});
		expect(result).toBe(false);
	});

	test("isMissionOwnedSession: plain session with no goalId/missionId returns false", async ({ page }) => {
		const result = await page.evaluate(() => {
			const goalsById = new Map();
			return (window as any).__missionGrouping.isMissionOwnedSession({ id: "x" }, goalsById);
		});
		expect(result).toBe(false);
	});
});
