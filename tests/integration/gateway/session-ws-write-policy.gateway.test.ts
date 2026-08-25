import { vi } from "vitest";
import { TaskManager } from "../../../src/server/agent/task-manager.js";
import { expect, test } from "./_helpers/e2e/in-process-harness.js";
import {
	connectWs,
	createSession,
	deleteSession,
	type WsConnection,
	waitForSessionStatus,
} from "./_helpers/e2e/e2e-setup.js";

type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(onResolve => { resolve = onResolve; });
	return { promise, resolve };
}

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

function captureContextClearPersistence(gateway: any, sessionId: string): Record<string, unknown> {
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	expect(persisted, "session has a durable context-clear row").toBeTruthy();
	return {
		agentSessionFile: persisted.agentSessionFile,
		contextClearBoundariesPresent: Object.prototype.hasOwnProperty.call(persisted, "contextClearBoundaries"),
		contextClearBoundaries: structuredClone(persisted.contextClearBoundaries),
	};
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
	{ type: "clear" },
	{ type: "grant_tool_permission", toolName: "bash", scope: "tool", mode: "session-only" },
];

const MODEL_CONTROL_FRAMES: ReadonlyArray<Record<string, unknown>> = [
	{ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
	{ type: "set_thinking_level", level: "high" },
	{ type: "set_image_model", provider: "openai", modelId: "gpt-image-2" },
];

const MODEL_SELECTION_CONDITION = {
	code: "MODEL_SELECTION_REQUIRED",
	provider: "retired-provider",
	modelId: "retired-model",
} as const;

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
	test("persisted read-only capability permits interaction but blocks permission widening", async ({ gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const live = gateway.sessionManager.getSession(sessionId);
		expect(live).toBeTruthy();
		expect(live.readOnly).not.toBe(true);
		persistPolicy(gateway, sessionId, { readOnly: true });

		const conn = await connectWs(sessionId);
		const enqueuePrompt = vi.spyOn(gateway.sessionManager, "enqueuePrompt").mockResolvedValue(undefined);
		const deliverLiveSteer = vi.spyOn(gateway.sessionManager, "deliverLiveSteer").mockResolvedValue(undefined);
		const steerQueued = vi.spyOn(gateway.sessionManager, "steerQueued").mockReturnValue(true);
		const removeQueued = vi.spyOn(gateway.sessionManager, "removeQueued").mockReturnValue(true);
		const reorderQueue = vi.spyOn(gateway.sessionManager, "reorderQueue").mockReturnValue(true);
		const grantToolPermission = vi.spyOn(gateway.sessionManager, "grantToolPermission")
			.mockRejectedValue(new Error("read-only capability guard missed permission widening"));
		try {
			conn.send({ type: "prompt", text: "direct read-only delegate follow-up", intentId: "readonly-prompt" });
			await vi.waitFor(() => {
				expect(
					enqueuePrompt,
					"READ_ONLY_DELEGATE_PROMPT_REJECTED: capability-only readOnly blocked a direct follow-up prompt",
				).toHaveBeenCalledWith(
					sessionId,
					"direct read-only delegate follow-up",
					expect.objectContaining({ source: "user", intentId: "readonly-prompt" }),
				);
			}, { timeout: 2_000 });

			live.status = "streaming";
			conn.send({ type: "steer", text: "redirect active read-only delegate", intentId: "readonly-live-steer" });
			await vi.waitFor(() => expect(deliverLiveSteer).toHaveBeenCalledWith(
				sessionId,
				"redirect active read-only delegate",
				expect.objectContaining({ source: "user", intentId: "readonly-live-steer" }),
			), { timeout: 2_000 });

			live.status = "idle";
			conn.send({ type: "steer", text: "queue read-only delegate follow-up", intentId: "readonly-queued-steer" });
			await vi.waitFor(() => expect(enqueuePrompt).toHaveBeenCalledWith(
				sessionId,
				"queue read-only delegate follow-up",
				expect.objectContaining({ isSteered: true, source: "user", intentId: "readonly-queued-steer" }),
			), { timeout: 2_000 });

			for (const frame of QUEUE_CONTROL_FRAMES) conn.send(frame);
			await vi.waitFor(() => {
				expect(steerQueued).toHaveBeenCalledWith(sessionId, "queued-1");
				expect(removeQueued).toHaveBeenCalledWith(sessionId, "queued-1");
				expect(reorderQueue).toHaveBeenCalledWith(sessionId, ["queued-1"]);
			}, { timeout: 2_000 });

			await expectPolicyError(conn, {
				type: "grant_tool_permission",
				toolName: "bash",
				scope: "tool",
				mode: "session-only",
			}, "SESSION_READ_ONLY");
			expect(grantToolPermission).not.toHaveBeenCalled();
			expect(gateway.sessionManager.getPersistedSession(sessionId)?.readOnly).toBe(true);
			await expectReadFramesStillWork(conn);
		} finally {
			live.status = "idle";
			enqueuePrompt.mockRestore();
			deliverLiveSteer.mockRestore();
			steerQueued.mockRestore();
			removeQueued.mockRestore();
			reorderQueue.mockRestore();
			grantToolPermission.mockRestore();
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
		const contextClearPersistenceBefore = captureContextClearPersistence(gateway, sessionId);

		const conn = await connectWs(sessionId);
		const clearContext = vi.spyOn(gateway.sessionManager, "clearContext").mockRejectedValue(new Error("policy guard missed clear"));
		const newSession = vi.spyOn(live.rpcClient, "newSession").mockRejectedValue(new Error("policy guard missed new_session"));
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
			// Streaming only carves out the direct steer frame. Alternate retry,
			// context replacement, and extension redirect/enqueue paths stay forbidden.
			await expectPolicyError(conn, { type: "retry" }, "NON_INTERACTIVE_WORK_CONTROL");
			await expectPolicyError(conn, { type: "clear" }, "NON_INTERACTIVE_WORK_CONTROL");
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
			expect(clearContext).not.toHaveBeenCalled();
			expect(newSession).not.toHaveBeenCalled();
			expect(captureContextClearPersistence(gateway, sessionId)).toEqual(contextClearPersistenceBefore);
			expectNoModelControlMutations(modelControlSpies);
			await expectNoTitleControlMutations(titleControlSpies);
		} finally {
			live.status = "idle";
			clearContext.mockRestore();
			newSession.mockRestore();
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

	test("clear admitted first holds model/thinking mutation until release and commits one consistent tuple", async ({ gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const live = gateway.sessionManager.getSession(sessionId);
		const persistedBefore = gateway.sessionManager.getPersistedSession(sessionId);
		expect(live).toBeTruthy();
		expect(persistedBefore?.effectiveThinkingLevel).toEqual(expect.any(String));
		const clearGate = deferred<void>();
		const clearContext = vi.spyOn(gateway.sessionManager, "clearContext").mockImplementation(async () => clearGate.promise);
		const setThinkingLevel = vi.spyOn(live.rpcClient, "setThinkingLevel");
		const compact = vi.spyOn(live.rpcClient, "compact").mockResolvedValue({ success: true, data: {} });
		const persistSessionModel = vi.spyOn(gateway.sessionManager, "persistSessionModel");
		const clearConn = await connectWs(sessionId);
		const settingsConn = await connectWs(sessionId);
		try {
			clearConn.send({ type: "clear" });
			await vi.waitFor(() => expect(clearContext).toHaveBeenCalledTimes(1));
			settingsConn.send({ type: "set_thinking_level", level: persistedBefore!.effectiveThinkingLevel });
			settingsConn.send({ type: "compact" });
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(setThinkingLevel).not.toHaveBeenCalled();
			expect(compact).not.toHaveBeenCalled();
			expect(persistSessionModel).not.toHaveBeenCalled();

			clearGate.resolve(undefined);
			await vi.waitFor(() => expect(persistSessionModel).toHaveBeenCalledTimes(1), { timeout: 5_000 });
			await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1), { timeout: 5_000 });
			const persistedAfter = gateway.sessionManager.getPersistedSession(sessionId);
			const runtimeState = await live.rpcClient.getState();
			expect(runtimeState.success).toBe(true);
			expect({
				provider: runtimeState.data?.model?.provider,
				modelId: runtimeState.data?.model?.id,
				thinkingLevel: runtimeState.data?.thinkingLevel,
			}).toEqual({
				provider: persistedAfter?.modelProvider,
				modelId: persistedAfter?.modelId,
				thinkingLevel: persistedAfter?.effectiveThinkingLevel,
			});
		} finally {
			clearGate.resolve(undefined);
			clearContext.mockRestore();
			setThinkingLevel.mockRestore();
			compact.mockRestore();
			persistSessionModel.mockRestore();
			clearConn.close();
			settingsConn.close();
			await deleteSession(sessionId);
		}
	});

	test("thinking mutation admitted first rejects clear until its complete tuple commits", async ({ gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const live = gateway.sessionManager.getSession(sessionId);
		const persisted = gateway.sessionManager.getPersistedSession(sessionId);
		expect(live).toBeTruthy();
		expect(persisted?.effectiveThinkingLevel).toEqual(expect.any(String));
		const thinkingGate = deferred<void>();
		const originalSetThinking = live.rpcClient.setThinkingLevel.bind(live.rpcClient);
		const setThinkingLevel = vi.spyOn(live.rpcClient, "setThinkingLevel").mockImplementation(async (...args: any[]) => {
			await thinkingGate.promise;
			return originalSetThinking(...args);
		});
		const persistSessionModel = vi.spyOn(gateway.sessionManager, "persistSessionModel");
		const clearContext = vi.spyOn(gateway.sessionManager, "clearContext").mockResolvedValue(undefined);
		const settingsConn = await connectWs(sessionId);
		const clearConn = await connectWs(sessionId);
		try {
			settingsConn.send({ type: "set_thinking_level", level: persisted!.effectiveThinkingLevel });
			await vi.waitFor(() => expect(setThinkingLevel).toHaveBeenCalledTimes(1));
			await expectPolicyError(clearConn, { type: "clear" }, "CLEAR_ACTIVE");
			expect(clearContext).not.toHaveBeenCalled();

			thinkingGate.resolve(undefined);
			await vi.waitFor(() => expect(persistSessionModel).toHaveBeenCalledTimes(1), { timeout: 5_000 });
			clearConn.send({ type: "clear" });
			await vi.waitFor(() => expect(clearContext).toHaveBeenCalledTimes(1));
		} finally {
			thinkingGate.resolve(undefined);
			setThinkingLevel.mockRestore();
			persistSessionModel.mockRestore();
			clearContext.mockRestore();
			settingsConn.close();
			clearConn.close();
			await deleteSession(sessionId);
		}
	});

	test("manual compact admitted first rejects clear through finalization, then releases admission", async ({ gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const live = gateway.sessionManager.getSession(sessionId);
		expect(live).toBeTruthy();
		const compactGate = deferred<any>();
		const finalizationGate = deferred<void>();
		const compact = vi.spyOn(live.rpcClient, "compact").mockImplementation(async () => compactGate.promise);
		const originalFinish = gateway.sessionManager.finishCompactionAndRelease.bind(gateway.sessionManager);
		const finish = vi.spyOn(gateway.sessionManager, "finishCompactionAndRelease").mockImplementation(async (...args: any[]) => {
			await finalizationGate.promise;
			return originalFinish(...args);
		});
		const clearContext = vi.spyOn(gateway.sessionManager, "clearContext").mockResolvedValue(undefined);
		const compactConn = await connectWs(sessionId);
		const clearConn = await connectWs(sessionId);
		try {
			compactConn.send({ type: "compact" });
			await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
			await expectPolicyError(clearConn, { type: "clear" }, "CLEAR_ACTIVE");
			expect(clearContext).not.toHaveBeenCalled();

			compactGate.resolve({ success: true, data: {} });
			await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
			await expectPolicyError(clearConn, { type: "clear" }, "CLEAR_ACTIVE");
			expect(clearContext).not.toHaveBeenCalled();
			finalizationGate.resolve(undefined);
			await vi.waitFor(() => expect(live.isCompacting).toBe(false));
			clearConn.send({ type: "clear" });
			await vi.waitFor(() => expect(clearContext).toHaveBeenCalledTimes(1));
		} finally {
			compactGate.resolve({ success: true, data: {} });
			finalizationGate.resolve(undefined);
			compact.mockRestore();
			finish.mockRestore();
			clearContext.mockRestore();
			compactConn.close();
			clearConn.close();
			await deleteSession(sessionId);
		}
	});

	test("read-only capability admits set_model only through active model-selection recovery", async ({ gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const live = gateway.sessionManager.getSession(sessionId);
		expect(live).toBeTruthy();
		persistPolicy(gateway, sessionId, { readOnly: true });
		live.condition = MODEL_SELECTION_CONDITION;

		const conn = await connectWs(sessionId);
		const recoverModelSelection = vi.spyOn(gateway.sessionManager, "recoverModelSelectionRequired")
			.mockResolvedValue(undefined);
		const modelControlSpies = spyOnModelControlMutations(gateway, live);
		try {
			conn.send({
				type: "set_model",
				provider: "anthropic",
				modelId: "claude-sonnet-4-20250514",
				thinkingLevel: "high",
			});
			await vi.waitFor(() => expect(recoverModelSelection).toHaveBeenCalledWith(
				sessionId,
				"anthropic",
				"claude-sonnet-4-20250514",
				"high",
			), { timeout: 2_000 });
			expectNoModelControlMutations(modelControlSpies);
		} finally {
			live.condition = undefined;
			recoverModelSelection.mockRestore();
			restoreModelControlSpies(modelControlSpies);
			conn.close();
			await deleteSession(sessionId);
		}
	});

	test("read-only capability still blocks ordinary set_model without a recovery condition", async ({ gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const live = gateway.sessionManager.getSession(sessionId);
		expect(live).toBeTruthy();
		persistPolicy(gateway, sessionId, { readOnly: true });

		const conn = await connectWs(sessionId);
		const recoverModelSelection = vi.spyOn(gateway.sessionManager, "recoverModelSelectionRequired");
		const modelControlSpies = spyOnModelControlMutations(gateway, live);
		try {
			await expectPolicyError(conn, {
				type: "set_model",
				provider: "anthropic",
				modelId: "claude-sonnet-4-20250514",
			}, "SESSION_READ_ONLY");
			expect(recoverModelSelection).not.toHaveBeenCalled();
			expectNoModelControlMutations(modelControlSpies);
		} finally {
			recoverModelSelection.mockRestore();
			restoreModelControlSpies(modelControlSpies);
			conn.close();
			await deleteSession(sessionId);
		}
	});

	test("non-interactive policy blocks read-only model-selection recovery", async ({ gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const live = gateway.sessionManager.getSession(sessionId);
		expect(live).toBeTruthy();
		persistPolicy(gateway, sessionId, { readOnly: true, nonInteractive: true });
		live.condition = MODEL_SELECTION_CONDITION;

		const conn = await connectWs(sessionId);
		const recoverModelSelection = vi.spyOn(gateway.sessionManager, "recoverModelSelectionRequired");
		const modelControlSpies = spyOnModelControlMutations(gateway, live);
		try {
			await expectPolicyError(conn, {
				type: "set_model",
				provider: "anthropic",
				modelId: "claude-sonnet-4-20250514",
			}, "NON_INTERACTIVE_WORK_CONTROL");
			expect(recoverModelSelection).not.toHaveBeenCalled();
			expectNoModelControlMutations(modelControlSpies);
		} finally {
			live.condition = undefined;
			recoverModelSelection.mockRestore();
			restoreModelControlSpies(modelControlSpies);
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
