import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

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
const EVENT_WAIT_TIMEOUT_MS = 5_000;

type CannedWorktreeAddSignal = {
	repoPath: string;
	promise: Promise<string>;
	resolve: (worktreePath: string) => void;
	cancel: () => void;
};

let pendingWorktreeAddSignal: CannedWorktreeAddSignal | undefined;

function nextCannedWorktreeAdd(repoPath: string): CannedWorktreeAddSignal {
	if (pendingWorktreeAddSignal) throw new Error("a canned worktree-add signal is already armed");
	let resolvePromise!: (worktreePath: string) => void;
	const signal: CannedWorktreeAddSignal = {
		repoPath,
		promise: new Promise(resolve => { resolvePromise = resolve; }),
		resolve(worktreePath) {
			if (pendingWorktreeAddSignal === signal) pendingWorktreeAddSignal = undefined;
			resolvePromise(worktreePath);
		},
		cancel() {
			if (pendingWorktreeAddSignal === signal) pendingWorktreeAddSignal = undefined;
		},
	};
	pendingWorktreeAddSignal = signal;
	return signal;
}

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
		if (args[3]?.startsWith("session/") && pendingWorktreeAddSignal?.repoPath === cwd) {
			const signal = pendingWorktreeAddSignal;
			pendingWorktreeAddSignal = undefined;
			signal.resolve(worktreePath);
		}
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

async function waitForCannedWorktree(
	gateway: any,
	sessionId: string,
	sourceRepo: string,
	worktreeAdded: CannedWorktreeAddSignal,
): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		const addedPath = await Promise.race([
			worktreeAdded.promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					const live = gateway.sessionManager.getSession(sessionId);
					const observed = {
						status: live?.status ?? null,
						worktreePath: live?.worktreePath ?? null,
						worktreeGitExists: live?.worktreePath ? existsSync(join(live.worktreePath, ".git")) : false,
					};
					reject(new Error(`timed out waiting for canned worktree add after ${EVENT_WAIT_TIMEOUT_MS}ms; observed=${JSON.stringify(observed)}`));
				}, EVENT_WAIT_TIMEOUT_MS);
				timer.unref();
			}),
		]);
		const live = gateway.sessionManager.getSession(sessionId);
		const observed = {
			status: live?.status ?? null,
			worktreePath: live?.worktreePath ?? null,
			worktreeGitExists: live?.worktreePath ? existsSync(join(live.worktreePath, ".git")) : false,
		};
		expect(
			observed.worktreePath === addedPath && observed.worktreePath !== sourceRepo && observed.worktreeGitExists === true,
			`worktree:true with the canned Git runner must create a distinct marked worktree; observed=${JSON.stringify(observed)}`,
		).toBe(true);
	} finally {
		if (timer) clearTimeout(timer);
		worktreeAdded.cancel();
	}
}

function waitForIdleStatusSignal(gateway: any, sessionId: string): Promise<void> {
	const live = gateway.sessionManager.getSession(sessionId);
	if (!live) return Promise.reject(new Error(`live session ${sessionId} not found`));
	if (live.status === "idle") return Promise.resolve();

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const client = {
			readyState: 1,
			send(payload: string) {
				const message = JSON.parse(payload);
				if (message.type !== "session_status") return;
				if (message.status === "idle") settle(resolve);
				if (message.status === "terminated") settle(() => reject(new Error(`session ${sessionId} terminated before initial role setup completed`)));
			},
		};
		const settle = (complete: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			live.clients.delete(client);
			complete();
		};
		live.clients.add(client);
		timer = setTimeout(() => {
			const observed = {
				status: live.status,
				clientAttached: live.clients.has(client),
			};
			settle(() => reject(new Error(`timed out waiting for session ${sessionId} idle status after ${EVENT_WAIT_TIMEOUT_MS}ms; observed=${JSON.stringify(observed)}`)));
		}, EVENT_WAIT_TIMEOUT_MS);
		timer.unref();
		// Registration and this re-check are synchronous, so an idle transition
		// cannot occur between them without either being observed or read here.
		if (live.status === "idle") settle(resolve);
		if (live.status === "terminated") settle(() => reject(new Error(`session ${sessionId} terminated before initial role setup completed`)));
	});
}

async function waitForInitialRoleConfiguration(gateway: any, sessionId: string): Promise<void> {
	await waitForIdleStatusSignal(gateway, sessionId);
	const live = gateway.sessionManager.getSession(sessionId);
	const rolePrompt = String(gateway.sessionManager.getPromptParts(sessionId)?.rolePrompt ?? "");
	const observed = {
		status: live?.status ?? null,
		spawnPinnedModel: live?.spawnPinnedModel ?? null,
		spawnPinnedThinkingLevel: live?.spawnPinnedThinkingLevel ?? null,
		rolePromptReady: rolePrompt.includes(GENERAL_PROMPT_MARKER),
	};
	expect(
		live?.status === "idle"
			&& live.spawnPinnedModel === MODEL
			&& live.spawnPinnedThinkingLevel === THINKING
			&& observed.rolePromptReady,
		`resolved role configuration did not reach worktree initial spawn; observed=${JSON.stringify(observed)}`,
	).toBe(true);
}

test.beforeAll(async ({ gateway }) => {
	await installCannedGitRunner();
	worktreeFixtureRoot = mkdtempSync(join(tmpdir(), "bobbit-default-role-worktree-"));
	const repoRoot = join(worktreeFixtureRoot, "repo");
	mkdirSync(repoRoot, { recursive: true });
	writeFileSync(join(repoRoot, ".git"), "gitdir: canned\n");
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
		expect(existsSync(join(sourceRepo, ".git")), "fixture project must expose the minimal Git marker used by cannedGit").toBe(true);
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

test("canned worktree creation with omitted role gets the full resolved general configuration", async ({ gateway }) => {
	let created: CreatedSession | undefined;
	const sourceRepo = worktreeProject.rootPath;
	const worktreeAdded = nextCannedWorktreeAdd(sourceRepo);
	try {
		created = await createSession({ cwd: sourceRepo, projectId: worktreeProject.id, worktree: true });
		await waitForCannedWorktree(gateway, created.id, sourceRepo, worktreeAdded);
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
		worktreeAdded.cancel();
		await purgeSession(created?.id);
	}
});
