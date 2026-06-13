/**
 * Reproducer: visible session creation bumps the /api/sessions generation, but
 * currently does not push a session-list invalidation to already connected
 * clients. The desired fix may use either a precise `session_created` event or a
 * broader `sessions_changed` event; this test accepts both and fails pre-fix
 * with a stable message when neither arrives before the 5s polling fallback.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, connectWs, createSession, deleteSession, type WsMsg } from "./e2e-setup.js";

const PUSH_TIMEOUT_MS = 1_000;

function isSessionCreateInvalidation(msg: WsMsg, sessionId: string): boolean {
	if (msg.type === "sessions_changed") return true;
	if (msg.type !== "session_created") return false;
	const id = typeof msg.sessionId === "string"
		? msg.sessionId
		: typeof (msg as any).id === "string"
			? (msg as any).id
			: undefined;
	return !id || id === sessionId;
}

async function listSessions(path = "/api/sessions"): Promise<{ generation: number; sessions: Array<{ id: string; [key: string]: unknown }>; changed?: boolean }> {
	const resp = await apiFetch(path);
	expect(resp.status, `${path} should return the session index`).toBe(200);
	const body = await resp.json();
	expect(typeof body.generation, `${path} should include the session generation`).toBe("number");
	if (body.changed === false) {
		return { generation: body.generation, sessions: [], changed: false };
	}
	expect(Array.isArray(body.sessions), `${path} should include sessions when changed`).toBe(true);
	return body;
}

test.describe("cross-client session creation sync", () => {
	test.describe.configure({ retries: 0 });

	test("visible session creation pushes session_created or sessions_changed before polling fallback", async () => {
		const anchorSessionId = await createSession();
		let createdSessionId: string | undefined;
		const clientA = await connectWs(anchorSessionId);
		const clientB = await connectWs(anchorSessionId);
		try {
			const before = await listSessions();
			const cursor = clientB.messageCount();

			createdSessionId = await createSession();

			const catchup = await listSessions(`/api/sessions?since=${before.generation}`);
			expect(catchup.changed, "/api/sessions?since must report a generation change for the newly created visible session").not.toBe(false);
			expect(catchup.sessions.some((s) => s.id === createdSessionId), "/api/sessions?since sees the new visible session, so a failing assertion below isolates the missing WebSocket push").toBe(true);

			let pushed: WsMsg | undefined;
			try {
				pushed = await clientB.waitForFrom(cursor, (msg) => isSessionCreateInvalidation(msg, createdSessionId!), PUSH_TIMEOUT_MS);
			} catch (err) {
				throw new Error(
					`missing session-created sync broadcast: no session_created or sessions_changed event within ${PUSH_TIMEOUT_MS}ms for visible session ${createdSessionId}; /api/sessions?since=${before.generation} already returned it`,
					{ cause: err },
				);
			}

			expect(isSessionCreateInvalidation(pushed, createdSessionId)).toBe(true);
		} finally {
			clientA.close();
			clientB.close();
			if (createdSessionId) await deleteSession(createdSessionId);
			await deleteSession(anchorSessionId);
		}
	});
});
