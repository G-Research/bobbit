import { describe, expect, it } from "vitest";

import { readTerminalAssistantUsage } from "../../src/server/agent/turn-usage.ts";

const assistantEvent = (usage: unknown) => ({
	type: "message_end",
	message: { role: "assistant", usage },
});

describe("readTerminalAssistantUsage", () => {
	it("normalizes supported aliases and preserves a complete attribution pair", () => {
		expect(readTerminalAssistantUsage(assistantEvent({
		input: 10,
		outputTokens: 5,
		cacheRead: 3,
		cacheWriteTokens: 2,
		cost: { total: 0.42 },
	}), { provider: "anthropic", modelId: "claude-test" })).toEqual({
		telemetry: "known",
		inputTokens: 10,
		outputTokens: 5,
		cacheReadTokens: 3,
		cacheWriteTokens: 2,
		cost: 0.42,
		provider: "anthropic",
		modelId: "claude-test",
	});
	});

	it("keeps omitted cache telemetry unknown while preserving explicit zeroes", () => {
		expect(readTerminalAssistantUsage(assistantEvent({ input: 0, output: 0, cost: 0 }))).toEqual({
		telemetry: "known",
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
	});
		expect(readTerminalAssistantUsage(assistantEvent({ cacheRead: 0, cacheWrite: 0 }))).toEqual({
		telemetry: "known",
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	});
	});

	it("rejects missing usage and invalid fields without estimating values", () => {
		expect(readTerminalAssistantUsage({ type: "message_end", message: { role: "assistant" } })).toBeUndefined();
		expect(readTerminalAssistantUsage({ type: "message_end", message: { role: "user", usage: {} } })).toBeUndefined();
		expect(readTerminalAssistantUsage(assistantEvent({
		inputTokens: -1,
		input: "not-a-number",
		output: Infinity,
		cacheRead: {},
		cacheWrite: NaN,
		cost: -0.1,
	}))).toEqual({ telemetry: "known" });
	});

	it("uses a finite fallback alias and omits partial attribution", () => {
		expect(readTerminalAssistantUsage(assistantEvent({
		inputTokens: Number.NaN,
		input: 12,
		cost: Number.POSITIVE_INFINITY,
	}), { provider: "openai" })).toEqual({
		telemetry: "known",
		inputTokens: 12,
	});
	});
});
