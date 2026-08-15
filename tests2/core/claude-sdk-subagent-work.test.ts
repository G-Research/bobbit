// v2-native — G10b exact-parent SDK child projection and recovery contract.
import { describe, expect, it, vi } from "vitest";

import {
	ClaudeSdkSubagentWorkAssembler,
	MAX_RECOVERY_BYTES,
	MAX_RECOVERY_CONCURRENCY,
	MAX_RECOVERY_ROWS,
	projectClaudeSdkEmbeddedWork,
	recoverClaudeSdkEmbeddedWork,
} from "../../src/server/agent/claude-sdk-subagent-work.ts";
import { adaptSdkSessionMessages, type ClaudeAgentSdkHistoryMessage } from "../../src/server/agent/claude-agent-sdk-history-adapter.ts";
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

function recoverySdk(
	rowsByAgent: Record<string, SdkSessionMessage[]>,
	overrides: Partial<ClaudeAgentSdkSessionApi> = {},
): { sdk: ClaudeAgentSdkSessionApi; deps: { loadSdk: () => Promise<ClaudeAgentSdkSessionApi> } } {
	const sdk: ClaudeAgentSdkSessionApi = {
		getSessionInfo: vi.fn(async () => undefined),
		getSessionMessages: vi.fn(async () => []),
		listSubagents: vi.fn(async () => Object.keys(rowsByAgent)),
		getSubagentMessages: vi.fn(async (_sessionId, agentId) => rowsByAgent[agentId] ?? []),
		...overrides,
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

	it("derives durable root Agent/Task completion and safe failures by exact tool-result id", () => {
		const completedParent = "agent-completed";
		const failedParent = "task-failed";
		const unknownParent = "agent-unknown";
		const root = assistant("root", undefined, "", [
			{ type: "toolCall", id: completedParent, name: "Agent", arguments: {} },
			{ type: "toolCall", id: failedParent, name: "Task", arguments: {} },
			{ type: "toolCall", id: unknownParent, name: "Agent", arguments: {} },
		]);
		const child = assistant("child", failedParent, "child-1", [{ type: "text", text: "work" }]);
		// Use the adapter's actual Pi-shaped toolResult fields, rather than a
		// guessed SDK result envelope, for durable root terminal authority.
		const adapted = adaptSdkSessionMessages([
			{
				type: "assistant", uuid: "adapter-root", session_id: SESSION_ID, parent_tool_use_id: null, parent_agent_id: null,
				message: { model: "claude-test", content: [
					{ type: "tool_use", id: completedParent, name: "Agent", input: {} },
					{ type: "tool_use", id: failedParent, name: "Task", input: {} },
				], stop_reason: "tool_use" },
			},
			{
				type: "user", uuid: "root-completed", session_id: SESSION_ID, parent_tool_use_id: null, parent_agent_id: null,
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: completedParent, content: "completed", is_error: false }] },
			},
			{
				type: "user", uuid: "root-failed", session_id: SESSION_ID, parent_tool_use_id: null, parent_agent_id: null,
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: failedParent, content: "provider secret: /private/path", is_error: true }] },
			},
		]);
		const completed = adapted.find(row => row.role === "toolResult" && row.toolCallId === completedParent)!;
		const failed = adapted.find(row => row.role === "toolResult" && row.toolCallId === failedParent)!;
		expect(completed).toMatchObject({ role: "toolResult", toolCallId: completedParent, isError: false });
		expect(failed).toMatchObject({ role: "toolResult", toolCallId: failedParent, isError: true });
		const unrelated: ClaudeAgentSdkHistoryMessage = {
			id: "root-unrelated", role: "toolResult", toolCallId: "not-an-agent-call", toolName: "Read",
			isError: true, content: [], timestamp: 4,
		};

		const projection = projectClaudeSdkEmbeddedWork([root, child, completed, failed, unrelated]);
		expect(projection.workByParent.get(completedParent)).toMatchObject({ phase: "completed" });
		expect(projection.workByParent.get(completedParent)?.error).toBeUndefined();
		expect(projection.workByParent.get(failedParent)).toMatchObject({ phase: "error", error: "Subagent failed" });
		expect(JSON.stringify(projection.workByParent.get(failedParent))).not.toContain("provider secret");
		expect(projection.workByParent.get(unknownParent)).toBeUndefined();

		const childResult: ClaudeAgentSdkHistoryMessage = {
			id: "child-result", role: "toolResult", toolCallId: unknownParent, toolName: "Agent",
			parentToolUseId: unknownParent, parentAgentId: "child-2", isError: true, content: [], timestamp: 5,
		};
		const unknownProjection = projectClaudeSdkEmbeddedWork([
			root,
			assistant("unknown-child", unknownParent, "child-2", [{ type: "text", text: "still running" }]),
			childResult,
		]);
		expect(unknownProjection.workByParent.get(unknownParent)).toMatchObject({ phase: "unknown" });
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

	it("recovers a snapshot with one child listing, bounded concurrent limited reads, and a global row budget", async () => {
		const parent = "agent-use";
		const root = assistant("root", undefined, "", [{ type: "toolCall", id: parent, name: "Agent", arguments: {} }]);
		const ids = Array.from({ length: 32 }, (_, index) => `child-${index}`);
		let active = 0;
		let peakActive = 0;
		const getSubagentMessages = vi.fn(async (_sessionId: string, agentId: string, options?: { limit?: number }) => {
			active += 1;
			peakActive = Math.max(peakActive, active);
			await new Promise(resolve => setTimeout(resolve, 1));
			active -= 1;
			const count = (options?.limit ?? 0) + 1; // A provider ignoring the requested limit cannot exceed admission.
			return Array.from({ length: count }, (_, index): SdkSessionMessage => ({
				type: "assistant", uuid: `${agentId}-${index}`, session_id: SESSION_ID,
				parent_tool_use_id: parent, parent_agent_id: agentId,
				message: { content: [{ type: "text", text: "recovered" }], stop_reason: "end_turn" },
			}));
		});
		const fixture = recoverySdk({}, {
			listSubagents: vi.fn(async () => ids),
			getSubagentMessages,
		});

		const recovered = await recoverClaudeSdkEmbeddedWork([root], { sessionId: SESSION_ID, cwd: "/workspace", access: fixture.deps });

		expect(fixture.sdk.listSubagents).toHaveBeenCalledTimes(1);
		expect(getSubagentMessages).toHaveBeenCalledTimes(ids.length);
		expect(new Set(getSubagentMessages.mock.calls.map(([, agentId]) => agentId))).toEqual(new Set(ids));
		expect(peakActive).toBeLessThanOrEqual(MAX_RECOVERY_CONCURRENCY);
		const limits = getSubagentMessages.mock.calls.map(([, , options]) => options?.limit);
		expect(limits.every(limit => typeof limit === "number" && limit > 0)).toBe(true);
		expect(limits.reduce<number>((total, limit) => total + (limit ?? 0), 0)).toBeLessThanOrEqual(MAX_RECOVERY_ROWS);
		expect(recovered).toHaveLength(1 + MAX_RECOVERY_ROWS);
	});

	it("anchors recovered children at their immutable root parent boundary so later root rows preserve the snapshot prefix", async () => {
		const parent = "agent-use";
		const root = assistant("root-agent", undefined, "", [{ type: "toolCall", id: parent, name: "Agent", arguments: {} }]);
		const terminal: ClaudeAgentSdkHistoryMessage = {
			id: "root-agent-result", role: "toolResult", toolCallId: parent, toolName: "Agent", content: [], timestamp: 2,
		};
		const laterRoot = assistant("later-root", undefined, "", [{ type: "text", text: "later official root turn" }]);
		const fixture = recoverySdk({
			"child-1": [{
				type: "assistant", uuid: "recovered-child", session_id: SESSION_ID, parent_tool_use_id: parent, parent_agent_id: "child-1",
				message: { content: [{ type: "text", text: "recovered child work" }], stop_reason: "end_turn" },
			}],
		});
		const snapshotA = await recoverClaudeSdkEmbeddedWork([root, terminal], { sessionId: SESSION_ID, cwd: "/workspace", access: fixture.deps });
		const snapshotB = await recoverClaudeSdkEmbeddedWork([root, terminal, laterRoot], { sessionId: SESSION_ID, cwd: "/workspace", access: fixture.deps });

		// The recovered child is nested at its immutable root invocation, not
		// globally tailed behind later official history.
		expect(snapshotA.map(message => ({ id: message.id, role: message.role }))).toEqual([
			{ id: "root-agent", role: "assistant" },
			{ id: "recovered-child", role: "assistant" },
			{ id: "root-agent-result", role: "toolResult" },
		]);
		expect(snapshotB.slice(0, snapshotA.length).map(message => ({ id: message.id, role: message.role })))
			.toEqual(snapshotA.map(message => ({ id: message.id, role: message.role })));

		const projectedA = projectClaudeSdkEmbeddedWork(snapshotA);
		const projectedB = projectClaudeSdkEmbeddedWork(snapshotB);
		expect(projectedA.rootMessages.map(message => ({ id: message.id, role: message.role }))).toEqual([
			{ id: "root-agent", role: "assistant" },
			{ id: "root-agent-result", role: "toolResult" },
		]);
		expect(projectedB.rootMessages.slice(0, projectedA.rootMessages.length).map(message => ({ id: message.id, role: message.role })))
			.toEqual(projectedA.rootMessages.map(message => ({ id: message.id, role: message.role })));
		expect(projectedB.workByParent.get(parent)?.messages.map(message => message.id)).toEqual(["recovered-child"]);
	});

	it("preserves root and child partition prefixes as later recovery adds rows at exact parent boundaries", async () => {
		const firstParent = "agent-use-one";
		const secondParent = "agent-use-two";
		const firstRoot = assistant("root-first", undefined, "", [{ type: "toolCall", id: firstParent, name: "Agent", arguments: {} }]);
		const firstResult: ClaudeAgentSdkHistoryMessage = {
			id: "root-first-result", role: "toolResult", toolCallId: firstParent, toolName: "Agent", isError: false, content: [], timestamp: 2,
		};
		const laterRoot = assistant("root-later", undefined, "", [{ type: "toolCall", id: secondParent, name: "Task", arguments: {} }]);
		const laterResult: ClaudeAgentSdkHistoryMessage = {
			id: "root-later-result", role: "toolResult", toolCallId: secondParent, toolName: "Task", isError: false, content: [], timestamp: 4,
		};
		const firstChild: SdkSessionMessage = {
			type: "assistant", uuid: "child-one-first", session_id: SESSION_ID, parent_tool_use_id: firstParent, parent_agent_id: "child-one",
			message: { content: [{ type: "text", text: "first recovered child row" }], stop_reason: "end_turn" },
		};
		const laterFirstChild: SdkSessionMessage = {
			type: "assistant", uuid: "child-one-later", session_id: SESSION_ID, parent_tool_use_id: firstParent, parent_agent_id: "child-one",
			message: { content: [{ type: "text", text: "later row for the same root parent" }], stop_reason: "end_turn" },
		};
		const secondChild: SdkSessionMessage = {
			type: "assistant", uuid: "child-two-first", session_id: SESSION_ID, parent_tool_use_id: secondParent, parent_agent_id: "child-two",
			message: { content: [{ type: "text", text: "separate child partition" }], stop_reason: "end_turn" },
		};
		let recoverySnapshot: "A" | "B" = "A";
		const fixture = recoverySdk({}, {
			listSubagents: vi.fn(async () => recoverySnapshot === "A" ? ["child-one"] : ["child-one", "child-two"]),
			getSubagentMessages: vi.fn(async (_sessionId, agentId) => {
				if (agentId === "child-one") return recoverySnapshot === "A" ? [firstChild] : [firstChild, laterFirstChild];
				return agentId === "child-two" ? [secondChild] : [];
			}),
		});

		const snapshotA = await recoverClaudeSdkEmbeddedWork([firstRoot, firstResult], { sessionId: SESSION_ID, cwd: "/workspace", access: fixture.deps });
		recoverySnapshot = "B";
		const snapshotB = await recoverClaudeSdkEmbeddedWork([firstRoot, firstResult, laterRoot, laterResult], { sessionId: SESSION_ID, cwd: "/workspace", access: fixture.deps });
		const projectedA = projectClaudeSdkEmbeddedWork(snapshotA);
		const projectedB = projectClaudeSdkEmbeddedWork(snapshotB);
		const rootA = projectedA.rootMessages.map(message => ({ id: message.id, role: message.role }));
		const rootB = projectedB.rootMessages.map(message => ({ id: message.id, role: message.role }));
		const firstPartitionA = projectedA.workByParent.get(firstParent)?.messages ?? [];
		const firstPartitionB = projectedB.workByParent.get(firstParent)?.messages ?? [];

		expect(rootB.slice(0, rootA.length)).toEqual(rootA);
		expect(firstPartitionB.slice(0, firstPartitionA.length)).toEqual(firstPartitionA);
		expect(firstPartitionB.map(message => ({ id: message.id, role: message.role }))).toEqual([
			{ id: "child-one-first", role: "assistant" },
			{ id: "child-one-later", role: "assistant" },
		]);
		expect(projectedB.workByParent.get(secondParent)?.messages.map(message => message.id)).toEqual(["child-two-first"]);
		// Child rows stay under their immutable root invocation, rather than being
		// globally tailed after the later official root history.
		expect(snapshotB.map(message => message.id)).toEqual([
			"root-first", "child-one-first", "child-one-later", "root-first-result",
			"root-later", "child-two-first", "root-later-result",
		]);
		expect(projectedA.workByParent.get(firstParent)).toMatchObject({ phase: "completed" });
		expect(projectedB.workByParent.get(firstParent)).toMatchObject({ phase: "completed" });
	});

	it("keeps an unterminated recovered child before a later terminal and root tail", async () => {
		const parent = "agent-use-late-terminal";
		const root = assistant("root-agent", undefined, "", [{ type: "toolCall", id: parent, name: "Agent", arguments: {} }]);
		const terminal: ClaudeAgentSdkHistoryMessage = {
			id: "late-terminal", role: "toolResult", toolCallId: parent, toolName: "Agent", content: [], timestamp: 2,
		};
		const laterRoot = assistant("later-root", undefined, "", [{ type: "text", text: "later official root turn" }]);
		const fixture = recoverySdk({
			"child-1": [{
				type: "assistant", uuid: "recovered-child", session_id: SESSION_ID, parent_tool_use_id: parent, parent_agent_id: "child-1",
				message: { content: [{ type: "text", text: "recovered child work" }], stop_reason: "end_turn" },
			}],
		});
		const snapshotA = await recoverClaudeSdkEmbeddedWork([root], { sessionId: SESSION_ID, cwd: "/workspace", access: fixture.deps });
		const snapshotB = await recoverClaudeSdkEmbeddedWork([root, terminal, laterRoot], { sessionId: SESSION_ID, cwd: "/workspace", access: fixture.deps });

		expect(snapshotA.map(message => ({ id: message.id, role: message.role }))).toEqual([
			{ id: "root-agent", role: "assistant" },
			{ id: "recovered-child", role: "assistant" },
		]);
		expect(snapshotB.slice(0, snapshotA.length).map(message => ({ id: message.id, role: message.role })))
			.toEqual(snapshotA.map(message => ({ id: message.id, role: message.role })));
		expect(projectClaudeSdkEmbeddedWork(snapshotB).rootMessages.map(message => message.id)).toEqual([
			"root-agent", "late-terminal", "later-root",
		]);
	});

	it("partitions only exact non-empty root parents and drops rows after the byte budget without failing recovery", async () => {
		const one = "agent-use-1";
		const two = "agent-use-2";
		const root = assistant("root", undefined, "", [
			{ type: "toolCall", id: one, name: "Agent", arguments: {} },
			{ type: "toolCall", id: two, name: "Task", arguments: {} },
		]);
		const fixture = recoverySdk({
			"child-mixed": [
				{ type: "assistant", uuid: "one", session_id: SESSION_ID, parent_tool_use_id: one, parent_agent_id: "child-mixed", message: { content: [{ type: "text", text: "one" }], stop_reason: "end_turn" } },
				{ type: "assistant", uuid: "two", session_id: SESSION_ID, parent_tool_use_id: two, parent_agent_id: "child-mixed", message: { content: [{ type: "text", text: "two" }], stop_reason: "end_turn" } },
				{ type: "assistant", uuid: "unknown", session_id: SESSION_ID, parent_tool_use_id: "not-a-root-parent", parent_agent_id: "child-mixed", message: { content: [{ type: "text", text: "hidden" }], stop_reason: "end_turn" } },
			],
			"child-oversized": [{
				type: "assistant", uuid: "oversized", session_id: SESSION_ID, parent_tool_use_id: one, parent_agent_id: "child-oversized",
				message: { content: [{ type: "text", text: "x".repeat(MAX_RECOVERY_BYTES) }], stop_reason: "end_turn" },
			}],
		});

		const recovered = await recoverClaudeSdkEmbeddedWork([root], { sessionId: SESSION_ID, cwd: "/workspace", access: fixture.deps });
		expect(recovered.map(row => row.id)).toEqual(["root", "one", "two"]);
		expect(recovered.some(row => row.parentToolUseId === "not-a-root-parent")).toBe(false);
	});
});
