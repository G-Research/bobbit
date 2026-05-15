/**
 * Browser E2E for the goal-proposal modal subgoal controls.
 *
 * Covers the per-goal "Allow subgoals" checkbox + "Max nesting depth"
 * input restored in `renderGoalForm` (src/app/render.ts). The controls
 * are pinned by source in `tests/proposal-form-controls-source-pinned.test.ts`;
 * this spec pins their runtime behaviour and server round-trip:
 *
 *   1. With subgoals enabled the toggle is visible and the max-depth input
 *      appears when the toggle is on, disappears when off, and reappears
 *      when toggled back on.
 *   2. Submitting with the toggle ON and depth set to 2 → created goal has
 *      subgoalsAllowed:true and maxNestingDepth:2 via GET /api/goals/:id.
 *   3. Submitting with the toggle OFF → created goal has subgoalsAllowed:false.
 *
 * Pattern is taken from `tests/e2e/ui/propose-goal-parent-picker.spec.ts`:
 * the proposal panel is driven by seeding via
 * `POST /api/sessions/:id/proposal/goal/seed`, then the WS `proposal_update`
 * event populates state.activeProposals.goal and the form renders.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { apiFetch, createSession, deleteSession } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

async function setPref(key: string, value: unknown): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ [key]: value }),
	});
	expect(resp.status).toBe(200);
}

async function seedGoalProposal(
	sessionId: string,
	args: Record<string, unknown>,
): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/proposal/goal/seed`, {
		method: "POST",
		body: JSON.stringify({ args }),
	});
	expect(resp.status, "seed proposal must succeed").toBe(200);
	const body = await resp.json();
	expect(body.ok).toBe(true);
}

async function openSession(page: Page, sessionId: string): Promise<void> {
	await openApp(page);
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

async function findGoalByTitle(title: string): Promise<any | undefined> {
	const resp = await apiFetch("/api/goals");
	const data = await resp.json();
	const goals = data.goals || data;
	return (goals as any[]).find((g: any) => g.title === title);
}

async function deleteGoalIfExists(goalId: string | undefined): Promise<void> {
	if (!goalId) return;
	await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => {});
}

test.describe("Goal proposal modal — subgoal controls", () => {
	test("toggle hides/shows max-depth input; submission persists subgoalsAllowed + maxNestingDepth", async ({ page }) => {
		test.setTimeout(90_000);
		await setPref("subgoalsEnabled", true);
		await setPref("maxNestingDepth", 3);

		const title = `Proposal subgoals on ${Date.now()}`;
		const sessionId = await createSession();
		let createdGoalId: string | undefined;

		try {
			await seedGoalProposal(sessionId, {
				title,
				spec: "Verify per-goal Allow-subgoals toggle + max-depth input round-trip.",
			});

			await openSession(page, sessionId);

			const titleInput = page.locator("input[placeholder='Goal title']").first();
			await expect(titleInput).toBeVisible({ timeout: 15_000 });
			await expect(titleInput).toHaveValue(title, { timeout: 10_000 });

			// 1. Toggle is visible by default (subgoals enabled).
			const toggle = page.locator("[data-testid='goal-form-subgoals-toggle']").first();
			await expect(toggle).toBeVisible({ timeout: 10_000 });
			await expect(toggle).toBeChecked();

			// Max-depth input is shown while the toggle is checked.
			const maxDepth = page.locator("[data-testid='goal-form-max-depth']").first();
			await expect(maxDepth).toBeVisible({ timeout: 5_000 });

			// 1b. Verify the toggle row contains Sandbox → Auto-start team →
			//     Enable QA Testing → Allow subgoals → Max depth in that order.
			//     This pins UI consistency: the subgoals controls must live in the
			//     same shared toggle row as their peers, not in a separate row.
			const rowText = await toggle.evaluate((el) => {
				const row = el.closest("div.flex.flex-wrap");
				return row ? (row.textContent || "").replace(/\s+/g, " ").trim() : "";
			});
			expect(rowText, "Allow-subgoals toggle must live in the shared toggle row").not.toBe("");
			const expectedOrder = [
				"Sandbox",
				"Auto-start team",
				"Enable QA Testing",
				"Allow subgoals",
				"Max depth",
			];
			let cursor = 0;
			for (const label of expectedOrder) {
				const idx = rowText.indexOf(label, cursor);
				expect(idx, `Expected "${label}" after position ${cursor} in row text: "${rowText}"`).toBeGreaterThanOrEqual(cursor);
				cursor = idx + label.length;
			}

			// 2. Toggle OFF → max-depth input disappears.
			await toggle.click();
			await expect(toggle).not.toBeChecked();
			await expect(page.locator("[data-testid='goal-form-max-depth']")).toHaveCount(0);

			// 3. Toggle back ON → max-depth input reappears.
			await toggle.click();
			await expect(toggle).toBeChecked();
			const maxDepth2 = page.locator("[data-testid='goal-form-max-depth']").first();
			await expect(maxDepth2).toBeVisible({ timeout: 5_000 });

			// 4. Set depth to 2.
			await maxDepth2.fill("2");
			await maxDepth2.blur();
			await expect(maxDepth2).toHaveValue("2");

			// 5. Submit the proposal.
			const createPromise = page.waitForResponse(
				resp => resp.url().includes("/api/goals")
					&& resp.request().method() === "POST"
					&& resp.ok(),
				{ timeout: 20_000 },
			);
			const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
			await expect(createBtn).toBeVisible({ timeout: 5_000 });
			await expect(createBtn).toBeEnabled();
			await createBtn.click();
			await createPromise;

			// 6. Verify persisted goal via GET /api/goals/:id.
			await expect.poll(
				async () => {
					const g = await findGoalByTitle(title);
					return g?.id;
				},
				{ timeout: 10_000 },
			).toBeTruthy();
			const created = await findGoalByTitle(title);
			expect(created).toBeTruthy();
			createdGoalId = created.id;

			const detailResp = await apiFetch(`/api/goals/${createdGoalId}`);
			expect(detailResp.status).toBe(200);
			const detail = await detailResp.json();
			expect(detail.subgoalsAllowed).toBe(true);
			expect(detail.maxNestingDepth).toBe(2);
		} finally {
			await deleteGoalIfExists(createdGoalId);
			await deleteSession(sessionId);
			await setPref("maxNestingDepth", null);
			await setPref("subgoalsEnabled", null);
		}
	});

	test("submitting with Allow-subgoals OFF persists subgoalsAllowed:false", async ({ page }) => {
		test.setTimeout(90_000);
		await setPref("subgoalsEnabled", true);
		await setPref("maxNestingDepth", 3);

		const title = `Proposal subgoals off ${Date.now()}`;
		const sessionId = await createSession();
		let createdGoalId: string | undefined;

		try {
			await seedGoalProposal(sessionId, {
				title,
				spec: "Verify per-goal Allow-subgoals=false round-trip.",
			});

			await openSession(page, sessionId);

			const titleInput = page.locator("input[placeholder='Goal title']").first();
			await expect(titleInput).toBeVisible({ timeout: 15_000 });
			await expect(titleInput).toHaveValue(title, { timeout: 10_000 });

			const toggle = page.locator("[data-testid='goal-form-subgoals-toggle']").first();
			await expect(toggle).toBeVisible({ timeout: 10_000 });
			await expect(toggle).toBeChecked();

			// Toggle OFF and confirm max-depth input is gone.
			await toggle.click();
			await expect(toggle).not.toBeChecked();
			await expect(page.locator("[data-testid='goal-form-max-depth']")).toHaveCount(0);

			// Submit.
			const createPromise = page.waitForResponse(
				resp => resp.url().includes("/api/goals")
					&& resp.request().method() === "POST"
					&& resp.ok(),
				{ timeout: 20_000 },
			);
			const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
			await expect(createBtn).toBeEnabled({ timeout: 5_000 });
			await createBtn.click();
			await createPromise;

			await expect.poll(
				async () => {
					const g = await findGoalByTitle(title);
					return g?.id;
				},
				{ timeout: 10_000 },
			).toBeTruthy();
			const created = await findGoalByTitle(title);
			expect(created).toBeTruthy();
			createdGoalId = created.id;

			const detailResp = await apiFetch(`/api/goals/${createdGoalId}`);
			expect(detailResp.status).toBe(200);
			const detail = await detailResp.json();
			expect(detail.subgoalsAllowed).toBe(false);
		} finally {
			await deleteGoalIfExists(createdGoalId);
			await deleteSession(sessionId);
			await setPref("maxNestingDepth", null);
			await setPref("subgoalsEnabled", null);
		}
	});
});
