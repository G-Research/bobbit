/**
 * API coverage split out from browser session stories.
 *
 * Browser stories keep UI behavior coverage; these persistence/worktree
 * assertions do not need a spawned browser gateway.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	connectWs,
	harnessDefaultProjectRoot,
} from "./_e2e/e2e-setup.js";
import { installCommandRunnerInterceptor, installMethodInterceptor } from "./helpers/command-runner-dispatcher.js";

function canonicalPath(value: string): string {
	try { return realpathSync(value); } catch { return resolve(value); }
}

async function withWorktreeDecisionSeam<T>(
	gateway: any,
	repoRoot: string,
	projectId: string,
	run: (capture: { cwd?: string; options?: any }) => Promise<T>,
): Promise<T> {
	const sessionManager = gateway.sessionManager;
	const expectedRoot = canonicalPath(repoRoot);
	const capture: { cwd?: string; options?: any } = {};
	const releaseRunner = installCommandRunnerInterceptor(sessionManager.commandRunner, {
		label: `stories-worktree-git:${expectedRoot}`,
		async execFile(command, args, options, next) {
			const cwd = canonicalPath(typeof options?.cwd === "string" ? options.cwd : process.cwd());
			const executable = basename(command).replace(/\.exe$/i, "").toLowerCase();
			if (cwd !== expectedRoot || executable !== "git") return next();
			if (args.join(" ") === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "" };
			if (args.join(" ") === "rev-parse --show-toplevel") return { stdout: `${repoRoot}\n`, stderr: "" };
			if (args.join(" ") === "rev-parse --verify HEAD") return { stdout: `${"d".repeat(40)}\n`, stderr: "" };
			throw new Error(`unexpected git command for ${expectedRoot}: ${args.join(" ")}`);
		},
	});
	const releaseCreate = installMethodInterceptor(sessionManager, "createSession", `stories-worktree-create:${expectedRoot}`, async (args, next) => {
		const [cwd, , , , rawOptions] = args;
		const options = rawOptions as { projectId?: string } | undefined;
		if (
			typeof cwd !== "string"
			|| canonicalPath(cwd) !== expectedRoot
			|| options?.projectId !== projectId
		) return next(...args);
		capture.cwd = cwd;
		capture.options = options;
		return { id: "session-worktree-decision", cwd, status: "preparing", projectId: options.projectId };
	});
	try {
		return await run(capture);
	} finally {
		releaseCreate();
		releaseRunner();
	}
}

function seedLiveStorySession(gateway: any): { sessionId: string; cleanup: () => void } {
	const sessionManager = gateway.sessionManager;
	const projectId = gateway.defaultProjectId;
	const sessionId = `session-story-${randomUUID()}`;
	const cwd = harnessDefaultProjectRoot();
	const now = Date.now();
	let model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
	const session = {
		id: sessionId,
		title: "Session story fixture",
		titleGenerated: true,
		cwd,
		projectId,
		status: "idle",
		statusVersion: 0,
		createdAt: now,
		lastActivity: now,
		clients: new Set(),
		isCompacting: false,
		eventBuffer: { size: 0 },
		promptQueue: { toArray: () => [] },
		rpcClient: {
			async setModel(provider: string, id: string) { model = { provider, id }; },
			async getState() { return { success: true, data: { model } }; },
		},
	};
	const store = sessionManager.getSessionStore(projectId);
	sessionManager.sessions.set(sessionId, session);
	store.put({
		id: sessionId,
		title: session.title,
		cwd,
		agentSessionFile: "",
		createdAt: now,
		lastActivity: now,
		projectId,
	});
	return {
		sessionId,
		cleanup() {
			sessionManager.sessions.delete(sessionId);
			store.remove(sessionId);
		},
	};
}

test.describe("Session story API invariants", () => {
	test("S-08: session in a detected repository selects worktree provisioning", async ({ gateway }) => {
		const repoRoot = harnessDefaultProjectRoot();
		const projectId = gateway.defaultProjectId;
		await withWorktreeDecisionSeam(gateway, repoRoot, projectId, async (capture) => {
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

	test("S-09/S-10: renamed title and session properties persist", async ({ gateway }) => {
		const fixture = seedLiveStorySession(gateway);
		try {
			const patchResp = await apiFetch(`/api/sessions/${fixture.sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "My Custom Title", colorIndex: 5 }),
			});
			expect(patchResp.ok).toBe(true);

			const connection = await connectWs(fixture.sessionId);
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
					1_000,
				);
				expect(state.data.model.provider).toBe("anthropic");
				expect(state.data.model.contextWindow).toBe(1_000_000);

				const resp = await apiFetch(`/api/sessions/${fixture.sessionId}`);
				expect(resp.ok).toBe(true);
				expect(await resp.json()).toMatchObject({
					title: "My Custom Title",
					colorIndex: 5,
					modelProvider: "anthropic",
					modelId: "claude-sonnet-4-20250514",
				});
			} finally {
				connection.close();
			}
		} finally {
			fixture.cleanup();
		}
	});
});
