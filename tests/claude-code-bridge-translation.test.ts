import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeStreamLimitError, ClaudeCodeStreamTranslator, normalizeClaudeCodeTiming, normalizeClaudeCodeUsage } from "../src/server/agent/claude-code-stream.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures", "claude-code", "streams");

function fixtureEvents(name: string): any[] {
	return fs.readFileSync(path.join(fixturesDir, name), "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line));
}

function translateAll(events: any[]) {
	const translator = new ClaudeCodeStreamTranslator(undefined, { messageIdPrefix: "test" });
	const out = events.flatMap((event) => translator.translate(event));
	return { out, state: translator.state };
}

describe("Claude Code stream translation", () => {
	it("maps system init, user echo, assistant chunks, and success result", () => {
		const { out, state } = translateAll(fixtureEvents("basic-text.jsonl"));

		assert.equal(state.claudeCodeSessionId, "claude-sess-1");
		const start = out.find((event) => event.type === "agent_start");
		assert.equal(start?.runtime, "claude-code");
		assert.equal(start?.claudeCodeSessionId, "claude-sess-1");
		assert.equal(start?.model.id, "local-claude-sonnet-4-6");

		const user = out.find((event) => event.type === "message_end" && event.message.role === "user");
		assert.equal(user?.message.content[0].text, "Hello");
		assert.equal(typeof user?.message.timestamp, "number");

		const updates = out.filter((event) => event.type === "message_update");
		assert.equal(updates.length, 2);
		assert.equal(updates[0].message.content[0].text, "Hi ");
		assert.equal(updates[1].message.content[0].text, "Hi there");
		assert.equal(typeof updates[0].message.timestamp, "number");

		const assistantEnd = out.find((event) => event.type === "message_end" && event.message.role === "assistant");
		assert.equal(assistantEnd?.message.content[0].text, "Hi there");
		assert.equal(typeof assistantEnd?.message.timestamp, "number");
		assert.equal(assistantEnd?.message.stopReason, "stop");
		assert.deepEqual(assistantEnd?.message.usage, {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		});
		assert.deepEqual(assistantEnd?.message.rawClaudeUsage, { input_tokens: 10, output_tokens: 2 });
		assert.equal(assistantEnd?.message.cost.totalUsd, 0.001);

		const end = out.find((event) => event.type === "agent_end");
		assert.equal(end?.stopReason, "stop");
		assert.deepEqual(end?.usage, assistantEnd?.message.usage);
	});

	it("normalizes reported Claude Code snake_case result usage", () => {
		const { out, state } = translateAll(fixtureEvents("reported-transcript-usage.jsonl"));
		const rawUsage = {
			input_tokens: 301,
			cache_creation_input_tokens: 6415,
			cache_read_input_tokens: 13231,
			output_tokens: 77,
			server_tool_use: { web_search_requests: 0 },
			service_tier: "standard",
		};
		const expectedUsage = {
			input: 301,
			output: 77,
			cacheRead: 13231,
			cacheWrite: 6415,
			totalTokens: 20024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		assert.deepEqual(normalizeClaudeCodeUsage(rawUsage), expectedUsage);
		assert.deepEqual(state.lastUsage, expectedUsage);

		const assistantEnd = out.filter((event) => event.type === "message_end" && event.message.role === "assistant").at(-1);
		assert.equal(assistantEnd?.message.content[0].text, "The file contains Bobbit project notes.");
		assert.deepEqual(assistantEnd?.message.usage, expectedUsage);
		assert.deepEqual(assistantEnd?.usage, expectedUsage);
		assert.deepEqual(assistantEnd?.message.rawClaudeUsage, rawUsage);
		assert.equal(assistantEnd?.message.usage.cost.total, 0);

		const agentEnd = out.find((event) => event.type === "agent_end");
		assert.deepEqual(agentEnd?.usage, expectedUsage);
		assert.deepEqual(agentEnd?.rawClaudeUsage, rawUsage);

		const toolStart = out.find((event) => event.type === "tool_execution_start");
		assert.equal(toolStart?.toolName, "Read");
		assert.deepEqual(toolStart?.input, { file_path: "README.md" });
		const toolResultMessage = out.find((event) => event.type === "message_end" && event.message.role === "toolResult");
		assert.equal(toolResultMessage?.message.toolCallId, "toolu_reported_1");
		assert.equal(toolResultMessage?.message.toolName, "Read");
		assert.deepEqual(toolResultMessage?.message.content, [{ type: "text", text: "# README\nBobbit project notes" }]);
	});

	it("maps tool_use and tool_result to renderable tool events", () => {
		const { out, state } = translateAll(fixtureEvents("tool-use.jsonl"));

		const toolStart = out.find((event) => event.type === "tool_execution_start");
		assert.equal(toolStart?.id, "toolu_1");
		assert.equal(toolStart?.toolCallId, "toolu_1");
		assert.equal(toolStart?.toolId, "toolu_1");
		assert.equal(toolStart?.toolName, "Read");
		assert.deepEqual(toolStart?.input, { file_path: "README.md" });
		assert.deepEqual(toolStart?.arguments, { file_path: "README.md" });

		const toolUpdate = out.find((event) => event.type === "message_update" && event.message.content.some((block: any) => block.type === "toolCall"));
		const toolCall = toolUpdate?.message.content.find((block: any) => block.type === "toolCall");
		assert.equal(toolCall?.id, "toolu_1");
		assert.equal(toolCall?.toolCallId, "toolu_1");
		assert.equal(toolCall?.name, "Read");
		assert.deepEqual(toolCall?.arguments, { file_path: "README.md" });

		const toolEnd = out.find((event) => event.type === "tool_execution_end");
		assert.equal(toolEnd?.toolCallId, "toolu_1");
		assert.equal(toolEnd?.toolId, "toolu_1");
		assert.equal(toolEnd?.toolUseId, "toolu_1");
		assert.equal(toolEnd?.toolName, "Read");
		assert.equal(toolEnd?.result, "# README");
		assert.equal(toolEnd?.isError, false);

		const assistantToolMessage = out.find((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.content.some((block: any) => block.type === "toolCall"));
		assert.ok(assistantToolMessage?.message.content.some((block: any) => block.type === "toolCall" && block.id === "toolu_1"));

		const toolResultMessage = out.find((event) => event.type === "message_end" && event.message.role === "toolResult");
		assert.equal(toolResultMessage?.message.toolCallId, "toolu_1");
		assert.equal(toolResultMessage?.message.toolName, "Read");
		assert.equal(toolResultMessage?.message.isError, false);
		assert.deepEqual(toolResultMessage?.message.content, [{ type: "text", text: "# README" }]);

		const finalAssistant = out.filter((event) => event.type === "message_end" && event.message.role === "assistant").at(-1);
		assert.equal(finalAssistant?.message.content[0].text, "Done");
		assert.equal(finalAssistant?.message.content.some((block: any) => block.type === "toolCall"), false);
		assert.deepEqual(state.messages.map((message: any) => message.role), ["assistant", "toolResult", "assistant"]);
	});

	it("normalizes Claude Code ask-user tool_use to Bobbit ask_user_choices", () => {
		const translator = new ClaudeCodeStreamTranslator(undefined, { messageIdPrefix: "test" });
		const out = [
			...translator.translate({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{
						type: "tool_use",
						id: "toolu_ask_1",
						name: "AskUserQuestion",
						input: {
							questions: [{
								question: "Which runtime should I use?",
								header: "Runtime",
								multiSelect: true,
								options: [
									{ label: "Claude Code", description: "Use local Claude Code" },
									{ label: "Pi", description: "Use default Pi runtime" },
								],
							}],
						},
					}],
				},
			}),
			...translator.translate({
				type: "user",
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ask_1", content: "Answer questions?", is_error: true }] },
			}),
		];
		const expectedInput = {
			questions: [{
				question: "Which runtime should I use?",
				options: ["Claude Code", "Pi"],
				tab_label: "Runtime",
				multi: true,
			}],
		};

		const toolStart = out.find((event) => event.type === "tool_execution_start");
		assert.equal(toolStart?.toolName, "ask_user_choices");
		assert.equal(toolStart?.name, "ask_user_choices");
		assert.deepEqual(toolStart?.input, expectedInput);
		assert.deepEqual(toolStart?.arguments, expectedInput);

		const toolUpdate = out.find((event) => event.type === "message_update" && event.message.content.some((block: any) => block.type === "toolCall"));
		const toolCall = toolUpdate?.message.content.find((block: any) => block.type === "toolCall");
		assert.equal(toolCall?.name, "ask_user_choices");
		assert.deepEqual(toolCall?.input, expectedInput);
		assert.deepEqual(toolCall?.arguments, expectedInput);

		const postedStub = JSON.stringify({ status: "posted", tool_use_id: "toolu_ask_1" });
		const postedStubContent = [{ type: "text", text: postedStub }];
		const toolEnd = out.find((event) => event.type === "tool_execution_end");
		assert.equal(toolEnd?.toolCallId, "toolu_ask_1");
		assert.equal(toolEnd?.toolName, "ask_user_choices");
		assert.equal(toolEnd?.result, postedStub);
		assert.deepEqual(toolEnd?.content, postedStubContent);
		assert.equal(toolEnd?.isError, false);
		assert.equal(toolEnd?.error, undefined);
		const toolResultMessage = out.find((event) => event.type === "message_end" && event.message.role === "toolResult");
		assert.equal(toolResultMessage?.message.toolCallId, "toolu_ask_1");
		assert.equal(toolResultMessage?.message.toolName, "ask_user_choices");
		assert.equal(toolResultMessage?.message.isError, false);
		assert.equal(toolResultMessage?.message.error, undefined);
		assert.deepEqual(toolResultMessage?.message.content, postedStubContent);
		assert.deepEqual(JSON.parse(toolResultMessage?.message.content[0].text), { status: "posted", tool_use_id: "toolu_ask_1" });
	});

	it("converts normalized ask_user_choices tool_result placeholder text to posted stub", () => {
		const translator = new ClaudeCodeStreamTranslator(undefined, { messageIdPrefix: "test" });
		const out = [
			...translator.translate({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{
						type: "tool_use",
						id: "toolu_ask_normalized",
						name: "ask_user_choices",
						input: {
							questions: [{
								question: "Which area should we inspect?",
								options: ["Runtime", "UI"],
								tab_label: "Area",
							}],
						},
					}],
				},
			}),
			...translator.translate({
				type: "user",
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ask_normalized", content: "Answer questions?", is_error: true }] },
			}),
		];
		const postedStub = JSON.stringify({ status: "posted", tool_use_id: "toolu_ask_normalized" });
		const postedStubContent = [{ type: "text", text: postedStub }];
		const toolEnd = out.find((event) => event.type === "tool_execution_end");
		assert.equal(toolEnd?.toolName, "ask_user_choices");
		assert.equal(toolEnd?.result, postedStub);
		assert.deepEqual(toolEnd?.content, postedStubContent);
		assert.equal(toolEnd?.isError, false);
		assert.equal(toolEnd?.error, undefined);
		const toolResultMessage = out.find((event) => event.type === "message_end" && event.message.role === "toolResult");
		assert.equal(toolResultMessage?.message.toolName, "ask_user_choices");
		assert.equal(toolResultMessage?.message.isError, false);
		assert.equal(toolResultMessage?.message.error, undefined);
		assert.deepEqual(toolResultMessage?.message.content, postedStubContent);
	});

	it("maps Claude Code result timing to assistant messages and agent end", () => {
		const { out, state } = translateAll([
			{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
			{ type: "result", subtype: "success", session_id: "claude-timing", result: "Done", is_error: false, duration_ms: 4321, duration_api_ms: 3210 },
		]);
		const expectedTiming = { durationMs: 4321, apiDurationMs: 3210 };
		assert.deepEqual(normalizeClaudeCodeTiming({ duration_ms: 4321, duration_api_ms: 3210 }), expectedTiming);
		assert.deepEqual(state.lastTiming, expectedTiming);
		const assistantEnd = out.find((event) => event.type === "message_end" && event.message.role === "assistant");
		assert.equal(assistantEnd?.durationMs, 4321);
		assert.deepEqual(assistantEnd?.timing, expectedTiming);
		assert.equal(assistantEnd?.message.durationMs, 4321);
		assert.deepEqual(assistantEnd?.message.timing, expectedTiming);
		const agentEnd = out.find((event) => event.type === "agent_end");
		assert.equal(agentEnd?.durationMs, 4321);
		assert.deepEqual(agentEnd?.timing, expectedTiming);
	});

	it("preserves errored tool_result pairing", () => {
		const translator = new ClaudeCodeStreamTranslator(undefined, { messageIdPrefix: "test" });
		const out = [
			...translator.translate({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_error", name: "Bash", input: { command: "false" } }] } }),
			...translator.translate({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_error", content: "exit 1", is_error: true }] } }),
		];
		const toolEnd = out.find((event) => event.type === "tool_execution_end");
		assert.equal(toolEnd?.toolCallId, "toolu_error");
		assert.equal(toolEnd?.toolName, "Bash");
		assert.equal(toolEnd?.isError, true);
		assert.equal(toolEnd?.error, "exit 1");
		const toolResultMessage = out.find((event) => event.type === "message_end" && event.message.role === "toolResult");
		assert.equal(toolResultMessage?.message.toolCallId, "toolu_error");
		assert.equal(toolResultMessage?.message.isError, true);
	});

	it("preserves real ask_user_choices errors", () => {
		const translator = new ClaudeCodeStreamTranslator(undefined, { messageIdPrefix: "test" });
		const out = [
			...translator.translate({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_ask_error", name: "ask_user_choices", input: { questions: [] } }] } }),
			...translator.translate({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ask_error", content: "Widget failed", is_error: true }] } }),
		];
		const toolEnd = out.find((event) => event.type === "tool_execution_end");
		assert.equal(toolEnd?.toolName, "ask_user_choices");
		assert.equal(toolEnd?.isError, true);
		assert.equal(toolEnd?.error, "Widget failed");
		const toolResultMessage = out.find((event) => event.type === "message_end" && event.message.role === "toolResult");
		assert.equal(toolResultMessage?.message.isError, true);
		assert.deepEqual(toolResultMessage?.message.content, [{ type: "text", text: "Widget failed" }]);
	});

	it("maps error results to visible assistant error and agent_end", () => {
		const { out } = translateAll(fixtureEvents("error-result.jsonl"));

		const assistantEnd = out.find((event) => event.type === "message_end" && event.message.role === "assistant");
		assert.equal(assistantEnd?.message.stopReason, "error");
		assert.equal(assistantEnd?.message.errorMessage, "Claude Code authentication required");
		assert.equal(assistantEnd?.message.content[0].text, "Claude Code authentication required");

		const end = out.find((event) => event.type === "agent_end");
		assert.equal(end?.stopReason, "error");
		assert.equal(end?.error, "Claude Code authentication required");
	});

	it("ignores unknown event types without crashing", () => {
		const translator = new ClaudeCodeStreamTranslator();
		assert.deepEqual(translator.translate({ type: "future_event", payload: true }), []);
	});

	it("rejects oversized assistant content before retaining it", () => {
		const translator = new ClaudeCodeStreamTranslator(undefined, { maxContentCharsPerEvent: 12 });
		assert.throws(
			() => translator.translate({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "this is too long" }] } }),
			ClaudeCodeStreamLimitError,
		);
		assert.equal(translator.state.assistantText, "");
	});

	it("bounds live message retention", () => {
		const translator = new ClaudeCodeStreamTranslator(undefined, { maxStoredMessages: 2 });
		for (const text of ["one", "two", "three"]) {
			translator.translate({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
		}
		assert.deepEqual(translator.state.messages.map((message: any) => message.content[0].text), ["two", "three"]);
	});
});
