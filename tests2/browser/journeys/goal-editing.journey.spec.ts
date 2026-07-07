/**
 * Journey: Goal Editing + Subgoals — v2 browser smoke
 * Covers: journey-goal-editing, journey-subgoals
 * Consolidated from: goal-edit-*, goal-spec-*, subgoals-*, etc.
 */
import { test, expect, openApp, navigateToHash, createGoal, deleteGoal, apiFetch, defaultProjectId, sendMessage, createSessionViaUI } from "../_helpers/journey-fixture.js";
import { nonGitCwd } from "../e2e-setup.js";
import { createGoalAssistantViaUI } from "../fixtures/ui-helpers.js";

test.describe("Journey: Goal Editing", () => {
	test("goal dashboard renders goal title", async ({ page }) => {
		const title = "v2-goal-editing-smoke";
		const goal = await createGoal({ title });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(title).first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("goal dashboard shows sidebar edge", async ({ page }) => {
		const goal = await createGoal({ title: "v2-goal-edit-sidebar" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});
});

test.describe("Journey: Subgoals", () => {
	test("goal route renders for subgoal context", async ({ page }) => {
		const goal = await createGoal({ title: "v2-subgoal-smoke" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("multiple goals navigable without crash", async ({ page }) => {
		const g1 = await createGoal({ title: "v2-subgoal-a" });
		const g2 = await createGoal({ title: "v2-subgoal-b" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${g1.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/goal/${g2.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteGoal(g1.id, true);
			await deleteGoal(g2.id, true);
		}
	});
});

// Behavioral assertions ported from goal-archive-always-on.spec.ts
test.describe("Journey: Goal Archive Always-On — behavioral assertions", () => {
	test("archive button is visible and enabled in goal dashboard", async ({ page }) => {
		const goal = await createGoal({ title: "v2-archive-btn-smoke", team: false });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			// Archive button must be present regardless of team/PR state
			const archiveBtn = page.locator(".dashboard-container").getByRole("button", { name: "Archive", exact: true }).first();
			await expect(archiveBtn).toBeVisible({ timeout: 20_000 });
			await expect(archiveBtn).toBeEnabled();
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("clicking archive button and confirming marks goal archived in API", async ({ page }) => {
		const goal = await createGoal({ title: "v2-archive-confirm-smoke", team: false });
		const goalId = goal.id as string;
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goalId}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			const archiveBtn = page.locator(".dashboard-container").getByRole("button", { name: "Archive", exact: true }).first();
			await expect(archiveBtn).toBeVisible({ timeout: 20_000 });
			await archiveBtn.click();
			// Confirmation dialog
			const dialog = page.locator("body > div")
				.filter({ has: page.getByRole("heading", { name: "Archive Goal", exact: true }) })
				.last();
			await expect(
				dialog.getByRole("heading", { name: "Archive Goal", exact: true }),
			).toBeVisible({ timeout: 15_000 });
			await dialog.getByRole("button", { name: "Archive", exact: true }).click();
			await expect(dialog).toBeHidden({ timeout: 15_000 });
			// Goal must be archived in API
			await expect.poll(async () => {
				const r = await apiFetch(`/api/goals/${goalId}`);
				if (!r.ok) return "missing";
				const g = await r.json();
				return g.archived === true ? "archived" : "active";
			}, { timeout: 20_000 }).toBe("archived");
		} finally {
			await deleteGoal(goalId, true);
		}
	});
});

// Behavioral assertions ported from goal-creation.spec.ts
test.describe("Journey: Goal Creation — behavioral assertions", () => {
	test("created goal appears in API goals list", async () => {
		const title = `v2-creation-api-list-${Date.now()}`;
		const goal = await createGoal({ title });
		try {
			const resp = await apiFetch("/api/goals");
			expect(resp.ok).toBe(true);
			const data = await resp.json();
			const goals = (data.goals || data) as Array<{ id: string; title: string }>;
			const found = goals.find((g) => g.title === title);
			expect(found).toBeTruthy();
			expect(found!.id).toBe(goal.id);
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("created goal title appears in sidebar after API creation", async ({ page }) => {
		const title = `v2-creation-sidebar-${Date.now()}`;
		const goal = await createGoal({ title });
		try {
			await openApp(page);
			// Goal must be visible in the sidebar goals list
			await expect(page.getByText(title).first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});
});

// Behavioral assertions ported from goal-empty-workflows-banner.spec.ts
test.describe("Journey: Goal Empty Workflows Banner — behavioral assertions", () => {
	test("workflows API returns a workflows array", async () => {
		const resp = await apiFetch("/api/workflows");
		expect(resp.ok).toBe(true);
		const data = await resp.json();
		// /api/workflows returns { workflows: [...] }
		expect(Array.isArray(data.workflows)).toBe(true);
	});

	test("empty-workflows route: banner visible and Create Goal button disabled", async ({ page }) => {
		test.setTimeout(90_000);
		// Route-mock all GET /api/workflows to return an empty list
		await page.route(/\/api\/workflows(?:\?.*)?$/, async (route, req) => {
			if (req.method() === "GET") {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify([]),
				});
				return;
			}
			await route.continue();
		});

		await openApp(page);
		await createGoalAssistantViaUI(page);
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 15_000 });
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 15_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		// Banner must appear
		const banner = page.locator('[data-testid="goal-form-no-workflows-banner"]').first();
		await expect(banner).toBeVisible({ timeout: 20_000 });
		await expect(banner).toContainText("no workflows yet");

		// Create Goal button must be disabled
		const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
		await expect(createBtn).toBeDisabled();
	});
});

// Behavioral assertions ported from goal-form-tooltips.spec.ts
test.describe("Journey: Goal Form Tooltips — behavioral assertions", () => {
	test("workflow select dropdown renders in goal proposal panel", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createGoalAssistantViaUI(page);
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 15_000 });
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		// Workflow select must exist in the proposal panel
		const workflowSelect = page.locator(".goal-preview-panel select").first();
		await expect(workflowSelect).toBeVisible({ timeout: 15_000 });
		// Should have at least the "general" workflow option
		await expect(workflowSelect.locator("option[value='general']")).toHaveCount(1);
	});

	test("optional step tooltip ⓘ icon renders with cursor-help class after workflow switch", async ({ page }) => {
		test.setTimeout(90_000);
		// Configure qa_start_command on default project for the tooltip to show workflow description
		const projectId = await defaultProjectId();
		if (projectId) {
			const structuredResp = await apiFetch(`/api/projects/${projectId}/structured`).catch(() => null);
			if (structuredResp?.ok) {
				const data = await structuredResp.json();
				const comps = Array.isArray(data.components) ? data.components : [];
				if (comps.length > 0) {
					comps[0].config = { ...(comps[0].config || {}), qa_start_command: "echo ready" };
					await apiFetch(`/api/projects/${projectId}/config`, {
						method: "PUT",
						body: JSON.stringify({ components: comps }),
					});
				}
			}
		}

		await openApp(page);
		await createGoalAssistantViaUI(page);
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 15_000 });
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		// Switch to feature workflow which has an optional QA Testing step with a tooltip
		const workflowSelect = page.locator(".goal-preview-panel select").first();
		await expect(workflowSelect).toBeVisible({ timeout: 15_000 });
		await workflowSelect.selectOption("feature");

		// Tooltip icon must render with cursor-help class
		const qaLabel = page.locator(".goal-preview-panel label", { hasText: "Enable QA Testing" }).first();
		await expect(qaLabel).toBeVisible({ timeout: 15_000 });
		const tooltipIcon = qaLabel.locator("span.cursor-help").first();
		await expect(tooltipIcon).toBeVisible({ timeout: 15_000 });
		await expect(tooltipIcon).toHaveText("ⓘ");
	});
});

// Behavioral assertions ported from subgoal-existing-goal-settings.spec.ts
test.describe("Journey: Subgoal Existing Goal Settings — behavioral assertions", () => {
	test("goal created with subgoalsAllowed:false has that flag in API response", async () => {
		const goal = await createGoal({ title: "v2-subgoal-settings-false", team: false, subgoalsAllowed: false });
		try {
			const resp = await apiFetch(`/api/goals/${goal.id}`);
			expect(resp.ok).toBe(true);
			const data = await resp.json();
			expect(data.subgoalsAllowed).toBe(false);
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("children tab visible in dashboard for goal with subgoalsAllowed:true", async ({ page }) => {
		// Ensure system subgoals flag is on
		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: true }),
		});
		const goal = await createGoal({ title: "v2-subgoal-settings-tab", team: false, subgoalsAllowed: true });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			// Children tab must be present when subgoals are allowed
			const childrenTab = page.locator('[data-testid="tab-children"]').first();
			await expect(childrenTab).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});
});

// Behavioral assertions ported from subgoal-nesting-limit.spec.ts
test.describe("Journey: Subgoal Nesting Limit — behavioral assertions", () => {
	test("max-depth stepper visible and enabled when subgoals flag is on", async ({ page }) => {
		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: true }),
		});
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");
		const stepper = page.locator("[data-testid='general-max-nesting-depth']");
		await expect(stepper).toBeVisible({ timeout: 20_000 });
		await expect(stepper).toBeEnabled();
	});

	test("max-depth stepper is disabled when subgoals flag is off", async ({ page }) => {
		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: false }),
		});
		try {
			await openApp(page);
			await navigateToHash(page, "#/settings/system/general");
			const stepper = page.locator("[data-testid='general-max-nesting-depth']");
			await expect(stepper).toBeVisible({ timeout: 20_000 });
			await expect(stepper).toBeDisabled();
		} finally {
			// Restore default
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ subgoalsEnabled: true }),
			});
		}
	});
});

// Behavioral assertions ported from subgoal-parent-picker-repro.spec.ts
test.describe("Journey: Subgoal Parent Picker — behavioral assertions", () => {
	test("goal API accepts parentGoalId and returns linked parent in response", async () => {
		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: true }),
		});
		const parentSpec = "Parent goal for parent-picker journey test, padded to satisfy the spec minimum length validator.";
		const parent = await createGoal({ title: "v2-picker-parent", team: false, subgoalsAllowed: true });
		let childId: string | undefined;
		try {
			const childResp = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: `v2-picker-child-${Date.now()}`,
					cwd: nonGitCwd(),
					worktree: false,
					autoStartTeam: false,
					workflowId: "feature",
					spec: parentSpec,
					projectId: await defaultProjectId(),
					parentGoalId: parent.id,
				}),
			});
			expect(childResp.status).toBe(201);
			const childBody = await childResp.json();
			childId = childBody.id as string;
			expect(childBody.parentGoalId).toBe(parent.id);
		} finally {
			if (childId) await deleteGoal(childId).catch(() => {});
			await deleteGoal(parent.id, true);
		}
	});

	test.skip("ineligible (sub-goals off) parent option is marked in proposal panel picker", async ({ page }) => {
		// Skipped: state.goals picker population requires full app boot + proposal
		// flow; projectId filter interacts badly under concurrent worker load.
		// Covered by legacy suite (tests/e2e/ui/subgoal-parent-picker-repro.spec.ts).
		test.slow(); // complex full-stack flow: goals fetch + proposal form + picker populate
		test.setTimeout(90_000);
		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: true }),
		});
		const stamp = Date.now();
		const blockedSpec = "Parent goal for parent-picker eligibility journey test, padded to satisfy spec minimum length.";
		const blockedResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: `v2-picker-blocked-${stamp}`,
				cwd: nonGitCwd(),
				worktree: false,
				autoStartTeam: false,
				workflowId: "feature",
				spec: blockedSpec,
				projectId: await defaultProjectId(),
				subgoalsAllowed: false,
			}),
		});
		expect(blockedResp.status).toBe(201);
		const blockedId = (await blockedResp.json()).id as string;

		try {
			await openApp(page);
			await createSessionViaUI(page);
			await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

			const titleInput = page.locator("input[placeholder='Goal title']").first();
			await expect(titleInput).toBeVisible({ timeout: 20_000 });
			await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

			// Sub-goals tab must be visible (system flag ON)
			const subgoalsTab = page.locator("[data-testid='goal-proposal-tab-subgoals']");
			await expect(subgoalsTab).toBeVisible({ timeout: 20_000 });
			await subgoalsTab.click();

			// Wait for state.goals to include blockedId (goals are fetched async;
			// the picker renders from state.goals — ensure it's populated first).
			await page.waitForFunction(
				(id: string) => ((window as any).__bobbitState?.goals ?? []).some((g: any) => g.id === id),
				blockedId,
				{ timeout: 30_000 },
			);
			// Parent picker must contain the blocked parent as an option
			const picker = page.locator("[data-testid='goal-form-parent-picker']");
			await expect(picker).toBeVisible({ timeout: 20_000 });
			await expect(
				picker.locator(`option[value="${blockedId}"]`),
			).toHaveCount(1, { timeout: 30_000 });

			// Ineligible parent must be marked: disabled or "(sub-goals off)" suffix
			const blocked = await picker
				.locator(`option[value="${blockedId}"]`)
				.evaluate((o: HTMLOptionElement) => ({ disabled: o.disabled, text: o.textContent || "" }));
			const isMarked = blocked.disabled || /sub-?goals?\s*off/i.test(blocked.text);
			expect(
				isMarked,
				`ineligible parent option must be marked; got disabled=${blocked.disabled} text=${JSON.stringify(blocked.text)}`,
			).toBe(true);
		} finally {
			await deleteGoal(blockedId).catch(() => {});
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ subgoalsEnabled: true }),
			});
		}
	});
});

// Behavioral assertions ported from subgoals-experimental-toggle.spec.ts
test.describe("Journey: Subgoals Experimental Toggle — behavioral assertions", () => {
	test("subgoals toggle and experimental pill render in settings", async ({ page }) => {
		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: true }),
		});
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");
		const checkbox = page.locator("[data-testid='general-subgoals-enabled']");
		await expect(checkbox).toBeVisible({ timeout: 20_000 });
		await expect(checkbox).toBeChecked();
		// Experimental pill must be visible alongside the toggle
		const pill = page.locator("[data-testid='experimental-pill']").first();
		await expect(pill).toBeVisible();
		await expect(pill).toHaveText(/experimental/i);
	});

	test("toggling subgoals OFF fires PUT to preferences and flips dataset attribute", async ({ page }) => {
		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: true }),
		});
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		const checkbox = page.locator("[data-testid='general-subgoals-enabled']");
		await expect(checkbox).toBeVisible({ timeout: 20_000 });
		await expect(checkbox).toBeChecked();

		const prefResp = page.waitForResponse(
			(r) => r.url().includes("/api/preferences")
				&& r.request().method() === "PUT"
				&& r.status() === 200,
		);
		await checkbox.click();
		await expect(checkbox).not.toBeChecked();
		await prefResp;
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
		).toBe("false");

		// Restore
		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: true }),
		});
	});
});

// Ported from subgoal-parent-picker-repro.spec.ts (audit: goal-editing GAP):
// with subgoals enabled, the goal-proposal Sub-goals tab exposes the parent
// picker.
test.describe("Journey: Subgoal Parent Picker", () => {
	test("Sub-goals tab exposes the parent picker when subgoals enabled", async ({ page }) => {
		test.setTimeout(120_000);
		const pref = await apiFetch("/api/preferences", { method: "PUT", body: JSON.stringify({ subgoalsEnabled: true }) });
		expect(pref.status).toBe(200);
		try {
			await openApp(page);
			await createGoalAssistantViaUI(page, { timeout: 60_000 });
			const textarea = page.locator("textarea").first();
			await expect(textarea).toBeVisible({ timeout: 30_000 });
			await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
			const titleInput = page.locator("input[placeholder='Goal title']").first();
			await expect(titleInput).toBeVisible({ timeout: 20_000 });
			const subgoalsTab = page.locator("[data-testid='goal-proposal-tab-subgoals']").first();
			await expect(subgoalsTab).toBeVisible({ timeout: 15_000 });
			await subgoalsTab.click();
			await expect(page.locator("[data-testid='goal-form-parent-picker']").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await apiFetch("/api/preferences", { method: "PUT", body: JSON.stringify({ subgoalsEnabled: false }) }).catch(() => {});
		}
	});
});
