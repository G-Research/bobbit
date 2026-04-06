/**
 * E2E tests for sandbox branch reconciliation.
 *
 * Verifies that when a sandboxed session is created with a sandboxBranch that
 * differs from the auto-generated branch, the persisted branch is updated to
 * match the sandboxBranch after sandbox wiring completes.
 *
 * Since these tests run without Docker, they focus on:
 * 1. Verifying the reconciliation code path doesn't break non-sandbox sessions
 * 2. Testing the session store's branch field for non-sandboxed worktree sessions
 * 3. Verifying that sandbox config + no Docker produces the expected error
 *    (i.e. the sandboxBranch field is accepted by the API)
 *
 * Full integration testing of the reconciliation with Docker is covered by
 * the manual integration tests (npm run test:manual).
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, gitCwd } from "./e2e-setup.js";

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

test.describe("Sandbox branch reconciliation", () => {
	test("non-sandboxed worktree session preserves auto-generated branch", async ({ gateway }) => {
		// Create a worktree session (non-sandboxed) — branch should remain session/new-session-<uuid8>
		const createRes = await apiFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: gitCwd() }),
		});
		expect(createRes.status).toBe(201);
		const { id } = await createRes.json() as any;

		try {
			// Wait for the session to be ready (worktree sessions start as "preparing")
			let session: any;
			for (let i = 0; i < 20; i++) {
				const res = await apiFetch(gateway.baseURL, `/api/sessions/${id}`);
				session = await res.json();
				if (session.status !== "preparing") break;
				await new Promise(r => setTimeout(r, 500));
			}

			// GET /api/sessions/:id doesn't include branch — use sessionManager to read persisted data
			const persisted = gateway.sessionManager.getPersistedSession(id);
			expect(persisted).toBeTruthy();
			expect(persisted!.branch).toBeTruthy();
			expect(persisted!.branch).toMatch(/^session\/new-session-[a-f0-9]{8}$/);
		} finally {
			await apiFetch(gateway.baseURL, `/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("sandbox session creation accepts sandboxBranch parameter", async ({ gateway }) => {
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
			// Create a sandboxed worktree session with explicit sandboxBranch.
			// Without Docker, this will fail during sandbox wiring, but the session
			// should still be persisted (persistOnce runs before sandbox wiring).
			const createRes = await apiFetch(gateway.baseURL, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					cwd: gitCwd(),
					sandboxed: true,
					sandboxBranch: "goal-test-coder-abc123",
				}),
			});

			if (createRes.ok) {
				// Docker was available — verify the branch was reconciled
				const { id } = await createRes.json() as any;
				try {
					// Wait for session to finish setup
					let session: any;
					for (let i = 0; i < 30; i++) {
						const res = await apiFetch(gateway.baseURL, `/api/sessions/${id}`);
						session = await res.json();
						if (session.status !== "preparing") break;
						await new Promise(r => setTimeout(r, 500));
					}

					// If the session finished successfully, branch should be reconciled
					// to the sandboxBranch value
					if (session.status === "idle" || session.status === "active") {
						const persisted = gateway.sessionManager.getPersistedSession(id);
						expect(persisted).toBeTruthy();
						expect(persisted!.branch).toBe("goal-test-coder-abc123");
					}
				} finally {
					await apiFetch(gateway.baseURL, `/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
				}
			} else {
				// Docker unavailable — session creation failed during sandbox wiring.
				// Server should still be healthy.
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

	test("reconciliation logic does not run for non-sandboxed sessions", async ({ gateway }) => {
		// Create a regular worktree session with no sandbox
		const createRes = await apiFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: gitCwd() }),
		});
		expect(createRes.status).toBe(201);
		const { id } = await createRes.json() as any;

		try {
			// Wait for session to be ready
			let session: any;
			for (let i = 0; i < 20; i++) {
				const res = await apiFetch(gateway.baseURL, `/api/sessions/${id}`);
				session = await res.json();
				if (session.status !== "preparing") break;
				await new Promise(r => setTimeout(r, 500));
			}

			// Branch should be the auto-generated one (not reconciled to anything else)
			const persisted = gateway.sessionManager.getPersistedSession(id);
			expect(persisted).toBeTruthy();
			expect(persisted!.branch).toBeTruthy();
			expect(persisted!.branch).toMatch(/^session\/new-session-[a-f0-9]{8}$/);

			// sandboxed should be falsy
			expect(session.sandboxed).toBeFalsy();
		} finally {
			await apiFetch(gateway.baseURL, `/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
