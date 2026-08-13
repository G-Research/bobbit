// v2-native — G10b exact-parent SDK child projection and recovery contract.
import { describe, expect, it, vi } from "vitest";

import {
	ClaudeSdkSubagentWorkAssembler,
	projectClaudeSdkEmbeddedWork,
} from "../../src/server/agent/claude-sdk-subagent-work.ts";
import type { ClaudeAgentSdkHistoryMessage } from "../../src/server/agent/claude-agent-sdk-history-adapter.ts";
import type { ClaudeAgentSdkSessionApi, SdkSessionMessage } from "../../src/server/agent/claude-agent-sdk-session-access.ts";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

function assistant(id: string, parentToolUseId: string | undefined, parentAgentId: string, content: unknown): ClaudeAgentSdkHistoryMessage {
	return {
		id, role: "assistant", content, timestamp: 1,
		...(parentToolUseId ? { parentToolUseId } : {}),
		parentAgentId,
		usage: { input: 9, cost: { total: 1.23 } },
	};
}

function recoverySdk(rowsByAgent: Record<string, SdkSessionMessage[]>): { sdk: ClaudeAgentSdkSessionApi; deps: { loadSdk: () => Promise<ClaudeAgentSdkSessionApi> } } {
	const sdk: ClaudeAgentSdkSessionApi = {
		getSessionInfo: vi.fn(async () => undefined),
		getSessionMessages: vi.fn(async () => []),
		listSubagents: vi.fn(async () => Object.keys(rowsByAgent)),
		getSubagentMessages: vi.fn(async (_sessionId, agentId) => rowsByAgent[agentId] ?? []),
	};
	return { sdk, deps: { loadSdk: async () => sdk } };
}

describe("Claude SDK embedded subagent work", () => {
	it("partitions interleaved children, preserves source metadata, ordering, and local tools", () => {
		const parentOne = "agent-use-1";
		const parentTwo = "agent-use-2";
		const root = assistant("root", undefined, "", [
			{ type: "toolCall", id: parentOne, name: "Agent", arguments: {} },
			{ type: "toolCall", id: parentTwo, name: "Agent", arguments: {} },
		]);
		const childOne = assistant("child-one", parentOne, "child-1", [{ type: "toolCall", id: "read-1", name: "Read", arguments: { path: "a" } }]);
		const childTwo = assistant("child-two", parentTwo, "child-2", [{ type: "text", text: "two" }]);
		const toolResult: ClaudeAgentSdkHistoryMessage = { id: "result-one", role: "toolResult", toolCallId: "read-1", toolName: "Read", content: [], parentToolUseId: parentOne, parentAgentId: "child-1" };

		const projection = projectClaudeSdkEmbeddedWork([root, childOne, childTwo, toolResult, childOne]);
		expect(projection.rootMessages).toEqual([root]);
		expect(projection.workByParent.get(parentOne)).toMatchObject({
			phase: "unknown",
			pendingToolCallIds: [],
			messages: [childOne, toolResult],
		});
		expect(projection.workByParent.get(parentOne)?.messages[0]).toBe(childOne);
		expect(projection.workByParent.get(parentTwo)?.messages).toEqual([childTwo]);
		expect(projection.diagnostics).toEqual([]);
	});

	it("keeps multiple verified identities under one exact parent and never settles root state", () => {
		const assembler = new ClaudeSdkSubagentWorkAssembler();
		assembler.setKnownParentToolUseIds(["agent-use"]);
		assembler.ingestLifecycle({ kind: "start", entry: { toolUseId: "agent-use", agentId: "child-1", agentType: "research" }, at: 10 });
		assembler.ingestLifecycle({ kind: "start", entry: { toolUseId: "agent-use", agentId: "child-2", agentType: "review" }, at: 11 });
		assembler.ingestLifecycle({ kind: "stop", entry: { toolUseId: "agent-use", agentId: "child-1", agentType: "research" }, at: 12 });
		assembler.ingestLifecycle({ kind: "aborted", entry: { toolUseId: "agent-use", agentId: "child-2", agentType: "review" }, at: 13 });

		const work = assembler.snapshot().get("agent-use")!;
		expect(work.identities).toEqual([
			{ parentToolUseId: "agent-use", agentId: "child-1", agentType: "research" },
			{ parentToolUseId: "agent-use", agentId: "child-2", agentType: "review" },
		]);
		expect(work.phase).toBe("aborted");
		expect(assembler.ingestLiveEvent({ type: "agent_end" })).toEqual([]);
	});

	it("converges replay by parent plus source id and isolates child tool lifecycle", () => {
		const assembler = new ClaudeSdkSubagentWorkAssembler();
		const row = assistant("same-source", "parent", "child", [{ type: "text", text: "first" }]);
		assembler.ingestMessage(row);
		assembler.ingestMessage({ ...row, content: [{ type: "text", text: "replacement" }] });
		assembler.ingestLiveEvent({ type: "tool_execution_start", parentToolUseId: "parent", toolCallId: "tool-1" });
		assembler.ingestLiveEvent({ type: "tool_execution_end", parentToolUseId: "parent", toolCallId: "tool-1" });

		const work = assembler.snapshot().get("parent")!;
		expect(work.messages).toHaveLength(1);
		expect(work.messages[0].content).toEqual([{ type: "text", text: "replacement" }]);
		expect(work.pendingToolCallIds).toEqual([]);
		expect(work.diagnostic).toBe("unknown-parent");
	});

	it("recovers only rows whose one exact parent matches, never inferring a parent from child ids", async () => {
		const parent = "agent-use";
		const fixture = recoverySdk({
			"child-good": [{
				type: "assistant", uuid: "good-row", session_id: SESSION_ID, parent_tool_use_id: parent, parent_agent_id: "child-good",
				message: { content: [{ type: "text", text: "recovered" }], stop_reason: "end_turn", usage: { cost_usd: 9 } },
			}],
			"child-wrong": [{
				type: "assistant", uuid: "wrong-row", session_id: SESSION_ID, parent_tool_use_id: "other-parent", parent_agent_id: "child-wrong",
				message: { content: [{ type: "text", text: "must stay hidden" }], stop_reason: "end_turn" },
			}],
		});
		const assembler = new ClaudeSdkSubagentWorkAssembler({ recovery: { sessionId: SESSION_ID, cwd: "/workspace", access: fixture.deps } });
		const [first, second] = await Promise.all([assembler.recover(parent), assembler.recover(parent)]);

		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		expect(fixture.sdk.listSubagents).toHaveBeenCalledTimes(1);
		const work = assembler.snapshot().get(parent)!;
		expect(work.messages.map(message => message.id)).toEqual(["good-row"]);
		expect(work.messages[0]).toMatchObject({ usage: expect.anything() });
		expect(work.diagnostic).toBe("recovery-mismatch");
		expect(assembler.snapshot().has("other-parent")).toBe(false);
	});
});
