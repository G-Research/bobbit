// CLF-W1b: pinning tests for the F14 deterministic thinking-level router's
// rule table (`classifyThinkingLevel`) and its `DecisionClassifier` wrapper
// (`thinkingRouterClassifier`). See the Fable program's classifier-framework
// design note §7/§9
// ("Regex `ultrathink`→xhigh (0 tokens)") and
// src/server/agent/thinking-router-classifier.ts's header comment for why
// there are no further heuristic tiers this wave — every rule not below MUST
// abstain, never guess.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	classifyThinkingLevel,
	thinkingRouterClassifier,
	THINKING_ROUTER_CLASSIFIER_ID,
	THINKING_ROUTER_POINT,
	THINKING_ROUTER_KIND,
} from "../src/server/agent/thinking-router-classifier.ts";

describe("classifyThinkingLevel (F14 deterministic rule table)", () => {
	it("selects xhigh for an explicit 'ultrathink' keyword", () => {
		const decision = classifyThinkingLevel("ultrathink: redesign the whole auth flow");
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "xhigh");
		assert.equal((decision as { confidence?: number }).confidence, 1);
	});

	it("is case-insensitive for 'ultrathink'", () => {
		const decision = classifyThinkingLevel("ULTRATHINK this please");
		assert.deepEqual(decision, { kind: "select", choice: "xhigh", confidence: 1, rationale: "matched deterministic rule 'ultrathink'" });
	});

	it("selects xhigh for the 'think harder' F14-ultrathink-override marker", () => {
		const decision = classifyThinkingLevel("no really, think harder about this one");
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "xhigh");
	});

	it("is case-insensitive for 'think harder'", () => {
		const decision = classifyThinkingLevel("Think Harder");
		assert.equal(decision.kind, "select");
	});

	it("does not false-positive on a superstring like 'ultrathinking'", () => {
		assert.deepEqual(classifyThinkingLevel("I was ultrathinking about it"), { kind: "abstain" });
	});

	it("does not false-positive on 'rethink harder' (word boundary on 'think harder')", () => {
		// "rethink harder" contains "think harder" as a substring at a word
		// boundary before "harder" but NOT before "think" (preceded by "re"),
		// so \bthink harder\b must not match. Regression guard for the exact
		// boundary semantics, not just presence of the substring.
		assert.deepEqual(classifyThinkingLevel("I want you to rethink harder about this"), { kind: "abstain" });
	});

	it("abstains on an ordinary prompt with no keyword — no ambiguity guessing", () => {
		assert.deepEqual(classifyThinkingLevel("fix this typo in the README"), { kind: "abstain" });
	});

	it("abstains on an empty string", () => {
		assert.deepEqual(classifyThinkingLevel(""), { kind: "abstain" });
	});

	it("does not invent prompt-shape heuristic tiers for a long/complex-looking prompt", () => {
		const longPrompt = "please ".repeat(200) + "refactor the entire codebase across every module and add full test coverage";
		assert.deepEqual(classifyThinkingLevel(longPrompt), { kind: "abstain" });
	});
});

describe("thinkingRouterClassifier (DecisionClassifier wrapper)", () => {
	const ctx = { sessionId: "sess-1", cwd: "/tmp" };

	it("has the expected built-in classifier id", () => {
		assert.equal(thinkingRouterClassifier.id, THINKING_ROUTER_CLASSIFIER_ID);
	});

	it("registers at (user-prompt-submit, thinking) per the design doc's F14 unification row", () => {
		assert.equal(THINKING_ROUTER_POINT, "user-prompt-submit");
		assert.equal(THINKING_ROUTER_KIND, "thinking");
	});

	it("reads `arg.text` and selects xhigh for ultrathink", async () => {
		const decision = await thinkingRouterClassifier.evaluate(ctx, { text: "ultrathink about this" });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "xhigh");
	});

	it("abstains for a malformed arg (missing text) rather than throwing", async () => {
		const decision = await thinkingRouterClassifier.evaluate(ctx, { notText: "oops" });
		assert.deepEqual(decision, { kind: "abstain" });
	});

	it("abstains for a null/undefined arg rather than throwing", async () => {
		assert.deepEqual(await thinkingRouterClassifier.evaluate(ctx, undefined), { kind: "abstain" });
		assert.deepEqual(await thinkingRouterClassifier.evaluate(ctx, null), { kind: "abstain" });
	});
});
