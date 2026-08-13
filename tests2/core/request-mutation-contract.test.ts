import { describe, expect, it } from "vitest";
import { validateDecisionHookOutput } from "../../src/server/agent/decision-hook-contract.ts";
import {
	MAX_REQUEST_MUTATION_PROMPT_BYTES,
	RequestMutationContractError,
	reducePromptShape,
	reduceToolSafety,
	validateRequestMutationHookOutput,
	validateRequestMutationProposal,
} from "../../src/server/agent/request-mutation-contract.ts";

const promptRequest = { sessionId: "session-a", projectId: "project-a", text: "original" };
const toolRequest = { sessionId: "session-a", projectId: "project-a", toolName: "bash" };
const source = (packId: string, priority: number) => ({ packId, hookId: "hook", priority });

function prompt(text = "replacement"): unknown {
	return { kind: "request-mutation", proposal: { kind: "prompt-shape", version: 1, intent: "clarify", text, reasonId: "clarify" } };
}
function tool(decision: "warn" | "deny", name?: string): unknown {
	return { kind: "request-mutation", proposal: { kind: "tool-safety", version: 1, decision, ...(name === undefined ? {} : { tool: name }), reasonId: "policy" } };
}
function code(value: unknown, event: "beforePrompt" | "beforeToolCall", request: typeof promptRequest | typeof toolRequest): string {
	try { validateRequestMutationHookOutput(value, event, request); } catch (error) {
		if (error instanceof RequestMutationContractError) return error.code;
		throw error;
	}
	throw new Error("expected contract failure");
}

describe("request mutation contract", () => {
	it("accepts only closed, event-scoped proposal discriminants", () => {
		expect(validateRequestMutationHookOutput(prompt(), "beforePrompt", promptRequest)).toMatchObject({ kind: "prompt-shape", text: "replacement" });
		expect(validateRequestMutationHookOutput(tool("deny"), "beforeToolCall", toolRequest)).toMatchObject({ kind: "tool-safety", decision: "deny" });
		expect(validateRequestMutationHookOutput(null, "beforePrompt", promptRequest)).toBeNull();
		expect(code({ kind: "request-mutation", proposal: { kind: "prompt-shape", version: 1, intent: "clarify", text: "x", reasonId: "id", systemPrompt: "no" } }, "beforePrompt", promptRequest)).toBe("UNKNOWN_PROPOSAL_FIELD");
		expect(code({ kind: "request-mutation", proposal: { kind: "tool-safety", version: 1, decision: "deny", reasonId: "id", arguments: {} } }, "beforeToolCall", toolRequest)).toBe("UNKNOWN_PROPOSAL_FIELD");
		expect(code(prompt(), "beforeToolCall", toolRequest)).toBe("INVALID_PROPOSAL_EVENT");
	});

	it("admits the output through the decision hook contract only with a mutation context", () => {
		expect(() => validateDecisionHookOutput(prompt())).toThrow(expect.objectContaining({ code: "INVALID_HOOK_OUTPUT" }));
		expect(validateDecisionHookOutput(prompt(), { requestMutation: { event: "beforePrompt", request: promptRequest } })).toMatchObject({ kind: "request-mutation", proposal: { kind: "prompt-shape" } });
	});

	it("enforces UTF-8, identifier, and exact tool scope bounds", () => {
		expect(code(prompt("x".repeat(MAX_REQUEST_MUTATION_PROMPT_BYTES + 1)), "beforePrompt", promptRequest)).toBe("INVALID_PROMPT_PROPOSAL");
		expect(code({ kind: "request-mutation", proposal: { kind: "prompt-shape", version: 1, intent: "clarify", text: "https://u:p@example.test", reasonId: "id" } }, "beforePrompt", promptRequest)).toBe("INVALID_PROMPT_PROPOSAL");
		expect(code(tool("deny", "other-tool"), "beforeToolCall", toolRequest)).toBe("TOOL_SCOPE_MISMATCH");
		expect(code({ kind: "request-mutation", proposal: { kind: "tool-safety", version: 1, decision: "deny", reasonId: "has space" } }, "beforeToolCall", toolRequest)).toBe("INVALID_TOOL_PROPOSAL");
	});

	it("uses stable higher-priority prompt replacement and deny-over-warn tool reduction", () => {
		const low = validateRequestMutationHookOutput(prompt("low"), "beforePrompt", promptRequest)!;
		const high = validateRequestMutationHookOutput(prompt("high"), "beforePrompt", promptRequest)!;
		const promptResult = reducePromptShape([
			{ source: source("z-pack", 1), proposal: low as any },
			{ source: source("a-pack", 2), proposal: high as any },
		]);
		expect(promptResult).toMatchObject({ action: "replace", text: "high", source: { packId: "a-pack" } });

		const warning = validateRequestMutationHookOutput(tool("warn"), "beforeToolCall", toolRequest)!;
		const denial = validateRequestMutationHookOutput(tool("deny"), "beforeToolCall", toolRequest)!;
		const toolResult = reduceToolSafety([
			{ source: source("higher-warning", 10), proposal: warning as any },
			{ source: source("lower-deny", 1), proposal: denial as any },
		]);
		expect(toolResult).toMatchObject({ action: "deny", reason: "Tool denied", source: { packId: "lower-deny" } });
	});

	it("uses code-unit source ties regardless of input order", () => {
		const firstPrompt = validateRequestMutationHookOutput(prompt("hyphen"), "beforePrompt", promptRequest)!;
		const secondPrompt = validateRequestMutationHookOutput(prompt("period"), "beforePrompt", promptRequest)!;
		const promptCandidates = [
			{ source: { packId: "pack-2", hookId: "hook", priority: 4 }, proposal: firstPrompt as any },
			{ source: { packId: "pack.1", hookId: "hook", priority: 4 }, proposal: secondPrompt as any },
		];
		for (const candidates of [promptCandidates, [...promptCandidates].reverse()]) {
			expect(reducePromptShape(candidates)).toMatchObject({ action: "replace", text: "hyphen", source: { packId: "pack-2" } });
		}

		const firstDeny = validateRequestMutationHookOutput(tool("deny"), "beforeToolCall", toolRequest)!;
		const secondDeny = validateRequestMutationHookOutput(tool("deny"), "beforeToolCall", toolRequest)!;
		const toolCandidates = [
			{ source: { packId: "pack", hookId: "hook-2", priority: 4 }, proposal: firstDeny as any },
			{ source: { packId: "pack", hookId: "hook.1", priority: 4 }, proposal: secondDeny as any },
		];
		for (const candidates of [toolCandidates, [...toolCandidates].reverse()]) {
			expect(reduceToolSafety(candidates)).toMatchObject({ action: "deny", source: { hookId: "hook-2" } });
		}
	});

	it("never manufactures a replacement or tool permission without a candidate", () => {
		expect(reducePromptShape([])).toEqual({ action: "pass", reason: "Unavailable" });
		expect(reduceToolSafety([])).toEqual({ action: "pass", reason: "Unavailable" });
		expect(() => validateRequestMutationProposal(Object.create({ kind: "prompt-shape" }), "beforePrompt", promptRequest)).toThrow(RequestMutationContractError);
	});
});
