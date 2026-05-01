/**
 * Unit tests for the Plan tab's "Approve plan" button visibility
 * (nested-goals task F3).
 *
 * Mirrors the pure helper `shouldShowApprovePlanButton` from
 * src/app/goal-dashboard.ts. The button must appear iff:
 *   1. The plan is editable (goal-plan gate not yet passed).
 *   2. The plan has at least one subgoal step.
 *   3. The goal is NOT paused.
 *
 * See docs/design/nested-goals.md §10.2 + acceptance criterion #3.
 *
 *   APB-1  editable + 3 steps + not paused → visible
 *   APB-2  frozen (goal-plan passed) + 3 steps + not paused → hidden
 *   APB-3  editable + 0 steps + not paused → hidden
 *   APB-4  editable + 3 steps + paused → hidden
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/plan-tab-approve-button.html")}`;

declare global {
	interface Window {
		isPlanEditable: (
			goal: { paused?: boolean } | null,
			gateStates: Array<{ gateId: string; status: "pending" | "passed" | "failed" }>,
		) => boolean;
		shouldShowApprovePlanButton: (
			editable: boolean,
			stepCount: number,
			paused: boolean,
		) => boolean;
		decideButtonVisible: (
			goal: { paused?: boolean } | null,
			gateStates: Array<{ gateId: string; status: "pending" | "passed" | "failed" }>,
			stepCount: number,
		) => boolean;
	}
}

test.describe("APB-1: editable plan with steps + not paused → button visible", () => {
	test("button is visible when plan is editable and has 3 steps", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const visible = await page.evaluate(() => window.decideButtonVisible(
			{ paused: false },
			[{ gateId: "goal-plan", status: "pending" }],
			3,
		));
		expect(visible).toBe(true);
	});

	test("button is visible when goal-plan gate state is missing (treated as pending)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const visible = await page.evaluate(() => window.decideButtonVisible(
			{ paused: false },
			[],
			1,
		));
		expect(visible).toBe(true);
	});
});

test.describe("APB-2: frozen → button hidden", () => {
	test("button is hidden when goal-plan gate has passed and goal not paused", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const visible = await page.evaluate(() => window.decideButtonVisible(
			{ paused: false },
			[{ gateId: "goal-plan", status: "passed" }],
			3,
		));
		expect(visible).toBe(false);
	});
});

test.describe("APB-3: empty plan → button hidden", () => {
	test("button is hidden when plan is editable but has zero steps", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const visible = await page.evaluate(() => window.decideButtonVisible(
			{ paused: false },
			[{ gateId: "goal-plan", status: "pending" }],
			0,
		));
		expect(visible).toBe(false);
	});
});

test.describe("APB-4: paused goal → button hidden", () => {
	test("button is hidden when goal is paused (even though plan is editable)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const visible = await page.evaluate(() => window.decideButtonVisible(
			{ paused: true },
			[{ gateId: "goal-plan", status: "pending" }],
			3,
		));
		expect(visible).toBe(false);
	});

	test("button stays hidden if paused even when goal-plan already passed", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const visible = await page.evaluate(() => window.decideButtonVisible(
			{ paused: true },
			[{ gateId: "goal-plan", status: "passed" }],
			3,
		));
		expect(visible).toBe(false);
	});
});

test.describe("APB-5: null goal sanity check", () => {
	test("button is hidden when goal is null", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const visible = await page.evaluate(() => window.decideButtonVisible(null, [], 3));
		expect(visible).toBe(false);
	});
});
