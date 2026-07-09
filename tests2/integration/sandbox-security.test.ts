/**
 * Sandbox Security Boundary E2E Tests
 *
 * Verifies that sandbox-scoped tokens are properly restricted by the
 * HTTP middleware (sandbox-guard.ts). No Docker required — tests use
 * the in-process gateway's live SandboxTokenStore to register scoped
 * tokens and make real HTTP requests against the gateway.
 *
 * Uses the per-project token model: one token per project, sessions
 * are tracked under the project scope via addSession().
 */
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import { bobbitDir, readE2EToken, nonGitCwd, injectDefaultProjectId, createGoal, deleteGoal, registerProject } from "./_e2e/e2e-setup.js";

// Helper to make requests with admin token
async function adminFetch(baseURL: string, path: string, opts: RequestInit = {}) {
	const method = (opts.method || "GET").toUpperCase();
	let body = opts.body;
	if (method === "POST" && /^\/api\/(sessions|goals|staff)(\?|$|\/)/.test(path)) {
		body = await injectDefaultProjectId(body) as BodyInit;
	}
	return fetch(`${baseURL}${path}`, {
		...opts,
		body,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${readE2EToken()}`, ...(opts.headers as Record<string, string>) },
	});
}

// Helper to make requests with sandbox-scoped token
function sandboxFetch(baseURL: string, path: string, token: string, opts: RequestInit = {}) {
	return fetch(`${baseURL}${path}`, {
		...opts,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers as Record<string, string>) },
	});
}

test.describe("Sandbox Security Boundaries", () => {
	let scopedToken: string;
	let sessionId: string;
	const goalId = "test-goal-id";
	const projectId = "test-project-for-security";

	test.beforeAll(async ({ gateway }) => {
		// Create a real session via admin token
		const res = await adminFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(res.status).toBe(201);
		const data = await res.json();
		sessionId = data.id;

		// Register a sandbox-scoped token using the per-project model
		scopedToken = gateway.sessionManager.sandboxTokenStore.register(projectId);
		gateway.sessionManager.sandboxTokenStore.addSession(projectId, sessionId);
		gateway.sessionManager.sandboxTokenStore.addGoal(projectId, goalId);
	});

	test.afterAll(async ({ gateway }) => {
		await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
	});

	// ── BLOCKED endpoints ──────────────────────────────────────────────

	test("cannot list sessions", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/sessions", scopedToken);
		expect(res.status).toBe(403);
	});

	test("cannot read project config", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/project-config", scopedToken);
		expect(res.status).toBe(403);
	});

	test("cannot write project config", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/project-config", scopedToken, {
			method: "PUT",
			body: JSON.stringify({ sandbox: "none" }),
		});
		expect(res.status).toBe(403);
	});

	test("cannot read roles", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/roles", scopedToken);
		expect(res.status).toBe(403);
	});

	test("cannot read MCP servers", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/mcp-servers", scopedToken);
		expect(res.status).toBe(403);
	});

	test("cannot read preferences", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/preferences", scopedToken);
		expect(res.status).toBe(403);
	});

	test("bg-processes allowed on own session", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`, scopedToken, {
			method: "POST",
			body: JSON.stringify({ command: "echo hello" }),
		});
		// bg-processes are now allowed for sandbox tokens on own session (spawns via docker exec)
		expect(res.status).toBe(201);
	});

	test("cannot access other sessions", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/sessions/nonexistent-other", scopedToken);
		expect(res.status).toBe(403);
	});

	test("cannot access other goals", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/goals/other-goal-id/gates", scopedToken);
		expect(res.status).toBe(403);
	});

	// ── ALLOWED endpoints ──────────────────────────────────────────────

	test("can access own session", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, `/api/sessions/${sessionId}`, scopedToken);
		expect(res.status).toBe(200);
	});

	test("can access health endpoint", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/health", scopedToken);
		expect(res.status).toBe(200);
	});

	test("can create delegate sessions", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/sessions", scopedToken, {
			method: "POST",
			body: JSON.stringify({ delegateOf: sessionId, instructions: "test delegate", cwd: nonGitCwd() }),
		});
		// Should be 201 — sandbox tokens are allowed to create delegate sessions
		expect(res.status).toBe(201);
		const data = await res.json();
		expect(data.id).toBeTruthy();
		// Clean up the delegate session
		await adminFetch(gateway.baseURL, `/api/sessions/${data.id}`, { method: "DELETE" }).catch(() => {});
	});

	// ── Cross-session bg-processes restriction ─────────────────────────

	test("cannot run bg-processes on another session", async ({ gateway }) => {
		// Create a second session (simulates a non-sandboxed host session)
		const res2 = await adminFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(res2.status).toBe(201);
		const otherSession = (await res2.json()).id;

		// Sandbox token should NOT be able to run bg-processes on the other session
		const res = await sandboxFetch(gateway.baseURL, `/api/sessions/${otherSession}/bg-processes`, scopedToken, {
			method: "POST",
			body: JSON.stringify({ command: "echo pwned" }),
		});
		expect(res.status).toBe(403);

		// Clean up
		await adminFetch(gateway.baseURL, `/api/sessions/${otherSession}`, { method: "DELETE" }).catch(() => {});
	});

	test("cannot create non-delegate sessions", async ({ gateway }) => {
		// A sandbox token should NOT be able to create a standalone (non-delegate) session.
		// The server rejects this with 403 (sandbox guard) or 400 (missing delegateOf).
		// Either way, the session must NOT be created.
		const res = await sandboxFetch(gateway.baseURL, "/api/sessions", scopedToken, {
			method: "POST",
			body: JSON.stringify({ cwd: "/tmp" }),
		});
		expect([400, 403]).toContain(res.status);
	});

	// ── Session-creation scope ownership (before goal mutation/resolution) ──

	test("cannot create a session in a project outside its sandbox scope", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/sessions", scopedToken, {
			method: "POST",
			body: JSON.stringify({ projectId: "some-other-project", cwd: nonGitCwd() }),
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.code).toBe("SANDBOX_SCOPE_VIOLATION");
	});

	test("cannot create an assistant/server-scope session under a sandbox token", async ({ gateway }) => {
		for (const assistantType of ["project", "role", "tool"]) {
			const res = await sandboxFetch(gateway.baseURL, "/api/sessions", scopedToken, {
				method: "POST",
				body: JSON.stringify({ assistantType, projectId, cwd: nonGitCwd() }),
			});
			expect(res.status, `assistantType=${assistantType}`).toBe(403);
			expect((await res.json()).code).toBe("SANDBOX_SCOPE_VIOLATION");
		}
	});

	test("scoped token cannot read or mutate a task from another project's goal", async ({ gateway }) => {
		const otherRoot = mkdtempSync(join(dirname(bobbitDir()), `task-scope-other-${Date.now()}-`));
		let scopedGoalId = "";
		let otherGoalId = "";
		let otherProjectId = "";
		try {
			const scopedGoal = await createGoal({ title: `Scoped task goal ${Date.now()}`, worktree: false });
			scopedGoalId = scopedGoal.id as string;
			const scopedProjectId = scopedGoal.projectId as string;

			const otherProject = await registerProject({ name: `task-scope-other-${Date.now()}`, rootPath: otherRoot, seedWorkflows: false });
			otherProjectId = otherProject.id;
			const otherGoal = await createGoal({
				projectId: otherProject.id,
				cwd: otherProject.rootPath,
				title: `Out-of-scope task goal ${Date.now()}`,
				worktree: false,
			});
			otherGoalId = otherGoal.id as string;

			const scopedTaskResp = await adminFetch(gateway.baseURL, `/api/goals/${scopedGoalId}/tasks`, {
				method: "POST",
				body: JSON.stringify({ title: "Scoped task", type: "implementation" }),
			});
			const scopedTaskText = await scopedTaskResp.text();
			expect(scopedTaskResp.status, scopedTaskText).toBe(201);
			const scopedTask = JSON.parse(scopedTaskText);

			const otherTaskResp = await adminFetch(gateway.baseURL, `/api/goals/${otherGoalId}/tasks`, {
				method: "POST",
				body: JSON.stringify({ title: "Other project task", type: "implementation", spec: "original" }),
			});
			const otherTaskText = await otherTaskResp.text();
			expect(otherTaskResp.status, otherTaskText).toBe(201);
			const otherTask = JSON.parse(otherTaskText);

			const taskToken = gateway.sessionManager.sandboxTokenStore.register(scopedProjectId);
			gateway.sessionManager.sandboxTokenStore.addGoal(scopedProjectId, scopedGoalId);

			const allowed = await sandboxFetch(gateway.baseURL, `/api/tasks/${scopedTask.id}`, taskToken, {
				method: "PUT",
				body: JSON.stringify({ spec: "allowed" }),
			});
			expect(allowed.status, await allowed.text()).toBe(200);

			const deniedGet = await sandboxFetch(gateway.baseURL, `/api/tasks/${otherTask.id}`, taskToken);
			expect(deniedGet.status).toBe(403);

			const deniedPut = await sandboxFetch(gateway.baseURL, `/api/tasks/${otherTask.id}`, taskToken, {
				method: "PUT",
				body: JSON.stringify({ spec: "pwned" }),
			});
			expect(deniedPut.status).toBe(403);
			expect((await deniedPut.json()).code).toBe("SANDBOX_SCOPE_VIOLATION");

			const otherTaskAfter = await (await adminFetch(gateway.baseURL, `/api/tasks/${otherTask.id}`)).json();
			expect(otherTaskAfter.spec).toBe("original");
		} finally {
			if (scopedGoalId) await deleteGoal(scopedGoalId).catch(() => {});
			if (otherGoalId) await deleteGoal(otherGoalId).catch(() => {});
			if (otherProjectId) await adminFetch(gateway.baseURL, `/api/projects/${otherProjectId}`, { method: "DELETE" }).catch(() => {});
			rmSync(otherRoot, { recursive: true, force: true });
		}
	});

	test("cannot attach to an out-of-scope goal, and does not transition it to in-progress", async ({ gateway }) => {
		// Create a real todo goal in the harness default project (a different
		// project + goal than the sandbox scope). The sandbox token must be
		// rejected BEFORE the goal auto-transition mutates its state.
		const goal = await createGoal({ title: `Sandbox scope guard ${Date.now()}`, worktree: false });
		const outOfScopeGoalId = goal.id as string;
		try {
			const before = await adminFetch(gateway.baseURL, `/api/goals/${outOfScopeGoalId}`);
			expect((await before.json()).state).toBe("todo");

			const res = await sandboxFetch(gateway.baseURL, "/api/sessions", scopedToken, {
				method: "POST",
				body: JSON.stringify({ projectId, goalId: outOfScopeGoalId }),
			});
			expect(res.status).toBe(403);
			expect((await res.json()).code).toBe("SANDBOX_SCOPE_VIOLATION");

			// The critical invariant: the out-of-scope goal was NOT flipped to
			// in-progress. This pins the "goal auto-transition runs after the
			// sandbox ownership check" fix.
			const after = await adminFetch(gateway.baseURL, `/api/goals/${outOfScopeGoalId}`);
			expect((await after.json()).state).toBe("todo");
		} finally {
			await deleteGoal(outOfScopeGoalId).catch(() => {});
		}
	});

	// ── Token persistence check ────────────────────────────────────────

	test("sandbox token not persisted to disk", async ({ gateway }) => {
		const fs = await import("node:fs");
		const path = await import("node:path");

		// Recursively read all files in the bobbit state dir
		function readAllFiles(dir: string): string[] {
			const contents: string[] = [];
			try {
				const entries = fs.readdirSync(dir, { withFileTypes: true });
				for (const entry of entries) {
					const fullPath = path.join(dir, entry.name);
					if (entry.isDirectory()) {
						contents.push(...readAllFiles(fullPath));
					} else if (entry.isFile()) {
						try {
							contents.push(fs.readFileSync(fullPath, "utf-8"));
						} catch { /* skip binary/unreadable */ }
					}
				}
			} catch { /* skip inaccessible dirs */ }
			return contents;
		}

		const allContent = readAllFiles(gateway.bobbitDir).join("\n");
		expect(allContent).not.toContain(scopedToken);
	});
});
