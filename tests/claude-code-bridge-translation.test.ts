import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeStreamLimitError, ClaudeCodeStreamTranslator } from "../src/server/agent/claude-code-stream.ts";

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

		const user = out.find((event) => event.type === "message_end" && event.message.role === "user");
		assert.equal(user?.message.content[0].text, "Hello");

		const updates = out.filter((event) => event.type === "message_update");
		assert.equal(updates.length, 2);
		assert.equal(updates[0].message.content[0].text, "Hi ");
		assert.equal(updates[1].message.content[0].text, "Hi there");

		const assistantEnd = out.find((event) => event.type === "message_end" && event.message.role === "assistant");
		assert.equal(assistantEnd?.message.content[0].text, "Hi there");
		assert.equal(assistantEnd?.message.stopReason, "stop");
		assert.deepEqual(assistantEnd?.message.usage, { input_tokens: 10, output_tokens: 2 });
		assert.equal(assistantEnd?.message.cost.totalUsd, 0.001);

		const end = out.find((event) => event.type === "agent_end");
		assert.equal(end?.stopReason, "stop");
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
