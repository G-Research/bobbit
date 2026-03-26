/**
 * End-to-end tests for Bobbit server APIs and WebSocket protocol.
 *
 * Tests run against a real gateway (started by Playwright webServer).
 * They verify:
 *   1. REST API endpoints (sessions, goals, tasks, artifacts, skills, health)
 *   2. WebSocket protocol (auth, ping/pong, set_title, client join/leave)
 *
 * Agent tool invocations (Read, Write, Edit, Bash) that spawn real agent
 * subprocesses have been moved to agent-tools-e2e.spec.ts (excluded by default).
 *
 * Run with: npm run build:server && npx playwright test --config playwright-e2e.config.ts tests/e2e/tools-e2e.spec.ts
 */
import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { readE2EToken, BASE, WS_BASE, waitForHealth, nonGitCwd } from "./e2e-setup.js";

// ---------------------------------------------------------------------------
// Config — agent tool tests need much longer timeouts
// ---------------------------------------------------------------------------
test.setTimeout(30_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN = readE2EToken();

/** Authenticated REST helper */
function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

/** Create a session, return its ID */
async function createSession(cwd?: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: cwd || nonGitCwd() }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return data.id;
}

/** Delete a session (best-effort, for cleanup) */
async function deleteSession(id: string): Promise<void> {
	await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

interface WsMsg { type: string; [key: string]: any }

/** Connect & authenticate a WebSocket to a session */
function connectWs(sessionId: string): Promise<{
	ws: WebSocket;
	messages: WsMsg[];
	waitFor: (pred: (m: WsMsg) => boolean, timeoutMs?: number) => Promise<WsMsg>;
	send: (msg: Record<string, unknown>) => void;
	close: () => void;
}> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${WS_BASE}/ws/${sessionId}`);
		const messages: WsMsg[] = [];
		const waiters: Array<{ pred: (m: WsMsg) => boolean; res: (m: WsMsg) => void; rej: (e: Error) => void }> = [];

		ws.on("message", (raw) => {
			const msg: WsMsg = JSON.parse(raw.toString());
			messages.push(msg);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].pred(msg)) {
					waiters[i].res(msg);
					waiters.splice(i, 1);
				}
			}
		});

		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: TOKEN })));
		ws.on("error", reject);

		const iv = setInterval(() => {
			if (messages.some((m) => m.type === "auth_ok")) {
				clearInterval(iv);
				resolve({
					ws, messages,
					waitFor(pred, timeoutMs = 30_000) {
						const existing = messages.find(pred);
						if (existing) return Promise.resolve(existing);
						return new Promise((res, rej) => {
							const t = setTimeout(() => rej(new Error(`WS waitFor timed out (${timeoutMs}ms)`)), timeoutMs);
							waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); }, rej });
						});
					},
					send: (m) => ws.send(JSON.stringify(m)),
					close: () => ws.close(),
				});
			}
		}, 50);

		setTimeout(() => { clearInterval(iv); reject(new Error("WS auth timeout")); }, 15_000);
	});
}

/** Wait for a tool_execution_start event with the given tool name (case-insensitive) */
function toolStartPredicate(toolName: string): (m: WsMsg) => boolean {
	const lower = toolName.toLowerCase();
	return (m) =>
		m.type === "event" &&
		m.data?.type === "tool_execution_start" &&
		(m.data?.toolName || "").toLowerCase() === lower;
}

/** Wait for agent_end (turn finished) */
function agentEndPredicate(): (m: WsMsg) => boolean {
	return (m) => m.type === "event" && m.data?.type === "agent_end";
}

// Wait for the server to be fully ready (replaces fixed sleep)
test.beforeAll(async () => {
	await waitForHealth();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. REST API — Health
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Health endpoint", () => {
	test("GET /api/health returns ok", async () => {
		const resp = await apiFetch("/api/health");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.status).toBe("ok");
		expect(typeof data.sessions).toBe("number");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. REST API — Sessions CRUD
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Sessions API", () => {
	let sessionId: string;
	test.afterEach(async () => { if (sessionId) { await deleteSession(sessionId); sessionId = ""; } });

	test("POST creates a session", async () => {
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.id).toBeTruthy();
		expect(data.status).toBeTruthy();
		sessionId = data.id;
	});

	test("GET lists sessions", async () => {
		sessionId = await createSession();
		const resp = await apiFetch("/api/sessions");
		expect(resp.status).toBe(200);
		const { sessions } = await resp.json();
		expect(Array.isArray(sessions)).toBe(true);
		expect(sessions.some((s: any) => s.id === sessionId)).toBe(true);
	});

	test("GET /:id returns a single session", async () => {
		sessionId = await createSession();
		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.id).toBe(sessionId);
		expect(data.cwd).toBeTruthy();
	});

	test("GET /:id returns 404 for non-existent", async () => {
		const resp = await apiFetch("/api/sessions/nonexistent-id-12345");
		expect(resp.status).toBe(404);
	});

	test("DELETE terminates a session", async () => {
		sessionId = await createSession();
		const resp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		expect(resp.status).toBe(200);
		const listResp = await apiFetch("/api/sessions");
		const { sessions } = await listResp.json();
		expect(sessions.some((s: any) => s.id === sessionId)).toBe(false);
		sessionId = "";
	});

	test("PATCH updates colorIndex", async () => {
		sessionId = await createSession();
		const resp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ colorIndex: 7 }),
		});
		expect(resp.status).toBe(200);
		const getResp = await apiFetch(`/api/sessions/${sessionId}`);
		expect((await getResp.json()).colorIndex).toBe(7);
	});

	test("PATCH updates accessory", async () => {
		sessionId = await createSession();
		const resp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ accessory: "crown" }),
		});
		expect(resp.status).toBe(200);
	});

	test("PATCH updates preview flag", async () => {
		sessionId = await createSession();
		const resp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ preview: true }),
		});
		expect(resp.status).toBe(200);
		const getResp = await apiFetch(`/api/sessions/${sessionId}`);
		expect((await getResp.json()).preview).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. REST API — Goals CRUD
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Goals API", () => {
	let goalId: string;
	test.afterEach(async () => { if (goalId) { await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {}); goalId = ""; } });

	test("POST creates a goal", async () => {
		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "E2E test goal", cwd: nonGitCwd(), spec: "Test spec" }),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.id).toBeTruthy();
		expect(data.title).toBe("E2E test goal");
		expect(data.state).toBe("todo");
		goalId = data.id;
	});

	test("GET lists goals", async () => {
		const resp1 = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "List test", cwd: nonGitCwd() }),
		});
		goalId = (await resp1.json()).id;
		const resp = await apiFetch("/api/goals");
		expect(resp.status).toBe(200);
		const { goals } = await resp.json();
		expect(goals.some((g: any) => g.id === goalId)).toBe(true);
	});

	test("GET /:id returns a single goal", async () => {
		const resp1 = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Get test", cwd: nonGitCwd(), spec: "spec here" }),
		});
		goalId = (await resp1.json()).id;
		const resp = await apiFetch(`/api/goals/${goalId}`);
		expect(resp.status).toBe(200);
		expect((await resp.json()).spec).toBe("spec here");
	});

	test("PUT updates a goal", async () => {
		const resp1 = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Update test", cwd: nonGitCwd() }),
		});
		goalId = (await resp1.json()).id;
		const resp = await apiFetch(`/api/goals/${goalId}`, {
			method: "PUT",
			body: JSON.stringify({ title: "Updated title", state: "in-progress" }),
		});
		expect(resp.status).toBe(200);
		const getResp = await apiFetch(`/api/goals/${goalId}`);
		const data = await getResp.json();
		expect(data.title).toBe("Updated title");
		expect(data.state).toBe("in-progress");
	});

	test("DELETE archives a goal (soft-delete)", async () => {
		const resp1 = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Archive test", cwd: nonGitCwd() }),
		});
		goalId = (await resp1.json()).id;
		const resp = await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" });
		expect(resp.status).toBe(200);
		// Goal still exists but is archived
		const getResp = await apiFetch(`/api/goals/${goalId}`);
		expect(getResp.status).toBe(200);
		const data = await getResp.json();
		expect(data.archived).toBe(true);
		expect(data.archivedAt).toBeGreaterThan(0);
		// Mutations should be rejected with 409
		const putResp = await apiFetch(`/api/goals/${goalId}`, {
			method: "PUT",
			body: JSON.stringify({ title: "Should fail" }),
		});
		expect(putResp.status).toBe(409);
		goalId = "";
	});

	test("creating a session under a goal auto-transitions to in-progress", async () => {
		const resp1 = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Integration test goal", cwd: nonGitCwd() }),
		});
		goalId = (await resp1.json()).id;
		expect((await (await apiFetch(`/api/goals/${goalId}`)).json()).state).toBe("todo");

		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ goalId, cwd: nonGitCwd() }),
		});
		const sessId = (await sessResp.json()).id;

		expect((await (await apiFetch(`/api/goals/${goalId}`)).json()).state).toBe("in-progress");
		await deleteSession(sessId);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. REST API — Tasks (under a team goal)
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Tasks API", () => {
	let goalId: string;

	test.beforeEach(async () => {
		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Task test goal " + Date.now(), cwd: nonGitCwd(), team: true, worktree: false }),
		});
		goalId = (await resp.json()).id;
	});
	test.afterEach(async () => {
		if (goalId) await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {});
	});

	test("creates a non-implementation task without design-doc", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Refactor X", type: "refactor", spec: "Clean up" }),
		});
		expect(resp.status).toBe(201);
		const task = await resp.json();
		expect(task.id).toBeTruthy();
		expect(task.title).toBe("Refactor X");
		expect(task.state).toBe("todo");
	});

	test("allows implementation task without artifact requirements", async () => {
		// Task creation no longer enforces artifact requirements
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Impl Y", type: "implementation" }),
		});
		expect(resp.status).toBe(201);
	});

	test("accepts any task type string", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Custom type", type: "my-custom-type" }),
		});
		expect(resp.status).toBe(201);
	});

	test("GET lists tasks for a goal", async () => {
		await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "List test task", type: "refactor" }),
		});
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`);
		expect(resp.status).toBe(200);
		const { tasks } = await resp.json();
		expect(tasks.some((t: any) => t.title === "List test task")).toBe(true);
	});

	test("PUT /api/tasks/:id updates task state", async () => {
		const createResp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Update me", type: "refactor" }),
		});
		const task = await createResp.json();

		// Task update uses /api/tasks/:id (not under /goals/)
		const resp = await apiFetch(`/api/tasks/${task.id}`, {
			method: "PUT",
			body: JSON.stringify({ state: "in-progress", spec: "Updated spec" }),
		});
		expect(resp.status).toBe(200);

		const getResp = await apiFetch(`/api/tasks/${task.id}`);
		const updated = await getResp.json();
		expect(updated.state).toBe("in-progress");
		expect(updated.spec).toBe("Updated spec");
	});

	test("DELETE /api/tasks/:id removes a task", async () => {
		const createResp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Delete me", type: "refactor" }),
		});
		const task = await createResp.json();

		const resp = await apiFetch(`/api/tasks/${task.id}`, { method: "DELETE" });
		expect(resp.status).toBe(200);

		const getResp = await apiFetch(`/api/tasks/${task.id}`);
		expect(getResp.status).toBe(404);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. REST API — Gates (replaced Artifacts)
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Artifacts API", () => {
	let goalId: string;

	test.beforeEach(async () => {
		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Gate test " + Date.now(), cwd: nonGitCwd(), team: false, workflowId: "general" }),
		});
		goalId = (await resp.json()).id;
	});
	test.afterEach(async () => {
		if (goalId) await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {});
	});

	test("CRUD lifecycle", async () => {
		// List gates
		const listResp = await apiFetch(`/api/goals/${goalId}/gates`);
		expect(listResp.status).toBe(200);
		const { gates } = await listResp.json();
		expect(gates.length).toBeGreaterThan(0);
		expect(gates[0].status).toBe("pending");

		// Get gate detail
		const getResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc`);
		expect(getResp.status).toBe(200);
		const gate = await getResp.json();
		expect(gate.gateId).toBe("design-doc");
	});

	test("returns 404 for non-existent artifact", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/gates/nonexistent`);
		expect(resp.status).toBe(404);
	});
});

test.describe("Slash Skills API", () => {
	test("GET /api/slash-skills discovers SKILL.md files", async () => {
		// Create a test skill in .claude/skills/ under an isolated temp dir
		// to avoid cache collisions with other tests
		const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { join } = await import("node:path");
		const tmpCwd = join(process.cwd(), `.e2e-slash-skill-test-${Date.now()}`);
		const skillDir = join(tmpCwd, ".claude", "skills", "test-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), `---
name: test-skill
description: A test skill for E2E
argument-hint: <thing>
---

Do something with $ARGUMENTS.
`);

		try {
			const resp = await apiFetch(`/api/slash-skills?cwd=${encodeURIComponent(tmpCwd)}`);
			expect(resp.status).toBe(200);
			const { skills } = await resp.json();
			expect(Array.isArray(skills)).toBe(true);
			const testSkill = skills.find((s: any) => s.name === "test-skill");
			expect(testSkill).toBeTruthy();
			expect(testSkill.description).toBe("A test skill for E2E");
			expect(testSkill.argumentHint).toBe("<thing>");
			expect(testSkill.source).toBe("project");
		} finally {
			rmSync(tmpCwd, { recursive: true, force: true });
		}
	});

	test("GET /api/slash-skills returns array for empty cwd", async () => {
		const { mkdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		const tmpCwd = join(process.cwd(), `.e2e-slash-empty-${Date.now()}`);
		mkdirSync(tmpCwd, { recursive: true });
		try {
			const resp = await apiFetch(`/api/slash-skills?cwd=${encodeURIComponent(tmpCwd)}`);
			expect(resp.status).toBe(200);
			const { skills } = await resp.json();
			expect(Array.isArray(skills)).toBe(true);
		} finally {
			const { rmSync } = await import("node:fs");
			rmSync(tmpCwd, { recursive: true, force: true });
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. REST API — Auth enforcement
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Auth enforcement", () => {
	test("rejects unauthenticated requests", async () => {
		expect((await fetch(`${BASE}/api/sessions`)).status).toBe(401);
		expect((await fetch(`${BASE}/api/goals`)).status).toBe(401);
	});

	test("rejects invalid token", async () => {
		const resp = await fetch(`${BASE}/api/sessions`, {
			headers: { Authorization: "Bearer invalid-token-12345" },
		});
		expect(resp.status).toBe(401);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. WebSocket — Auth & basic protocol
// ═══════════════════════════════════════════════════════════════════════════

test.describe("WebSocket protocol", () => {
	let sessionId: string;
	test.afterEach(async () => { if (sessionId) { await deleteSession(sessionId); sessionId = ""; } });

	test("authenticates and receives initial state", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			expect(conn.messages.some((m) => m.type === "auth_ok")).toBe(true);
			const status = await conn.waitFor((m) => m.type === "session_status");
			expect(typeof status.status).toBe("string");
			const title = await conn.waitFor((m) => m.type === "session_title");
			expect(title.sessionId).toBe(sessionId);
			const queue = await conn.waitFor((m) => m.type === "queue_update");
			expect(queue.queue).toEqual([]);
		} finally {
			conn.close();
		}
	});

	test("rejects invalid auth token", async () => {
		sessionId = await createSession();
		const result = await new Promise<string>((resolve) => {
			const ws = new WebSocket(`${WS_BASE}/ws/${sessionId}`);
			ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: "bad-token" })));
			ws.on("message", (data) => {
				const msg = JSON.parse(data.toString());
				if (msg.type === "auth_failed") resolve("auth_failed");
			});
			ws.on("close", (code) => resolve(`closed:${code}`));
			setTimeout(() => resolve("timeout"), 5000);
		});
		expect(result).toBe("auth_failed");
	});

	test("ping/pong works", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "ping" });
			const pong = await conn.waitFor((m) => m.type === "pong");
			expect(pong.type).toBe("pong");
		} finally {
			conn.close();
		}
	});

	test("set_title updates session title", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "set_title", title: "My Custom Title" });
			const titleMsg = await conn.waitFor(
				(m) => m.type === "session_title" && m.title === "My Custom Title",
			);
			expect(titleMsg.title).toBe("My Custom Title");

			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			expect((await resp.json()).title).toBe("My Custom Title");
		} finally {
			conn.close();
		}
	});

	test("second client gets client_joined, first gets client_left on disconnect", async () => {
		sessionId = await createSession();
		const conn1 = await connectWs(sessionId);
		try {
			const conn2 = await connectWs(sessionId);
			const joinMsg = await conn1.waitFor((m) => m.type === "client_joined", 5000);
			expect(joinMsg.clientId).toBeTruthy();

			conn2.close();
			const leftMsg = await conn1.waitFor((m) => m.type === "client_left", 5000);
			expect(leftMsg.clientId).toBeTruthy();
		} finally {
			conn1.close();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 9-10. Session lifecycle + Agent tools — moved to agent-tools-e2e.spec.ts
//       (spawns real pi-coding-agent processes; excluded from default E2E runs)
// ═══════════════════════════════════════════════════════════════════════════
