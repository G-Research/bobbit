// src/server/agent/thinking-router-classifier.ts
//
// CLF-W1b — the F14 deterministic thinking-level router: the Classifier
// Framework lane's first production `dispatchDecision` customer. See the
// Fable program's classifier-framework design note §7/§9
// ("Regex `ultrathink`→xhigh (0 tokens); else `ambiguous`→cheap model") and
// §10 Wave 1 ("deterministic-only ... no model-backed tiebreak yet").
//
// OBSERVE MODE (default, unchanged since W1b): `SessionManager.enqueuePrompt`
// consults this classifier and the resulting `Decision` is recorded into the
// transparency trace via `LifecycleHub.dispatchDecision` → `ContextTraceStore
// .appendDecision`, but nothing applies it — no `setThinkingLevel` call runs.
// The session's live thinking level is only ever changed by the pre-existing
// role/spawn-time resolution (`resolveInitialThinkingLevel`) and explicit user
// action (`set_thinking_level`, ws/handler.ts).
//
// CLF-W3 — APPLY MODE (`BOBBIT_CLF_THINKING_ROUTER=enforce`, see
// `isThinkingRouterApplyMode` below): `enqueuePrompt` calls
// `session.rpcClient.setThinkingLevel(choice)` with the classifier's exact
// `select`ed level, transiently for that turn only (never persisted as
// `spawnPinnedThinkingLevel` — the next turn re-consults from scratch, same as
// this wave's Decision itself is per-prompt). Three states mirror the
// tool-approve-heuristic pattern exactly (`isToolApproveEnforceMode`): absent
// or any value other than the literal string `"enforce"` (including
// `"observe"`) stays observe-only, byte-identical to W1b.
//
// PRECEDENCE (pinned invariant — the classifier must lose to any config a
// human already committed to): apply mode never fires when
// `SessionManager.resolveRoleThinkingLevel(session)` returns a role-level
// override, or when `session.thinkingLevelUserPinned` is true (set only by
// the explicit `set_thinking_level` ws action — never by spawn-time default
// resolution). See `SessionManager.canApplyThinkingRouterDecision`. An
// `abstain` never calls `setThinkingLevel` regardless of mode — there is
// nothing to apply.
//
// Deterministic-only discipline: the design doc names "heuristic tiers" as a
// Wave-1 aspiration but gives no concrete deterministic rule for prompt-shape
// tiers beyond the `ultrathink` keyword itself — inventing thresholds here
// (e.g. by prompt length) would be exactly the "ambiguity guessing" the
// design's cascade discipline (§7) reserves for a model tiebreak, which this
// wave explicitly does not have. So the rule table below is intentionally
// small: match a hard-override keyword → `select`, otherwise `abstain` and
// let the pre-hook default win (design doc §4).
import type { ThinkingLevel } from "../../shared/thinking-levels.js";
import type { Decision, DecisionClassifier, DecisionDispatchCtx, DecisionPoint } from "./decision-types.js";
import type { LifecycleHub } from "./lifecycle-hub.js";

/** The (point, kind) pair this router is registered at. Exported so the
 *  production call site (`SessionManager.enqueuePrompt`) and the
 *  registration call site (`registerThinkingRouterClassifier`, wired at
 *  gateway construction in `server.ts`) can never drift apart into a silent
 *  mismatch — a typo in either place fails `npm run check`, not a test. */
export const THINKING_ROUTER_POINT: DecisionPoint = "user-prompt-submit";
export const THINKING_ROUTER_KIND = "thinking";
export const THINKING_ROUTER_CLASSIFIER_ID = "builtin.thinking-router";

/** Argument shape passed to the thinking-router classifier's `evaluate()`. */
export interface ThinkingRouterArg {
	/** The user's verbatim submitted text (NOT the model-expanded dispatch
	 *  text produced for skill/file-mention expansions) — the keyword rules
	 *  describe user intent, not model-facing content. */
	text: string;
}

interface ThinkingRule {
	id: string;
	pattern: RegExp;
	level: ThinkingLevel;
}

// F14 finding + F14-ultrathink-override treat `ultrathink` and `think harder`
// as equivalent hard-override markers for the same (highest) tier — see
// PRIOR-CLAIMS.md F14-ultrathink-override ("detect an `ultrathink`/`think
// harder` marker ... apply xhigh for that turn only"). Word-boundary regex so
// e.g. "ultrathinking" or "rethink harder" don't false-positive.
const RULES: readonly ThinkingRule[] = [
	{ id: "ultrathink", pattern: /\bultrathink\b/i, level: "xhigh" },
	{ id: "think-harder", pattern: /\bthink harder\b/i, level: "xhigh" },
];

/**
 * Pure rule-table function — zero tokens, zero I/O, fully synchronous.
 * Exported directly so the rule table itself is unit-testable without
 * standing up a `LifecycleHub`/`DecisionClassifier` wrapper.
 */
export function classifyThinkingLevel(text: string): Decision<ThinkingLevel> {
	for (const rule of RULES) {
		if (rule.pattern.test(text)) {
			return { kind: "select", choice: rule.level, confidence: 1, rationale: `matched deterministic rule '${rule.id}'` };
		}
	}
	return { kind: "abstain" };
}

function isThinkingRouterArg(value: unknown): value is ThinkingRouterArg {
	return !!value && typeof value === "object" && typeof (value as ThinkingRouterArg).text === "string";
}

/**
 * The built-in deterministic classifier — CLF-W1b's Decision-seam customer at
 * `(user-prompt-submit, thinking)`. A malformed/missing `arg` (defensive —
 * `dispatchDecision`'s `arg` is untyped `unknown`) abstains rather than
 * throwing, matching `isDecision`'s "malformed → treated as abstain"
 * discipline elsewhere in the seam.
 */
export const thinkingRouterClassifier: DecisionClassifier<ThinkingLevel> = {
	id: THINKING_ROUTER_CLASSIFIER_ID,
	evaluate(_ctx: DecisionDispatchCtx, arg: unknown): Decision<ThinkingLevel> {
		if (!isThinkingRouterArg(arg)) return { kind: "abstain" };
		return classifyThinkingLevel(arg.text);
	},
};

/** Reads the flag LIVE (not cached at module load) so tests can flip it
 *  in-process without re-importing — same idiom as
 *  `isToolApproveEnforceMode()` (tool-approve-classifier.ts). Default is
 *  OBSERVE: any value other than the exact string "enforce" (including
 *  unset, or the explicit "observe") stays observe-only, byte-identical to
 *  CLF-W1b. See this file's header for the precedence rules apply mode must
 *  still honor. */
export function isThinkingRouterApplyMode(): boolean {
	return process.env.BOBBIT_CLF_THINKING_ROUTER === "enforce";
}

/**
 * Registers the built-in thinking router at `(user-prompt-submit, thinking)`.
 * Called ONCE at gateway construction (`server.ts`, right after
 * `sessionManager.lifecycleHub` is created) — NOT from `SessionManager`'s own
 * constructor, since `lifecycleHub` is an optional field assigned by the
 * caller after construction (see `SessionManager.lifecycleHub?: LifecycleHub`).
 *
 * Registering here (rather than merely `allowDecisionPoint`) means the pair
 * always has a real classifier attached, so `dispatchDecision`'s "throw on
 * unregistered (point,kind)" guard never fires for this pair in production —
 * per that method's own doc comment, a real call site must decide fail-open
 * vs fail-closed before relying on the allow-list throw; this router doesn't
 * rely on it at all, since it registers a classifier instead of a bare
 * allow-list entry.
 *
 * Returns the unregister function (mirrors `registerDecisionClassifier`) for
 * symmetry/tests; production code never calls it.
 */
export function registerThinkingRouterClassifier(hub: LifecycleHub): () => void {
	return hub.registerDecisionClassifier<ThinkingLevel>(THINKING_ROUTER_POINT, THINKING_ROUTER_KIND, thinkingRouterClassifier);
}
