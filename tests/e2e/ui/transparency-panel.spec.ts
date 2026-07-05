/**
 * Browser E2E: Transparency Panel — classifier decision rows (CLF-W1a).
 *
 * Design: the Fable program's classifier-framework design note,
 * Wave 1(a) ("Transparency first: TraceEntry.decisions[] + panel rows +
 * browser E2E ... before any classifier") and its transparency-panel
 * design note.
 *
 * There is still NO production call site for `LifecycleHub.dispatchDecision`
 * (CLF-W0b shipped it dark; CLF-W1b wires the first real customer, the F14
 * thinking router). So this test drives the two REAL seams that DO exist
 * today rather than a stub:
 *
 *   1. `POST /api/sessions/:id/provider-hooks/before-prompt` — the actual
 *      production endpoint the pi bridge's `before_agent_start` hook calls
 *      every turn (server.ts), which runs `LifecycleHub.dispatch("beforePrompt", ...)`
 *      and writes a real, persisted `TraceEntry`.
 *   2. `gateway.sessionManager.lifecycleHub` — the in-process hub handle
 *      (the gateway runs in the SAME process as this test; see
 *      `gateway-harness.ts`'s header comment). This mirrors the established
 *      "reach into `gateway.sessionManager.<internal>`" pattern already used
 *      by `cost-popover-cache-hit.spec.ts` (`getCostTracker`) and
 *      `pre-compaction-history.spec.ts` (`getPersistedSession`) — no new
 *      debug/test-only server endpoint needed. We register a fake
 *      `DecisionClassifier` and call `dispatchDecision` directly, which
 *      attaches a real `DecisionOutcome` onto the `TraceEntry` written above
 *      (`ContextTraceStore.appendDecision`).
 *
 * Deliberately NOT using `page.route()` to stub `/context-trace` — the point
 * of the reload assertion is that the row is read back from the real,
 * on-disk JSONL trace store, not from a mocked response that would "persist"
 * regardless of whether the server-side write path actually works.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("Transparency Panel — decisions rows (CLF-W1a)", () => {
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

	test("a recorded decision renders folded, expands to full detail, and survives reload", async ({ page, gateway }) => {
		sessionId = await createSession();

		const hub = gateway.sessionManager?.lifecycleHub;
		expect(hub).toBeTruthy();

		// Register a fake classifier at an allow-listed (point, kind) — the exact
		// registration seam CLF-W0b shipped for tests (see
		// tests/lifecycle-hub-dispatch-decision.test.ts). No production code
		// calls dispatchDecision yet; this simulates the future CLF-W1b customer.
		const unregister = hub.registerDecisionClassifier("agent-prompt", "thinking", {
			id: "e2e-fake-classifier",
			evaluate: () => ({ kind: "select", choice: "xhigh", confidence: 0.9, rationale: "e2e fixture" }),
		});

		try {
			// 1. Drive the REAL per-turn dispatch() call site — creates a real
			// persisted TraceEntry (hook: "beforePrompt") for this session.
			const beforePromptResp = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
				method: "POST",
				body: JSON.stringify({ prompt: "hello" }),
			});
			expect(beforePromptResp.ok).toBe(true);

			// 2. Fire the decision seam directly (in-process) — attaches into the
			// TraceEntry the call above just wrote.
			const session = gateway.sessionManager!.getSession(sessionId);
			const outcome = await hub.dispatchDecision("agent-prompt", "thinking", {
				sessionId,
				cwd: session?.cwd ?? "",
			});
			expect(outcome).toEqual({ kind: "select", choice: "xhigh", confidence: 0.9, rationale: "e2e fixture" });

			// 3. Drive the actual user-visible turn so the transcript has a user
			// row to render the panel under. CLF-W1b note: since the F14 thinking
			// router is now a REAL registered classifier at
			// (user-prompt-submit, thinking) — a DIFFERENT (point,kind) pair from
			// this test's fake ("agent-prompt", "thinking") — sending "hello"
			// through the real `enqueuePrompt` also consults it for real, and it
			// (correctly) abstains, adding a SECOND decision onto the same
			// TraceEntry this test synthesized above. Two decisions is the
			// correct post-CLF-W1b count, not a fixture bug.
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await sendMessage(page, "hello");
			await waitForAgentResponse(page);

			const toggle = page.locator('[data-testid="transparency-panel-toggle"]').first();
			await expect(toggle).toBeVisible({ timeout: 15_000 });
			await expect(toggle).toContainText("2 decisions");

			// Folded by default — row detail is not in the DOM until expanded.
			await expect(page.locator('[data-testid="transparency-panel-rows"]')).toHaveCount(0);

			await toggle.click();
			const rows = page.locator('[data-testid="transparency-panel-rows"]');
			await expect(rows).toBeVisible();
			await expect(rows).toContainText("agent-prompt");
			await expect(rows).toContainText("thinking");
			await expect(rows).toContainText("selected: xhigh");
			await expect(rows).toContainText("consulted 1");
			// The real F14 router's own abstain, recorded by the production
			// enqueuePrompt call site (CLF-W1b), not this test's fixture.
			await expect(rows).toContainText("user-prompt-submit");
			await expect(rows).toContainText("abstained");

			// Expand the row's own detail toggle for consulted ids + rationale.
			await page.locator('[data-testid="transparency-panel-row-toggle"]').first().click();
			await expect(rows).toContainText("e2e-fake-classifier");
			await expect(rows).toContainText("e2e fixture");

			// 4. Persistence across reload — re-fetched from the durable JSONL
			// trace store, not a stubbed route.
			await page.reload();
			await navigateToHash(page, `#/session/${sessionId}`);
			const toggleAfterReload = page.locator('[data-testid="transparency-panel-toggle"]').first();
			await expect(toggleAfterReload).toBeVisible({ timeout: 15_000 });
			await expect(toggleAfterReload).toContainText("2 decisions");
		} finally {
			unregister();
		}
	});

	test("a turn with zero decisions renders no panel (byte-identical empty state)", async ({ page }) => {
		sessionId = await createSession();
		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await sendMessage(page, "hello, no decisions recorded for this turn");
		await waitForAgentResponse(page);

		// No `<transparency-panel>` markup at all — not just hidden — for a
		// turn with zero recorded decisions (matches TransparencyPanel.render()
		// returning `nothing`, pinned server-side by
		// tests/lifecycle-hub-decision-trace.test.ts's "never gains a
		// `decisions` field" case).
		await expect(page.locator('[data-testid="transparency-panel"]')).toHaveCount(0);
	});
});

/**
 * CLF-W1b: the F14 thinking router is now a REAL registered production
 * classifier (`registerThinkingRouterClassifier`, wired at gateway
 * construction in server.ts) — not the fake classifier CLF-W1a's test above
 * used to prove the seam mechanically works. This drives an actual prompt
 * containing 'ultrathink' through the real `SessionManager.enqueuePrompt` →
 * `LifecycleHub.dispatchDecision("user-prompt-submit", "thinking", ...)` path
 * and asserts the REAL decision renders.
 *
 * A per-turn `TraceEntry` only exists once `dispatch()` has run at least once
 * for the session (see `ContextTraceStore.appendDecision`'s "attaches to the
 * LATEST entry" contract, CLF-W1a) — the default E2E test project has no
 * context providers, so (exactly like CLF-W1a's own test above) we first
 * POST the real `before-prompt` endpoint to synthesize an active turn, THEN
 * send the real 'ultrathink' message so the router's outcome has a durable
 * entry to attach to.
 */
test.describe("Transparency Panel — real F14 thinking router (CLF-W1b)", () => {
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

	test("a real 'ultrathink' prompt produces a real xhigh SELECT decision, observed but not applied", async ({ page }) => {
		sessionId = await createSession();

		// Synthesize an active turn (mirrors the test above) so the router's
		// outcome — recorded via the SAME production `enqueuePrompt` call every
		// real prompt goes through — has a durable TraceEntry to attach to.
		const beforePromptResp = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
			method: "POST",
			body: JSON.stringify({ prompt: "hello" }),
		});
		expect(beforePromptResp.ok).toBe(true);

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await sendMessage(page, "ultrathink: please redesign the auth flow");
		await waitForAgentResponse(page);

		const toggle = page.locator('[data-testid="transparency-panel-toggle"]').first();
		await expect(toggle).toBeVisible({ timeout: 15_000 });
		await expect(toggle).toContainText("1 decision");

		await toggle.click();
		const rows = page.locator('[data-testid="transparency-panel-rows"]');
		await expect(rows).toBeVisible();
		await expect(rows).toContainText("user-prompt-submit");
		await expect(rows).toContainText("thinking");
		await expect(rows).toContainText("selected: xhigh");
		await expect(rows).toContainText("consulted 1");

		await page.locator('[data-testid="transparency-panel-row-toggle"]').first().click();
		await expect(rows).toContainText("builtin.thinking-router");
		await expect(rows).toContainText("matched deterministic rule 'ultrathink'");
	});
});
