/**
 * Unit tests for ArchivedWorktreeManager (SessionManager decomposition
 * cohort 1, docs/design/session-manager-decomposition.md). Exercises the
 * extracted archived-worktree bookkeeping directly against a fake
 * ArchivedWorktreeDeps — no SessionManager, no MCP, no RpcBridge, no
 * sandbox — the same payoff session-status.ts's own header comment cites
 * for its extraction.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ArchivedWorktreeManager, type ArchivedWorktreeDeps, type LiveSessionWorktreeRef } from "../src/server/agent/archived-worktree-manager.ts";

process.env.BOBBIT_TEST_NO_PUSH = "1";

const execFile = promisify(execFileCb);
const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	}
});

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd });
	return stdout.trim();
}

async function makeRepo(): Promise<string> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awm-test-"));
	tmpDirs.push(tmp);
	const repo = path.join(tmp, "repo");
	fs.mkdirSync(repo, { recursive: true });
	await git(["-c", "init.defaultBranch=master", "init", repo], tmp);
	await git(["config", "user.name", "Bobbit Test"], repo);
	await git(["config", "user.email", "bobbit-test@example.invalid"], repo);
	fs.writeFileSync(path.join(repo, "README.md"), "# repro\n", "utf8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);
	return repo;
}

async function makeWorktree(repo: string, worktreePath: string, branch: string): Promise<void> {
	fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
	await git(["worktree", "add", "-b", branch, worktreePath, "HEAD"], repo);
}

function makePersistedSession(id: string, extra: Record<string, unknown> = {}): any {
	return {
		id,
		title: `session ${id}`,
		cwd: "/tmp/does-not-matter",
		createdAt: Date.now(),
		lastActivity: Date.now(),
		archived: true,
		...extra,
	};
}

/** Minimal fake store: get/update/purge/getArchived/getLive over a Map. */
function makeFakeStore(sessions: any[]) {
	const byId = new Map(sessions.map(s => [s.id, s]));
	return {
		get: (id: string) => byId.get(id),
		update: (id: string, updates: Record<string, unknown>) => {
			const existing = byId.get(id);
			if (existing) Object.assign(existing, updates);
		},
		purge: (id: string) => byId.delete(id),
		getArchived: () => [...byId.values()].filter(s => s.archived),
		getLive: () => [...byId.values()].filter(s => !s.archived),
	};
}

function makeDeps(overrides: Partial<ArchivedWorktreeDeps> = {}): ArchivedWorktreeDeps & { calls: Record<string, unknown[]> } {
	const calls: Record<string, unknown[]> = {
		cascadeReapOwner: [],
		cleanupScopedMcpManagersForSessionScope: [],
		terminateSession: [],
		archiveWithCascade: [],
		notifyTermination: [],
	};
	const base: ArchivedWorktreeDeps = {
		projectContextManager: null,
		testStore: null,
		testSearchIndex: null,
		colorStore: undefined,
		getSandboxManager: () => null,
		getVerificationHarness: () => undefined,
		listLiveSessionWorktreeRefs: (): LiveSessionWorktreeRef[] => [],
		resolveStoreForId: () => null,
		getSessionStore: () => { throw new Error("getSessionStore not stubbed"); },
		getAllPersistedSessionsForWorktreeGuard: () => [],
		cascadeReapOwner: async (id: string) => { calls.cascadeReapOwner.push(id); },
		cleanupScopedMcpManagersForSessionScope: async (scope) => { calls.cleanupScopedMcpManagersForSessionScope.push(scope); },
		terminateSession: async (id: string) => { calls.terminateSession.push(id); return false; },
		archiveWithCascade: async (id: string) => { calls.archiveWithCascade.push(id); return true; },
		notifyTermination: (sessionId, info) => { calls.notifyTermination.push({ sessionId, info }); },
	};
	return Object.assign(base, overrides, { calls });
}

describe("ArchivedWorktreeManager", () => {
	it("updateArchivedMeta updates only archived sessions found via resolveStoreForId", () => {
		const store = makeFakeStore([makePersistedSession("s1", { archived: true }), makePersistedSession("s2", { archived: false })]);
		const deps = makeDeps({ resolveStoreForId: () => store as any });
		const mgr = new ArchivedWorktreeManager(deps);

		assert.equal(mgr.updateArchivedMeta("s1", { readOnly: true }), true);
		assert.equal(store.get("s1").readOnly, true);

		// s2 is not archived — update must be refused.
		assert.equal(mgr.updateArchivedMeta("s2", { readOnly: true }), false);
		assert.equal(store.get("s2").readOnly, undefined);

		// Unknown id — refused, no throw.
		assert.equal(mgr.updateArchivedMeta("missing", { readOnly: true }), false);
	});

	it("listArchivedSessions reads through testStore when no projectContextManager is wired", () => {
		const archived = [makePersistedSession("a1"), makePersistedSession("a2")];
		const testStore = { getArchived: () => archived, getLive: () => [] };
		const deps = makeDeps({ testStore: testStore as any });
		const mgr = new ArchivedWorktreeManager(deps);

		const result = mgr.listArchivedSessions();
		assert.equal(result.length, 2);
		assert.deepEqual(result.map(r => r.id).sort(), ["a1", "a2"]);
		assert.ok(result.every(r => r.archived === true));
	});

	it("getExpiredArchiveStats counts only archives past the 7-day cutoff", async () => {
		const now = Date.now();
		const old = makePersistedSession("old", { archivedAt: now - 8 * 24 * 60 * 60 * 1000 });
		const recent = makePersistedSession("recent", { archivedAt: now - 1 * 24 * 60 * 60 * 1000 });
		const testStore = { getArchived: () => [old, recent], getLive: () => [] };
		const deps = makeDeps({ testStore: testStore as any });
		const mgr = new ArchivedWorktreeManager(deps);

		const stats = await mgr.getExpiredArchiveStats();
		assert.equal(stats.count, 1);
	});

	it("purgeOneSession refuses to purge the active team-lead of a non-archived goal (dangling team-lead safety net)", async () => {
		const ps = makePersistedSession("lead1", { role: "team-lead", teamGoalId: "goal1", projectId: "p1", archived: true });
		const store = makeFakeStore([ps]);
		const projectContextManager = {
			getOrCreate: (projectId: string) => projectId === "p1" ? {
				teamStore: { get: (goalId: string) => goalId === "goal1" ? { teamLeadSessionId: "lead1" } : undefined },
				goalStore: { get: (goalId: string) => goalId === "goal1" ? { archived: false } : undefined },
			} : undefined,
		};
		const deps = makeDeps({ resolveStoreForId: () => store as any, projectContextManager: projectContextManager as any });
		const mgr = new ArchivedWorktreeManager(deps);

		const purged = await mgr.purgeArchivedSession("lead1");
		assert.equal(purged, true, "purgeArchivedSession itself just checks .archived and delegates");
		// The session must still be present — the internal safety check refused the actual purge.
		assert.ok(store.get("lead1"), "team-lead session must survive the safety-net refusal");
		assert.equal(deps.calls.cascadeReapOwner.length, 0, "cascade-reap must not run when the purge was refused");
	});

	it("purgeOneSession runs the full teardown sequence and notifies termination listeners once", async () => {
		const ps = makePersistedSession("s1", { projectId: "p1", cwd: "/tmp/x", archived: true });
		const store = makeFakeStore([ps]);
		const deps = makeDeps({ resolveStoreForId: () => store as any });
		const mgr = new ArchivedWorktreeManager(deps);

		const purged = await mgr.purgeArchivedSession("s1");
		assert.equal(purged, true);
		assert.equal(store.get("s1"), undefined, "purged session must be removed from the store");
		assert.deepEqual(deps.calls.cascadeReapOwner, ["s1"]);
		assert.deepEqual(deps.calls.cleanupScopedMcpManagersForSessionScope, [{ projectId: "p1", cwd: "/tmp/x" }]);
		assert.equal(deps.calls.notifyTermination.length, 1);
		assert.deepEqual(deps.calls.notifyTermination[0], { sessionId: "s1", info: { projectId: "p1", reason: "purged" } });
	});

	it("terminateOrphanedSessions falls back to archiveWithCascade when terminateSession reports no live session", async () => {
		const ps = makePersistedSession("orphan1", { projectId: "p1", nonInteractive: true, archived: false });
		const store = makeFakeStore([ps]);
		const deps = makeDeps({
			resolveStoreForId: () => store as any,
			getSessionStore: () => store as any,
			terminateSession: async (id: string) => { deps.calls.terminateSession.push(id); return false; },
		});
		const mgr = new ArchivedWorktreeManager(deps);

		const terminated = await mgr.terminateOrphanedSessions(["orphan1"]);
		assert.equal(terminated, 1);
		assert.deepEqual(deps.calls.terminateSession, ["orphan1"]);
		assert.deepEqual(deps.calls.archiveWithCascade, ["orphan1"]);
	});

	describe("git-backed worktree scanning", () => {
		it("listArchivedSessionWorktrees classifies a real archived-session worktree as removable, and cleanup actually removes it", async () => {
			const repo = await makeRepo();
			const wt = path.join(path.dirname(repo), "wt-archived");
			await makeWorktree(repo, wt, "session/archived1");
			const ps = makePersistedSession("archived1", { repoPath: repo, worktreePath: wt, branch: "session/archived1", archived: true, archivedAt: Date.now() });
			const testStore = { getArchived: () => [ps], getLive: () => [] };
			const deps = makeDeps({ testStore: testStore as any });
			const mgr = new ArchivedWorktreeManager(deps);

			const scan = await mgr.listArchivedSessionWorktrees();
			assert.equal(scan.items.length, 1);
			assert.equal(scan.items[0].status, "removable");
			assert.equal(scan.items[0].reason, "safe-archived-session-worktree");

			const cleanup = await mgr.cleanupArchivedSessionWorktrees({ mode: "all" });
			assert.equal(cleanup.counts.cleaned, 1);
			assert.equal(fs.existsSync(wt), false, "cleanup must actually remove the worktree directory");
		});

		it("listArchivedSessionWorktrees skips a worktree still referenced by a live session", async () => {
			const repo = await makeRepo();
			const wt = path.join(path.dirname(repo), "wt-shared");
			await makeWorktree(repo, wt, "session/shared1");
			const archivedPs = makePersistedSession("archived-shared", { repoPath: repo, worktreePath: wt, branch: "session/shared1", archived: true, archivedAt: Date.now() });
			const testStore = { getArchived: () => [archivedPs], getLive: () => [] };
			const liveRef: LiveSessionWorktreeRef = { id: "live1", worktreePath: wt, cwd: wt, repoPath: repo, branch: "session/shared1" };
			const deps = makeDeps({ testStore: testStore as any, listLiveSessionWorktreeRefs: () => [liveRef] });
			const mgr = new ArchivedWorktreeManager(deps);

			const scan = await mgr.listArchivedSessionWorktrees();
			assert.equal(scan.items.length, 1);
			assert.equal(scan.items[0].status, "skipped");
			assert.equal(scan.items[0].reason, "referenced-by-live-session");
		});
	});
});
