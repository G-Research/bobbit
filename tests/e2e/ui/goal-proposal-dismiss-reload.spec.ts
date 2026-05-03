/**
 * Reproducer for: Dismissed goal proposal restored on reload.
 *
 * Bug: `goalDraft.restore` (src/app/session-manager.ts ~line 286) does not
 * consult the dismissal fingerprint stored in localStorage by
 * `markProposalDismissed`. After the user dismisses a goal proposal, the
 * in-memory slot is cleared and the dismissal flag is written, but the
 * server-side draft (saved by the legacy `onGoalProposal` callback in the
 * goal-assistant when `state.assistantType === "goal"`) still contains
 * `activeGoalProposal`. On page reload, `restoreGoalDraft` runs (only on
 * goal-assistant sessions, gated by `state.assistantType === "goal"`) and
 * unconditionally re-populates `state.activeProposals.goal` from the
 * server-side draft → the panel reappears.
 *
 * Why we drive Dismiss via JS rather than clicking a button:
 * the goal-assistant panel (`renderGoalForm` call at render.ts:833) does
 * NOT pass `onDismiss` — by design, the assistant panel has no Dismiss
 * button. The Dismiss button only lives on the regular-session
 * `goalProposalPanel()` (render.ts:1937), but regular sessions don't run
 * `restoreGoalDraft` (it's gated on `assistantType === "goal"`), so the
 * draft-rehydrate bug doesn't reproduce there.
 *
 * The end-user-visible scenario this exercises is therefore the
 * goal-assistant flow where the user has clicked "Open proposal" on a
 * tool card → proposal panel renders alongside the assistant → user
 * dismisses → reload restores the dismissed proposal. We simulate the
 * dismiss step by writing the fingerprint + clearing the slot exactly
 * the way `markProposalDismissed` + `delete state.activeProposals.goal`
 * does in handleDismiss (render.ts:1918).
 *
 * Currently fails on master at the post-reload "panel must stay hidden"
 * assertion. Will pass once `goalDraft.restore` consults
 * `isProposalDismissedTyped` before populating the slot.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, sendMessage } from "./ui-helpers.js";

async function activeSessionId(page: Page): Promise<string> {
	const sid = await page.evaluate(
		() => (window as any).bobbitState?.selectedSessionId ?? null,
	);
	if (!sid) throw new Error("no active session id");
	return sid;
}

test.describe("Goal proposal dismiss + reload @repro", () => {
	test("dismissed goal proposal stays hidden after page reload (goal-assistant)", async ({ page }) => {
		// 1. Open a goal-assistant session — only flow that runs
		//    `saveGoalDraft` from `onGoalProposal` AND `restoreGoalDraft`
		//    on session attach (both gated on `assistantType === "goal"`).
		await openApp(page);
		const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
		await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
		await expect(newGoalBtn).toBeEnabled({ timeout: 10_000 });
		await newGoalBtn.click();

		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 30_000 });

		// 2. Drive a propose_goal — mock agent emits a propose_goal when
		//    the prompt contains "GOAL_PROPOSAL".
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		// 3. Wait for the goal-assistant preview to reflect the proposal.
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		const sid = await activeSessionId(page);

		// 4. Plant the goal-proposal draft on the server explicitly. The
		//    debounced `saveGoalDraft` triggered by `onGoalProposal` is racy in
		//    the test (the slot may not yet be live when the debounce fires),
		//    so we PUT the draft body directly. This is the exact shape that
		//    `goalDraft.serialize()` produces when a propose_goal has just
		//    arrived (src/app/session-manager.ts:271-282).
		const plantResult = await page.evaluate(async (sidArg: string) => {
			const url = (localStorage.getItem("gateway.url") ?? location.origin).replace(/\/$/, "");
			const token = localStorage.getItem("gateway.token") ?? "";
			const s = (window as any).bobbitState;
			const fields = s?.activeProposals?.goal?.fields ?? null;
			if (!fields) return { error: "slot missing" };
			const body = {
				type: "goal",
				data: {
					sessionId: sidArg,
					activeGoalProposal: fields,
					previewTitle: s?.previewTitle ?? "",
					previewSpec: s?.previewSpec ?? "",
					previewCwd: s?.previewCwd ?? "",
					previewProjectId: s?.previewProjectId ?? "",
					previewTitleEdited: false,
					previewSpecEdited: false,
					previewCwdEdited: false,
					hasReceivedProposal: true,
					goalAssistantTab: s?.assistantTab ?? "chat",
				},
			};
			const res = await fetch(`${url}/api/sessions/${sidArg}/draft`, {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
			return { status: res.status, ok: res.ok };
		}, sid);
		expect(plantResult, "draft plant must succeed").toMatchObject({ ok: true });

		// Confirm the server actually persisted activeGoalProposal.
		await page.waitForFunction(async () => {
			const url = (localStorage.getItem("gateway.url") ?? location.origin).replace(/\/$/, "");
			const token = localStorage.getItem("gateway.token") ?? "";
			const sid = (window as any).bobbitState?.selectedSessionId;
			const res = await fetch(`${url}/api/sessions/${sid}/draft?type=goal`, { headers: { Authorization: `Bearer ${token}` } });
			if (!res.ok) return false;
			const body = await res.json();
			return !!body?.data?.activeGoalProposal?.title;
		}, null, { timeout: 5_000 });

		// 5. Simulate Dismiss exactly as `handleDismiss` (render.ts:1918) does:
		//    write the dismissal fingerprint to localStorage and clear the
		//    in-memory slot. The goal-assistant panel itself has no Dismiss
		//    button (renderGoalForm call at render.ts:833 does not pass
		//    `onDismiss`), so we drive the same state mutation directly.
		await page.evaluate((sidArg: string) => {
			const s = (window as any).bobbitState;
			const fields = { ...(s?.activeProposals?.goal?.fields ?? {}) };
			// Match production normalisation (proposal-helpers.ts):
			// goal `spec` is right-trimmed before fingerprinting so the
			// pre-dismiss in-memory body matches the post-rehydrate body
			// (server adds a trailing newline on round-trip).
			if (typeof fields.spec === "string") {
				fields.spec = (fields.spec as string).replace(/\s+$/u, "");
			}
			const sorted = Object.keys(fields).sort();
			const ordered: Record<string, unknown> = {};
			for (const k of sorted) ordered[k] = fields[k];
			localStorage.setItem(
				`bobbit-goal-proposal-dismissed-${sidArg}`,
				JSON.stringify(ordered),
			);
			delete s.activeProposals.goal;
			s.assistantHasProposal = false;
		}, sid);

		// 6. Reload — `setupSessionSubscription` → `restoreGoalDraft`
		//    runs. On master it unconditionally re-populates
		//    `state.activeProposals.goal` from the server-side draft, and
		//    the assistant preview re-renders the proposal contents.
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });

		// Wait for the connection to re-attach so the restore path has
		// had a chance to fire. We can't poll for the slot becoming
		// populated (that's the bug we expect to NOT happen post-fix);
		// instead poll for *any* state hydrated for this session id.
		await page.waitForFunction(
			(sidArg: string) =>
				(window as any).bobbitState?.selectedSessionId === sidArg,
			sid,
			{ timeout: 15_000 },
		);

		// Give the async draft-restore promise time to resolve. Polling
		// on the negative condition: the slot should NOT exist after the
		// fix; on master it appears within ~hundred ms.
		await page
			.waitForFunction(
				() =>
					!!(window as any).bobbitState?.activeProposals?.goal?.fields?.title,
				null,
				{ timeout: 5_000 },
			)
			.catch(() => {
				/* expected NOT to populate after the fix; falls through
				   to the assertion below. */
			});



		// 7. The assistant goal title input must NOT have been re-populated
		//    from the dismissed proposal. CURRENTLY FAILS — the restore
		//    path re-fills `state.previewTitle` from the draft so the
		//    input shows "E2E Test Goal" again.
		const titleAfterReload = page
			.locator("input[placeholder='Goal title']")
			.first();
		await expect(titleAfterReload).toBeVisible({ timeout: 10_000 });
		await expect(
			titleAfterReload,
			"dismissed goal proposal must NOT re-populate the title input after reload",
		).not.toHaveValue("E2E Test Goal", { timeout: 5_000 });

		// And the in-memory slot must be empty.
		const slotAfter = await page.evaluate(
			() => (window as any).bobbitState?.activeProposals?.goal ?? null,
		);
		expect(
			slotAfter,
			"dismissed goal proposal must NOT re-populate state.activeProposals.goal after reload",
		).toBeNull();
	});
});
