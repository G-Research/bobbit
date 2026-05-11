/**
 * Unit tests for the tool-call verify-step handler.
 * Tool-call is the thinnest of the three new built-ins: it delegates the
 * actual session-spawn to the existing llm-review path via ctx.runLlmReview,
 * so these tests focus on prompt construction and result mapping.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toolCallHandler } from "../src/server/agent/verify-handlers/tool-call-handler.ts";
import type { VerifyExecCtx, VerifyStepResult } from "../src/server/agent/verify-handlers/registry.ts";
import type { VerifyStep } from "../src/server/agent/workflow-store.ts";

function ctx(runLlmReview?: VerifyExecCtx["runLlmReview"]): VerifyExecCtx {
	return {
		goalId: "g1",
		gateId: "gate-lit",
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
		runLlmReview,
	};
}

describe("tool-call handler", () => {
	it("fails without `tool`", async () => {
		const r = await toolCallHandler.execute(ctx(async () => ({ passed: true, output: "" })), {
			name: "x", type: "tool-call",
		});
		assert.equal(r.passed, false);
		assert.match(r.output, /has no `tool`/);
	});

	it("fails when runLlmReview is not provided", async () => {
		const r = await toolCallHandler.execute(ctx(undefined), {
			name: "x", type: "tool-call", tool: "literature_search",
		});
		assert.equal(r.passed, false);
		assert.match(r.output, /requires harness to expose runLlmReview/);
	});

	it("constructs a prompt that names the tool, serialises args, and instructs single invocation", async () => {
		let capturedPrompt = "";
		const runLlmReview = async (args: { prompt: string }): Promise<VerifyStepResult> => {
			capturedPrompt = args.prompt;
			return { passed: true, output: "Tool returned 12 relevant papers.", sessionId: "s1" };
		};
		const step: VerifyStep = {
			name: "Literature coverage", type: "tool-call",
			tool: "literature_search",
			args: { query: "diffusion models", min_results: 5 },
			expect: "success",
		};
		const result = await toolCallHandler.execute(ctx(runLlmReview), step);

		assert.equal(result.passed, true);
		assert.equal(result.sessionId, "s1");
		assert.match(capturedPrompt, /`literature_search`/);
		assert.match(capturedPrompt, /diffusion models/);
		assert.match(capturedPrompt, /min_results/);
		assert.match(capturedPrompt, /verification_result/);
		assert.match(capturedPrompt, /exactly once/);
	});

	it("inverts pass criterion when expect: failure", async () => {
		let capturedPrompt = "";
		const runLlmReview = async (args: { prompt: string }) => {
			capturedPrompt = args.prompt;
			return { passed: true, output: "Tool threw as expected.", sessionId: "s1" };
		};
		await toolCallHandler.execute(ctx(runLlmReview), {
			name: "x", type: "tool-call", tool: "must_fail", expect: "failure",
		});
		assert.match(capturedPrompt, /passes.*when the tool reports a failure/i);
	});

	it("passes the role through to runLlmReview so the user can pick a role with the tool allowed", async () => {
		let receivedRole: string | undefined;
		const runLlmReview = async (args: { prompt: string; role?: string }) => {
			receivedRole = args.role;
			return { passed: true, output: "ok" };
		};
		await toolCallHandler.execute(ctx(runLlmReview), {
			name: "x", type: "tool-call", tool: "literature_search", role: "researcher",
		});
		assert.equal(receivedRole, "researcher");
	});

	it("wraps non-empty output as a markdown artifact", async () => {
		const runLlmReview = async () => ({ passed: true, output: "## Tool output\n\nLooks great.", sessionId: "s1" });
		const r = await toolCallHandler.execute(ctx(runLlmReview), {
			name: "x", type: "tool-call", tool: "literature_search",
		});
		assert.equal(r.artifact?.contentType, "text/markdown");
		assert.match(r.artifact?.content ?? "", /Tool output/);
	});

	it("propagates underlying failure verbatim", async () => {
		const runLlmReview = async () => ({ passed: false, output: "Reviewer session timed out.", sessionId: "s1" });
		const r = await toolCallHandler.execute(ctx(runLlmReview), {
			name: "x", type: "tool-call", tool: "literature_search",
		});
		assert.equal(r.passed, false);
		assert.match(r.output, /timed out/);
	});
});
