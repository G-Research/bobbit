/** Goal-proposal acceptance, project binding, and sub-goal form journeys. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, openApp, navigateToHash, createSession, deleteSession, createGoal, deleteGoal, apiFetch, defaultProjectId, registerProject } from "../../support/helpers/browser/journeys/journey-fixture.js";
import { createSessionViaUI, sendMessage } from "../../support/helpers/browser/journeys/journey-fixture.js";
import { nonGitCwd } from "../../support/harnesses/browser/e2e-setup.js";
import { seedGoalProposal, setSubgoalsEnabledPreference, waitForGoalProposal } from "../../support/helpers/browser/journeys/proposal-helpers.js";

// Acceptance projection regressions: the regular proposal panel must submit
// the persisted candidate identity and let POST /api/goals own current-state
// validation. The sibling goal-preview handler is pinned in the core source
// contract without duplicating this browser setup.
test.describe("Journey: Goal Proposal — canonical acceptance projection", () => {
	test("stale child proposal keeps its parent through SUBGOALS_DISABLED and succeeds after correction", async ({ page }) => {
		test.setTimeout(90_000);
		await setSubgoalsEnabledPreference(true);
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const parent = await createGoal({
			title: `proposal-parent-${Date.now()}`,
			projectId,
			team: false,
			subgoalsAllowed: true,
			maxNestingDepth: 3,
		});
		const sessionId = await createSession({ projectId });
		let acceptCurrentState = false;
		const submitted: Array<Record<string, unknown>> = [];
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const seeded = await seedGoalProposal(page, sessionId, {
				title: "Stale Child Proposal",
				spec: "A child proposal that must retain its parent through acceptance-time validation.",
				workflow: "general",
				parentGoalId: parent.id,
			});
			expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
			const initial = await waitForGoalProposal(page, "Stale Child Proposal");
			expect(initial.fields.parentGoalId).toBe(parent.id);
			expect(initial.rev).toBeGreaterThan(0);

			await page.route("**/api/goals", async (route) => {
				if (route.request().method() !== "POST") return route.continue();
				const body = route.request().postDataJSON() as Record<string, unknown>;
				submitted.push(body);
				if (!acceptCurrentState) {
					await route.fulfill({
						status: 403,
						contentType: "application/json",
						body: JSON.stringify({
							error: "Sub-goals are disabled in system settings.",
							message: "Sub-goals are disabled in system settings.",
							code: "SUBGOALS_DISABLED",
						}),
					});
					return;
				}
				await route.fulfill({
					status: 201,
					contentType: "application/json",
					body: JSON.stringify({
						id: "corrected-child-goal",
						title: body.title,
						spec: body.spec,
						cwd: body.cwd || nonGitCwd(),
						state: "active",
						team: true,
						projectId,
						parentGoalId: parent.id,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					}),
				});
			});

			await setSubgoalsEnabledPreference(false);
			await expect.poll(
				() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
				{ timeout: 10_000 },
			).toBe("false");

			const panel = page.locator('[data-panel="goal-proposal"]').first();
			const createButton = panel.getByRole("button", { name: "Create Goal" });
			await expect(createButton).toBeEnabled({ timeout: 10_000 });
			await createButton.click();

			await expect(page.locator('[data-testid="error-details-code"]')).toHaveText("SUBGOALS_DISABLED", { timeout: 15_000 });
			await expect(page.locator('[data-testid="error-details-message"]')).toContainText("Sub-goals are disabled");
			expect(submitted).toHaveLength(1);
			expect(submitted[0].parentGoalId, "visibility changes must not rewrite the child candidate into a root").toBe(parent.id);

			const retained = await waitForGoalProposal(page, "Stale Child Proposal");
			expect(retained.rev, "failed acceptance must not advance the draft revision").toBe(initial.rev);
			expect(retained.fields.parentGoalId).toBe(parent.id);
			await expect(panel).toBeVisible();
			const rawDraft = await page.evaluate(async (sid) => {
				const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/proposal/goal`);
				return { status: response.status, text: await response.text() };
			}, sessionId);
			expect(rawDraft.status).toBe(200);
			expect(rawDraft.text).toContain(parent.id);

			const goalsAfterFailure = await (await apiFetch("/api/goals")).json();
			const goalList: any[] = Array.isArray(goalsAfterFailure) ? goalsAfterFailure : goalsAfterFailure.goals ?? [];
			expect(goalList.some(goal => goal.title === "Stale Child Proposal"), "no root/child goal may exist before correction").toBe(false);

			await page.getByRole("button", { name: "OK" }).click();
			acceptCurrentState = true;
			await setSubgoalsEnabledPreference(true);
			await expect.poll(
				() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
				{ timeout: 10_000 },
			).toBe("true");
			await createButton.click();

			await expect.poll(() => submitted.length, { timeout: 10_000 }).toBe(2);
			expect(submitted[1].parentGoalId).toBe(parent.id);
			await expect.poll(
				() => page.evaluate(() => (window as any).bobbitState?.activeProposals?.goal ?? null),
				{ timeout: 10_000 },
			).toBeNull();
			await expect(page).toHaveURL(/#\/goal\/corrected-child-goal$/);
		} finally {
			await page.unroute("**/api/goals").catch(() => {});
			await deleteSession(sessionId).catch(() => {});
			await deleteGoal(parent.id).catch(() => {});
			await setSubgoalsEnabledPreference(true).catch(() => {});
		}
	});

	test("workflowless omitted-workflow proposal stays enabled and reaches createGoal without a workflow", async ({ page }) => {
		test.setTimeout(90_000);
		const rootPath = mkdtempSync(join(tmpdir(), "bobbit-v2-proposal-workflowless-"));
		const project = await registerProject({
			name: `proposal-workflowless-${Date.now()}`,
			rootPath,
			seedWorkflows: false,
		});
		const sessionId = await createSession({ cwd: rootPath, projectId: project.id });
		let submitted: Record<string, unknown> | undefined;
		try {
			const before = await (await apiFetch(`/api/workflows?projectId=${encodeURIComponent(project.id)}`)).json();
			expect(Array.isArray(before) ? before : before.workflows ?? []).toHaveLength(0);

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const seeded = await seedGoalProposal(page, sessionId, {
				title: "Generated Default Proposal",
				spec: "A workflowless proposal whose omitted selection is resolved canonically at creation time.",
			});
			expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
			const proposal = await waitForGoalProposal(page, "Generated Default Proposal");
			expect(proposal.fields).not.toHaveProperty("workflow");
			expect(proposal.fields).not.toHaveProperty("workflowId");

			const afterSeed = await (await apiFetch(`/api/workflows?projectId=${encodeURIComponent(project.id)}`)).json();
			expect(Array.isArray(afterSeed) ? afterSeed : afterSeed.workflows ?? [], "proposal validation must not persist generated defaults").toHaveLength(0);

			await page.route("**/api/goals", async (route) => {
				if (route.request().method() !== "POST") return route.continue();
				submitted = route.request().postDataJSON() as Record<string, unknown>;
				await route.fulfill({
					status: 201,
					contentType: "application/json",
					body: JSON.stringify({
						id: "generated-default-goal",
						title: submitted.title,
						spec: submitted.spec,
						cwd: rootPath,
						state: "active",
						team: true,
						projectId: project.id,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					}),
				});
			});

			const panel = page.locator('[data-panel="goal-proposal"]').first();
			const createButton = panel.getByRole("button", { name: "Create Goal" });
			await expect(createButton, "an empty workflow cache must not hard-stop an omitted selection").toBeEnabled({ timeout: 10_000 });
			await createButton.click();
			await expect.poll(() => submitted, { timeout: 10_000 }).toBeTruthy();
			expect(submitted).not.toHaveProperty("workflowId");
			expect(submitted).not.toHaveProperty("workflow");
			await expect(page.locator('[data-testid="error-details-message"]')).toHaveCount(0);
			await expect(page).toHaveURL(/#\/goal\/generated-default-goal$/);
		} finally {
			await page.unroute("**/api/goals").catch(() => {});
			await deleteSession(sessionId).catch(() => {});
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			rmSync(rootPath, { recursive: true, force: true });
		}
	});
});

// Ported from goal-reattempt-project-binding.spec.ts (audit: project-settings
// GAP, mutant BR71): Create Goal in a Re-attempt session must inherit the
// original goal's projectId (no "No project selected" error).
test.describe("Journey: Goal Re-attempt — project binding", () => {
	test("Create Goal in a re-attempt session inherits the original projectId", async ({ page }) => {
		test.setTimeout(120_000);
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();

		const origResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "v2 original goal to re-attempt",
				spec: "Original spec body for the re-attempt binding journey test.",
				cwd: nonGitCwd(),
				worktree: false,
				autoStartTeam: false,
				projectId,
			}),
		});
		expect(origResp.status).toBe(201);
		const origGoal = await origResp.json();
		let sessionId = "";
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${origGoal.id}`);
			const reattemptBtn = page.locator("button").filter({ hasText: "Re-attempt" }).first();
			await expect(reattemptBtn).toBeVisible({ timeout: 15_000 });

			const sessionCreate = page.waitForResponse(
				(resp) => resp.url().includes("/api/sessions") && resp.request().method() === "POST" && resp.ok(),
				{ timeout: 30_000 },
			);
			await reattemptBtn.click();
			sessionId = (await (await sessionCreate).json()).id;
			expect(sessionId).toBeTruthy();
			// Server inherited projectId + reattemptGoalId.
			const sessData = await (await apiFetch(`/api/sessions/${sessionId}`)).json();
			expect(sessData.projectId).toBe(projectId);
			expect(sessData.reattemptGoalId).toBe(origGoal.id);

			const textarea = page.locator("textarea").first();
			await expect(textarea).toBeVisible({ timeout: 20_000 });
			await textarea.fill("Please create a GOAL_PROPOSAL for the re-attempt");
			await textarea.press("Enter");

			const titleInput = page.locator("input[placeholder='Goal title']").first();
			await expect(titleInput).toBeVisible({ timeout: 30_000 });
			await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

			const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
			await expect(createBtn).toBeEnabled({ timeout: 10_000 });
			const createPost = page.waitForResponse(
				(resp) => resp.url().includes("/api/goals") && resp.request().method() === "POST" && resp.ok(),
				{ timeout: 10_000 },
			).catch(() => null);
			await createBtn.click();

			// The re-attempt derivation must prevent the "No project selected" error.
			await expect(page.getByText("No project selected for this goal")).not.toBeVisible({ timeout: 3_000 });
			expect(await createPost, "POST /api/goals must fire").not.toBeNull();

			// New goal bound to the original projectId.
			await expect.poll(async () => {
				const data = await (await apiFetch("/api/goals")).json();
				const goals: any[] = Array.isArray(data) ? data : data.goals ?? [];
				return goals.find((g) => g.id !== origGoal.id && g.title === "E2E Test Goal" && g.projectId === projectId)?.projectId ?? null;
			}, { timeout: 10_000 }).toBe(projectId);
		} finally {
			const data = await (await apiFetch("/api/goals")).json().catch(() => ({ goals: [] }));
			const goals: any[] = Array.isArray(data) ? data : data.goals ?? [];
			const fresh = goals.find((g) => g.id !== origGoal.id && g.title === "E2E Test Goal");
			if (fresh?.id) await apiFetch(`/api/goals/${fresh.id}`, { method: "DELETE" }).catch(() => {});
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await apiFetch(`/api/goals/${origGoal.id}`, { method: "DELETE" }).catch(() => {});
		}
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
