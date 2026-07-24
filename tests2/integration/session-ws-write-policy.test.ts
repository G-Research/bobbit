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

test.describe("authenticated WebSocket session write policy", () => {
	test("persisted read-only policy rejects prompts, steers, and every queue control while reads remain available", async ({ gateway }) => {
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
		try {
			await expectPolicyError(conn, { type: "prompt", text: "must not run" }, "SESSION_READ_ONLY");
			// A read-only session has no streaming-steer carve-out.
			live.status = "streaming";
			await expectPolicyError(conn, { type: "steer", text: "must not redirect" }, "SESSION_READ_ONLY");
			live.status = "idle";
			for (const frame of QUEUE_CONTROL_FRAMES) {
				await expectPolicyError(conn, frame, "SESSION_READ_ONLY");
			}

			expect(enqueuePrompt).not.toHaveBeenCalled();
			expect(deliverLiveSteer).not.toHaveBeenCalled();
			expect(steerQueued).not.toHaveBeenCalled();
			expect(removeQueued).not.toHaveBeenCalled();
			expect(reorderQueue).not.toHaveBeenCalled();
			await expectReadFramesStillWork(conn);
		} finally {
			live.status = "idle";
			enqueuePrompt.mockRestore();
			deliverLiveSteer.mockRestore();
			steerQueued.mockRestore();
			removeQueued.mockRestore();
			reorderQueue.mockRestore();
			conn.close();
			await deleteSession(sessionId);
		}
	});

	test("persisted non-interactive policy rejects new work and queue controls but permits a streaming steer", async ({ gateway }) => {
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
		try {
			await expectPolicyError(conn, { type: "prompt", text: "must not start review" }, "NON_INTERACTIVE_PROMPT");
			await expectPolicyError(conn, { type: "steer", text: "must not queue review" }, "NON_INTERACTIVE_STEER");
			for (const frame of QUEUE_CONTROL_FRAMES) {
				await expectPolicyError(conn, frame, "NON_INTERACTIVE_QUEUE_CONTROL");
			}

			expect(enqueuePrompt).not.toHaveBeenCalled();
			expect(deliverLiveSteer).not.toHaveBeenCalled();
			expect(steerQueued).not.toHaveBeenCalled();
			expect(removeQueued).not.toHaveBeenCalled();
			expect(reorderQueue).not.toHaveBeenCalled();
			await expectReadFramesStillWork(conn);

			live.status = "streaming";
			conn.send({ type: "steer", text: "redirect active review" });
			await vi.waitFor(() => {
				expect(deliverLiveSteer).toHaveBeenCalledWith(sessionId, "redirect active review");
			}, { timeout: 2_000 });
			expect(enqueuePrompt).not.toHaveBeenCalled();
		} finally {
			live.status = "idle";
			enqueuePrompt.mockRestore();
			deliverLiveSteer.mockRestore();
			steerQueued.mockRestore();
			removeQueued.mockRestore();
			reorderQueue.mockRestore();
			conn.close();
			await deleteSession(sessionId);
		}
	});
});
