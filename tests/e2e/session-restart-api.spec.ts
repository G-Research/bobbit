import { test, expect } from "./in-process-harness.js";
import {
	createSession,
	defaultProjectId,
	deleteSession,
	rawApiFetch,
	waitForSessionStatus,
} from "./e2e-setup.js";

async function readJson(resp: Response): Promise<any> {
	return resp.json().catch(() => ({}));
}

async function postRestart(sessionId: string, body: Record<string, unknown> = {}): Promise<Response> {
	return rawApiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/restart`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

async function projectIdFor(gateway: any, sessionId: string): Promise<string> {
	return gateway.sessionManager.getPersistedSession(sessionId)?.projectId ?? await defaultProjectId();
}

test.describe("POST /api/sessions/:id/restart", () => {
	test("restarts a valid idle session and returns ok with the matching session id", async () => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");

			const resp = await postRestart(sessionId);
			expect(resp.status).toBe(200);
			expect(resp.ok).toBe(true);
			expect(await readJson(resp)).toMatchObject({ ok: true, sessionId });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("returns SESSION_NOT_FOUND for a missing session id", async () => {
		const resp = await postRestart("missing-restart-session-id");

		expect(resp.status).toBe(404);
		expect(await readJson(resp)).toMatchObject({ code: "SESSION_NOT_FOUND" });
	});

	test("rejects a busy session without force", async ({ gateway }) => {
		const sessionId = await createSession();
		let previousStatus: string | undefined;
		try {
			await waitForSessionStatus(sessionId, "idle");
			const live = gateway.sessionManager.getSession(sessionId);
			expect(live).toBeTruthy();
			previousStatus = live.status;
			live.status = "streaming";
			gateway.sessionManager.getSessionStore(await projectIdFor(gateway, sessionId)).update(sessionId, { status: "streaming" });

			const resp = await postRestart(sessionId, { force: false });
			expect(resp.status).toBe(409);
			expect(await readJson(resp)).toMatchObject({ code: "SESSION_BUSY" });
		} finally {
			const live = gateway.sessionManager.getSession(sessionId);
			if (live && previousStatus) live.status = previousStatus;
			gateway.sessionManager.getSessionStore(await projectIdFor(gateway, sessionId)).update(sessionId, { status: previousStatus ?? "idle" });
			await deleteSession(sessionId);
		}
	});

	test("rejects a non-interactive session as not restartable", async ({ gateway }) => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			const live = gateway.sessionManager.getSession(sessionId);
			expect(live).toBeTruthy();
			live.nonInteractive = true;
			gateway.sessionManager.getSessionStore(await projectIdFor(gateway, sessionId)).update(sessionId, { nonInteractive: true });

			const resp = await postRestart(sessionId);
			expect([403, 409]).toContain(resp.status);
			expect(await readJson(resp)).toMatchObject({ code: "SESSION_NOT_RESTARTABLE" });
		} finally {
			const live = gateway.sessionManager.getSession(sessionId);
			if (live) live.nonInteractive = false;
			gateway.sessionManager.getSessionStore(await projectIdFor(gateway, sessionId)).update(sessionId, { nonInteractive: false });
			await deleteSession(sessionId);
		}
	});
});
