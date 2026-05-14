/**
 * Reproducing test for the "sidebar goal-group sessions ignore Show Busy /
 * Show Read filters" bug.
 *
 * `src/app/render-helpers.ts::renderGoalGroup()` (~line 719) builds the
 * goal-scoped session list without calling `passesSidebarFilters`, so the
 * Show Busy / Show Read toggles in the sidebar filter popover have no effect
 * on sessions rendered under a goal group.  Ungrouped sessions, delegate
 * children, and the equivalent paths in `render.ts` / `sidebar.ts` all call
 * `passesSidebarFilters` correctly — only `renderGoalGroup` forgot.
 *
 * These tests pin the EXPECTED post-fix behaviour:
 *   - filters apply to goal-grouped sessions exactly as they do elsewhere
 *   - team-lead is "sticky" when at least one child survives the filter
 *   - active session is always exempt
 *   - non-empty search bypasses filters
 *   - the goal header path remains intact (empty display list is allowed —
 *     `renderGoalGroup` already renders the goal header above the empty
 *     state)
 *
 * The fixture (tests/sidebar-goal-group-filters.html) intentionally mirrors
 * MASTER (no filter applied), so every filter-related case below FAILS on
 * master.  After the production fix lands, the fixture helper is updated to
 * apply `passesSidebarFilters` + team-lead-sticky and the spec passes.
 *
 * Run: `npx playwright test tests/sidebar-goal-group-filters.spec.ts --reporter=line`
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/sidebar-goal-group-filters.html")}`;

declare global {
	interface Window {
		computeGoalGroupDisplaySessions: (
			goalSessions: any[],
			opts: {
				activeId: string | null;
				showBusy: boolean;
				showRead: boolean;
				searchQuery: string;
				isTeamGoal: boolean;
			},
		) => any[];
		passesSidebarFilters: (
			session: any,
			isActive: boolean,
			bypass: boolean,
			flags: { showBusy: boolean; showRead: boolean },
		) => boolean;
		hasUnseenActivity: (session: any, isActive: boolean) => boolean;
	}
}

// --- session factories ----------------------------------------------------

const NOW = 1_700_000_000_000;

function idleReadSession(over: Partial<any> = {}): any {
	return {
		id: "s-idle-read",
		title: "idle read session",
		cwd: "/x",
		status: "idle",
		role: undefined,
		createdAt: NOW,
		lastActivity: NOW,
		lastReadAt: NOW, // read
		clientCount: 0,
		...over,
	};
}

function idleUnreadSession(over: Partial<any> = {}): any {
	return {
		id: "s-idle-unread",
		title: "idle unread session",
		cwd: "/x",
		status: "idle",
		role: undefined,
		createdAt: NOW,
		lastActivity: NOW + 5_000, // newer than lastReadAt → unseen
		lastReadAt: NOW,
		clientCount: 0,
		...over,
	};
}

function streamingSession(over: Partial<any> = {}): any {
	return {
		id: "s-streaming",
		title: "busy session",
		cwd: "/x",
		status: "streaming",
		role: undefined,
		createdAt: NOW,
		lastActivity: NOW,
		lastReadAt: NOW,
		clientCount: 0,
		...over,
	};
}

const defaultOpts = {
	activeId: null,
	showBusy: true,
	showRead: true,
	searchQuery: "",
	isTeamGoal: false,
};

// ==========================================================================
// Plain (non-team) goal: Show Read toggle
// ==========================================================================

test.describe("plain goal · Show Read filter", () => {
	test("idle read session is hidden when showRead=false", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [[idleReadSession()], { ...defaultOpts, showRead: false }] as any);
		// MASTER bug: still returns ["s-idle-read"] because renderGoalGroup
		// never calls passesSidebarFilters.  After the fix this is [].
		expect(ids).toEqual([]);
	});

	test("idle read session is visible when showRead=true", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [[idleReadSession()], { ...defaultOpts, showRead: true }] as any);
		expect(ids).toEqual(["s-idle-read"]);
	});

	test("idle UNREAD session is visible even when showRead=false (unseen exemption)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [[idleUnreadSession()], { ...defaultOpts, showRead: false }] as any);
		expect(ids).toEqual(["s-idle-unread"]);
	});
});

// ==========================================================================
// Plain (non-team) goal: Show Busy toggle
// ==========================================================================

test.describe("plain goal · Show Busy filter", () => {
	test("streaming session is hidden when showBusy=false", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [[streamingSession()], { ...defaultOpts, showBusy: false }] as any);
		// MASTER bug: returns ["s-streaming"] regardless.  After fix: [].
		expect(ids).toEqual([]);
	});

	test("streaming session is visible when showBusy=true", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [[streamingSession()], { ...defaultOpts, showBusy: true }] as any);
		expect(ids).toEqual(["s-streaming"]);
	});

	test("isCompacting=true counts as busy and is hidden when showBusy=false", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [[idleReadSession({ id: "s-compacting", isCompacting: true })], { ...defaultOpts, showBusy: false }] as any);
		expect(ids).toEqual([]);
	});
});

// ==========================================================================
// Active session exemption
// ==========================================================================

test.describe("active session exemption", () => {
	test("active idle-read session is visible even when showRead=false", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [
			[idleReadSession({ id: "s-active" })],
			{ ...defaultOpts, showRead: false, activeId: "s-active" },
		] as any);
		expect(ids).toEqual(["s-active"]);
	});

	test("active streaming session is visible even when showBusy=false", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [
			[streamingSession({ id: "s-active" })],
			{ ...defaultOpts, showBusy: false, activeId: "s-active" },
		] as any);
		expect(ids).toEqual(["s-active"]);
	});
});

// ==========================================================================
// Search bypass
// ==========================================================================

test.describe("search bypasses filters", () => {
	test("non-empty searchQuery → all sessions returned regardless of toggles", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [
			[idleReadSession(), streamingSession()],
			{ ...defaultOpts, showBusy: false, showRead: false, searchQuery: "foo" },
		] as any);
		expect(ids).toEqual(["s-idle-read", "s-streaming"]);
	});

	test("whitespace-only searchQuery does NOT bypass filters", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [
			[idleReadSession()],
			{ ...defaultOpts, showRead: false, searchQuery: "   " },
		] as any);
		expect(ids).toEqual([]);
	});
});

// ==========================================================================
// Team-lead sticky
// ==========================================================================

test.describe("team-lead sticky", () => {
	test("idle-read lead is kept when a child still passes (showBusy=true, showRead=false, child streaming)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const lead = idleReadSession({ id: "lead", role: "team-lead", createdAt: NOW });
		const child = streamingSession({ id: "child", role: "coder", createdAt: NOW + 1 });
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [
			[lead, child],
			{ ...defaultOpts, showBusy: true, showRead: false, isTeamGoal: true },
		] as any);
		// Lead would normally be filtered out (idle + read) but must be kept
		// because the child survives the filter.  Order preserved.
		expect(ids).toEqual(["lead", "child"]);
	});

	test("lead drops when every child also fails the filter", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const lead = idleReadSession({ id: "lead", role: "team-lead", createdAt: NOW });
		const child = idleReadSession({ id: "child", role: "coder", createdAt: NOW + 1 });
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [
			[lead, child],
			{ ...defaultOpts, showRead: false, isTeamGoal: true },
		] as any);
		// Both lead and child are idle-read; with showRead=false everything
		// disappears.  Nothing keeps the lead sticky.
		expect(ids).toEqual([]);
	});

	test("lead that passes on its own is unaffected by sticky logic", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const lead = streamingSession({ id: "lead", role: "team-lead", createdAt: NOW });
		const child = idleReadSession({ id: "child", role: "coder", createdAt: NOW + 1 });
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [
			[lead, child],
			{ ...defaultOpts, showRead: false, showBusy: true, isTeamGoal: true },
		] as any);
		// Lead is streaming → passes outright.  Child is idle-read → drops.
		expect(ids).toEqual(["lead"]);
	});

	test("non-team goal does NOT apply sticky logic — lead-like sessions filter normally", async ({ page }) => {
		await page.goto(TEST_PAGE);
		// Even if a session happens to carry role:"team-lead", a non-team
		// goal has no team partition → no sticky rule.  Both should drop.
		const a = idleReadSession({ id: "a", role: "team-lead", createdAt: NOW });
		const b = idleReadSession({ id: "b", role: "coder", createdAt: NOW + 1 });
		const ids = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).map((s: any) => s.id);
		}, [
			[a, b],
			{ ...defaultOpts, showRead: false, isTeamGoal: false },
		] as any);
		expect(ids).toEqual([]);
	});
});

// ==========================================================================
// Goal header / empty display list
// ==========================================================================

test.describe("empty display list is allowed (goal header stays visible)", () => {
	test("all-filtered-out goal returns empty list (goal header path renders empty state)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const count = await page.evaluate(([sessions, opts]: any) => {
			return window.computeGoalGroupDisplaySessions(sessions, opts).length;
		}, [[idleReadSession()], { ...defaultOpts, showRead: false }] as any);
		// renderGoalGroup branches on `goalSessions.length === 0` to show the
		// empty-state / "Start Team" / "start one" CTA above the goal header.
		// Returning [] is the correct signal for that path.  The goal header
		// itself is rendered unconditionally above this list, so the goal
		// stays discoverable.
		expect(count).toBe(0);
	});
});
