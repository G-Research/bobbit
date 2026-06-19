/**
 * REPRODUCING TEST — sub-goal creation UX bug (issue analysis gate), UI layer.
 *
 * #2  The Parent-Goal picker on the goal-proposal panel must pre-communicate
 *     host eligibility: a parent whose effective `subgoalsAllowed` is false
 *     must be visibly marked as unable to host children BEFORE submit —
 *     either a disabled <option> or a "(sub-goals off)" suffix on its label.
 *     An eligible parent must NOT be marked.
 *
 * RED on the current tree: `renderParentPickerRow` lists every non-archived
 * goal with bare titles and no eligibility signal, so the ineligible parent's
 * option is neither disabled nor suffixed — the dead-end only surfaces at
 * submit time.
 *
 * The "Allow team lead to create sub-goals" toggle on this panel governs the
 * NEW goal being proposed, not the selected parent — so it cannot fix this.
 * This test asserts the picker itself carries the signal.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, deleteGoal, defaultProjectId, nonGitCwd } from "../e2e-setup.js";
import { openApp, sendMessage, createSessionViaUI } from "./ui-helpers.js";

const PARENT_SPEC =
	"Parent goal for the parent-picker eligibility repro — padded to satisfy the spec minimum length validator.";

async function setSubgoalsEnabled(enabled: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: enabled }),
	});
	expect(resp.status).toBe(200);
}

async function createParent(title: string, subgoalsAllowed: boolean): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title,
			cwd: nonGitCwd(),
			worktree: false,
			autoStartTeam: false,
			workflowId: "feature",
			spec: PARENT_SPEC,
			projectId: await defaultProjectId(),
			subgoalsAllowed,
		}),
	});
	expect(resp.status).toBe(201);
	const body = await resp.json();
	return body.id as string;
}

test.describe("Parent-Goal picker host-eligibility hint", () => {
	test("an ineligible (sub-goals off) parent is marked before submit; an eligible one is not", async ({ page }) => {
		await setSubgoalsEnabled(true);
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const blockedTitle = `picker-blocked ${stamp}`;
		const openTitle = `picker-open ${stamp}`;
		const blockedId = await createParent(blockedTitle, false);
		const openId = await createParent(openTitle, true);

		try {
			await openApp(page);
			await createSessionViaUI(page);

			// Mock agent emits a top-level propose_goal titled "E2E Test Goal".
			await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

			const titleInput = page.locator("input[placeholder='Goal title']").first();
			await expect(titleInput).toBeVisible({ timeout: 20_000 });
			await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

			// The parent picker lives on the Sub-goals tab (visible when the
			// system flag is ON).
			const subgoalsTab = page.locator("[data-testid='goal-proposal-tab-subgoals']");
			await expect(subgoalsTab).toBeVisible({ timeout: 10_000 });
			await subgoalsTab.click();

			const picker = page.locator("[data-testid='goal-form-parent-picker']");
			await expect(picker).toBeVisible({ timeout: 10_000 });

			// Both parents must appear as options.
			await expect(picker.locator(`option[value="${blockedId}"]`)).toHaveCount(1, { timeout: 10_000 });
			await expect(picker.locator(`option[value="${openId}"]`)).toHaveCount(1);

			// The ineligible parent must be marked: disabled OR a "(sub-goals off)"
			// suffix on the visible label.
			const blocked = await picker
				.locator(`option[value="${blockedId}"]`)
				.evaluate((o: HTMLOptionElement) => ({ disabled: o.disabled, text: o.textContent || "" }));
			const blockedMarked = blocked.disabled || /sub-?goals?\s*off/i.test(blocked.text);
			expect(
				blockedMarked,
				`ineligible parent option must be disabled or suffixed; got disabled=${blocked.disabled} text=${JSON.stringify(blocked.text)}`,
			).toBe(true);

			// The eligible parent must NOT be marked (guards against marking all).
			const open = await picker
				.locator(`option[value="${openId}"]`)
				.evaluate((o: HTMLOptionElement) => ({ disabled: o.disabled, text: o.textContent || "" }));
			const openMarked = open.disabled || /sub-?goals?\s*off/i.test(open.text);
			expect(
				openMarked,
				`eligible parent option must NOT be marked; got disabled=${open.disabled} text=${JSON.stringify(open.text)}`,
			).toBe(false);

			// The tab must visibly separate the two concepts so the picker reads as
			// "where this new goal is attached", distinct from "may the new goal
			// host its own children". The parent picker lives in the attach section;
			// the allow-sub-goals toggle lives in the host section.
			const attachSection = page.locator("[data-testid='goal-form-attach-section']");
			const hostSection = page.locator("[data-testid='goal-form-host-section']");
			await expect(attachSection).toBeVisible();
			await expect(hostSection).toBeVisible();
			await expect(attachSection.locator("[data-testid='goal-form-parent-picker']")).toHaveCount(1);
			await expect(hostSection.locator("[data-testid='goal-form-subgoals-toggle']")).toHaveCount(1);
			// The attach heading must NOT contain the host toggle, and vice-versa.
			await expect(attachSection.locator("[data-testid='goal-form-subgoals-toggle']")).toHaveCount(0);
			await expect(hostSection.locator("[data-testid='goal-form-parent-picker']")).toHaveCount(0);

			// Selecting the ineligible parent surfaces an attachment-focused warning
			// that points at the parent's dashboard → Children tab.
			await picker.selectOption(blockedId);
			const warning = page.locator("[data-testid='goal-form-parent-ineligible-warning']");
			await expect(warning).toBeVisible({ timeout: 10_000 });
			await expect(warning).toContainText(/Children tab/i);
			await expect(warning).toContainText(/attached|host this goal/i);
		} finally {
			await deleteGoal(blockedId).catch(() => {});
			await deleteGoal(openId).catch(() => {});
			await setSubgoalsEnabled(true);
		}
	});
});
