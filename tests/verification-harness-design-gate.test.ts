/**
 * Regression tests for the design-doc gate reviewer fix.
 *
 * Covers:
 *   RC1 \u2014 `substituteVars` uses the dynamic primary branch passed to the
 *          harness (so local stale `master` no longer produces false positives).
 *   RC2 \u2014 Pre-implementation design gates receive NO git diff/log
 *          instructions in their review prompt; implementation gates use
 *          `origin/<primary>` baselines.
 *
 * See docs/goals-workflows-tasks.md \u2014 "Gate verification baselines".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt } from "../src/server/agent/verification-harness.js";
import { isPreImplementationGate, substituteVars } from "../src/server/agent/verification-logic.js";

test("design-doc gate: prompt contains NO git diff instructions", async () => {
	const gate = { id: "design-doc", content: true, depends_on: [] };
	const prompt = await buildReviewPrompt(
		{ promptTemplate: "role\n{{REVIEW_CONTEXT}}", name: "architect" },
		{ name: "Design review", prompt: "Review the design." },
		"/tmp/cwd",
		{ branch: "goal/x", master: "main", cwd: "/tmp/cwd", commit: "abc123", goal_spec: "" },
		undefined, undefined, "spec", new Map(),
		gate,
	);
	// Must NOT contain an *actionable* `git diff <ref>...HEAD` instruction.
	// The design-gate text may reference the phrase `git diff` inside a NEGATION
	// ("Do NOT run `git diff`"), but must not include a runnable form like
	// `git diff master...HEAD` or `git diff origin/main...HEAD`.
	assert.doesNotMatch(prompt, /git diff \S+\.\.\.?HEAD/);
	assert.doesNotMatch(prompt, /git log \S+\.\.\.?HEAD/);
	assert.match(prompt, /pre-implementation/i);
	assert.match(prompt, /Baseline: none/);
});

test("implementation gate: prompt contains origin/<primary> diff instructions", async () => {
	const gate = { id: "implementation", depends_on: ["design-doc"] };
	const prompt = await buildReviewPrompt(
		{ promptTemplate: "role\n{{REVIEW_CONTEXT}}", name: "reviewer" },
		{ name: "Code quality", prompt: "Review code." },
		"/tmp/cwd",
		{ branch: "goal/x", master: "main", cwd: "/tmp/cwd", commit: "abc", goal_spec: "" },
		undefined, undefined, "spec", new Map(),
		gate,
	);
	assert.match(prompt, /git diff origin\/main\.\.\.HEAD/);
	// Must not have a bare-local `git diff main...HEAD` (without `origin/` prefix).
	assert.doesNotMatch(prompt, /git diff main\.\.\.HEAD/);
});

test("isPreImplementationGate: classification rules", () => {
	assert.equal(isPreImplementationGate({ content: true, depends_on: [] }), true);
	assert.equal(isPreImplementationGate({ content: true }), true);
	assert.equal(isPreImplementationGate({ content: true, depends_on: ["x"] }), false);
	assert.equal(isPreImplementationGate({ content: false, depends_on: [] }), false);
	assert.equal(isPreImplementationGate({}), false);
	// Also supports camelCase dependsOn (WorkflowGate shape).
	assert.equal(isPreImplementationGate({ content: true, dependsOn: [] }), true);
	assert.equal(isPreImplementationGate({ content: true, dependsOn: ["x"] }), false);
});

test("substituteVars: {{master}} resolves to dynamic primary branch name", () => {
	const out = substituteVars("diff {{master}}...HEAD", { master: "trunk", branch: "goal/x" }, {}, {}, new Map());
	assert.match(out, /diff trunk\.\.\.HEAD/);
	assert.doesNotMatch(out, /\{\{master\}\}/);
});
