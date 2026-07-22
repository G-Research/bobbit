import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { copyGitTemplate } from "../harness/git-template.js";
import { loadServerTestRuntime } from "../harness/server-runtime.js";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, registerProject } from "./_e2e/e2e-setup.js";
import {
	GENERAL_PROMPT_MARKER,
	GENERAL_ROLE,
	MODEL,
	THINKING,
	createSession,
	expectInitialRoleConfiguration,
	expectProjectRoles,
	expectRoleEverywhere,
	generalOverride,
	purgeSession,
	putProjectRole,
	readJson,
	removeProjectRole,
	sessionIdsBySurface,
	type CreatedSession,
} from "./default-standard-session-role-helper.js";

let worktreeProject: { id: string; rootPath: string };
let worktreeFixtureRoot = "";
let restoreCommandRunner: (() => void) | undefined;
const gitCalls: Array<{ cwd: string; args: string[] }> = [];

function directorySnapshot(directoryPath: string): { exists: boolean; entries: string[] } {
	const exists = existsSync(directoryPath);
	return { exists, entries: exists ? readdirSync(directoryPath).sort() : [] };
}

function mkdirWorktree(worktreePath: string): void {
	const gitMarker = join(worktreePath, ".git");
	if (!existsSync(worktreePath)) {
		mkdirSync(worktreePath, { recursive: true });
		writeFileSync(gitMarker, "gitdir: canned\n");
	}
}

function cannedGit(cwd: string, args: readonly string[]): string {
	gitCalls.push({ cwd, args: [...args] });
	const key = args.join(" ");
	if (key === "rev-parse --show-toplevel") return cwd;
	if (key === "rev-parse --is-inside-work-tree") return "true";
	if (key === "rev-parse --verify HEAD" || key === "rev-parse --verify refs/heads/master" || key === "rev-parse --verify origin/master") {
		return "a".repeat(40);
	}
	if (key === "symbolic-ref refs/remotes/origin/HEAD") return "refs/remotes/origin/master";
	if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error(`missing ref: ${args[2]}`);
	if (args[0] === "worktree" && args[1] === "add") {
		const worktreePath = args[2] === "-b" ? args[4] : args[2];
		mkdirWorktree(worktreePath);
		return "";
	}
	if (args[0] === "worktree" && args[1] === "remove") {
		rmSync(args[2], { recursive: true, force: true });
		return "";
	}
	if (["branch", "fetch", "push"].includes(args[0])) return "";
	if (args[0] === "remote" && args[1] === "get-url") throw new Error("no remote");
	throw new Error(`unexpected canned git command (${cwd}): ${key}`);
}

async function installCannedGitRunner(): Promise<void> {
	const runtime = await loadServerTestRuntime();
	const runner = runtime.gatewayDeps.realCommandRunner;
	const original = { execFile: runner.execFile, execFileSync: runner.execFileSync, spawn: runner.spawn };
	runner.execFile = async (file, args, options) => {
		if (basename(file).toLowerCase().replace(/\.exe$/, "") !== "git") throw new Error(`unexpected command: ${file}`);
		return { stdout: cannedGit(String(options?.cwd ?? ""), args), stderr: "" };
	};
	runner.execFileSync = (file, args, options) => {
		if (basename(file).toLowerCase().replace(/\.exe$/, "") !== "git") throw new Error(`unexpected command: ${file}`);
		return cannedGit(String(options?.cwd ?? ""), args);
	};
	runner.spawn = undefined;
	restoreCommandRunner = () => Object.assign(runner, original);
}

async function waitForGenuineWorktree(gateway: any, sessionId: string, sourceRepo: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	let observed: Record<string, unknown> = {};
	while (Date.now() < deadline) {
		const live = gateway.sessionManager.getSession(sessionId);
		observed = {
			status: live?.status ?? null,
			worktreePath: live?.worktreePath ?? null,
			worktreeGitExists: live?.worktreePath ? existsSync(join(live.worktreePath, ".git")) : false,
		};
		if (observed.worktreePath && observed.worktreePath !== sourceRepo && observed.worktreeGitExists) return;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	expect(
		observed.worktreeGitExists === true,
		`worktree:true against a committed fixture repository must create a distinct Git worktree; observed=${JSON.stringify(observed)}`,
	).toBe(true);
}

async function waitForInitialRoleConfiguration(gateway: any, sessionId: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	let observed: Record<string, unknown> = {};
	while (Date.now() < deadline) {
		const live = gateway.sessionManager.getSession(sessionId);
		const rolePrompt = String(gateway.sessionManager.getPromptParts(sessionId)?.rolePrompt ?? "");
		observed = {
			status: live?.status ?? null,
			spawnPinnedModel: live?.spawnPinnedModel ?? null,
			spawnPinnedThinkingLevel: live?.spawnPinnedThinkingLevel ?? null,
			rolePromptReady: rolePrompt.includes(GENERAL_PROMPT_MARKER),
		};
		if (live?.status === "idle" && live.spawnPinnedModel === MODEL && live.spawnPinnedThinkingLevel === THINKING && observed.rolePromptReady) return;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	expect(false, `resolved role configuration did not reach worktree initial spawn; observed=${JSON.stringify(observed)}`).toBe(true);
}

test.beforeAll(async ({ gateway }) => {
	await installCannedGitRunner();
	worktreeFixtureRoot = mkdtempSync(join(tmpdir(), "bobbit-default-role-worktree-"));
	const repoRoot = copyGitTemplate(join(worktreeFixtureRoot, "repo"));
	worktreeProject = await registerProject({
		name: `default-role-worktree-${process.pid}`,
		rootPath: repoRoot,
		components: [{ name: "repo", repo: "." }],
		seedWorkflows: false,
	});
	const worktreeContext = gateway.projectContextManager.getOrCreate(worktreeProject.id);
	expect(worktreeContext, "registered worktree fixture must have a project context").toBeTruthy();
	worktreeContext.projectConfigStore.set("base_ref", "master");
	await putProjectRole(worktreeProject.id, generalOverride);
	await expectProjectRoles(worktreeProject.id, [GENERAL_ROLE]);
});

test.afterAll(async () => {
	if (worktreeProject) await removeProjectRole(worktreeProject.id, GENERAL_ROLE);
	if (worktreeProject) {
		await apiFetch(`/api/projects/${encodeURIComponent(worktreeProject.id)}`, { method: "DELETE" }).catch(() => undefined);
	}
	if (worktreeFixtureRoot) rmSync(worktreeFixtureRoot, { recursive: true, force: true });
	restoreCommandRunner?.();
});

test("unknown explicit role is rejected before worktree resolution or provisioning", async ({ gateway }) => {
	const sourceRepo = worktreeProject.rootPath;
	const worktreeRoot = join(dirname(sourceRepo), `${basename(sourceRepo)}-wt`);
	const unknownRole = "missing-worktree-role";
	const beforeSessions = await sessionIdsBySurface(gateway, worktreeProject.id);
	const beforeDirectory = directorySnapshot(worktreeRoot);
	const beforeGitCallCount = gitCalls.length;
	const beforeWorktreeAddCount = gitCalls.filter(call => call.args[0] === "worktree" && call.args[1] === "add").length;
	let unexpectedSessionId: string | undefined;

	try {
		expect(existsSync(join(sourceRepo, ".git")), "fixture project must be a worktree-capable Git repository").toBe(true);
		const response = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: sourceRepo, projectId: worktreeProject.id, worktree: true, roleId: unknownRole }),
		});
		const payload = await readJson(response);
		unexpectedSessionId = typeof payload.id === "string" ? payload.id : undefined;

		expect(response.status, `unknown explicit role must be rejected; body=${JSON.stringify(payload)}`).toBe(404);
		expect(payload).toEqual({ error: `Role "${unknownRole}" not found` });
		expect(gitCalls, "role rejection must precede worktree capability resolution").toHaveLength(beforeGitCallCount);
		expect(
			gitCalls.filter(call => call.args[0] === "worktree" && call.args[1] === "add"),
			"role rejection must not invoke git worktree add",
		).toHaveLength(beforeWorktreeAddCount);
		expect(directorySnapshot(worktreeRoot), "role rejection must not provision a worktree directory").toEqual(beforeDirectory);
		expect(
			await sessionIdsBySurface(gateway, worktreeProject.id),
			"role rejection must not create a live, persisted, or API-visible session",
		).toEqual(beforeSessions);
	} finally {
		await purgeSession(unexpectedSessionId);
	}
});

test("genuine worktree creation with omitted role gets the full resolved general configuration", async ({ gateway }) => {
	let created: CreatedSession | undefined;
	const sourceRepo = worktreeProject.rootPath;
	try {
		created = await createSession({ cwd: sourceRepo, projectId: worktreeProject.id, worktree: true });
		await waitForGenuineWorktree(gateway, created.id, sourceRepo);
		await expectRoleEverywhere(
			gateway,
			created,
			worktreeProject.id,
			GENERAL_ROLE,
			"worktree POST without roleId must resolve to role=general in POST, live state, persistence, detail, and list",
		);
		expect(created.accessory).toBe(generalOverride.accessory);
		await waitForInitialRoleConfiguration(gateway, created.id);
		expectInitialRoleConfiguration(gateway, created.id, {
			role: GENERAL_ROLE,
			promptMarker: GENERAL_PROMPT_MARKER,
			accessory: generalOverride.accessory,
		});
	} finally {
		await purgeSession(created?.id);
	}
});
