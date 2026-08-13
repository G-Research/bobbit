import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	applyClaudeSdkSubagentWorkFrame,
	projectClaudeSdkSubagentSnapshot,
	type ClaudeSdkEmbeddedWork,
} from "../../src/app/claude-sdk-subagent-work.ts";
import { initialState, reduce } from "../../src/app/message-reducer.ts";

describe("Claude SDK embedded client projection", () => {
	it("keeps interleaved children under exact parents with local tool lifecycle and replay replacement", () => {
		let work = new Map<string, ClaudeSdkEmbeddedWork>();
		work = applyClaudeSdkSubagentWorkFrame(work, {
			type: "claude_sdk_subagent_work", parentToolUseId: "agent-1", kind: "start",
			identity: { parentToolUseId: "agent-1", agentId: "child-a", agentType: "research" }, at: 10,
		});
		work = applyClaudeSdkSubagentWorkFrame(work, {
			type: "claude_sdk_subagent_work", parentToolUseId: "agent-2", kind: "start",
			identity: { parentToolUseId: "agent-2", agentId: "child-b", agentType: "coder" }, at: 11,
		});
		// A pre-semantic bridge frame uses the exact parent id too; it follows the
		// same nested path instead of becoming root streaming prose.
		work = applyClaudeSdkSubagentWorkFrame(work, {
			type: "message_update", parentToolUseId: "agent-1",
			message: { id: "child-a-message", role: "assistant", timestamp: 20, content: [{ type: "text", text: "draft" }], usage: { cost: 0.4 } },
		});
		work = applyClaudeSdkSubagentWorkFrame(work, {
			type: "claude_sdk_subagent_work", parentToolUseId: "agent-2", kind: "tool_start",
			toolEvent: { toolCallId: "child-b-tool" },
		});
		// Replay replaces source UUID in place and retains opaque metadata verbatim.
		work = applyClaudeSdkSubagentWorkFrame(work, {
			type: "claude_sdk_subagent_work", parentToolUseId: "agent-1", kind: "message",
			message: { id: "child-a-message", role: "assistant", timestamp: 20, content: [{ type: "text", text: "complete" }], usage: { cost: 0.4 } },
		});
		work = applyClaudeSdkSubagentWorkFrame(work, {
			type: "claude_sdk_subagent_work", parentToolUseId: "agent-2", kind: "terminal",
			terminal: { phase: "error", error: "child-only failure" }, at: 30,
		});

		assert.equal(work.size, 2);
		assert.deepEqual(work.get("agent-1")?.messages.map((m) => m.id), ["child-a-message"]);
		assert.equal((work.get("agent-1")?.messages[0] as any).content[0].text, "complete");
		assert.equal((work.get("agent-1")?.messages[0] as any).usage.cost, 0.4);
		assert.deepEqual(work.get("agent-2")?.pendingToolCallIds, ["child-b-tool"]);
		assert.equal(work.get("agent-2")?.phase, "error");
		assert.equal(work.get("agent-1")?.phase, "running");
	});

	it("projects legacy parent rows before root snapshots and converges semantic snapshot work", () => {
		const projected = projectClaudeSdkSubagentSnapshot([
			{ id: "root", role: "assistant", content: [{ type: "text", text: "root prose" }] },
			{ id: "late-child", role: "assistant", parentToolUseId: "agent-late", timestamp: 3, content: [{ type: "text", text: "hidden child prose" }] },
		], {
			"agent-1": {
				parentToolUseId: "agent-1", phase: "completed", agentId: "child-a",
				messages: [{ id: "recovered", role: "assistant", timestamp: 2, content: [{ type: "text", text: "recovered" }] }],
				pendingToolCallIds: [],
			},
		});

		assert.deepEqual(projected.rootMessages.map((message: any) => message.id), ["root"]);
		assert.deepEqual(projected.subagentWorkByParent.get("agent-late")?.messages.map((m) => m.id), ["late-child"]);
		assert.equal(projected.subagentWorkByParent.get("agent-1")?.phase, "completed");

		const rootReducer = reduce(initialState(), {
			type: "snapshot",
			messages: [
				...projected.rootMessages,
				{ id: "must-not-leak", role: "assistant", parentToolUseId: "agent-late", content: [{ type: "text", text: "child" }] },
			],
		});
		assert.deepEqual(rootReducer.messages.map((message) => message.id), ["root"]);
	});
});
