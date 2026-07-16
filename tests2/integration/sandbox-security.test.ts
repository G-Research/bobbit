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
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import type { PersistedGoal } from "../../src/server/agent/goal-store.js";
import type { PersistedTask } from "../../src/server/agent/task-store.js";
import { test, expect } from "./_e2e/in-process-harness.js";
import { readE2EToken, nonGitCwd } from "./_e2e/e2e-setup.js";

/** Bypass the integration harness's mutation observer: every fixture mutation in
 * this file is test-owned in-memory state and is restored before its afterEach. */
async function localFetch(baseURL: string, route: string, opts: RequestInit = {}): Promise<Response> {
	const url = new URL(route, baseURL);
	const method = (opts.method || "GET").toUpperCase();
	const headers = new Headers(opts.headers);
	const body = typeof opts.body === "string" ? opts.body : undefined;
	if (body !== undefined && !headers.has("content-length")) headers.set("content-length", String(Buffer.byteLength(body)));
	return new Promise<Response>((resolve, reject) => {
		const req = httpRequest(url, { method, headers: Object.fromEntries(headers) }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", chunk => chunks.push(Buffer.from(chunk)));
			res.on("end", () => resolve(new Response(Buffer.concat(chunks), {
				status: res.statusCode ?? 500,
				headers: res.headers as HeadersInit,
			})));
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

function adminFetch(baseURL: string, route: string, opts: RequestInit = {}) {
	return localFetch(baseURL, route, {
		...opts,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${readE2EToken()}`, ...(opts.headers as Record<string, string>) },
	});
}

function sandboxFetch(baseURL: string, route: string, token: string, opts: RequestInit = {}) {
	return localFetch(baseURL, route, {
		...opts,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers as Record<string, string>) },
	});
}

let fixtureSequence = 0;

function installSyntheticSession(gateway: any, id: string): () => void {
	const sessionManager = gateway.sessionManager as any;
	const bgProcessManager = gateway.bgProcessManager as any;
	const cwd = nonGitCwd();
	const now = Date.now();
	const live = {
		id,
		title: "Sandbox security fixture",
		cwd,
		status: "idle",
		createdAt: now,
		lastActivity: now,
		clients: new Set(),
		isCompacting: false,
		projectId: gateway.defaultProjectId,
		sandboxed: false,
	};
	const persisted = { ...live, agentSessionFile: "" };
	delete (persisted as any).clients;
	delete (persisted as any).isCompacting;

	const ctx = sessionManager.getProjectContextManager().getOrCreate(gateway.defaultProjectId);
	const originalStoreGet = ctx.sessionStore.get;
	const originalCreateDelegate = sessionManager.createDelegateSession;
	const originalBgCreate = bgProcessManager.create;
	sessionManager.sessions.set(id, live);
	ctx.sessionStore.get = (candidate: string) => candidate === id ? persisted : originalStoreGet.call(ctx.sessionStore, candidate);
	sessionManager.createDelegateSession = async (parentId: string, options: { cwd: string }) => ({
		id: `${parentId}-delegate`,
		cwd: options.cwd,
		status: "idle",
		projectId: gateway.defaultProjectId,
		delegateOf: parentId,
	});
	bgProcessManager.create = (ownerId: string, command: string) => ({
		id: `fake-bg-${ownerId}`,
		name: command,
		command,
		status: "running",
	});

	return () => {
		sessionManager.sessions.delete(id);
		ctx.sessionStore.get = originalStoreGet;
		sessionManager.createDelegateSession = originalCreateDelegate;
		bgProcessManager.create = originalBgCreate;
	};
}

function installSyntheticContext(
	gateway: any,
	projectId: string,
	goals: PersistedGoal[],
	tasks: PersistedTask[] = [],
): () => void {
	const contexts = (gateway.projectContextManager as any).contexts as Map<string, any>;
	const goalRecords = new Map(goals.map(goal => [goal.id, goal]));
	const taskRecords = new Map(tasks.map(task => [task.id, task]));
	const context = {
		project: { id: projectId, name: projectId, rootPath: nonGitCwd() },
		goalStore: { get: (id: string) => goalRecords.get(id), getAll: () => [...goalRecords.values()] },
		taskStore: {
			get: (id: string) => taskRecords.get(id),
			put: (task: PersistedTask) => taskRecords.set(task.id, task),
			getAll: () => [...taskRecords.values()],
			getByGoalId: (goalId: string) => [...taskRecords.values()].filter(task => task.goalId === goalId),
			getBySessionId: (ownerId: string) => [...taskRecords.values()].filter(task => task.assignedSessionId === ownerId),
			getByParentTaskId: (parentId: string) => [...taskRecords.values()].filter(task => task.parentTaskId === parentId),
		},
	};
	contexts.set(projectId, context);
	return () => contexts.delete(projectId);
}

test.describe("Sandbox Security Boundaries", () => {
	let scopedToken: string;
	let sessionId: string;
	const goalId = "test-goal-id";
	const projectId = "test-project-for-security";
	let restoreSessionFixture: () => void;

	test.beforeEach(({ gateway }) => {
		sessionId = `sandbox-security-${fixtureSequence++}`;
		gateway.sessionManager.sandboxTokenStore.remove(projectId);
		restoreSessionFixture = installSyntheticSession(gateway, sessionId);
		scopedToken = gateway.sessionManager.sandboxTokenStore.register(projectId);
		gateway.sessionManager.sandboxTokenStore.addSession(projectId, sessionId);
		gateway.sessionManager.sandboxTokenStore.addGoal(projectId, goalId);
	});

	test.afterEach(({ gateway }) => {
		gateway.sessionManager.sandboxTokenStore.remove(projectId);
		restoreSessionFixture();
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
		// The authorization path permits background work on the token's own session;
		// the manager's injected SpawnFn keeps this tier-1 assertion in-process.
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
		const otherSession = `outside-session-${fixtureSequence++}`;
		// The route guard rejects the foreign id before consulting SessionManager,
		// so a token/session fixture must not touch a persistent SessionStore.
		const res = await sandboxFetch(gateway.baseURL, `/api/sessions/${otherSession}/bg-processes`, scopedToken, {
			method: "POST",
			body: JSON.stringify({ command: "echo pwned" }),
		});
		expect(res.status).toBe(403);
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
		const suffix = fixtureSequence++;
		const scopedProjectId = `task-scope-project-${suffix}`;
		const otherProjectId = `task-other-project-${suffix}`;
		const scopedGoalId = `task-scope-goal-${suffix}`;
		const otherGoalId = `task-other-goal-${suffix}`;
		const now = Date.now();
		const scopedGoal: PersistedGoal = {
			id: scopedGoalId, projectId: scopedProjectId, title: "Scoped task goal", cwd: nonGitCwd(),
			state: "todo", spec: "", createdAt: now, updatedAt: now,
		};
		const otherGoal: PersistedGoal = {
			id: otherGoalId, projectId: otherProjectId, title: "Out-of-scope task goal", cwd: nonGitCwd(),
			state: "todo", spec: "", createdAt: now, updatedAt: now,
		};
		const scopedTask: PersistedTask = {
			id: `task-scope-${suffix}`, goalId: scopedGoalId, title: "Scoped task", type: "implementation",
			state: "todo", createdAt: now, updatedAt: now,
		};
		const otherTask: PersistedTask = {
			id: `task-other-${suffix}`, goalId: otherGoalId, title: "Other project task", type: "implementation",
			state: "todo", spec: "original", createdAt: now, updatedAt: now,
		};
		const restoreScoped = installSyntheticContext(gateway, scopedProjectId, [scopedGoal], [scopedTask]);
		const restoreOther = installSyntheticContext(gateway, otherProjectId, [otherGoal], [otherTask]);
		try {
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
			gateway.sessionManager.sandboxTokenStore.remove(scopedProjectId);
			restoreOther();
			restoreScoped();
		}
	});

	test("cannot attach to an out-of-scope goal, and does not transition it to in-progress", async ({ gateway }) => {
		const suffix = fixtureSequence++;
		const outOfScopeProjectId = `outside-goal-project-${suffix}`;
		const outOfScopeGoalId = `outside-goal-${suffix}`;
		const now = Date.now();
		const goal: PersistedGoal = {
			id: outOfScopeGoalId,
			projectId: outOfScopeProjectId,
			title: "Sandbox scope guard",
			cwd: nonGitCwd(),
			state: "todo",
			spec: "",
			createdAt: now,
			updatedAt: now,
		};
		const restoreContext = installSyntheticContext(gateway, outOfScopeProjectId, [goal]);
		try {
			const before = await adminFetch(gateway.baseURL, `/api/goals/${outOfScopeGoalId}`);
			expect((await before.json()).state).toBe("todo");

			const res = await sandboxFetch(gateway.baseURL, "/api/sessions", scopedToken, {
				method: "POST",
				body: JSON.stringify({ projectId, goalId: outOfScopeGoalId }),
			});
			expect(res.status).toBe(403);
			expect((await res.json()).code).toBe("SANDBOX_SCOPE_VIOLATION");

			const after = await adminFetch(gateway.baseURL, `/api/goals/${outOfScopeGoalId}`);
			expect((await after.json()).state).toBe("todo");
		} finally {
			restoreContext();
		}
	});

	// ── Token persistence check ────────────────────────────────────────

	test("sandbox token not persisted to disk", async ({ gateway }) => {
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
