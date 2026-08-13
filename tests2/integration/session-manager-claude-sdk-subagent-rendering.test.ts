// v2-native — SessionManager keeps semantic SDK child work outside root ownership.
import { describe, expect, it } from "vitest";

import type { ServerMessage } from "../../src/server/ws/protocol.ts";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import {
	SessionManager,
	isClaudeSdkSubagentWorkEvent,
	isUserVisibleActivity,
} from "../../src/server/agent/session-manager.ts";
import { buildVisibleMessageSnapshot } from "../../src/server/agent/visible-message-snapshot.ts";
import { LARGE_CONTENT_THRESHOLD } from "../../src/server/agent/truncate-large-content.ts";

type Client = { readyState: number; bufferedAmount: number; sent: unknown[]; send(payload: string): void };

function client(): Client {
	return {
		readyState: 1,
		bufferedAmount: 0,
		sent: [],
		send(payload) { this.sent.push(JSON.parse(payload)); },
	};
}

describe("SessionManager Claude SDK embedded work transport", () => {
	it("sequences and resumes semantic child work without accepting it as root lifecycle, activity, or cost", () => {
		const event = {
			type: "claude_sdk_subagent_work" as const,
			parentToolUseId: "agent-parent-1",
			kind: "message" as const,
			message: {
				id: "child-message-1",
				role: "assistant",
				content: [{ type: "text", text: "child-only prose" }],
				usage: { input: 11, output: 7, cost: { total: 0.25 } },
			},
		};
		const wire: ServerMessage = { type: "event", data: event, seq: 1, ts: 10 };
		expect(wire).toMatchObject({ type: "event", data: { type: "claude_sdk_subagent_work" } });
		expect(isClaudeSdkSubagentWorkEvent(event)).toBe(true);
		expect(isUserVisibleActivity(event)).toBe(false);

		const rootClient = client();
		const session: any = {
			id: "sdk-root",
			status: "streaming",
			completedTurnCount: 3,
			lastActivity: 100,
			clients: new Set([rootClient]),
			eventBuffer: new EventBuffer(),
			promptQueue: { length: 2 },
		};
		const manager: any = Object.create(SessionManager.prototype);

		manager.handleAgentLifecycle(session, event);
		manager.trackCostFromEvent(session, event);
		manager.emitAgentEvent(session, event);

		expect(session).toMatchObject({
			status: "streaming",
			completedTurnCount: 3,
			lastActivity: 100,
		});
		expect(session.eventBuffer.getAll()).toMatchObject([{ seq: 1, event }]);
		expect(session.eventBuffer.since(0)).toMatchObject([{ seq: 1, event }]);
		expect(rootClient.sent).toEqual([expect.objectContaining({
			type: "event",
			seq: 1,
			data: event,
		})]);
	});

	it("bounds large child frames before live replay while retaining their audit metadata", () => {
		const large = "x".repeat(LARGE_CONTENT_THRESHOLD + 1);
		const event = {
			type: "claude_sdk_subagent_work" as const,
			parentToolUseId: "agent-parent-1",
			kind: "tool_end" as const,
			identity: { parentToolUseId: "agent-parent-1", agentId: "child-1" },
			message: {
				id: "child-message-1", role: "assistant", parentToolUseId: "agent-parent-1",
				content: [{ type: "toolCall", id: "child-tool-1", name: "write", arguments: { content: large } }],
				usage: { input: 11, output: 7, cost: { total: 0.25 } },
			},
			toolEvent: {
				type: "tool_execution_end", toolCallId: "child-tool-1", toolName: "write", args: { content: large },
				result: { content: [{ type: "text", text: large }] },
			},
		};
		const rootClient = client();
		const session: any = { clients: new Set([rootClient]), eventBuffer: new EventBuffer() };
		const manager: any = Object.create(SessionManager.prototype);

		manager.emitAgentEvent(session, event);

		const replay: any = session.eventBuffer.since(0)[0].event;
		expect(replay).not.toBe(event);
		expect(replay.message).toMatchObject({
			id: "child-message-1", parentToolUseId: "agent-parent-1",
			usage: { input: 11, output: 7, cost: { total: 0.25 } },
		});
		expect(replay.message.content[0].arguments.content).toMatchObject({ _truncated: true, _originalLength: large.length });
		expect(replay.toolEvent.args.content).toMatchObject({ _truncated: true, _originalLength: large.length });
		expect(replay.toolEvent.result.content[0]).toMatchObject({ _truncated: true, _originalLength: large.length });
		expect((rootClient.sent[0] as any).data).toEqual(replay);
		expect(event.message.content[0].arguments.content).toBe(large);
		expect(event.toolEvent.args.content).toBe(large);
		expect(event.toolEvent.result.content[0].text).toBe(large);
	});

	it("keeps a nested snapshot envelope intact while ordering only root rows", () => {
		const nested = [{
			parentToolUseId: "agent-parent-1",
			phase: "error",
			messages: [{ id: "child-error", role: "assistant", content: "still child-only", usage: { cost: { total: 0.25 } } }],
		}];
		const snapshot = buildVisibleMessageSnapshot({
			messages: [{ id: "root-message", role: "assistant", content: "root prose" }],
			subagentWork: nested,
		}, { sessionId: "sdk-root" }) as any;

		expect(snapshot.messages).toEqual([expect.objectContaining({ id: "root-message", _order: EventBuffer.SNAPSHOT_ORDER_FLOOR })]);
		expect(snapshot.subagentWork).toBe(nested);
		expect(snapshot.messages).not.toContainEqual(expect.objectContaining({ id: "child-error" }));
	});

	it("truncates nested snapshot messages without changing parent, identity, or usage metadata", () => {
		const large = "x".repeat(LARGE_CONTENT_THRESHOLD + 1);
		const manager: any = Object.create(SessionManager.prototype);
		manager.sessions = new Map();
		manager.projectContextManager = null;
		manager._testStore = { get: () => ({ id: "sdk-root", runtime: "claude-agent-sdk", title: "SDK", cwd: "/workspace" }) };
		manager.messageAuthorDependencies = () => ({});
		const snapshot = manager.buildVisibleMessageSnapshot("sdk-root", [
			{ id: "root-agent", role: "assistant", content: [{ type: "toolCall", id: "agent-parent-1", name: "Agent", arguments: {} }] },
			{
				id: "child-result", role: "toolResult", parentToolUseId: "agent-parent-1", parentAgentId: "child-1",
				toolCallId: "child-tool", content: [{ type: "text", text: large }], usage: { cost: { total: 0.25 } },
			},
		]);

		const child = snapshot.subagentWork[0].messages[0];
		expect(child).toMatchObject({
			id: "child-result", parentToolUseId: "agent-parent-1", parentAgentId: "child-1", toolCallId: "child-tool",
			usage: { cost: { total: 0.25 } },
		});
		expect(child.content[0]).toMatchObject({ _truncated: true, _originalLength: large.length });
		expect(snapshot.messages).not.toContainEqual(expect.objectContaining({ id: "child-result" }));
	});

	it("projects SDK reload/archive rows into nested work before the root snapshot pipeline", () => {
		const manager: any = Object.create(SessionManager.prototype);
		manager.sessions = new Map();
		manager.projectContextManager = null;
		manager._testStore = { get: () => ({ id: "sdk-root", runtime: "claude-agent-sdk", title: "SDK", cwd: "/workspace" }) };
		manager.messageAuthorDependencies = () => ({});
		const snapshot = manager.buildVisibleMessageSnapshot("sdk-root", [
			{ id: "root-agent", role: "assistant", content: [{ type: "toolCall", id: "agent-parent-1", name: "Agent", arguments: {} }] },
			{ id: "child-text", role: "assistant", parentToolUseId: "agent-parent-1", parentAgentId: "child-1", content: "nested prose", usage: { cost: { total: 0.25 } } },
		]);

		expect(snapshot.messages).toEqual([expect.objectContaining({ id: "root-agent" })]);
		expect(snapshot.messages).not.toContainEqual(expect.objectContaining({ id: "child-text" }));
		expect(snapshot.subagentWork).toEqual([expect.objectContaining({
			parentToolUseId: "agent-parent-1",
			messages: [expect.objectContaining({ id: "child-text", usage: { cost: { total: 0.25 } } })],
		})]);
	});

	it("returns root prose only when recovered child assistant rows are appended last", async () => {
		const manager: any = Object.create(SessionManager.prototype);
		const session = { dormant: false };
		manager.sessions = new Map([["sdk-root", session]]);
		manager.getMessagesSnapshotBase = async () => ({
			success: true,
			data: [
				{ role: "assistant", content: "root prose" },
				{ role: "assistant", content: [{ type: "text", text: "root follow-up" }] },
				{ role: "assistant", parentToolUseId: "agent-parent-1", content: "recovered child prose" },
			],
		});

		expect(await manager.getSessionOutput("sdk-root")).toBe("root prose\n\nroot follow-up");
	});
});
