/**
 * E2E tests for session auto-worktree feature.
 *
 * Verifies that non-goal, non-assistant sessions automatically get a git
 * worktree branch, while assistant sessions skip worktree creation.
 * Also tests worktree cleanup on session termination.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base, gitCwd } from "./e2e-setup.js";
import { existsSync } from "node:fs";

let token: string;

function headers() {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
}

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
	return fetch(`${base()}${path}`, {
		...opts,
		headers: { ...headers(), ...(opts?.headers || {}) },
	});
}

/**
 * Wait for a session to leave "preparing" status (worktree setup is async).
 */
async function waitForSessionReady(sessionId: string, timeoutMs = 30_000): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		if (resp.ok) {
			const data = await resp.json();
			if (data.status !== "preparing") return data;
		}
		await new Promise(r => setTimeout(r, 200));
	}
	throw new Error(`Session ${sessionId} did not leave "preparing" within ${timeoutMs}ms`);
}

test.beforeAll(() => {
	token = readE2EToken();
});

test.describe("Session auto-worktree", () => {
	const createdSessionIds: string[] = [];

	test.afterAll(async () => {
		// Best-effort cleanup
		for (const id of createdSessionIds) {
			await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("non-goal session gets a worktree branch", async () => {
		const cwd = gitCwd();
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd }),
		});
		expect(resp.status).toBe(201);
		const created = await resp.json();
		createdSessionIds.push(created.id);

		// Wait for session to be ready (worktree setup is async)
		const session = await waitForSessionReady(created.id);

		// Verify session has a worktreePath
		expect(session.worktreePath).toBeTruthy();
		expect(typeof session.worktreePath).toBe("string");

		// Verify the worktree directory exists on disk
		expect(existsSync(session.worktreePath)).toBe(true);

		// Verify session cwd is the worktree path (not the original repo)
		expect(session.cwd).toBe(session.worktreePath);

		// Verify git-status endpoint shows a session/* branch
		const gitStatusResp = await apiFetch(`/api/sessions/${created.id}/git-status`);
		expect(gitStatusResp.ok).toBe(true);
		const gitStatus = await gitStatusResp.json();
		expect(gitStatus.branch).toMatch(/^session\/new-session-[a-f0-9]{8}$/);
	});

	test("assistant sessions do NOT get worktrees", async () => {
		const cwd = gitCwd();
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd, assistantType: "goal" }),
		});
		expect(resp.status).toBe(201);
		const created = await resp.json();
		createdSessionIds.push(created.id);

		// Wait briefly for session to initialize
		const session = await waitForSessionReady(created.id);

		// Assistant sessions should NOT have a worktreePath
		expect(session.worktreePath).toBeFalsy();

		// The cwd should be the original path (not a worktree)
		// Assistant sessions don't change their cwd to a worktree
		expect(session.cwd).toBe(cwd);
	});

	test("worktree is cleaned up on session terminate", async () => {
		const cwd = gitCwd();
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd }),
		});
		expect(resp.status).toBe(201);
		const created = await resp.json();

		// Wait for worktree to be ready
		const session = await waitForSessionReady(created.id);
		expect(session.worktreePath).toBeTruthy();

		const worktreePath = session.worktreePath;
		expect(existsSync(worktreePath)).toBe(true);

		// Terminate and purge the session (purge triggers worktree cleanup)
		const delResp = await apiFetch(`/api/sessions/${created.id}?purge=true`, {
			method: "DELETE",
		});
		expect(delResp.status).toBe(200);

		// Poll until the worktree directory is removed (cleanup is async)
		const start = Date.now();
		while (existsSync(worktreePath) && Date.now() - start < 15_000) {
			await new Promise(r => setTimeout(r, 500));
		}
		expect(existsSync(worktreePath)).toBe(false);
	});
});
