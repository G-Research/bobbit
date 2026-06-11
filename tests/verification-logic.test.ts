/**
 * Unit tests for pure functions extracted from the verification harness.
 *
 * Runs via `npm run test:unit` (Node test runner, no Playwright needed).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	substituteVars,
	isTransientReviewError,
	isTransientQaError,
	matchExpectFailure,
	groupStepsByPhase,
	getSortedPhases,
	isCommandStepSkippable,
	partitionOptionalSteps,
	buildStepCache,
	canSkipAllSteps,
	computeAllPassed,
	TRANSIENT_ERROR_PATTERNS,
	TRANSIENT_ERROR_REGEXES,
	QA_NON_TRANSIENT_PATTERNS,
	detectJsonValidationError,
	// New classifier for provider overload / rate-limit / quota-throttle.
	// Used by SessionManager to pick the unbounded backoff policy.
	isProviderBackoffError,
	// Classifier for restart-induced resume errors (cold-agent RPC timeout, agent
	// process not yet up) that must leave the gate pending, not failed.
	isRestartInterruptError,
} from "../src/server/agent/verification-logic.ts";

// ---------------------------------------------------------------------------
// Helpers — minimal objects satisfying the VerifyStep / GateSignal shapes
// ---------------------------------------------------------------------------

function step(name: string, opts: Record<string, unknown> = {}): any {
	return { name, type: "command" as const, ...opts };
}

function signal(
	id: string,
	commitSha: string,
	verification?: { status: string; steps: { name: string; passed: boolean; output?: string; duration_ms?: number; type?: string }[] },
	opts: { timestamp?: number } = {},
): any {
	return {
		id,
		gateId: "g",
		goalId: "goal",
		sessionId: "s",
		timestamp: opts.timestamp ?? Date.now(),
		commitSha,
		verification: verification ?? { status: "passed", steps: [] },
	};
}

// ===================================================================
// substituteVars
// ===================================================================

describe("substituteVars", () => {
	const builtins = { branch: "feat/x", master: "master", cwd: "/work", commit: "abc123", goal_spec: "Fix the bug" };
	const project = { test_command: "npm test", typecheck_command: "npm run check", build_command: "npm run build" };
	const agent = { error_pattern: "Expected.*fail" };

	it("resolves builtin {{branch}}", () => {
		assert.equal(substituteVars("git checkout {{branch}}", builtins, {}, {}), "git checkout feat/x");
	});

	it("resolves builtin {{master}}", () => {
		assert.equal(substituteVars("git merge {{master}}", builtins, {}, {}), "git merge master");
	});

	it("resolves builtin {{cwd}}", () => {
		assert.equal(substituteVars("cd {{cwd}}", builtins, {}, {}), "cd /work");
	});

	it("resolves builtin {{commit}}", () => {
		assert.equal(substituteVars("git show {{commit}}", builtins, {}, {}), "git show abc123");
	});

	it("resolves builtin {{goal_spec}}", () => {
		assert.equal(substituteVars("Goal: {{goal_spec}}", builtins, {}, {}), "Goal: Fix the bug");
	});

	// Phase 2 of multi-repo & components removed `{{project.X}}` substitution.
	// The token is now left literal so isCommandStepSkippable() can detect it.
	it("leaves {{project.test_command}} literal (Phase 2 break)", () => {
		assert.equal(substituteVars("run {{project.test_command}}", {}, project, {}), "run {{project.test_command}}");
	});

	it("leaves {{project.typecheck_command}} literal (Phase 2 break)", () => {
		assert.equal(substituteVars("{{project.typecheck_command}} --strict", {}, project, {}), "{{project.typecheck_command}} --strict");
	});

	it("resolves {{agent.error_pattern}}", () => {
		assert.equal(substituteVars("pattern: {{agent.error_pattern}}", {}, {}, agent), "pattern: Expected.*fail");
	});

	it("resolves upstream gate metadata {{design-doc.meta.key}}", () => {
		const gates = new Map([
			["design-doc", { metadata: { key: "val123" } }],
		]);
		assert.equal(substituteVars("{{design-doc.meta.key}}", {}, {}, {}, gates), "val123");
	});

	it("leaves unresolved gate metadata as-is", () => {
		const gates = new Map([["other", { metadata: { x: "1" } }]]);
		assert.equal(substituteVars("{{missing-gate.meta.k}}", {}, {}, {}, gates), "{{missing-gate.meta.k}}");
	});

	it("leaves unresolved bare vars as-is", () => {
		assert.equal(substituteVars("{{unknown}}", {}, {}, {}), "{{unknown}}");
	});

	it("leaves unresolved project vars as-is", () => {
		assert.equal(substituteVars("{{project.missing}}", {}, project, {}), "{{project.missing}}");
	});

	it("returns empty string for empty template", () => {
		assert.equal(substituteVars("", builtins, project, agent), "");
	});

	it("returns template unchanged when no vars present", () => {
		assert.equal(substituteVars("just text", builtins, project, agent), "just text");
	});

	it("handles mixed namespaces in one template (project.X stays literal)", () => {
		const result = substituteVars(
			"cd {{cwd}} && {{project.test_command}} --branch={{branch}} --pat={{agent.error_pattern}}",
			builtins, project, agent,
		);
		assert.equal(result, "cd /work && {{project.test_command}} --branch=feat/x --pat=Expected.*fail");
	});

	it("handles whitespace inside braces {{ branch }}", () => {
		assert.equal(substituteVars("{{ branch }}", builtins, {}, {}), "feat/x");
	});

	it("handles whitespace in namespaced var {{ project.test_command }} (still left literal)", () => {
		assert.equal(substituteVars("{{ project.test_command }}", {}, project, {}), "{{ project.test_command }}");
	});
});

// ===================================================================
// isTransientReviewError
// ===================================================================

describe("isTransientReviewError", () => {
	it("matches 'timed out'", () => {
		assert.equal(isTransientReviewError("Agent timed out after 30s"), true);
	});

	it("matches 'ECONNRESET'", () => {
		assert.equal(isTransientReviewError("Error: read ECONNRESET"), true);
	});

	it("matches 'spawn UNKNOWN'", () => {
		assert.equal(isTransientReviewError("Error: spawn UNKNOWN"), true);
	});

	it("matches 'socket hang up'", () => {
		assert.equal(isTransientReviewError("socket hang up while connecting"), true);
	});

	it("matches 'connect ECONNREFUSED'", () => {
		assert.equal(isTransientReviewError("Error: connect ECONNREFUSED 127.0.0.1:3000"), true);
	});

	it("returns false for 'Agent did not call verification_result' (not in TRANSIENT_ERROR_PATTERNS)", () => {
		assert.equal(isTransientReviewError("Agent did not call verification_result"), false);
	});

	it("returns false for non-transient error", () => {
		// Note: "Unexpected token" is NOT present here — a bare "Syntax error" alone shouldn't trip.
		assert.equal(isTransientReviewError("TypeError: cannot read properties of null"), false);
	});

	it("returns false for empty string", () => {
		assert.equal(isTransientReviewError(""), false);
	});

	it("matches LLM JSON glitch 'Expected double-quoted property name'", () => {
		assert.equal(
			isTransientReviewError("Error: Expected double-quoted property name in JSON at position 42 (line 1 column 43)"),
			true,
		);
	});

	it("matches 'Validation failed for tool'", () => {
		assert.equal(isTransientReviewError("Validation failed for tool \"verification_result\": ..."), true);
	});

	it("matches 'Unexpected token'", () => {
		assert.equal(isTransientReviewError("SyntaxError: Unexpected token 'x' in JSON"), true);
	});

	it("matches 'Unexpected end of JSON'", () => {
		assert.equal(isTransientReviewError("Unexpected end of JSON input"), true);
	});

	it("detects every TRANSIENT_ERROR_PATTERNS entry", () => {
		for (const pattern of TRANSIENT_ERROR_PATTERNS) {
			assert.equal(
				isTransientReviewError(`Some context around ${pattern} in output`),
				true,
				`Expected '${pattern}' to be detected as transient`,
			);
		}
	});
});

// ===================================================================
// isProviderBackoffError — overload / rate-limit / quota-throttle
// ===================================================================

describe("isProviderBackoffError", () => {
	// The exact payload from the goal spec — Anthropic SDK surfaces the error
	// body as a JSON string in `error.message`.
	const ANTHROPIC_OVERLOAD_JSON =
		'Error: {"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011Cb3PkGgaYHToky3UNLG2i"}';

	it("matches the Anthropic overloaded_error JSON sample", () => {
		assert.equal(isProviderBackoffError(ANTHROPIC_OVERLOAD_JSON), true);
	});

	it("matches the bare 'overloaded_error' marker", () => {
		assert.equal(isProviderBackoffError('{"type":"overloaded_error"}'), true);
		assert.equal(isProviderBackoffError("overloaded_error"), true);
	});

	it("matches the bare 'rate_limit_error' marker", () => {
		assert.equal(isProviderBackoffError('{"type":"rate_limit_error"}'), true);
		assert.equal(isProviderBackoffError("Error: rate_limit_error from provider"), true);
	});

	it("matches HTTP 429 phrasings", () => {
		assert.equal(isProviderBackoffError("HTTP 429 Too Many Requests"), true);
		assert.equal(isProviderBackoffError("status 429"), true);
		assert.equal(isProviderBackoffError("statusCode: 429"), true);
	});

	it("matches HTTP 529 phrasings", () => {
		assert.equal(isProviderBackoffError("HTTP 529 Site is overloaded"), true);
		assert.equal(isProviderBackoffError("status 529"), true);
		assert.equal(isProviderBackoffError("statusCode: 529"), true);
	});

	it("overload/rate-limit markers are ALSO transient (single source of truth)", () => {
		assert.equal(isTransientReviewError(ANTHROPIC_OVERLOAD_JSON), true);
		assert.equal(isTransientReviewError('{"type":"rate_limit_error"}'), true);
		assert.equal(isTransientReviewError("HTTP 429"), true);
		assert.equal(isTransientReviewError("HTTP 529"), true);
	});

	it("returns false for empty / null-ish input", () => {
		assert.equal(isProviderBackoffError(""), false);
		assert.equal(isProviderBackoffError(null as unknown as string), false);
		assert.equal(isProviderBackoffError(undefined as unknown as string), false);
	});

	it("returns false for JSON parse / tool-validation transient errors", () => {
		// These remain transient (bounded retry) but are NOT provider-backoff.
		const jsonGlitch =
			"Error: Expected ',' or '}' after property value in JSON at position 320";
		assert.equal(isTransientReviewError(jsonGlitch), true);
		assert.equal(isProviderBackoffError(jsonGlitch), false);

		const toolValidation = 'Validation failed for tool "verification_result": ...';
		assert.equal(isTransientReviewError(toolValidation), true);
		assert.equal(isProviderBackoffError(toolValidation), false);

		const unexpectedToken = "SyntaxError: Unexpected token 'x' in JSON";
		assert.equal(isTransientReviewError(unexpectedToken), true);
		assert.equal(isProviderBackoffError(unexpectedToken), false);
	});

	it("returns false for network-blip transient errors", () => {
		// ECONNRESET / socket hang up / ECONNREFUSED are transient but the
		// existing bounded-retry policy is appropriate — they should NOT
		// switch the session into the 5-minute-cap unbounded mode.
		for (const msg of [
			"Error: read ECONNRESET",
			"socket hang up while connecting",
			"Error: connect ECONNREFUSED 127.0.0.1:3000",
			"Error: spawn UNKNOWN",
			"Agent process not running",
			"process exited",
		]) {
			assert.equal(
				isTransientReviewError(msg), true,
				`Expected transient: ${msg}`,
			);
			assert.equal(
				isProviderBackoffError(msg), false,
				`Expected NOT provider-backoff: ${msg}`,
			);
		}
	});

	it("does not false-positive on random 3-digit numbers or unrelated 'rate' words", () => {
		assert.equal(isProviderBackoffError("compiled 429 files"), false);
		assert.equal(isProviderBackoffError("sample rate: 44100"), false);
		assert.equal(isProviderBackoffError("TypeError: cannot read properties of null"), false);
	});
});

// ===================================================================
// isTransientQaError
// ===================================================================

describe("isTransientQaError", () => {
	it("matches transient pattern 'timed out'", () => {
		assert.equal(isTransientQaError("Request timed out"), true);
	});

	it("matches transient pattern 'ECONNRESET'", () => {
		assert.equal(isTransientQaError("read ECONNRESET"), true);
	});

	it("returns false for QA non-transient 'Agent did not call verification_result'", () => {
		assert.equal(isTransientQaError("Agent did not call verification_result"), false);
	});

	it("returns false when QA non-transient overrides transient substring", () => {
		// Contains both a QA_NON_TRANSIENT pattern and a transient pattern
		assert.equal(
			isTransientQaError("Agent did not call verification_result and timed out"),
			false,
		);
	});

	it("returns false for non-transient error", () => {
		assert.equal(isTransientQaError("TypeError: cannot read properties of null"), false);
	});

	it("returns false for empty string", () => {
		assert.equal(isTransientQaError(""), false);
	});

	it("matches JSON validation glitch for QA too", () => {
		assert.equal(
			isTransientQaError("Error: Expected double-quoted property name in JSON at position 42"),
			true,
		);
		assert.equal(isTransientQaError("Validation failed for tool 'verification_result': ..."), true);
	});

	it("QA non-transient still wins over JSON glitch", () => {
		// If the reviewer exhausted its budget AND produced a JSON glitch, treat as non-transient.
		assert.equal(
			isTransientQaError("Agent did not call verification_result. Also: Unexpected token"),
			false,
		);
	});
});

// ===================================================================
// detectJsonValidationError
// ===================================================================

describe("detectJsonValidationError", () => {
	it("returns null for empty input", () => {
		assert.equal(detectJsonValidationError(""), null);
		assert.equal(detectJsonValidationError(null as unknown as string), null);
	});

	it("returns null for non-matching output", () => {
		assert.equal(detectJsonValidationError("some ordinary error"), null);
	});

	it("extracts the line containing the JSON parse error", () => {
		const out =
			"Tool execution failed\n" +
			"Error: Expected double-quoted property name in JSON at position 42 (line 1 column 43)\n" +
			"More noise below";
		const detected = detectJsonValidationError(out);
		assert.ok(detected);
		assert.ok(detected!.includes("Expected double-quoted property name"));
		assert.ok(!detected!.includes("Tool execution failed"));
		assert.ok(!detected!.includes("More noise below"));
	});

	it("extracts validation failure lines", () => {
		const detected = detectJsonValidationError('Validation failed for tool "verification_result":\n  - verdict: must be equal to one of the allowed values');
		assert.ok(detected);
		assert.ok(detected!.includes("Validation failed for tool"));
	});

	it("trims to a reasonable length", () => {
		const longLine = "Unexpected token " + "x".repeat(10_000);
		const detected = detectJsonValidationError(longLine);
		assert.ok(detected);
		assert.ok(detected!.length <= 400);
	});

	it("detects the Node 20+ 'Expected ... in JSON at position N' phrasing", () => {
		// Real failure from session 80c7a7a8… — previously not matched and left the
		// session stuck until a human pressed Retry.
		const msg = "Error: Expected ',' or '}' after property value in JSON at position 320 (line 1 column 321)";
		assert.ok(detectJsonValidationError(msg), "Expected the V8 JSON error phrasing to be detected");
		assert.equal(isTransientReviewError(msg), true);
		assert.equal(isTransientQaError(msg), true);
	});

	it("detects the 'Unexpected non-whitespace character after JSON' phrasing", () => {
		const msg = "SyntaxError: Unexpected non-whitespace character after JSON at position 42";
		assert.ok(detectJsonValidationError(msg));
		assert.equal(isTransientReviewError(msg), true);
	});

	it("detects 'Unexpected end of input while parsing JSON'", () => {
		const msg = "Unexpected end of input while parsing JSON";
		assert.ok(detectJsonValidationError(msg));
		assert.equal(isTransientReviewError(msg), true);
	});

	it("detects every TRANSIENT_ERROR_REGEXES entry via a representative variant", () => {
		// One canonical sample per regex — asserts each pattern is reachable.
		const samples = [
			"Error: Expected ',' or '}' after property value in JSON at position 320",
			"Unexpected end of JSON input",
			"Expected double-quoted property name in JSON at position 42",
			"Expected property name or '}' in JSON at position 1",
		];
		for (const s of samples) {
			assert.ok(detectJsonValidationError(s), `Expected to detect: ${s}`);
			assert.equal(isTransientReviewError(s), true, `Expected transient: ${s}`);
		}
		// And make sure the exported regex list is non-empty so future refactors
		// don't silently empty it.
		assert.ok(TRANSIENT_ERROR_REGEXES.length > 0);
	});
});

// ===================================================================
// matchExpectFailure
// ===================================================================

describe("matchExpectFailure", () => {
	it("fails when command succeeds (exit 0) but was expected to fail", () => {
		const r = matchExpectFailure(0, "All tests passed");
		assert.equal(r.passed, false);
		assert.ok(r.output.includes("expected to fail"));
	});

	it("fails when command fails but no error_pattern provided", () => {
		const r = matchExpectFailure(1, "some error");
		assert.equal(r.passed, false);
		assert.ok(r.output.includes("no error_pattern metadata was provided"));
	});

	it("passes when command fails and error_pattern matches", () => {
		const r = matchExpectFailure(1, "Expected element to exist", "Expected element");
		assert.equal(r.passed, true);
	});

	it("fails when command fails but error_pattern does not match", () => {
		const r = matchExpectFailure(1, "Timeout waiting for page", "Expected element");
		assert.equal(r.passed, false);
		assert.ok(r.output.includes("did not match expected error pattern"));
	});

	it("fails with regex error for invalid error_pattern", () => {
		const r = matchExpectFailure(1, "some output", "[invalid(");
		assert.equal(r.passed, false);
		assert.ok(r.output.includes("Invalid error_pattern regex"));
	});

	it("performs case-insensitive matching", () => {
		const r = matchExpectFailure(1, "EXPECTED ELEMENT TO EXIST", "expected element");
		assert.equal(r.passed, true);
	});

	it("treats null exit code as non-zero (failure)", () => {
		const r = matchExpectFailure(null, "Crashed", "Crashed");
		assert.equal(r.passed, true);
	});

	it("includes truncated output in missing-pattern failure", () => {
		const longOutput = "x".repeat(600);
		const r = matchExpectFailure(1, longOutput);
		assert.equal(r.passed, false);
		// Output should be truncated to first 500 chars
		assert.ok(r.output.includes("Actual output (first 500 chars)"));
	});
});

// ===================================================================
// groupStepsByPhase
// ===================================================================

describe("groupStepsByPhase", () => {
	it("groups all steps into default phase 0 when no phase set", () => {
		const steps = [step("a"), step("b"), step("c")];
		const groups = groupStepsByPhase(steps, steps);
		assert.equal(groups.size, 1);
		assert.ok(groups.has(0));
		assert.equal(groups.get(0)!.length, 3);
	});

	it("groups steps across phases 0, 1, 2", () => {
		const steps = [
			step("a", { phase: 0 }),
			step("b", { phase: 1 }),
			step("c", { phase: 2 }),
		];
		const groups = groupStepsByPhase(steps, steps);
		assert.equal(groups.size, 3);
		assert.equal(groups.get(0)!.length, 1);
		assert.equal(groups.get(1)!.length, 1);
		assert.equal(groups.get(2)!.length, 1);
	});

	it("handles mixed explicit and default phases", () => {
		const steps = [step("a"), step("b", { phase: 1 }), step("c")];
		const groups = groupStepsByPhase(steps, steps);
		assert.equal(groups.size, 2);
		assert.equal(groups.get(0)!.length, 2);
		assert.equal(groups.get(1)!.length, 1);
	});

	it("returns empty map for empty steps", () => {
		const groups = groupStepsByPhase([], []);
		assert.equal(groups.size, 0);
	});

	it("preserves original indices from allSteps", () => {
		const allSteps = [step("a"), step("skipped"), step("b", { phase: 1 })];
		const active = [allSteps[0], allSteps[2]]; // skip index 1
		const groups = groupStepsByPhase(active, allSteps);
		assert.equal(groups.get(0)![0].index, 0);
		assert.equal(groups.get(1)![0].index, 2);
	});
});

// ===================================================================
// getSortedPhases
// ===================================================================

describe("getSortedPhases", () => {
	it("sorts phase numbers ascending", () => {
		const groups = new Map<number, unknown[]>([[2, []], [0, []], [1, []]]);
		assert.deepEqual(getSortedPhases(groups), [0, 1, 2]);
	});

	it("returns single phase", () => {
		const groups = new Map<number, unknown[]>([[0, []]]);
		assert.deepEqual(getSortedPhases(groups), [0]);
	});

	it("returns empty array for empty map", () => {
		assert.deepEqual(getSortedPhases(new Map()), []);
	});
});

// ===================================================================
// partitionOptionalSteps
// ===================================================================

describe("partitionOptionalSteps", () => {
	it("keeps all steps active when none are optional", () => {
		const steps = [step("a"), step("b")];
		const { active, skippedIndices } = partitionOptionalSteps(steps, []);
		assert.equal(active.length, 2);
		assert.equal(skippedIndices.length, 0);
	});

	it("skips optional step not in enabledOptionalSteps", () => {
		const steps = [step("a"), step("qa", { optional: true })];
		const { active, skippedIndices } = partitionOptionalSteps(steps, []);
		assert.equal(active.length, 1);
		assert.equal(active[0].name, "a");
		assert.deepEqual(skippedIndices, [1]);
	});

	it("includes optional step when it is in enabledOptionalSteps", () => {
		const steps = [step("a"), step("qa", { optional: true })];
		const { active, skippedIndices } = partitionOptionalSteps(steps, ["qa"]);
		assert.equal(active.length, 2);
		assert.equal(skippedIndices.length, 0);
	});

	it("handles mix of optional and required steps", () => {
		const steps = [
			step("build"),
			step("lint", { optional: true }),
			step("test"),
			step("qa", { optional: true }),
		];
		const { active, skippedIndices } = partitionOptionalSteps(steps, ["qa"]);
		assert.equal(active.length, 3);
		assert.equal(active.map((s: any) => s.name).join(","), "build,test,qa");
		assert.deepEqual(skippedIndices, [1]); // lint skipped
	});

	it("skips all optional steps when enabledOptionalSteps is empty", () => {
		const steps = [
			step("a", { optional: true }),
			step("b", { optional: true }),
		];
		const { active, skippedIndices } = partitionOptionalSteps(steps, []);
		assert.equal(active.length, 0);
		assert.deepEqual(skippedIndices, [0, 1]);
	});
});

// ===================================================================
// buildStepCache
// ===================================================================

describe("buildStepCache", () => {
	it("returns empty cache when no previous signals", () => {
		const cache = buildStepCache([], "sig-1", "abc");
		assert.equal(cache.size, 0);
	});

	it("returns empty cache when commitSha is undefined", () => {
		const sigs = [signal("sig-0", "abc", { status: "passed", steps: [{ name: "test", passed: true }] })];
		const cache = buildStepCache(sigs, "sig-1", undefined);
		assert.equal(cache.size, 0);
	});

	it("caches passed step with same commit SHA", () => {
		const sigs = [
			signal("sig-0", "abc", {
				status: "passed",
				steps: [{ name: "test", passed: true, output: "ok", duration_ms: 100 }],
			}),
		];
		const cache = buildStepCache(sigs, "sig-1", "abc");
		assert.equal(cache.size, 1);
		assert.ok(cache.has("test"));
	});

	it("does not cache steps from signals with different commit SHA", () => {
		const sigs = [
			signal("sig-0", "def", {
				status: "passed",
				steps: [{ name: "test", passed: true, output: "ok", duration_ms: 100 }],
			}),
		];
		const cache = buildStepCache(sigs, "sig-1", "abc");
		assert.equal(cache.size, 0);
	});

	it("does not cache failed steps", () => {
		const sigs = [
			signal("sig-0", "abc", {
				status: "failed",
				steps: [{ name: "test", passed: false, output: "err", duration_ms: 50 }],
			}),
		];
		const cache = buildStepCache(sigs, "sig-1", "abc");
		assert.equal(cache.size, 0);
	});

	it("does not cache steps from running verifications", () => {
		const sigs = [
			signal("sig-0", "abc", {
				status: "running",
				steps: [{ name: "test", passed: true, output: "ok", duration_ms: 100 }],
			}),
		];
		const cache = buildStepCache(sigs, "sig-1", "abc");
		assert.equal(cache.size, 0);
	});

	it("excludes current signal ID from cache", () => {
		const sigs = [
			signal("sig-1", "abc", {
				status: "passed",
				steps: [{ name: "test", passed: true, output: "ok", duration_ms: 100 }],
			}),
		];
		const cache = buildStepCache(sigs, "sig-1", "abc");
		assert.equal(cache.size, 0);
	});

	it("first cached result wins when multiple signals have the same step", () => {
		const sigs = [
			signal("sig-0", "abc", {
				status: "passed",
				steps: [{ name: "test", passed: true, output: "first", duration_ms: 100 }],
			}),
			signal("sig-2", "abc", {
				status: "passed",
				steps: [{ name: "test", passed: true, output: "second", duration_ms: 200 }],
			}),
		];
		const cache = buildStepCache(sigs, "sig-1", "abc");
		assert.equal(cache.get("test")!.output, "first");
	});

	it("ignores same-commit passed steps from before the reset invalidation marker", () => {
		const resetAt = 1_700_000_000_000;
		const sigs = [
			signal("sig-before-reset", "abc", {
				status: "passed",
				steps: [{ name: "test", passed: true, output: "pre-reset", duration_ms: 100 }],
			}, { timestamp: resetAt - 1 }),
			signal("sig-after-reset", "abc", {
				status: "passed",
				steps: [{ name: "test", passed: true, output: "post-reset", duration_ms: 125 }],
			}, { timestamp: resetAt + 1 }),
		];

		const cache = (buildStepCache as any)(sigs, "sig-current", "abc", resetAt);

		assert.equal(cache.size, 1);
		assert.equal(cache.get("test")!.output, "post-reset");
	});

	it("does not cache any pre-reset same-commit passed steps when there are no post-reset passes", () => {
		const resetAt = 1_700_000_000_000;
		const sigs = [
			signal("sig-before-reset", "abc", {
				status: "passed",
				steps: [{ name: "test", passed: true, output: "pre-reset", duration_ms: 100 }],
			}, { timestamp: resetAt - 1 }),
		];

		const cache = (buildStepCache as any)(sigs, "sig-current", "abc", resetAt);

		assert.equal(cache.size, 0);
	});

	it("keeps post-reset same-commit passed steps cache eligible while excluding human signoff", () => {
		const resetAt = 1_700_000_000_000;
		const sigs = [
			signal("sig-after-reset", "abc", {
				status: "passed",
				steps: [
					{ name: "build", type: "command", passed: true, output: "ok", duration_ms: 100 },
					{ name: "approve-design", type: "human-signoff", passed: true, output: "Approved", duration_ms: 1 },
				],
			}, { timestamp: resetAt + 1 }),
		];

		const cache = (buildStepCache as any)(sigs, "sig-current", "abc", resetAt);

		assert.equal(cache.size, 1, "only the command step should be cached after reset");
		assert.ok(cache.has("build"), "post-reset command step must still be reused");
		assert.ok(!cache.has("approve-design"), "human-signoff step must still NOT be reused");
	});

	// Pin the human-signoff exclusion (Bug-1 defense-in-depth fix in the
	// "Re-attempt: Sign-Off Gates" goal). A prior approval is not consent
	// for a re-signal — humans must re-confirm. Without this filter, a
	// single approval at SHA X would silently satisfy every subsequent
	// re-signal at the same SHA.
	it("excludes human-signoff steps even when passed at the same commit SHA", () => {
		const sigs = [
			signal("sig-0", "abc", {
				status: "passed",
				steps: [
					// A real previously-passed command step — must still be cached,
					// proving the filter is selective and not a blanket short-circuit.
					{ name: "build", type: "command", passed: true, output: "ok", duration_ms: 100 } as any,
					// A previously-approved human-signoff step — must NOT be cached.
					{ name: "approve-design", type: "human-signoff", passed: true, output: "Approved", duration_ms: 1 } as any,
				],
			}),
		];
		const cache = buildStepCache(sigs, "sig-1", "abc");
		assert.equal(cache.size, 1, "only the command step should be cached");
		assert.ok(cache.has("build"), "command step must still be reused");
		assert.ok(!cache.has("approve-design"), "human-signoff step must NOT be reused");
	});
});

// ===================================================================
// canSkipAllSteps
// ===================================================================

describe("canSkipAllSteps", () => {
	it("returns true when all active steps are cached", () => {
		const cache = new Map([
			["test", { name: "test", passed: true }],
			["lint", { name: "lint", passed: true }],
		]);
		const steps = [step("test"), step("lint")];
		assert.equal(canSkipAllSteps(cache as any, steps), true);
	});

	it("returns false when any step is not cached", () => {
		const cache = new Map([["test", { name: "test", passed: true }]]);
		const steps = [step("test"), step("lint")];
		assert.equal(canSkipAllSteps(cache as any, steps), false);
	});

	it("returns true for empty active steps (vacuously)", () => {
		assert.equal(canSkipAllSteps(new Map(), []), true);
	});

	it("returns false when cache is smaller than active steps", () => {
		const cache = new Map([["test", { name: "test", passed: true }]]);
		const steps = [step("test"), step("lint"), step("build")];
		assert.equal(canSkipAllSteps(cache as any, steps), false);
	});
});

// ===================================================================
// computeAllPassed
// ===================================================================

function signalStep(name: string, opts: Record<string, unknown> = {}): any {
	return { name, type: "command", passed: true, output: "", duration_ms: 0, ...opts };
}

describe("computeAllPassed", () => {
	it("returns true when all steps passed", () => {
		assert.equal(computeAllPassed([
			signalStep("test", { passed: true }),
			signalStep("lint", { passed: true }),
		]), true);
	});

	it("returns false when a step failed", () => {
		assert.equal(computeAllPassed([
			signalStep("test", { passed: true }),
			signalStep("lint", { passed: false }),
		]), false);
	});

	it("returns true when skipped steps have passed: false (phase-skipped)", () => {
		assert.equal(computeAllPassed([
			signalStep("test", { passed: true }),
			signalStep("review", { passed: false, skipped: true }),
		]), true);
	});

	it("returns true when skipped steps have passed: true (optional-skipped)", () => {
		assert.equal(computeAllPassed([
			signalStep("test", { passed: true }),
			signalStep("qa", { passed: true, skipped: true }),
		]), true);
	});

	it("returns false when a non-skipped step failed even if skipped steps exist", () => {
		assert.equal(computeAllPassed([
			signalStep("test", { passed: false }),
			signalStep("review", { passed: false, skipped: true }),
		]), false);
	});

	it("returns true for empty results (vacuously)", () => {
		assert.equal(computeAllPassed([]), true);
	});

	it("returns true when all steps are skipped", () => {
		assert.equal(computeAllPassed([
			signalStep("qa", { passed: false, skipped: true }),
			signalStep("review", { passed: false, skipped: true }),
		]), true);
	});
});

// ---------------------------------------------------------------------------
// isCommandStepSkippable — auto-skip empty / unresolved-template commands
// ---------------------------------------------------------------------------

describe("isCommandStepSkippable", () => {
	it("returns null for a resolved non-empty command", () => {
		assert.equal(isCommandStepSkippable("npm run build"), null);
		assert.equal(isCommandStepSkippable("npx tsc --noEmit"), null);
	});

	it("returns a skip reason when the command is empty", () => {
		const reason = isCommandStepSkippable("");
		assert.ok(reason && reason.includes("empty"));
	});

	it("returns a skip reason when the command is only whitespace", () => {
		const reason = isCommandStepSkippable("   \n  \t");
		assert.ok(reason && reason.includes("empty"));
	});

	it("returns a skip reason when a {{project.*}} template is unresolved", () => {
		const reason = isCommandStepSkippable("{{project.build_command}}");
		assert.ok(reason);
		assert.ok(reason.includes("project.build_command"));
		assert.ok(reason.includes("not configured"));
	});

	it("returns a skip reason when an unresolved template is embedded mid-command", () => {
		const reason = isCommandStepSkippable("echo {{project.custom_thing}} && true");
		assert.ok(reason);
		assert.ok(reason.includes("project.custom_thing"));
	});

	it("does not skip a fully-resolved command that happens to contain braces", () => {
		// Real commands can contain `{}` (e.g. find -exec, awk) — only `{{...}}`
		// patterns count as unresolved templates.
		assert.equal(isCommandStepSkippable("find . -exec echo {} \\;"), null);
		assert.equal(isCommandStepSkippable("awk '{print $1}'"), null);
	});
});

// ---------------------------------------------------------------------------
// isRestartInterruptError — classify resume-path thrown errors
// ---------------------------------------------------------------------------

describe("isRestartInterruptError", () => {
	it("treats cold-agent RPC timeouts as restart-interrupts (not real failures)", () => {
		// The exact message RpcBridge.sendCommand rejects with on the 30s default.
		assert.equal(isRestartInterruptError("Command timed out: prompt"), true);
		assert.equal(isRestartInterruptError("Command timed out: get_state"), true);
		// Generic "timed out" phrasings.
		assert.equal(isRestartInterruptError("operation timed out"), true);
	});

	it("treats agent-not-ready / process-gone errors as restart-interrupts", () => {
		assert.equal(isRestartInterruptError("Agent did not become ready within 90000ms"), true);
		assert.equal(isRestartInterruptError("reviewer agent not ready"), true);
		assert.equal(isRestartInterruptError("Agent process exited during initialization"), true);
		assert.equal(isRestartInterruptError("Agent process not running"), true);
		assert.equal(isRestartInterruptError("child process exited"), true);
	});

	it("returns false for genuine, non-restart failures and empty input", () => {
		assert.equal(isRestartInterruptError(""), false);
		assert.equal(isRestartInterruptError("Review found a real bug: missing null check"), false);
		assert.equal(isRestartInterruptError("TypeError: cannot read property foo of undefined"), false);
	});
});
