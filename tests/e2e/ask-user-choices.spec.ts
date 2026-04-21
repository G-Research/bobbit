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
 *     `{ ok: true, alreadySubmitted: true }` and does not append again.
 *  3. 404 when no matching tool_use is in the transcript.
 *  4. 400 on malformed answers.
 *  5. Legacy `POST /api/internal/user-question` endpoint is gone (404).
 *  6. Legacy `GET /api/internal/user-question/pending` endpoint is gone (404).
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	base,
	connectWs,
	createSession,
	deleteSession,
	messageEndPredicate,
	readE2EToken,
	toolStartPredicate,
} from "./e2e-setup.js";

async function postSubmit(sessionId: string, toolUseId: string, answers: any) {
	return fetch(`${base()}/api/internal/user-question/submit`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${readE2EToken()}` },
		body: JSON.stringify({ sessionId, toolUseId, answers }),
	});
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
				const submitResp = await postSubmit(sessionId, toolUseId, answers);
				expect(submitResp.status).toBe(200);
				expect(await submitResp.json()).toEqual({ ok: true });

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
