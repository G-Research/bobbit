/**
 * Goal-creation dialog — per-goal worktree setup controls (browser E2E).
 *
 * Verifies the goal form exposes the optional "Setup command" + "Timeout (ms)"
 * controls (data-testids goal-form-worktree-setup-command /
 * goal-form-worktree-setup-timeout-ms), that they are optional (empty by
 * default ⇒ no persisted hook), and that filled values are forwarded to
 * goal creation and persist across a page reload.
 *
 * Mirrors tests/e2e/ui/goal-creation.spec.ts (assistant proposal flow + mock
 * agent). Persistence is asserted against the server-side goal via the API,
 * which is the durable record that survives a reload.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

const CMD_TESTID = "[data-testid='goal-form-worktree-setup-command']";
const TIMEOUT_TESTID = "[data-testid='goal-form-worktree-setup-timeout-ms']";

/** Open the goal assistant and wait for the populated proposal title input. */
async function openGoalAssistantProposal(page: import("@playwright/test").Page) {
	test.setTimeout(90_000);
	await openApp(page);
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await expect(newGoalBtn).toBeEnabled({ timeout: 10_000 });
	const sessionCreated = page.waitForResponse(
		(resp) => resp.url().includes("/api/sessions") && resp.request().method() === "POST" && resp.ok(),
		{ timeout: 60_000 },
	);
	await newGoalBtn.click();
	await sessionCreated;
	await page.waitForURL(/#\/session\//, { timeout: 10_000 });
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 10_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 10_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
}

async function findGoalByTitle(title: string): Promise<any | undefined> {
	const resp = await apiFetch("/api/goals");
	const data = await resp.json();
	const goals = data.goals || data;
	return (goals as any[]).find((g) => g.title === title);
}

async function deleteGoal(goalId: string) {
	await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => {});
}

async function clickCreate(page: import("@playwright/test").Page) {
	const createPromise = page.waitForResponse(
		(resp) => resp.url().includes("/api/goals") && resp.request().method() === "POST" && resp.ok(),
		{ timeout: 15_000 },
	);
	await page.locator("button").filter({ hasText: "Create Goal" }).first().click();
	await createPromise;
	await expect(page).toHaveURL(/#\/goal(-dashboard)?\//, { timeout: 15_000 });
}

test.describe("Goal creation dialog — per-goal worktree setup controls", () => {
	test("controls are visible and optional; empty fields persist no hook", async ({ page }) => {
		await openGoalAssistantProposal(page);

		// Controls are exposed and empty by default.
		const cmd = page.locator(CMD_TESTID).first();
		const timeout = page.locator(TIMEOUT_TESTID).first();
		await expect(cmd).toBeVisible({ timeout: 5_000 });
		await expect(timeout).toBeVisible({ timeout: 5_000 });
		await expect(cmd).toHaveValue("");
		await expect(timeout).toHaveValue("");

		// Create without touching them — backward-compatible no-hook goal.
		await clickCreate(page);

		const created = await findGoalByTitle("E2E Test Goal");
		expect(created).toBeTruthy();
		try {
			expect(created.worktreeSetupCommand).toBeUndefined();
			expect(created.worktreeSetupTimeoutMs).toBeUndefined();
		} finally {
			if (created) await deleteGoal(created.id);
		}
	});

	test("filled command + timeout are forwarded and persist across reload", async ({ page }) => {
		await openGoalAssistantProposal(page);

		const cmd = page.locator(CMD_TESTID).first();
		const timeout = page.locator(TIMEOUT_TESTID).first();
		await expect(cmd).toBeVisible({ timeout: 5_000 });
		await cmd.fill("./scripts/seed.sh");
		await timeout.fill("60000");
		await expect(cmd).toHaveValue("./scripts/seed.sh");
		await expect(timeout).toHaveValue("60000");

		await clickCreate(page);

		const created = await findGoalByTitle("E2E Test Goal");
		expect(created).toBeTruthy();
		try {
			expect(created.worktreeSetupCommand).toBe("./scripts/seed.sh");
			expect(created.worktreeSetupTimeoutMs).toBe(60000);

			// Persisted server-side: survives a full page reload.
			await page.reload();
			const reloaded = await findGoalByTitle("E2E Test Goal");
			expect(reloaded).toBeTruthy();
			expect(reloaded.worktreeSetupCommand).toBe("./scripts/seed.sh");
			expect(reloaded.worktreeSetupTimeoutMs).toBe(60000);
		} finally {
			if (created) await deleteGoal(created.id);
		}
	});
});
