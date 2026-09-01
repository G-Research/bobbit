/**
 * E2E API tests for the non-blocking ask_user_choices flow.
 *
 * The tool extension now returns a stub `{status:"posted",tool_use_id}` result
 * immediately. The UI widget POSTs user answers to
 * `POST /api/internal/user-question/submit`, which appends a
 * `[ask_user_choices_response tool_use_id=...]` envelope user message to the
 * session transcript via the normal prompt path.
 *
 * Covers:
 *  1. Happy path: /submit appends the envelope; the mock agent wakes and
 *     echoes the answers as an assistant message.
 *  2. Idempotency: a second /submit for the same toolUseId returns
 *     `{ ok: true, alreadySubmitted: true }` and does not append again,
 *     including transcript-fallback detection for composite tool IDs.
 *  3. 404 when no matching tool_use is in the transcript.
 *  4. 400 on malformed answers.
 *  5. Legacy `POST /api/internal/user-question` endpoint is gone (404).
 *  6. Legacy `GET /api/internal/user-question/pending` endpoint is gone (404).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { test, expect } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import { gatewaySync } from "../../../tests/support/harnesses/integration/gateway/runtime.js";
import {
	apiFetch,
	base,
	connectWs,
	createSession,
	deleteSession,
	messageEndPredicate,
	readE2EToken,
	registerProject,
	toolStartPredicate,
} from "../../../tests/support/harnesses/integration/gateway/e2e-setup.js";

async function postSubmit(sessionId: string, toolUseId: string, answers: any) {
	return fetch(`${base()}/api/internal/user-question/submit`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${readE2EToken()}` },
		body: JSON.stringify({ sessionId, toolUseId, answers }),
	});
}

async function postDismiss(sessionId: string, toolUseId: string) {
	return fetch(`${base()}/api/internal/user-question/dismiss`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${readE2EToken()}` },
		body: JSON.stringify({ sessionId, toolUseId }),
	});
}

async function getDismissals(sessionId: string) {
	return apiFetch(`/api/internal/user-question/dismissals?sessionId=${encodeURIComponent(sessionId)}`);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => { resolve = next; });
	return { promise, resolve };
}

type TestWsConnection = Awaited<ReturnType<typeof connectWs>>;

function blockQuestionStateFlush(sessionId: string, state: boolean) {
	const manager = gatewaySync().sessionManager;
	const store = manager.resolveStoreForId(sessionId)!;
	const originalFlush = store.flushAsync.bind(store);
	const entered = deferred<void>();
	const release = deferred<void>();
	let blocked = false;
	const spy = vi.spyOn(store, "flushAsync").mockImplementation(async () => {
		if (!blocked && store.get(sessionId)?.hasUnansweredQuestion === state) {
			blocked = true;
			entered.resolve();
			await release.promise;
		}
		return originalFlush();
	});
	return { entered, release, restore: () => spy.mockRestore() };
}

async function runQuestionStateTransition<T>(
	sessionId: string,
	projectId: string,
	state: boolean,
	uiConnections: TestWsConnection[],
	action: () => Promise<T>,
	whilePersistenceBlocked?: () => void,
): Promise<T> {
	const cursors = uiConnections.map(conn => conn.messageCount());
	const barrier = blockQuestionStateFlush(sessionId, state);
	let pending: Promise<T> | undefined;
	try {
		pending = action();
		await barrier.entered.promise;
		await new Promise<void>(resolve => setImmediate(resolve));
		for (let index = 0; index < uiConnections.length; index++) {
			expect(uiConnections[index]!.messages.slice(cursors[index]).filter(message =>
				message.type === "sessions_changed" && message.sessionId === sessionId
			)).toEqual([]);
		}
		whilePersistenceBlocked?.();

		barrier.release.resolve();
		const result = await pending;
		const events = await Promise.all(uiConnections.map((conn, index) => conn.waitForFrom(
			cursors[index]!,
			message => message.type === "sessions_changed" && message.sessionId === sessionId,
			10_000,
		)));
		for (const event of events) {
			expect(event).toEqual({ type: "sessions_changed", sessionId, projectId });
		}
		expect(gatewaySync().sessionManager.getPersistedSession(sessionId)?.hasUnansweredQuestion).toBe(state);
		return result;
	} finally {
		barrier.release.resolve();
		if (pending) await pending.catch(() => undefined);
		barrier.restore();
		await gatewaySync().sessionManager.resolveStoreForId(sessionId)?.flushAsync();
	}
}

async function postAsk(conn: TestWsConnection, prompt = "please use ask_user_choices"): Promise<string> {
	const cursor = conn.messageCount();
	conn.send({ type: "prompt", text: prompt });
	await conn.waitForFrom(cursor, toolStartPredicate("ask_user_choices"), 10_000);
	const stubResult = await conn.waitForFrom(
		cursor,
		(m) => messageEndPredicate("toolResult")(m)
			&& m.data?.message?.toolName === "ask_user_choices",
		15_000,
	);
	const toolUseId = JSON.parse(stubResult.data.message.content[0].text).tool_use_id as string;
	await conn.waitForFrom(
		cursor,
		(m) => m.type === "session_status" && (m as any).status === "idle",
		10_000,
	);
	return toolUseId;
}

function messageText(message: any): string | undefined {
	if (typeof message?.content === "string") return message.content;
	return message?.content?.find?.((block: any) => block?.type === "text")?.text;
}

test.describe("ask_user_choices non-blocking REST", () => {
	test("legacy /api/internal/user-question POST is removed (404)", async () => {
		const sessionId = await createSession();
		try {
			const r = await apiFetch("/api/internal/user-question", {
				method: "POST",
				body: JSON.stringify({ sessionId, toolUseId: "t", questions: [{ question: "Q", options: ["a", "b"] }] }),
			});
			expect(r.status).toBe(404);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("legacy /api/internal/user-question/pending GET is removed (404)", async () => {
		const sessionId = await createSession();
		try {
			const r = await apiFetch(`/api/internal/user-question/pending?sessionId=${sessionId}`);
			expect(r.status).toBe(404);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("/submit with malformed answers → 400", async () => {
		const sessionId = await createSession();
		try {
			const r = await postSubmit(sessionId, "any-tool-id", "not-an-array");
			expect(r.status).toBe(400);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("/submit with no matching tool_use in transcript → 404", async () => {
		const sessionId = await createSession();
		try {
			const r = await postSubmit(sessionId, "nonexistent-tool-id", [
				{ question: "Q", selected: "a", other_text: null },
			]);
			expect(r.status).toBe(404);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("/submit with unknown session → 404", async () => {
		const r = await postSubmit("no-such-session", "t", []);
		expect(r.status).toBe(404);
	});

	test("dismissal routes validate sessions and matching ask calls", async () => {
		const missingQuery = await apiFetch("/api/internal/user-question/dismissals");
		expect(missingQuery.status).toBe(400);
		const unknown = await getDismissals("no-such-session");
		expect(unknown.status).toBe(404);

		const sessionId = await createSession();
		try {
			const empty = await getDismissals(sessionId);
			expect(empty.status).toBe(200);
			expect(await empty.json()).toEqual({ dismissedToolUseIds: [] });
			const noCall = await postDismiss(sessionId, "not-an-ask");
			expect(noCall.status).toBe(404);
		} finally {
			await deleteSession(sessionId);
		}
	});
});

test.describe("ask_user_choices end-to-end via mock agent", () => {
	test("agent posts widget, /submit appends envelope, agent wakes and echoes answers", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				// Trigger the mock agent's ask_user_choices branch. The tool returns
				// immediately (non-blocking) with a `{status:"posted"}` stub.
				conn.send({ type: "prompt", text: "please use ask_user_choices" });

				// Wait for tool start + the stub toolResult message_end.
				await conn.waitFor(toolStartPredicate("ask_user_choices"), 10_000);
				const stubResult = await conn.waitFor(
					(m) => messageEndPredicate("toolResult")(m)
						&& m.data?.message?.toolName === "ask_user_choices",
					15_000,
				);
				const stubText = stubResult.data?.message?.content?.[0]?.text || "";
				const parsed = JSON.parse(stubText);
				expect(parsed.status).toBe("posted");
				const toolUseId = parsed.tool_use_id as string;
				expect(toolUseId).toBeTruthy();

				// Agent should go idle.
				await conn.waitFor(
					(m) => m.type === "session_status" && (m as any).status === "idle",
					10_000,
				);

				// Submit answers.
				const answers = [
					{ question: "Favorite color?", selected: "blue", other_text: null },
					{ question: "Team size?", selected: "Other", other_text: "tiny" },
				];
				const answerCursor = conn.messageCount();
				const submitResp = await postSubmit(sessionId, toolUseId, answers);
				expect(submitResp.status).toBe(200);
				expect(await submitResp.json()).toEqual({ ok: true });
				await conn.waitForFrom(
					answerCursor,
					(m) => m.type === "sessions_changed" && m.sessionId === sessionId,
					10_000,
				);
				const answeredList = await apiFetch("/api/sessions");
				const answeredRows = (await answeredList.json()).sessions;
				expect(answeredRows.find((row: any) => row.id === sessionId)?.hasUnansweredQuestion).toBe(false);

				// Agent wakes on the envelope user message and echoes a response.
				const echo = await conn.waitFor(
					(m) => {
						if (!messageEndPredicate("assistant")(m)) return false;
						const blocks = m.data?.message?.content || [];
						const text = blocks.find((b: any) => b.type === "text")?.text || "";
						return text.includes("gotAnswersFor") && text.includes(toolUseId);
					},
					10_000,
				);
				const echoText = echo.data?.message?.content?.find((b: any) => b.type === "text")?.text || "";
				const echoed = JSON.parse(echoText);
				expect(echoed.gotAnswersFor).toBe(toolUseId);
				expect(echoed.answers).toEqual(answers);
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("question-state and dismissal egress reaches UI principals only after persistence", async () => {
		const victimSessionId = await createSession();
		const sandboxRoot = join(gatewaySync().bobbitDir, `ask-egress-${randomUUID()}`);
		mkdirSync(sandboxRoot, { recursive: true });
		const sandboxProject = await registerProject({
			name: `ask-egress-${randomUUID()}`,
			rootPath: sandboxRoot,
			seedWorkflows: false,
		});
		const sandboxSessionId = await createSession({ projectId: sandboxProject.id, cwd: sandboxProject.rootPath });
		expect(sandboxSessionId).not.toBe(victimSessionId);

		const manager = gatewaySync().sessionManager;
		const victimProjectId = String(manager.getPersistedSession(victimSessionId)?.projectId);
		expect(victimProjectId).not.toBe(sandboxProject.id);
		const sandboxStore = manager.sandboxTokenStore;
		const unrelatedSandboxToken = sandboxStore.register(sandboxProject.id);
		sandboxStore.addSession(sandboxProject.id, sandboxSessionId);
		const askingSandboxToken = sandboxStore.register(victimProjectId);
		sandboxStore.addSession(victimProjectId, victimSessionId);

		const [victimUiA, victimUiB, unrelatedUi, unrelatedSandbox, askingSandbox] = await Promise.all([
			connectWs(victimSessionId),
			connectWs(victimSessionId),
			connectWs(sandboxSessionId),
			connectWs(sandboxSessionId, unrelatedSandboxToken),
			connectWs(victimSessionId, askingSandboxToken),
		]);
		const uiConnections = [victimUiA, victimUiB, unrelatedUi];
		const unrelatedSandboxCursor = unrelatedSandbox.messageCount();

		try {
			const askAId = await runQuestionStateTransition(
				victimSessionId,
				victimProjectId,
				true,
				uiConnections,
				() => postAsk(victimUiA),
			);

			const answerCursor = victimUiA.messageCount();
			const answers = [
				{ question: "Favorite color?", selected: "blue", other_text: null },
				{ question: "Team size?", selected: "small", other_text: null },
			];
			const answered = await runQuestionStateTransition(
				victimSessionId,
				victimProjectId,
				false,
				uiConnections,
				() => postSubmit(victimSessionId, askAId, answers),
			);
			expect(answered.status).toBe(200);
			expect(await answered.json()).toEqual({ ok: true });
			await victimUiA.waitForFrom(
				answerCursor,
				message => messageEndPredicate("assistant")(message)
					&& JSON.stringify(message.data?.message?.content ?? "").includes(askAId),
				10_000,
			);
			await victimUiA.waitForFrom(
				answerCursor,
				message => message.type === "session_status" && message.status === "idle",
				10_000,
			);

			const askBId = await runQuestionStateTransition(
				victimSessionId,
				victimProjectId,
				true,
				uiConnections,
				() => postAsk(victimUiA),
			);
			expect(askBId).not.toBe(askAId);

			const before = await manager.getSession(victimSessionId)!.rpcClient.getMessages();
			const beforeMessages = before.data?.messages || before.data;
			const dismissalCursors = [victimUiA, victimUiB, unrelatedUi, askingSandbox]
				.map(conn => conn.messageCount());
			const dismissed = await runQuestionStateTransition(
				victimSessionId,
				victimProjectId,
				false,
				uiConnections,
				() => postDismiss(victimSessionId, askBId),
				() => {
					for (const [index, conn] of [victimUiA, victimUiB, unrelatedUi, askingSandbox].entries()) {
						expect(conn.messages.slice(dismissalCursors[index]).filter(message =>
							message.type === "ask_question_dismissed"
						)).toEqual([]);
					}
				},
			);
			expect(dismissed.status).toBe(200);
			expect(await dismissed.json()).toEqual({ ok: true });

			for (const [index, conn] of [victimUiA, victimUiB].entries()) {
				const event = await conn.waitForFrom(
					dismissalCursors[index]!,
					message => message.type === "ask_question_dismissed",
					10_000,
				);
				expect(event).toEqual({
					type: "ask_question_dismissed",
					sessionId: victimSessionId,
					toolUseId: askBId,
				});
			}

			unrelatedUi.send({ type: "ping" });
			await unrelatedUi.waitForFrom(dismissalCursors[2]!, message => message.type === "pong", 10_000);
			expect(unrelatedUi.messages.slice(dismissalCursors[2]).filter(message =>
				message.type === "ask_question_dismissed"
			)).toEqual([]);

			askingSandbox.send({ type: "ping" });
			await askingSandbox.waitForFrom(dismissalCursors[3]!, message => message.type === "pong", 10_000);
			expect(askingSandbox.messages.slice(dismissalCursors[3]).filter(message =>
				message.type === "ask_question_dismissed"
			)).toEqual([]);

			unrelatedSandbox.send({ type: "ping" });
			await unrelatedSandbox.waitForFrom(unrelatedSandboxCursor, message => message.type === "pong", 10_000);
			const unrelatedSandboxFrames = unrelatedSandbox.messages.slice(unrelatedSandboxCursor);
			expect(unrelatedSandboxFrames.filter(message =>
				message.type === "sessions_changed" && message.sessionId === victimSessionId
			)).toEqual([]);
			const serializedSandboxFrames = JSON.stringify(unrelatedSandboxFrames);
			expect(serializedSandboxFrames).not.toContain(victimSessionId);
			expect(serializedSandboxFrames).not.toContain(victimProjectId);

			const durable = await getDismissals(victimSessionId);
			expect(await durable.json()).toEqual({ dismissedToolUseIds: [askBId] });
			const after = await manager.getSession(victimSessionId)!.rpcClient.getMessages();
			const afterMessages = after.data?.messages || after.data;
			expect(afterMessages).toHaveLength(beforeMessages.length);
			expect(manager.getSession(victimSessionId)?.status).toBe("idle");
		} finally {
			victimUiA.close();
			victimUiB.close();
			unrelatedUi.close();
			unrelatedSandbox.close();
			askingSandbox.close();
			sandboxStore.removeSession(sandboxProject.id, sandboxSessionId);
			sandboxStore.removeSession(victimProjectId, victimSessionId);
			await Promise.all([
				deleteSession(victimSessionId),
				deleteSession(sandboxSessionId),
			]);
		}
	});

	test("dismiss persists, broadcasts, stays idle, updates list state, and rejects later answers", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				conn.send({ type: "prompt", text: "please use ask_user_choices" });
				await conn.waitFor(toolStartPredicate("ask_user_choices"), 10_000);
				const stubResult = await conn.waitFor(
					(m) => messageEndPredicate("toolResult")(m)
						&& m.data?.message?.toolName === "ask_user_choices",
					10_000,
				);
				const toolUseId = JSON.parse(stubResult.data.message.content[0].text).tool_use_id as string;
				await conn.waitFor((m) => m.type === "sessions_changed" && m.sessionId === sessionId, 10_000);
				await conn.waitFor((m) => m.type === "session_status" && (m as any).status === "idle", 10_000);

				const pendingList = await apiFetch("/api/sessions");
				const pendingRows = (await pendingList.json()).sessions;
				expect(pendingRows.find((row: any) => row.id === sessionId)?.hasUnansweredQuestion).toBe(true);

				const before = await gatewaySync().sessionManager.getSession(sessionId)!.rpcClient.getMessages();
				const beforeMessages = before.data?.messages || before.data;
				const dismissalCursor = conn.messageCount();
				const dismissedEvent = conn.waitForFrom(
					dismissalCursor,
					(m) => m.type === "ask_question_dismissed" && m.sessionId === sessionId && m.toolUseId === toolUseId,
					10_000,
				);
				const refreshEvent = conn.waitForFrom(
					dismissalCursor,
					(m) => m.type === "sessions_changed" && m.sessionId === sessionId,
					10_000,
				);
				const response = await postDismiss(sessionId, toolUseId);
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ ok: true });
				await dismissedEvent;
				await refreshEvent;

				const durable = await getDismissals(sessionId);
				expect(await durable.json()).toEqual({ dismissedToolUseIds: [toolUseId] });
				expect(gatewaySync().sessionManager.getPersistedSession(sessionId)?.dismissedAskToolUseIds).toEqual([toolUseId]);
				const settledList = await apiFetch("/api/sessions");
				const settledRows = (await settledList.json()).sessions;
				expect(settledRows.find((row: any) => row.id === sessionId)?.hasUnansweredQuestion).toBe(false);

				const duplicate = await postDismiss(sessionId, toolUseId);
				expect(await duplicate.json()).toEqual({ ok: true, alreadyDismissed: true });
				const rejected = await postSubmit(sessionId, toolUseId, [
					{ question: "Favorite color?", selected: "blue", other_text: null },
					{ question: "Team size?", selected: "small", other_text: null },
				]);
				expect(rejected.status).toBe(409);

				const after = await gatewaySync().sessionManager.getSession(sessionId)!.rpcClient.getMessages();
				const afterMessages = after.data?.messages || after.data;
				expect(afterMessages).toHaveLength(beforeMessages.length);
				expect(gatewaySync().sessionManager.getSession(sessionId)?.status).toBe("idle");
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});

	for (const terminal of ["dismiss", "answer"] as const) {
		test(`posted Ask B stays behind a stale Ask A ${terminal} projection`, async () => {
			const sessionId = await createSession();
			try {
				const conn = await connectWs(sessionId);
				try {
					const askAId = await postAsk(conn);
					// Drain A's fire-and-forget posted projection before arming the
					// controlled terminal read, so the blocked snapshot belongs to A.
					await gatewaySync().sessionManager.recomputeHasUnansweredQuestion(sessionId);
					const session = gatewaySync().sessionManager.getSession(sessionId)!;
					const rpcClient = session.rpcClient as any;
					const originalGetMessages = rpcClient.getMessages.bind(rpcClient);
					const originalPrompt = rpcClient.prompt.bind(rpcClient);
					const originalPromptWhenReady = rpcClient.promptWhenReady?.bind(rpcClient);
					const staleSnapshotEntered = deferred<void>();
					const releaseStaleSnapshot = deferred<void>();
					const projectionSnapshots: any[][] = [];
					const dispatchedPrompts: string[] = [];
					let terminalReads = 0;
					let armed = false;

					rpcClient.getMessages = async (...args: any[]) => {
						const snapshot = await originalGetMessages(...args);
						if (armed) {
							terminalReads += 1;
							const messages = snapshot.data?.messages || snapshot.data;
							if (Array.isArray(messages)) projectionSnapshots.push(messages);
							// The route validation is read one. Read two is the terminal
							// whole-session projection captured before Ask B exists.
							if (terminalReads === 2) {
								staleSnapshotEntered.resolve();
								await releaseStaleSnapshot.promise;
							}
						}
						return snapshot;
					};
					rpcClient.prompt = async (text: string, ...args: any[]) => {
						dispatchedPrompts.push(text);
						return originalPrompt(text, ...args);
					};
					if (originalPromptWhenReady) {
						rpcClient.promptWhenReady = async (text: string, ...args: any[]) => {
							dispatchedPrompts.push(text);
							return originalPromptWhenReady(text, ...args);
						};
					}

					const answers = [
						{ question: "Favorite color?", selected: "blue", other_text: null },
						{ question: "Team size?", selected: "small", other_text: null },
					];
					armed = true;
					const terminalResponse = terminal === "dismiss"
						? postDismiss(sessionId, askAId)
						: postSubmit(sessionId, askAId, answers);

					try {
						await staleSnapshotEntered.promise;
						const askBId = await postAsk(conn);
						expect(askBId).not.toBe(askAId);
						releaseStaleSnapshot.resolve();
						expect((await terminalResponse).status).toBe(200);

						await expect.poll(() => terminalReads, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
						await expect.poll(
							() => gatewaySync().sessionManager.getPersistedSession(sessionId)?.hasUnansweredQuestion,
							{ timeout: 10_000 },
						).toBe(true);
						const sessionList = await apiFetch("/api/sessions");
						const sessionRows = (await sessionList.json()).sessions;
						expect(sessionRows.find((row: any) => row.id === sessionId)?.hasUnansweredQuestion).toBe(true);
						expect(projectionSnapshots.some(snapshot => JSON.stringify(snapshot).includes(askBId))).toBe(true);

						const transcript = await originalGetMessages();
						const messages = transcript.data?.messages || transcript.data;
						const askAEnvelopes = messages.filter((message: any) =>
							messageText(message)?.startsWith(`[ask_user_choices_response tool_use_id=${askAId}]`)
						);
						expect(askAEnvelopes).toHaveLength(terminal === "answer" ? 1 : 0);
						expect(messages.some((message: any) =>
							messageText(message)?.startsWith(`[ask_user_choices_response tool_use_id=${askBId}]`)
						)).toBe(false);
						const askAEnvelopeDispatches = dispatchedPrompts.filter(text =>
							text.startsWith(`[ask_user_choices_response tool_use_id=${askAId}]`)
						);
						expect(askAEnvelopeDispatches).toHaveLength(terminal === "answer" ? 1 : 0);
						const dismissals = await getDismissals(sessionId).then(response => response.json());
						expect(dismissals.dismissedToolUseIds).toEqual(terminal === "dismiss" ? [askAId] : []);

						// A structurally valid but question-mismatched answer reaches B's
						// cross-validation and returns 400, proving B is still actionable
						// without resolving it or waking the agent.
						const actionable = await postSubmit(sessionId, askBId, [
							{ question: "Favorite color?", selected: "blue", other_text: null },
						]);
						expect(actionable.status).toBe(400);
						expect(gatewaySync().sessionManager.getPersistedSession(sessionId)?.hasUnansweredQuestion).toBe(true);
					} finally {
						releaseStaleSnapshot.resolve();
						rpcClient.getMessages = originalGetMessages;
						rpcClient.prompt = originalPrompt;
						if (originalPromptWhenReady) rpcClient.promptWhenReady = originalPromptWhenReady;
					}
				} finally {
					conn.close();
				}
			} finally {
				await deleteSession(sessionId);
			}
		});
	}

	for (const firstTerminal of ["answer", "dismiss"] as const) {
		test(`cross-card ${firstTerminal}-first terminal snapshots converge durably`, async () => {
			const sessionId = await createSession();
			try {
				const conn = await connectWs(sessionId);
				try {
					const answerToolUseId = await postAsk(conn);
					const dismissToolUseId = await postAsk(conn);
					expect(dismissToolUseId).not.toBe(answerToolUseId);

					const session = gatewaySync().sessionManager.getSession(sessionId)!;
					const rpcClient = session.rpcClient as any;
					const originalGetMessages = rpcClient.getMessages.bind(rpcClient);
					const originalPrompt = rpcClient.prompt.bind(rpcClient);
					const originalPromptWhenReady = rpcClient.promptWhenReady?.bind(rpcClient);
					const entered = [deferred<void>(), deferred<void>()];
					const releases = [deferred<void>(), deferred<void>()];
					const dispatchedPrompts: string[] = [];
					let capturedSnapshots = 0;
					rpcClient.getMessages = async (...args: any[]) => {
						const snapshot = await originalGetMessages(...args);
						const index = capturedSnapshots++;
						if (index < 2) {
							entered[index]!.resolve();
							await releases[index]!.promise;
						}
						return snapshot;
					};
					rpcClient.prompt = async (text: string, ...args: any[]) => {
						dispatchedPrompts.push(text);
						return originalPrompt(text, ...args);
					};
					if (originalPromptWhenReady) {
						rpcClient.promptWhenReady = async (text: string, ...args: any[]) => {
							dispatchedPrompts.push(text);
							return originalPromptWhenReady(text, ...args);
						};
					}

					const answers = [
						{ question: "Favorite color?", selected: "blue", other_text: null },
						{ question: "Team size?", selected: "small", other_text: null },
					];
					const begin = (terminal: "answer" | "dismiss") => terminal === "answer"
						? postSubmit(sessionId, answerToolUseId, answers)
						: postDismiss(sessionId, dismissToolUseId);
					const secondTerminal = firstTerminal === "answer" ? "dismiss" : "answer";
					const eventCursor = conn.messageCount();

					try {
						const firstResponse = begin(firstTerminal);
						await entered[0]!.promise;
						const secondResponse = begin(secondTerminal);
						await entered[1]!.promise;
						// Both route-level transcript snapshots now predate either terminal
						// mutation. Release them one at a time to pin both operation orders.
						releases[0]!.resolve();
						expect((await firstResponse).status).toBe(200);
						releases[1]!.resolve();
						expect((await secondResponse).status).toBe(200);
					} finally {
						releases[0]!.resolve();
						releases[1]!.resolve();
						rpcClient.getMessages = originalGetMessages;
						rpcClient.prompt = originalPrompt;
						if (originalPromptWhenReady) rpcClient.promptWhenReady = originalPromptWhenReady;
					}

					await conn.waitForFrom(
						eventCursor,
						(m) => messageEndPredicate("assistant")(m)
							&& JSON.stringify(m.data?.message?.content ?? "").includes(answerToolUseId),
						10_000,
					);
					await conn.waitForFrom(
						eventCursor,
						(m) => m.type === "session_status" && (m as any).status === "idle",
						10_000,
					);

					const durable = await getDismissals(sessionId).then(response => response.json());
					expect(durable).toEqual({ dismissedToolUseIds: [dismissToolUseId] });
					const transcript = await session.rpcClient.getMessages();
					const messages = transcript.data?.messages || transcript.data;
					const answerEnvelopes = messages.filter((message: any) =>
						messageText(message)?.startsWith(`[ask_user_choices_response tool_use_id=${answerToolUseId}]`)
					);
					expect(answerEnvelopes).toHaveLength(1);
					expect(messages.some((message: any) =>
						messageText(message)?.startsWith(`[ask_user_choices_response tool_use_id=${dismissToolUseId}]`)
					)).toBe(false);
					expect(dispatchedPrompts).toHaveLength(1);
					expect(dispatchedPrompts[0]?.startsWith(
						`[ask_user_choices_response tool_use_id=${answerToolUseId}]`,
					)).toBe(true);

					const settledList = await apiFetch("/api/sessions");
					const settledRows = (await settledList.json()).sessions;
					expect(settledRows.find((row: any) => row.id === sessionId)?.hasUnansweredQuestion).toBe(false);
				} finally {
					conn.close();
				}
			} finally {
				await deleteSession(sessionId);
			}
		});
	}

	test("concurrent answer and dismissal linearize to exactly one terminal winner", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				conn.send({ type: "prompt", text: "please use ask_user_choices" });
				await conn.waitFor(toolStartPredicate("ask_user_choices"), 10_000);
				const stubResult = await conn.waitFor(
					(m) => messageEndPredicate("toolResult")(m)
						&& m.data?.message?.toolName === "ask_user_choices",
					10_000,
				);
				const toolUseId = JSON.parse(stubResult.data.message.content[0].text).tool_use_id as string;
				await conn.waitFor((m) => m.type === "session_status" && (m as any).status === "idle", 10_000);
				const answers = [
					{ question: "Favorite color?", selected: "blue", other_text: null },
					{ question: "Team size?", selected: "small", other_text: null },
				];

				const [submit, dismiss] = await Promise.all([
					postSubmit(sessionId, toolUseId, answers),
					postDismiss(sessionId, toolUseId),
				]);
				expect([submit.status, dismiss.status].sort((a, b) => a - b)).toEqual([200, 409]);

				const dismissalState = await getDismissals(sessionId).then(response => response.json());
				const transcript = await gatewaySync().sessionManager.getSession(sessionId)!.rpcClient.getMessages();
				const messages = transcript.data?.messages || transcript.data;
				const envelopeCount = messages.filter((message: any) => {
					const content = typeof message?.content === "string"
						? message.content
						: message?.content?.find?.((block: any) => block?.type === "text")?.text;
					return typeof content === "string" && content.startsWith(`[ask_user_choices_response tool_use_id=${toolUseId}]`);
				}).length;
				if (submit.status === 200) {
					expect(dismissalState.dismissedToolUseIds).not.toContain(toolUseId);
					expect(envelopeCount).toBe(1);
				} else {
					expect(dismissalState.dismissedToolUseIds).toContain(toolUseId);
					expect(envelopeCount).toBe(0);
				}
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("duplicate /submit returns alreadySubmitted:true without re-appending", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				conn.send({ type: "prompt", text: "please use ask_user_choices" });
				await conn.waitFor(toolStartPredicate("ask_user_choices"), 10_000);
				const stubResult = await conn.waitFor(
					(m) => messageEndPredicate("toolResult")(m)
						&& m.data?.message?.toolName === "ask_user_choices",
					10_000,
				);
				const toolUseId = JSON.parse(stubResult.data.message.content[0].text).tool_use_id;

				const answers = [
					{ question: "Favorite color?", selected: "red", other_text: null },
					{ question: "Team size?", selected: "small", other_text: null },
				];
				const first = await postSubmit(sessionId, toolUseId, answers);
				expect(first.status).toBe(200);
				expect(await first.json()).toEqual({ ok: true });

				const second = await postSubmit(sessionId, toolUseId, answers);
				expect(second.status).toBe(200);
				expect(await second.json()).toEqual({ ok: true, alreadySubmitted: true });
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("queued answer evidence survives terminal-guard loss before transcript echo", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				const submitToolUseId = await postAsk(conn, "please use ask_user_choices_composite");
				const dismissToolUseId = await postAsk(conn, "please use ask_user_choices_composite");
				expect(submitToolUseId).toContain("|");
				expect(dismissToolUseId).toContain("|");

				const answers = [
					{ question: "Favorite color?", selected: "red", other_text: null },
					{ question: "Team size?", selected: "small", other_text: null },
				];
				const manager = gatewaySync().sessionManager;
				const session = manager.getSession(sessionId)!;
				const queuedEnvelopes = [submitToolUseId, dismissToolUseId].map(toolUseId =>
					`[ask_user_choices_response tool_use_id=${toolUseId}]\n${JSON.stringify({ answers })}`
				);
				// Model a restored durable queue without touching the fresh process-local
				// terminal guard: neither envelope has reached the transcript yet.
				for (const envelope of queuedEnvelopes) session.promptQueue.enqueue(envelope);
				(manager as any).broadcastQueue(session);
				await manager.resolveStoreForId(sessionId)!.flushAsync();
				const setupCursor = conn.messageCount();
				await manager.recomputeHasUnansweredQuestion(sessionId);
				conn.send({ type: "ping" });
				await conn.waitForFrom(setupCursor, message => message.type === "pong", 10_000);
				expect(manager.getPersistedSession(sessionId)?.messageQueue?.map((row: { text: string }) => row.text)).toEqual(queuedEnvelopes);

				const rpcClient = session.rpcClient as any;
				const promptSpy = vi.spyOn(rpcClient, "prompt");
				const steerSpy = vi.spyOn(rpcClient, "steer");
				const eventCursor = conn.messageCount();
				const beforeTranscript = await rpcClient.getMessages();
				const beforeMessages = beforeTranscript.data?.messages || beforeTranscript.data;

				const duplicate = await postSubmit(sessionId, submitToolUseId, answers);
				expect(duplicate.status).toBe(200);
				expect(await duplicate.json()).toEqual({ ok: true, alreadySubmitted: true });
				const dismissed = await postDismiss(sessionId, dismissToolUseId);
				expect(dismissed.status).toBe(409);
				expect(await dismissed.json()).toEqual({ error: "Question was already answered" });

				conn.send({ type: "ping" });
				await conn.waitForFrom(eventCursor, message => message.type === "pong", 10_000);
				expect(conn.messages.slice(eventCursor).filter(message =>
					message.type === "ask_question_dismissed"
					|| message.type === "queue_update"
					|| message.type === "sessions_changed"
					|| message.type === "session_status"
					|| message.type === "event"
				)).toEqual([]);
				expect(promptSpy).not.toHaveBeenCalled();
				expect(steerSpy).not.toHaveBeenCalled();
				expect(session.status).toBe("idle");
				expect(session.promptQueue.toArray().map((row: { text: string }) => row.text)).toEqual(queuedEnvelopes);
				expect(await getDismissals(sessionId).then(response => response.json())).toEqual({ dismissedToolUseIds: [] });
				const afterTranscript = await rpcClient.getMessages();
				const afterMessages = afterTranscript.data?.messages || afterTranscript.data;
				expect(afterMessages).toEqual(beforeMessages);
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("composite toolUseId transcript-fallback idempotency returns alreadySubmitted:true", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				conn.send({ type: "prompt", text: "please use ask_user_choices_composite" });
				await conn.waitFor(toolStartPredicate("ask_user_choices"), 10_000);
				const stubResult = await conn.waitFor(
					(m) => messageEndPredicate("toolResult")(m)
						&& m.data?.message?.toolName === "ask_user_choices",
					10_000,
				);
				const toolUseId = JSON.parse(stubResult.data.message.content[0].text).tool_use_id as string;
				expect(toolUseId).toContain("|");

				await conn.waitFor(
					(m) => m.type === "session_status" && (m as any).status === "idle",
					10_000,
				);

				const answers = [
					{ question: "Favorite color?", selected: "green", other_text: null },
					{ question: "Team size?", selected: "medium", other_text: null },
				];
				const envelope = `[ask_user_choices_response tool_use_id=${toolUseId}]\n${JSON.stringify({ answers })}`;
				conn.send({ type: "prompt", text: envelope });

				// The mock parser must also accept the composite id and echo it back.
				const echo = await conn.waitFor(
					(m) => {
						if (!messageEndPredicate("assistant")(m)) return false;
						const blocks = m.data?.message?.content || [];
						const text = blocks.find((b: any) => b.type === "text")?.text || "";
						return text.includes("gotAnswersFor") && text.includes(toolUseId);
					},
					10_000,
				);
				const echoText = echo.data?.message?.content?.find((b: any) => b.type === "text")?.text || "";
				expect(JSON.parse(echoText).gotAnswersFor).toBe(toolUseId);

				await conn.waitFor(
					(m) => m.type === "session_status" && (m as any).status === "idle",
					10_000,
				);

				// This submit has no in-memory dedup flag, so it must be caught by
				// findAskResponseAnswers scanning the transcript envelope above.
				const second = await postSubmit(sessionId, toolUseId, answers);
				expect(second.status).toBe(200);
				expect(await second.json()).toEqual({ ok: true, alreadySubmitted: true });
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("multi-select answers round-trip through the envelope", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				conn.send({ type: "prompt", text: "please use ask_user_choices_multi" });
				await conn.waitFor(toolStartPredicate("ask_user_choices"), 10_000);
				const stubResult = await conn.waitFor(
					(m) => messageEndPredicate("toolResult")(m)
						&& m.data?.message?.toolName === "ask_user_choices",
					10_000,
				);
				const toolUseId = JSON.parse(stubResult.data.message.content[0].text).tool_use_id;

				const answers = [
					{ question: "Which colors?", selected: ["red", "blue"], other_text: null },
					{ question: "Team size?", selected: "small", other_text: null },
				];
				const submitResp = await postSubmit(sessionId, toolUseId, answers);
				expect(submitResp.status).toBe(200);

				const echo = await conn.waitFor(
					(m) => {
						if (!messageEndPredicate("assistant")(m)) return false;
						const blocks = m.data?.message?.content || [];
						const text = blocks.find((b: any) => b.type === "text")?.text || "";
						return text.includes("gotAnswersFor") && text.includes(toolUseId);
					},
					10_000,
				);
				const echoText = echo.data?.message?.content?.find((b: any) => b.type === "text")?.text || "";
				const parsed = JSON.parse(echoText);
				expect(Array.isArray(parsed.answers[0].selected)).toBe(true);
				expect(parsed.answers[0].selected).toEqual(["red", "blue"]);
				expect(parsed.answers[1].selected).toBe("small");
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("/submit with mismatched answers (single-select submitted as array) → 400", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				conn.send({ type: "prompt", text: "please use ask_user_choices" });
				await conn.waitFor(toolStartPredicate("ask_user_choices"), 10_000);
				const stubResult = await conn.waitFor(
					(m) => messageEndPredicate("toolResult")(m)
						&& m.data?.message?.toolName === "ask_user_choices",
					10_000,
				);
				const toolUseId = JSON.parse(stubResult.data.message.content[0].text).tool_use_id;

				// Single-select question submitted with an array → cross-validate fails.
				const bad = [
					{ question: "Favorite color?", selected: ["blue"], other_text: null },
					{ question: "Team size?", selected: "small", other_text: null },
				];
				const r = await postSubmit(sessionId, toolUseId, bad);
				expect(r.status).toBe(400);
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});
});
