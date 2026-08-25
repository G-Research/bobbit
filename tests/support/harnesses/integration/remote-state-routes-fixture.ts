import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { basename, dirname, join } from "node:path";
import { awaitableRm } from "../../../e2e/_helpers/test-utils/cleanup.js";
import { test, expect } from "../../../integration/gateway/_helpers/e2e/in-process-harness.js";
import { apiFetch, connectWs, createGoal, defaultProjectId, deleteGoal, deleteSession, gitCwd, nonGitCwd, registerProject } from "../../../integration/gateway/_helpers/e2e/e2e-setup.js";
import { loadServerTestRuntime } from "../shared/server-runtime.js";
import { createCommandSpawnAdapter } from "../../../../src/server/owned-tree-command-spawn.js";

export let serverModule: any;
let forceRequestedAt = 1_000;
type PersistenceMode = "sqlite" | "json" | undefined;
interface MutableProjectPersistenceOptions {
	goalPersistence?: PersistenceMode;
	taskPersistence?: PersistenceMode;
	gatePersistence?: PersistenceMode;
}
let projectPersistenceOptions: MutableProjectPersistenceOptions | undefined;
let previousPersistence: MutableProjectPersistenceOptions | undefined;

function deterministicGitStatus(opts?: { untracked?: boolean }) {
	return {
		branch: "main",
		primaryBranch: "main",
		primaryRef: "refs/heads/main",
		isOnPrimary: true,
		status: [],
		hasUpstream: true,
		ahead: 0,
		behind: 0,
		aheadOfPrimary: 0,
		behindPrimary: 0,
		mergedIntoPrimary: true,
		insertionsVsPrimary: 0,
		deletionsVsPrimary: 0,
		clean: true,
		summary: "clean",
		unpushed: false,
		partial: false,
		untrackedIncluded: opts?.untracked === true,
	};
}

function crossForceCoalescingWindow(): void {
	forceRequestedAt += 251;
}

function unexpectedRunnerCommand(file: string, args: readonly string[], options?: any): never {
	throw new Error(`unexpected route command: ${commandName(file)} ${args.join(" ")} (cwd=${String(options?.cwd ?? "")})`);
}

function standardSingleRepositoryProbe(
	file: string,
	args: readonly string[],
	repositoryRoot: string,
): { stdout: string; stderr: string } | undefined {
	if (commandName(file) !== "git") return undefined;
	const command = args.join(" ");
	if (command === "rev-parse --show-toplevel") return { stdout: `${repositoryRoot}\n`, stderr: "" };
	if (command === "rev-parse --path-format=absolute --git-common-dir" || command === "rev-parse --git-common-dir") {
		return { stdout: `${join(repositoryRoot, ".git")}\n`, stderr: "" };
	}
	if (command === "rev-parse --git-dir") return { stdout: ".git\n", stderr: "" };
	if (command === "symbolic-ref --quiet --short HEAD") return { stdout: "fixture/route-head\n", stderr: "" };
	if (args[0] === "check-ref-format" && args[1] === "--branch" && typeof args[2] === "string") {
		if (/^[\-]|[\u0000-\u001f\u007f]|:\/\//.test(args[2])) throw new Error("invalid fixture branch");
		return { stdout: `${args[2]}\n`, stderr: "" };
	}
	return undefined;
}

function commandName(file: string): string {
	return basename(file).toLowerCase().replace(/\.(?:cmd|exe)$/, "");
}

function credentialHelperResult(output: string): any {
	const child: any = new EventEmitter();
	child.stdout = new PassThrough();
	child.stdin = new PassThrough();
	child.kill = () => { throw new Error("credential route fixture must use owned-tree control"); };
	setImmediate(() => {
		child.stdout.end(output);
		child.emit("close", 0, null);
	});
	return {
		child,
		ownershipReady: Promise.resolve(),
		killTree: () => {},
		waitForTreeExit: async () => true,
		killed: () => false,
		timedOut: () => false,
	};
}

function ownedHeadEvidence(owner: string, repository: string): Record<string, unknown> {
	return {
		headRepository: { name: repository },
		headRepositoryOwner: { login: owner },
		isCrossRepository: false,
	};
}

function ownedHeadEvidenceForSlug(slug: string): Record<string, unknown> {
	const [owner, repository, extra] = slug.split("/");
	if (!owner || !repository || extra) throw new Error(`invalid test repository slug: ${slug}`);
	return ownedHeadEvidence(owner, repository);
}

async function createRemoteStateSession(gateway: any, cwd: string, requestedProjectId?: string): Promise<string> {
	const projectId = requestedProjectId ?? await defaultProjectId();
	const response = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd, projectId, worktree: false }),
	});
	const body = await response.json().catch(() => ({})) as Record<string, unknown>;
	expect(response.status, `remote-state fixture session creation failed: ${JSON.stringify(body)}`).toBe(201);
	expect(body.id).toEqual(expect.any(String));
	const sessionId = String(body.id);
	// Route fixtures must stay on the exact supplied repository/worktree. The
	// ordinary helper permits asynchronous session worktree provisioning, which
	// can finish (or fail and remove the live session) halfway through a slow
	// Windows run and turn later route reads into unrelated 404s.
	expect(gateway.sessionManager.getSession(sessionId)).toMatchObject({
		id: sessionId,
		cwd,
		status: "idle",
	});
	expect(gateway.sessionManager.getSession(sessionId)?.worktreePath).toBeUndefined();
	return sessionId;
}

async function removeSiblingWorktree(runner: any, primary: string, sibling: string): Promise<void> {
	// Windows can briefly retain handles after the session and websocket close.
	// Remove the filesystem tree with the shared bounded retry policy, then prune
	// Git's administrative entry and prove that both halves of teardown settled.
	const cleanup = await awaitableRm(sibling, { maxAttempts: 5, backoffMs: 50 });
	expect(cleanup.removed, `sibling worktree cleanup failed after ${cleanup.attempts} attempts: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
	await runner.execFile("git", ["worktree", "prune", "--expire", "now"], { cwd: primary, encoding: "utf-8", timeout: 10_000 });
	const listed = await runner.execFile("git", ["worktree", "list", "--porcelain"], { cwd: primary, encoding: "utf-8", timeout: 10_000 });
	const listedPaths = String(listed.stdout)
		.split(/\r?\n/)
		.filter((line: string) => line.startsWith("worktree "))
		.map((line: string) => line.slice("worktree ".length).replaceAll("\\", "/").toLowerCase());
	expect(listedPaths).not.toContain(sibling.replaceAll("\\", "/").toLowerCase());
}

/** Register the shared remote-state route lifecycle without duplicating mutable runner overrides. */
export function installRemoteStateRouteHooks(): void {
	test.beforeAll(async ({ gateway }) => {
		// This route suite creates four temporary real-filesystem projects but does
		// not test store persistence. Keep those lazy contexts on the existing JSON
		// fixture seam; native SQLite ownership is covered by the focused store/E2E
		// suites and otherwise adds synchronous handles to the tier-1 route budget.
		projectPersistenceOptions = (gateway.projectContextManager as { options: MutableProjectPersistenceOptions }).options;
		previousPersistence = {
			goalPersistence: projectPersistenceOptions.goalPersistence,
			taskPersistence: projectPersistenceOptions.taskPersistence,
			gatePersistence: projectPersistenceOptions.gatePersistence,
		};
		projectPersistenceOptions.goalPersistence = "json";
		projectPersistenceOptions.taskPersistence = "json";
		projectPersistenceOptions.gatePersistence = "json";

		serverModule = (await loadServerTestRuntime()).server;
		expect(typeof serverModule.__setGitStatusFake).toBe("function");
		expect(typeof serverModule.__clearGitStatusFake).toBe("function");
		expect(typeof serverModule.__setRemoteStateForceNowFake).toBe("function");
		expect(typeof serverModule.__clearRemoteStateForceNowFake).toBe("function");
	});

	test.afterAll(() => {
		if (!projectPersistenceOptions || !previousPersistence) return;
		projectPersistenceOptions.goalPersistence = previousPersistence.goalPersistence;
		projectPersistenceOptions.taskPersistence = previousPersistence.taskPersistence;
		projectPersistenceOptions.gatePersistence = previousPersistence.gatePersistence;
	});

	test.beforeEach(() => {
		forceRequestedAt = performance.now() + 251;
		serverModule.__setRemoteStateForceNowFake(() => forceRequestedAt);
		serverModule.__setGitStatusFake(async (_cwd: string, _containerId?: string, opts?: { untracked?: boolean }) => deterministicGitStatus(opts));
	});

	test.afterEach(() => {
		serverModule.__clearGitStatusFake();
		serverModule.__clearRemoteStateForceNowFake();
	});
}

export {
	mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync,
	EventEmitter, tmpdir, PassThrough, dirname, join, awaitableRm, test, expect,
	apiFetch, connectWs, createGoal, defaultProjectId, deleteGoal, deleteSession, gitCwd, nonGitCwd, registerProject,
	createCommandSpawnAdapter, crossForceCoalescingWindow, unexpectedRunnerCommand,
	standardSingleRepositoryProbe, commandName, credentialHelperResult, ownedHeadEvidence,
	ownedHeadEvidenceForSlug, createRemoteStateSession, removeSiblingWorktree,
};
