/**
 * Regression tests for buildReviewPrompt's signal-metadata rendering.
 *
 * Bug: when `signalMetadata` was a string (e.g. because a caller serialised
 * an object to JSON before sending it), `Object.entries(string)` yielded
 * per-character bullets — producing 350+ junk `- **0**: {` lines in the
 * reviewer's system prompt and corrupting the review.
 *
 * Fix: type-guard `signalMetadata` to a non-array object before iterating.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt } from "../src/server/agent/verification-harness.js";

const baseArgs = {
	role: { promptTemplate: "role\n{{REVIEW_CONTEXT}}", name: "reviewer" },
	step: { name: "Test step", prompt: "Review the thing." },
	cwd: "/tmp/cwd",
	builtinVars: { branch: "goal/x", master: "main", cwd: "/tmp/cwd", commit: "abc123", goal_spec: "" },
	signalContent: undefined as string | undefined,
	goalSpec: "spec",
	allGateStates: new Map(),
	gate: { id: "implementation", depends_on: ["design-doc"] },
};

test("signalMetadata is a string: no per-character bullets, no Signal Metadata section", async () => {
	const prompt = await buildReviewPrompt(
		baseArgs.role,
		baseArgs.step,
		baseArgs.cwd,
		baseArgs.builtinVars,
		baseArgs.signalContent,
		// Pretend a caller passed `'{"k":"v"}'` (a JSON string) where we expect an object.
		'{"foo":"bar","baz":42}' as unknown as Record<string, string>,
		baseArgs.goalSpec,
		baseArgs.allGateStates,
		baseArgs.gate,
	);

	// Must NOT contain a per-character bullet like `- **0**: {`.
	assert.doesNotMatch(prompt, /^- \*\*0\*\*:/m, "string iterated as per-character bullets");
	assert.doesNotMatch(prompt, /^- \*\*1\*\*:/m, "string iterated as per-character bullets");
	// The whole section should be omitted when metadata is malformed.
	assert.doesNotMatch(prompt, /^### Signal Metadata$/m);
});

test("signalMetadata is null: no Signal Metadata section", async () => {
	const prompt = await buildReviewPrompt(
		baseArgs.role,
		baseArgs.step,
		baseArgs.cwd,
		baseArgs.builtinVars,
		baseArgs.signalContent,
		null as unknown as Record<string, string>,
		baseArgs.goalSpec,
		baseArgs.allGateStates,
		baseArgs.gate,
	);
	assert.doesNotMatch(prompt, /^### Signal Metadata$/m);
});

test("signalMetadata is an array: no Signal Metadata section", async () => {
	const prompt = await buildReviewPrompt(
		baseArgs.role,
		baseArgs.step,
		baseArgs.cwd,
		baseArgs.builtinVars,
		baseArgs.signalContent,
		["a", "b"] as unknown as Record<string, string>,
		baseArgs.goalSpec,
		baseArgs.allGateStates,
		baseArgs.gate,
	);
	assert.doesNotMatch(prompt, /^### Signal Metadata$/m);
});

test("signalMetadata is a proper object: renders bullets", async () => {
	const prompt = await buildReviewPrompt(
		baseArgs.role,
		baseArgs.step,
		baseArgs.cwd,
		baseArgs.builtinVars,
		baseArgs.signalContent,
		{ foo: "bar", baz: "qux" },
		baseArgs.goalSpec,
		baseArgs.allGateStates,
		baseArgs.gate,
	);
	assert.match(prompt, /^### Signal Metadata$/m);
	assert.match(prompt, /^- \*\*foo\*\*: bar$/m);
	assert.match(prompt, /^- \*\*baz\*\*: qux$/m);
});

test("signalMetadata with undefined values are filtered", async () => {
	const prompt = await buildReviewPrompt(
		baseArgs.role,
		baseArgs.step,
		baseArgs.cwd,
		baseArgs.builtinVars,
		baseArgs.signalContent,
		// Pass an object where one value is undefined.
		{ foo: "bar", missing: undefined as unknown as string },
		baseArgs.goalSpec,
		baseArgs.allGateStates,
		baseArgs.gate,
	);
	assert.match(prompt, /^- \*\*foo\*\*: bar$/m);
	assert.doesNotMatch(prompt, /^- \*\*missing\*\*:/m);
});

test("signalMetadata with non-string value is JSON.stringified", async () => {
	const prompt = await buildReviewPrompt(
		baseArgs.role,
		baseArgs.step,
		baseArgs.cwd,
		baseArgs.builtinVars,
		baseArgs.signalContent,
		// Pass a value that's actually a number — defensive path.
		{ count: 42 as unknown as string },
		baseArgs.goalSpec,
		baseArgs.allGateStates,
		baseArgs.gate,
	);
	assert.match(prompt, /^- \*\*count\*\*: 42$/m);
});

test("signalMetadata empty object: no Signal Metadata section", async () => {
	const prompt = await buildReviewPrompt(
		baseArgs.role,
		baseArgs.step,
		baseArgs.cwd,
		baseArgs.builtinVars,
		baseArgs.signalContent,
		{},
		baseArgs.goalSpec,
		baseArgs.allGateStates,
		baseArgs.gate,
	);
	assert.doesNotMatch(prompt, /^### Signal Metadata$/m);
});
