/**
 * E2E test for steer-interruptible `bash_bg wait`.
 *
 * Starts a long-running bg process via REST, begins a long-polling wait,
 * then triggers BgProcessManager.abortAllWaits() (the same call SessionManager
 * makes from its live-steer code path). The wait must return `aborted: true`
 * within 500ms and the bg process must keep running.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, nonGitCwd, injectDefaultProjectId } from "./e2e-setup.js";

async function adminFetch(baseURL: string, path: string, opts: RequestInit = {}) {
	const method = (opts.method || "GET").toUpperCase();
	let body = opts.body;
	if (method === "POST" && /^\/api\/(sessions|goals|staff)(\?|$|\/)/.test(path)) {
		body = await injectDefaultProjectId(body) as BodyInit;
	}
	return fetch(`${baseURL}${path}`, {
		...opts,
		body,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${readE2EToken()}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

const SLEEP_CMD = process.platform === "win32"
	? "ping -n 60 127.0.0.1 >NUL"
	: "sleep 60";

test.describe("bash_bg wait — steer abort", () => {
	test("abortAllWaits resolves long-poll wait with aborted:true, process keeps running", async ({ gateway }) => {
		// Create session
		const res = await adminFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(res.status).toBe(201);
		const { id: sessionId } = await res.json();

		// Spawn a long-running bg process
		const bgRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`, {
			method: "POST",
			body: JSON.stringify({ command: SLEEP_CMD, name: "sleeper" }),
		});
		expect(bgRes.status).toBe(201);
		const bg = await bgRes.json();

		// Start a wait with a generous timeout (60s)
		const waitStart = Date.now();
		const waitPromise = adminFetch(
			gateway.baseURL,
			`/api/sessions/${sessionId}/bg-processes/${bg.id}/wait?timeout=60`,
		).then(async (r) => ({ status: r.status, body: await r.json() }));

		// Give the long poll a moment to begin so the AbortController is registered.
		await new Promise((r) => setTimeout(r, 100));

		// Trigger abort via the bg manager (same call the live-steer code path uses).
		gateway.bgProcessManager.abortAllWaits(sessionId);

		const result = await waitPromise;
		const elapsed = Date.now() - waitStart;

		expect(result.status).toBe(200);
		expect(result.body.aborted).toBe(true);
		expect(result.body.timedOut).toBe(false);
		expect(result.body.info.status).toBe("running");
		expect(elapsed).toBeLessThan(1500);

		// Process should still be running.
		const listRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`);
		const list = await listRes.json();
		const proc = list.processes.find((p: any) => p.id === bg.id);
		expect(proc).toBeTruthy();
		expect(proc.status).toBe("running");

		// Cleanup: kill the process then the session.
		await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes/${bg.id}`, { method: "DELETE" });
		await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" });
	});

	test("session termination releases hanging wait handlers", async ({ gateway }) => {
		const res = await adminFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(res.status).toBe(201);
		const { id: sessionId } = await res.json();

		const bgRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`, {
			method: "POST",
			body: JSON.stringify({ command: SLEEP_CMD, name: "sleeper2" }),
		});
		expect(bgRes.status).toBe(201);
		const bg = await bgRes.json();

		const waitStart = Date.now();
		const waitPromise = adminFetch(
			gateway.baseURL,
			`/api/sessions/${sessionId}/bg-processes/${bg.id}/wait?timeout=60`,
		);

		await new Promise((r) => setTimeout(r, 100));

		// Terminate — must abort the in-flight wait so the handler resolves.
		await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" });

		const response = await waitPromise;
		const elapsed = Date.now() - waitStart;
		// Either 200 with aborted:true (abort fired first) or 404 (session gone) or
		// 200 with the process having exited via SIGTERM — any of these is OK as
		// long as the handler returned well before the 60s timeout.
		expect([200, 404]).toContain(response.status);
		expect(elapsed).toBeLessThan(5000);
	});
});
