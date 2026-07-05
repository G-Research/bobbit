// src/server/agent/decision-types.ts
//
// SELECT-ONLY decision seam — Wave 0(b) of the Classifier Framework lane
// (EXT-05 core). See the Fable program's classifier-framework design note
// §4/§8/§10 for the full design; this file + LifecycleHub.dispatchDecision()
// implement ONLY the Wave 0(b) slice described there: a typed Decision return,
// a per-(point,kind) allow-list, and outcome tracing. No production code calls
// dispatchDecision yet (ships dark) and no mutate/veto variant exists (Wave-5
// gated — see the Decision union comment below).
//
// This lives in its own leaf module (not inside lifecycle-hub.ts) for the same
// reason lifecycle-hooks.ts does (EXT-02, see that file's header): a future
// pack-level classifier loader/registry (Wave 1(b)) will want these types
// without creating an import cycle back through lifecycle-hub.ts.

/**
 * Interception points `dispatchDecision` may be consulted at (design doc §3).
 * Distinct from `LifecycleHook` (lifecycle-hooks.ts) — most of these points
 * are NOT dispatched through the provider-registry `LifecycleHub.dispatch()`
 * path at all (e.g. `tool-call` is pi's native `tool_call` event, `compaction`
 * is pi's native `beforeCompact`); wiring any of them to a real call site is
 * out of scope for Wave 0(b).
 */
export const DECISION_POINTS = [
	"user-prompt-submit",
	"agent-prompt",
	"tool-call",
	"turn-boundary",
	"compaction",
	// CLF-W4 — session spawn, where the model/thinking-tier for a new session
	// is resolved (see model-tier-classifier.ts's header for the full design).
	"session-spawn",
	// CLF-W5 — gate verification, where a signal's diff shape (changed-file
	// count/path-classes/high-risk surfaces) is known before its verify[]
	// steps run (see gate-risk-classifier.ts's header for the full design).
	"gate-verify",
	// SWARM-W4.2 — goal creation, where a swarm topology is (today, always
	// caller-supplied) chosen for a new goal. Hand-added exactly the same way
	// (tool-call, tool-approve) was hand-added by CLF-W2, per
	// docs/design/swarm-orchestration-w4.md §3.2: "do not wait for STR-01"
	// (the route-registry-derived interception-point generalization) — flag
	// this point for STR-01 to later subsume, same discipline as this file's
	// own header. See swarm-topology-classifier.ts's header for the full
	// design/scope of this wave (harness only — zero classifiers registered).
	"goal-create",
] as const;

export type DecisionPoint = (typeof DECISION_POINTS)[number];

/**
 * A classifier's typed verdict, returned from `dispatchDecision`.
 *
 * - `select` — the classifier picked a concrete `choice`.
 * - `abstain` — first-class "not my call": the chain continues; if nobody
 *   selects, the pre-hook / host default wins. This is how "defer when
 *   unsure" is free (design doc §4).
 *
 * SELECT-ONLY for Wave 0(b): no `mutate` (rewrite-and-continue) or `veto`
 * (deny/terminal) variant exists yet. Those are Wave-5-gated (design doc §6
 * RW mount property + §10 phased plan) — introducing them here before a
 * second composing mutator exists would be exactly the over-engineering the
 * design doc's §10/§2 explicitly warns against. If you're adding one: read
 * the design doc's safety model (§6) first — mutate/veto need re-validation,
 * trust-tier checks, and a fail-closed default that `select`/`abstain` don't.
 */
export type Decision<TChoice = unknown> =
	| { kind: "select"; choice: TChoice; confidence?: number; rationale?: string }
	| { kind: "abstain" };

/** Minimal read-only context handed to a classifier's `evaluate()`. */
export interface DecisionDispatchCtx {
	sessionId: string;
	projectId?: string;
	goalId?: string;
	cwd: string;
}

/**
 * A registered decision classifier. Wave 0(b) classifiers are plain in-process
 * objects registered directly on the hub (see `LifecycleHub.registerDecisionClassifier`)
 * — there is no pack/YAML loader wiring yet (that's Wave 1(b)); a real
 * classifier would be adapted from a pack's `providers/<id>.yaml` (`kind:
 * selector`) through `moduleHost.invoke`, mirroring `LifecycleHub.dispatch()`.
 */
export interface DecisionClassifier<TChoice = unknown> {
	readonly id: string;
	evaluate(ctx: DecisionDispatchCtx, arg: unknown): Decision<TChoice> | Promise<Decision<TChoice>>;
}

/** One recorded `dispatchDecision` call outcome (see LifecycleHub's internal trace buffer). */
export interface DecisionOutcome {
	ts: number;
	point: DecisionPoint;
	decisionKind: string;
	/** ids of classifiers actually invoked, in invocation order. */
	consulted: string[];
	decision: Decision;
	ms: number;
	/**
	 * Privacy-safe, identity/shape-only summary of the classifier consult input,
	 * when derivable. Never contains prompt text, spec/content, command args, diff
	 * content, or changed-file paths; `changedFiles` is recorded only as
	 * `changedFileCount`. Omitted for legacy rows and for absent/non-object args.
	 */
	argSummary?: Record<string, string | number | boolean>;
	/**
	 * CLF-W3 — whether a `select` decision was actually applied to live session
	 * state, as opposed to merely recorded for telemetry. Set by the CALLER via
	 * `dispatchDecision`'s `opts.applyIfSelected` (decided BEFORE the classifier
	 * runs, from mode-flag + precedence checks only — never from the resulting
	 * `choice`), not computed here. Omitted for `abstain` outcomes (never
	 * meaningful) and for any caller that doesn't pass `opts.applyIfSelected` at
	 * all (every pre-CLF-W3 call site) — those stay exactly as before, byte-
	 * identical. See `dispatchDecision`'s doc comment.
	 */
	applied?: boolean;
}

/** The allow-list / registration map key for a (point, kind) pair. */
export function decisionKey(point: DecisionPoint, kind: string): string {
	return `${point}::${kind}`;
}

/** Runtime guard: is `value` a well-formed `Decision`? Defensive parsing for
 *  classifier return values, mirroring `validateBlock`'s discipline in
 *  lifecycle-hub.ts — a malformed return is treated as abstain, never thrown
 *  into caller code. */
export function isDecision(value: unknown): value is Decision {
	if (!value || typeof value !== "object") return false;
	const kind = (value as { kind?: unknown }).kind;
	if (kind === "abstain") return true;
	if (kind === "select") return "choice" in (value as Record<string, unknown>);
	return false;
}
