/**
 * Pure, testable logic extracted from VerificationHarness.
 *
 * These functions contain no I/O, no class state, and no side-effects —
 * they operate only on their arguments and return deterministic results.
 */

import type { GateSignal, GateSignalStep } from "./gate-store.js";
import type { VerifyStep } from "./workflow-store.js";

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

/**
 * Literal substring patterns that indicate a transient/infrastructure failure
 * worth retrying. Matched via `output.includes(pattern)`.
 *
 * For LLM streaming/tool-argument glitches (malformed JSON from
 * `input_json_delta` accumulation, schema-validation failures), prefer the
 * regex list `TRANSIENT_ERROR_REGEXES` below — it catches every V8/Node
 * `SyntaxError` variant in one place instead of chasing new substrings as
 * they're discovered.
 */
export const TRANSIENT_ERROR_PATTERNS = [
	"timed out",
	"Agent process not running",
	"process exited",
	"Session lost during server restart",
	"ECONNRESET",
	"ENOTCONN",
	"EPIPE",
	"spawn UNKNOWN",
	"WebSocket error",
	"socket error",
	"socket hang up",
	"connect ECONNREFUSED",
	// Tool-call schema validation failure from the provider SDK — distinct
	// from the raw JSON parse errors, which live in TRANSIENT_ERROR_REGEXES.
	"Validation failed for tool",
	// resumed-reviewer transient pattern — Resumed reviewer agents lose kickoff context after a
	// gateway restart. The terse legacy reminder doesn't elicit a tool call;
	// the agent eventually goes idle. Treating this output as transient
	// promotes recovery to `_rerunLlmReviewStep`, which rebuilds the kickoff
	// from the workflow step definition and drives a fresh review session.
	"Agent did not call verification_result after server restart and reminder",
	// Provider overload / rate-limit / quota-throttle conditions. These are
	// transient too, but `isProviderBackoffError()` classifies them more
	// narrowly so SessionManager can select an unbounded retry policy.
	"overloaded_error",
	"rate_limit_error",
];

/**
 * Regex patterns that indicate a provider overload / rate-limit / quota
 * throttle. Distinct from the JSON-glitch regexes — these warrant
 * effectively unbounded retry with long backoff rather than a bounded
 * burst of 3 attempts.
 */
export const PROVIDER_BACKOFF_REGEXES: RegExp[] = [
	// HTTP 429 (rate limit) and 529 (Anthropic overload) in any common SDK
	// phrasing: "HTTP 429", "status 429", "statusCode: 429", "status code 429".
	// NB: must list 429 and 529 explicitly — an earlier `5?29` shorthand also
	// matched bogus "HTTP 29" and missed 429 entirely.
	/\b(?:HTTP|status(?:[ _-]?code)?:?)\s*(?:429|529)\b/i,
	// Provider error type markers (also covered as literal substrings above,
	// but kept here for completeness when matched via the classifier).
	/overloaded_error/i,
	/rate_limit_error/i,
];

// ---------------------------------------------------------------------------
// Restart-interrupt suppression (restart-interrupted verifications mark gates pending, not failed)
// ---------------------------------------------------------------------------

/**
 * Output-prefix markers indicating that a verification step failed because
 * the gateway was restarted mid-flight (or its agent subprocess was killed)
 * — NOT because the work being verified was actually wrong.
 *
 * Single source of truth for the predicate used by
 * `VerificationHarness._resumeOneVerification` to decide whether the overall
 * gate should fall back to `pending` (with a benign team-lead notification)
 * instead of `failed` (which would cause the team-lead to spend a turn
 * re-investigating a phantom regression).
 *
 * Match semantics: a step's `output` matches if it `includes()` any of these
 * substrings. Empty-output `llm-review` / `agent-qa` steps are also treated
 * as restart-interrupts at the call site (the SIGTERM-during-review case).
 *
 * Extend this list rather than introducing a parallel list — every test that
 * codifies "this is a restart-interrupt" reads from this array.
 */
export const RESTART_INTERRUPT_MARKERS: readonly string[] = [
	"Step was running but had no session ID",
	"Step was interrupted by server restart",
	"Session lost during server restart",
	"Agent process exited unexpectedly",
	"Reviewer agent process died",
	"Agent did not call verification_result after server restart",
	// Resume path could not re-attach to the revived reviewer: the agent was
	// still cold (model + MCP init) and the readiness wait / reminder prompt
	// RPC timed out. This is a restart-interrupt, not a real review failure.
	"timed out while resuming after server restart",
];

/**
 * Return true iff a resume *error message* (from a thrown RpcBridge call —
 * `waitForReady` / `prompt`) indicates the failure was caused by the server
 * restart killing+reviving the reviewer agent (cold-init RPC timeout, process
 * not yet up) rather than a genuine verification failure.
 *
 * Used by `resumeInterruptedVerifications`'s outer catch to route such errors
 * into the `pending`-with-benign-nudge path instead of marking the gate
 * `failed` with a `Resume Error` step.
 */
export function isRestartInterruptError(message: string): boolean {
	if (!message) return false;
	const patterns = [
		"Command timed out",
		"timed out",
		"not ready",
		"did not become ready",
		"Agent process exited",
		"Agent process not running",
		"process exited",
	];
	return patterns.some(p => message.includes(p));
}

/**
 * Return true iff every failed step in `steps` looks like a restart
 * interrupt (per RESTART_INTERRUPT_MARKERS, plus the empty-output review/QA
 * special case). The predicate is conjunctive — a single real failure poisons
 * the whole verification, which still marks the gate failed.
 *
 * `steps` shape mirrors what `_resumeOneVerification` produces locally before
 * persisting the GateSignalStep records: each entry carries `passed`,
 * `output`, and `type`. Skipped steps are out of scope (they don't reach
 * this predicate's caller; only failed steps do).
 */
export function isRestartInterruptedStep(step: { passed: boolean; output: string; type: string }): boolean {
	if (step.passed) return false;
	const output = step.output ?? "";
	if (RESTART_INTERRUPT_MARKERS.some(marker => output.includes(marker))) return true;
	// Empty-output llm-review / agent-qa failures are also restart-interrupts
	// (the SIGTERM-during-review case — the reviewer was killed before it
	// could emit anything to its session log).
	if ((step.type === "llm-review" || step.type === "agent-qa") && output.trim() === "") return true;
	return false;
}

/**
 * Return true iff at least one step failed AND every failed step is a
 * restart interrupt. This is the suppression predicate: when it returns true,
 * the gate should be marked `pending` (not `failed`) and the team-lead should
 * receive a benign "interrupted by restart, please re-signal" notification.
 *
 * Returns false when:
 * - No steps failed (overall pass — caller takes the normal pass branch)
 * - Any failed step is a real failure (gate should still mark failed)
 */
export function shouldSuppressRestartInterrupt(steps: ReadonlyArray<{ passed: boolean; output: string; type: string }>): boolean {
	const failedSteps = steps.filter(s => !s.passed);
	if (failedSteps.length === 0) return false;
	return failedSteps.every(isRestartInterruptedStep);
}

/**
 * Regex patterns for LLM streaming / tool-argument JSON glitches.
 *
 * Fresh runs of these almost always succeed — the model's streamed
 * `input_json_delta` just accumulated into something that didn't parse. We
 * treat the whole V8/Node `SyntaxError` family, plus pi-ai's wrapper
 * messages, as one class. `maxAttempts` caps blast radius if a model is
 * reliably broken.
 *
 * Known concrete variants this covers:
 *   - "Expected ',' or '}' after property value in JSON at position 320"
 *   - "Expected double-quoted property name in JSON at position 42"
 *   - "Expected property name or '}' in JSON at position 1"
 *   - "Unexpected token 'x', \"...\" is not valid JSON"
 *   - "Unexpected character ... in JSON at position 5"
 *   - "Unexpected end of JSON input"
 *   - "Unexpected end of input while parsing JSON"
 *   - "Unexpected non-whitespace character after JSON at position ..."
 *   - anything else ending in "in JSON at position <n>"
 */
export const TRANSIENT_ERROR_REGEXES: RegExp[] = [
	// V8/Node JSON parser position marker — present in almost every modern variant.
	/in JSON at position \d+/i,
	// "Unexpected token ..." / "Unexpected character ..." / "Unexpected end of (JSON|input) ..."
	/Unexpected (?:token|character|non-whitespace character|end of (?:JSON|input))/i,
	// "Expected <something> in JSON" (covers the Node 20+ "Expected ',' or '}' ..." phrasing)
	/Expected [^\n]{1,120}? in JSON/i,
	// Older "Expected <something>" phrasings without "in JSON" (Node 18 / browsers).
	/Expected (?:double-quoted )?property name/i,
];

/**
 * Regex patterns for transient agent/runtime infrastructure failures. Kept
 * separate from TRANSIENT_ERROR_REGEXES so detectJsonValidationError() remains
 * scoped to tool-argument JSON/schema glitches and does not send JSON-retry
 * prompts for socket/process failures.
 */
export const TRANSIENT_INFRA_ERROR_REGEXES: RegExp[] = [
	/\bwebsocket\s+error\b/i,
	/\bsocket\s+error\b/i,
	/\bsocket\s+hang\s+up\b/i,
	/\b(?:TypeError:\s*)?fetch failed\b/i,
	/\bUND_ERR_(?:SOCKET|HEADERS_TIMEOUT|CONNECT_TIMEOUT|BODY_TIMEOUT|ABORTED|DESTROYED)\b/i,
	/\b(?:ECONNRESET|ECONNREFUSED|ENOTCONN|EPIPE)\b/i,
	/\bconnection\s+(?:reset|refused|closed|lost|terminated)\b/i,
	/\bconnect\s+ECONNREFUSED\b/i,
	/\b(?:agent\s+)?process[-\s]+not[-\s]+running\b/i,
	/\b(?:agent\s+)?process[-\s]+(?:exited|exit(?:ed)?|died|terminated)\b/i,
];

/**
 * Return the matched JSON/validation error substring (roughly one line of
 * context around the match) if `output` looks like an LLM tool-argument
 * glitch, otherwise null. Used to craft a targeted retry prompt.
 */
export function detectJsonValidationError(output: string): string | null {
	if (!output) return null;

	let idx = -1;
	// Try regex patterns first (cover the V8/Node SyntaxError family).
	for (const re of TRANSIENT_ERROR_REGEXES) {
		const m = re.exec(output);
		if (m && m.index >= 0) { idx = m.index; break; }
	}
	// Fall back to the tool-validation substring.
	if (idx < 0) {
		const i = output.indexOf("Validation failed for tool");
		if (i >= 0) idx = i;
	}
	if (idx < 0) return null;

	const start = output.lastIndexOf("\n", idx) + 1;
	const endNl = output.indexOf("\n", idx);
	const end = endNl < 0 ? output.length : endNl;
	return output.slice(start, end).trim().slice(0, 400);
}

/**
 * Patterns that are transient for LLM reviews but NOT for agent-qa steps.
 * "Agent did not call verification_result" means the agent burned its budget
 * without producing results — retrying will just waste more time/cost.
 */
export const QA_NON_TRANSIENT_PATTERNS = [
	"Agent did not call verification_result",
];

function matchesAnyTransient(output: string): boolean {
	if (TRANSIENT_ERROR_PATTERNS.some(pattern => output.includes(pattern))) return true;
	if (TRANSIENT_ERROR_REGEXES.some(re => re.test(output))) return true;
	if (TRANSIENT_INFRA_ERROR_REGEXES.some(re => re.test(output))) return true;
	// Provider overload / rate-limit conditions (HTTP 429/529 phrasings) are
	// transient too — keep `isTransientReviewError()` as the single source of
	// truth so any consumer that gates on "transient" also covers these.
	return PROVIDER_BACKOFF_REGEXES.some(re => re.test(output));
}

/** Check if an LLM review error output matches a transient failure pattern. */
export function isTransientReviewError(output: string): boolean {
	return matchesAnyTransient(output);
}

/**
 * Narrow classifier for provider overload / rate-limit / quota throttle
 * conditions that warrant an effectively unbounded retry with long backoff
 * (capped at 5 min) rather than the default bounded 3-attempt policy.
 *
 * `isTransientReviewError()` returns true for these too — they are
 * transient — but SessionManager uses this narrower check to pick the
 * unbounded policy.
 */
export function isProviderBackoffError(output: string): boolean {
	if (!output) return false;
	if (output.includes("overloaded_error")) return true;
	if (output.includes("rate_limit_error")) return true;
	return PROVIDER_BACKOFF_REGEXES.some(re => re.test(output));
}

const GENERIC_AGENT_RETRYABLE_REGEXES: RegExp[] = [
	/\bthe system encountered an unexpected error\b/i,
	/\ban unexpected (?:agent |system |internal )?error (?:occurred|happened|was encountered)\b/i,
	/\b(?:internal|system) (?:server )?error\b/i,
];

const GENERIC_AGENT_NON_RETRYABLE_REGEXES: RegExp[] = [
	/\b(?:auth(?:entication|orization)?|unauthori[sz]ed|forbidden)\b/i,
	/\b(?:invalid|missing|no) api key\b/i,
	/\b(?:api key|token|credential)s? (?:is |are )?(?:missing|invalid|expired|not configured|required)\b/i,
	/\b(?:configuration|config) (?:error|invalid|missing|not configured)\b/i,
	/\b(?:unsupported|unknown|unrecognized) (?:provider|model)\b/i,
	/\b(?:provider|model)\b.{0,80}\b(?:unsupported|not supported|unrecognized)\b/i,
	/\b(?:permission denied|access denied|operation not permitted|eacces|eperm)\b/i,
	/\b(?:user|human) (?:aborted|cancelled|canceled|interrupted)\b/i,
	/\b(?:aborterror|cancelled by user|canceled by user)\b/i,
	/\b(?:content policy|policy violation|safety policy|blocked by policy|disallowed content)\b/i,
	/\b(?:validationerror|validation error|invalid request|bad request|schema validation)\b/i,
];

export function isNonRetryableAgentError(output: string): boolean {
	return !!output && GENERIC_AGENT_NON_RETRYABLE_REGEXES.some(re => re.test(output));
}

/**
 * Classify generic agent/runtime failures that are worth one short bounded
 * retry burst even when they do not match the narrower transient/provider
 * classifiers above. Deterministic operator/config/user-policy failures are
 * excluded first so sanitized "unexpected error" wrappers with a concrete
 * cause (for example, "missing API key") do not loop.
 */
export function isRetryableGenericAgentError(output: string): boolean {
	if (!output) return false;
	if (isNonRetryableAgentError(output)) return false;
	return GENERIC_AGENT_RETRYABLE_REGEXES.some(re => re.test(output));
}

/**
 * Decide whether a verification-step retry loop should attempt another
 * pass given the latest result, or break out.
 *
 * Returns `"break"` for terminal outcomes (passed, non-transient failure,
 * or the bounded-attempt budget has been exhausted for a non-backoff
 * transient). Returns `"retry"` when the loop should sleep and try again
 * — either because we're still within the bounded budget for a transient
 * error, or because the failure is a provider rate-limit / overload that
 * warrants unbounded retry.
 *
 * Pure — no I/O — so the harness retry loops can delegate the decision
 * here and unit tests can exercise every branch without spinning up a
 * SessionManager.
 */
export type RetryDecision = "break" | "retry";
export function shouldRetryVerificationStep(args: {
	passed: boolean;
	output: string;
	attempt: number;
	maxBoundedAttempts: number;
	isTransient: (output: string) => boolean;
}): RetryDecision {
	if (args.passed) return "break";
	if (isNonRetryableAgentError(args.output)) return "break";
	const retryable = args.isTransient(args.output) || isRetryableGenericAgentError(args.output);
	if (!retryable) return "break";
	const isBackoff = isProviderBackoffError(args.output);
	if (isBackoff) return "retry"; // unbounded for rate-limit / overload
	return args.attempt >= args.maxBoundedAttempts ? "break" : "retry";
}

/**
 * Minimal session snapshot — just the fields needed to surface an active
 * provider backoff. Defined locally (rather than importing SessionInfo) so
 * this stays in the pure-logic module and is trivially testable.
 */
export interface BackoffSnapshot {
	lastTurnErrorMessage?: string;
	transientRetryAttempts?: number;
	pendingAutoRetryTimer?: unknown;
}

/**
 * If a session's last turn ended in a provider overload / rate-limit error,
 * return a human-readable suffix describing the condition; otherwise return
 * empty string. Used to enrich verification timeout messages so reviewers
 * (and the team-lead notification that quotes them) can distinguish "model
 * silently chugging through a long review" from "stuck behind a quota wall".
 *
 * Pure — no I/O — so the verification harness can pass a session-info
 * snapshot directly and unit tests can pass plain objects.
 */
export function describeProviderBackoff(session: BackoffSnapshot | undefined): string {
	if (!session) return "";
	const errMsg = session.lastTurnErrorMessage || "";
	if (!errMsg) return "";
	if (!isProviderBackoffError(errMsg)) return "";
	const kind = errMsg.includes("rate_limit_error") || /\b429\b/.test(errMsg)
		? "rate-limit"
		: (errMsg.includes("overloaded_error") || /\b529\b/.test(errMsg) ? "overload" : "backoff");
	const attempts = session.transientRetryAttempts ?? 0;
	const attemptPart = attempts > 0 ? ` after ${attempts} auto-retry attempt${attempts === 1 ? "" : "s"}` : "";
	const pendingPart = session.pendingAutoRetryTimer ? " — auto-retry still pending" : "";
	const snippet = errMsg.slice(0, 200).replace(/\s+/g, " ").trim();
	return ` Last turn hit a provider ${kind} error${attemptPart}${pendingPart}. Check your provider quota / subscription rate limits. (Error: ${snippet})`;
}

/** Check if an agent-qa error output matches a transient failure pattern (stricter than LLM reviews). */
export function isTransientQaError(output: string): boolean {
	if (QA_NON_TRANSIENT_PATTERNS.some(pattern => output.includes(pattern))) return false;
	return matchesAnyTransient(output);
}

// ---------------------------------------------------------------------------
// Gate kind classification
// ---------------------------------------------------------------------------

/**
 * A workflow gate is "pre-implementation" iff it is a content gate with no
 * upstream dependencies — meaning nothing it reviews has been produced yet,
 * and the branch cannot contain code satisfying this gate.
 *
 * Derived purely from workflow topology to avoid drift with an explicit
 * `kind` field. See design doc §3.1.
 */
export function isPreImplementationGate(gate: { content?: boolean; depends_on?: string[]; dependsOn?: string[] }): boolean {
	const deps = gate.depends_on ?? gate.dependsOn ?? [];
	return gate.content === true && deps.length === 0;
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

/**
 * Substitute namespaced variables in a template string.
 *
 * Namespaces:
 * - {{branch}}, {{master}}, etc. — built-in goal variables
 * - {{agent.key}} — from the signal's metadata (provided by the agent)
 * - {{gate_id.meta.key}} — from an upstream gate's metadata
 * - {{goal_spec}} — the goal specification text
 *
 * Phase 2 of the multi-repo design dropped support for `{{project.X}}`
 * tokens — their replacement is the structural `{ component, command }`
 * step shape resolved at runtime by `verification-harness.resolveStep()`.
 * The `projectVars` parameter is retained for back-compat at the call site
 * but is no longer consulted; passing it has no effect.
 *
 * Legacy bare references like {{typecheck_command}} are NOT resolved to
 * prevent accidental cross-namespace collisions. Use the explicit namespace.
 */
export function substituteVars(
	template: string,
	builtinVars: Record<string, string>,
	_projectVars: Record<string, string>,
	agentVars: Record<string, string>,
	allGateStates?: Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>,
): string {
	return template.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
		const trimmed = key.trim();

		// {{project.key}} — deliberately UNRESOLVED in Phase 2. Workflow steps
		// that still reference these tokens will surface the unresolved
		// variable and fail at shell-time as a typo, which is the agreed
		// breaking-change surface from docs/design/multi-repo-components.md §3.4.
		if (trimmed.startsWith("project.")) {
			return match;
		}

		// {{agent.key}} — signal metadata from the agent
		if (trimmed.startsWith("agent.")) {
			const field = trimmed.slice("agent.".length);
			if (field in agentVars) return agentVars[field];
			return match;
		}

		// {{gate_id.meta.key}} — upstream gate metadata
		const metaMatch = trimmed.match(/^([^.]+)\.meta\.(.+)$/);
		if (metaMatch && allGateStates) {
			const [, gateId, field] = metaMatch;
			const gateState = allGateStates.get(gateId);
			if (gateState?.metadata && field in gateState.metadata) {
				return gateState.metadata[field];
			}
			return match;
		}

		// Bare variables — builtins only (branch, baseBranch, master, cwd, goal_spec, commit)
		if (trimmed in builtinVars) return builtinVars[trimmed];

		return match; // Leave unresolved
	});
}

/**
 * Decide whether a command step should be auto-skipped based on its resolved
 * `run` string (after template substitution).
 *
 * Returns a human-readable skip reason if the step should be skipped, or null
 * if it should execute normally.
 *
 * A step is skippable when:
 * - The resolved run string is empty or whitespace-only
 * - The resolved run string still contains an unresolved `{{...}}` template
 *   variable — typically because the referenced project/agent config key is
 *   not set (e.g. `{{project.build_command}}` for a project that doesn't
 *   define a build command).
 *
 * This lets workflows declare optional infrastructure steps (build, lint,
 * custom commands) that gracefully skip-as-passed for projects that don't
 * configure them, rather than failing the gate.
 */
export function isCommandStepSkippable(resolvedCmd: string): string | null {
	const trimmed = resolvedCmd.trim();
	if (trimmed === "") {
		return "Skipped — command is empty (no value configured)";
	}
	const unresolved = trimmed.match(/\{\{([^}]+)\}\}/);
	if (unresolved) {
		return `Skipped — unresolved template variable {{${unresolved[1].trim()}}} (not configured for this project)`;
	}
	return null;
}

const READY_TO_MERGE_REQUIRED_BUILTINS = new Set(["branch", "baseBranch", "master", "cwd", "goal_spec", "commit"]);

/**
 * Ready-to-merge command checks are safety checks. If one still contains an
 * unresolved required built-in after substitution, fail the step instead of
 * treating it like an optional project-specific command.
 */
export function readyToMergeUnresolvedBuiltinFailure(gateId: string, resolvedCmd: string): string | null {
	if (gateId !== "ready-to-merge") return null;
	const unresolved = [...resolvedCmd.matchAll(/\{\{([^}]+)\}\}/g)]
		.map(match => match[1].trim())
		.filter(name => READY_TO_MERGE_REQUIRED_BUILTINS.has(name));
	if (unresolved.length === 0) return null;
	const name = unresolved[0];
	return `Failed — unresolved required built-in template variable {{${name}}} in ready-to-merge command`;
}

// ---------------------------------------------------------------------------
// Documentation gate diff-based skip filter (VER-06 / W3.4)
//
// The documentation gate (`llm-review` step marked `docGate: true` in
// seed-default-workflows.ts) always spawned a full-diff frontier review, even
// for changes that provably cannot need a doc update — e.g. a test-only diff.
// This is a cheap, DETERMINISTIC pre-filter (no LLM judgment) that skips the
// review ONLY when every changed path matches a test/fixture pattern. It is
// deliberately narrow and fails toward reviewing:
//   - Any diff touching a non-test/fixture path (this includes ALL of src/,
//     defaults/, market-packs/, and docs/*.md) still gets the full review.
//   - A docs-only diff is NOT skipped — the doc gate's own job is to review
//     doc placement/quality/AGENTS.md discipline (DOC_PROMPT checks 3 & 4),
//     so a change that touches only docs is exactly the case the gate exists
//     for and must still run.
//   - An empty diff (nothing changed vs. base) is skipped — there is no
//     surface, documented or not, for a reviewer to inspect.
// ---------------------------------------------------------------------------

/**
 * Path patterns that can ONLY contain test/fixture material in this repo
 * (see AGENTS.md "Tests" section and `tests/fixtures`, `tests/contract/fixtures`).
 * Intentionally narrow — do not extend to cover "safe-looking" paths like
 * lockfiles or CI config; the finding scopes the deterministic skip to
 * test-only/fixture-only diffs specifically.
 */
const TEST_OR_FIXTURE_PATH_PATTERNS: RegExp[] = [
	/(^|\/)tests\//,        // tests/, tests/e2e/, tests/e2e/ui/, tests/manual-integration/, tests/fixtures/, ...
	/(^|\/)__tests__\//,
	/(^|\/)__fixtures__\//,
	/(^|\/)fixtures\//,     // e.g. a component-local fixtures/ dir outside tests/
	/\.(test|spec)\.[cm]?[jt]sx?$/, // *.test.ts, *.spec.tsx, *.test.mjs, ...
];

/** True when `path` matches one of the test/fixture-only patterns above. */
export function isTestOrFixtureOnlyPath(path: string): boolean {
	return TEST_OR_FIXTURE_PATH_PATTERNS.some((re) => re.test(path));
}

export interface DocGateSkipDecision {
	/** Whether the doc-gate `llm-review` step should be auto-skipped. */
	skip: boolean;
	/** Human-readable rule name, logged for auditability either way. */
	rule: string;
}

/**
 * Decide whether the documentation gate's `llm-review` step can be
 * deterministically skipped, given the list of paths changed in the diff
 * being reviewed (already pathspec-filtered the same way DOC_PROMPT views the
 * diff, e.g. excluding package-lock.json).
 *
 * Skips only when every changed path is provably test/fixture-only, or the
 * diff is empty. Anything else — including docs-only diffs — runs the full
 * review (fail toward reviewing).
 */
export function evaluateDocGateSkip(changedPaths: string[]): DocGateSkipDecision {
	if (changedPaths.length === 0) {
		return { skip: true, rule: "empty-diff — no changed paths vs. base branch" };
	}
	const nonTestFixturePaths = changedPaths.filter((p) => !isTestOrFixtureOnlyPath(p));
	if (nonTestFixturePaths.length === 0) {
		return { skip: true, rule: "test-fixture-only — every changed path matches a test/fixture pattern" };
	}
	return {
		skip: false,
		rule: `review-required — ${nonTestFixturePaths.length} changed path(s) outside test/fixture patterns (e.g. "${nonTestFixturePaths[0]}")`,
	};
}

/**
 * Feature flag for the doc-gate diff filter. Default ON: the skip rule is
 * narrow (test/fixture-only or empty diff), fails toward reviewing on any
 * ambiguity, and the finding assessed this as low-risk/high-confidence. Set
 * `BOBBIT_DOC_GATE_FILTER=off` to force every documentation gate back to an
 * unconditional full review (e.g. while validating the rule on a new repo).
 */
export function isDocGateFilterEnabled(): boolean {
	return process.env.BOBBIT_DOC_GATE_FILTER !== "off";
}

// ---------------------------------------------------------------------------
// Error pattern matching (expect: failure)
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a command step with `expect: failure` passed or failed.
 *
 * Rules:
 * - If exitCode === 0: the command was expected to fail but succeeded → fail
 * - If no errorPattern provided: fail (pattern is required for expect:failure gates)
 * - If errorPattern is an invalid regex: fail with regex error
 * - If output matches errorPattern (case-insensitive): pass
 * - If output does not match: fail
 */
export function matchExpectFailure(
	exitCode: number | null,
	output: string,
	errorPattern?: string,
): { passed: boolean; output: string } {
	if (exitCode === 0) {
		return {
			passed: false,
			output: `Command succeeded (exit code 0) but was expected to fail.\n\n${output}`,
		};
	}

	if (!errorPattern) {
		return {
			passed: false,
			output: `Command failed as expected (exit code ${exitCode}), but no error_pattern metadata was provided. Gates with expect: failure verification require error_pattern metadata containing a regex that matches the expected error output.\n\nActual output (first 500 chars):\n${(output || '').slice(0, 500)}`,
		};
	}

	try {
		const regex = new RegExp(errorPattern, 'i');
		if (regex.test(output)) {
			return { passed: true, output: output || `exit code ${exitCode}` };
		}
		return {
			passed: false,
			output: `Command failed (exit code ${exitCode}) but output did not match expected error pattern.\n\nExpected pattern: /${errorPattern}/i\n\nActual output (first 500 chars):\n${(output || '').slice(0, 500)}`,
		};
	} catch (regexErr: any) {
		return {
			passed: false,
			output: `Invalid error_pattern regex: ${regexErr.message}\n\nPattern was: ${errorPattern}`,
		};
	}
}

// ---------------------------------------------------------------------------
// Phase grouping and ordering
// ---------------------------------------------------------------------------

export interface PhaseGroup {
	step: VerifyStep;
	index: number;
}

/**
 * Group active steps by their phase number (defaulting to 0).
 * The `index` in each PhaseGroup refers to the step's position in `allSteps`
 * (the full list including optional steps), so that broadcast events reference
 * the correct original indices.
 */
export function groupStepsByPhase(activeSteps: VerifyStep[], allSteps: VerifyStep[]): Map<number, PhaseGroup[]> {
	const groups = new Map<number, PhaseGroup[]>();
	for (const step of activeSteps) {
		const originalIndex = allSteps.indexOf(step);
		const phase = step.phase ?? 0;
		if (!groups.has(phase)) groups.set(phase, []);
		groups.get(phase)!.push({ step, index: originalIndex });
	}
	return groups;
}

/** Return phase numbers sorted ascending. */
export function getSortedPhases(groups: Map<number, unknown[]>): number[] {
	return [...groups.keys()].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Optional step partitioning
// ---------------------------------------------------------------------------

/**
 * Partition verify steps into active (will run) and skipped (optional but not
 * enabled for this goal).
 *
 * Returns:
 * - `active`: steps that should be executed
 * - `skippedIndices`: original indices of steps that were skipped
 */
export function partitionOptionalSteps(
	steps: VerifyStep[],
	enabledOptionalSteps: string[],
): { active: VerifyStep[]; skippedIndices: number[] } {
	const active: VerifyStep[] = [];
	const skippedIndices: number[] = [];
	steps.forEach((step, index) => {
		if (step.optional && !enabledOptionalSteps.includes(step.name)) {
			skippedIndices.push(index);
		} else {
			active.push(step);
		}
	});
	return { active, skippedIndices };
}

// ---------------------------------------------------------------------------
// Step cache (reuse previously-passed steps for same commit SHA)
// ---------------------------------------------------------------------------

/**
 * Build a cache of previously-passed verification steps from earlier signals
 * that share the same commit SHA.
 *
 * Only steps with `passed: true` from completed (non-running) verifications
 * are cached. The current signal is excluded from the search. When a reset
 * invalidation timestamp is provided, signals at or before that boundary are
 * excluded so audit history remains intact without making stale results
 * cache-eligible.
 *
 * `human-signoff` steps are **always excluded** — a prior approval is not
 * consent for a re-signal. Humans must re-confirm any time the gate is
 * re-signalled, even when the commit SHA hasn't changed. This was the
 * Bug-1 defense-in-depth fix in the "Re-attempt: Sign-Off Gates" goal:
 * without this filter, a single approval at SHA X would silently satisfy
 * every subsequent re-signal at the same SHA.
 */
export function buildStepCache(
	signals: GateSignal[],
	currentSignalId: string,
	commitSha?: string,
	verificationCacheInvalidatedAt?: number,
): Map<string, GateSignalStep> {
	const cache = new Map<string, GateSignalStep>();
	if (!commitSha) return cache;

	for (const prev of signals) {
		if (prev.id === currentSignalId) continue;
		if (verificationCacheInvalidatedAt !== undefined && prev.timestamp <= verificationCacheInvalidatedAt) continue;
		if (prev.commitSha !== commitSha) continue;
		if (!prev.verification?.status || prev.verification.status === "running") continue;
		for (const s of prev.verification.steps) {
			// Never reuse a prior human approval — humans must re-confirm.
			if (s.type === "human-signoff") continue;
			if (s.passed && !cache.has(s.name)) {
				cache.set(s.name, s);
			}
		}
	}
	return cache;
}

/**
 * Check whether every active step already has a cached result, meaning we can
 * skip spawning any agents and resolve the verification entirely from cache.
 */
export function canSkipAllSteps(
	cache: Map<string, GateSignalStep>,
	activeSteps: VerifyStep[],
): boolean {
	return cache.size >= activeSteps.length && activeSteps.every(s => cache.has(s.name));
}

// ---------------------------------------------------------------------------
// Content-keyed step cache (VER-01) — opt-in widening of buildStepCache
// ---------------------------------------------------------------------------
//
// buildStepCache above requires an EXACT commit-SHA match: every Ralph-loop
// fix commit changes HEAD, so it re-invalidates the whole gate suite even
// when a step's real inputs are untouched (see docs/design/gate-step-cache.md,
// finding VER-01). This section adds a second, opt-in cache mode selected via
// `BOBBIT_GATE_CACHE=content` (default remains "sha" — buildStepCache is
// UNCHANGED above, so the default behavior and its pinning tests are
// unaffected byte-for-byte).
//
// Content mode reuses a step from a *different* commit SHA only when the step
// declares `cacheInputGlobs` (VerifyStep) AND the declared globs are
// byte-identical between the two commits. Steps without declared globs always
// fall back to requiring an exact SHA match — the conservative default for
// step types whose real inputs can't be soundly expressed as static path
// globs (llm-review, agent-qa, subgoal, human-signoff).

/** Selects the gate step-cache keying strategy. See docs/design/gate-step-cache.md. */
export type GateCacheMode = "sha" | "content";

/**
 * Resolve `BOBBIT_GATE_CACHE` to a cache mode. Any value other than the
 * literal string `"content"` (including undefined, empty, or a typo) falls
 * back to `"sha"` — today's behavior — so a misconfigured env var can only
 * ever be *more* conservative, never silently widen reuse.
 */
export function resolveGateCacheMode(raw: string | undefined): GateCacheMode {
	return raw === "content" ? "content" : "sha";
}

/**
 * Convert a simple glob (`*` matches within a path segment, `**` matches
 * across segments, everything else is literal) into an anchored RegExp.
 * Deliberately minimal — no brace expansion, no character classes, no
 * negation. Over-matching is safe here (it only widens what counts as
 * "changed", never what counts as "unchanged"); under-matching a glob that
 * was meant to cover a path is the actual risk, so keep the glob vocabulary
 * small and the mapping obvious.
 */
export function globToRegExp(glob: string): RegExp {
	// Walk the glob one token at a time rather than split/join on a sentinel
	// (a sentinel string risks colliding with pathological input). `**`
	// crosses path separators, a lone `*`/`?` stays within a path segment,
	// everything else is escaped and matched literally.
	let pattern = "";
	for (let i = 0; i < glob.length; i++) {
		if (glob[i] === "*" && glob[i + 1] === "*") {
			pattern += ".*";
			i += 1;
		} else if (glob[i] === "*") {
			pattern += "[^/]*";
		} else if (glob[i] === "?") {
			pattern += "[^/]";
		} else if (/[.+^${}()|[\]\\]/.test(glob[i])) {
			pattern += `\\${glob[i]}`;
		} else {
			pattern += glob[i];
		}
	}
	return new RegExp(`^${pattern}$`);
}

/** True when `path` matches at least one of `globs` (see `globToRegExp`). */
export function pathMatchesAnyGlob(path: string, globs: string[]): boolean {
	return globs.some(g => globToRegExp(g).test(path));
}

/**
 * True when at least one entry of `trackedPaths` matches at least one of
 * `globs`. Used as a defense-in-depth existence guard: a glob that matches
 * NOTHING in the tree is indistinguishable, to a pathspec-scoped `git diff`,
 * from a glob whose files are merely unchanged — both report "no
 * differences". Without this guard a typo'd or stale glob (e.g. a renamed
 * `src/` directory) would silently look content-stable forever. Callers
 * should treat a `false` result as "cannot verify" and refuse to reuse,
 * NOT as "confirmed changed" or "confirmed unchanged".
 */
export function anyPathMatchesGlobs(trackedPaths: string[], globs: string[]): boolean {
	return trackedPaths.some(p => pathMatchesAnyGlob(p, globs));
}

export interface ContentCacheDecision {
	stepName: string;
	/** Which key actually produced (or would have produced) the verdict. */
	keyKind: "sha" | "content";
	result: "hit" | "miss";
	reason?: string;
}

/**
 * Git-backed lookups needed to evaluate content-keyed reuse. Injected so the
 * decision logic here stays pure/testable; the real implementation
 * (verification-harness.ts) shells out to `git`.
 */
export interface ContentCacheGitDeps {
	/** Flat list of tracked file paths at `sha`, relative to `cwd`'s repo root... callers pass paths relative to `cwd`. */
	listTrackedPaths(cwd: string, sha: string): Promise<string[]>;
	/** True when `git diff --quiet <priorSha> <currentSha> -- <globs>` (run at `cwd`) reports no differences. */
	diffIsClean(cwd: string, priorSha: string, currentSha: string, globs: string[]): Promise<boolean>;
}

/**
 * Content-keyed counterpart to `buildStepCache`. Reuses `buildStepCache`
 * verbatim for the exact-SHA case (identical semantics, zero duplicated
 * invalidation rules), then layers additional per-step content-matched reuse
 * on top for steps that:
 *   1. are still uncached after the exact-SHA pass,
 *   2. are not `human-signoff` (never reusable, any mode),
 *   3. declare `cacheInputGlobs` on the workflow step, and
 *   4. have a prior passed result whose declared globs are byte-identical
 *      (per `deps`) between that prior commit and the current one.
 *
 * `stepCwds` maps step name -> resolved cwd (the caller already computes this
 * via `resolveStep` to run the command; content mode reuses it rather than
 * re-resolving).
 */
export async function buildContentStepCache(
	signals: GateSignal[],
	currentSignalId: string,
	commitSha: string | undefined,
	verificationCacheInvalidatedAt: number | undefined,
	activeSteps: VerifyStep[],
	stepCwds: Map<string, string>,
	deps: ContentCacheGitDeps,
): Promise<{ cache: Map<string, GateSignalStep>; decisions: ContentCacheDecision[] }> {
	const decisions: ContentCacheDecision[] = [];
	const exact = buildStepCache(signals, currentSignalId, commitSha, verificationCacheInvalidatedAt);
	const cache = new Map(exact);
	const activeStepNames = new Set(activeSteps.map(s => s.name));
	for (const name of exact.keys()) {
		if (activeStepNames.has(name)) decisions.push({ stepName: name, keyKind: "sha", result: "hit" });
	}

	if (!commitSha) return { cache, decisions };

	const trackedPathsCache = new Map<string, string[]>(); // cwd -> tracked paths at commitSha

	for (const step of activeSteps) {
		if (cache.has(step.name)) continue; // already satisfied by exact match
		if (step.type === "human-signoff") continue; // never reusable, any mode

		const globs = step.cacheInputGlobs;
		if (!globs || globs.length === 0) {
			decisions.push({ stepName: step.name, keyKind: "sha", result: "miss", reason: "no cacheInputGlobs declared on step — sha-exact only" });
			continue;
		}

		// Find the (chronologically-first, matching buildStepCache's own
		// iteration convention) prior passed result for this step, at any SHA.
		let matchedStep: GateSignalStep | undefined;
		let matchedFromSha: string | undefined;
		for (const prev of signals) {
			if (prev.id === currentSignalId) continue;
			if (verificationCacheInvalidatedAt !== undefined && prev.timestamp <= verificationCacheInvalidatedAt) continue;
			if (!prev.verification?.status || prev.verification.status === "running") continue;
			const s = prev.verification.steps.find(x => x.name === step.name);
			if (!s || !s.passed) continue;
			matchedStep = s;
			matchedFromSha = prev.commitSha;
			break;
		}
		if (!matchedStep || !matchedFromSha) {
			decisions.push({ stepName: step.name, keyKind: "content", result: "miss", reason: "no prior passed result found" });
			continue;
		}
		if (matchedFromSha === commitSha) {
			// Should already be covered by the exact-SHA pass above, but keep this
			// branch for robustness (e.g. a step added to cacheInputGlobs after the
			// exact pass already ran with a name it didn't recognize).
			cache.set(step.name, matchedStep);
			decisions.push({ stepName: step.name, keyKind: "sha", result: "hit" });
			continue;
		}

		const cwd = stepCwds.get(step.name);
		if (!cwd) {
			decisions.push({ stepName: step.name, keyKind: "content", result: "miss", reason: "step cwd could not be resolved" });
			continue;
		}

		try {
			let trackedPaths = trackedPathsCache.get(cwd);
			if (!trackedPaths) {
				trackedPaths = await deps.listTrackedPaths(cwd, commitSha);
				trackedPathsCache.set(cwd, trackedPaths);
			}
			if (!anyPathMatchesGlobs(trackedPaths, globs)) {
				decisions.push({ stepName: step.name, keyKind: "content", result: "miss", reason: "cacheInputGlobs matched no tracked paths — cannot verify" });
				continue;
			}
			const unchanged = await deps.diffIsClean(cwd, matchedFromSha, commitSha, globs);
			if (unchanged) {
				cache.set(step.name, matchedStep);
				decisions.push({ stepName: step.name, keyKind: "content", result: "hit" });
			} else {
				decisions.push({ stepName: step.name, keyKind: "content", result: "miss" });
			}
		} catch (err) {
			// Any git failure (unreachable SHA after a force-push, timeout, etc.)
			// is conservative-miss, never a hit.
			const msg = err instanceof Error ? err.message : String(err);
			decisions.push({ stepName: step.name, keyKind: "content", result: "miss", reason: `git lookup failed: ${msg}` });
		}
	}

	return { cache, decisions };
}

// ---------------------------------------------------------------------------
// Overall pass/fail computation
// ---------------------------------------------------------------------------

/**
 * Determine whether all verification steps passed.
 *
 * Steps that were skipped (e.g. because an earlier phase failed, or because
 * they are disabled optional steps) are excluded from the pass/fail decision.
 * The actually-failed step in the earlier phase is what causes the gate to
 * fail — the downstream skipped steps should not pile on as additional
 * failures.
 */
export function computeAllPassed(results: GateSignalStep[]): boolean {
	return results.every(r => r.skipped || r.passed);
}
