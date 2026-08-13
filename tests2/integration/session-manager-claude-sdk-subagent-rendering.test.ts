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
});
