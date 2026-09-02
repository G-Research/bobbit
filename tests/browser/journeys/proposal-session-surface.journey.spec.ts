/** Proposal shell, navigation, tab, and streaming journeys. */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus } from "../../support/helpers/browser/journeys/journey-fixture.js";
import { createSessionViaUI, sendMessage } from "../../support/helpers/browser/journeys/journey-fixture.js";
import { holdProposalStream, waitForProposalSlot } from "../../support/helpers/browser/journeys/proposal-helpers.js";

// ── Shell / navigation tests ────────────────────────────────────────────────

test.describe("Journey: Proposals — shell", () => {
	test("app shell and an idle session render the proposal-compatible surface", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
			expect(await page.title()).toBeTruthy();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
			const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
			await expect(newGoalBtn).toBeVisible({ timeout: 15_000 });
			await newGoalBtn.click();
			await expect(page.locator(
				"dialog, [role='dialog'], [role='alertdialog'], goal-proposal-panel, [data-testid='goal-proposal'], input[placeholder*='title' i], input[placeholder*='goal' i]",
			).first()).toBeVisible({ timeout: 20_000 });
			await page.keyboard.press("Escape");
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

});

// ── Behavioral: proposal slot + tab ────────────────────────────────────────

test.describe("Journey: Proposals — behavioral", () => {
	test("role and streaming goal proposals expose every intermediate and terminal state", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "ROLE_PROPOSAL_PARITY");
		await waitForProposalSlot(page, "role");
		const fields = await page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.activeProposals?.role?.fields ?? null;
		});
		expect(fields).toBeTruthy();
		expect(typeof fields).toBe("object");
		expect(Object.keys(fields as object).length).toBeGreaterThan(0);

		const roleTab = page.locator('.goal-tab-pill[title="Role"]').first();
		await expect(roleTab).toBeVisible({ timeout: 15_000 });
		await expect(roleTab.locator(".goal-tab-dot")).toBeVisible({ timeout: 15_000 });
		await roleTab.click();
		const rolePane = page.locator('[data-panel="role-proposal"]').first();
		await expect(rolePane).toBeVisible({ timeout: 15_000 });
		const dismissBtn = rolePane.getByRole("button", { name: /^Dismiss$/ }).first();
		await expect(dismissBtn).toBeVisible({ timeout: 15_000 });
		await expect(dismissBtn).toBeEnabled();
		await dismissBtn.click();
		await expect(roleTab).toHaveCount(0, { timeout: 20_000 });
		await page.waitForFunction(
			() => {
				const state = (window as any).bobbitState ?? (window as any).__bobbitState;
				return !!state && !state.activeProposals?.role;
			},
			{ timeout: 20_000 },
		);

		const stream = await holdProposalStream(page, gateway, "goal");
		const badge = page.locator('[data-testid="proposal-streaming-badge"]').first();
		const submitWrap = page.locator('[data-testid="proposal-primary-submit"]').first();
		try {
			await sendMessage(page, "STAY_BUSY:propose_goal:5:0");
			await stream.entered;
			await expect(submitWrap).toBeVisible({ timeout: 15_000 });
			const submitBtn = submitWrap.locator("button").first();
			await expect(badge).toBeVisible({ timeout: 15_000 });
			await expect(submitBtn).toBeDisabled({ timeout: 15_000 });
		} finally {
			stream.release();
		}
		const submitBtn = submitWrap.locator("button").first();
		await expect(badge).toBeHidden({ timeout: 20_000 });
		await expect(submitBtn).toBeEnabled({ timeout: 15_000 });
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.remoteAgent?.state?.status ?? ""),
			{ timeout: 15_000 },
		).toBe("idle");

		const dismissStream = await holdProposalStream(page, gateway, "goal");
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		try {
			await sendMessage(page, "STAY_BUSY:propose_goal:8:0");
			await dismissStream.entered;
			await expect(titleInput).toBeVisible({ timeout: 15_000 });
			await expect(badge).toBeVisible({ timeout: 15_000 });
			const dismissBtn = page.locator("button").filter({ hasText: "Dismiss" }).first();
			await expect(dismissBtn).toBeVisible({ timeout: 15_000 });
			await expect(dismissBtn).toBeEnabled();
			await dismissBtn.click();
			await expect(titleInput).toBeHidden({ timeout: 15_000 });
		} finally {
			dismissStream.release();
		}
		await page.waitForFunction(
			() => (window as any).bobbitState?.remoteAgent?.state?.status === "idle",
			{ timeout: 15_000 },
		);
		await expect(titleInput).toBeHidden();
		await expect(badge).toBeHidden();
	});
});
