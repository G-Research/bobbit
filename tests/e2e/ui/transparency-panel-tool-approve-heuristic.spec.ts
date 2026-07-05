/**
 * Browser E2E: Transparency Panel — the REAL CLF-W2.5 tool-approve heuristic
 * classifier (`tool-approve-heuristic.ts`), as opposed to
 * `transparency-panel.spec.ts`'s CLF-W2 test, which drives the decision seam
 * with a FAKE fixture classifier to prove the harness mechanics alone.
 *
 * `server.ts` only registers the real heuristic when `BOBBIT_CLF_TOOL_APPROVE`
 * is set at all (see `isToolApproveHeuristicEnabled`'s doc comment) — this
 * spec file opts into that via `test.use({ enableToolApproveHeuristic: true })`,
 * which sets the flag to `"observe"` (never `"enforce"`) before the worker's
 * gateway boots, so the classifier's real verdicts are recorded for the panel
 * but never change what `requestToolGrant` actually does — this lane ships
 * "observe-mode-only value delivery" (transparency without behavior change).
 *
 * A DIFFERENT worker-scoped option value means this file gets its OWN
 * gateway/worker (Playwright groups by option value), so it cannot
 * contaminate `transparency-panel.spec.ts`'s default (unset) worker.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.use({ enableToolApproveHeuristic: true });

test.describe("Transparency Panel — real tool-approve heuristic classifier (CLF-W2.5, observe mode)", () => {
	let sessionId = "";

	test.afterEach(async () => {
		if (sessionId) {
			try {
				await deleteSession(sessionId);
			} catch {
				/* best-effort cleanup */
			}
			sessionId = "";
		}
	});

	test("a real dangerous-group deny verdict is recorded and rendered with its matched-rule rationale, but does not auto-deny in observe mode", async ({ page, gateway }) => {
		sessionId = await createSession();

		// 1. Synthesize an active turn (same trick transparency-panel.spec.ts's
		// own tests use) so the decision below has a durable TraceEntry to
		// attach to.
		const beforePromptResp = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
			method: "POST",
			body: JSON.stringify({ prompt: "hello" }),
		});
		expect(beforePromptResp.ok).toBe(true);

		// 2. Drive the REAL production call site with a REAL tool the
		// heuristic's "dangerous-group" rule matches (Children/Team/PR
		// Walkthrough are the codebase's own existing never-by-default
		// groups — see tool-approve-heuristic.ts). No fake classifier
		// registration here: `server.ts` already registered the real one
		// because this worker opted into `enableToolApproveHeuristic`.
		const grantPromise = gateway.sessionManager!.requestToolGrant(sessionId, "team_dismiss", "Team");
		await expect
			.poll(() => gateway.sessionManager!.getSession(sessionId)?.pendingGrantRequest !== undefined, { timeout: 5_000 })
			.toBe(true);

		// Observe mode: the heuristic selected "deny" for real, but that must
		// NOT auto-apply — the human-ask flow's promise stays pending until
		// explicitly resolved.
		gateway.sessionManager!.denyToolPermission(sessionId, "team_dismiss");
		const result = await grantPromise;
		expect(result).toEqual({ granted: false });

		// 3. Drive the actual user-visible turn so the transcript has a user
		// row to render the panel under.
		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await sendMessage(page, "hello");
		await waitForAgentResponse(page);

		const toggle = page.locator('[data-testid="transparency-panel-toggle"]').first();
		await expect(toggle).toBeVisible({ timeout: 15_000 });
		// 2 decisions: this test's real tool-approve heuristic verdict + the
		// real F14 router's own abstain, recorded by the production
		// `enqueuePrompt` call site — same two-decisions shape as the CLF-W1a/
		// CLF-W2 transparency-panel tests.
		await expect(toggle).toContainText("2 decisions");

		await toggle.click();
		const rows = page.locator('[data-testid="transparency-panel-rows"]');
		await expect(rows).toBeVisible();
		await expect(rows).toContainText("tool-call");
		await expect(rows).toContainText("tool-approve");
		await expect(rows).toContainText("selected: deny");

		// Expand the row's own detail toggle — this is where the REAL
		// classifier id and its matched-rule rationale render, so users see
		// WHY (the design program's "full transparency, nothing hidden"
		// requirement): which built-in rule fired, and which tool/group it
		// matched.
		await page.locator('[data-testid="transparency-panel-row-toggle"]').first().click();
		await expect(rows).toContainText("builtin.tool-approve-heuristic");
		await expect(rows).toContainText("matched deterministic rule 'dangerous-group'");
		await expect(rows).toContainText('"team_dismiss"');
		await expect(rows).toContainText('"Team"');
	});

	test("a real read-only-safe allow verdict is recorded and rendered (record-only — no CQ-03 auto-apply)", async ({ page, gateway }) => {
		sessionId = await createSession();

		const beforePromptResp = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
			method: "POST",
			body: JSON.stringify({ prompt: "hello" }),
		});
		expect(beforePromptResp.ok).toBe(true);

		const grantPromise = gateway.sessionManager!.requestToolGrant(sessionId, "ls", "File System");
		await expect
			.poll(() => gateway.sessionManager!.getSession(sessionId)?.pendingGrantRequest !== undefined, { timeout: 5_000 })
			.toBe(true);

		gateway.sessionManager!.denyToolPermission(sessionId, "ls");
		const result = await grantPromise;
		expect(result).toEqual({ granted: false });

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await sendMessage(page, "hello");
		await waitForAgentResponse(page);

		const toggle = page.locator('[data-testid="transparency-panel-toggle"]').first();
		await expect(toggle).toBeVisible({ timeout: 15_000 });
		await expect(toggle).toContainText("2 decisions");

		await toggle.click();
		const rows = page.locator('[data-testid="transparency-panel-rows"]');
		await expect(rows).toBeVisible();
		await expect(rows).toContainText("selected: allow");

		await page.locator('[data-testid="transparency-panel-row-toggle"]').first().click();
		await expect(rows).toContainText("builtin.tool-approve-heuristic");
		await expect(rows).toContainText("matched deterministic rule 'read-only-safe'");
		await expect(rows).toContainText('"ls"');
		await expect(rows).toContainText("record-only");
	});
});
