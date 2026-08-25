import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { loadServerTestRuntime } from "../../support/harnesses/shared/server-runtime.js";
import { test, expect } from "./_helpers/e2e/in-process-harness.js";
import { apiFetch, registerProject } from "./_helpers/e2e/e2e-setup.js";
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
} from "./_helpers/default-standard-session-role-helper.js";

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

type CannedWorktree = {
	repoPath: string;
	branch: string;
};

// The fixture uses a minimal .git marker rather than a real repository, so
// model just the state that setup creates and then validates.
const cannedWorktrees = new Map<string, CannedWorktree>();
const cannedBranches = new Map<string, Map<string, string | undefined>>();

function canonicalCannedPath(path: string): string {
	return resolve(path);
}

function branchesFor(repoPath: string): Map<string, string | undefined> {
	const canonicalRepoPath = canonicalCannedPath(repoPath);
	let branches = cannedBranches.get(canonicalRepoPath);
	if (!branches) {
		branches = new Map([["master", undefined]]);
		cannedBranches.set(canonicalRepoPath, branches);
	}
	return branches;
}

function cannedRepository(cwd: string): { repoPath: string; branch: string } {
	const path = canonicalCannedPath(cwd);
	const worktree = cannedWorktrees.get(path);
	if (worktree) return worktree;
	if (existsSync(join(path, ".git"))) return { repoPath: path, branch: "master" };
	throw new Error(`not a canned git repository: ${cwd}`);
}

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
	const repository = cannedRepository(cwd);
	const branches = branchesFor(repository.repoPath);

	if (key === "rev-parse --show-toplevel") return canonicalCannedPath(cwd);
	if (key === "rev-parse --is-inside-work-tree") return "true";
	if (key === "rev-parse --path-format=absolute --git-common-dir" || key === "rev-parse --git-common-dir") {
		return join(repository.repoPath, ".git");
	}
	if (key === "rev-parse --abbrev-ref HEAD") return repository.branch;
	if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "--symbolic-full-name") {
		const requestedBranch = args[3]?.replace(/@\{upstream\}$/, "");
		const upstream = requestedBranch && branches.get(requestedBranch);
		if (upstream) return upstream;
		throw new Error(`branch has no upstream: ${args[3]}`);
	}
	if (args[0] === "rev-parse" && args[1] === "--verify") {
		const ref = args[2];
		const branch = ref?.replace(/^refs\/heads\//, "");
		if (ref === "HEAD" || ref === "origin/master" || (branch && branches.has(branch))) return "a".repeat(40);
		throw new Error(`missing ref: ${ref}`);
	}
	if (key === "symbolic-ref refs/remotes/origin/HEAD") return "refs/remotes/origin/master";
	if (args[0] === "worktree" && args[1] === "add") {
		const noTrackIndex = args.indexOf("--no-track");
		if (noTrackIndex === -1) throw new Error(`canned worktree creation must use --no-track: ${key}`);
		const createBranchIndex = args.indexOf("-b");
		const positional = args.slice(2).filter(arg => arg !== "--no-track");
		const branchName = createBranchIndex === -1 ? positional[1] : args[createBranchIndex + 1];
		const worktreePath = createBranchIndex === -1 ? positional[0] : args[createBranchIndex + 2];
		if (!branchName || !worktreePath) throw new Error(`invalid canned worktree add: ${key}`);
		const canonicalWorktreePath = canonicalCannedPath(worktreePath);
		mkdirWorktree(canonicalWorktreePath);
		cannedWorktrees.set(canonicalWorktreePath, { repoPath: repository.repoPath, branch: branchName });
		branches.set(branchName, branches.get(branchName));
		if (branchName.startsWith("session/") && pendingWorktreeAddSignal?.repoPath === cwd) {
			const signal = pendingWorktreeAddSignal;
			pendingWorktreeAddSignal = undefined;
			signal.resolve(canonicalWorktreePath);
		}
		return "";
	}
	if (args[0] === "worktree" && args[1] === "remove") {
		const worktreePath = canonicalCannedPath(args[2]);
		rmSync(worktreePath, { recursive: true, force: true });
		cannedWorktrees.delete(worktreePath);
		return "";
	}
	if (args[0] === "branch" && args[1]?.startsWith("--set-upstream-to=")) {
		const branchName = args[2];
		const upstream = args[1].slice("--set-upstream-to=".length);
		if (!branchName || !branches.has(branchName)) throw new Error(`unknown branch: ${branchName}`);
		branches.set(branchName, upstream);
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
