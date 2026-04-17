/**
 * E2E API tests for the ask_user_choices blocking round-trip.
 *
 * Covers:
 *  1. Direct REST round-trip: POST /api/internal/user-question blocks until
 *     POST /api/internal/user-question/submit resolves it; answers round-trip.
 *  2. GET /api/internal/user-question/pending rehydrates pending entries.
 *  3. Submit with unknown (sessionId, toolUseId) → 404.
 *  4. Invalid question shape → 400.
 *  5. Unknown session → 404 from the blocking endpoint.
 *  6. Session termination rejects the pending blocking request.
 *  7. End-to-end via the mock agent: agent calls ask_user_choices, test submits
 *     answers, assert the tool_result round-trips.
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

async function postInternal(path: string, body: any): Promise<Response> {
	return apiFetch(path, { method: "POST", body: JSON.stringify(body) });
}

test.describe("ask_user_choices REST round-trip", () => {
	test("blocking POST resolves when /submit is called with answers", async () => {
		const sessionId = await createSession();
		try {
			const toolUseId = `tool-ask-${Date.now()}-1`;
			const questions = [
				{ question: "Color?", options: ["red", "blue", "green"] },
				{ question: "Size?",  options: ["s", "m", "l"], allow_other: true },
			];

			// Fire the blocking request (do NOT await yet).
			const blockingP = postInternal("/api/internal/user-question", { sessionId, toolUseId, questions });

			// Poll /pending until the entry appears.
			let pendingList: any[] = [];
			for (let i = 0; i < 50; i++) {
				const r = await apiFetch(`/api/internal/user-question/pending?sessionId=${sessionId}`);
				expect(r.ok).toBe(true);
				pendingList = (await r.json()).pending;
				if (pendingList.length > 0) break;
				await new Promise(r => setTimeout(r, 50));
			}
			expect(pendingList).toHaveLength(1);
			expect(pendingList[0].toolUseId).toBe(toolUseId);
			expect(pendingList[0].questions).toHaveLength(2);

			// Submit answers.
			const answers = [
				{ question: "Color?", selected: "blue", other_text: null },
				{ question: "Size?",  selected: "Other", other_text: "custom" },
			];
			const submitResp = await postInternal("/api/internal/user-question/submit", {
				sessionId, toolUseId, answers,
			});
			expect(submitResp.status).toBe(200);
			expect(await submitResp.json()).toEqual({ ok: true });

			// The blocking request should now resolve with the answers.
			const blockingResp = await blockingP;
			expect(blockingResp.status).toBe(200);
			expect(await blockingResp.json()).toEqual({ answers });

			// Pending list is empty.
			const r2 = await apiFetch(`/api/internal/user-question/pending?sessionId=${sessionId}`);
			expect((await r2.json()).pending).toEqual([]);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("submit with unknown toolUseId → 404", async () => {
		const sessionId = await createSession();
		try {
			const resp = await postInternal("/api/internal/user-question/submit", {
				sessionId, toolUseId: "does-not-exist", answers: [],
			});
			expect(resp.status).toBe(404);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("invalid questions → 400", async () => {
		const sessionId = await createSession();
		try {
			// Too many questions (max 5).
			const tooMany = Array.from({ length: 6 }, (_, i) => ({
				question: `Q${i}`, options: ["a", "b"],
			}));
			const r1 = await postInternal("/api/internal/user-question", {
				sessionId, toolUseId: "bad-1", questions: tooMany,
			});
			expect(r1.status).toBe(400);

			// Too few options on a question (min 2).
			const r2 = await postInternal("/api/internal/user-question", {
				sessionId, toolUseId: "bad-2", questions: [{ question: "Q", options: ["only-one"] }],
			});
			expect(r2.status).toBe(400);

			// Empty question string.
			const r3 = await postInternal("/api/internal/user-question", {
				sessionId, toolUseId: "bad-3", questions: [{ question: "", options: ["a", "b"] }],
			});
			expect(r3.status).toBe(400);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("multi-select: answers round-trip with selected as array", async () => {
		const sessionId = await createSession();
		try {
			const toolUseId = `tool-ask-multi-${Date.now()}`;
			const questions = [
				{ question: "Which?", options: ["a", "b", "c"], multi: true },
			];
			const blockingP = postInternal("/api/internal/user-question", { sessionId, toolUseId, questions });
			// Wait for pending.
			for (let i = 0; i < 50; i++) {
				const r = await apiFetch(`/api/internal/user-question/pending?sessionId=${sessionId}`);
				if ((await r.json()).pending.length > 0) break;
				await new Promise(r => setTimeout(r, 50));
			}
			const answers = [{ question: "Which?", selected: ["a", "b"], other_text: null }];
			const submitResp = await postInternal("/api/internal/user-question/submit", { sessionId, toolUseId, answers });
			expect(submitResp.status).toBe(200);
			const blockingResp = await blockingP;
			expect(blockingResp.status).toBe(200);
			expect(await blockingResp.json()).toEqual({ answers });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("single-select question submitted with an array → 400", async () => {
		const sessionId = await createSession();
		try {
			const toolUseId = `tool-ask-bad-single-${Date.now()}`;
			const questions = [{ question: "Q?", options: ["a", "b"] }];
			const blockingP = postInternal("/api/internal/user-question", { sessionId, toolUseId, questions });
			for (let i = 0; i < 50; i++) {
				const r = await apiFetch(`/api/internal/user-question/pending?sessionId=${sessionId}`);
				if ((await r.json()).pending.length > 0) break;
				await new Promise(r => setTimeout(r, 50));
			}
			const bad = [{ question: "Q?", selected: ["a"], other_text: null }];
			const resp = await postInternal("/api/internal/user-question/submit", { sessionId, toolUseId, answers: bad });
			expect(resp.status).toBe(400);
			// Clean up: submit a valid answer so the blocking request resolves.
			await postInternal("/api/internal/user-question/submit", {
				sessionId, toolUseId,
				answers: [{ question: "Q?", selected: "a", other_text: null }],
			});
			await blockingP;
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("multi-select question submitted with a string → 400", async () => {
		const sessionId = await createSession();
		try {
			const toolUseId = `tool-ask-bad-multi-${Date.now()}`;
			const questions = [{ question: "Q?", options: ["a", "b"], multi: true }];
			const blockingP = postInternal("/api/internal/user-question", { sessionId, toolUseId, questions });
			for (let i = 0; i < 50; i++) {
				const r = await apiFetch(`/api/internal/user-question/pending?sessionId=${sessionId}`);
				if ((await r.json()).pending.length > 0) break;
				await new Promise(r => setTimeout(r, 50));
			}
			const bad = [{ question: "Q?", selected: "a", other_text: null }];
			const resp = await postInternal("/api/internal/user-question/submit", { sessionId, toolUseId, answers: bad });
			expect(resp.status).toBe(400);
			await postInternal("/api/internal/user-question/submit", {
				sessionId, toolUseId,
				answers: [{ question: "Q?", selected: ["a"], other_text: null }],
			});
			await blockingP;
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("unknown session → 404", async () => {
		const r = await postInternal("/api/internal/user-question", {
			sessionId: "no-such-session", toolUseId: "t", questions: [{ question: "Q", options: ["a", "b"] }],
		});
		expect(r.status).toBe(404);
	});

	test("session termination rejects pending question", async () => {
		const sessionId = await createSession();
		const toolUseId = `tool-term-${Date.now()}`;
		const questions = [{ question: "Q", options: ["a", "b"] }];

		// Fire blocking call.
		const blockingP = postInternal("/api/internal/user-question", { sessionId, toolUseId, questions });

		// Wait until the pending list actually contains the entry (register() ran).
		for (let i = 0; i < 50; i++) {
			const r = await apiFetch(`/api/internal/user-question/pending?sessionId=${sessionId}`);
			const list = (await r.json()).pending;
			if (list.length > 0) break;
			await new Promise(r => setTimeout(r, 50));
		}

		// Terminate — the harness should reject the pending promise → endpoint returns 500.
		await deleteSession(sessionId);

		const blockingResp = await blockingP;
		expect(blockingResp.status).toBe(500);
		const body = await blockingResp.json();
		expect(body.error).toMatch(/terminated|Session/i);
	});
});

test.describe("ask_user_choices end-to-end via mock agent", () => {
	test("mock agent posts question, UI submits, agent receives answers", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				// Trigger the mock agent's ask_user_choices branch.
				conn.send({ type: "prompt", text: "please use ask_user_choices" });

				// Wait for the tool_execution_start event — confirms the agent has fired
				// the blocking POST to /api/internal/user-question.
				await conn.waitFor(toolStartPredicate("ask_user_choices"), 10_000);

				// Poll for the pending entry (the mock agent's POST hits /register).
				let toolUseId = "";
				for (let i = 0; i < 100; i++) {
					const r = await apiFetch(`/api/internal/user-question/pending?sessionId=${sessionId}`);
					const list = (await r.json()).pending;
					if (list.length > 0) { toolUseId = list[0].toolUseId; break; }
					await new Promise(r => setTimeout(r, 50));
				}
				expect(toolUseId).not.toBe("");

				// Submit answers.
				const answers = [
					{ question: "Favorite color?", selected: "blue", other_text: null },
					{ question: "Team size?", selected: "Other", other_text: "tiny" },
				];
				const submitResp = await fetch(`${base()}/api/internal/user-question/submit`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${readE2EToken()}` },
					body: JSON.stringify({ sessionId, toolUseId, answers }),
				});
				expect(submitResp.status).toBe(200);

				// Wait for the agent's toolResult message_end carrying the answers.
				const toolResultMsg = await conn.waitFor(
					(m) => messageEndPredicate("toolResult")(m)
						&& m.data?.message?.toolName === "ask_user_choices",
					10_000,
				);
				const content = toolResultMsg.data?.message?.content?.[0]?.text || "";
				const parsed = JSON.parse(content);
				expect(parsed.answers).toEqual(answers);

				// Pending list is now empty.
				const r2 = await apiFetch(`/api/internal/user-question/pending?sessionId=${sessionId}`);
				expect((await r2.json()).pending).toEqual([]);
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("mock agent multi-select: tool_result.answers[0].selected is an array", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				conn.send({ type: "prompt", text: "please use ask_user_choices_multi" });
				await conn.waitFor(toolStartPredicate("ask_user_choices"), 10_000);

				let toolUseId = "";
				for (let i = 0; i < 100; i++) {
					const r = await apiFetch(`/api/internal/user-question/pending?sessionId=${sessionId}`);
					const list = (await r.json()).pending;
					if (list.length > 0) { toolUseId = list[0].toolUseId; break; }
					await new Promise(r => setTimeout(r, 50));
				}
				expect(toolUseId).not.toBe("");

				const answers = [
					{ question: "Which colors?", selected: ["red", "blue"], other_text: null },
					{ question: "Team size?", selected: "small", other_text: null },
				];
				const submitResp = await fetch(`${base()}/api/internal/user-question/submit`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${readE2EToken()}` },
					body: JSON.stringify({ sessionId, toolUseId, answers }),
				});
				expect(submitResp.status).toBe(200);

				const toolResultMsg = await conn.waitFor(
					(m) => messageEndPredicate("toolResult")(m)
						&& m.data?.message?.toolName === "ask_user_choices",
					10_000,
				);
				const content = toolResultMsg.data?.message?.content?.[0]?.text || "";
				const parsed = JSON.parse(content);
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
});
