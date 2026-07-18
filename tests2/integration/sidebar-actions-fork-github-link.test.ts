// Ported from tests/e2e/sidebar-actions-server.spec.ts (v2-integration tier).
//
// Exercise the production route decision cores with suite-owned state. No
// gateway, global dispatcher, Git process, project registry or session store is
// shared with another file.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rebaseTranscriptCwdMetadataContent } from "../../src/server/agent/transcript-sanitizer.js";
import {
	launchSidebarSessionFork,
	resolveGoalGithubLink,
	type SidebarForkLaunchContext,
} from "../../src/server/sidebar-actions.js";

// Keep the Playwright-style declaration surface used by the migrated base file
// without importing the gateway-backed compatibility harness.
const test = Object.assign(it, { describe: Object.assign(describe, { serial: describe }) });

type RuntimeCwdRecord = { type: "system" | "session"; cwd: string };

type ForkCapture = {
	id: string;
	requestedCwd: string;
	resolvedCwd: string;
	options: Record<string, any>;
};

function transcriptMessage(id: string, text: string): unknown {
	return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } };
}

function writeTranscript(path: string, entries: unknown[]): void {
	writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

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

function createForkDependencies(repoPath: string, captures: ForkCapture[], titles: Array<{ id: string; title: string }>, rebase = false) {
	return {
		resolveNewWorktreeRepoPath: async () => repoPath,
		buildCreateOptions: (context: SidebarForkLaunchContext) => ({
			sessionId: context.forkId,
			projectId: context.projectId,
			worktreeOpts: context.worktreeOpts,
			preExistingAgentSessionFile: context.destJsonl,
			preExistingAgentSessionOldCwds: context.oldTranscriptCwds,
		}),
		createSession: async ({ cwd, options }: { cwd: string; options: Record<string, any> }) => {
			const id = options.sessionId as string;
			const resolvedCwd = options.worktreeOpts ? join(repoPath, `.fake-worktree-${id}`) : cwd;
			mkdirSync(resolvedCwd, { recursive: true });
			if (rebase) {
				const file = options.preExistingAgentSessionFile as string;
				const transformed = rebaseTranscriptCwdMetadataContent(readFileSync(file, "utf8"), {
					oldCwds: options.preExistingAgentSessionOldCwds,
					newCwd: resolvedCwd,
				});
				if (transformed.changed) writeFileSync(file, transformed.content);
			}
			captures.push({ id, requestedCwd: cwd, resolvedCwd, options });
			return { id, cwd: resolvedCwd, status: "idle" };
		},
		setTitle: (id: string, title: string) => { titles.push({ id, title }); },
	};
}

test.describe.serial("sidebar actions server endpoints", () => {
	test("GET /api/goals/:id/github-link returns PR, branch fallback, and unavailable states", async () => {
		type Goal = { id: string; cwd: string; repoPath?: string; worktreePath?: string; branch?: string };
		const goals = new Map<string, Goal>([
			["pr", { id: "pr", cwd: "C:/suite/pr", worktreePath: "C:/suite/pr", branch: "feature/pr" }],
			["branch", { id: "branch", cwd: "C:/suite/branch-wt", repoPath: "C:/suite/repo", worktreePath: "C:/suite/branch-wt", branch: "feature/sidebar-actions" }],
			["no-worktree", { id: "no-worktree", cwd: "C:/suite/plain" }],
			["no-github", { id: "no-github", cwd: "C:/suite/no-github", worktreePath: "C:/suite/no-github", branch: "feature/local" }],
		]);
		const cachedPrs = new Map([["pr", { url: "https://github.com/acme/widget/pull/123" }]]);
		const remoteCwds: string[] = [];
		const deps = {
			getGoal: (id: string) => goals.get(id),
			hasGitWorktree: (goal: Goal) => !!goal.branch && !!goal.worktreePath,
			noWorktreeMessage: () => "This goal runs without a git worktree.",
			getCachedPr: (id: string) => cachedPrs.get(id),
			getFreshPr: async () => null,
			setCachedPr: (id: string, pr: { url?: string }) => { cachedPrs.set(id, { url: pr.url! }); },
			pathExists: () => true,
			getOriginRemote: async (cwd: string) => {
				remoteCwds.push(cwd);
				if (cwd === "C:/suite/repo") return "git@github.com:acme/widget.git";
				throw new Error("origin is not a GitHub remote");
			},
		};

		expect(await resolveGoalGithubLink("pr", deps)).toEqual({
			available: true,
			kind: "pr",
			url: "https://github.com/acme/widget/pull/123",
		});
		expect(await resolveGoalGithubLink("branch", deps)).toEqual({
			available: true,
			kind: "branch",
			url: "https://github.com/acme/widget/tree/feature%2Fsidebar-actions",
		});
		expect(remoteCwds).toContain("C:/suite/repo");
		expect(await resolveGoalGithubLink("no-worktree", deps)).toMatchObject({ available: false, reason: "no-worktree" });
		expect(await resolveGoalGithubLink("missing", deps)).toEqual({ available: false, reason: "goal-not-found" });
		expect(await resolveGoalGithubLink("no-github", deps)).toEqual({ available: false, reason: "no-github-remote" });
	});
});

test.describe.serial("fork worktree choice", () => {
	test("newWorktree selects repo provisioning while reuse selects the source cwd", async () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-sidebar-fork-"));
		const repoPath = join(root, "repo");
		const sourceWorktree = join(root, "source-worktree");
		const projectId = "sidebar-project";
		const captures: ForkCapture[] = [];
		const titles: Array<{ id: string; title: string }> = [];
		mkdirSync(sourceWorktree, { recursive: true });
		try {
			for (const [forkId, newWorktree] of [["fresh-fork", true], ["reuse-fork", false]] as const) {
				const destJsonl = join(root, `${forkId}.jsonl`);
				writeTranscript(destJsonl, [transcriptMessage(forkId, "FORK_WT_MARKER")]);
				const launched = await launchSidebarSessionFork({
					forkId,
					projectId,
					projectRoot: repoPath,
					destJsonl,
					newWorktree,
					source: { cwd: sourceWorktree, title: "Sidebar fork source" },
					persisted: { cwd: sourceWorktree, worktreePath: sourceWorktree, title: "Sidebar fork source" },
				}, createForkDependencies(repoPath, captures, titles));
				expect(launched.title).toBe("Fork: Sidebar fork source");
				expect(launched.projectId).toBe(projectId);
			}

			expect(captures).toHaveLength(2);
			expect(captures[0].requestedCwd).toBe(repoPath);
			expect(captures[0].resolvedCwd).not.toBe(sourceWorktree);
			expect(captures[0].options.worktreeOpts).toEqual({ repoPath });
			expect(captures[1].requestedCwd).toBe(sourceWorktree);
			expect(captures[1].resolvedCwd).toBe(sourceWorktree);
			expect(captures[1].options.worktreeOpts).toBeUndefined();
			expect(titles).toEqual([
				{ id: "fresh-fork", title: "Fork: Sidebar fork source" },
				{ id: "reuse-fork", title: "Fork: Sidebar fork source" },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("newWorktree rebases cloned runtime cwd metadata off a stale source cwd", async () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-sidebar-stale-"));
		const repoPath = join(root, "repo");
		const sourceWorktree = join(root, "stale-source");
		const sourceId = "stale-source-session";
		const forkId = "stale-fork";
		const marker = "FORK_STALE_CWD";
		const sourceJsonl = join(root, "source.jsonl");
		const destJsonl = join(root, "fork.jsonl");
		const captures: ForkCapture[] = [];
		const titles: Array<{ id: string; title: string }> = [];
		mkdirSync(sourceWorktree, { recursive: true });
		writeTranscript(sourceJsonl, [transcriptMessage(`${marker}-prompt`, `${marker} hello from stale source`)]);
		ensureStaleRuntimeCwdMetadata(sourceJsonl, sourceWorktree, sourceId);
		const { userLine, assistantLine } = appendOldCwdMessageContentSentinels(sourceJsonl, sourceWorktree, marker);
		copyFileSync(sourceJsonl, destJsonl);
		try {
			await launchSidebarSessionFork({
				forkId,
				projectId: "sidebar-project",
				projectRoot: repoPath,
				destJsonl,
				newWorktree: true,
				source: { cwd: sourceWorktree, title: "Sidebar fork source" },
				persisted: { cwd: sourceWorktree, worktreePath: sourceWorktree, title: "Sidebar fork source" },
			}, createForkDependencies(repoPath, captures, titles, true));

			expect(captures).toHaveLength(1);
			const capture = captures[0];
			expect(capture.options.preExistingAgentSessionOldCwds).toContain(sourceWorktree);
			expect(existsSync(destJsonl)).toBe(true);
			const clonedText = readFileSync(destJsonl, "utf8");
			expect(clonedText).toContain(marker);
			expect(clonedText).toContain(userLine);
			expect(clonedText).toContain(assistantLine);
			const runtimeRecords = readRuntimeCwdRecords(destJsonl);
			expect(runtimeRecords).not.toContainEqual({ type: "system", cwd: sourceWorktree });
			expect(runtimeRecords).not.toContainEqual({ type: "session", cwd: sourceWorktree });
			expect(runtimeRecords).toContainEqual({ type: "system", cwd: capture.resolvedCwd });
			expect(runtimeRecords).toContainEqual({ type: "session", cwd: capture.resolvedCwd });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
