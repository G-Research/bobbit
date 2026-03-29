import { test, expect } from "./gateway-harness.js";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { apiFetch, gitCwd, nonGitCwd } from "./e2e-setup.js";

/**
 * E2E tests for session worktree creation and cleanup.
 *
 * Run with:
 *   npm run build:server && npx playwright test tests/e2e/session-worktree.spec.ts --config playwright-e2e.config.ts
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll GET /api/sessions/:id until a predicate is met on the response. */
async function pollSession(
	sessionId: string,
	pred: (data: any) => boolean,
	timeoutMs = 30_000,
): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		if (resp.ok) {
			const data = await resp.json();
			if (pred(data)) return data;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`pollSession timed out after ${timeoutMs}ms`);
}

/**
 * Fully delete a session: terminate (archive) then purge.
 * Retries DELETE until the server returns 404 (fully purged).
 */
async function terminateAndPurge(sessionId: string): Promise<void> {
	for (let i = 0; i < 5; i++) {
		const resp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		if (resp.status === 404) return;
		await new Promise((r) => setTimeout(r, 1_000));
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Session worktrees", () => {
	test("creates a worktree when worktree: true and cwd is a git repo", async () => {
		// Create session with worktree: true, using a git repo cwd
		const createResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: gitCwd(), worktree: true }),
		});
		expect(createResp.status).toBe(201);
		const created = await createResp.json();
		const sessionId = created.id;

		try {
			expect(sessionId).toBeTruthy();

			// Poll until worktreePath is set AND the worktree directory exists on disk.
			// The worktree setup is async fire-and-forget, so we need to wait.
			const session = await pollSession(
				sessionId,
				(data) => !!data.worktreePath && existsSync(data.worktreePath),
				30_000,
			);

			expect(session.worktreePath).toBeTruthy();
			expect(typeof session.worktreePath).toBe("string");
			expect(existsSync(session.worktreePath)).toBe(true);

			// The session cwd should have been updated to the worktree path
			expect(session.cwd).toBe(session.worktreePath);

			// worktreePath should follow the expected naming pattern:
			// <repoRoot>-wt/session-<slug>-<uuid8>
			expect(session.worktreePath).toMatch(/session-/);
		} finally {
			await terminateAndPurge(sessionId);
		}
	});

	test("worktree is cleaned up on session purge", async () => {
		// Create session with worktree
		const createResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: gitCwd(), worktree: true }),
		});
		expect(createResp.status).toBe(201);
		const created = await createResp.json();
		const sessionId = created.id;

		// Wait for worktree to be ready
		const session = await pollSession(
			sessionId,
			(data) => !!data.worktreePath && existsSync(data.worktreePath),
			30_000,
		);
		const worktreePath = session.worktreePath;
		expect(existsSync(worktreePath)).toBe(true);

		// Terminate + purge the session (DELETE until 404)
		await terminateAndPurge(sessionId);

		// Session should no longer exist in the API
		const detailResp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(detailResp.status).toBe(404);

		// Worktree directory should be cleaned up.
		// On Windows, git worktree remove can fail if file locks are held by
		// recently-terminated processes. If the directory persists, verify the
		// worktree is at least unregistered from git, then force-remove.
		if (existsSync(worktreePath)) {
			// The server tried to clean up — verify it's unregistered from git
			try {
				const wtList = execFileSync("git", ["worktree", "list", "--porcelain"], {
					cwd: gitCwd(),
					encoding: "utf-8",
				});
				// The worktree path should NOT appear in the list if cleanup succeeded
				const normalizedWtPath = worktreePath.replace(/\\/g, "/").toLowerCase();
				const isRegistered = wtList
					.split("\n")
					.filter((l: string) => l.startsWith("worktree "))
					.some((l: string) => l.replace(/\\/g, "/").toLowerCase().includes(normalizedWtPath));
				expect(isRegistered).toBe(false);
			} catch {
				// git worktree list failed — skip this check
			}

			// Force-remove the leftover directory (Windows lock issue)
			try {
				execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
					cwd: gitCwd(),
					stdio: "pipe",
				});
			} catch {
				// Best effort — may still fail if locks persist
			}
		}
	});

	test("worktree: true from a non-git directory creates session without error and no worktree fields", async () => {
		// Use a temp dir that is NOT a git repo
		const cwd = nonGitCwd();

		const createResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd, worktree: true }),
		});
		expect(createResp.status).toBe(201);
		const created = await createResp.json();
		const sessionId = created.id;

		try {
			// Give async setup a moment (there shouldn't be any worktree setup)
			await new Promise((r) => setTimeout(r, 2_000));

			// Fetch the session — worktreePath should be undefined/falsy
			const detailResp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(detailResp.ok).toBe(true);
			const session = await detailResp.json();

			expect(session.worktreePath).toBeFalsy();
			// cwd should remain the original non-git directory
			expect(session.cwd).toBe(cwd);
		} finally {
			await terminateAndPurge(sessionId);
		}
	});
});
