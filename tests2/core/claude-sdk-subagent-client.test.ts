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

	it("keeps a live exact-parent terminal during an unknown snapshot, but lets an explicit terminal replace it", () => {
		let work = new Map<string, ClaudeSdkEmbeddedWork>();
		work = applyClaudeSdkSubagentWorkFrame(work, {
			type: "claude_sdk_subagent_work", parentToolUseId: "agent-a", kind: "start", at: 10,
			identity: { parentToolUseId: "agent-a", agentId: "live-child", agentType: "reviewer" },
		});
		work = applyClaudeSdkSubagentWorkFrame(work, {
			type: "claude_sdk_subagent_work", parentToolUseId: "agent-a", kind: "tool_start",
			toolEvent: { toolCallId: "unsettled-live-tool" },
		});
		work = applyClaudeSdkSubagentWorkFrame(work, {
			type: "claude_sdk_subagent_work", parentToolUseId: "agent-a", kind: "terminal", at: 50,
			terminal: { phase: "error", error: "Subagent failed" },
		});
		const wrongPartition = projectClaudeSdkSubagentSnapshot([], {
			"agent-a": { parentToolUseId: "agent-b", phase: "completed", messages: [], pendingToolCallIds: [] },
		}, work).subagentWorkByParent.get("agent-a");
		assert.equal(wrongPartition?.phase, "error");

		const unknownRefresh = projectClaudeSdkSubagentSnapshot([], {
			"agent-a": {
				parentToolUseId: "agent-a", phase: "unknown", startedAt: 20,
				identities: [
					{ parentToolUseId: "agent-a", agentId: "recovered-child", agentType: "researcher" },
					{ parentToolUseId: "agent-b", agentId: "must-not-cross-parent", agentType: "wrong" },
				],
				messages: [{ id: "recovered-row", parentToolUseId: "agent-a", timestamp: 25, usage: { cost: 0.1 } }],
				pendingToolCallIds: ["stale-refresh-tool"],
			},
		}, work);
		const retained = unknownRefresh.subagentWorkByParent.get("agent-a");
		assert.equal(retained?.phase, "error");
		assert.equal(retained?.error, "Subagent failed");
		assert.equal(retained?.startedAt, 10);
		assert.equal(retained?.stoppedAt, 50);
		assert.deepEqual(retained?.identities?.map((identity) => identity.agentId), ["live-child", "recovered-child"]);
		assert.deepEqual(retained?.pendingToolCallIds, []);
		assert.deepEqual(retained?.messages.map((message) => message.id), ["recovered-row"]);

		const explicitTerminal = projectClaudeSdkSubagentSnapshot([], {
			"agent-a": {
				parentToolUseId: "agent-a", phase: "completed", stoppedAt: 60,
				messages: [{ id: "authoritative-row", parentToolUseId: "agent-a", timestamp: 60 }],
				pendingToolCallIds: ["must-close"],
			},
		}, unknownRefresh.subagentWorkByParent).subagentWorkByParent.get("agent-a");
		assert.equal(explicitTerminal?.phase, "completed");
		assert.equal(explicitTerminal?.error, undefined);
		assert.equal(explicitTerminal?.stoppedAt, 60);
		assert.deepEqual(explicitTerminal?.pendingToolCallIds, []);
		assert.deepEqual(explicitTerminal?.messages.map((message) => message.id), ["authoritative-row"]);
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
