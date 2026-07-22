/**
 * AC §3 — Steer + gateway restart durability.
 *
 * The pre-restart in-process bridge is put in deterministic queue-drop mode.
 * That leaves the accepted steer solely in SessionManager's persisted in-flight
 * ledger, matching the dispatch→echo crash window without a subprocess, sleep,
 * polling loop, or real gateway restart. Restore then re-enqueues the ledger
 * once; a fresh mock bridge echoes it into the reconnect snapshot.
 */
import { vi } from "vitest";

import { test, expect } from "./_e2e/in-process-harness.js";
import {
	connectWs,
	createSession,
	deleteSession,
	queueLenPredicate,
} from "./_e2e/e2e-setup.js";
import {
	promptAuthorBindingMatchesText,
	readAuthorSidecar,
} from "../../src/server/agent/author-sidecar.js";
import { attachLocalMockAgentClock } from "./helpers/local-mock-agent-clock.js";

const STEER_TEXT = "RESTART_M1\nRESTART_M2";
const AGENT_STEER_TEXT = "RESTART_AGENT_ACCOUNTABLE_STEER";
const AGENT_AUTHOR = {
	kind: "agent",
	id: "session:abcdef12-3456-7890",
	label: "Restart Coordinator",
} as const;
const AGENT_PREFIX = "[Restart Coordinator (abcdef)]: ";

function snapshotMessages(frame: any): any[] {
	return Array.isArray(frame?.data) ? frame.data : frame?.data?.messages ?? [];
}

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function rawUserMessages(gateway: any, sessionId: string): any[] {
	const messages = gateway.sessionManager.getSession(sessionId)?.rpcClient?._agent?.conversationMessages;
	expect(Array.isArray(messages), "restored session uses the in-process mock transcript").toBe(true);
	return messages.filter((message: any) => message?.role === "user" || message?.role === "user-with-attachments");
}

test.describe("Steer + gateway restart (AC §3)", () => {
	test("steered queued text survives in-flight restart exactly once, ordered", async ({ gateway }) => {
		const sessionId = await createSession();
		let conn = await connectWs(sessionId);
		const sm = gateway.sessionManager as any;
		let steerRpc: ReturnType<typeof vi.spyOn> | undefined;

		try {
			await conn.waitFor((message: any) => message.type === "queue_update");
			const live = sm.sessions.get(sessionId);
			expect(live, "session live before steer").toBeTruthy();
			const mockAgent = live.rpcClient?._agent;
			expect(mockAgent, "session uses the in-process mock bridge").toBeTruthy();

			// Drive only this bridge into the dispatch→echo crash seam. Mutating the
			// session-owned mock env avoids process-global state and affects no peer.
			mockAgent.env.MOCK_STEER_QUEUE_DROP = "always";
			steerRpc = vi.spyOn(live.rpcClient, "steer");
			live.status = "streaming";
			conn.send({ type: "prompt", text: STEER_TEXT });
			const queued = await conn.waitFor(queueLenPredicate(1));
			const messageId = queued.queue!.find((message: any) => message.text === STEER_TEXT)!.id;

			const emptyQueueCursor = conn.messageCount();
			conn.send({ type: "steer_queued", messageId });
			await conn.waitForFrom(emptyQueueCursor, queueLenPredicate(0));
			expect(steerRpc).toHaveBeenCalledOnce();
			expect(steerRpc).toHaveBeenCalledWith(STEER_TEXT);

			const persistedBeforeRestore = sm.resolveStoreForSession(sessionId).get(sessionId);
			expect(persistedBeforeRestore?.messageQueue ?? []).toHaveLength(0);
			expect(persistedBeforeRestore?.inFlightSteerTexts).toEqual([
				expect.objectContaining({
					text: STEER_TEXT,
					promptId: expect.stringMatching(/^steer:[a-f0-9]{64}$/),
					source: "user",
					author: { kind: "user", id: "user:local", label: "User" },
				}),
			]);
			const pendingHuman = readAuthorSidecar(sessionId).filter(binding =>
				promptAuthorBindingMatchesText(binding, STEER_TEXT),
			);
			expect(pendingHuman).toHaveLength(1);
			expect(pendingHuman[0].settlement).toBeUndefined();
			expect((pendingHuman[0] as any).modelPrefix).toBeUndefined();
			expect(mockAgent.conversationMessages.some((message: any) => messageText(message) === STEER_TEXT)).toBe(false);

			// Simulate restart precisely at Bobbit's durable boundary, then restore
			// through SessionManager with a fresh healthy in-process bridge.
			conn.close();
			live.unsubscribe();
			await live.rpcClient.stop();
			sm.sessions.delete(sessionId);
			await sm.restoreSessions();

			const restoredClock = attachLocalMockAgentClock(gateway, sessionId);
			await restoredClock.settleCurrentPrompt();

			conn = await connectWs(sessionId);
			const snapshotCursor = conn.messageCount();
			conn.send({ type: "get_messages" });
			const response = await conn.waitForFrom(snapshotCursor, (message: any) => message.type === "messages");
			const userMessages = snapshotMessages(response).filter((message: any) => message.role === "user");
			const restoredMessages = userMessages.filter((message: any) => messageText(message).includes("RESTART_M1"));

			expect(restoredMessages).toHaveLength(1);
			expect(restoredMessages[0].author).toEqual({
				kind: "user",
				id: "user:local",
				label: "User",
			});
			expect(messageText(restoredMessages[0])).toBe(STEER_TEXT);
			expect(rawUserMessages(gateway, sessionId).filter(message => messageText(message) === STEER_TEXT)).toHaveLength(1);
			const humanDispatches = readAuthorSidecar(sessionId).filter(binding =>
				promptAuthorBindingMatchesText(binding, STEER_TEXT),
			);
			expect(humanDispatches).toHaveLength(2);
			expect(humanDispatches.map(binding => binding.settlement?.outcome).sort()).toEqual(["cancelled", "echoed"]);
			expect(humanDispatches.every(binding => (binding as any).modelPrefix === undefined)).toBe(true);
			expect(sm.resolveStoreForSession(sessionId).get(sessionId)?.inFlightSteerTexts ?? []).toHaveLength(0);
		} finally {
			steerRpc?.mockRestore();
			conn.close();
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});

	test("agent steer restart keeps the durable ledger unprefixed and redispatches one decorated Pi occurrence", async ({ gateway }) => {
		const sessionId = await createSession();
		let conn = await connectWs(sessionId);
		const sm = gateway.sessionManager as any;
		let steerRpc: ReturnType<typeof vi.spyOn> | undefined;
		const piText = `${AGENT_PREFIX}${AGENT_STEER_TEXT}`;

		try {
			await conn.waitFor((message: any) => message.type === "queue_update");
			const live = sm.sessions.get(sessionId);
			expect(live, "session live before accountable steer").toBeTruthy();
			const mockAgent = live.rpcClient?._agent;
			expect(mockAgent, "session uses the in-process mock bridge").toBeTruthy();
			mockAgent.env.MOCK_STEER_QUEUE_DROP = "always";
			steerRpc = vi.spyOn(live.rpcClient, "steer");
			live.status = "streaming";

			await sm.deliverLiveSteer(sessionId, AGENT_STEER_TEXT, {
				source: "agent",
				author: AGENT_AUTHOR,
			});
			expect(steerRpc).toHaveBeenCalledOnce();
			expect(steerRpc).toHaveBeenCalledWith(piText);
			const persistedBeforeRestore = sm.resolveStoreForSession(sessionId).get(sessionId);
			expect(persistedBeforeRestore?.inFlightSteerTexts).toEqual([
				expect.objectContaining({
					text: AGENT_STEER_TEXT,
					source: "agent",
					author: AGENT_AUTHOR,
				}),
			]);
			const pendingAgent = readAuthorSidecar(sessionId).filter(binding =>
				promptAuthorBindingMatchesText(binding, piText),
			);
			expect(pendingAgent).toHaveLength(1);
			expect(pendingAgent[0]).toMatchObject({ modelPrefix: AGENT_PREFIX, author: AGENT_AUTHOR });
			expect(promptAuthorBindingMatchesText(pendingAgent[0], AGENT_STEER_TEXT)).toBe(false);

			conn.close();
			live.unsubscribe();
			await live.rpcClient.stop();
			sm.sessions.delete(sessionId);
			await sm.restoreSessions();

			const restoredClock = attachLocalMockAgentClock(gateway, sessionId);
			await restoredClock.settleCurrentPrompt();
			expect(rawUserMessages(gateway, sessionId).filter(message => messageText(message) === piText),
				"only the healthy post-restart bridge observes the decorated steer").toHaveLength(1);

			conn = await connectWs(sessionId);
			const snapshotCursor = conn.messageCount();
			conn.send({ type: "get_messages" });
			const response = await conn.waitForFrom(snapshotCursor, (message: any) => message.type === "messages");
			const restored = snapshotMessages(response).filter((message: any) =>
				message.role === "user" && messageText(message) === AGENT_STEER_TEXT,
			);
			expect(restored).toHaveLength(1);
			expect(restored[0].author).toEqual(AGENT_AUTHOR);
			expect(JSON.stringify(restored[0])).not.toContain(AGENT_PREFIX);

			const agentDispatches = readAuthorSidecar(sessionId).filter(binding =>
				promptAuthorBindingMatchesText(binding, piText),
			);
			expect(agentDispatches).toHaveLength(2);
			expect(agentDispatches.map(binding => binding.settlement?.outcome).sort()).toEqual(["cancelled", "echoed"]);
			expect(agentDispatches.every(binding => (binding as any).modelPrefix === AGENT_PREFIX)).toBe(true);
			expect(sm.resolveStoreForSession(sessionId).get(sessionId)?.inFlightSteerTexts ?? []).toHaveLength(0);
		} finally {
			steerRpc?.mockRestore();
			conn.close();
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
