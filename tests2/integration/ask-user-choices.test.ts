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
import { test, expect } from "./_e2e/in-process-harness.js";
import { gatewaySync } from "./_e2e/runtime.js";
import {
	apiFetch,
	base,
	connectWs,
	createSession,
	deleteSession,
	messageEndPredicate,
	readE2EToken,
	toolStartPredicate,
} from "./_e2e/e2e-setup.js";

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

async function postAsk(conn: Awaited<ReturnType<typeof connectWs>>): Promise<string> {
	const cursor = conn.messageCount();
	conn.send({ type: "prompt", text: "please use ask_user_choices" });
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
