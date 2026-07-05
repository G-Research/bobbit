/**
 * API E2E: pins `server.ts`'s CLF-W2.5 registration gate for the real
 * tool-approve heuristic classifier —
 * `if (isToolApproveHeuristicEnabled()) { registerToolApproveHeuristicClassifier(...) }`,
 * placed right next to the CLF-W2 `allowDecisionPoint` call.
 *
 * This worker never sets `BOBBIT_CLF_TOOL_APPROVE` (the default — see
 * `in-process-harness.ts`), so the ONLY way this test can pass is if
 * `server.ts` really left the (tool-call, tool-approve) pair with ZERO
 * classifiers registered: `dispatchDecision` must abstain with an empty
 * `consulted` list on the REAL, production-booted gateway's REAL hub — not a
 * bare test-constructed `LifecycleHub` (see tool-approve-classifier.test.ts /
 * session-manager-tool-approve.test.ts for those unit-level pins). Proves the
 * byte-identical-when-unset claim end to end, not just at the unit level.
 */
import { test, expect } from "./in-process-harness.js";
import { createSession, deleteSession } from "./e2e-setup.js";
import { TOOL_APPROVE_POINT, TOOL_APPROVE_KIND } from "../../src/server/agent/tool-approve-classifier.js";

test.describe("server.ts CLF-W2.5 registration gate — BOBBIT_CLF_TOOL_APPROVE unset", () => {
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

	test("dispatchDecision abstains with zero consulted classifiers for (tool-call, tool-approve) on the real production gateway", async ({ gateway }) => {
		expect(process.env.BOBBIT_CLF_TOOL_APPROVE).toBeFalsy();

		sessionId = await createSession();
		const hub = gateway.sessionManager?.lifecycleHub;
		expect(hub).toBeTruthy();

		const session = gateway.sessionManager!.getSession(sessionId);
		const outcome = await hub.dispatchDecision(TOOL_APPROVE_POINT, TOOL_APPROVE_KIND, {
			sessionId,
			cwd: session?.cwd ?? "",
		}, { toolName: "team_dismiss", toolGroup: "Team" });

		// Zero classifiers registered ⇒ abstain. Proves the real heuristic
		// classifier (which WOULD select "deny" for this exact arg — see
		// tests/tool-approve-heuristic.test.ts's "Team group tool → deny"
		// case) never got registered on this real gateway's hub, i.e.
		// server.ts's `allowDecisionPoint` call is still the ONLY
		// registration for the pair when the flag is unset, exactly as
		// CLF-W2 shipped it. (Not asserting on `getDecisionTrace()`'s
		// in-memory ring here — `createSession()` may already have an active
		// per-turn trace entry for this session, in which case
		// `recordDecisionOutcome` attaches the outcome there instead of the
		// ring fallback; the `outcome` return value alone is sufficient
		// proof of "abstain, no classifier consulted".)
		expect(outcome).toEqual({ kind: "abstain" });
	});

	test("requestToolGrant's real call site behaves byte-identically to CLF-W2 (no auto-deny, even for a tool the heuristic WOULD deny)", async ({ gateway }) => {
		sessionId = await createSession();

		// "team_dismiss"/"Team" matches the heuristic's dangerous-group deny
		// rule for real (see tests/tool-approve-heuristic.test.ts) — if the
		// classifier were mistakenly registered even with the flag unset, this
		// would auto-deny immediately with zero broadcast. Since it isn't
		// registered, this must behave exactly like ordinary CLF-W2
		// harness-only behavior: the call reaches the human-ask flow and only
		// resolves once explicitly denied below.
		const grantPromise = gateway.sessionManager!.requestToolGrant(sessionId, "team_dismiss", "Team");
		await expect
			.poll(() => gateway.sessionManager!.getSession(sessionId)?.pendingGrantRequest !== undefined, { timeout: 5_000 })
			.toBe(true);

		gateway.sessionManager!.denyToolPermission(sessionId, "team_dismiss");
		const result = await grantPromise;
		expect(result).toEqual({ granted: false });
	});
});
