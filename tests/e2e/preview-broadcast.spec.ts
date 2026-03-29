/**
 * E2E tests for preview_changed WebSocket broadcast.
 *
 * Verifies that when the preview flag is toggled via REST PATCH,
 * a `preview_changed` message is broadcast to all connected WS clients.
 */
import { test, expect } from "./gateway-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	connectWs,
	WsConnection,
} from "./e2e-setup.js";

let sessionId: string;
let wsConn: WsConnection;

test.beforeAll(async () => {
	sessionId = await createSession();
	wsConn = await connectWs(sessionId);
});

test.afterAll(async () => {
	wsConn?.close();
	await deleteSession(sessionId).catch(() => {});
});

test.describe("preview_changed WS broadcast", () => {
	test("PATCH preview=true broadcasts preview_changed to WS clients", async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ preview: true }),
		});
		expect(resp.status).toBe(200);

		const msg = await wsConn.waitFor(
			(m) => m.type === "preview_changed" && m.sessionId === sessionId,
			5000,
		);

		expect(msg.type).toBe("preview_changed");
		expect(msg.sessionId).toBe(sessionId);
		expect(msg.preview).toBe(true);
	});

	test("PATCH preview=false broadcasts preview_changed with false", async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ preview: false }),
		});
		expect(resp.status).toBe(200);

		const msg = await wsConn.waitFor(
			(m) => m.type === "preview_changed" && m.preview === false,
			5000,
		);

		expect(msg.type).toBe("preview_changed");
		expect(msg.sessionId).toBe(sessionId);
		expect(msg.preview).toBe(false);
	});

	test("preview_changed is received by a second WS client", async () => {
		const wsConn2 = await connectWs(sessionId);

		try {
			await apiFetch(`/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ preview: true }),
			});

			// Both clients should receive the broadcast
			const [msg1, msg2] = await Promise.all([
				wsConn.waitFor(
					(m) => m.type === "preview_changed" && m.preview === true,
					5000,
				),
				wsConn2.waitFor(
					(m) => m.type === "preview_changed" && m.preview === true,
					5000,
				),
			]);

			expect(msg1.sessionId).toBe(sessionId);
			expect(msg2.sessionId).toBe(sessionId);
		} finally {
			wsConn2.close();
		}
	});
});
