import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeInventoryService, classifyPoolReclaimCandidate, isContainerInternalWorktreePath } from "../src/server/agent/worktree-inventory.ts";

function makeCtx(rootPath: string, opts?: { worktreeRoot?: string; liveSessions?: any[]; archivedSessions?: any[]; goals?: any[]; components?: any[] }) {
	return {
		project: { id: "p1", name: "Project", rootPath },
		projectConfigStore: {
			get: (key: string) => key === "worktree_root" ? opts?.worktreeRoot : undefined,
			getComponents: () => opts?.components ?? [],
		},
		sessionStore: { getLive: () => opts?.liveSessions ?? [], getArchived: () => opts?.archivedSessions ?? [] },
		goalStore: { getAll: () => opts?.goals ?? [] },
		teamStore: { getAll: () => [] },
		staffStore: { getAll: () => [] },
	};
}

function makeService(ctx: any, porcelain: string, archivedItems: any[] = [], pools = new Map()) {
	return new WorktreeInventoryService({
		projectContextManager: { visible: function* () { yield ctx; }, all: function* () { yield ctx; } } as any,
		sessionManager: {
			listSessions: () => [],
			getAllWorktreePools: () => pools,
			listArchivedSessionWorktrees: async () => ({ sessions: [], items: archivedItems, counts: {}, groups: [], selectionPresets: [], generatedAt: 1 }),
		} as any,
		execGit: async (_repoPath, args) => args[0] === "worktree" ? porcelain : "",
		clock: () => 1,
	});
}

function tmpProject() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-inventory-"));
	const repo = path.join(root, "repo");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	return { root, repo };
}

describe("worktree inventory classifier", () => {
	it("protects a live referenced worktree", async () => {
		const { root, repo } = tmpProject();
		try {
			const wt = path.join(root, "repo-wt", "session-live");
			fs.mkdirSync(wt, { recursive: true });
			const ctx = makeCtx(repo, { liveSessions: [{ id: "s1", title: "Live", cwd: wt, worktreePath: wt, repoPath: repo, branch: "session/live" }] });
			const service = makeService(ctx, `worktree ${repo}\nbranch refs/heads/master\n\nworktree ${wt}\nbranch refs/heads/session/live\n`);
			const report = await service.scan();
			const item = report.items.find(i => i.path === wt)!;
			assert.equal(item.classification, "protected-in-use");
			assert.equal(item.reason, "referenced-by-live-session");
			assert.equal(item.actionable, false);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("maps archived-session owned git worktrees to ready cleanup rows", async () => {
		const { root, repo } = tmpProject();
		try {
			const wt = path.join(root, "repo-wt", "session-arch");
			fs.mkdirSync(wt, { recursive: true });
			const archived = {
				key: "a1:.:x", sessionId: "a1", title: "Archived", projectId: "p1", projectName: "Project", repo: ".", repoPath: repo, repoDisplayName: "repo", path: wt, branch: "session/arch", source: "sessionWorktree",
				pathExists: true, gitWorktreeMetadataExists: true, localBranchExists: true, status: "removable", reason: "safe-archived-session-worktree", detail: "safe", willDeleteBranch: true,
				disposition: "ready-to-clean", reasonCategory: "safe", actionable: true, selectable: true, defaultSelected: true, selectionCategories: ["archived-session", "single-repo"],
			};
			const service = makeService(makeCtx(repo), `worktree ${repo}\nbranch refs/heads/master\n\nworktree ${wt}\nbranch refs/heads/session/arch\n`, [archived]);
			const report = await service.scan();
			const item = report.items.find(i => i.legacy?.archivedSession?.sessionId === "a1")!;
			assert.equal(item.classification, "archived-owned");
			assert.equal(item.disposition, "ready-to-clean");
			assert.equal(item.defaultSelected, true);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("reports unowned session git worktrees through the legacy adapter", async () => {
		const { root, repo } = tmpProject();
		try {
			const wt = path.join(root, "repo-wt", "session-orphan");
			fs.mkdirSync(wt, { recursive: true });
			const service = makeService(makeCtx(repo), `worktree ${repo}\nbranch refs/heads/master\n\nworktree ${wt}\nbranch refs/heads/session/orphan\n`);
			const legacy = await service.legacyOrphanedWorktrees();
			assert.deepEqual(legacy.worktrees, [{ path: wt, branch: "session/orphan", repoPath: repo }]);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("honors configured worktree_root and keeps filesystem-only directories non-actionable", async () => {
		const { root, repo } = tmpProject();
		try {
			const stale = path.join(repo, ".custom-wt", "session-stale");
			fs.mkdirSync(stale, { recursive: true });
			const service = makeService(makeCtx(repo, { worktreeRoot: ".custom-wt" }), `worktree ${repo}\nbranch refs/heads/master\n`);
			const report = await service.scan();
			const item = report.items.find(i => i.path === stale)!;
			assert.equal(item.classification, "stale-filesystem-only");
			assert.equal(item.actionable, false);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("keeps pool candidates diagnostic and guards container paths", async () => {
		assert.equal(isContainerInternalWorktreePath("/workspace-wt/session-x"), true);
		const verdict = classifyPoolReclaimCandidate({ resolvedWorktreeRoot: "/tmp/repo-wt", candidatePath: "/tmp/repo-wt/pool-_pool-a", branch: "pool/_pool-a", gitMetadataExists: true });
		assert.equal(verdict.eligible, true);
		const active = classifyPoolReclaimCandidate({ resolvedWorktreeRoot: "/tmp/repo-wt", candidatePath: "/tmp/repo-wt/pool-_pool-a", branch: "pool/_pool-a", gitMetadataExists: true, activeWorktreePaths: new Set(["/tmp/repo-wt/pool-_pool-a"]) });
		assert.equal(active.eligible, false);
		assert.equal(active.reason, "referenced-by-live-session");

		const { root, repo } = tmpProject();
		try {
			const wt = path.join(root, "repo-wt", "pool-_pool-a");
			fs.mkdirSync(wt, { recursive: true });
			const pools = new Map([["p1", { snapshotEntries: () => ({ entries: [{ branchName: "pool/_pool-a", worktreePath: wt, createdAt: 1 }], target: 1, filling: false }) }]]);
			const service = makeService(makeCtx(repo), `worktree ${repo}\nbranch refs/heads/master\n\nworktree ${wt}\nbranch refs/heads/pool/_pool-a\n`, [], pools);
			const report = await service.scan();
			const item = report.items.find(i => i.path === wt)!;
			assert.equal(item.classification, "pool-entry");
			assert.equal(item.defaultSelected, false);
			assert.equal(report.counts.poolEntries, 1);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("classifies multi-repo pool entries as pool-entry instead of branch-referenced live records", async () => {
		const { root, repo } = tmpProject();
		try {
			const apiRepo = path.join(repo, "packages", "api");
			fs.mkdirSync(path.join(apiRepo, ".git"), { recursive: true });
			const container = path.join(root, "repo-wt", "pool-_pool-multi");
			const apiWt = path.join(container, "packages", "api");
			fs.mkdirSync(apiWt, { recursive: true });
			const components = [{ name: "api", repo: "packages/api" }];
			const pools = new Map([["p1", { snapshotEntries: () => ({ entries: [{ branchName: "pool/_pool-multi", worktreePath: container, worktrees: [{ repo: "packages/api", repoPath: apiRepo, worktreePath: apiWt }], createdAt: 1 }], target: 1, filling: false }) }]]);
			const service = makeService(makeCtx(repo, { components }), `worktree ${apiRepo}\nbranch refs/heads/master\n\nworktree ${apiWt}\nbranch refs/heads/pool/_pool-multi\n`, [], pools);
			const report = await service.scan();
			const item = report.items.find(i => i.path === apiWt)!;
			assert.equal(item.classification, "pool-entry");
			assert.equal(item.reason, "safe-pool-entry");
			assert.equal(item.defaultSelected, false);
			assert.equal(report.counts.poolEntries, 1);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
});
