// src/server/agent/tool-approve-classifier.ts
//
// CLF-W2 — tool auto-approve/deny decision seam HARNESS at
// `SessionManager.requestToolGrant`. See
// ~/Documents/dev/bobbit-fable-refactor/design/classifier-framework.md §3
// (the `tool-call` interception point), §6 (RO vs RW is a *mount* property —
// observe vs enforce), §8.3 ("consult at the top of `requestToolGrant`
// (abstain→existing human widget)"), and §10 Wave 2 ("tool auto-approve/deny
// at `requestToolGrant` (heuristic-only, CQ-03 permit for widening,
// host-forced fail-closed)").
//
// SCOPE OF THIS WAVE — deliberately narrow, mirroring the CLF-W0b→W1b split
// (ship the dispatch harness first, ship a real classifier customer later):
//   - This file defines the (point, kind) pair and the arg/choice shapes
//     ONLY. `server.ts` calls `allowDecisionPoint` for this pair (NOT
//     `registerDecisionClassifier`), so `LifecycleHub.dispatchDecision`
//     always abstains in production today — zero classifiers registered ⇒
//     byte-identical, the same discipline as CLF-W0b's own "allow-listed but
//     zero classifiers registered" pin (tests/lifecycle-hub-dispatch-decision
//     .test.ts).
//   - Unlike CLF-W0b's fully-dark seam, `SessionManager.requestToolGrant`
//     DOES consult this pair for real on every tool-permission ask (see that
//     method) — a genuine production call site. With nothing registered,
//     every consult abstains, so behaviour is unconditionally unchanged.
//   - A concrete heuristic classifier (the actual rule that decides
//     allow/deny) is deferred to a follow-up slice: there is no
//     `ultrathink`-style unambiguous keyword signal for tool approval to
//     hard-code, and per the design doc §6.4 an auto-`allow` verdict is
//     "always widening" and must mint+consume a CQ-03
//     `operator-confirmation` permit (`../auth/operator-confirmation.ts`)
//     before it can ever auto-apply — that wiring is a separate, larger PR
//     and is intentionally NOT built here. Auto-`deny` needs no such permit
//     (§6.4: "deny is the only always-safe tool verdict") and IS wired to
//     short-circuit in enforce mode below — but, again, only once a real
//     classifier is registered to actually produce one.
//
// Observe vs enforce (design doc §6, "a mount property, not code"):
//   - observe (default, `BOBBIT_CLF_TOOL_APPROVE` unset or any value other
//     than "enforce"): `requestToolGrant`'s existing human-ask flow runs
//     completely unconditionally; the classifier's `Decision` (if any) is
//     recorded via `dispatchDecision`'s own trace/transparency-panel wiring
//     and nothing else changes.
//   - enforce (`BOBBIT_CLF_TOOL_APPROVE=enforce`): a `select` with
//     `choice: "deny"` short-circuits `requestToolGrant` to
//     `{ granted: false }` immediately — no `tool_permission_needed`
//     broadcast, no pending-grant frame allocated, no 5-minute timer. A
//     `select` with `choice: "allow"` is NOT auto-applied this wave (see
//     above) and falls through to the ordinary human-ask flow, exactly like
//     an `abstain`.
import type { Decision, DecisionPoint } from "./decision-types.js";

/** The (point, kind) pair this seam is consulted at. Exported so the
 *  allow-list call site (`server.ts`, at gateway construction) and the
 *  consult call site (`SessionManager.requestToolGrant`) can never drift
 *  apart into a silent mismatch — a typo in either place fails `npm run
 *  check`, not a test (same discipline as `THINKING_ROUTER_POINT`/`_KIND` in
 *  `thinking-router-classifier.ts`). */
export const TOOL_APPROVE_POINT: DecisionPoint = "tool-call";
export const TOOL_APPROVE_KIND = "tool-approve";

/** The classifier's verdict shape. `Decision<TChoice>` itself stays
 *  select/abstain only (see decision-types.ts's header comment — do not
 *  extend the union without documenting why) — this is just the `TChoice`
 *  for this one (point, kind) pair, the same pattern `ThinkingLevel` uses
 *  for the thinking router. */
export type ToolApproveVerdict = "allow" | "deny";

/** Argument shape passed to a tool-approve classifier's `evaluate()` — the
 *  inputs that would drive an allow/deny call, kept explicit end-to-end so a
 *  future classifier's `rationale` can name them for the transparency panel
 *  (design doc: "full transparency, nothing hidden from users"). */
export interface ToolApproveArg {
	toolName: string;
	toolGroup: string;
	/** The session's resolved role name at the time of the ask, when known. */
	roleName?: string;
}

export function isToolApproveArg(value: unknown): value is ToolApproveArg {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<ToolApproveArg>;
	return typeof v.toolName === "string" && typeof v.toolGroup === "string";
}

/** Reads the flag LIVE (not cached at module load) so tests can flip it
 *  in-process without re-importing — same idiom as the other
 *  `process.env.BOBBIT_*` live-reads in this codebase (e.g.
 *  `cpu-diagnostics.ts`'s `BOBBIT_DEBUG` checks). Default is OBSERVE: any
 *  value other than the exact string "enforce" (including unset) stays
 *  observe-only. */
export function isToolApproveEnforceMode(): boolean {
	return process.env.BOBBIT_CLF_TOOL_APPROVE === "enforce";
}

/** True only for the one auto-appliable verdict this wave supports — an
 *  auto-`deny` (design doc §6.4: "deny is the only always-safe tool
 *  verdict"). An auto-`allow` needs the CQ-03 permit machinery this wave
 *  deliberately does not build; it is treated identically to an abstain. */
export function isAutoDenyDecision(
	decision: Decision<ToolApproveVerdict> | undefined,
): decision is { kind: "select"; choice: "deny"; confidence?: number; rationale?: string } {
	return !!decision && decision.kind === "select" && decision.choice === "deny";
}
