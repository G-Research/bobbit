/**
 * Unit tests for sidebar goal rendering user stories:
 * SB-09 (goal gate badge), SB-10 (PR status badge), SB-11 (goal setup status),
 * SB-12 (empty state), SB-13 (shelved goal opacity), SB-30 (provisional project).
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/sidebar-goal-rendering.html")}`;

// Helper type for page.evaluate calls
declare global {
	interface Window {
		getGoalBadgeInfo: (
			goalId: string,
			gateStatusCache: Map<string, any>,
			prStatusCache: Map<string, any>,
			sessions: any[],
		) => any;
		getEmptyState: (archived: boolean, canArchive: boolean, isTeamGoal: boolean) => string;
		getSetupIndicator: (setupStatus: string | undefined) => string;
		getGoalOpacity: (goalState: string) => string;
		isProvisionalProject: (project: { provisional?: boolean }) => boolean;
	}
}

test.describe("SB-09: Goal gate badge", () => {
	test("no gate status returns type 'none'", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const gates = new Map();
			const prs = new Map();
			return window.getGoalBadgeInfo("g1", gates, prs, []);
		});
		expect(result).toEqual({ type: "none" });
	});

	test("gate status shows passed/total", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const gates = new Map([["g1", { passed: 2, total: 5, verifying: false, verifyingCount: 0 }]]);
			const prs = new Map();
			return window.getGoalBadgeInfo("g1", gates, prs, []);
		});
		expect(result.type).toBe("gate");
		expect(result.passed).toBe(2);
		expect(result.total).toBe(5);
	});

	test("allPassed is true when passed equals total", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const gates = new Map([["g1", { passed: 5, total: 5, verifying: false, verifyingCount: 0 }]]);
			const prs = new Map();
			const sessions = [{ goalId: "g1", role: "team-lead", status: "idle", delegateOf: null, isCompacting: false }];
			return window.getGoalBadgeInfo("g1", gates, prs, sessions);
		});
		expect(result.allPassed).toBe(true);
		expect(result.color).toBe("#22c55e");
	});

	test("verifying state is reported", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const gates = new Map([["g1", { passed: 2, total: 5, verifying: true, verifyingCount: 1 }]]);
			const prs = new Map();
			return window.getGoalBadgeInfo("g1", gates, prs, []);
		});
		expect(result.verifying).toBe(true);
		expect(result.verifyingCount).toBe(1);
	});

	test("anyAgentWorking when agent is streaming", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
			const prs = new Map();
			const sessions = [
				{ goalId: "g1", role: "team-lead", status: "streaming", delegateOf: null, isCompacting: false },
			];
			return window.getGoalBadgeInfo("g1", gates, prs, sessions);
		});
		expect(result.anyAgentWorking).toBe(true);
		expect(result.color).toBe("#3b82f6");
	});

	test("anyAgentWorking when agent is busy", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
			const prs = new Map();
			const sessions = [
				{ goalId: "g1", role: "coder", status: "busy", delegateOf: null, isCompacting: false },
				{ goalId: "g1", role: "team-lead", status: "idle", delegateOf: null, isCompacting: false },
			];
			return window.getGoalBadgeInfo("g1", gates, prs, sessions);
		});
		expect(result.anyAgentWorking).toBe(true);
	});

	test("anyAgentWorking when agent is compacting", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
			const prs = new Map();
			const sessions = [
				{ goalId: "g1", role: "team-lead", status: "idle", delegateOf: null, isCompacting: true },
			];
			return window.getGoalBadgeInfo("g1", gates, prs, sessions);
		});
		expect(result.anyAgentWorking).toBe(true);
	});

	test("no team (no team-lead) shows muted color", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
			const prs = new Map();
			// No team-lead session
			return window.getGoalBadgeInfo("g1", gates, prs, []);
		});
		expect(result.hasTeam).toBe(false);
		expect(result.color).toBe("#6b7280");
	});

	test("idle team with incomplete gates shows default team color", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
			const prs = new Map();
			const sessions = [
				{ goalId: "g1", role: "team-lead", status: "idle", delegateOf: null, isCompacting: false },
			];
			return window.getGoalBadgeInfo("g1", gates, prs, sessions);
		});
		expect(result.hasTeam).toBe(true);
		expect(result.color).toBe("#7a8ea8");
	});

	test("delegates are excluded from agent working check", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
			const prs = new Map();
			const sessions = [
				{ goalId: "g1", role: "team-lead", status: "idle", delegateOf: null, isCompacting: false },
				// This delegate is streaming but should be excluded
				{ goalId: "g1", role: "coder", status: "streaming", delegateOf: "parent-id", isCompacting: false },
			];
			return window.getGoalBadgeInfo("g1", gates, prs, sessions);
		});
		expect(result.anyAgentWorking).toBe(false);
	});

	test("teamGoalId sessions count toward goal agents", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
			const prs = new Map();
			const sessions = [
				{ goalId: "other", teamGoalId: "g1", role: "team-lead", status: "streaming", delegateOf: null, isCompacting: false },
			];
			return window.getGoalBadgeInfo("g1", gates, prs, sessions);
		});
		expect(result.hasTeam).toBe(true);
		expect(result.anyAgentWorking).toBe(true);
	});
});

test.describe("SB-10: PR status badge", () => {
	test("PR takes priority over gate status", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const gates = new Map([["g1", { passed: 2, total: 5, verifying: false, verifyingCount: 0 }]]);
			const prs = new Map([["g1", { state: "OPEN", reviewDecision: null, mergeable: "MERGEABLE", url: "https://pr" }]]);
			return window.getGoalBadgeInfo("g1", gates, prs, []);
		});
		expect(result.type).toBe("pr");
	});

	test("MERGED PR → purple color", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const prs = new Map([["g1", { state: "MERGED" }]]);
			return window.getGoalBadgeInfo("g1", new Map(), prs, []);
		});
		expect(result.color).toBe("#a87fd4");
	});

	test("CLOSED PR → red color", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const prs = new Map([["g1", { state: "CLOSED" }]]);
			return window.getGoalBadgeInfo("g1", new Map(), prs, []);
		});
		expect(result.color).toBe("#c47070");
	});

	test("OPEN + APPROVED → green color", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const prs = new Map([["g1", { state: "OPEN", reviewDecision: "APPROVED" }]]);
			return window.getGoalBadgeInfo("g1", new Map(), prs, []);
		});
		expect(result.color).toBe("#6bc485");
	});

	test("OPEN + CHANGES_REQUESTED → red color", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const prs = new Map([["g1", { state: "OPEN", reviewDecision: "CHANGES_REQUESTED" }]]);
			return window.getGoalBadgeInfo("g1", new Map(), prs, []);
		});
		expect(result.color).toBe("#c47070");
	});

	test("OPEN + REVIEW_REQUIRED → gold color", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const prs = new Map([["g1", { state: "OPEN", reviewDecision: "REVIEW_REQUIRED" }]]);
			return window.getGoalBadgeInfo("g1", new Map(), prs, []);
		});
		expect(result.color).toBe("#d4a04a");
	});

	test("OPEN with no review decision → default green", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const prs = new Map([["g1", { state: "OPEN", reviewDecision: null }]]);
			return window.getGoalBadgeInfo("g1", new Map(), prs, []);
		});
		expect(result.color).toBe("#6bc485");
	});

	test("OPEN + CONFLICTING → hasConflicts true", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const prs = new Map([["g1", { state: "OPEN", reviewDecision: null, mergeable: "CONFLICTING" }]]);
			return window.getGoalBadgeInfo("g1", new Map(), prs, []);
		});
		expect(result.hasConflicts).toBe(true);
	});

	test("non-OPEN PR does not have conflicts even if mergeable is CONFLICTING", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const prs = new Map([["g1", { state: "MERGED", mergeable: "CONFLICTING" }]]);
			return window.getGoalBadgeInfo("g1", new Map(), prs, []);
		});
		expect(result.hasConflicts).toBe(false);
	});

	test("PR with url includes it", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const prs = new Map([["g1", { state: "OPEN", url: "https://github.com/repo/pull/42" }]]);
			return window.getGoalBadgeInfo("g1", new Map(), prs, []);
		});
		expect(result.url).toBe("https://github.com/repo/pull/42");
	});

	test("PR without url has null url", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const prs = new Map([["g1", { state: "OPEN" }]]);
			return window.getGoalBadgeInfo("g1", new Map(), prs, []);
		});
		expect(result.url).toBeNull();
	});
});

test.describe("SB-11: Goal setup status indicator", () => {
	test("'preparing' → spinner", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.getSetupIndicator("preparing"));
		expect(result).toBe("spinner");
	});

	test("'error' → warning", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.getSetupIndicator("error"));
		expect(result).toBe("warning");
	});

	test("'ready' → none", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.getSetupIndicator("ready"));
		expect(result).toBe("none");
	});

	test("undefined → none", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.getSetupIndicator(undefined));
		expect(result).toBe("none");
	});
});

test.describe("SB-12: Empty state logic", () => {
	test("archived goal → 'archived'", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.getEmptyState(true, false, true));
		expect(result).toBe("archived");
	});

	test("canArchive (merged PR, no team) → 'archive-goal'", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.getEmptyState(false, true, true));
		expect(result).toBe("archive-goal");
	});

	test("team goal → 'start-team'", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.getEmptyState(false, false, true));
		expect(result).toBe("start-team");
	});

	test("non-team goal → 'start-session'", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.getEmptyState(false, false, false));
		expect(result).toBe("start-session");
	});
});

test.describe("SB-13: Shelved goal opacity", () => {
	test("shelved → 'opacity-60'", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.getGoalOpacity("shelved"));
		expect(result).toBe("opacity-60");
	});

	test("in-progress → empty string", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.getGoalOpacity("in-progress"));
		expect(result).toBe("");
	});

	test("complete → empty string", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.getGoalOpacity("complete"));
		expect(result).toBe("");
	});

	test("todo → empty string", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.getGoalOpacity("todo"));
		expect(result).toBe("");
	});
});

test.describe("SB-30: Provisional project indicator", () => {
	test("provisional: true → true", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.isProvisionalProject({ provisional: true }));
		expect(result).toBe(true);
	});

	test("provisional: false → false", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.isProvisionalProject({ provisional: false }));
		expect(result).toBe(false);
	});

	test("no provisional property → false", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => window.isProvisionalProject({}));
		expect(result).toBe(false);
	});
});
