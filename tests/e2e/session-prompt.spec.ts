/**
 * E2E tests for the session_prompt delivery endpoint/tool surface.
 *
 * These drive the in-process gateway and mock agent while keeping the target
 * unrestricted by team/delegate ownership, which is the new session_prompt scope.
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
import { pollUntil } from "./test-utils/cleanup.js";

const LONG_SLEEP_CMD = process.platform === "win32"
	? "ping -n 60 127.0.0.1 >NUL"
	: "sleep 60";

test.setTimeout(45_000);

function sessionCallerHeaders(gateway: any, callerSessionId: string): Record<string, string> {
	const secret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(callerSessionId);
	return {
		"X-Bobbit-Session-Id": callerSessionId,
		"X-Bobbit-Session-Secret": secret,
	};
}

async function createSessionPromptRole(roleName: string): Promise<void> {
	const createResp = await apiFetch("/api/roles", {
		method: "POST",
		body: JSON.stringify({
			name: roleName,
			label: `Session prompt ${roleName}`,
			promptTemplate: "E2E session_prompt enabled role.",
			toolPolicies: { session_prompt: "allow" },
		}),
	});
	const text = await createResp.text();
	expect(createResp.status, text).toBe(201);
}

async function createRoleSession(roleName: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd(), roleId: roleName }),
	});
	const data = await resp.json();
	expect(resp.status, JSON.stringify(data)).toBe(201);
	return data.id;
}

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

test.describe("session_prompt", () => {
	let roleName: string;
	const sessions: string[] = [];

	test.beforeEach(async () => {
		roleName = `session-prompt-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		await createSessionPromptRole(roleName);
	});

	test.afterEach(async () => {
		for (const sessionId of sessions.splice(0)) await deleteSession(sessionId).catch(() => {});
		if (roleName) await apiFetch(`/api/roles/${roleName}`, { method: "DELETE" }).catch(() => {});
	});

	test("prompt mode can prompt an arbitrary explicitly enabled live target session", async ({ gateway }) => {
		const callerId = await createRoleSession(roleName);
		const targetId = await createSession({ cwd: nonGitCwd() });
		sessions.push(callerId, targetId);
		await waitForSessionStatus(callerId, "idle");
		await waitForSessionStatus(targetId, "idle");

		const caller = gateway.sessionManager.getSession(callerId);
		expect(caller?.allowedTools, "caller role must explicitly expose session_prompt").toContain("session_prompt");

		const targetConn = await connectWs(targetId);
		try {
			const marker = `SESSION_PROMPT_ARBITRARY_${Date.now()}`;
			const cursor = targetConn.messageCount();
			const resp = await apiFetch(`/api/sessions/${targetId}/prompt`, {
				method: "POST",
				headers: sessionCallerHeaders(gateway, callerId),
				body: JSON.stringify({ message: marker, mode: "prompt" }),
			});
			const data = await resp.json();
			expect(resp.status, JSON.stringify(data)).toBe(200);
			expect(data).toMatchObject({ ok: true, mode: "prompt" });
			expect(["dispatched", "queued"]).toContain(data.status);

			await expectUserTurn(targetConn, cursor, marker);
		} finally {
			targetConn.close();
		}
	});

	test("steer mode uses the live-steer path and interrupts registered bash_bg waits", async ({ gateway }) => {
		const callerId = await createRoleSession(roleName);
		const targetId = await createSession({ cwd: nonGitCwd() });
		sessions.push(callerId, targetId);
		await waitForSessionStatus(callerId, "idle");
		await waitForSessionStatus(targetId, "idle");

		const bgResp = await apiFetch(`/api/sessions/${targetId}/bg-processes`, {
			method: "POST",
			body: JSON.stringify({ command: LONG_SLEEP_CMD, name: "session prompt wait" }),
		});
		const bg = await bgResp.json();
		expect(bgResp.status, JSON.stringify(bg)).toBe(201);

		const waitStartedAt = Date.now();
		const waitPromise = apiFetch(
			`/api/sessions/${targetId}/bg-processes/${bg.id}/wait?timeout=60`,
		).then(async (r) => ({ status: r.status, body: await r.json() }));
		void waitPromise.catch(() => {});

		await pollUntil(
			() => ((gateway.bgProcessManager as any).waits as Map<string, Set<unknown>>).get(targetId)?.size ? true : false,
			{ timeoutMs: 5_000, intervalMs: 25, label: "session_prompt bg wait registered" },
		);

		const sm = gateway.sessionManager;
		const origSteer = sm.deliverLiveSteer.bind(sm);
		let liveSteerSeen = false;
		sm.deliverLiveSteer = async (sessionId: string, message: string, opts?: any) => {
			if (sessionId === targetId && message.includes("SESSION_PROMPT_STEER_ABORT")) liveSteerSeen = true;
			return origSteer(sessionId, message, opts);
		};

		try {
			const session = sm.getSession(targetId);
			expect(session, "target session should be live").toBeTruthy();
			session.status = "streaming";

			const resp = await apiFetch(`/api/sessions/${targetId}/prompt`, {
				method: "POST",
				headers: sessionCallerHeaders(gateway, callerId),
				body: JSON.stringify({ message: "SESSION_PROMPT_STEER_ABORT", mode: "steer" }),
			});
			const data = await resp.json();
			expect(resp.status, JSON.stringify(data)).toBe(200);
			expect(data).toMatchObject({ ok: true, mode: "steer", dispatched: true });

			const waitResult = await waitPromise;
			expect(liveSteerSeen, "session_prompt(mode=steer) must call deliverLiveSteer for streaming targets").toBe(true);
			expect(waitResult.status).toBe(200);
			expect(waitResult.body.aborted).toBe(true);
			expect(waitResult.body.timedOut).toBe(false);
			expect(Date.now() - waitStartedAt).toBeLessThan(2_000);
		} finally {
			sm.deliverLiveSteer = origSteer;
			await apiFetch(`/api/sessions/${targetId}/bg-processes/${bg.id}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
