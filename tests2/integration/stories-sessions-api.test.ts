/**
 * API coverage split out from browser session stories.
 *
 * Browser stories keep UI behavior coverage; these persistence/worktree
 * assertions do not need a spawned browser gateway.
 */
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

async function withWorktreeDecisionSeam<T>(gateway: any, repoRoot: string, run: (capture: { cwd?: string; options?: any }) => Promise<T>): Promise<T> {
	const sessionManager = gateway.sessionManager;
	const runner = sessionManager.commandRunner;
	const originalExecFile = runner.execFile;
	const originalCreateSession = sessionManager.createSession;
	const originalGetSessionStore = sessionManager.getSessionStore;
	const capture: { cwd?: string; options?: any } = {};
	runner.execFile = async (command: string, args: readonly string[]) => {
		if (command !== "git") throw new Error(`unexpected command: ${command}`);
		if (args.join(" ") === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "" };
		if (args.join(" ") === "rev-parse --show-toplevel") return { stdout: `${repoRoot}\n`, stderr: "" };
		if (args.join(" ") === "rev-parse --verify HEAD") return { stdout: `${"d".repeat(40)}\n`, stderr: "" };
		throw new Error(`unexpected git command: ${args.join(" ")}`);
	};
	sessionManager.createSession = async (cwd: string, _args: unknown, _goalId: unknown, _assistantType: unknown, options: any) => {
		capture.cwd = cwd;
		capture.options = options;
		return { id: "session-worktree-decision", cwd, status: "preparing", projectId: options.projectId };
	};
	sessionManager.getSessionStore = () => ({ update: () => true });
	try {
		return await run(capture);
	} finally {
		runner.execFile = originalExecFile;
		sessionManager.createSession = originalCreateSession;
		sessionManager.getSessionStore = originalGetSessionStore;
	}
}

function removeTree(root: string): void {
	if (!root) return;
	try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort after assertions */ }
}

test.describe("Session story API invariants", () => {
	let repoRoot = "";
	let projectId = "";
	let sessionId = "";

	test.beforeEach(async () => {
		// Each story owns its project. A describe-level project is outside the
		// harness's per-test baseline and would be swept after the first story.
		repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-session-story-")));
		fs.writeFileSync(path.join(repoRoot, "README.md"), "# Session story fixture\n");

		const project = await registerProject({
			name: `session-story-${Date.now()}`,
			rootPath: repoRoot,
			seedWorkflows: false,
		});
		projectId = project.id;
		sessionId = "";
	});

	test.afterEach(async () => {
		try {
			if (sessionId) {
				const deleted = await apiFetch(`/api/sessions/${sessionId}?purge=true`, { method: "DELETE" });
				expect(deleted.ok, "session purge must succeed").toBe(true);
			}
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

	test("S-08: session in a detected repository selects worktree provisioning", async ({ gateway }) => {
		await withWorktreeDecisionSeam(gateway, repoRoot, async (capture) => {
			const resp = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: repoRoot, projectId, worktree: true }),
			});
			expect(resp.status, await resp.clone().text()).toBe(201);
			const data = await resp.json();
			expect(data.projectId).toBe(projectId);
			expect(capture.cwd).toBe(repoRoot);
			expect(capture.options?.worktreeOpts).toEqual({ repoPath: repoRoot });
		});
	});

	test("S-09/S-10: renamed title and session properties persist", async () => {
		// This story owns a fully-idle session so a fork-mate or the preceding
		// worktree-decision route cannot replace or sweep its persisted identity.
		sessionId = await createSession({ cwd: repoRoot, projectId });
		await waitForSessionStatus(sessionId, "idle");
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
