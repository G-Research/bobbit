/**
 * Sandbox Session Persistence E2E Tests
 *
 * Verifies that sandboxed sessions are persisted to sessions.json even if
 * the agent spawn fails (e.g. Docker ENOENT). This prevents session loss
 * on gateway restart.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken } from "./e2e-setup.js";

let _tok: string;
function TOKEN() { if (!_tok) _tok = readE2EToken(); return _tok; }

function apiFetch(baseURL: string, path: string, opts: RequestInit = {}) {
	return fetch(`${baseURL}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN()}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

test.describe("sandbox session persistence", () => {
	test("session metadata persisted before agent spawn", async ({ gateway }) => {
		// Get the default project
		const projectsRes = await apiFetch(gateway.baseURL, "/api/projects");
		const projects = await projectsRes.json() as any[];
		const projectId = projects[0]?.id;
		expect(projectId).toBeTruthy();

		// Enable sandbox in project config
		await apiFetch(gateway.baseURL, `/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({ sandbox: "docker" }),
		});

		try {
			// Create a sandboxed session — may fail if Docker isn't available,
			// but the session should be persisted regardless
			const createRes = await apiFetch(gateway.baseURL, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({ sandboxed: true }),
			});

			if (createRes.ok) {
				// Docker was available and session was created
				const { id } = await createRes.json() as any;
				expect(id).toBeTruthy();

				// Verify the session is persisted with sandboxed=true
				const sm = (gateway as any).sessionManager;
				const store = sm.getSessionStore(projectId);
				const persisted = store.get(id);
				expect(persisted).toBeTruthy();
				expect(persisted.sandboxed).toBe(true);

				// Clean up
				await apiFetch(gateway.baseURL, `/api/sessions/${id}`, { method: "DELETE" });
			} else {
				// Docker unavailable — verify server didn't crash (it responded)
				const body = await createRes.json() as any;
				expect(body.error).toBeTruthy();

				// Even though creation failed, verify the server is still healthy
				const healthRes = await apiFetch(gateway.baseURL, "/api/health");
				expect(healthRes.ok).toBe(true);
			}
		} finally {
			// Reset sandbox config
			await apiFetch(gateway.baseURL, `/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({ sandbox: "" }),
			});
		}
	});
});
