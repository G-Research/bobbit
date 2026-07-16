// Ported from tests/e2e/sidebar-actions-server.spec.ts (v2-integration tier).
//
// This file exercises the REST decision boundaries without provisioning Git
// processes. Worktree creation itself is covered by the dedicated Git suites.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { rebaseAgentTranscriptCwdMetadataFile } from "../../src/server/agent/transcript-sanitizer.js";
import { test, expect } from "./_e2e/in-process-harness.js";
import { installCommandRunnerInterceptor, installMethodInterceptor } from "./helpers/command-runner-dispatcher.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	harnessDefaultProjectRoot,
	nonGitCwd,
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

function canonicalPath(value: string): string {
	try { return realpathSync(value); } catch { return resolve(value); }
}

function isGitExecutable(command: string): boolean {
	return basename(command).replace(/\.exe$/i, "").toLowerCase() === "git";
}

function commandCwd(options: { cwd?: unknown } | undefined): string {
	return canonicalPath(typeof options?.cwd === "string" ? options.cwd : process.cwd());
}

function installSidebarGitBoundary(
	gateway: any,
	label: string,
	repoPath: string,
	cwdAliases: readonly string[],
	githubRemote = false,
): () => void {
	const canonicalRepo = canonicalPath(repoPath);
	const ownedCwds = new Set(cwdAliases.map(canonicalPath));
	ownedCwds.add(canonicalRepo);

	// API routes retain the SessionManager's injected CommandRunner object. Lease
	// that exact dependency instead of patching realCommandRunner or another facade.
	return installCommandRunnerInterceptor(gateway.sessionManager.commandRunner, {
		label: `${label}:${canonicalRepo}`,
		async execFile(command, args, options, next) {
			if (!isGitExecutable(command) || !ownedCwds.has(commandCwd(options))) return next();
			const invocation = args.join(" ");
			if (invocation === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "" };
			if (invocation === "rev-parse --show-toplevel") return { stdout: `${repoPath}\n`, stderr: "" };
			if (githubRemote && invocation === "remote get-url origin") {
				return { stdout: "git@github.com:acme/widget.git\n", stderr: "" };
			}
			return next();
		},
	});
}

async function withGithubRemote<T>(gateway: any, cwd: string, run: () => Promise<T>): Promise<T> {
	const restore = installSidebarGitBoundary(gateway, "sidebar-github-remote", cwd, [cwd], true);
	try {
		return await run();
	} finally {
		restore();
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
	sourceId: string,
	repoPath: string,
	run: (captures: ForkCapture[]) => Promise<T>,
): Promise<T> {
	const sessionManager = gateway.sessionManager;
	const source = sessionManager.getSession(sourceId);
	const persisted = sessionManager.getPersistedSession(sourceId);
	if (!source || !persisted) throw new Error(`source session ${sourceId} missing`);
	const sourceProjectId = persisted.projectId;
	const cwdAliases = [
		repoPath,
		harnessDefaultProjectRoot(),
		source.cwd,
		source.worktreePath,
		source.repoPath,
		persisted.cwd,
		persisted.worktreePath,
		persisted.repoPath,
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	const ownedCwds = new Set(cwdAliases.map(canonicalPath));
	const captures: ForkCapture[] = [];

	const restoreCommandRunner = installSidebarGitBoundary(gateway, "sidebar-fork", repoPath, cwdAliases);
	const restoreCreateSession = installMethodInterceptor(sessionManager, "createSession", `sidebar-fork-create:${sourceId}`, async (args, next) => {
		const [cwd, , , , rawOptions] = args;
		const options = rawOptions as any;
		if (
			typeof cwd !== "string"
			|| !ownedCwds.has(canonicalPath(cwd))
			|| options?.projectId !== sourceProjectId
			|| typeof options?.sessionId !== "string"
		) return next(...args);

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
	});
	const restoreSetTitle = installMethodInterceptor(sessionManager, "setTitle", `sidebar-fork-title:${sourceId}`, (args, next) => {
		const [sessionId] = args;
		return captures.some(capture => capture.id === sessionId) ? undefined : next(...args);
	});
	try {
		return await run(captures);
	} finally {
		restoreSetTitle();
		restoreCreateSession();
		restoreCommandRunner();
		for (const capture of captures) rmSync(capture.clonedTranscript, { force: true });
	}
}

function seedSyntheticSourceSession(
	gateway: any,
	projectId: string,
	repoPath: string,
	sourceWorktree: string,
): string {
	const sessionId = `sidebar-fork-${randomUUID()}`;
	const now = Date.now();
	mkdirSync(sourceWorktree, { recursive: true });
	const session = {
		id: sessionId,
		title: "Sidebar fork source",
		cwd: sourceWorktree,
		worktreePath: sourceWorktree,
		repoPath,
		branch: `session/${sessionId.slice(0, 8)}`,
		projectId,
		status: "idle",
		createdAt: now,
		lastActivity: now,
	};
	const sessionManager = gateway.sessionManager;
	const ctx = sessionManager.getProjectContextManager().getOrCreate(projectId);
	// The fork route only observes live/persisted source metadata. Seed that
	// boundary directly instead of booting an agent process that the seam never uses.
	sessionManager.sessions.set(sessionId, session);
	ctx.sessionStore.put({
		id: sessionId,
		title: session.title,
		cwd: sourceWorktree,
		worktreePath: sourceWorktree,
		repoPath,
		branch: session.branch,
		agentSessionFile: "",
		createdAt: now,
		lastActivity: now,
		projectId,
	});
	return sessionId;
}

function removeSyntheticSourceSession(gateway: any, projectId: string, sessionId: string): void {
	gateway.sessionManager.sessions.delete(sessionId);
	gateway.sessionManager.getProjectContextManager().getOrCreate(projectId).sessionStore.remove(sessionId);
}

test.describe.serial("sidebar actions server endpoints", () => {
	test("GET /api/goals/:id/github-link returns PR, branch fallback, and unavailable states", async ({ gateway }) => {
		const cwd = join(nonGitCwd(), `sidebar-github-${randomUUID()}`);
		// Keep the fake repo structurally truthful; the route-visible seam owns only
		// discovery output and never relies on a process-wide Git implementation.
		mkdirSync(join(cwd, ".git", "objects"), { recursive: true });
		writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/feature/sidebar-actions\n");
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
			const branchResp = await withGithubRemote(gateway, cwd, () => apiFetch(`/api/goals/${linkGoal.id}/github-link`));
			expect(branchResp.status).toBe(200);
			expect(await branchResp.json()).toMatchObject({
				available: true,
				kind: "branch",
				url: "https://github.com/acme/widget/tree/feature%2Fsidebar-actions",
			});
		} finally {
			await deleteGoal(linkGoal.id);
			await deleteGoal(noWorktreeGoal.id);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test.describe.serial("fork worktree choice", () => {
	let repoPath = "";
	let projectId = "";
	let sourceId = "";
	let sourceWorktree = "";

	test.beforeEach(async ({ gateway }) => {
		repoPath = harnessDefaultProjectRoot();
		projectId = gateway.defaultProjectId;
		sourceWorktree = join(repoPath, `.sidebar-fork-source-${randomUUID()}`);
		sourceId = seedSyntheticSourceSession(gateway, projectId, repoPath, sourceWorktree);
	});

	test.afterEach(async ({ gateway }) => {
		if (sourceId) removeSyntheticSourceSession(gateway, projectId, sourceId);
		if (sourceWorktree) rmSync(sourceWorktree, { recursive: true, force: true });
		sourceId = "";
		sourceWorktree = "";
	});

	test("newWorktree selects repo provisioning while reuse selects the source cwd", async ({ gateway }) => {
		seedSessionTranscript(gateway, sourceId, [transcriptMessage(`fork-${sourceId}`, "FORK_WT_MARKER")]);

		await withForkCreateSeam(gateway, sourceId, repoPath, async (captures) => {
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
	});

	test("newWorktree rebases cloned runtime cwd metadata off a stale source cwd", async ({ gateway }) => {
		const marker = `FORK_STALE_CWD_${Date.now()}`;
		const sourceJsonl = seedSessionTranscript(gateway, sourceId, [
			transcriptMessage(`${marker}-prompt`, `${marker} hello from stale source`),
		]);
		ensureStaleRuntimeCwdMetadata(sourceJsonl, sourceWorktree, sourceId);
		const { userLine, assistantLine } = appendOldCwdMessageContentSentinels(sourceJsonl, sourceWorktree, marker);

		await withForkCreateSeam(gateway, sourceId, repoPath, async (captures) => {
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
	});
});
