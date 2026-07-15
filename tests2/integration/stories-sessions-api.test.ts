/**
 * API coverage split out from browser session stories.
 *
 * Browser stories keep UI behavior coverage; these persistence/worktree
 * assertions do not need a spawned browser gateway.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	connectWs,
	createSession,
	registerProject,
	waitForSessionStatus,
} from "./_e2e/e2e-setup.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function removeTree(root: string): void {
	if (!root) return;
	try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort after assertions */ }
}

test.describe("Session story API invariants", () => {
	let repoRoot = "";
	let projectId = "";
	let sessionId = "";
	let sessionWorktree = "";

	test.beforeAll(async () => {
		// One immutable source graph serves both stories. The session still goes
		// through the production HTTP → worktree → agent setup pipeline; sharing its
		// completed lifecycle avoids starting and immediately tearing down a second
		// agent while metadata persistence is still in flight under suite load.
		repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-session-story-")));
		git(repoRoot, "init", "--quiet", "--initial-branch=master");
		fs.writeFileSync(path.join(repoRoot, "README.md"), "# Session story fixture\n");
		git(repoRoot, "add", "README.md");
		git(repoRoot, "-c", "user.email=e2e@bobbit.ai", "-c", "user.name=e2e", "commit", "--quiet", "-m", "immutable seed");

		const project = await registerProject({
			name: `session-story-${Date.now()}`,
			rootPath: repoRoot,
			seedWorkflows: false,
		});
		projectId = project.id;
		sessionId = await createSession({ cwd: repoRoot, projectId });
		await waitForSessionStatus(sessionId, "idle");
	});

	test.afterAll(async () => {
		try {
			if (sessionId) {
				const deleted = await apiFetch(`/api/sessions/${sessionId}?purge=true`, { method: "DELETE" });
				expect(deleted.ok, "session purge must succeed").toBe(true);
			}
			if (sessionWorktree) expect(fs.existsSync(sessionWorktree), "session worktree must be removed on termination").toBe(false);
			if (sessionId) {
				const resp = await apiFetch(`/api/sessions/${sessionId}`);
				expect(resp.status, "terminated session must leave the live-session API").toBe(404);
			}
		} finally {
			if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
			removeTree(`${repoRoot}-wt`);
			removeTree(repoRoot);
		}
	});

	test("S-08: session in git repo gets a worktree", async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(resp.ok).toBe(true);
		const data = await resp.json();

		expect(data.status).toBe("idle");
		expect(data.worktreePath).toBeTruthy();
		expect(typeof data.worktreePath).toBe("string");
		expect(data.branch).toBe(`session/${sessionId.slice(0, 8)}`);
		sessionWorktree = fs.realpathSync(data.worktreePath);
		expect(fs.statSync(path.join(sessionWorktree, ".git")).isFile()).toBe(true);
		expect(fs.realpathSync(git(sessionWorktree, "rev-parse", "--show-toplevel"))).toBe(sessionWorktree);
		const registeredWorktrees = git(repoRoot, "worktree", "list", "--porcelain").replace(/\\/g, "/");
		expect(registeredWorktrees).toContain(sessionWorktree.replace(/\\/g, "/"));
	});

	test("S-09/S-10: renamed title and session properties persist", async () => {
		// Reuse the fully-idle worktree session from S-08. This keeps the original
		// persistence assertions while ensuring teardown cannot stop the bridge
		// between its pre-idle metadata read and the idle transition.
		const patchResp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "My Custom Title", colorIndex: 5 }),
		});
		expect(patchResp.ok).toBe(true);

		const connection = await connectWs(sessionId);
		try {
			const cursor = connection.messageCount();
			connection.send({
				type: "set_model",
				provider: "anthropic",
				modelId: "claude-sonnet-4-20250514",
			});
			connection.send({ type: "get_state" });
			const state = await connection.waitForFrom(
				cursor,
				(message) =>
					message.type === "state" &&
					message.data?.model?.id === "claude-sonnet-4-20250514",
				5_000,
			);
			expect(state.data.model.provider).toBe("anthropic");
			expect(state.data.model.contextWindow).toBe(1_000_000);

			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${sessionId}`);
				if (!resp.ok) return undefined;
				const data = await resp.json();
				return {
					title: data.title,
					colorIndex: data.colorIndex,
					modelProvider: data.modelProvider,
					modelId: data.modelId,
				};
			}, { timeout: 5_000 }).toEqual({
				title: "My Custom Title",
				colorIndex: 5,
				modelProvider: "anthropic",
				modelId: "claude-sonnet-4-20250514",
			});
		} finally {
			connection.close();
		}
	});
});
