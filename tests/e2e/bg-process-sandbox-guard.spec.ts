/**
 * E2E tests for the BgProcessManager sandboxed-session guard.
 *
 * Verifies that sandboxed sessions without a containerId are refused
 * host-side execution (403) and non-sandboxed sessions work normally.
 *
 * The Docker-dependent test (sandboxed session WITH containerId) lives in
 * sandbox-recovery-docker.spec.ts and runs via test:manual.
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

test.describe("BgProcess Sandbox Guard", () => {

	test("sandboxed session without containerId returns 403", async ({ gateway }) => {
		// Create a normal session
		const res = await adminFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(res.status).toBe(201);
		const { id } = await res.json();

		// Manipulate session to be sandboxed without a container
		const session = gateway.sessionManager.getSession(id);
		session.sandboxed = true;
		delete session.containerId;

		// Attempt to create a bg-process — should be refused
		const bgRes = await adminFetch(gateway.baseURL, `/api/sessions/${id}/bg-processes`, {
			method: "POST",
			body: JSON.stringify({ command: "echo test" }),
		});
		expect(bgRes.status).toBe(403);
		const body = await bgRes.json();
		expect(body.error).toBeTruthy();

		// Cleanup
		await adminFetch(gateway.baseURL, `/api/sessions/${id}`, { method: "DELETE" });
	});

	test("non-sandboxed session without containerId returns 201", async ({ gateway }) => {
		// Create a normal (non-sandboxed) session
		const res = await adminFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(res.status).toBe(201);
		const { id } = await res.json();

		// Verify session is not sandboxed and has no containerId
		const session = gateway.sessionManager.getSession(id);
		expect(session.sandboxed).toBeFalsy();
		expect(session.containerId).toBeFalsy();

		// Create a bg-process — should succeed on host
		const bgRes = await adminFetch(gateway.baseURL, `/api/sessions/${id}/bg-processes`, {
			method: "POST",
			body: JSON.stringify({ command: "echo hello" }),
		});
		expect(bgRes.status).toBe(201);
		const bgBody = await bgRes.json();
		expect(bgBody.id).toBeTruthy();

		// Cleanup
		await adminFetch(gateway.baseURL, `/api/sessions/${id}`, { method: "DELETE" });
	});
});
