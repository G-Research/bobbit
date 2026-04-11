/**
 * Unit tests for sidebar session rendering helpers.
 *
 * Stories covered: SB-05, SB-06, SB-07, SB-08, SB-35, SB-36
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/sidebar-session-rendering.html").replace(/\\/g, "/")}`;

// ---------------------------------------------------------------------------
// SB-06: terseRelativeTime
// ---------------------------------------------------------------------------
test.describe("SB-06: terseRelativeTime", () => {
	test("returns empty string for 0", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__sessionRendering.terseRelativeTime(0));
		expect(r).toBe("");
	});

	test("returns empty string for NaN", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__sessionRendering.terseRelativeTime(NaN));
		expect(r).toBe("");
	});

	test('returns "now" for timestamp less than 60s ago', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__sessionRendering.terseRelativeTime(Date.now() - 5000));
		expect(r).toBe("now");
	});

	test('returns "3m" for 3 minutes ago', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__sessionRendering.terseRelativeTime(Date.now() - 3 * 60000));
		expect(r).toBe("3m");
	});

	test('returns "2h" for 2 hours ago', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__sessionRendering.terseRelativeTime(Date.now() - 2 * 3600000));
		expect(r).toBe("2h");
	});

	test('returns "1d" for 1 day ago', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__sessionRendering.terseRelativeTime(Date.now() - 86400000));
		expect(r).toBe("1d");
	});
});

// ---------------------------------------------------------------------------
// SB-06: formatSessionAge
// ---------------------------------------------------------------------------
test.describe("SB-06: formatSessionAge", () => {
	test("returns empty string for 0", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__sessionRendering.formatSessionAge(0));
		expect(r).toBe("");
	});

	test("returns empty string for NaN", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__sessionRendering.formatSessionAge(NaN));
		expect(r).toBe("");
	});

	test('returns "just now" for less than 1 minute', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__sessionRendering.formatSessionAge(Date.now() - 5000));
		expect(r).toBe("just now");
	});

	test('returns "49m ago" for 49 minutes', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__sessionRendering.formatSessionAge(Date.now() - 49 * 60000));
		expect(r).toBe("49m ago");
	});

	test('returns "2h ago" for 2 hours', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__sessionRendering.formatSessionAge(Date.now() - 2 * 3600000));
		expect(r).toBe("2h ago");
	});

	test('returns "3d ago" for 3 days', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__sessionRendering.formatSessionAge(Date.now() - 3 * 86400000));
		expect(r).toBe("3d ago");
	});
});

// ---------------------------------------------------------------------------
// SB-07: hasUnseenActivity
// ---------------------------------------------------------------------------
test.describe("SB-07: hasUnseenActivity", () => {
	test("returns false for streaming session", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const s = { id: "s1", status: "streaming", lastActivity: Date.now() };
			return (window as any).__sessionRendering.hasUnseenActivity(s, "other", [], {});
		});
		expect(r).toBe(false);
	});

	test("returns false for busy session", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const s = { id: "s1", status: "busy", lastActivity: Date.now() };
			return (window as any).__sessionRendering.hasUnseenActivity(s, "other", [], {});
		});
		expect(r).toBe(false);
	});

	test("returns false when session is active", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const s = { id: "s1", status: "idle", lastActivity: Date.now() };
			return (window as any).__sessionRendering.hasUnseenActivity(s, "s1", [], {});
		});
		expect(r).toBe(false);
	});

	test("returns true when idle and lastActivity > lastVisit", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const now = Date.now();
			const s = { id: "s1", status: "idle", lastActivity: now };
			return (window as any).__sessionRendering.hasUnseenActivity(s, "other", [], { s1: now - 10000 });
		});
		expect(r).toBe(true);
	});

	test("returns false when lastActivity <= lastVisit", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const now = Date.now();
			const s = { id: "s1", status: "idle", lastActivity: now - 10000 };
			return (window as any).__sessionRendering.hasUnseenActivity(s, "other", [], { s1: now });
		});
		expect(r).toBe(false);
	});

	test("suppresses for team agent when goal is not complete", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const now = Date.now();
			const s = { id: "s1", status: "idle", lastActivity: now, teamGoalId: "g1" };
			const goals = [{ id: "g1", state: "in-progress" }];
			return (window as any).__sessionRendering.hasUnseenActivity(s, "other", goals, { s1: now - 10000 });
		});
		expect(r).toBe(false);
	});

	test("shows for team agent when goal is complete", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const now = Date.now();
			const s = { id: "s1", status: "idle", lastActivity: now, teamGoalId: "g1" };
			const goals = [{ id: "g1", state: "complete" }];
			return (window as any).__sessionRendering.hasUnseenActivity(s, "other", goals, { s1: now - 10000 });
		});
		expect(r).toBe(true);
	});

	test("returns false for team-lead role when goal not found", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const now = Date.now();
			const s = { id: "s1", status: "idle", lastActivity: now, role: "team-lead", goalId: "g1" };
			return (window as any).__sessionRendering.hasUnseenActivity(s, "other", [], { s1: now - 10000 });
		});
		expect(r).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// SB-05: getSessionIndicatorType
// ---------------------------------------------------------------------------
test.describe("SB-05: getSessionIndicatorType", () => {
	test('returns "pulsing-dot" for streaming', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.getSessionIndicatorType({ status: "streaming" })
		);
		expect(r).toBe("pulsing-dot");
	});

	test('returns "pulsing-dot" for busy', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.getSessionIndicatorType({ status: "busy" })
		);
		expect(r).toBe("pulsing-dot");
	});

	test('returns "compacting" for compacting session', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.getSessionIndicatorType({ status: "idle", isCompacting: true })
		);
		expect(r).toBe("compacting");
	});

	test('returns "aborting" for aborting session (SB-08)', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.getSessionIndicatorType({ status: "idle", isAborting: true })
		);
		expect(r).toBe("aborting");
	});

	test('returns "spinner" for connecting session', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.getSessionIndicatorType({ status: "connecting" })
		);
		expect(r).toBe("spinner");
	});

	test('returns "time" for idle session', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.getSessionIndicatorType({ status: "idle" })
		);
		expect(r).toBe("time");
	});

	test('returns "time" for terminated session', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.getSessionIndicatorType({ status: "terminated" })
		);
		expect(r).toBe("time");
	});
});

// ---------------------------------------------------------------------------
// SB-35: Personality badges
// ---------------------------------------------------------------------------
test.describe("SB-35: hasPersonalityBadges", () => {
	test("returns true when personalities array has items", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.hasPersonalityBadges({ personalities: ["pirate", "formal"] })
		);
		expect(r).toBe(true);
	});

	test("returns false with empty array", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.hasPersonalityBadges({ personalities: [] })
		);
		expect(r).toBe(false);
	});

	test("returns false with undefined", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.hasPersonalityBadges({})
		);
		expect(r).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// SB-36: Sandbox indicator dot color
// ---------------------------------------------------------------------------
test.describe("SB-36: getSandboxDotColor", () => {
	test('returns "green" for streaming', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.getSandboxDotColor("streaming")
		);
		expect(r).toBe("green");
	});

	test('returns "green" for busy', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.getSandboxDotColor("busy")
		);
		expect(r).toBe("green");
	});

	test('returns "grey" for idle', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.getSandboxDotColor("idle")
		);
		expect(r).toBe("grey");
	});

	test('returns "grey" for terminated', async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__sessionRendering.getSandboxDotColor("terminated")
		);
		expect(r).toBe("grey");
	});
});
