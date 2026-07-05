/**
 * E2E tests for POST /api/sessions/:id/notify (W2.G(a) restoration).
 *
 * Client caller: src/app/api.ts's notifyProposalDecision(), invoked by
 * session-manager.ts after the user accepts/rejects a registered proposal
 * (project/goal/role/tool/staff). Before this route existed the POST 404'd
 * silently — see tests/client-api-orphan-pinning.test.ts's now-removed
 * "/api/sessions/0/notify" KNOWN_ORPHANS entry.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	connectWs,
	createSession,
	deleteSession,
	nonGitCwd,
	waitForSessionStatus,
	type WsConnection,
} from "./e2e-setup.js";

test.setTimeout(30_000);

function messageText(message: any): string {
	return (message?.content || [])
		.map((block: any) => typeof block?.text === "string" ? block.text : "")
		.join("\n");
}

async function expectUserTurn(conn: WsConnection, fromIndex: number, text: string): Promise<void> {
	await conn.waitForFrom(
		fromIndex,
		(m) => m.type === "event"
			&& m.data?.type === "message_end"
			&& m.data?.message?.role === "user"
			&& messageText(m.data.message).includes(text),
		15_000,
	);
}

test.describe("POST /api/sessions/:id/notify", () => {
	const sessions: string[] = [];

	test.afterEach(async () => {
		for (const sessionId of sessions.splice(0)) await deleteSession(sessionId).catch(() => {});
	});

	test("happy path: message is enqueued and delivered as a user turn to an idle session", async () => {
		const sessionId = await createSession({ cwd: nonGitCwd() });
		sessions.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");

		const conn = await connectWs(sessionId);
		try {
			const marker = `NOTIFY_HAPPY_PATH_${Date.now()}`;
			const cursor = conn.messageCount();
			const resp = await apiFetch(`/api/sessions/${sessionId}/notify`, {
				method: "POST",
				body: JSON.stringify({ message: `[SYSTEM: ${marker}]` }),
			});
			const data = await resp.json();
			expect(resp.status, JSON.stringify(data)).toBe(200);
			expect(data).toMatchObject({ ok: true });

			// Observable effect: the notification text actually reaches the
			// session's prompt/queue flow and shows up as a user-role turn.
			await expectUserTurn(conn, cursor, marker);
		} finally {
			conn.close();
		}
	});

	test("404s for an unknown session id", async () => {
		const resp = await apiFetch("/api/sessions/does-not-exist-notify/notify", {
			method: "POST",
			body: JSON.stringify({ message: "hello" }),
		});
		const data = await resp.json();
		expect(resp.status, JSON.stringify(data)).toBe(404);
	});

	test("400s for a missing/empty message body", async () => {
		const sessionId = await createSession({ cwd: nonGitCwd() });
		sessions.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");

		const missing = await apiFetch(`/api/sessions/${sessionId}/notify`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(missing.status, await missing.text()).toBe(400);

		const blank = await apiFetch(`/api/sessions/${sessionId}/notify`, {
			method: "POST",
			body: JSON.stringify({ message: "   " }),
		});
		expect(blank.status, await blank.text()).toBe(400);

		const wrongType = await apiFetch(`/api/sessions/${sessionId}/notify`, {
			method: "POST",
			body: JSON.stringify({ message: 42 }),
		});
		expect(wrongType.status, await wrongType.text()).toBe(400);
	});

	test("400s for an over-length message", async () => {
		const sessionId = await createSession({ cwd: nonGitCwd() });
		sessions.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");

		const resp = await apiFetch(`/api/sessions/${sessionId}/notify`, {
			method: "POST",
			body: JSON.stringify({ message: "x".repeat(10_001) }),
		});
		expect(resp.status, await resp.text()).toBe(400);
	});
});
