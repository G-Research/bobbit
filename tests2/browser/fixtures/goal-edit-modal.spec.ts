import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, deleteGoal } from "../e2e-setup.js";
import { openApp, navigateToGoalDashboard } from "./ui-helpers.js";

async function openGoalEditDialog(page: import("@playwright/test").Page) {
	const editButton = page.locator('[data-testid="goal-dashboard"] button[title="Edit goal"]').first();
	await expect(editButton).toBeVisible({ timeout: 15_000 });
	await editButton.click();

	const dialog = page.getByTestId("goal-edit-dialog");
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	await expect(page.getByTestId("goal-edit-title-input")).toBeFocused({ timeout: 5_000 });
	return dialog;
}

async function dialogBox(page: import("@playwright/test").Page) {
	const box = await page.getByTestId("goal-edit-dialog").boundingBox();
	expect(box, "Edit Goal dialog should have a measurable bounding box").not.toBeNull();
	return box!;
}

async function fetchGoal(goalId: string): Promise<any> {
	const resp = await apiFetch(`/api/goals/${goalId}`);
	expect(resp.ok).toBe(true);
	return resp.json();
}

test.describe("Edit Goal modal", () => {
	test("uses near-full-screen sizing while preserving close and save behavior", async ({ page }) => {
		const initialTitle = `Edit modal sizing ${Date.now()}`;
		const goal = await createGoal({
			title: initialTitle,
			team: false,
			worktree: false,
			spec: [
				"# Edit modal sizing",
				"",
				"This deliberately long goal spec gives the editor enough content to exercise the expanded modal layout.",
				"",
				...Array.from({ length: 18 }, (_, i) => `- Acceptance detail ${i + 1}: keep the footer reachable while editing.`),
			].join("\n"),
		});
		const goalId = goal.id as string;

		try {
			await page.setViewportSize({ width: 1280, height: 900 });
			await openApp(page);
			await navigateToGoalDashboard(page, goalId);

			await openGoalEditDialog(page);
			let box = await dialogBox(page);
			expect(box.width, "desktop dialog should occupy most of the viewport width").toBeGreaterThanOrEqual(1280 * 0.84);
			expect(box.height, "desktop dialog should occupy most of the viewport height").toBeGreaterThanOrEqual(900 * 0.88);
			expect(box.width).toBeLessThanOrEqual(1280);
			expect(box.height).toBeLessThanOrEqual(900);
			expect(await page.getByTestId("goal-edit-spec-textarea").boundingBox()).toEqual(
				expect.objectContaining({ height: expect.any(Number) }),
			);
			const specBox = await page.getByTestId("goal-edit-spec-textarea").boundingBox();
			expect(specBox?.height, "spec editor should be substantially taller than the old compact textarea").toBeGreaterThanOrEqual(300);

			await page.keyboard.press("Escape");
			await expect(page.getByTestId("goal-edit-dialog")).toBeHidden({ timeout: 5_000 });

			await page.setViewportSize({ width: 390, height: 720 });
			await openGoalEditDialog(page);
			box = await dialogBox(page);
			expect(box.x, "narrow dialog should not overflow left").toBeGreaterThanOrEqual(0);
			expect(box.y, "narrow dialog should not overflow top").toBeGreaterThanOrEqual(0);
			expect(box.x + box.width, "narrow dialog should not overflow right").toBeLessThanOrEqual(390 + 1);
			expect(box.y + box.height, "narrow dialog should not overflow bottom").toBeLessThanOrEqual(720 + 1);

			const saveButton = page.getByTestId("goal-edit-save-button");
			const cancelButton = page.getByTestId("goal-edit-cancel-button");
			await expect(saveButton).toBeVisible();
			await expect(cancelButton).toBeVisible();
			for (const control of [saveButton, cancelButton]) {
				const controlBox = await control.boundingBox();
				expect(controlBox, "footer action should have a measurable bounding box").not.toBeNull();
				expect(controlBox!.y + controlBox!.height, "footer action should stay within the narrow viewport").toBeLessThanOrEqual(720 + 1);
			}

			await page.getByTestId("goal-edit-title-input").fill(`${initialTitle} canceled`);
			await cancelButton.click();
			await expect(page.getByTestId("goal-edit-dialog")).toBeHidden({ timeout: 5_000 });
			expect((await fetchGoal(goalId)).title).toBe(initialTitle);

			await openGoalEditDialog(page);
			const savedTitle = `${initialTitle} saved`;
			const titleInput = page.getByTestId("goal-edit-title-input");
			await titleInput.fill(savedTitle);
			await titleInput.press("Enter");
			await expect(page.getByTestId("goal-edit-dialog")).toBeHidden({ timeout: 10_000 });
			await expect.poll(async () => (await fetchGoal(goalId)).title, { timeout: 10_000 }).toBe(savedTitle);
		} finally {
			await deleteGoal(goalId);
		}
	});
});
