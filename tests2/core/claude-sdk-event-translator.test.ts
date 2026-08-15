// v2-native — Offline translator contract. Listed in tests-map.json `v2Native`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	createClaudeSdkTranslatorState,
	normalizeClaudeSdkRootResultUsage,
	translateClaudeSdkEvent,
	type ClaudeSdkTranslation,
	type ClaudeSdkTranslatorState,
} from "../../src/server/agent/claude-sdk-event-translator.ts";

type FixtureRecord = Record<string, unknown>;
type Event = Record<string, unknown>;

const FIXTURE_ROOT = fileURLToPath(
	new URL("../fixtures/claude-sdk-event-translator/", import.meta.url),
);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function fixture(name: string): FixtureRecord {
	return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, name), "utf8")) as FixtureRecord;
}

function fixtureMessages(record: FixtureRecord): readonly unknown[] {
	expect(record.fixtureSchema).toBe("claude-sdk-event-translator/v1");
	expect(record.provenance).toMatchObject({
		kind: "hand-authored captured-shape record",
		source: "@anthropic-ai/claude-agent-sdk published declarations",
		sdkVersion: "0.3.220",
	});
	expect(record.messages).toBeInstanceOf(Array);
	return record.messages as readonly unknown[];
}

function feed(inputs: readonly unknown[]): { state: ClaudeSdkTranslatorState; events: Event[]; diagnostics: Event[] } {
	let state = createClaudeSdkTranslatorState();
	const events: Event[] = [];
	const diagnostics: Event[] = [];
	for (const input of inputs) {
		const result = translateClaudeSdkEvent(state, input) as ClaudeSdkTranslation;
		state = result.state;
		events.push(...(result.events as unknown as Event[]));
		diagnostics.push(...(result.diagnostics as unknown as Event[]));
	}
	return { state, events, diagnostics };
}

function eventIndex(events: readonly Event[], predicate: (event: Event) => boolean): number {
	const index = events.findIndex(predicate);
	expect(index).toBeGreaterThanOrEqual(0);
	return index;
}

function messageWithRole(event: Event, role: string): boolean {
	return event.type === "message_end"
		&& !!event.message
		&& typeof event.message === "object"
		&& (event.message as Event).role === role;
}

function textInMessage(event: Event, text: string): boolean {
	const content = (event.message as Event | undefined)?.content;
	return Array.isArray(content) && content.some((block) =>
		!!block && typeof block === "object" && (block as Event).text === text,
	);
}

describe("Claude Agent SDK event translator", () => {
	it("translates captured text, thinking, tool use, and matching tool result in Pi lifecycle order", () => {
		const record = fixture("root-tool-lifecycle.json");
		const { events, diagnostics } = feed(fixtureMessages(record));

		expect(diagnostics).toEqual([]);
		const assistantEnd = eventIndex(events, (event) => messageWithRole(event, "assistant"));
		const toolStart = eventIndex(events, (event) => event.type === "tool_execution_start");
		const toolResult = eventIndex(events, (event) => messageWithRole(event, "toolResult"));
		const toolEnd = eventIndex(events, (event) => event.type === "tool_execution_end");
		expect(assistantEnd).toBeLessThan(toolStart);
		expect(toolStart).toBeLessThan(toolResult);
		expect(toolResult).toBeLessThan(toolEnd);
		expect(events[toolStart]).toMatchObject({ toolCallId: "tool-root-1" });
		expect(events[toolResult]).toMatchObject({ message: { toolCallId: "tool-root-1" } });
		expect(events[toolEnd]).toMatchObject({ toolCallId: "tool-root-1", isError: false });

		const updates = events.filter((event) => event.type === "message_update");
		expect(updates.some((event) => textInMessage(event, "I will inspect it."))).toBe(true);
		expect(updates.some((event) => {
			const content = (event.message as Event | undefined)?.content;
			return Array.isArray(content) && content.some((block) =>
				!!block && typeof block === "object" && (block as Event).type === "thinking",
			);
		})).toBe(true);
	});

	it("partitions interleaved root and child frames before UUID, message, or tool accumulation", () => {
		const record = fixture("interleaved-subagents.json");
		const { events, diagnostics } = feed(fixtureMessages(record));

		expect(diagnostics).toEqual([]);
		const childA = events.filter((event) => event.parentToolUseId === "parent-tool-a");
		const childB = events.filter((event) => event.parentToolUseId === "parent-tool-b");
		const root = events.filter((event) => event.parentToolUseId === undefined);
		expect(childA.length).toBeGreaterThan(0);
		expect(childB.length).toBeGreaterThan(0);
		expect(root.length).toBeGreaterThan(0);
		expect(childA.every((event) => event.parentToolUseId === "parent-tool-a")).toBe(true);
		expect(childB.every((event) => event.parentToolUseId === "parent-tool-b")).toBe(true);
		expect(childA.some((event) => textInMessage(event, "child A continued"))).toBe(true);
		expect(root.some((event) => textInMessage(event, "root only"))).toBe(true);

		const childAssistantEnd = eventIndex(childB, (event) => messageWithRole(event, "assistant"));
		const childToolStart = eventIndex(childB, (event) => event.type === "tool_execution_start");
		const childToolResult = eventIndex(childB, (event) => messageWithRole(event, "toolResult"));
		const childToolEnd = eventIndex(childB, (event) => event.type === "tool_execution_end");
		expect(childAssistantEnd).toBeLessThan(childToolStart);
		expect(childToolStart).toBeLessThan(childToolResult);
		expect(childToolResult).toBeLessThan(childToolEnd);
		expect(childB[childToolStart]).toMatchObject({ toolCallId: "child-tool-b" });
		expect(childB[childToolEnd]).toMatchObject({ toolCallId: "child-tool-b", isError: false });
	});

	it("atomically drains dangling tools and emits one root agent end for terminal success, error, and abort forms", () => {
		const root = fixture("root-tool-lifecycle.json");
		const terminal = fixture("terminal-and-permission.json");
		const beforeToolResult = fixtureMessages(root).slice(0, -1);

		for (const terminalKey of ["resultSuccess", "resultError", "resultAbort", "assistantAbort", "assistantError"] as const) {
			const { events, diagnostics } = feed([...beforeToolResult, terminal[terminalKey]]);
			expect(diagnostics).toEqual([]);
			const danglingResult = eventIndex(events, (event) => messageWithRole(event, "toolResult"));
			const danglingEnd = eventIndex(events, (event) => event.type === "tool_execution_end");
			const agentEnd = eventIndex(events, (event) => event.type === "agent_end");
			expect(danglingResult).toBeLessThan(danglingEnd);
			expect(danglingEnd).toBeLessThan(agentEnd);
			expect(events[danglingEnd]).toMatchObject({ toolCallId: "tool-root-1", isError: true });
			expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
			if (terminalKey !== "resultSuccess") {
				expect(events[agentEnd]).toMatchObject({ claudeSdk: { terminal: { error: expect.any(String) } } });
			}
		}
	});

	it("carries only a valid root result's authoritative usage on root agent_end", () => {
		const rootResult = {
			type: "result", subtype: "success", uuid: "result-usage-1", session_id: "sdk-session-usage-1",
			total_cost_usd: 0.0042,
			usage: { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 },
			modelUsage: {
				"claude-sonnet-4": {
					inputTokens: 121, outputTokens: 43, cacheReadInputTokens: 10, cacheCreationInputTokens: 2,
					costUSD: 0.004, contextWindow: 200_000, maxOutputTokens: 16_384,
				},
				"claude-haiku-4": {
					inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
					costUSD: 0.0002, contextWindow: 200_000, maxOutputTokens: 8_192,
				},
			},
		};
		let state = translateClaudeSdkEvent(createClaudeSdkTranslatorState(), {
			type: "assistant", uuid: "root-assistant-usage", message: {
				model: "claude-sonnet-4",
				usage: { input_tokens: 150, cache_read_input_tokens: 10, cache_creation_input_tokens: 10 },
				content: [{ type: "text", text: "root" }],
			},
		}).state;
		// A child may report a different model and usage, but it is not root context.
		state = translateClaudeSdkEvent(state, {
			type: "assistant", parent_tool_use_id: "child-tool", uuid: "child-assistant-usage", message: {
				model: "claude-haiku-4",
				usage: { input_tokens: 9_999, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 },
				content: [{ type: "text", text: "child" }],
			},
		}).state;
		const translated = translateClaudeSdkEvent(state, rootResult);
		expect(translated.diagnostics).toEqual([]);
		expect(translated.events).toEqual([expect.objectContaining({
			type: "agent_end",
			claudeSdkUsage: {
				source: "claude-agent-sdk-result",
				sourceResultId: "sdk-session-usage-1:result-usage-1",
				sdkSessionId: "sdk-session-usage-1",
				costBasis: "subscription-notional",
				total: { inputTokens: 123, outputTokens: 45, cacheReadTokens: 10, cacheWriteTokens: 2, notionalCostUsd: 0.0042 },
				modelUsage: expect.objectContaining({
					// Raw root request usage is authoritative, even above its declared window.
					"claude-sonnet-4": expect.objectContaining({ inputTokens: 121, contextWindow: 200_000, maxOutputTokens: 16_384, contextTokens: 170, notionalCostUsd: 0.004 }),
					// The child model cannot overwrite root context or receive a synthetic value.
					"claude-haiku-4": expect.not.objectContaining({ contextTokens: expect.any(Number) }),
				}),
			},
		})]);

		const withoutRootAssistant = normalizeClaudeSdkRootResultUsage(rootResult);
		expect(withoutRootAssistant?.modelUsage["claude-sonnet-4"]).not.toHaveProperty("contextTokens");

		expect(normalizeClaudeSdkRootResultUsage({ ...rootResult, parent_tool_use_id: "parent-tool" })).toBeUndefined();
		expect(normalizeClaudeSdkRootResultUsage({ ...rootResult, uuid: "" })).toBeUndefined();
		expect(normalizeClaudeSdkRootResultUsage({ ...rootResult, usage: { input_tokens: 1 } })).toBeUndefined();
	});

	it("drains a child terminal locally while root tools and the root terminal remain live", () => {
		let state = createClaudeSdkTranslatorState();
		state = translateClaudeSdkEvent(state, {
			type: "assistant", uuid: "root-open", message: { content: [{ type: "tool_use", id: "root-tool", name: "Read", input: {} }], stop_reason: "tool_use" },
		}).state;
		state = translateClaudeSdkEvent(state, {
			type: "assistant", parent_tool_use_id: "child-parent", uuid: "child-open", message: { content: [{ type: "tool_use", id: "child-tool", name: "Bash", input: {} }], stop_reason: "tool_use" },
		}).state;

		const childAbort = translateClaudeSdkEvent(state, {
			type: "result", parent_tool_use_id: "child-parent", subtype: "error_during_execution", is_error: true, error: "child aborted",
		});
		expect(childAbort.diagnostics).toEqual([]);
		expect(childAbort.events).toEqual([
			expect.objectContaining({ type: "message_end", parentToolUseId: "child-parent", message: expect.objectContaining({ role: "toolResult", toolCallId: "child-tool", isError: true }) }),
			expect.objectContaining({ type: "tool_execution_end", parentToolUseId: "child-parent", toolCallId: "child-tool", isError: true }),
		]);
		expect(childAbort.events.some((event) => event.type === "agent_end")).toBe(false);

		const rootResult = translateClaudeSdkEvent(childAbort.state, {
			type: "user", message: { content: [{ type: "tool_result", tool_use_id: "root-tool", content: "root completed" }] },
		});
		expect(rootResult.diagnostics).toEqual([]);
		expect(rootResult.events).toEqual([
			expect.objectContaining({ type: "message_end", message: expect.objectContaining({ role: "toolResult", toolCallId: "root-tool", isError: false }) }),
			expect.objectContaining({ type: "tool_execution_end", toolCallId: "root-tool", isError: false }),
		]);

		const lateChild = translateClaudeSdkEvent(rootResult.state, {
			type: "stream_event", parent_tool_use_id: "child-parent", uuid: "child-late", event: { type: "message_start", message: { id: "child-late", content: [] } },
		});
		expect(lateChild.events).toEqual([]);
		expect(lateChild.diagnostics).toMatchObject([{ code: "late_event", partition: "child-parent" }]);

		const rootTerminal = translateClaudeSdkEvent(lateChild.state, { type: "result", subtype: "success" });
		expect(rootTerminal.events).toEqual([expect.objectContaining({ type: "agent_end" })]);
	});

	it("continues an independently partitioned child after the root terminal while rejecting late root traffic", () => {
		let state = createClaudeSdkTranslatorState();
		const rootTerminal = translateClaudeSdkEvent(state, { type: "result", subtype: "success" });
		state = rootTerminal.state;
		expect(rootTerminal.events.filter((event) => event.type === "agent_end")).toHaveLength(1);

		const childCall = translateClaudeSdkEvent(state, {
			type: "assistant", parent_tool_use_id: "active-agent-root", uuid: "child-read-call",
			message: { content: [{ type: "tool_use", id: "child-read", name: "Read", input: { path: "fixture.md" } }], stop_reason: "tool_use" },
		});
		state = childCall.state;
		expect(childCall.diagnostics).toEqual([]);
		expect(childCall.events).toEqual([
			expect.objectContaining({ type: "message_end", parentToolUseId: "active-agent-root" }),
			expect.objectContaining({ type: "tool_execution_start", parentToolUseId: "active-agent-root", toolCallId: "child-read" }),
		]);

		const childResult = translateClaudeSdkEvent(state, {
			type: "user", parent_tool_use_id: "active-agent-root", uuid: "child-read-result",
			message: { content: [{ type: "tool_result", tool_use_id: "child-read", content: "read result" }] },
		});
		state = childResult.state;
		expect(childResult.diagnostics).toEqual([]);
		expect(childResult.events).toEqual([
			expect.objectContaining({ type: "message_end", parentToolUseId: "active-agent-root", message: expect.objectContaining({ role: "toolResult", toolCallId: "child-read" }) }),
			expect.objectContaining({ type: "tool_execution_end", parentToolUseId: "active-agent-root", toolCallId: "child-read", isError: false }),
		]);

		const childTerminal = translateClaudeSdkEvent(state, { type: "result", parent_tool_use_id: "active-agent-root", subtype: "success" });
		expect(childTerminal.diagnostics).toEqual([]);
		expect(childTerminal.events).toEqual([]);
		expect(childTerminal.state.partitions.get("active-agent-root")?.terminated).toBe(true);

		const lateRoot = translateClaudeSdkEvent(childTerminal.state, { type: "assistant", uuid: "late-root", message: { content: [{ type: "text", text: "ignored" }] } });
		expect(lateRoot.events).toEqual([]);
		expect(lateRoot.diagnostics).toMatchObject([{ code: "late_event", partition: "root" }]);
	});

	it("makes duplicate and late frames no-ops without mutating prior state or input", () => {
		const messages = fixtureMessages(fixture("root-tool-lifecycle.json"));
		const initial = createClaudeSdkTranslatorState();
		const initialSnapshot = structuredClone(initial);
		const input = structuredClone(messages[5]);
		const inputSnapshot = structuredClone(input);

		const first = translateClaudeSdkEvent(initial, input);
		expect(initial).toEqual(initialSnapshot);
		expect(input).toEqual(inputSnapshot);
		expect(first.events.length).toBeGreaterThan(0);

		const duplicate = translateClaudeSdkEvent(first.state, input);
		expect(duplicate.events).toEqual([]);
		expect(duplicate.diagnostics.some((diagnostic) => diagnostic.code === "duplicate" || diagnostic.code === "late_event")).toBe(true);

		const terminal = fixture("terminal-and-permission.json").resultSuccess;
		const ended = translateClaudeSdkEvent(first.state, terminal);
		const late = translateClaudeSdkEvent(ended.state, input);
		expect(late.events).toEqual([]);
		expect(late.diagnostics).toMatchObject([{ code: "late_event" }]);
	});

	it("keeps public native-Agent progress frames outside transcript translation without diagnostics", () => {
		const state = createClaudeSdkTranslatorState();
		for (const event of [
			{ type: "system", subtype: "task_started", tool_use_id: "agent-root", subagent_type: "bobbit-backend-parity-reviewer" },
			{ type: "system", subtype: "task_progress", tool_use_id: "agent-root", subagent_type: "bobbit-backend-parity-reviewer" },
			{ type: "tool_progress", parent_tool_use_id: "agent-root", tool_use_id: "child-read" },
			{ type: "system", subtype: "task_notification", tool_use_id: "agent-root", status: "completed" },
		]) {
			const translated = translateClaudeSdkEvent(state, event);
			expect(translated.events).toEqual([]);
			expect(translated.diagnostics).toEqual([]);
		}
	});

	it("degrades unknown, malformed, permission-relevant, and cyclic input safely without fabricated identities", () => {
		const record = fixture("terminal-and-permission.json");
		const state = createClaudeSdkTranslatorState();
		const unknown = translateClaudeSdkEvent(state, record.unknownFuture);
		expect(unknown.events).toEqual([]);
		expect(unknown.diagnostics).toMatchObject([{ code: "unknown_kind" }]);

		const malformed = translateClaudeSdkEvent(unknown.state, { type: "assistant", parent_tool_use_id: "child-malformed", message: [] });
		expect(malformed.events).toEqual([]);
		expect(malformed.diagnostics).toMatchObject([{ code: "malformed", partition: "child-malformed" }]);

		const permission = translateClaudeSdkEvent(malformed.state, record.permissionDenied);
		expect(permission.diagnostics).toEqual([]);
		expect(permission.events).toMatchObject([{
			type: "message_end",
			message: { role: "toolResult", toolCallId: "permission-tool-1", toolName: "Bash", isError: true, timestamp: 1700000000000 },
		}]);
		const repeatedPermission = translateClaudeSdkEvent(permission.state, record.permissionDenied);
		expect(repeatedPermission.events).toEqual([]);
		expect(repeatedPermission.diagnostics).toMatchObject([{ code: "duplicate" }]);
		expect(permission.diagnostics.every((diagnostic) => typeof diagnostic.detail === "string" && diagnostic.detail.length <= 500)).toBe(true);

		const cyclic: Event = { type: "stream_event", parent_tool_use_id: "child-cyclic" };
		cyclic.event = cyclic;
		expect(() => translateClaudeSdkEvent(permission.state, cyclic)).not.toThrow();
	});

	it("emits declaration-conformant Pi event and message shapes", () => {
		const root = feed(fixtureMessages(fixture("root-tool-lifecycle.json"))).events;
		const stream = fixture("streamed-tool-input.json");
		const streamed = feed(stream.valid as readonly unknown[]).events;
		const permission = translateClaudeSdkEvent(createClaudeSdkTranslatorState(), fixture("terminal-and-permission.json").permissionDenied).events as unknown as Event[];
		for (const event of [...root, ...streamed, ...permission]) {
			if (event.type === "message_update") {
				expect(event.assistantMessageEvent).toBeTypeOf("object");
			}
			const message = event.message as Event | undefined;
			if (message?.role === "assistant") {
				expect(message).not.toHaveProperty("id");
				expect(message.timestamp).toBeTypeOf("number");
				expect(message.usage).toMatchObject({ input: expect.any(Number), output: expect.any(Number), totalTokens: expect.any(Number), cost: { total: expect.any(Number) } });
				expect(["stop", "length", "toolUse", "error", "aborted"]).toContain(message.stopReason);
				for (const block of message.content as Event[]) {
					if (block.type === "thinking") expect(block).not.toHaveProperty("signature");
					if (block.type === "toolCall") expect(block.arguments).toBeTypeOf("object");
				}
			}
			if (message?.role === "toolResult") {
				expect(message).toMatchObject({ toolCallId: expect.any(String), toolName: expect.any(String), timestamp: expect.any(Number), isError: expect.any(Boolean) });
			}
			if (event.type === "agent_end") expect(event).not.toHaveProperty("error");
		}
	});

	it("preserves repeated streaming deltas and parses tool JSON without leaking raw partial strings", () => {
		const repeat = {
			type: "stream_event", uuid: "repeat-1", session_id: "repeat",
			event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " " } },
		};
		let state = createClaudeSdkTranslatorState();
		state = translateClaudeSdkEvent(state, { type: "stream_event", uuid: "repeat-1", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }).state;
		const first = translateClaudeSdkEvent(state, repeat);
		const second = translateClaudeSdkEvent(first.state, repeat);
		expect(first.diagnostics).toEqual([]);
		expect(second.diagnostics).toEqual([]);
		expect(textInMessage(second.events[0] as unknown as Event, "  ")).toBe(true);

		const streamed = fixture("streamed-tool-input.json");
		for (const [name, inputs, expected] of [["valid", streamed.valid, { pattern: "*.ts" }], ["truncated", streamed.truncated, {}]] as const) {
			const { events, diagnostics } = feed(inputs as readonly unknown[]);
			expect(diagnostics, name).toEqual([]);
			const start = events.find((event) => event.type === "tool_execution_start");
			expect(start).toMatchObject({ args: expected });
			expect(JSON.stringify(events)).not.toContain("[object Object]");
		}
	});

	it("preserves declared redacted thinking and signature deltas and ignores plain user echoes", () => {
		const frames: unknown[] = [
			{ type: "stream_event", uuid: "thinking-1", event: { type: "message_start", message: { id: "thinking-message", role: "assistant", content: [] } } },
			{ type: "stream_event", uuid: "thinking-delta", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "reason", signature: "old" } } },
			{ type: "stream_event", uuid: "thinking-signature", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "new" } } },
			{ type: "stream_event", uuid: "thinking-redacted", event: { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } } },
		];
		const { events, diagnostics } = feed(frames);
		expect(diagnostics).toEqual([]);
		const last = events.at(-1) as Event;
		const blocks = (last.message as Event).content as Event[];
		expect(blocks).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "thinking", thinking: "reason", thinkingSignature: "new" }),
			expect.objectContaining({ type: "thinking", redacted: true, thinkingSignature: "opaque" }),
		]));
		const plainUser = translateClaudeSdkEvent(createClaudeSdkTranslatorState(), { type: "user", uuid: "plain-user", message: { role: "user", content: "hello" } });
		expect(plainUser.events).toEqual([]);
		expect(plainUser.diagnostics).toEqual([]);
	});

	it("keeps hostile parent, UUID, and tool identities structurally separate", () => {
		const childRootName = "__claude_sdk_root__";
		const inputs: unknown[] = [
			{ type: "assistant", uuid: "__proto__", message: { role: "assistant", content: [{ type: "text", text: "root" }], stop_reason: "end_turn" } },
			{ type: "assistant", parent_tool_use_id: childRootName, uuid: "__proto__", message: { role: "assistant", content: [{ type: "text", text: "child" }], stop_reason: "end_turn" } },
			{ type: "assistant", parent_tool_use_id: "constructor", uuid: "constructor", message: { role: "assistant", content: [{ type: "tool_use", id: "toString", name: "Read", input: {} }], stop_reason: "tool_use" } },
			{ type: "user", parent_tool_use_id: "constructor", uuid: "toString", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toString", content: "ok" }] } },
			...(["__proto__", "toString"] as const).map((parent_tool_use_id) => ({ type: "assistant", parent_tool_use_id, uuid: parent_tool_use_id, message: { role: "assistant", content: [{ type: "text", text: parent_tool_use_id }], stop_reason: "end_turn" } })),
		];
		expect(() => feed(inputs)).not.toThrow();
		const { events, diagnostics } = feed(inputs);
		expect(diagnostics).toEqual([]);
		expect(events.some((event) => event.parentToolUseId === childRootName && textInMessage(event, "child"))).toBe(true);
		expect(events.some((event) => event.parentToolUseId === undefined && textInMessage(event, "root"))).toBe(true);
		expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", toolCallId: "toString", parentToolUseId: "constructor" }));
	});

	it("reconciles all streamed assistant identities exactly once and suppresses late frames", () => {
		const messages = fixtureMessages(fixture("root-tool-lifecycle.json"));
		const streamedAndFinal = feed(messages.slice(0, 6));
		const assistantEnds = streamedAndFinal.events.filter((event) => messageWithRole(event, "assistant"));
		expect(assistantEnds).toHaveLength(1);
		expect(JSON.stringify(streamedAndFinal.events)).not.toContain("argumentsJson");

		for (const event of [
			{ type: "stream_event", uuid: "root-assistant-1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "late" } } },
			{ type: "stream_event", uuid: "late-envelope", event: { type: "content_block_delta", index: 0, message: { id: "root-model-message-1" }, delta: { type: "text_delta", text: "late" } } },
		]) {
			const late = translateClaudeSdkEvent(streamedAndFinal.state, event);
			expect(late.events).toEqual([]);
			expect(late.diagnostics).toMatchObject([{ code: "late_event" }]);
		}

		const terminal = translateClaudeSdkEvent(streamedAndFinal.state, fixture("terminal-and-permission.json").resultSuccess);
		expect(terminal.events.filter((event) => messageWithRole(event as unknown as Event, "assistant"))).toHaveLength(0);

		const twoMessages = feed([
			{ type: "stream_event", uuid: "envelope-1", event: { type: "message_start", message: { id: "model-1", content: [] } } },
			{ type: "assistant", uuid: "envelope-1", message: { id: "model-1", content: [{ type: "text", text: "one" }] } },
			{ type: "stream_event", uuid: "envelope-2", event: { type: "message_start", message: { id: "model-2", content: [] } } },
			{ type: "assistant", uuid: "envelope-2", message: { id: "model-2", content: [{ type: "text", text: "two" }] } },
			fixture("terminal-and-permission.json").resultSuccess,
		]);
		expect(twoMessages.events.filter((event) => messageWithRole(event, "assistant"))).toHaveLength(2);
		const partitionPartials = [...((twoMessages.state as unknown as { partitions: ReadonlyMap<unknown, { partials: ReadonlyMap<unknown, unknown> }> }).partitions.values())]
			.reduce((total, partition) => total + partition.partials.size, 0);
		expect(partitionPartials).toBe(0);
	});

	it("keeps stream updates monotonic and maps normalized content indexes", () => {
		let state = createClaudeSdkTranslatorState();
		state = translateClaudeSdkEvent(state, { type: "stream_event", uuid: "stream", event: { type: "message_start", message: { id: "model", content: [] } } }).state;
		state = translateClaudeSdkEvent(state, { type: "stream_event", uuid: "stream", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "first" } } }).state;
		state = translateClaudeSdkEvent(state, { type: "stream_event", uuid: "stream", event: { type: "content_block_stop", index: 0 } }).state;
		for (const event of [
			{ type: "stream_event", uuid: "stream", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "replay" } } },
			{ type: "stream_event", uuid: "stream", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "late" } } },
		]) {
			const duplicate = translateClaudeSdkEvent(state, event);
			expect(duplicate.events).toEqual([]);
			expect(duplicate.diagnostics).toMatchObject([{ code: "duplicate" }]);
		}
		const usageOnly = translateClaudeSdkEvent(state, { type: "stream_event", uuid: "stream", event: { type: "message_delta", usage: { input_tokens: 2 } } });
		expect(usageOnly.events).toEqual([]);

		const normalized = feed([
			{ type: "stream_event", uuid: "indexes", event: { type: "content_block_start", index: 0, content_block: { type: "image", source: "unsupported" } } },
			{ type: "stream_event", uuid: "indexes", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "kept" } } },
		]);
		const update = normalized.events.at(-1) as Event;
		expect(update.assistantMessageEvent).toMatchObject({ type: "text_start", contentIndex: 0 });
	});

	it("completes every batched tool result in block order without synthetic failures", () => {
		const inputs: unknown[] = [
			{ type: "assistant", uuid: "parallel", message: { content: [
				{ type: "tool_use", id: "tool-one", name: "Read", input: { path: "one" } },
				{ type: "tool_use", id: "tool-two", name: "Glob", input: { pattern: "two" } },
			], stop_reason: "tool_use" } },
			{ type: "user", uuid: "parallel-results", message: { content: [
				{ type: "tool_result", tool_use_id: "tool-one", content: "one" },
				{ type: "tool_result", tool_use_id: "tool-two", content: "two", is_error: true },
			] } },
			fixture("terminal-and-permission.json").resultSuccess,
		];
		const { events, diagnostics } = feed(inputs);
		expect(diagnostics).toEqual([]);
		const ends = events.filter((event) => event.type === "tool_execution_end");
		expect(ends).toEqual([
			expect.objectContaining({ toolCallId: "tool-one", isError: false }),
			expect.objectContaining({ toolCallId: "tool-two", isError: true }),
		]);
		expect(JSON.stringify(events)).not.toContain("ended before a result was received");
	});

	it("remains an offline translator seam with no existing session setup or dispatch coupling", () => {
		const translator = readFileSync(
			path.join(REPOSITORY_ROOT, "src/server/agent/claude-sdk-event-translator.ts"),
			"utf8",
		);
		expect(translator).not.toMatch(/node:(?:child_process|fs|http|https|net)/);
		for (const file of ["src/server/agent/session-manager.ts", "src/server/agent/session-setup.ts"]) {
			const source = readFileSync(path.join(REPOSITORY_ROOT, file), "utf8");
			expect(source).not.toContain("claude-sdk-event-translator");
		}
	});
});
