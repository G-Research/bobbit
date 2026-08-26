import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { basename, dirname, join } from "node:path";
import { awaitableRm } from "../../../e2e/_helpers/test-utils/cleanup.js";
import { test, expect } from "../../../integration/gateway/_helpers/e2e/in-process-harness.js";
import { apiFetch as rawApiFetch, connectWs, createGoal as rawCreateGoal, defaultProjectId, deleteGoal, deleteSession, gitCwd, nonGitCwd, registerProject } from "../../../integration/gateway/_helpers/e2e/e2e-setup.js";
import { gatewaySync } from "../../../integration/gateway/_helpers/e2e/runtime.js";
import { loadServerTestRuntime } from "../shared/server-runtime.js";
import { createCommandSpawnAdapter } from "../../../../src/server/owned-tree-command-spawn.js";

export let serverModule: any;
let forceRequestedAt = 1_000;
let forceRequestBurstOpen = false;

function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	const url = new URL(path, "http://remote-state.fixture");
	const intent = url.searchParams.get("intent");
	const forcedRemoteRead = /\/(?:git|pr)-status$/.test(url.pathname) && (intent === "explicit" || intent === "force");
	if (forcedRemoteRead && !forceRequestBurstOpen) {
		// Synchronously-started force requests model one user burst and coalesce.
		// Closing at the microtask boundary makes an awaited force a new burst,
		// independent of how quickly the production 250 ms window elapses.
		forceRequestedAt += 251;
		forceRequestBurstOpen = true;
		queueMicrotask(() => { forceRequestBurstOpen = false; });
	}
	return rawApiFetch(path, opts);
}

/** Deterministic fixture seam for a read arriving in the already-open force epoch. */
function apiFetchAtCurrentForceEpoch(path: string, opts: RequestInit = {}): Promise<Response> {
	return rawApiFetch(path, opts);
}
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

type RemoteStateRouteOwner = { owner: "goals" | "sessions"; id: string };

async function completeRemoteStateRouteHandoff(owner: "goals" | "sessions", id: string): Promise<void> {
	// An explicit route read is the coordinator's public blocking join boundary:
	// it waits for existing refresh work (or its own) before replying. Complete
	// both resource lifecycles before a test replaces the shared command runner.
	// `optional=1` keeps a definitive missing PR successful; failed probes remain
	// observable responses whose bodies must still be consumed.
	const [gitHandoff, prHandoff] = await Promise.all([
		apiFetch(`/api/${owner}/${id}/git-status?intent=explicit`),
		apiFetch(`/api/${owner}/${id}/pr-status?intent=explicit&optional=1`),
	]);
	if (owner === "sessions") {
		expect(gitHandoff.status, "remote-state fixture Git lifecycle handoff failed").toBe(200);
		expect([200, 204], "remote-state fixture PR lifecycle handoff failed").toContain(prHandoff.status);
	}
	await Promise.all([gitHandoff.arrayBuffer(), prHandoff.arrayBuffer()]);
}

async function handoffRemoteStateRouteRunner(
	gateway: any,
	owners: readonly RemoteStateRouteOwner[],
	replacement: (file: string, args: readonly string[], options?: any) => Promise<any>,
): Promise<() => void> {
	const runner = gateway.sessionManager.commandRunner;
	const predecessor = runner.execFile;
	// Final route bindings can enqueue PR work after createGoal or createSession
	// drained its bootstrap. Join that work while its original runner still owns
	// it, then replace the mutable runner without another await. Do not re-probe
	// Git here: containment scenarios intentionally finish with broken worktrees.
	const handoffs = await Promise.all(owners.map(({ owner, id }) =>
		apiFetch(`/api/${owner}/${id}/pr-status?intent=explicit&optional=1`),
	));
	await Promise.all(handoffs.map(response => response.arrayBuffer()));
	expect(runner.execFile, "remote-state runner changed during lifecycle handoff").toBe(predecessor);
	// The drained predecessor read owns the current force marker. Seal a distinct
	// production-sized epoch before changing runner ownership so the first read
	// after handoff cannot coalesce onto that predecessor snapshot. Keep the epoch
	// advance and runner replacement synchronous: an await here would reopen the
	// mutable runner ownership gap this handoff closes.
	crossForceCoalescingWindow();
	runner.execFile = replacement;
	return () => {
		if (runner.execFile === replacement) runner.execFile = predecessor;
	};
}

async function createGoal(
	opts: Parameters<typeof rawCreateGoal>[0],
): Promise<Awaited<ReturnType<typeof rawCreateGoal>>> {
	const goal = await rawCreateGoal(opts);
	const goalId = String(goal.id);
	const projectId = typeof goal.projectId === "string" ? goal.projectId : undefined;
	expect(projectId, "remote-state fixture goal project unavailable").toEqual(expect.any(String));
	const goalStore = gatewaySync().sessionManager.getGoalStoreForProject(projectId!);
	const persisted = goalStore.get(goalId);
	expect(persisted, "remote-state fixture goal unavailable after creation").toBeTruthy();
	const originalBinding = {
		branch: persisted.branch,
		worktreePath: persisted.worktreePath,
		setupStatus: persisted.setupStatus,
	};

	// The compatibility helper intentionally creates standalone (`worktree:false`)
	// goals, so their public remote routes normally reject the missing branch and
	// worktree before reaching the coordinator. Give the goal a temporary routable
	// binding solely for this lifecycle handoff, then restore its exact standalone
	// shape before exposing it to the test. The returned API object is untouched.
	goalStore.update(goalId, {
		branch: "fixture/remote-state-bootstrap",
		worktreePath: persisted.cwd,
		setupStatus: "ready",
	});
	try {
		await completeRemoteStateRouteHandoff("goals", goalId);
	} finally {
		goalStore.update(goalId, originalBinding);
	}
	return goal;
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

	await completeRemoteStateRouteHandoff("sessions", sessionId);
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
		// These server-module fakes are process-global, so the suite—not an
		// individual spec body—owns their lifetime. The compatibility harness runs
		// its entity sweep after spec afterEach hooks; clearing here keeps cleanup in
		// the same synthetic force-clock domain and releases both seams before the
		// harness's final leak assertion or a later suite can observe them.
		serverModule?.__clearGitStatusFake();
		serverModule?.__clearRemoteStateForceNowFake();
		if (!projectPersistenceOptions || !previousPersistence) return;
		projectPersistenceOptions.goalPersistence = previousPersistence.goalPersistence;
		projectPersistenceOptions.taskPersistence = previousPersistence.taskPersistence;
		projectPersistenceOptions.gatePersistence = previousPersistence.gatePersistence;
	});

	test.beforeEach(() => {
		forceRequestBurstOpen = false;
		forceRequestedAt = Math.max(forceRequestedAt, performance.now()) + 251;
		serverModule.__setRemoteStateForceNowFake(() => forceRequestedAt);
		serverModule.__setGitStatusFake(async (_cwd: string, _containerId?: string, opts?: { untracked?: boolean }) => deterministicGitStatus(opts));
	});
}

export {
	mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync,
	EventEmitter, tmpdir, PassThrough, dirname, join, awaitableRm, test, expect,
	apiFetch, apiFetchAtCurrentForceEpoch, connectWs, createGoal, defaultProjectId, deleteGoal, deleteSession, gitCwd, nonGitCwd, registerProject,
	createCommandSpawnAdapter, crossForceCoalescingWindow, unexpectedRunnerCommand,
	standardSingleRepositoryProbe, commandName, credentialHelperResult, ownedHeadEvidence,
	ownedHeadEvidenceForSlug, createRemoteStateSession, removeSiblingWorktree,
	handoffRemoteStateRouteRunner,
};
