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
	"EPIPE",
	"spawn UNKNOWN",
	"socket hang up",
	"connect ECONNREFUSED",
	// Tool-call schema validation failure from the provider SDK — distinct
	// from the raw JSON parse errors, which live in TRANSIENT_ERROR_REGEXES.
	"Validation failed for tool",
];

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
	return TRANSIENT_ERROR_REGEXES.some(re => re.test(output));
}

/** Check if an LLM review error output matches a transient failure pattern. */
export function isTransientReviewError(output: string): boolean {
	return matchesAnyTransient(output);
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
 * - {{project.key}} — from project config (.bobbit/config/project.yaml)
 * - {{agent.key}} — from the signal's metadata (provided by the agent)
 * - {{gate_id.meta.key}} — from an upstream gate's metadata
 * - {{goal_spec}} — the goal specification text
 *
 * Legacy bare references like {{typecheck_command}} are NOT resolved to
 * prevent accidental cross-namespace collisions. Use the explicit namespace.
 */
export function substituteVars(
	template: string,
	builtinVars: Record<string, string>,
	projectVars: Record<string, string>,
	agentVars: Record<string, string>,
	allGateStates?: Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>,
): string {
	return template.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
		const trimmed = key.trim();

		// {{project.key}} — project config
		if (trimmed.startsWith("project.")) {
			const field = trimmed.slice("project.".length);
			if (field in projectVars) return projectVars[field];
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

		// Bare variables — builtins only (branch, master, cwd, goal_spec)
		if (trimmed in builtinVars) return builtinVars[trimmed];

		return match; // Leave unresolved
	});
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
 * are cached. The current signal is excluded from the search.
 */
export function buildStepCache(
	signals: GateSignal[],
	currentSignalId: string,
	commitSha?: string,
): Map<string, GateSignalStep> {
	const cache = new Map<string, GateSignalStep>();
	if (!commitSha) return cache;

	for (const prev of signals) {
		if (prev.id === currentSignalId) continue;
		if (prev.commitSha !== commitSha) continue;
		if (!prev.verification?.status || prev.verification.status === "running") continue;
		for (const s of prev.verification.steps) {
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
