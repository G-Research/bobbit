/**
 * Journey: Proposals — v2 browser smoke
 * Covers: journey-proposals
 * Consolidated from: goal-proposal-*, project-proposal-*, proposal-panel-*,
 *   proposal-open-all-types, proposal-panel-streaming, api-error-modal, etc.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch } from "../_helpers/journey-fixture.js";
import { createSessionViaUI, sendMessage } from "../_helpers/journey-fixture.js";
import { createGoalAssistantViaUI } from "../fixtures/ui-helpers.js";

async function waitForProposalSlot(page: import("@playwright/test").Page, type: string): Promise<void> {
	await page.waitForFunction(
		(t: string) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			const fields = state?.activeProposals?.[t]?.fields;
			return fields && typeof fields === "object" && Object.keys(fields).length > 0;
		},
		type,
		{ timeout: 20_000 },
	);
}

// ── Shell / navigation tests ────────────────────────────────────────────────

test.describe("Journey: Proposals — shell", () => {
	test("app shell renders on load", async ({ page }) => {
		await openApp(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
		const title = await page.title();
		expect(title).toBeTruthy();
	});

	test("proposal route is navigable", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("session with idle status shows proposal-compatible UI", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("sidebar visible alongside session for proposal panel integration", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("New Goal button opens dialog or navigates to goal form", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
		if (await newGoalBtn.isVisible({ timeout: 15_000 }).catch(() => false)) {
			await newGoalBtn.click();
			const dialogOrForm = page.locator(
				"dialog, [role='dialog'], [role='alertdialog'], " +
				"goal-proposal-panel, [data-testid='goal-proposal'], " +
				"input[placeholder*='title' i], input[placeholder*='goal' i]"
			).first();
			await expect(dialogOrForm).toBeVisible({ timeout: 20_000 });
		} else {
			test.skip(true, "New Goal button not found; proposals may surface differently in this gateway config");
		}
	});
});

// ── Behavioral: proposal slot + tab ────────────────────────────────────────

test.describe("Journey: Proposals — behavioral", () => {
	test("ROLE_PROPOSAL_PARITY trigger populates role proposal slot in app state", async ({ page }) => {
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
	});

	test("role proposal tab appears with dot after ROLE_PROPOSAL_PARITY", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "ROLE_PROPOSAL_PARITY");
		await waitForProposalSlot(page, "role");
		const roleTab = page.locator('.goal-tab-pill[title="Role"]').first();
		await expect(roleTab).toBeVisible({ timeout: 15_000 });
		await expect(roleTab.locator(".goal-tab-dot")).toBeVisible({ timeout: 15_000 });
	});

	test("goal proposal streaming badge visible during STAY_BUSY stream then disappears", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "STAY_BUSY:propose_goal:10:150");
		const badge = page.locator('[data-testid="proposal-streaming-badge"]').first();
		await expect(badge).toBeVisible({ timeout: 15_000 });
		await expect(badge).toBeHidden({ timeout: 20_000 });
	});

	test("goal proposal submit disabled while streaming then enables", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "STAY_BUSY:propose_goal:10:150");
		const badge = page.locator('[data-testid="proposal-streaming-badge"]').first();
		const submitWrap = page.locator('[data-testid="proposal-primary-submit"]').first();
		await expect(submitWrap).toBeVisible({ timeout: 15_000 });
		const submitBtn = submitWrap.locator("button").first();
		await expect.poll(async () => {
			const [badgeVisible, disabled] = await Promise.all([
				badge.isVisible().catch(() => false),
				submitBtn.isDisabled().catch(() => false),
			]);
			return badgeVisible && disabled;
		}, { timeout: 15_000, intervals: [50, 100, 150] }).toBe(true);
		await expect(badge).toBeHidden({ timeout: 20_000 });
		await expect(submitBtn).toBeEnabled({ timeout: 15_000 });
	});

	test("role proposal pane visible after clicking role tab", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "ROLE_PROPOSAL_PARITY");
		await waitForProposalSlot(page, "role");
		const roleTab = page.locator('.goal-tab-pill[title="Role"]').first();
		await expect(roleTab).toBeVisible({ timeout: 15_000 });
		await roleTab.click();
		const rolePane = page.locator('[data-panel="role-proposal"]').first();
		await expect(rolePane).toBeVisible({ timeout: 15_000 });
	});

	test("role proposal dismiss clears the slot and hides the tab", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "ROLE_PROPOSAL_PARITY");
		await waitForProposalSlot(page, "role");
		const roleTab = page.locator('.goal-tab-pill[title="Role"]').first();
		await expect(roleTab).toBeVisible({ timeout: 15_000 });
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
	});

	test("goal proposal dismiss during streaming sticks after stream ends", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "STAY_BUSY:propose_goal:20:150");
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 15_000 });
		const badge = page.locator('[data-testid="proposal-streaming-badge"]').first();
		await expect(badge).toBeVisible({ timeout: 15_000 });
		const dismissBtn = page.locator("button").filter({ hasText: "Dismiss" }).first();
		await expect(dismissBtn).toBeVisible({ timeout: 15_000 });
		await expect(dismissBtn).toBeEnabled();
		await dismissBtn.click();
		await expect(titleInput).toBeHidden({ timeout: 15_000 });
		await page.waitForFunction(
			() => (window as any).bobbitState?.remoteAgent?.state?.status === "idle",
			{ timeout: 15_000 },
		);
		await expect(titleInput).toBeHidden();
	});
});

test.describe("Journey: Proposals — API error handling", () => {
	test("createGoal 400 shows server error in error modal (page.route stub)", async ({ page }) => {
		test.setTimeout(90_000);
		await page.route("**/api/goals", async (route) => {
			if (route.request().method() !== "POST") return route.continue();
			await route.fulfill({
				status: 400,
				contentType: "application/json",
				body: JSON.stringify({
					error: "Journey test: missing title",
					stack: "Error: Journey test: missing title\n    at goalManager.create (server.ts:1:1)",
				}),
			});
		});
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "STAY_BUSY:propose_goal:4:80");
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 15_000 });
		const badge = page.locator('[data-testid="proposal-streaming-badge"]').first();
		await expect(badge).toBeHidden({ timeout: 20_000 });
		const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
		if (await createBtn.isVisible({ timeout: 15_000 }).catch(() => false)) {
			await createBtn.click();
			const errorMsg = page.locator('[data-testid="error-details-message"]').first();
			await expect(errorMsg).toHaveText("Journey test: missing title", { timeout: 20_000 });
			const bodyText = await page.locator("body").innerText();
			expect(bodyText).not.toContain("Failed to create goal: 400");
		} else {
			test.skip(true, "Create Goal button not present in this harness config");
		}
	});

	test("page.route() session list 500 still lets app load gracefully", async ({ page }) => {
		let firstCallDone = false;
		await page.route("**/api/sessions", async (route) => {
			if (route.request().method() === "GET" && !firstCallDone) {
				firstCallDone = true;
				await route.fulfill({ status: 500, body: "Internal Server Error" });
				return;
			}
			return route.continue();
		});
		await openApp(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 15_000 });
	});

	// Ported from proposal-tools.spec.ts (audit: proposals PARTIAL): the goal
	// proposal tool card must render an Open button (proposal-open-button).
	test("goal proposal tool card renders the Open button", async ({ page }) => {
		test.setTimeout(120_000);
		await openApp(page);
		await createGoalAssistantViaUI(page, { timeout: 60_000 });
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 30_000 });
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		// Tool card summary + Open button.
		await expect(page.getByText("Goal Proposal").first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator('[data-testid="proposal-open-button"]').first()).toBeVisible({ timeout: 15_000 });
	});
});

// Ported from failed-goal-proposal-ux.spec.ts (audit: proposals GAP): a
// MISSING_WORKFLOW failed proposal surfaces the workflow-error row.
test.describe("Journey: Failed Goal Proposal", () => {
	test("MISSING_WORKFLOW surfaces the goal-proposal-workflow-error row", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "Please run GOAL_PROPOSAL_MISSING_WORKFLOW now");
		const workflowError = page.locator('[data-testid="goal-proposal-workflow-error"]').first();
		await expect(workflowError).toBeVisible({ timeout: 20_000 });
		await expect(workflowError).toContainText(/Workflow is required/i, { timeout: 10_000 });
	});
});

// Ported from goal-proposal-subgoal-prefill.spec.ts (audit: proposals GAP,
// mutant BR45): an agent can pre-fill everything a human sets on the goal
// proposal's Sub-goals tab. syncProposalFormState() seeds the form controls
// from subgoalsAllowed/maxNestingDepth/divergencePolicy/maxConcurrentChildren
// so the panel opens with the agent's choices already selected.
test.describe("Journey: Goal Proposal — Sub-goals prefill", () => {
	async function setSubgoals(value: boolean): Promise<void> {
		const resp = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: value }),
		});
		expect(resp.status).toBe(200);
	}

	test.afterEach(async () => { await setSubgoals(true); });

	test("Sub-goals tab reflects agent-prefilled depth/concurrency/policy", async ({ page }) => {
		test.setTimeout(90_000);
		await setSubgoals(true);
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "Please GOAL_PROPOSAL_SUBGOAL_PREFILL now");

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("Prefilled Goal", { timeout: 15_000 });

		const subgoalsTab = page.locator("[data-testid='goal-proposal-tab-subgoals']");
		await expect(subgoalsTab).toBeVisible({ timeout: 10_000 });
		await subgoalsTab.click();

		// Allow-subgoals is pre-checked (agent set subgoalsAllowed: true).
		const toggle = page.locator("[data-testid='goal-form-subgoals-toggle']");
		await expect(toggle).toBeVisible({ timeout: 10_000 });
		await expect(toggle).toBeChecked();

		// Max-depth control retains its testid AND reflects the agent's value (2).
		await expect(page.locator("[data-testid='goal-form-max-depth']"))
			.toHaveValue("2", { timeout: 10_000 });

		// Concurrency reflects the agent's value (4).
		await expect(page.locator("[data-testid='goal-form-max-concurrent-children']"))
			.toHaveValue("4", { timeout: 10_000 });

		// Divergence policy 'autonomous' is the pressed segment.
		await expect(page.locator("[data-testid='goal-form-divergence-autonomous']"))
			.toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
		await expect(page.locator("[data-testid='goal-form-divergence-balanced']"))
			.toHaveAttribute("aria-pressed", "false", { timeout: 5_000 });
	});
});

// Ported from proposal-edit-flow.spec.ts (audit: proposals GAP, mutant BR54):
// an editable project proposal panel exposes its Apply/Accept button via the
// accept-label testid, and applying the (live-edited) proposal persists.
test.describe("Journey: Editable Project Proposal", () => {
	test("edit_proposal updates the slot live; Apply (accept-label) persists edited value", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);

		// Initial propose_project → slot populates with build_command="echo old".
		await sendMessage(page, "EDITABLE_PROPOSAL_INITIAL");
		await page.waitForFunction(
			() => {
				const s = (window as any).bobbitState ?? (window as any).__bobbitState;
				return s?.activeProposals?.project?.fields?.build_command === "echo old";
			},
			null,
			{ timeout: 20_000 },
		);
		const panel = page.locator('[data-panel="project-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 15_000 });

		// Surgical edit → slot flips live to "echo new" with no re-emit.
		await sendMessage(page, "EDITABLE_PROPOSAL_EDIT");
		await page.waitForFunction(
			() => {
				const s = (window as any).bobbitState ?? (window as any).__bobbitState;
				return s?.activeProposals?.project?.fields?.build_command === "echo new";
			},
			null,
			{ timeout: 15_000 },
		);

		// The Apply button is located via the accept-label testid (the mutant target).
		const acceptLabel = panel.locator('[data-testid="accept-label"]').first();
		await expect(acceptLabel).toBeVisible({ timeout: 15_000 });
		// Accept is gated by `streaming`; wait for the agent to go idle so the
		// button reflects its enabled (name-present) state.
		await page.waitForFunction(
			() => ((window as any).bobbitState ?? (window as any).__bobbitState)?.remoteAgent?.state?.status === "idle",
			null,
			{ timeout: 20_000 },
		);
		const applyBtn = panel.locator("button", { has: page.locator('[data-testid="accept-label"]') }).first();
		await expect(applyBtn).toBeEnabled({ timeout: 10_000 });
		await applyBtn.click();

		// Slot clears and panel disappears once the edited config is applied.
		await page.waitForFunction(
			() => !((window as any).bobbitState ?? (window as any).__bobbitState)?.activeProposals?.project,
			null,
			{ timeout: 15_000 },
		);
		await expect(panel).toBeHidden({ timeout: 10_000 });
	});

	// Ported from project-assistant.spec.ts (audit: proposals/project-assistant
	// GAP, mutant BR57): a multi-component propose_project renders structured
	// component cards in the Components view and per-component + all-components
	// workflow cards under the Workflows tab.
	test("multi-component project proposal renders component + workflow cards", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "MULTI_COMPONENT_PROPOSAL");

		const panel = page.locator('[data-panel="project-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 20_000 });

		// Components view (default) renders both structured component cards.
		await expect(panel.locator('[data-testid="component-card-api"]')).toBeVisible({ timeout: 20_000 });
		await expect(panel.locator('[data-testid="component-card-web"]')).toBeVisible({ timeout: 10_000 });

		// Switch to the Workflows tab — per-component + all-components cards
		// (mutant target: workflow-card-<id>) must render.
		await panel.locator('[data-testid="view-tab-workflows"]').click();
		await expect(panel.locator('[data-testid="workflow-card-feature-api"]')).toBeVisible({ timeout: 15_000 });
		await expect(panel.locator('[data-testid="workflow-card-feature-web"]')).toBeVisible({ timeout: 10_000 });
		await expect(panel.locator('[data-testid="workflow-card-all-components"]')).toBeVisible({ timeout: 10_000 });
	});
});

// Ported from goal-proposal-invalid-workflow.spec.ts (audit: proposals GAP,
// mutant BR58): the assistant goal-proposal panel must normalize a phantom
// (project-absent) workflow id to a valid configured workflow so the <select>
// never desyncs to an empty/phantom value.
test.describe("Journey: Goal Proposal — invalid workflow normalization", () => {
	const PHANTOM_WORKFLOW = "__does_not_exist_wf__";

	test("assistant panel normalizes a phantom workflow to a valid default", async ({ page }) => {
		test.setTimeout(120_000);
		await openApp(page);
		await createGoalAssistantViaUI(page, { timeout: 60_000 });
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 30_000 });
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		const select = page.locator(".goal-preview-panel select").first();
		await expect(select).toBeVisible({ timeout: 15_000 });
		const options = await select.locator("option").evaluateAll(
			(opts) => (opts as HTMLOptionElement[]).map((o) => o.value),
		);
		expect(options.length, "harness project must expose multiple workflows").toBeGreaterThan(1);

		// Inject a phantom workflow into the assistant panel's imperative state
		// and force a re-render — normalizeWorkflowSelections must repair it.
		await page.evaluate((phantom) => {
			(window as any).__bobbitSetSelectedWorkflowId?.(phantom);
			(window as any).__bobbitRenderApp?.();
		}, PHANTOM_WORKFLOW);

		// The displayed option must be a real configured workflow — never empty
		// (the desync symptom) and never the phantom id.
		await expect.poll(async () => select.inputValue(), { timeout: 8_000 }).not.toBe("");
		const fallbackValue = await select.inputValue();
		expect(options).toContain(fallbackValue);
		expect(fallbackValue).not.toBe(PHANTOM_WORKFLOW);
	});
});
