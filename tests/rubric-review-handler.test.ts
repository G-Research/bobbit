/**
 * Unit tests for the rubric-review verify-step handler.
 *
 * Covers:
 *   - human mode: callback token flow, triple validation, value validation,
 *     pass_when evaluation
 *   - llm mode: rubric prompt assembly, JSON extraction, value validation,
 *     pass_when evaluation
 *   - the pass_when mini-language (numeric comparisons, string equality, AND/OR)
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
	rubricReviewHandler,
	deliverRubricHumanCallback,
	evaluatePassWhen,
	_clearPendingRubricForTests,
} from "../src/server/agent/verify-handlers/rubric-review-handler.ts";
import type { VerifyExecCtx } from "../src/server/agent/verify-handlers/registry.ts";
import type { VerifyStep } from "../src/server/agent/workflow-store.ts";

function ctx(overrides: Partial<VerifyExecCtx> = {}): VerifyExecCtx {
	return {
		goalId: "g1",
		gateId: "gate-novelty",
		signalId: "sig-1",
		signal: {} as any,
		gate: {} as any,
		cwd: "/tmp",
		branch: "feature",
		primaryBranch: "master",
		builtinVars: {},
		projectVars: {},
		agentVars: {},
		substituteVars: (t: string) => t,
		broadcast: () => {},
		persistActive: () => {},
		isCancelled: () => false,
		...overrides,
	};
}

const NOVELTY_RUBRIC = [
	{ id: "novelty", label: "Novelty", scale: { min: 1, max: 5 } },
	{ id: "feasibility", label: "Feasibility", options: ["low", "medium", "high"] },
	{ id: "notes", label: "Notes", kind: "text" as const },
];

function step(opts: Partial<VerifyStep> = {}): VerifyStep {
	return {
		name: "Novelty rubric",
		type: "rubric-review",
		reviewer: "human",
		rubric: NOVELTY_RUBRIC,
		...opts,
	};
}

describe("rubric-review/human", () => {
	beforeEach(() => _clearPendingRubricForTests());

	it("rejects when no rubric is supplied", async () => {
		const result = await rubricReviewHandler.execute(ctx(), { name: "x", type: "rubric-review", reviewer: "human", rubric: [] });
		assert.equal(result.passed, false);
		assert.match(result.output, /no rubric items/);
	});

	it("broadcasts a token and accepts a matching callback", async () => {
		let token: string | undefined;
		const c = ctx({ broadcast: (ev: any) => { if (ev.token) token = ev.token; } });
		const promise = rubricReviewHandler.execute(c, step({ pass_when: "novelty >= 3 AND feasibility != 'low'" }));
		assert.ok(token);

		const outcome = deliverRubricHumanCallback(token, {
			goalId: "g1", gateId: "gate-novelty", signalId: "sig-1",
			values: { novelty: 4, feasibility: "high", notes: "promising" },
			notes: "Solid idea.",
		});
		assert.deepEqual(outcome, { ok: true });

		const result = await promise;
		assert.equal(result.passed, true);
		assert.match(result.output, /Rubric passed/);
		assert.equal(result.artifact?.contentType, "text/markdown");
		assert.equal(result.artifact?.metadata?.novelty, "4");
		assert.equal(result.artifact?.metadata?.feasibility, "high");
	});

	it("fails the gate when pass_when evaluates false", async () => {
		let token: string | undefined;
		const c = ctx({ broadcast: (ev: any) => { if (ev.token) token = ev.token; } });
		const promise = rubricReviewHandler.execute(c, step({ pass_when: "novelty >= 3 AND feasibility != 'low'" }));
		assert.ok(token);

		deliverRubricHumanCallback(token, {
			goalId: "g1", gateId: "gate-novelty", signalId: "sig-1",
			values: { novelty: 2, feasibility: "high", notes: "weak" },
		});

		const result = await promise;
		assert.equal(result.passed, false);
		assert.match(result.output, /Rubric failed/);
	});

	it("rejects callback with invalid scale value", async () => {
		let token: string | undefined;
		const c = ctx({ broadcast: (ev: any) => { if (ev.token) token = ev.token; } });
		const promise = rubricReviewHandler.execute(c, step());
		assert.ok(token);

		const outcome = deliverRubricHumanCallback(token, {
			goalId: "g1", gateId: "gate-novelty", signalId: "sig-1",
			values: { novelty: 99, feasibility: "high", notes: "x" },
		});
		assert.equal(outcome.ok, false);
		assert.equal((outcome as any).status, 400);
		assert.match((outcome as any).error, /'novelty' must be an integer in/);

		// Allow the pending entry to terminate cleanly.
		deliverRubricHumanCallback(token, {
			goalId: "g1", gateId: "gate-novelty", signalId: "sig-1",
			values: { novelty: 1, feasibility: "high", notes: "x" },
		});
		await promise;
	});

	it("rejects callback when triple does not match", () => {
		const promise = rubricReviewHandler.execute(ctx(), step());
		const outcome = deliverRubricHumanCallback("does-not-exist", {
			goalId: "g1", gateId: "gate-novelty", signalId: "sig-1",
			values: { novelty: 3, feasibility: "high", notes: "x" },
		});
		assert.equal(outcome.ok, false);
		assert.equal((outcome as any).status, 404);
		void promise;
	});
});

describe("rubric-review/llm", () => {
	it("requires the harness to provide runLlmReview", async () => {
		const result = await rubricReviewHandler.execute(
			ctx(),
			step({ reviewer: "llm", prompt: "Score it." }),
		);
		assert.equal(result.passed, false);
		assert.match(result.output, /requires harness to expose runLlmReview/);
	});

	it("parses LLM JSON output, validates against the rubric, and applies pass_when", async () => {
		const llmOutput = [
			"# Review",
			"",
			"The idea is decent.",
			"",
			"```json",
			"{ \"values\": { \"novelty\": 4, \"feasibility\": \"high\", \"notes\": \"good\" }, \"notes\": \"Strong novelty.\" }",
			"```",
		].join("\n");

		const c = ctx({
			runLlmReview: async () => ({ passed: true, output: llmOutput, sessionId: "sess-1" }),
		});
		const result = await rubricReviewHandler.execute(c, step({
			reviewer: "llm",
			prompt: "Score the idea.",
			pass_when: "novelty >= 3",
		}));
		assert.equal(result.passed, true);
		assert.equal(result.sessionId, "sess-1");
		assert.match(result.artifact?.content ?? "", /Strong novelty/);
		assert.equal(result.artifact?.metadata?.novelty, "4");
	});

	it("fails when the LLM emits no JSON block", async () => {
		const c = ctx({
			runLlmReview: async () => ({ passed: true, output: "Looks fine to me.", sessionId: "sess-1" }),
		});
		const result = await rubricReviewHandler.execute(c, step({
			reviewer: "llm", prompt: "Score.",
		}));
		assert.equal(result.passed, false);
		assert.match(result.output, /no ```json block found/);
	});

	it("fails when the LLM emits invalid rubric values", async () => {
		const c = ctx({
			runLlmReview: async () => ({
				passed: true,
				output: "```json\n{ \"values\": { \"novelty\": 99, \"feasibility\": \"high\", \"notes\": \"x\" } }\n```",
				sessionId: "sess-1",
			}),
		});
		const result = await rubricReviewHandler.execute(c, step({
			reviewer: "llm", prompt: "Score.",
		}));
		assert.equal(result.passed, false);
		assert.match(result.output, /invalid rubric values/);
	});

	it("propagates underlying LLM review failure (timeout, transport, etc.)", async () => {
		const c = ctx({
			runLlmReview: async () => ({ passed: false, output: "review timed out", sessionId: "sess-1" }),
		});
		const result = await rubricReviewHandler.execute(c, step({
			reviewer: "llm", prompt: "Score.",
		}));
		assert.equal(result.passed, false);
		assert.equal(result.sessionId, "sess-1");
	});
});

describe("evaluatePassWhen", () => {
	it("numeric ≥ on integers", () => {
		assert.equal(evaluatePassWhen("novelty >= 3", { novelty: 4 }), true);
		assert.equal(evaluatePassWhen("novelty >= 3", { novelty: 2 }), false);
	});

	it("string != with single-quoted literal", () => {
		assert.equal(evaluatePassWhen("feasibility != 'low'", { feasibility: "high" }), true);
		assert.equal(evaluatePassWhen("feasibility != 'low'", { feasibility: "low" }), false);
	});

	it("AND combines clauses", () => {
		const vals = { novelty: 4, feasibility: "high" };
		assert.equal(evaluatePassWhen("novelty >= 3 AND feasibility != 'low'", vals), true);
		assert.equal(evaluatePassWhen("novelty >= 5 AND feasibility != 'low'", vals), false);
	});

	it("OR combines clauses", () => {
		const vals = { novelty: 1, feasibility: "high" };
		assert.equal(evaluatePassWhen("novelty >= 5 OR feasibility = 'high'", vals), true);
		assert.equal(evaluatePassWhen("novelty >= 5 OR feasibility = 'low'", vals), false);
	});

	it("missing identifier yields false rather than throwing", () => {
		assert.equal(evaluatePassWhen("missing >= 1", { other: 5 }), false);
	});
});
