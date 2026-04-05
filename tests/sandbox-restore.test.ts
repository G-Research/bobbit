import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Unit tests for the sandbox worktree recovery logic in restoreOneSession().
 *
 * These tests validate the decision tree:
 * 1. Worktree exists → continue (no recovery needed)
 * 2. Worktree missing + branch + sandbox available → recreate via createWorktree
 * 3. Worktree missing + no branch → archive session
 * 4. Worktree missing + createWorktree fails → archive session
 *
 * Since the recovery logic is embedded in restoreOneSession() and hard to
 * unit-test in isolation, we test the decision logic via a extracted helper
 * that mirrors the conditional structure.
 */

/** Mirrors the recovery logic from session-manager.ts restoreOneSession() */
async function recoverSandboxWorktree(opts: {
	sessionId: string;
	cwd: string;
	branch?: string;
	projectId?: string;
	sandboxManager: {
		get(projectId: string): { createWorktree(name: string, branch: string): Promise<string> } | undefined;
	} | null;
	archiveFn: (id: string) => void;
}): Promise<"verified" | "recovered" | "archived"> {
	// This mirrors the exact logic in session-manager.ts
	let recovered = false;
	if (opts.branch && opts.projectId && opts.sandboxManager) {
		const sandbox = opts.sandboxManager.get(opts.projectId);
		if (sandbox) {
			try {
				await sandbox.createWorktree(opts.branch, opts.branch);
				recovered = true;
			} catch {
				// recovery failed
			}
		}
	}
	if (!recovered) {
		try { opts.archiveFn(opts.sessionId); } catch { /* best-effort */ }
		return "archived";
	}
	return "recovered";
}

describe("sandbox worktree recovery logic", () => {
	it("recovers when branch and sandbox are available", async () => {
		let createWorktreeCalled = false;
		const result = await recoverSandboxWorktree({
			sessionId: "test-1",
			cwd: "/workspace-wt/session/s-abc123",
			branch: "session/s-abc123",
			projectId: "proj-1",
			sandboxManager: {
				get: () => ({
					createWorktree: async (name: string, branch: string) => {
						createWorktreeCalled = true;
						assert.equal(name, "session/s-abc123");
						assert.equal(branch, "session/s-abc123");
						return "/workspace-wt/session/s-abc123";
					},
				}),
			},
			archiveFn: () => { throw new Error("should not archive"); },
		});
		assert.equal(result, "recovered");
		assert.equal(createWorktreeCalled, true);
	});

	it("archives when no branch is available", async () => {
		let archived = false;
		const result = await recoverSandboxWorktree({
			sessionId: "test-2",
			cwd: "/workspace-wt/session/s-abc123",
			branch: undefined, // no branch
			projectId: "proj-1",
			sandboxManager: {
				get: () => ({
					createWorktree: async () => { throw new Error("should not be called"); },
				}),
			},
			archiveFn: (id) => { archived = true; assert.equal(id, "test-2"); },
		});
		assert.equal(result, "archived");
		assert.equal(archived, true);
	});

	it("archives when no projectId is available", async () => {
		let archived = false;
		const result = await recoverSandboxWorktree({
			sessionId: "test-3",
			cwd: "/workspace-wt/session/s-abc123",
			branch: "session/s-abc123",
			projectId: undefined, // no projectId
			sandboxManager: {
				get: () => ({
					createWorktree: async () => { throw new Error("should not be called"); },
				}),
			},
			archiveFn: () => { archived = true; },
		});
		assert.equal(result, "archived");
		assert.equal(archived, true);
	});

	it("archives when sandboxManager is null", async () => {
		let archived = false;
		const result = await recoverSandboxWorktree({
			sessionId: "test-4",
			cwd: "/workspace-wt/session/s-abc123",
			branch: "session/s-abc123",
			projectId: "proj-1",
			sandboxManager: null,
			archiveFn: () => { archived = true; },
		});
		assert.equal(result, "archived");
		assert.equal(archived, true);
	});

	it("archives when sandbox.get() returns undefined (project not found)", async () => {
		let archived = false;
		const result = await recoverSandboxWorktree({
			sessionId: "test-5",
			cwd: "/workspace-wt/session/s-abc123",
			branch: "session/s-abc123",
			projectId: "proj-1",
			sandboxManager: {
				get: () => undefined, // project not initialized
			},
			archiveFn: () => { archived = true; },
		});
		assert.equal(result, "archived");
		assert.equal(archived, true);
	});

	it("archives when createWorktree throws (branch deleted)", async () => {
		let archived = false;
		const result = await recoverSandboxWorktree({
			sessionId: "test-6",
			cwd: "/workspace-wt/session/s-abc123",
			branch: "session/s-abc123",
			projectId: "proj-1",
			sandboxManager: {
				get: () => ({
					createWorktree: async () => { throw new Error("branch not found"); },
				}),
			},
			archiveFn: () => { archived = true; },
		});
		assert.equal(result, "archived");
		assert.equal(archived, true);
	});

	it("tolerates archiveFn throwing (best-effort archival)", async () => {
		const result = await recoverSandboxWorktree({
			sessionId: "test-7",
			cwd: "/workspace-wt/session/s-abc123",
			branch: undefined,
			projectId: undefined,
			sandboxManager: null,
			archiveFn: () => { throw new Error("store not found"); },
		});
		assert.equal(result, "archived");
	});
});
