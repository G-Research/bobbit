import { vi } from "vitest";
import { expect, test } from "./_e2e/in-process-harness.js";
import {
	connectWs,
	createSession,
	deleteSession,
	type WsConnection,
	waitForSessionStatus,
} from "./_e2e/e2e-setup.js";

async function expectPolicyError(
	conn: WsConnection,
	frame: Record<string, unknown>,
	code: string,
): Promise<void> {
	const cursor = conn.messageCount();
	conn.send(frame);
	const error = await conn.waitForFrom(cursor, message => message.type === "error", 2_000);
	expect(error).toMatchObject({ type: "error", code });
}

async function expectExtensionPolicyError(
	conn: WsConnection,
	frame: Record<string, unknown> & { requestId: string },
	resultType: "ext_session_write_permit_result" | "ext_session_post_result",
	code: string,
): Promise<void> {
	const cursor = conn.messageCount();
	conn.send(frame);
	const result = await conn.waitForFrom(
		cursor,
		message => message.type === resultType && message.requestId === frame.requestId,
		2_000,
	);
	expect(result).toMatchObject({
		type: resultType,
		requestId: frame.requestId,
		ok: false,
		error: code,
	});
}

async function expectExtensionWritesRejected(
	conn: WsConnection,
	code: string,
	requestPrefix: string,
): Promise<void> {
	await expectExtensionPolicyError(conn, {
		type: "ext_session_write_permit",
		requestId: `${requestPrefix}-permit`,
		surfaceToken: "crafted-surface-token",
		contentHash: "0".repeat(64),
	}, "ext_session_write_permit_result", code);
	await expectExtensionPolicyError(conn, {
		type: "ext_session_post",
		requestId: `${requestPrefix}-post`,
		surfaceToken: "crafted-surface-token",
		role: "user",
		text: "must not reach the agent",
		resumeTurn: true,
		nonce: "crafted-write-permit",
	}, "ext_session_post_result", code);
}

function persistPolicy(
	gateway: any,
	sessionId: string,
	updates: { readOnly?: boolean; nonInteractive?: boolean },
): void {
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	expect(persisted, "session has a durable policy row").toBeTruthy();
	expect(persisted.projectId, "session policy row is project-scoped").toEqual(expect.any(String));
	gateway.sessionManager.getSessionStore(persisted.projectId).update(sessionId, updates);
}

async function expectReadFramesStillWork(conn: WsConnection): Promise<void> {
	let cursor = conn.messageCount();
	conn.send({ type: "get_state" });
	await conn.waitForFrom(cursor, message => message.type === "state", 2_000);

	cursor = conn.messageCount();
	conn.send({ type: "get_messages" });
	await conn.waitForFrom(cursor, message => message.type === "messages", 2_000);

	cursor = conn.messageCount();
	conn.send({ type: "ping" });
	await conn.waitForFrom(cursor, message => message.type === "pong", 2_000);
}

const QUEUE_CONTROL_FRAMES: ReadonlyArray<Record<string, unknown>> = [
	{ type: "steer_queued", messageId: "queued-1" },
	{ type: "remove_queued", messageId: "queued-1" },
	{ type: "reorder_queue", messageIds: ["queued-1"] },
];

const WORK_CONTROL_FRAMES: ReadonlyArray<Record<string, unknown>> = [
	{ type: "retry" },
	{ type: "restart_agent" },
	{ type: "compact" },
	{ type: "grant_tool_permission", toolName: "bash", scope: "tool", mode: "session-only" },
];

test.describe("authenticated WebSocket session write policy", () => {
	test("persisted read-only policy rejects every agent work frame while reads remain available", async ({ gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const live = gateway.sessionManager.getSession(sessionId);
		expect(live).toBeTruthy();
		expect(live.readOnly).not.toBe(true);
		persistPolicy(gateway, sessionId, { readOnly: true });

		const conn = await connectWs(sessionId);
		const enqueuePrompt = vi.spyOn(gateway.sessionManager, "enqueuePrompt");
		const deliverLiveSteer = vi.spyOn(gateway.sessionManager, "deliverLiveSteer");
		const steerQueued = vi.spyOn(gateway.sessionManager, "steerQueued");
		const removeQueued = vi.spyOn(gateway.sessionManager, "removeQueued");
		const reorderQueue = vi.spyOn(gateway.sessionManager, "reorderQueue");
		const retryLastPrompt = vi.spyOn(gateway.sessionManager, "retryLastPrompt").mockRejectedValue(new Error("policy guard missed retry"));
		const restartAgent = vi.spyOn(gateway.sessionManager, "restartAgent").mockRejectedValue(new Error("policy guard missed restart"));
		const grantToolPermission = vi.spyOn(gateway.sessionManager, "grantToolPermission").mockRejectedValue(new Error("policy guard missed grant"));
		const compact = vi.spyOn(live.rpcClient, "compact").mockRejectedValue(new Error("policy guard missed compact"));
		try {
			await expectPolicyError(conn, { type: "prompt", text: "must not run" }, "SESSION_READ_ONLY");
			// A read-only session has no streaming-steer carve-out.
			live.status = "streaming";
			await expectPolicyError(conn, { type: "steer", text: "must not redirect" }, "SESSION_READ_ONLY");
			live.status = "idle";
			for (const frame of [...QUEUE_CONTROL_FRAMES, ...WORK_CONTROL_FRAMES]) {
				await expectPolicyError(conn, frame, "SESSION_READ_ONLY");
			}
			await expectExtensionWritesRejected(conn, "SESSION_READ_ONLY", "read-only");

			expect(enqueuePrompt).not.toHaveBeenCalled();
			expect(deliverLiveSteer).not.toHaveBeenCalled();
			expect(steerQueued).not.toHaveBeenCalled();
			expect(removeQueued).not.toHaveBeenCalled();
			expect(reorderQueue).not.toHaveBeenCalled();
			expect(retryLastPrompt).not.toHaveBeenCalled();
			expect(restartAgent).not.toHaveBeenCalled();
			expect(grantToolPermission).not.toHaveBeenCalled();
			expect(compact).not.toHaveBeenCalled();
			await expectReadFramesStillWork(conn);
		} finally {
			live.status = "idle";
			enqueuePrompt.mockRestore();
			deliverLiveSteer.mockRestore();
			steerQueued.mockRestore();
			removeQueued.mockRestore();
			reorderQueue.mockRestore();
			retryLastPrompt.mockRestore();
			restartAgent.mockRestore();
			grantToolPermission.mockRestore();
			compact.mockRestore();
			conn.close();
			await deleteSession(sessionId);
		}
	});

	test("persisted non-interactive policy permits only a direct streaming steer among agent work frames", async ({ gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const live = gateway.sessionManager.getSession(sessionId);
		expect(live).toBeTruthy();
		expect(live.nonInteractive).not.toBe(true);
		persistPolicy(gateway, sessionId, { nonInteractive: true });

		const conn = await connectWs(sessionId);
		const enqueuePrompt = vi.spyOn(gateway.sessionManager, "enqueuePrompt");
		const deliverLiveSteer = vi.spyOn(gateway.sessionManager, "deliverLiveSteer").mockResolvedValue(undefined);
		const steerQueued = vi.spyOn(gateway.sessionManager, "steerQueued");
		const removeQueued = vi.spyOn(gateway.sessionManager, "removeQueued");
		const reorderQueue = vi.spyOn(gateway.sessionManager, "reorderQueue");
		const retryLastPrompt = vi.spyOn(gateway.sessionManager, "retryLastPrompt").mockRejectedValue(new Error("policy guard missed retry"));
		const restartAgent = vi.spyOn(gateway.sessionManager, "restartAgent").mockRejectedValue(new Error("policy guard missed restart"));
		const grantToolPermission = vi.spyOn(gateway.sessionManager, "grantToolPermission").mockRejectedValue(new Error("policy guard missed grant"));
		const compact = vi.spyOn(live.rpcClient, "compact").mockRejectedValue(new Error("policy guard missed compact"));
		try {
			await expectPolicyError(conn, { type: "prompt", text: "must not start review" }, "NON_INTERACTIVE_PROMPT");
			await expectPolicyError(conn, { type: "steer", text: "must not queue review" }, "NON_INTERACTIVE_STEER");
			for (const frame of QUEUE_CONTROL_FRAMES) {
				await expectPolicyError(conn, frame, "NON_INTERACTIVE_QUEUE_CONTROL");
			}
			for (const frame of WORK_CONTROL_FRAMES) {
				await expectPolicyError(conn, frame, "NON_INTERACTIVE_WORK_CONTROL");
			}

			await expectReadFramesStillWork(conn);

			live.status = "streaming";
			conn.send({ type: "steer", text: "redirect active review" });
			await vi.waitFor(() => {
				expect(deliverLiveSteer).toHaveBeenCalledWith(sessionId, "redirect active review");
			}, { timeout: 2_000 });
			// Streaming only carves out the direct steer frame. Alternate retry and
			// extension redirect/enqueue paths stay forbidden.
			await expectPolicyError(conn, { type: "retry" }, "NON_INTERACTIVE_WORK_CONTROL");
			await expectExtensionWritesRejected(conn, "NON_INTERACTIVE_WORK_CONTROL", "non-interactive-streaming");

			expect(enqueuePrompt).not.toHaveBeenCalled();
			expect(deliverLiveSteer).toHaveBeenCalledTimes(1);
			expect(steerQueued).not.toHaveBeenCalled();
			expect(removeQueued).not.toHaveBeenCalled();
			expect(reorderQueue).not.toHaveBeenCalled();
			expect(retryLastPrompt).not.toHaveBeenCalled();
			expect(restartAgent).not.toHaveBeenCalled();
			expect(grantToolPermission).not.toHaveBeenCalled();
			expect(compact).not.toHaveBeenCalled();
		} finally {
			live.status = "idle";
			enqueuePrompt.mockRestore();
			deliverLiveSteer.mockRestore();
			steerQueued.mockRestore();
			removeQueued.mockRestore();
			reorderQueue.mockRestore();
			retryLastPrompt.mockRestore();
			restartAgent.mockRestore();
			grantToolPermission.mockRestore();
			compact.mockRestore();
			conn.close();
			await deleteSession(sessionId);
		}
	});
});
