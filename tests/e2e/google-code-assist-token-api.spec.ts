/**
 * API E2E — GET /api/sessions/:id/google-code-assist/token
 *
 * The agent-side Code Assist provider extension fetches short-lived runtime
 * material (Bearer access token + project id) from this endpoint per request.
 *
 * These tests cover the routing + auth/credential gating that does NOT require a
 * real Google account:
 *  - 404 for an unknown session id.
 *  - 401 + GOOGLE_CODE_ASSIST_REAUTH when no Google account is signed in (the
 *    isolated E2E env has no `google-gemini-cli` credential in auth.json).
 *
 * The success path (token + project) is exercised by unit tests over
 * getGoogleAccessToken/ensureCodeAssistProject and the manual-integration suite.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, apiFetch, createSession, deleteSession } from "./e2e-setup.js";

test.beforeAll(() => { readE2EToken(); });

test.describe("GET /api/sessions/:id/google-code-assist/token", () => {
	test("404 for an unknown session id", async () => {
		const res = await apiFetch("/api/sessions/does-not-exist/google-code-assist/token");
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toMatch(/not found/i);
	});

	test("401 GOOGLE_CODE_ASSIST_REAUTH when no Google account is signed in", async () => {
		const sid = await createSession();
		try {
			const res = await apiFetch(`/api/sessions/${sid}/google-code-assist/token`);
			expect(res.status).toBe(401);
			const body = await res.json();
			expect(body.code).toBe("GOOGLE_CODE_ASSIST_REAUTH");
			expect(body.error).toMatch(/Google account/i);
		} finally {
			await deleteSession(sid);
		}
	});
});
