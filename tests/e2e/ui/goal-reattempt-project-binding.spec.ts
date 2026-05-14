/**
 * Reproducer for: Re-attempt project binding bug.
 *
 * When the user clicks "Re-attempt" on a goal, the gateway opens a
 * goal-assistant session with `reattemptGoalId` set; the server inherits
 * `projectId` from the original goal (src/server/server.ts ~line 2832) and
 * attaches it to the new session record. The assistant then calls
 * `propose_goal`, the user clicks "Create Goal" — and the click is rejected
 * with toast "No project selected for this goal" because
 * `state.previewProjectId` is empty.
 *
 * Root cause: `goalProposalPanel()` / `goalPreviewPanel()` (src/app/render.ts
 * ~line 1879 and ~line 757 respectively) gate the create handler on
 * `state.previewProjectId`. That field is only seeded by the +New Goal
 * picker, never from the active session's inherited `projectId` once the
 * proposal lands. The session itself carries the right projectId — the UI
 * just never reads it.
 *
 * This test uses the goal-assistant entry point (`assistantType: "goal"` +
 * `reattemptGoalId`), the same path `startReattempt()` in
 * src/app/session-manager.ts uses. It does NOT exercise the `+ New Goal`
 * picker. The mock agent emits a `propose_goal` for the trigger word
 * "GOAL_PROPOSAL"; we assert the proposal lands, then click Create Goal
 * and verify a goal is created bound to the original goal's projectId
 * with no error dialog.
 *
 * Currently FAILS on master at the post-click assertions: the dialog
 * "No project selected for this goal" appears and no new goal is created.
 * Will pass once `goalProposalPanel()` / `goalPreviewPanel()` derives
 * `state.previewProjectId` from the active session's `projectId`.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, defaultProjectId, deleteSession } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Re-attempt goal proposal project binding @repro", () => {
	test("Create Goal succeeds in re-attempt session and inherits original projectId", async ({ page }) => {
		// Allow generous time for goal-assistant cold-start under parallel
		// browser workers — matches goal-creation.spec.ts budget.
		test.setTimeout(90_000);

		// 1. Resolve the harness default project (registered by gateway-harness).
		const projectId = await defaultProjectId();
		expect(projectId, "default project must be registered").toBeTruthy();

		// 2. Create the original goal in that project — the one we'll re-attempt.
		const origResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Original goal to re-attempt",
				spec: "Original spec body.",
				cwd: ".",
				worktree: false,
				autoStartTeam: false,
				projectId,
			}),
		});
		expect(origResp.status).toBe(201);
		const origGoal = await origResp.json();
		expect(origGoal.projectId).toBe(projectId);

		// 3. Open the app and navigate to the original goal's dashboard so the
		//    Re-attempt button is rendered. This drives the actual user flow
		//    end-to-end — startReattempt() POSTs the new session and then
		//    connects directly without an intervening refreshSessions(), which
		//    is the timing where `state.gatewaySessions` doesn't yet contain
		//    the new session and the previewProjectId fallback at
		//    src/app/session-manager.ts:1654 resolves empty.
		await openApp(page);
		await navigateToHash(page, `#/goal/${origGoal.id}`);

		const reattemptBtn = page.locator("button").filter({ hasText: "Re-attempt" }).first();
		await expect(reattemptBtn).toBeVisible({ timeout: 15_000 });

		// Capture the sessionId from the create POST so we can verify the
		// server inherited projectId, and so we can clean up at the end.
		const sessionCreatePromise = page.waitForResponse(
			(resp) =>
				resp.url().includes("/api/sessions") &&
				resp.request().method() === "POST" &&
				resp.ok(),
			{ timeout: 30_000 },
		);
		await reattemptBtn.click();
		const sessionResp = await sessionCreatePromise;
		const sessionBody = await sessionResp.json();
		const sessionId: string = sessionBody.id;
		expect(sessionId, "reattempt session id").toBeTruthy();

		// Sanity-check: server-side projectId WAS inherited.
		expect(
			sessionBody.id && sessionBody,
			"reattempt session create response",
		).toBeTruthy();
		const verify = await apiFetch(`/api/sessions/${sessionId}`);
		const sessData = await verify.json();
		expect(
			sessData.projectId,
			"server must inherit projectId via reattemptGoalId",
		).toBe(projectId);
		expect(sessData.reattemptGoalId).toBe(origGoal.id);

		// Wait for the goal-assistant chat to render.
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 20_000 });

		// Confirm the client connected to the right session and recognises
		// it as a goal-assistant.
		await page.waitForFunction(
			(sid: string) => {
				const s = (window as any).bobbitState;
				return s?.selectedSessionId === sid && s?.assistantType === "goal";
			},
			sessionId,
			{ timeout: 15_000 },
		);

		// 5. Trigger the mock agent's propose_goal emit (mock-agent-core.mjs
		//    matches /goal_proposal/i).
		await textarea.fill("Please create a GOAL_PROPOSAL for the re-attempt");
		await textarea.press("Enter");

		// 6. Wait for the goal proposal form to render with the mock-agent
		//    title. The proposal panel uses input[placeholder='Goal title'].
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 30_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		// 7. Click "Create Goal".
		const createGoalBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
		await expect(createGoalBtn).toBeVisible({ timeout: 5_000 });
		await expect(createGoalBtn).toBeEnabled({ timeout: 5_000 });

		// Arm the goal-creation POST listener BEFORE clicking, so a fast
		// response can't slip past. If the bug fires, no POST is made
		// (the showConnectionError dialog short-circuits before createGoal),
		// and this waitForResponse will time out — that's the failure mode.
		const createPromisePass = page
			.waitForResponse(
				(resp) =>
					resp.url().includes("/api/goals") &&
					resp.request().method() === "POST" &&
					resp.ok(),
				{ timeout: 10_000 },
			)
			.catch(() => null);
		await createGoalBtn.click();

		// 8. Negative assertion: the "No project selected" error dialog
		//    must NOT appear. On master this dialog appears synchronously
		//    inside the click handler (showConnectionError → renders Dialog
		//    immediately).
		const errorDialogText = page.getByText("No project selected for this goal");
		// Brief settle window for the synchronous render. We deliberately
		// poll on the negative — visible:false is what the fix produces.
		await expect(
			errorDialogText,
			"showConnectionError dialog must not appear after Create Goal click in re-attempt session",
		).not.toBeVisible({ timeout: 3_000 });

		// 9. Positive assertion: the goal POST must have been issued and
		//    the new goal should be bound to the original projectId.
		const createResp = await createPromisePass;
		expect(createResp, "POST /api/goals must fire on Create Goal click").not.toBeNull();

		// Find the newly created goal (title + projectId match) via API.
		await expect
			.poll(
				async () => {
					const r = await apiFetch("/api/goals");
					const data = await r.json();
					const goals: any[] = Array.isArray(data) ? data : data.goals ?? [];
					const fresh = goals.find(
						(g) =>
							g.id !== origGoal.id &&
							g.title === "E2E Test Goal" &&
							g.projectId === projectId,
					);
					return fresh?.projectId ?? null;
				},
				{ timeout: 10_000, message: "new goal must be bound to original goal's projectId" },
			)
			.toBe(projectId);

		// Cleanup: delete fresh goal + session + original goal.
		const r = await apiFetch("/api/goals");
		const data = await r.json();
		const goals: any[] = Array.isArray(data) ? data : data.goals ?? [];
		const fresh = goals.find(
			(g) => g.id !== origGoal.id && g.title === "E2E Test Goal",
		);
		if (fresh?.id) {
			await apiFetch(`/api/goals/${fresh.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
		}
		await deleteSession(sessionId).catch(() => {});
		await apiFetch(`/api/goals/${origGoal.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
	});
});
