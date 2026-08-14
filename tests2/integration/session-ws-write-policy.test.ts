import { vi } from "vitest";
import { TaskManager } from "../../src/server/agent/task-manager.js";
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

const MODEL_CONTROL_FRAMES: ReadonlyArray<Record<string, unknown>> = [
	{ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
	{ type: "set_thinking_level", level: "high" },
	{ type: "set_image_model", provider: "openai", modelId: "gpt-image-2" },
];

const TITLE_CONTROL_FRAMES: ReadonlyArray<Record<string, unknown>> = [
	{ type: "generate_title" },
	{ type: "summarize_goal_title", goalTitle: "Attacker controlled goal title" },
	{ type: "set_title", title: "forbidden title" },
];

const TASK_CONTROL_FRAMES: ReadonlyArray<Record<string, unknown>> = [
	{
		type: "task_create",
		goalId: "11111111-1111-4111-8111-111111111111",
		title: "Cross-goal crafted task",
		taskType: "implementation",
		parentTaskId: "22222222-2222-4222-8222-222222222222",
		dependsOn: ["33333333-3333-4333-8333-333333333333"],
	},
	{
		type: "task_update",
		taskId: "44444444-4444-4444-8444-444444444444",
		updates: { title: "Cross-goal crafted update", state: "in-progress" },
	},
	{
		type: "task_delete",
		taskId: "55555555-5555-4555-8555-555555555555",
	},
];

function spyOnModelControlMutations(gateway: any, live: any) {
	return {
		setModel: vi.spyOn(live.rpcClient, "setModel"),
		setThinkingLevel: vi.spyOn(live.rpcClient, "setThinkingLevel"),
		persistSessionModel: vi.spyOn(gateway.sessionManager, "persistSessionModel"),
		updateModelNameFile: vi.spyOn(gateway.sessionManager, "updateModelNameFile"),
		persistSessionImageModel: vi.spyOn(gateway.sessionManager, "persistSessionImageModel"),
		validateImageModel: vi.spyOn(gateway.sessionManager, "isKnownImageModel"),
	};
}

function expectNoModelControlMutations(spies: ReturnType<typeof spyOnModelControlMutations>): void {
	for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
}

function restoreModelControlSpies(spies: ReturnType<typeof spyOnModelControlMutations>): void {
	for (const spy of Object.values(spies)) spy.mockRestore();
}

function spyOnTitleControlMutations(gateway: any) {
	return {
		autoGenerateTitle: vi.spyOn(gateway.sessionManager, "autoGenerateTitle").mockRejectedValue(new Error("policy guard missed auto title")),
		generateGoalTitle: vi.spyOn(gateway.sessionManager, "generateGoalTitle").mockImplementation(() => undefined),
		setTitle: vi.spyOn(gateway.sessionManager, "setTitle").mockReturnValue(false),
	};
}

async function expectNoTitleControlMutations(spies: ReturnType<typeof spyOnTitleControlMutations>): Promise<void> {
	// Title generation is fire-and-forget. Cross an event-loop turn so a handler
	// that incorrectly defers either generation call cannot escape the assertion.
	await new Promise<void>(resolve => setImmediate(resolve));
	for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
}

function restoreTitleControlSpies(spies: ReturnType<typeof spyOnTitleControlMutations>): void {
	for (const spy of Object.values(spies)) spy.mockRestore();
}

function spyOnTaskControlPaths(gateway: any) {
	const projectContexts = gateway.sessionManager.getProjectContextManager();
	expect(projectContexts, "gateway has project contexts for task routing").toBeTruthy();
	return {
		resolveProjectContexts: vi.spyOn(gateway.sessionManager, "getProjectContextManager"),
		resolveGoal: vi.spyOn(projectContexts, "getContextForGoal"),
		scanProjects: vi.spyOn(projectContexts, "all"),
		createTask: vi.spyOn(TaskManager.prototype, "createTask"),
		updateTask: vi.spyOn(TaskManager.prototype, "updateTask"),
		deleteTask: vi.spyOn(TaskManager.prototype, "deleteTask"),
	};
}

function clearTaskControlSpies(spies: ReturnType<typeof spyOnTaskControlPaths>): void {
	for (const spy of Object.values(spies)) spy.mockClear();
}

function expectNoTaskControlPaths(spies: ReturnType<typeof spyOnTaskControlPaths>): void {
	for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
}

function restoreTaskControlSpies(spies: ReturnType<typeof spyOnTaskControlPaths>): void {
	for (const spy of Object.values(spies)) spy.mockRestore();
}

async function expectModelControlsRejected(conn: WsConnection, code: string): Promise<void> {
	for (const frame of MODEL_CONTROL_FRAMES) await expectPolicyError(conn, frame, code);
}

async function expectTitleControlsRejected(conn: WsConnection, code: string): Promise<void> {
	for (const frame of TITLE_CONTROL_FRAMES) await expectPolicyError(conn, frame, code);
}

async function expectTaskControlsRejected(conn: WsConnection, code: string): Promise<void> {
	for (const frame of TASK_CONTROL_FRAMES) await expectPolicyError(conn, frame, code);
}

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
		const modelControlSpies = spyOnModelControlMutations(gateway, live);
		const titleControlSpies = spyOnTitleControlMutations(gateway);
		const taskControlSpies = spyOnTaskControlPaths(gateway);
		try {
			await expectPolicyError(conn, { type: "prompt", text: "must not run" }, "SESSION_READ_ONLY");
			// A read-only session has no streaming-steer carve-out.
			live.status = "streaming";
			await expectPolicyError(conn, { type: "steer", text: "must not redirect" }, "SESSION_READ_ONLY");
			live.status = "idle";
			for (const frame of [...QUEUE_CONTROL_FRAMES, ...WORK_CONTROL_FRAMES]) {
				await expectPolicyError(conn, frame, "SESSION_READ_ONLY");
			}
			await expectModelControlsRejected(conn, "SESSION_READ_ONLY");
			await expectTitleControlsRejected(conn, "SESSION_READ_ONLY");
			clearTaskControlSpies(taskControlSpies);
			await expectTaskControlsRejected(conn, "SESSION_READ_ONLY");
			expectNoTaskControlPaths(taskControlSpies);
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
			expectNoModelControlMutations(modelControlSpies);
			await expectNoTitleControlMutations(titleControlSpies);
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
			restoreModelControlSpies(modelControlSpies);
			restoreTitleControlSpies(titleControlSpies);
			restoreTaskControlSpies(taskControlSpies);
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
		const modelControlSpies = spyOnModelControlMutations(gateway, live);
		const titleControlSpies = spyOnTitleControlMutations(gateway);
		const taskControlSpies = spyOnTaskControlPaths(gateway);
		try {
			await expectPolicyError(conn, { type: "prompt", text: "must not start review" }, "NON_INTERACTIVE_PROMPT");
			await expectPolicyError(conn, { type: "steer", text: "must not queue review" }, "NON_INTERACTIVE_STEER");
			for (const frame of QUEUE_CONTROL_FRAMES) {
				await expectPolicyError(conn, frame, "NON_INTERACTIVE_QUEUE_CONTROL");
			}
			for (const frame of WORK_CONTROL_FRAMES) {
				await expectPolicyError(conn, frame, "NON_INTERACTIVE_WORK_CONTROL");
			}
			await expectModelControlsRejected(conn, "NON_INTERACTIVE_WORK_CONTROL");
			await expectTitleControlsRejected(conn, "NON_INTERACTIVE_WORK_CONTROL");
			clearTaskControlSpies(taskControlSpies);
			await expectTaskControlsRejected(conn, "NON_INTERACTIVE_WORK_CONTROL");
			expectNoTaskControlPaths(taskControlSpies);
			expectNoModelControlMutations(modelControlSpies);
			await expectNoTitleControlMutations(titleControlSpies);

			await expectReadFramesStillWork(conn);

			live.status = "streaming";
			conn.send({ type: "steer", text: "redirect active review" });
			await vi.waitFor(() => {
				expect(deliverLiveSteer).toHaveBeenCalledWith(
					sessionId,
					"redirect active review",
					expect.objectContaining({ intentId: expect.any(String), source: "user" }),
				);
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
			expectNoModelControlMutations(modelControlSpies);
			await expectNoTitleControlMutations(titleControlSpies);
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
			restoreModelControlSpies(modelControlSpies);
			restoreTitleControlSpies(titleControlSpies);
			restoreTaskControlSpies(taskControlSpies);
			conn.close();
			await deleteSession(sessionId);
		}
	});

	test("live restricted metadata blocks model controls before RPC, validation, or persistence", async ({ gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const live = gateway.sessionManager.getSession(sessionId);
		expect(live).toBeTruthy();
		const persisted = gateway.sessionManager.getPersistedSession(sessionId);
		expect(persisted?.readOnly).not.toBe(true);
		expect(persisted?.nonInteractive).not.toBe(true);

		const conn = await connectWs(sessionId);
		const modelControlSpies = spyOnModelControlMutations(gateway, live);
		try {
			live.readOnly = true;
			await expectModelControlsRejected(conn, "SESSION_READ_ONLY");

			live.readOnly = false;
			live.nonInteractive = true;
			await expectModelControlsRejected(conn, "NON_INTERACTIVE_WORK_CONTROL");

			expectNoModelControlMutations(modelControlSpies);
		} finally {
			live.readOnly = false;
			live.nonInteractive = false;
			restoreModelControlSpies(modelControlSpies);
			conn.close();
			await deleteSession(sessionId);
		}
	});
});
