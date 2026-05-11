import type { VerifyHandler, VerifyExecCtx, VerifyStepResult } from "./registry.js";
import type { VerifyStep } from "../workflow-store.js";

/**
 * `tool-call` invokes a registered agent tool as a verify step. It spawns a
 * minimal sub-agent under the supplied `role` (default: `reviewer`), instructs
 * it to call `tool(args)` once, and treats `verification_result` as the verdict.
 *
 * For this to work, the chosen role's tool policy must permit the named tool.
 * The pre-existing `verification_result` tool flows back through the harness's
 * `pendingResults` map, so no extra plumbing is needed — the result the agent
 * emits is what the gate observes.
 *
 * Why piggyback `runLlmReview` rather than introduce a separate session-spawn
 * path: every existing one-shot dispatch (llm-review, agent-qa) goes through
 * the harness's session machinery. Inventing a third spawn site would
 * duplicate ~200 lines of cancellation, timeout, and resume logic. Phase 2
 * extracts the shared machinery; until then, the prompt below is the only
 * difference between a "review" session and a "tool-call" session.
 */
export const toolCallHandler: VerifyHandler = {
	type: "tool-call",
	async execute(ctx: VerifyExecCtx, step: VerifyStep): Promise<VerifyStepResult> {
		if (typeof step.tool !== "string" || step.tool.length === 0) {
			return { passed: false, output: "tool-call step has no `tool` set." };
		}
		if (!ctx.runLlmReview) {
			return { passed: false, output: "tool-call requires harness to expose runLlmReview." };
		}

		const argsJson = step.args ? JSON.stringify(step.args, null, 2) : "{}";
		const expect = step.expect ?? "success";
		const userPrompt = step.prompt ? ctx.substituteVars(step.prompt) : "";

		const prompt = [
			`You are running as a verification step for gate '${ctx.gateId}'.`,
			"",
			`Your only task is to call the tool **\`${step.tool}\`** exactly once with the arguments below, then emit \`verification_result\` summarising what came back.`,
			"",
			"## Arguments",
			"```json",
			argsJson,
			"```",
			"",
			"## Pass criterion",
			expect === "failure"
				? "The step **passes** when the tool reports a failure (e.g. throws, returns an error, or emits content that doesn't satisfy the requested check)."
				: "The step **passes** when the tool returns successfully with non-empty output relevant to the requested check.",
			"",
			userPrompt ? `## Additional instructions\n${userPrompt}\n` : "",
			"## Output",
			"After the tool returns, call `verification_result(verdict, summary)`:",
			"- `verdict`: \"pass\" or \"fail\"",
			"- `summary`: a markdown summary of what the tool returned and why you graded it that way",
			"",
			"Do not perform any other work. Do not explore the codebase. Do not write files.",
		].filter(Boolean).join("\n");

		const result = await ctx.runLlmReview({
			prompt,
			role: step.role,
			timeout: step.timeout,
		});

		return {
			passed: result.passed,
			output: result.output,
			sessionId: result.sessionId,
			artifact: result.output && result.output.length > 0
				? { content: result.output, contentType: "text/markdown" }
				: undefined,
		};
	},
};
