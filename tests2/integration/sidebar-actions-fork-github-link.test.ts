// Ported from tests/e2e/sidebar-actions-server.spec.ts (v2-integration tier).
//
// This file exercises the REST decision boundaries without provisioning Git
// processes. Worktree creation itself is covered by the dedicated Git suites.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { rebaseAgentTranscriptCwdMetadataFile } from "../../src/server/agent/transcript-sanitizer.js";
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	nonGitCwd,
	registerProject,
} from "./_e2e/e2e-setup.js";

function seedSessionTranscript(gateway: any, sessionId: string, entries: unknown[]): string {
	const session = gateway.sessionManager.getSession(sessionId);
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	if (!session || !persisted?.projectId) throw new Error(`session ${sessionId} was not persisted`);
	const jsonlPath = join(gateway.bobbitDir, "state", "session-prompts", `${sessionId}-fork-source.jsonl`);
	mkdirSync(dirname(jsonlPath), { recursive: true });
	writeFileSync(jsonlPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	session.agentSessionFile = jsonlPath;
	const ctx = gateway.sessionManager.getProjectContextManager().getOrCreate(persisted.projectId);
	ctx.sessionStore.update(sessionId, { agentSessionFile: jsonlPath });
	return jsonlPath;
}

function transcriptMessage(id: string, text: string): unknown {
	return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } };
}

type RuntimeCwdRecord = { type: "system" | "session"; cwd: string };

function readRuntimeCwdRecords(jsonlPath: string): RuntimeCwdRecord[] {
	const records: RuntimeCwdRecord[] = [];
	for (const line of readFileSync(jsonlPath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if ((parsed?.type === "system" || parsed?.type === "session") && typeof parsed.cwd === "string") {
				records.push({ type: parsed.type, cwd: parsed.cwd });
			}
		} catch { /* ignore malformed transcript lines */ }
	}
	return records;
}

function ensureStaleRuntimeCwdMetadata(jsonlPath: string, cwd: string, sessionId: string): void {
	appendFileSync(jsonlPath, `${JSON.stringify({ type: "system", subtype: "init", cwd })}\n`);
	appendFileSync(jsonlPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: `pi-style-${sessionId}`,
		timestamp: "2026-06-17T12:20:31.770Z",
		cwd,
	})}\n`);
}

function appendOldCwdMessageContentSentinels(jsonlPath: string, cwd: string, marker: string): { userLine: string; assistantLine: string } {
	const userLine = JSON.stringify({
		type: "message",
		id: `${marker}-user`,
		message: { role: "user", content: [{ type: "text", text: `${marker} user mentions old cwd ${cwd}` }] },
	});
	const assistantLine = JSON.stringify({
		type: "message",
		id: `${marker}-assistant`,
		message: { role: "assistant", content: [{ type: "text", text: `${marker} assistant mentions old cwd ${cwd}` }] },
	});
	appendFileSync(jsonlPath, `${userLine}\n${assistantLine}\n`);
	return { userLine, assistantLine };
}

async function withGithubRemote<T>(gateway: any, run: () => Promise<T>): Promise<T> {
	const runner = gateway.sessionManager.commandRunner;
	const originalExecFile = runner.execFile;
	runner.execFile = async (command: string, args: readonly string[]) => {
		if (command === "git" && args.join(" ") === "remote get-url origin") {
			return { stdout: "git@github.com:acme/widget.git\n", stderr: "" };
		}
		throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
	};
	try {
		return await run();
	} finally {
		runner.execFile = originalExecFile;
	}
}

type ForkCapture = {
	id: string;
	requestedCwd: string;
	resolvedCwd: string;
	options: any;
	clonedTranscript: string;
};

async function withForkCreateSeam<T>(
	gateway: any,
	repoPath: string,
	run: (captures: ForkCapture[]) => Promise<T>,
): Promise<T> {
	const sessionManager = gateway.sessionManager;
	const runner = sessionManager.commandRunner;
	const originalExecFile = runner.execFile;
	const originalCreateSession = sessionManager.createSession;
	const originalSetTitle = sessionManager.setTitle;
	const captures: ForkCapture[] = [];

	runner.execFile = async (command: string, args: readonly string[]) => {
		if (command !== "git") throw new Error(`unexpected command: ${command}`);
		if (args.join(" ") === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "" };
		if (args.join(" ") === "rev-parse --show-toplevel") return { stdout: `${repoPath}\n`, stderr: "" };
		throw new Error(`unexpected git command: ${args.join(" ")}`);
	};
	sessionManager.createSession = async (cwd: string, _agentArgs: unknown, _goalId: unknown, _assistantType: unknown, options: any) => {
		const id = options.sessionId;
		const resolvedCwd = options.worktreeOpts ? join(repoPath, `.fake-worktree-${id}`) : cwd;
		mkdirSync(resolvedCwd, { recursive: true });
		if (options.preExistingAgentSessionOldCwds?.length) {
			await rebaseAgentTranscriptCwdMetadataFile(
				{ sandboxed: false, projectId: options.projectId },
				options.preExistingAgentSessionFile,
				null,
				{ oldCwds: options.preExistingAgentSessionOldCwds, newCwd: resolvedCwd },
			);
		}
		captures.push({
			id,
			requestedCwd: cwd,
			resolvedCwd,
			options,
			clonedTranscript: options.preExistingAgentSessionFile,
		});
		return { id, cwd: resolvedCwd, status: "idle", projectId: options.projectId };
	};
	sessionManager.setTitle = () => {};
	try {
		return await run(captures);
	} finally {
		runner.execFile = originalExecFile;
		sessionManager.createSession = originalCreateSession;
		sessionManager.setTitle = originalSetTitle;
	}
}

function seedSyntheticSourceWorktree(gateway: any, sessionId: string, projectId: string, sourceWorktree: string, repoPath: string): void {
	mkdirSync(sourceWorktree, { recursive: true });
	const session = gateway.sessionManager.getSession(sessionId);
	if (!session) throw new Error(`source session ${sessionId} missing`);
	session.cwd = sourceWorktree;
	session.worktreePath = sourceWorktree;
	session.repoPath = repoPath;
	session.branch = `session/${sessionId.slice(0, 8)}`;
	const ctx = gateway.sessionManager.getProjectContextManager().getOrCreate(projectId);
	ctx.sessionStore.update(sessionId, {
		cwd: sourceWorktree,
		worktreePath: sourceWorktree,
		repoPath,
		branch: session.branch,
	});
}

test.describe.serial("sidebar actions server endpoints", () => {
	test("GET /api/goals/:id/github-link returns PR, branch fallback, and unavailable states", async ({ gateway }) => {
		const cwd = nonGitCwd();
		const linkGoal = await createGoal({ title: `sidebar link ${Date.now()}`, cwd, worktree: false, team: false });
		const noWorktreeGoal = await createGoal({ title: `sidebar no worktree ${Date.now()}`, cwd, worktree: false, team: false });
		try {
			gateway.sessionManager.getGoalStoreForProject(linkGoal.projectId).update(linkGoal.id, {
				branch: "feature/sidebar-pr-cache",
				repoPath: cwd,
				cwd,
				worktreePath: cwd,
			});
			gateway.sessionManager.prStatusStore.set(linkGoal.id, { state: "OPEN", url: "https://github.com/acme/widget/pull/123" });
			const prResp = await apiFetch(`/api/goals/${linkGoal.id}/github-link`);
			expect(prResp.status).toBe(200);
			expect(await prResp.json()).toMatchObject({ available: true, kind: "pr", url: "https://github.com/acme/widget/pull/123" });

			const noWorktreeResp = await apiFetch(`/api/goals/${noWorktreeGoal.id}/github-link`);
			expect(await noWorktreeResp.json()).toMatchObject({ available: false, reason: "no-worktree" });
			const missingResp = await apiFetch(`/api/goals/does-not-exist/github-link`);
			expect(await missingResp.json()).toMatchObject({ available: false, reason: "goal-not-found" });

			gateway.sessionManager.prStatusStore.remove(linkGoal.id);
			const branch = "feature/sidebar-actions";
			gateway.sessionManager.getGoalStoreForProject(linkGoal.projectId).update(linkGoal.id, { branch });
			const branchResp = await withGithubRemote(gateway, () => apiFetch(`/api/goals/${linkGoal.id}/github-link`));
			expect(branchResp.status).toBe(200);
			expect(await branchResp.json()).toMatchObject({
				available: true,
				kind: "branch",
				url: "https://github.com/acme/widget/tree/feature%2Fsidebar-actions",
			});
		} finally {
			await deleteGoal(linkGoal.id);
			await deleteGoal(noWorktreeGoal.id);
		}
	});
});

test.describe.serial("fork worktree choice", () => {
	let baseDir = "";
	let repoPath = "";
	let projectId = "";
	let sourceIds: string[] = [];

	test.beforeEach(async () => {
		baseDir = mkdtempSync(join(realpathSync(tmpdir()), `bobbit-v2-fork-seam-${process.pid}-`));
		repoPath = join(baseDir, "repo");
		mkdirSync(repoPath, { recursive: true });
		projectId = (await registerProject({ name: `fork-seam-${process.pid}-${Date.now()}`, rootPath: repoPath, seedWorkflows: false })).id;
		sourceIds = [];
	});

	test.afterEach(async () => {
		for (const sourceId of sourceIds) await deleteSession(sourceId).catch(() => {});
		if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		if (baseDir) rmSync(baseDir, { recursive: true, force: true });
		baseDir = "";
		repoPath = "";
		projectId = "";
		sourceIds = [];
	});

	test("newWorktree selects repo provisioning while reuse selects the source cwd", async ({ gateway }) => {
		const sourceId = await createSession({ cwd: repoPath, projectId });
		sourceIds.push(sourceId);
		const sourceWorktree = join(repoPath, `.synthetic-source-worktree-${sourceId}`);
		seedSyntheticSourceWorktree(gateway, sourceId, projectId, sourceWorktree, repoPath);
		seedSessionTranscript(gateway, sourceId, [transcriptMessage(`fork-${sourceId}`, "FORK_WT_MARKER")]);

		try {
			await withForkCreateSeam(gateway, repoPath, async (captures) => {
				const freshResp = await apiFetch(`/api/sessions/${sourceId}/fork`, {
					method: "POST",
					body: JSON.stringify({ newWorktree: true }),
				});
				expect(freshResp.status, await freshResp.clone().text()).toBe(201);
				const fresh = await freshResp.json();
				expect(fresh.title).toMatch(/^Fork: /);
				expect(fresh.projectId).toBe(projectId);
				expect(fresh.cwd).not.toBe(sourceWorktree);

				const reuseResp = await apiFetch(`/api/sessions/${sourceId}/fork`, {
					method: "POST",
					body: JSON.stringify({ newWorktree: false }),
				});
				expect(reuseResp.status, await reuseResp.clone().text()).toBe(201);
				const reuse = await reuseResp.json();
				expect(reuse.projectId).toBe(projectId);
				expect(reuse.cwd).toBe(sourceWorktree);

				expect(captures).toHaveLength(2);
				expect(captures[0].requestedCwd).toBe(repoPath);
				expect(captures[0].options.worktreeOpts).toEqual({ repoPath });
				expect(captures[1].requestedCwd).toBe(sourceWorktree);
				expect(captures[1].options.worktreeOpts).toBeUndefined();
			});
		} finally {
			await deleteSession(sourceId);
		}
	});

	test("newWorktree rebases cloned runtime cwd metadata off a stale source cwd", async ({ gateway }) => {
		const sourceId = await createSession({ cwd: repoPath, projectId });
		sourceIds.push(sourceId);
		const sourceWorktree = join(repoPath, `.synthetic-stale-${sourceId}`);
		seedSyntheticSourceWorktree(gateway, sourceId, projectId, sourceWorktree, repoPath);
		const marker = `FORK_STALE_CWD_${Date.now()}`;
		const sourceJsonl = seedSessionTranscript(gateway, sourceId, [
			transcriptMessage(`${marker}-prompt`, `${marker} hello from stale source`),
		]);
		ensureStaleRuntimeCwdMetadata(sourceJsonl, sourceWorktree, sourceId);
		const { userLine, assistantLine } = appendOldCwdMessageContentSentinels(sourceJsonl, sourceWorktree, marker);

		try {
			await withForkCreateSeam(gateway, repoPath, async (captures) => {
				const forkResp = await apiFetch(`/api/sessions/${sourceId}/fork`, {
					method: "POST",
					body: JSON.stringify({ newWorktree: true }),
				});
				expect(forkResp.status, await forkResp.clone().text()).toBe(201);
				expect(captures).toHaveLength(1);
				const capture = captures[0];
				expect(capture.options.preExistingAgentSessionOldCwds).toContain(sourceWorktree);
				expect(existsSync(capture.clonedTranscript)).toBe(true);

				const clonedText = readFileSync(capture.clonedTranscript, "utf8");
				expect(clonedText).toContain(marker);
				expect(clonedText).toContain(userLine);
				expect(clonedText).toContain(assistantLine);
				const runtimeRecords = readRuntimeCwdRecords(capture.clonedTranscript);
				expect(runtimeRecords).not.toContainEqual({ type: "system", cwd: sourceWorktree });
				expect(runtimeRecords).not.toContainEqual({ type: "session", cwd: sourceWorktree });
				expect(runtimeRecords).toContainEqual({ type: "system", cwd: capture.resolvedCwd });
				expect(runtimeRecords).toContainEqual({ type: "session", cwd: capture.resolvedCwd });
			});
		} finally {
			await deleteSession(sourceId);
		}
	});
});
