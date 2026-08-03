// v2-native — Offline translator contract. Listed in tests-map.json `v2Native`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	createClaudeSdkTranslatorState,
	translateClaudeSdkEvent,
	type ClaudeSdkTranslation,
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

function feed(inputs: readonly unknown[]): { state: unknown; events: Event[]; diagnostics: Event[] } {
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

		for (const terminalKey of ["resultSuccess", "resultError", "assistantAbort"] as const) {
			const { events, diagnostics } = feed([...beforeToolResult, terminal[terminalKey]]);
			expect(diagnostics).toEqual([]);
			const danglingResult = eventIndex(events, (event) => messageWithRole(event, "toolResult"));
			const danglingEnd = eventIndex(events, (event) => event.type === "tool_execution_end");
			const agentEnd = eventIndex(events, (event) => event.type === "agent_end");
			expect(danglingResult).toBeLessThan(danglingEnd);
			expect(danglingEnd).toBeLessThan(agentEnd);
			expect(events[danglingEnd]).toMatchObject({ toolCallId: "tool-root-1", isError: true });
			expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		}
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
		expect(() => translateClaudeSdkEvent(permission.state, record.permissionDenied)).not.toThrow();
		expect(permission.diagnostics.every((diagnostic) => typeof diagnostic.detail === "string" && diagnostic.detail.length <= 500)).toBe(true);

		const cyclic: Event = { type: "stream_event", parent_tool_use_id: "child-cyclic" };
		cyclic.event = cyclic;
		expect(() => translateClaudeSdkEvent(permission.state, cyclic)).not.toThrow();
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
