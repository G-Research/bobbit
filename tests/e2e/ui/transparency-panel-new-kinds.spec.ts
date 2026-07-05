/**
 * Browser E2E: Transparency Panel — CLF-W6 per-kind polish for the "four new"
 * classifier decision kinds that have shipped since the original two
 * (thinking/tool-approve) that `transparency-panel.spec.ts`,
 * `transparency-panel-thinking-router-enforce.spec.ts`, and
 * `transparency-panel-tool-approve-heuristic.spec.ts` already cover:
 * model-tier (CLF-W4), gate-risk (CLF-W5), and swarm-topology (SWARM-W4.2) —
 * all three OBSERVE-ONLY (no apply/enforce path exists for any of them this
 * wave, per their own file headers) — plus the kind-filter chip row that
 * appears once a turn accumulates more than one `decisionKind`.
 *
 * model-tier and gate-risk both already have a REAL, unconditionally-
 * registered production classifier (`server.ts`'s `registerModelTierClassifier`
 * / `registerGateRiskClassifier`) — this spec drives those REAL classifiers
 * directly via `hub.dispatchDecision(...)` with an arg chosen to force a
 * deterministic `select`, the same "drive the real registered classifier
 * in-process" technique `transparency-panel.spec.ts`'s CLF-W1a test
 * established for a seam with no convenient one-line HTTP trigger.
 * swarm-topology, by contrast, ships with NO classifier registered in
 * production at all this wave (harness-only — see
 * `swarm-topology-classifier.ts`'s header) — so this spec registers a fake
 * one at its real (point, kind) pair, mirroring `transparency-panel.spec.ts`'s
 * own CLF-W1a/CLF-W2 fake-classifier fixtures.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("Transparency Panel — new observe-only decision kinds + kind filter (CLF-W6)", () => {
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

	test("model-tier/gate-risk/swarm-topology rows render human labels, observe-only badges, and a severity accent; the kind filter isolates one kind; state survives reload", async ({ page, gateway }) => {
		sessionId = await createSession();

		const hub = gateway.sessionManager?.lifecycleHub;
		expect(hub).toBeTruthy();

		// Fake classifier at the real (goal-create, swarm-topology) pair — no
		// production classifier is registered for it this wave (harness-only,
		// see swarm-topology-classifier.ts's header), so a real `select`
		// outcome needs the same fixture pattern transparency-panel.spec.ts's
		// CLF-W1a/CLF-W2 tests use.
		const unregister = hub!.registerDecisionClassifier("goal-create", "swarm-topology", {
			id: "e2e-fake-swarm-topology-classifier",
			evaluate: () => ({
				kind: "select",
				choice: { topology: "best-of-n", fanOut: 3, earlyKill: true },
				rationale: "e2e fixture: ambiguous spec, no verify command supplied",
			}),
		});

		try {
			// 1. Synthesize an active turn so the direct dispatches below have a
			// durable TraceEntry to attach to (same trick every sibling spec in
			// this directory uses).
			const beforePromptResp = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
				method: "POST",
				body: JSON.stringify({ prompt: "hello" }),
			});
			expect(beforePromptResp.ok).toBe(true);

			const session = gateway.sessionManager!.getSession(sessionId);
			const ctx = { sessionId, cwd: session?.cwd ?? "" };

			// 2. Drive the REAL, unconditionally-registered model-tier classifier
			// (session-setup.ts's production customer) directly — "architect" is
			// on VER-02's Frontier tier (model-tier-classifier.ts).
			const modelTierOutcome = await hub!.dispatchDecision("session-spawn", "model-tier", ctx, { roleName: "architect" });
			expect(modelTierOutcome).toEqual({ kind: "select", choice: "frontier", confidence: 1, rationale: expect.stringContaining("frontier-tier-role") });

			// 3. Drive the REAL, unconditionally-registered gate-risk classifier
			// (verification-harness.ts's production customer) directly —
			// `src/server/server.ts` is on the explicit HIGH_RISK_SURFACES list.
			const gateRiskOutcome = await hub!.dispatchDecision("gate-verify", "risk", ctx, { changedFiles: ["src/server/server.ts"] });
			expect(gateRiskOutcome).toEqual({ kind: "select", choice: "high", confidence: 1, rationale: expect.stringContaining("high-risk-surface") });

			// 4. The fake swarm-topology classifier registered above.
			const swarmOutcome = await hub!.dispatchDecision("goal-create", "swarm-topology", ctx);
			expect(swarmOutcome).toEqual({
				kind: "select",
				choice: { topology: "best-of-n", fanOut: 3, earlyKill: true },
				rationale: expect.stringContaining("e2e fixture"),
			});

			// 5. Drive the actual user-visible turn so the transcript has a user
			// row to render the panel under. The real F14 thinking router
			// abstains (no ultrathink keyword), landing a 4th decisionKind
			// ("thinking") on the same trace entry — same "+1 for the real
			// router's abstain" shape every sibling spec in this directory has.
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await sendMessage(page, "hello");
			await waitForAgentResponse(page);

			const toggle = page.locator('[data-testid="transparency-panel-toggle"]').first();
			await expect(toggle).toBeVisible({ timeout: 15_000 });
			await expect(toggle).toContainText("4 decisions");
			await toggle.click();

			// Kind filter chips: 4 distinct kinds ⇒ the chip row appears with
			// "all" plus one chip per kind, each showing its own count.
			const kindFilter = page.locator('[data-testid="transparency-panel-kind-filter"]');
			await expect(kindFilter).toBeVisible();
			await expect(page.locator('[data-testid="transparency-panel-kind-filter-all"]')).toContainText("all (4)");
			await expect(page.locator('[data-testid="transparency-panel-kind-filter-all"]')).toHaveAttribute("aria-pressed", "true");

			const rows = page.locator('[data-testid="transparency-panel-rows"]');
			await expect(rows).toBeVisible();
			await expect(page.locator('[data-testid="transparency-panel-row"]')).toHaveCount(4);

			// Human labels replace the raw kind strings in the verdict line for
			// all three new kinds — never a bare "selected: <choice>".
			await expect(rows).toContainText("Model tier proposed: frontier");
			await expect(rows).toContainText("Gate risk proposed: high");
			await expect(rows).toContainText("Swarm topology proposed: best-of-n (fan-out 3, early-kill)");
			// The pre-existing kind (thinking) is untouched — still its raw,
			// pinned "abstained" verdict text.
			await expect(rows).toContainText("abstained");

			// observe-only badge: exactly the 3 new kinds, never the real F14
			// router's "thinking" row (which DOES have an apply path).
			await expect(page.locator('[data-testid="transparency-panel-row-observe-only"]')).toHaveCount(3);

			// Severity accent: the gate-risk row's verdict pill carries the
			// destructive/high-risk accent class.
			const riskRow = page.locator('[data-testid="transparency-panel-row"]', { hasText: "Gate risk proposed: high" });
			await expect(riskRow.locator('[data-testid="transparency-panel-row-verdict"]')).toHaveClass(/text-destructive/);

			// Detail row: consulted id, rationale, ms, and an explicit
			// applied:no line render consistently for an observe-only kind too.
			await riskRow.locator('[data-testid="transparency-panel-row-toggle"]').click();
			await expect(riskRow).toContainText("builtin.gate-risk");
			await expect(riskRow).toContainText("matched deterministic rule 'high-risk-surface'");
			await expect(riskRow).toContainText("applied: no");
			await expect(riskRow).toContainText("ms:");

			// Kind filter: clicking a chip isolates that kind's row(s) only.
			await page.locator('[data-testid="transparency-panel-kind-filter-risk"]').click();
			await expect(page.locator('[data-testid="transparency-panel-row"]')).toHaveCount(1);
			await expect(page.locator('[data-testid="transparency-panel-row"]').first()).toContainText("Gate risk proposed: high");
			await expect(page.locator('[data-testid="transparency-panel-kind-filter-risk"]')).toHaveAttribute("aria-pressed", "true");

			// Clicking "all" restores every row.
			await page.locator('[data-testid="transparency-panel-kind-filter-all"]').click();
			await expect(page.locator('[data-testid="transparency-panel-row"]')).toHaveCount(4);

			// 6. Persistence across reload — re-fetched from the durable JSONL
			// trace store, not a stubbed route (same discipline as
			// transparency-panel.spec.ts's own reload assertion).
			await page.reload();
			await navigateToHash(page, `#/session/${sessionId}`);
			const toggleAfterReload = page.locator('[data-testid="transparency-panel-toggle"]').first();
			await expect(toggleAfterReload).toBeVisible({ timeout: 15_000 });
			await expect(toggleAfterReload).toContainText("4 decisions");
			await toggleAfterReload.click();
			await expect(page.locator('[data-testid="transparency-panel-kind-filter"]')).toBeVisible();
			await expect(page.locator('[data-testid="transparency-panel-row"]')).toHaveCount(4);
		} finally {
			unregister();
		}
	});

	test("a single-decisionKind turn (real F14 router, 'ultrathink') renders no kind filter chips", async ({ page }) => {
		sessionId = await createSession();

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

		// A single decisionKind ("thinking") ⇒ no filter chrome at all — same
		// "no chrome when there's nothing to filter" discipline as the panel's
		// own zero-decisions empty state.
		await expect(page.locator('[data-testid="transparency-panel-kind-filter"]')).toHaveCount(0);
		await expect(page.locator('[data-testid="transparency-panel-row"]')).toHaveCount(1);
	});
});
