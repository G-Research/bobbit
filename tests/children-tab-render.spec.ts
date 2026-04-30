/**
 * Children tab — pure-logic unit tests for the F1 implementation
 * (docs/design/nested-goals.md §10.3).
 *
 *   CT-LBL-1   childCurrentGateLabel — handles every state branch
 *   CT-VRD-1   childLastVerdictLabel — maps state → verdict
 *   CT-CNT-1   childAgentCount — counts goalId + teamGoalId hits
 *   CT-ACT-1   formatChildLastActivity — relative time bands
 *
 * Mirrors the production helpers byte-for-byte (see fixture HTML).
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/children-tab-render.html")}`;

declare global {
	interface Window {
		childCurrentGateLabel: (child: any) => string;
		childLastVerdictLabel: (child: any) => string;
		childAgentCount: (childId: string, sessions: any[]) => number;
		formatChildLastActivity: (ts: number | undefined, now: number) => string;
	}
}

const wf = (gates: Array<{ id: string; name: string }>) => ({ gates });

test.describe("CT-LBL-1: childCurrentGateLabel", () => {
	test("emits 'ready-to-merge passed' for complete children", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const out = await page.evaluate(() =>
			window.childCurrentGateLabel({
				id: "c1",
				state: "complete",
				workflow: { gates: [{ id: "execution", name: "Execution" }] },
			}),
		);
		expect(out).toBe("ready-to-merge passed");
	});

	test("emits 'shelved' for shelved children", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const out = await page.evaluate(() =>
			window.childCurrentGateLabel({
				id: "c1",
				state: "shelved",
				workflow: { gates: [{ id: "x", name: "X" }] },
			}),
		);
		expect(out).toBe("shelved");
	});

	test("emits the workflow's last gate name for in-progress children", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const out = await page.evaluate(() =>
			window.childCurrentGateLabel({
				id: "c1",
				state: "in-progress",
				workflow: { gates: [{ id: "charter", name: "Charter" }, { id: "execution", name: "Execution" }] },
			}),
		);
		expect(out).toBe("Execution");
	});

	test("emits 'pending' for todo children", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const out = await page.evaluate(() =>
			window.childCurrentGateLabel({
				id: "c1",
				state: "todo",
				workflow: { gates: [{ id: "x", name: "X" }] },
			}),
		);
		expect(out).toBe("pending");
	});

	test("emits em-dash when the child has no workflow gates", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const out = await page.evaluate(() =>
			window.childCurrentGateLabel({ id: "c1", state: "in-progress", workflow: { gates: [] } }),
		);
		expect(out).toBe("\u2014");
	});
});

test.describe("CT-VRD-1: childLastVerdictLabel", () => {
	test("maps complete → passed, shelved → failed, in-progress → running, todo → em-dash", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const verdicts = await page.evaluate(() => [
			window.childLastVerdictLabel({ state: "complete" }),
			window.childLastVerdictLabel({ state: "shelved" }),
			window.childLastVerdictLabel({ state: "in-progress" }),
			window.childLastVerdictLabel({ state: "todo" }),
		]);
		expect(verdicts).toEqual(["passed", "failed", "running", "\u2014"]);
	});
});

test.describe("CT-CNT-1: childAgentCount", () => {
	test("counts sessions whose goalId OR teamGoalId matches the child id", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const n = await page.evaluate(() =>
			window.childAgentCount("c1", [
				{ id: "s1", goalId: "c1" },
				{ id: "s2", teamGoalId: "c1" },
				{ id: "s3", goalId: "other" },
				{ id: "s4", teamGoalId: "other" },
				{ id: "s5", goalId: "c1", teamGoalId: "c1" }, // dup match — counts once via OR
			]),
		);
		// s5 hits the goalId branch first; we don't double-count even when both fields match.
		expect(n).toBe(3);
	});

	test("returns 0 when no sessions reference the child", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const n = await page.evaluate(() =>
			window.childAgentCount("c1", [{ id: "s1", goalId: "other" }]),
		);
		expect(n).toBe(0);
	});
});

test.describe("CT-ACT-1: formatChildLastActivity", () => {
	test("emits a relative-time string for each band", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const now = 10_000_000_000;
		const labels = await page.evaluate((nowParam) => [
			window.formatChildLastActivity(undefined, nowParam),
			window.formatChildLastActivity(nowParam - 30_000, nowParam),     // <60s
			window.formatChildLastActivity(nowParam - 5 * 60_000, nowParam), // 5m
			window.formatChildLastActivity(nowParam - 2 * 3_600_000, nowParam), // 2h
			window.formatChildLastActivity(nowParam - 3 * 86_400_000, nowParam), // 3d
		], now);
		expect(labels).toEqual(["\u2014", "just now", "5m ago", "2h ago", "3d ago"]);
	});
});
