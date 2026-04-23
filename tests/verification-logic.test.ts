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
	partitionOptionalSteps,
	buildStepCache,
	canSkipAllSteps,
	computeAllPassed,
	TRANSIENT_ERROR_PATTERNS,
	TRANSIENT_ERROR_REGEXES,
	QA_NON_TRANSIENT_PATTERNS,
	detectJsonValidationError,
} from "../dist/server/agent/verification-logic.js";

// ---------------------------------------------------------------------------
// Helpers — minimal objects satisfying the VerifyStep / GateSignal shapes
// ---------------------------------------------------------------------------

function step(name: string, opts: Record<string, unknown> = {}): any {
	return { name, type: "command" as const, ...opts };
}

function signal(
	id: string,
	commitSha: string,
	verification?: { status: string; steps: { name: string; passed: boolean; output?: string; duration_ms?: number }[] },
): any {
	return {
		id,
		gateId: "g",
		goalId: "goal",
		sessionId: "s",
		timestamp: Date.now(),
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

	it("resolves {{project.test_command}}", () => {
		assert.equal(substituteVars("run {{project.test_command}}", {}, project, {}), "run npm test");
	});

	it("resolves {{project.typecheck_command}}", () => {
		assert.equal(substituteVars("{{project.typecheck_command}} --strict", {}, project, {}), "npm run check --strict");
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

	it("handles mixed namespaces in one template", () => {
		const result = substituteVars(
			"cd {{cwd}} && {{project.test_command}} --branch={{branch}} --pat={{agent.error_pattern}}",
			builtins, project, agent,
		);
		assert.equal(result, "cd /work && npm test --branch=feat/x --pat=Expected.*fail");
	});

	it("handles whitespace inside braces {{ branch }}", () => {
		assert.equal(substituteVars("{{ branch }}", builtins, {}, {}), "feat/x");
	});

	it("handles whitespace in namespaced var {{ project.test_command }}", () => {
		assert.equal(substituteVars("{{ project.test_command }}", {}, project, {}), "npm test");
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
