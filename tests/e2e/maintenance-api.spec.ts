/**
 * E2E tests for the /api/maintenance/* endpoints.
 *
 * Tests Phase 1 (no auto-cleanup on restart) and Phase 4a (maintenance REST API).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, apiFetch, createSession, deleteSession, defaultProjectId } from "./e2e-setup.js";

let token: string;

test.beforeAll(() => {
	token = readE2EToken();
});

type SeededSession = {
	ctx: any;
	session: any;
	projectId: string;
};

const archivedScanCountKeys = [
	"archivedSessions",
	"sessionsWithWorktrees",
	"removableWorktrees",
	"skippedWorktrees",
	"alreadyCleanedWorktrees",
	"totalItems",
	"readyToClean",
	"defaultSelected",
	"alreadyCleaned",
	"ineligible",
	"needsAttention",
	"failed",
] as const;

const archivedCleanupCountKeys = [
	"requested",
	"cleaned",
	"branchDeleted",
	"skipped",
	"alreadyCleaned",
	"failed",
	"worktreeRemoved",
	"invalidSelection",
	"notActionable",
] as const;

const archivedWorktreeStatuses = ["removable", "skipped", "already-cleaned"] as const;
const archivedWorktreeDispositions = ["ready-to-clean", "already-cleaned", "ineligible", "needs-attention", "failed"] as const;
const archivedWorktreeReasons = [
	"safe-archived-session-worktree",
	"already-cleaned",
	"no-worktree-path",
	"missing-repo-path",
	"sandbox-container-path",
	"delegate-shared-worktree",
	"stale-worktree-directory",
	"referenced-by-live-session",
	"referenced-by-live-goal",
	"referenced-by-live-team",
	"referenced-by-staff",
	"scan-error",
] as const;
const archivedWorktreeReasonCategories = ["safe", "already-cleaned", "missing-metadata", "container-path", "shared-delegate", "stale-path", "referenced-record", "error"] as const;
const archivedWorktreeSelectionCategories = ["archived-session", "goal-session", "team-session", "delegate-session", "child-session", "single-repo", "multi-repo"] as const;
const archivedCleanupStatuses = ["cleaned", "skipped", "already-cleaned", "failed"] as const;

function expectNumberCounts(body: any, keys: readonly string[]): void {
	expect(body).toHaveProperty("counts");
	for (const key of keys) {
		expect(typeof body.counts[key], `counts.${key}`).toBe("number");
	}
}

function expectNumberMap(value: any, label: string): void {
	expect(value && typeof value === "object" && !Array.isArray(value), label).toBe(true);
	for (const [key, count] of Object.entries(value)) {
		expect(typeof key, `${label} key`).toBe("string");
		expect(typeof count, `${label}.${key}`).toBe("number");
	}
}

function flattenedArchivedWorktreeItems(body: any): any[] {
	return (body.sessions as any[]).flatMap((session) => session.worktrees as any[]);
}

function expectArchivedWorktreeItemShape(item: any, parentSession?: any): void {
	expect(typeof item.key).toBe("string");
	expect(typeof item.sessionId).toBe("string");
	if (parentSession) {
		expect(item.sessionId).toBe(parentSession.id);
		expect(item.title).toBe(parentSession.title);
	}
	expect(typeof item.title).toBe("string");
	if (item.archivedAt !== undefined) expect(typeof item.archivedAt).toBe("number");
	if (item.projectId !== undefined) expect(typeof item.projectId).toBe("string");
	if (item.projectName !== undefined) expect(typeof item.projectName).toBe("string");
	if (item.goalId !== undefined) expect(typeof item.goalId).toBe("string");
	if (item.teamGoalId !== undefined) expect(typeof item.teamGoalId).toBe("string");
	if (item.delegateOf !== undefined) expect(typeof item.delegateOf).toBe("string");
	if (item.parentSessionId !== undefined) expect(typeof item.parentSessionId).toBe("string");
	if (item.childKind !== undefined) expect(typeof item.childKind).toBe("string");
	if (item.sandboxed !== undefined) expect(typeof item.sandboxed).toBe("boolean");
	expect(typeof item.repo).toBe("string");
	expect(typeof item.repoPath).toBe("string");
	expect(typeof item.repoDisplayName).toBe("string");
	expect(typeof item.path).toBe("string");
	if (item.branch !== undefined) expect(typeof item.branch).toBe("string");
	expect(["repoWorktrees", "sessionWorktree"]).toContain(item.source);
	expect(typeof item.pathExists).toBe("boolean");
	expect(typeof item.gitWorktreeMetadataExists).toBe("boolean");
	expect(typeof item.localBranchExists).toBe("boolean");
	expect([...archivedWorktreeStatuses]).toContain(item.status);
	expect([...archivedWorktreeReasons]).toContain(item.reason);
	expect(typeof item.detail).toBe("string");
	expect(typeof item.willDeleteBranch).toBe("boolean");
	if (item.branchDeleteBlockedReason !== undefined) expect(["branch-referenced-by-live-record", "branch-referenced-by-archived-record"]).toContain(item.branchDeleteBlockedReason);
	expect([...archivedWorktreeDispositions]).toContain(item.disposition);
	expect([...archivedWorktreeReasonCategories]).toContain(item.reasonCategory);
	expect(typeof item.actionable).toBe("boolean");
	expect(typeof item.selectable).toBe("boolean");
	expect(typeof item.defaultSelected).toBe("boolean");
	expect(Array.isArray(item.selectionCategories)).toBe(true);
	for (const category of item.selectionCategories) expect([...archivedWorktreeSelectionCategories]).toContain(category);
	if (item.status === "removable") {
		expect(item).toMatchObject({
			reason: "safe-archived-session-worktree",
			disposition: "ready-to-clean",
			reasonCategory: "safe",
			actionable: true,
			selectable: true,
			defaultSelected: true,
		});
	}
	if (item.status === "already-cleaned") {
		expect(item).toMatchObject({
			reason: "already-cleaned",
			disposition: "already-cleaned",
			reasonCategory: "already-cleaned",
			actionable: false,
			selectable: false,
			defaultSelected: false,
		});
	}
}

function expectArchivedScanShape(body: any): void {
	expect(body).toHaveProperty("sessions");
	expect(Array.isArray(body.sessions)).toBe(true);
	expectNumberCounts(body, archivedScanCountKeys);
	expectNumberMap(body.counts.byDisposition, "counts.byDisposition");
	expectNumberMap(body.counts.byReason, "counts.byReason");
	expectNumberMap(body.counts.bySelectionCategory, "counts.bySelectionCategory");
	expect(body.counts.readyToClean).toBe(body.counts.removableWorktrees);
	expect(body.counts.defaultSelected).toBe(body.counts.readyToClean);
	expect(body.counts.alreadyCleaned).toBe(body.counts.alreadyCleanedWorktrees);
	expect(typeof body.generatedAt).toBe("number");
	expect(Array.isArray(body.items)).toBe(true);
	expect(Array.isArray(body.groups)).toBe(true);
	expect(Array.isArray(body.selectionPresets)).toBe(true);
	const flattenedItems = flattenedArchivedWorktreeItems(body);
	expect(body.items.map((item: any) => item.key).sort()).toEqual(flattenedItems.map((item: any) => item.key).sort());
	for (const session of body.sessions as any[]) {
		expect(typeof session.id).toBe("string");
		expect(typeof session.title).toBe("string");
		if (session.archivedAt !== undefined) expect(typeof session.archivedAt).toBe("number");
		if (session.projectId !== undefined) expect(typeof session.projectId).toBe("string");
		if (session.projectName !== undefined) expect(typeof session.projectName).toBe("string");
		expect(Array.isArray(session.worktrees)).toBe(true);
		for (const item of session.worktrees as any[]) expectArchivedWorktreeItemShape(item, session);
	}
	for (const item of body.items as any[]) expectArchivedWorktreeItemShape(item);
	for (const group of body.groups as any[]) {
		expect(typeof group.key).toBe("string");
		expect(typeof group.label).toBe("string");
		expect(typeof group.description).toBe("string");
		expect([...archivedWorktreeDispositions]).toContain(group.disposition);
		if (group.reason !== undefined) expect([...archivedWorktreeReasons]).toContain(group.reason);
		if (group.reasonCategory !== undefined) expect([...archivedWorktreeReasonCategories]).toContain(group.reasonCategory);
		expect(typeof group.count).toBe("number");
		expect(Array.isArray(group.sampleKeys)).toBe(true);
		expect(group.sampleKeys.length).toBeLessThanOrEqual(5);
		for (const key of group.sampleKeys) expect(typeof key, `group ${group.key} sample key`).toBe("string");
		expect(Array.isArray(group.sampleItems)).toBe(true);
		expect(group.sampleItems.length).toBe(group.sampleKeys.length);
		for (const item of group.sampleItems) expectArchivedWorktreeItemShape(item);
		expect(typeof group.hasMore).toBe("boolean");
		expect(typeof group.actionable).toBe("boolean");
	}
	const allRemovablePreset = (body.selectionPresets as any[]).find((preset) => preset.id === "all-removable");
	expect(allRemovablePreset).toBeTruthy();
	for (const preset of body.selectionPresets as any[]) {
		expect(typeof preset.id).toBe("string");
		expect(typeof preset.label).toBe("string");
		expect(typeof preset.description).toBe("string");
		expect(typeof preset.enabled).toBe("boolean");
		expect(typeof preset.count).toBe("number");
		expect(Array.isArray(preset.worktreeKeys)).toBe(true);
		expect(preset.worktreeKeys).toHaveLength(preset.count);
		expect(preset.cleanupRequest && typeof preset.cleanupRequest).toBe("object");
		for (const key of preset.worktreeKeys) {
			const item = (body.items as any[]).find((candidate) => candidate.key === key);
			expect(item, `preset ${preset.id} key ${key}`).toBeTruthy();
			expect(item.actionable, `preset ${preset.id} must select only actionable rows`).toBe(true);
		}
	}
	expect(allRemovablePreset.cleanupRequest).toMatchObject({ mode: "all" });
	expect(allRemovablePreset.count).toBe(body.counts.readyToClean);
}

function expectArchivedCleanupShape(body: any): void {
	expectNumberCounts(body, archivedCleanupCountKeys);
	expectNumberMap(body.counts.byStatus, "counts.byStatus");
	expectNumberMap(body.counts.byReason, "counts.byReason");
	expect(typeof body.generatedAt).toBe("number");
	expect(Array.isArray(body.results)).toBe(true);
	for (const result of body.results as any[]) {
		expect(typeof result.key).toBe("string");
		expect(typeof result.sessionId).toBe("string");
		if (result.title !== undefined) expect(typeof result.title).toBe("string");
		if (result.repo !== undefined) expect(typeof result.repo).toBe("string");
		if (result.repoPath !== undefined) expect(typeof result.repoPath).toBe("string");
		if (result.path !== undefined) expect(typeof result.path).toBe("string");
		if (result.branch !== undefined) expect(typeof result.branch).toBe("string");
		expect([...archivedCleanupStatuses]).toContain(result.status);
		if (result.reason !== undefined) expect(typeof result.reason).toBe("string");
		if (result.detail !== undefined) expect(typeof result.detail).toBe("string");
		if (result.error !== undefined) expect(typeof result.error).toBe("string");
		expect(typeof result.worktreeRemoved).toBe("boolean");
		expect(typeof result.branchDeleted).toBe("boolean");
	}
}

function git(repoPath: string, args: string[]): string {
	return execFileSync("git", args, { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function branchExists(repoPath: string, branch: string): boolean {
	try {
		execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function normalizeTestPath(path: string): string {
	return path.replace(/\\/g, "/").toLowerCase();
}

function listedWorktreePaths(repoPath: string): string[] {
	return [...git(repoPath, ["worktree", "list", "--porcelain"]).matchAll(/^worktree (.+)$/gm)]
		.map(match => normalizeTestPath(match[1]));
}

function initGitRepo(path: string): void {
	mkdirSync(path, { recursive: true });
	git(path, ["init"]);
	git(path, ["config", "user.email", "e2e@example.invalid"]);
	git(path, ["config", "user.name", "E2E Test"]);
	writeFileSync(join(path, "README.md"), "# archived worktree maintenance e2e\n");
	git(path, ["add", "."]);
	git(path, ["commit", "-m", "init"]);
}

function tryRemoveWorktree(repoPath: string, worktreePath: string): void {
	try { execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath, stdio: "ignore" }); } catch { /* best effort */ }
}

function tryDeleteBranch(repoPath: string, branch: string): void {
	try { execFileSync("git", ["branch", "-D", branch], { cwd: repoPath, stdio: "ignore" }); } catch { /* best effort */ }
}

async function seedArchivedSession(gateway: any, overrides: Partial<any> & { id?: string; title?: string; baseDir?: string } = {}): Promise<SeededSession> {
	const projectId = await defaultProjectId();
	expect(projectId).toBeTruthy();
	const ctx = gateway.projectContextManager.getOrCreate(projectId!);
	expect(ctx).toBeTruthy();
	const now = Date.now();
	const baseDir = overrides.baseDir ?? mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-session-"));
	const id = overrides.id ?? `archived-wt-${now}-${Math.random().toString(36).slice(2, 8)}`;
	const agentSessionFile = overrides.agentSessionFile ?? join(baseDir, `${id}.jsonl`);
	mkdirSync(dirname(agentSessionFile), { recursive: true });
	if (!existsSync(agentSessionFile)) {
		writeFileSync(agentSessionFile, JSON.stringify({ type: "system", cwd: overrides.cwd ?? baseDir }) + "\n");
	}
	const session = {
		id,
		title: overrides.title ?? `Archived worktree ${id}`,
		cwd: overrides.cwd ?? baseDir,
		agentSessionFile,
		createdAt: now - 1000,
		lastActivity: now - 500,
		archived: true,
		archivedAt: now,
		projectId,
		...overrides,
	};
	delete session.baseDir;
	ctx.sessionStore.put(session);
	return { ctx, session, projectId: projectId! };
}

function findArchivedSession(scan: any, sessionId: string): any | undefined {
	return (scan.sessions as any[]).find((session) => session.id === sessionId);
}

function findArchivedWorktreeItem(scan: any, sessionId: string): any | undefined {
	return (scan.items as any[]).find((item) => item.sessionId === sessionId);
}

function findArchivedWorktreeGroup(scan: any, key: string): any | undefined {
	return (scan.groups as any[]).find((group) => group.key === key);
}

async function getArchivedWorktreeScan(query = ""): Promise<any> {
	const resp = await apiFetch(`/api/maintenance/archived-session-worktrees${query}`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expectArchivedScanShape(body);
	return body;
}

// ---------------------------------------------------------------------------
// GET /api/maintenance/orphaned-worktrees
// ---------------------------------------------------------------------------
test("GET /api/maintenance/orphaned-worktrees returns list", async () => {
	const resp = await apiFetch("/api/maintenance/orphaned-worktrees");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toHaveProperty("worktrees");
	expect(Array.isArray(body.worktrees)).toBe(true);
});

// ---------------------------------------------------------------------------
// POST /api/maintenance/cleanup-worktrees returns cleaned count
// ---------------------------------------------------------------------------
test("POST /api/maintenance/cleanup-worktrees returns cleaned count", async () => {
	test.slow(); // Worktree scan can be slow when other tests create worktrees concurrently
	const resp = await apiFetch("/api/maintenance/cleanup-worktrees", {
		method: "POST",
		body: JSON.stringify({}),
	});
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toHaveProperty("cleaned");
	expect(typeof body.cleaned).toBe("number");
});

// ---------------------------------------------------------------------------
// GET /api/maintenance/orphaned-sessions
// ---------------------------------------------------------------------------
test("GET /api/maintenance/orphaned-sessions returns list", async () => {
	const resp = await apiFetch("/api/maintenance/orphaned-sessions");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toHaveProperty("sessions");
	expect(Array.isArray(body.sessions)).toBe(true);
});

// ---------------------------------------------------------------------------
// POST /api/maintenance/cleanup-sessions
// ---------------------------------------------------------------------------
test("POST /api/maintenance/cleanup-sessions returns terminated count", async () => {
	const resp = await apiFetch("/api/maintenance/cleanup-sessions", {
		method: "POST",
		body: JSON.stringify({}),
	});
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toHaveProperty("terminated");
	expect(typeof body.terminated).toBe("number");
});

// ---------------------------------------------------------------------------
// GET /api/maintenance/expired-archives
// ---------------------------------------------------------------------------
test("GET /api/maintenance/expired-archives returns stats", async () => {
	const resp = await apiFetch("/api/maintenance/expired-archives");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toHaveProperty("count");
	expect(body).toHaveProperty("totalSizeBytes");
	expect(typeof body.count).toBe("number");
	expect(typeof body.totalSizeBytes).toBe("number");
});

// ---------------------------------------------------------------------------
// POST /api/maintenance/purge-archives
// ---------------------------------------------------------------------------
test("POST /api/maintenance/purge-archives runs purge", async () => {
	const resp = await apiFetch("/api/maintenance/purge-archives", {
		method: "POST",
		body: JSON.stringify({}),
	});
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toHaveProperty("purged", true);
	expect(body).toHaveProperty("remaining");
});

// ---------------------------------------------------------------------------
// Archived session worktree maintenance
// ---------------------------------------------------------------------------
test.describe("archived session worktree maintenance", () => {
	test("GET /api/maintenance/archived-session-worktrees returns sessions, flattened items, groups, presets, and additive counts", async () => {
		const body = await getArchivedWorktreeScan();
		expectArchivedScanShape(body);
	});

	test("scan exposes UX dispositions, reason categories, groups, and selection presets", async ({ gateway }) => {
		test.slow();
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-v2-scan-"));
		const repoPath = join(baseDir, "repo");
		const removablePath = join(baseDir, "removable-worktree");
		const liveReferencedPath = join(baseDir, "live-referenced-worktree");
		const stalePath = join(baseDir, "stale-directory");
		const missingPath = join(baseDir, "already-cleaned-worktree");
		const removableBranch = `archived-v2-removable-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const liveBranch = `archived-v2-live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const staleBranch = `archived-v2-stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const missingBranch = `archived-v2-missing-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const seeded: SeededSession[] = [];
		let liveSessionId: string | undefined;
		try {
			initGitRepo(repoPath);
			git(repoPath, ["worktree", "add", "-b", removableBranch, removablePath, "HEAD"]);
			git(repoPath, ["worktree", "add", "-b", liveBranch, liveReferencedPath, "HEAD"]);
			git(repoPath, ["branch", staleBranch, "HEAD"]);
			git(repoPath, ["branch", missingBranch, "HEAD"]);
			mkdirSync(stalePath, { recursive: true });

			const removable = await seedArchivedSession(gateway, { baseDir, title: "V2 removable archived worktree", cwd: removablePath, repoPath, worktreePath: removablePath, branch: removableBranch });
			const noPath = await seedArchivedSession(gateway, { baseDir, title: "V2 missing worktree path", cwd: join(baseDir, "no-path"), repoPath, worktreePath: undefined });
			const missingRepo = await seedArchivedSession(gateway, { baseDir, title: "V2 missing repo path", cwd: join(baseDir, "missing-repo"), repoPath: undefined, worktreePath: join(baseDir, "missing-repo") });
			const sandbox = await seedArchivedSession(gateway, { baseDir, title: "V2 sandbox path", cwd: "/workspace-wt/session/v2-sandbox", repoPath, worktreePath: "/workspace-wt/session/v2-sandbox", branch: "v2-sandbox", sandboxed: true });
			const delegate = await seedArchivedSession(gateway, { baseDir, title: "V2 delegate shared worktree", cwd: join(baseDir, "delegate"), repoPath, worktreePath: join(baseDir, "delegate"), branch: undefined, delegateOf: "parent-session-id" });
			const alreadyCleaned = await seedArchivedSession(gateway, { baseDir, title: "V2 already cleaned", cwd: missingPath, repoPath, worktreePath: missingPath, branch: missingBranch });
			const stale = await seedArchivedSession(gateway, { baseDir, title: "V2 stale path", cwd: stalePath, repoPath, worktreePath: stalePath, branch: staleBranch });
			const liveReferenced = await seedArchivedSession(gateway, { baseDir, title: "V2 live referenced", cwd: liveReferencedPath, repoPath, worktreePath: liveReferencedPath, branch: liveBranch });
			seeded.push(removable, noPath, missingRepo, sandbox, delegate, alreadyCleaned, stale, liveReferenced);
			liveSessionId = `live-v2-guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			removable.ctx.sessionStore.put({
				id: liveSessionId,
				title: "Live session sharing archived worktree path",
				cwd: liveReferencedPath,
				agentSessionFile: join(baseDir, `${liveSessionId}.jsonl`),
				createdAt: Date.now(),
				lastActivity: Date.now(),
				archived: false,
				projectId: removable.projectId,
				repoPath,
				worktreePath: liveReferencedPath,
				branch: liveBranch,
			});

			const scan = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			const cases: Array<[SeededSession, string, string, string, string, boolean]> = [
				[removable, "removable", "safe-archived-session-worktree", "ready-to-clean", "safe", true],
				[noPath, "skipped", "no-worktree-path", "ineligible", "missing-metadata", false],
				[missingRepo, "skipped", "missing-repo-path", "ineligible", "missing-metadata", false],
				[sandbox, "skipped", "sandbox-container-path", "ineligible", "container-path", false],
				[delegate, "skipped", "delegate-shared-worktree", "ineligible", "shared-delegate", false],
				[alreadyCleaned, "already-cleaned", "already-cleaned", "already-cleaned", "already-cleaned", false],
				[stale, "skipped", "stale-worktree-directory", "needs-attention", "stale-path", false],
				[liveReferenced, "skipped", "referenced-by-live-session", "ineligible", "referenced-record", false],
			];
			for (const [seed, status, reason, disposition, reasonCategory, actionable] of cases) {
				const item = findArchivedWorktreeItem(scan, seed.session.id);
				expect(item, seed.session.title).toBeTruthy();
				expect(item).toMatchObject({ status, reason, disposition, reasonCategory, actionable, selectable: actionable, defaultSelected: actionable });
				expect(scan.counts.byReason[reason]).toBeGreaterThanOrEqual(1);
				expect(scan.counts.byDisposition[disposition]).toBeGreaterThanOrEqual(1);
				const groupKey = disposition === "ready-to-clean" ? "ready-to-clean" : disposition === "already-cleaned" ? "already-cleaned" : `reason:${reason}`;
				const group = findArchivedWorktreeGroup(scan, groupKey);
				expect(group, groupKey).toBeTruthy();
				expect(group.count).toBeGreaterThanOrEqual(1);
			}

			const removableItem = findArchivedWorktreeItem(scan, removable.session.id);
			expect(removableItem.selectionCategories).toEqual(expect.arrayContaining(["archived-session", "single-repo"]));
			expect(scan.counts.readyToClean).toBeGreaterThanOrEqual(1);
			expect(scan.counts.defaultSelected).toBe(scan.counts.readyToClean);
			expect(scan.counts.alreadyCleaned).toBeGreaterThanOrEqual(1);
			expect(scan.counts.needsAttention).toBeGreaterThanOrEqual(1);
			expect(scan.counts.bySelectionCategory["archived-session"]).toBeGreaterThanOrEqual(1);
			const allPreset = scan.selectionPresets.find((preset: any) => preset.id === "all-removable");
			expect(allPreset).toMatchObject({ enabled: true, count: scan.counts.readyToClean, cleanupRequest: { mode: "all" } });
			expect(allPreset.worktreeKeys).toContain(removableItem.key);
			const archivedPreset = scan.selectionPresets.find((preset: any) => preset.id === "category:archived-session");
			expect(archivedPreset).toBeTruthy();
			expect(archivedPreset.worktreeKeys).toContain(removableItem.key);
			expect(archivedPreset.worktreeKeys).not.toContain(findArchivedWorktreeItem(scan, stale.session.id).key);

			const defaultScan = await getArchivedWorktreeScan();
			expect(findArchivedWorktreeItem(defaultScan, alreadyCleaned.session.id)).toBeUndefined();
			expect(defaultScan.counts.alreadyCleaned).toBeGreaterThanOrEqual(1);
		} finally {
			if (liveSessionId && seeded[0]) seeded[0].ctx.sessionStore.remove(liveSessionId);
			for (const seed of seeded) seed.ctx.sessionStore.remove(seed.session.id);
			tryRemoveWorktree(repoPath, removablePath);
			tryRemoveWorktree(repoPath, liveReferencedPath);
			for (const branch of [removableBranch, liveBranch, staleBranch, missingBranch]) tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("POST /api/maintenance/cleanup-archived-session-worktrees validates request shape", async () => {
		const missingMode = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(missingMode.status).toBe(400);

		const mixedSelectors = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
			method: "POST",
			body: JSON.stringify({
				mode: "selected",
				sessionIds: ["archived-a"],
				worktrees: [{ sessionId: "archived-a", key: "archived-a:." }],
			}),
		});
		expect(mixedSelectors.status).toBe(400);

		const emptySelected = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
			method: "POST",
			body: JSON.stringify({ mode: "selected", worktrees: [] }),
		});
		expect(emptySelected.status).toBe(200);
		const emptyBody = await emptySelected.json();
		expectArchivedCleanupShape(emptyBody);
		expect(emptyBody.counts).toMatchObject({
			requested: 0,
			cleaned: 0,
			branchDeleted: 0,
			skipped: 0,
			alreadyCleaned: 0,
			failed: 0,
		});
		expect(emptyBody.results).toEqual([]);

		const allWithProjectSelector = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
			method: "POST",
			body: JSON.stringify({ mode: "all", projectId: "project-a" }),
		});
		expect(allWithProjectSelector.status).toBe(400);

		const allWithRepoSelector = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
			method: "POST",
			body: JSON.stringify({ mode: "all", repoPath: "/tmp/repo-a" }),
		});
		expect(allWithRepoSelector.status).toBe(400);

		const allMode = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
			method: "POST",
			body: JSON.stringify({ mode: "all" }),
		});
		expect(allMode.status).toBe(200);
		expectArchivedCleanupShape(await allMode.json());
	});

	test("scan and selected cleanup remove archived worktree while preserving archived session visibility", async ({ gateway }) => {
		test.slow();
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-cleanup-"));
		const repoPath = join(baseDir, "repo");
		const worktreePath = join(baseDir, "worktree");
		const branch = `archived-cleanup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			git(repoPath, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
			expect(existsSync(worktreePath)).toBe(true);
			expect(branchExists(repoPath, branch)).toBe(true);

			seeded = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived cleanup candidate",
				cwd: worktreePath,
				repoPath,
				worktreePath,
				branch,
			});

			const scan = await getArchivedWorktreeScan();
			const scannedSession = findArchivedSession(scan, seeded.session.id);
			expect(scannedSession).toBeTruthy();
			expect(scannedSession.worktrees).toHaveLength(1);
			const candidate = scannedSession.worktrees[0];
			expect(candidate).toMatchObject({
				status: "removable",
				reason: "safe-archived-session-worktree",
				disposition: "ready-to-clean",
				reasonCategory: "safe",
				actionable: true,
				selectable: true,
				defaultSelected: true,
				title: "Archived cleanup candidate",
				repo: ".",
				repoPath,
				repoDisplayName: expect.any(String),
				path: worktreePath,
				branch,
				source: "sessionWorktree",
				pathExists: true,
				gitWorktreeMetadataExists: true,
				localBranchExists: true,
				willDeleteBranch: true,
			});
			expect(candidate.selectionCategories).toEqual(expect.arrayContaining(["archived-session", "single-repo"]));

			const cleanup = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
				method: "POST",
				body: JSON.stringify({
					mode: "selected",
					worktrees: [{ sessionId: seeded.session.id, key: candidate.key }],
				}),
			});
			expect(cleanup.status).toBe(200);
			const cleanupBody = await cleanup.json();
			expectArchivedCleanupShape(cleanupBody);
			expect(cleanupBody.counts).toMatchObject({
				requested: 1,
				cleaned: 1,
				branchDeleted: 1,
				worktreeRemoved: 1,
				invalidSelection: 0,
				notActionable: 0,
				failed: 0,
			});
			expect(cleanupBody.counts.byStatus.cleaned).toBe(1);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				key: candidate.key,
				title: "Archived cleanup candidate",
				repo: ".",
				repoPath,
				path: worktreePath,
				branch,
				status: "cleaned",
				reason: "worktree-and-branch-cleaned",
				worktreeRemoved: true,
				branchDeleted: true,
			}));
			expect(existsSync(worktreePath)).toBe(false);
			expect(branchExists(repoPath, branch)).toBe(false);

			const archivedResp = await apiFetch(`/api/sessions/${seeded.session.id}?include=archived`);
			expect(archivedResp.status).toBe(200);
			const archivedSession = await archivedResp.json();
			expect(archivedSession).toMatchObject({
				id: seeded.session.id,
				title: "Archived cleanup candidate",
				archived: true,
			});
			const persistedSession = seeded.ctx.sessionStore.get(seeded.session.id);
			expect(persistedSession).toMatchObject({
				id: seeded.session.id,
				title: "Archived cleanup candidate",
				archived: true,
				repoPath,
				worktreePath,
				branch,
			});
			expect(existsSync(seeded.session.agentSessionFile)).toBe(true);

			const rescan = await getArchivedWorktreeScan();
			expect(findArchivedSession(rescan, seeded.session.id)).toBeUndefined();
		} finally {
			if (seeded) seeded.ctx.sessionStore.remove(seeded.session.id);
			tryRemoveWorktree(repoPath, worktreePath);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("already-cleaned archived worktrees are hidden by default and stale selected cleanup is non-destructive", async ({ gateway }) => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-stale-"));
		const repoPath = join(baseDir, "repo");
		const missingWorktreePath = join(baseDir, "missing-worktree");
		const branch = `archived-stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			git(repoPath, ["branch", branch, "HEAD"]);
			seeded = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived already cleaned candidate",
				cwd: missingWorktreePath,
				repoPath,
				worktreePath: missingWorktreePath,
				branch,
			});

			const defaultScan = await getArchivedWorktreeScan();
			expect(findArchivedSession(defaultScan, seeded.session.id)).toBeUndefined();
			expect(findArchivedWorktreeItem(defaultScan, seeded.session.id)).toBeUndefined();
			expect(defaultScan.counts.alreadyCleaned).toBeGreaterThanOrEqual(1);
			const defaultAlreadyGroup = findArchivedWorktreeGroup(defaultScan, "already-cleaned");
			expect(defaultAlreadyGroup).toBeTruthy();
			expect(defaultAlreadyGroup.sampleItems).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				status: "already-cleaned",
				reason: "already-cleaned",
			}));

			const diagnosticScan = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			const diagnosticSession = findArchivedSession(diagnosticScan, seeded.session.id);
			expect(diagnosticSession).toBeTruthy();
			expect(diagnosticSession.worktrees).toHaveLength(1);
			const item = diagnosticSession.worktrees[0];
			expect(item).toMatchObject({
				status: "already-cleaned",
				reason: "already-cleaned",
				disposition: "already-cleaned",
				reasonCategory: "already-cleaned",
				actionable: false,
				selectable: false,
				defaultSelected: false,
				pathExists: false,
				gitWorktreeMetadataExists: false,
				localBranchExists: true,
				willDeleteBranch: false,
			});

			const cleanup = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
				method: "POST",
				body: JSON.stringify({
					mode: "selected",
					worktrees: [{ sessionId: seeded.session.id, key: item.key }],
				}),
			});
			expect(cleanup.status).toBe(200);
			const cleanupBody = await cleanup.json();
			expectArchivedCleanupShape(cleanupBody);
			expect(cleanupBody.counts).toMatchObject({
				requested: 1,
				cleaned: 0,
				branchDeleted: 0,
				worktreeRemoved: 0,
				invalidSelection: 0,
				notActionable: 0,
				failed: 0,
				alreadyCleaned: 1,
			});
			expect(cleanupBody.counts.byStatus["already-cleaned"]).toBe(1);
			expect(cleanupBody.counts.byReason["already-cleaned"]).toBe(1);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				key: item.key,
				repo: ".",
				repoPath,
				path: missingWorktreePath,
				branch,
				status: "already-cleaned",
				reason: "already-cleaned",
				worktreeRemoved: false,
				branchDeleted: false,
			}));
			expect(branchExists(repoPath, branch)).toBe(true);
		} finally {
			if (seeded) seeded.ctx.sessionStore.remove(seeded.session.id);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("branch deletion is blocked when another archived record in the same repo references the branch", async ({ gateway }) => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-archived-branch-guard-"));
		const repoPath = join(baseDir, "repo");
		const removablePath = join(baseDir, "removable-worktree");
		const alreadyCleanedPath = join(baseDir, "already-cleaned-worktree");
		const branch = `archived-branch-guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let removable: SeededSession | undefined;
		let archivedReference: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			git(repoPath, ["worktree", "add", "-b", branch, removablePath, "HEAD"]);
			removable = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived removable with shared branch",
				cwd: removablePath,
				repoPath,
				worktreePath: removablePath,
				branch,
			});
			archivedReference = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived already cleaned branch reference",
				cwd: alreadyCleanedPath,
				repoPath,
				worktreePath: alreadyCleanedPath,
				branch,
			});

			const before = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			const candidate = findArchivedWorktreeItem(before, removable.session.id);
			expect(candidate).toMatchObject({
				status: "removable",
				localBranchExists: true,
				willDeleteBranch: false,
				branchDeleteBlockedReason: "branch-referenced-by-archived-record",
			});
			expect(findArchivedWorktreeItem(before, archivedReference.session.id)).toMatchObject({ status: "already-cleaned", branch });

			const cleanup = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
				method: "POST",
				body: JSON.stringify({ mode: "all" }),
			});
			expect(cleanup.status).toBe(200);
			const cleanupBody = await cleanup.json();
			expectArchivedCleanupShape(cleanupBody);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: removable.session.id,
				status: "cleaned",
				worktreeRemoved: true,
				branchDeleted: false,
			}));
			expect(branchExists(repoPath, branch)).toBe(true);
		} finally {
			if (removable) removable.ctx.sessionStore.remove(removable.session.id);
			if (archivedReference) archivedReference.ctx.sessionStore.remove(archivedReference.session.id);
			tryRemoveWorktree(repoPath, removablePath);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("stale archived paths do not inherit git metadata from another worktree on the same branch", async ({ gateway }) => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-branch-assoc-"));
		const repoPath = join(baseDir, "repo");
		const worktreeBasename = "same-basename-worktree";
		const activeWorktreePath = join(baseDir, "active", worktreeBasename);
		const missingWorktreePath = join(baseDir, "missing", worktreeBasename);
		const branch = `archived-branch-assoc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			mkdirSync(dirname(activeWorktreePath), { recursive: true });
			mkdirSync(dirname(missingWorktreePath), { recursive: true });
			git(repoPath, ["worktree", "add", "-b", branch, activeWorktreePath, "HEAD"]);
			expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(activeWorktreePath));
			expect(existsSync(missingWorktreePath)).toBe(false);

			seeded = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived stale path sharing another branch",
				cwd: missingWorktreePath,
				repoPath,
				worktreePath: missingWorktreePath,
				branch,
			});

			const diagnosticScan = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			const diagnosticSession = findArchivedSession(diagnosticScan, seeded.session.id);
			expect(diagnosticSession).toBeTruthy();
			const item = diagnosticSession.worktrees[0];
			expect.soft(item).toMatchObject({
				status: "already-cleaned",
				pathExists: false,
				gitWorktreeMetadataExists: false,
				localBranchExists: true,
				willDeleteBranch: false,
			});

			const cleanup = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
				method: "POST",
				body: JSON.stringify({
					mode: "selected",
					worktrees: [{ sessionId: seeded.session.id, key: item.key }],
				}),
			});
			expect(cleanup.status).toBe(200);
			const cleanupBody = await cleanup.json();
			expectArchivedCleanupShape(cleanupBody);
			expect(cleanupBody.counts.cleaned).toBe(0);
			expect(cleanupBody.counts.branchDeleted).toBe(0);
			expect(cleanupBody.counts.alreadyCleaned).toBe(1);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				key: item.key,
				status: "already-cleaned",
				worktreeRemoved: false,
				branchDeleted: false,
			}));

			expect(existsSync(activeWorktreePath)).toBe(true);
			expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(activeWorktreePath));
			expect(branchExists(repoPath, branch)).toBe(true);
			git(activeWorktreePath, ["status", "--short"]);
		} finally {
			if (seeded) seeded.ctx.sessionStore.remove(seeded.session.id);
			tryRemoveWorktree(repoPath, activeWorktreePath);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("stale existing directories with colliding basenames are non-actionable", async ({ gateway }) => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-stale-dir-"));
		const repoPath = join(baseDir, "repo");
		const worktreeBasename = "same-basename-worktree";
		const activeWorktreePath = join(baseDir, "active", worktreeBasename);
		const staleWorktreePath = join(baseDir, "stale", worktreeBasename);
		const branch = `archived-stale-dir-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			mkdirSync(dirname(activeWorktreePath), { recursive: true });
			git(repoPath, ["worktree", "add", "-b", branch, activeWorktreePath, "HEAD"]);
			mkdirSync(staleWorktreePath, { recursive: true });
			expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(activeWorktreePath));

			seeded = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived stale existing path",
				cwd: staleWorktreePath,
				repoPath,
				worktreePath: staleWorktreePath,
				branch,
			});

			const scan = await getArchivedWorktreeScan();
			const scannedSession = findArchivedSession(scan, seeded.session.id);
			expect(scannedSession).toBeTruthy();
			const item = scannedSession.worktrees[0];
			expect(item).toMatchObject({
				status: "skipped",
				reason: "stale-worktree-directory",
				disposition: "needs-attention",
				reasonCategory: "stale-path",
				actionable: false,
				selectable: false,
				defaultSelected: false,
				pathExists: true,
				gitWorktreeMetadataExists: false,
				localBranchExists: true,
				willDeleteBranch: false,
			});

			const cleanup = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
				method: "POST",
				body: JSON.stringify({
					mode: "selected",
					worktrees: [{ sessionId: seeded.session.id, key: item.key }],
				}),
			});
			expect(cleanup.status).toBe(200);
			const cleanupBody = await cleanup.json();
			expectArchivedCleanupShape(cleanupBody);
			expect(cleanupBody.counts).toMatchObject({ cleaned: 0, branchDeleted: 0, skipped: 1, notActionable: 1, failed: 0 });
			expect(cleanupBody.counts.byReason["stale-worktree-directory"]).toBe(1);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				key: item.key,
				repo: ".",
				repoPath,
				path: staleWorktreePath,
				branch,
				status: "skipped",
				reason: "stale-worktree-directory",
				worktreeRemoved: false,
				branchDeleted: false,
			}));

			expect(existsSync(staleWorktreePath)).toBe(true);
			expect(existsSync(activeWorktreePath)).toBe(true);
			expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(activeWorktreePath));
			expect(branchExists(repoPath, branch)).toBe(true);
			git(activeWorktreePath, ["status", "--short"]);
		} finally {
			if (seeded) seeded.ctx.sessionStore.remove(seeded.session.id);
			tryRemoveWorktree(repoPath, activeWorktreePath);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("worktree key selectors must match the supplied session id", async ({ gateway }) => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-key-session-"));
		const repoPath = join(baseDir, "repo");
		const worktreePath = join(baseDir, "worktree");
		const branch = `archived-key-session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			git(repoPath, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
			seeded = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived key/session mismatch candidate",
				cwd: worktreePath,
				repoPath,
				worktreePath,
				branch,
			});

			const scan = await getArchivedWorktreeScan();
			const scannedSession = findArchivedSession(scan, seeded.session.id);
			expect(scannedSession).toBeTruthy();
			const item = scannedSession.worktrees[0];
			expect(item.status).toBe("removable");

			const cleanup = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
				method: "POST",
				body: JSON.stringify({
					mode: "selected",
					worktrees: [{ sessionId: `${seeded.session.id}-wrong`, key: item.key, repo: item.repo, path: item.path }],
				}),
			});
			expect(cleanup.status).toBe(200);
			const cleanupBody = await cleanup.json();
			expectArchivedCleanupShape(cleanupBody);
			expect(cleanupBody.counts).toMatchObject({ requested: 1, cleaned: 0, branchDeleted: 0, skipped: 1, invalidSelection: 1, failed: 0 });
			expect(cleanupBody.counts.byReason["invalid-selection"]).toBe(1);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				key: item.key,
				sessionId: `${seeded.session.id}-wrong`,
				status: "skipped",
				reason: "invalid-selection",
				worktreeRemoved: false,
				branchDeleted: false,
			}));
			expect(existsSync(worktreePath)).toBe(true);
			expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(worktreePath));
			expect(branchExists(repoPath, branch)).toBe(true);
		} finally {
			if (seeded) seeded.ctx.sessionStore.remove(seeded.session.id);
			tryRemoveWorktree(repoPath, worktreePath);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("mode all cleans only safe candidates and leaves ineligible archived records untouched", async ({ gateway }) => {
		test.slow();
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-all-guard-"));
		const repoPath = join(baseDir, "repo");
		const removablePath = join(baseDir, "all-removable-worktree");
		const liveReferencedPath = join(baseDir, "all-live-referenced-worktree");
		const stalePath = join(baseDir, "all-stale-directory");
		const alreadyCleanedPath = join(baseDir, "all-already-cleaned");
		const removableBranch = `archived-all-removable-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const liveBranch = `archived-all-live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const staleBranch = `archived-all-stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const alreadyBranch = `archived-all-already-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const seeded: SeededSession[] = [];
		let liveSessionId: string | undefined;
		try {
			initGitRepo(repoPath);
			git(repoPath, ["worktree", "add", "-b", removableBranch, removablePath, "HEAD"]);
			git(repoPath, ["worktree", "add", "-b", liveBranch, liveReferencedPath, "HEAD"]);
			git(repoPath, ["branch", staleBranch, "HEAD"]);
			git(repoPath, ["branch", alreadyBranch, "HEAD"]);
			mkdirSync(stalePath, { recursive: true });

			const removable = await seedArchivedSession(gateway, { baseDir, title: "All removable", cwd: removablePath, repoPath, worktreePath: removablePath, branch: removableBranch });
			const liveReferenced = await seedArchivedSession(gateway, { baseDir, title: "All live referenced", cwd: liveReferencedPath, repoPath, worktreePath: liveReferencedPath, branch: liveBranch });
			const sandbox = await seedArchivedSession(gateway, { baseDir, title: "All sandbox", cwd: "/workspace-wt/session/all-sandbox", repoPath, worktreePath: "/workspace-wt/session/all-sandbox", branch: "all-sandbox", sandboxed: true });
			const stale = await seedArchivedSession(gateway, { baseDir, title: "All stale", cwd: stalePath, repoPath, worktreePath: stalePath, branch: staleBranch });
			const alreadyCleaned = await seedArchivedSession(gateway, { baseDir, title: "All already cleaned", cwd: alreadyCleanedPath, repoPath, worktreePath: alreadyCleanedPath, branch: alreadyBranch });
			seeded.push(removable, liveReferenced, sandbox, stale, alreadyCleaned);
			liveSessionId = `live-all-guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			removable.ctx.sessionStore.put({
				id: liveSessionId,
				title: "Live guard for clean all",
				cwd: liveReferencedPath,
				agentSessionFile: join(baseDir, `${liveSessionId}.jsonl`),
				createdAt: Date.now(),
				lastActivity: Date.now(),
				archived: false,
				projectId: removable.projectId,
				repoPath,
				worktreePath: liveReferencedPath,
				branch: liveBranch,
			});

			const before = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			expect(findArchivedWorktreeItem(before, removable.session.id)).toMatchObject({ status: "removable", actionable: true });
			expect(findArchivedWorktreeItem(before, liveReferenced.session.id)).toMatchObject({ status: "skipped", reason: "referenced-by-live-session", actionable: false });
			expect(findArchivedWorktreeItem(before, sandbox.session.id)).toMatchObject({ status: "skipped", reason: "sandbox-container-path", actionable: false });
			expect(findArchivedWorktreeItem(before, stale.session.id)).toMatchObject({ status: "skipped", reason: "stale-worktree-directory", actionable: false });
			expect(findArchivedWorktreeItem(before, alreadyCleaned.session.id)).toMatchObject({ status: "already-cleaned", reason: "already-cleaned", actionable: false });

			const cleanup = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
				method: "POST",
				body: JSON.stringify({ mode: "all" }),
			});
			expect(cleanup.status).toBe(200);
			const cleanupBody = await cleanup.json();
			expectArchivedCleanupShape(cleanupBody);
			expect(cleanupBody.counts).toMatchObject({ cleaned: 1, branchDeleted: 1, worktreeRemoved: 1, invalidSelection: 0, notActionable: 0, failed: 0 });
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: removable.session.id,
				status: "cleaned",
				path: removablePath,
				branch: removableBranch,
				worktreeRemoved: true,
				branchDeleted: true,
			}));
			expect(cleanupBody.results.some((result: any) => [liveReferenced.session.id, sandbox.session.id, stale.session.id, alreadyCleaned.session.id].includes(result.sessionId))).toBe(false);

			expect(existsSync(removablePath)).toBe(false);
			expect(branchExists(repoPath, removableBranch)).toBe(false);
			expect(existsSync(liveReferencedPath)).toBe(true);
			expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(liveReferencedPath));
			expect(existsSync(stalePath)).toBe(true);
			expect(branchExists(repoPath, liveBranch)).toBe(true);
			expect(branchExists(repoPath, staleBranch)).toBe(true);
			expect(branchExists(repoPath, alreadyBranch)).toBe(true);

			const after = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			expect(findArchivedWorktreeItem(after, removable.session.id)).toMatchObject({ status: "already-cleaned", reason: "already-cleaned" });
			expect(findArchivedWorktreeItem(after, liveReferenced.session.id)).toMatchObject({ status: "skipped", reason: "referenced-by-live-session" });
			expect(findArchivedWorktreeItem(after, sandbox.session.id)).toMatchObject({ status: "skipped", reason: "sandbox-container-path" });
			expect(findArchivedWorktreeItem(after, stale.session.id)).toMatchObject({ status: "skipped", reason: "stale-worktree-directory" });
		} finally {
			if (liveSessionId && seeded[0]) seeded[0].ctx.sessionStore.remove(liveSessionId);
			for (const seed of seeded) seed.ctx.sessionStore.remove(seed.session.id);
			tryRemoveWorktree(repoPath, removablePath);
			tryRemoveWorktree(repoPath, liveReferencedPath);
			for (const branch of [removableBranch, liveBranch, staleBranch, alreadyBranch]) tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("sandbox container paths are skipped instead of treated as host worktrees", async ({ gateway }) => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-sandbox-"));
		const repoPath = join(baseDir, "repo");
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			seeded = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived sandbox worktree",
				cwd: "/workspace-wt/session/archived-sandbox",
				repoPath,
				worktreePath: "/workspace-wt/session/archived-sandbox",
				branch: "archived-sandbox-branch",
				sandboxed: true,
			});

			const scan = await getArchivedWorktreeScan();
			const scannedSession = findArchivedSession(scan, seeded.session.id);
			expect(scannedSession).toBeTruthy();
			expect(scannedSession.sandboxed).toBe(true);
			expect(scannedSession.worktrees).toHaveLength(1);
			const item = scannedSession.worktrees[0];
			expect(item).toMatchObject({
				sessionId: seeded.session.id,
				path: "/workspace-wt/session/archived-sandbox",
				status: "skipped",
				reason: "sandbox-container-path",
				disposition: "ineligible",
				reasonCategory: "container-path",
				actionable: false,
				selectable: false,
				willDeleteBranch: false,
			});

			const cleanup = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
				method: "POST",
				body: JSON.stringify({
					mode: "selected",
					worktrees: [{ sessionId: seeded.session.id, key: item.key }],
				}),
			});
			expect(cleanup.status).toBe(200);
			const cleanupBody = await cleanup.json();
			expectArchivedCleanupShape(cleanupBody);
			expect(cleanupBody.counts).toMatchObject({ cleaned: 0, skipped: 1, notActionable: 1, failed: 0 });
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				key: item.key,
				status: "skipped",
				reason: "sandbox-container-path",
				worktreeRemoved: false,
				branchDeleted: false,
			}));
		} finally {
			if (seeded) seeded.ctx.sessionStore.remove(seeded.session.id);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("multi-repo archived sessions expose one worktree row per repoWorktrees entry", async ({ gateway }) => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-multirepo-"));
		const repoPath = join(baseDir, "repo");
		const packageRepoPath = join(repoPath, "packages", "api");
		const branch = `archived-multirepo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			mkdirSync(packageRepoPath, { recursive: true });
			initGitRepo(packageRepoPath);
			git(repoPath, ["branch", branch, "HEAD"]);
			git(packageRepoPath, ["branch", branch, "HEAD"]);
			seeded = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived multi-repo worktree",
				cwd: join(baseDir, "container"),
				repoPath,
				worktreePath: join(baseDir, "container"),
				repoWorktrees: {
					".": join(baseDir, "missing-root-worktree"),
					"packages/api": join(baseDir, "missing-api-worktree"),
				},
				branch,
			});

			const scan = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			const scannedSession = findArchivedSession(scan, seeded.session.id);
			expect(scannedSession).toBeTruthy();
			expect(scannedSession.worktrees).toHaveLength(2);
			const byRepo = new Map(scannedSession.worktrees.map((item: any) => [item.repo, item]));
			expect(byRepo.get(".")).toMatchObject({
				title: "Archived multi-repo worktree",
				repo: ".",
				repoPath,
				repoDisplayName: expect.any(String),
				path: join(baseDir, "missing-root-worktree"),
				branch,
				source: "repoWorktrees",
				status: "already-cleaned",
				reason: "already-cleaned",
				disposition: "already-cleaned",
				reasonCategory: "already-cleaned",
				localBranchExists: true,
			});
			expect(byRepo.get(".").selectionCategories).toEqual(expect.arrayContaining(["archived-session", "multi-repo"]));
			expect(byRepo.get("packages/api")).toMatchObject({
				title: "Archived multi-repo worktree",
				repo: "packages/api",
				repoPath: packageRepoPath,
				repoDisplayName: expect.any(String),
				path: join(baseDir, "missing-api-worktree"),
				branch,
				source: "repoWorktrees",
				status: "already-cleaned",
				reason: "already-cleaned",
				disposition: "already-cleaned",
				reasonCategory: "already-cleaned",
				localBranchExists: true,
			});
			expect(byRepo.get("packages/api").selectionCategories).toEqual(expect.arrayContaining(["archived-session", "multi-repo"]));
		} finally {
			if (seeded) seeded.ctx.sessionStore.remove(seeded.session.id);
			tryDeleteBranch(repoPath, branch);
			tryDeleteBranch(packageRepoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("scan skips archived worktree paths still referenced by a live session", async ({ gateway }) => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-guard-"));
		const repoPath = join(baseDir, "repo");
		const sharedWorktreePath = join(baseDir, "shared-worktree");
		let seeded: SeededSession | undefined;
		let liveSessionId: string | undefined;
		try {
			initGitRepo(repoPath);
			mkdirSync(sharedWorktreePath, { recursive: true });
			seeded = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived guarded worktree",
				cwd: sharedWorktreePath,
				repoPath,
				worktreePath: sharedWorktreePath,
				branch: "archived-guarded-branch",
			});
			liveSessionId = `live-guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			seeded.ctx.sessionStore.put({
				id: liveSessionId,
				title: "Live session sharing archived worktree path",
				cwd: sharedWorktreePath,
				agentSessionFile: join(baseDir, `${liveSessionId}.jsonl`),
				createdAt: Date.now(),
				lastActivity: Date.now(),
				archived: false,
				projectId: seeded.projectId,
				repoPath,
				worktreePath: sharedWorktreePath,
				branch: "live-guard-branch",
			});

			const scan = await getArchivedWorktreeScan();
			const scannedSession = findArchivedSession(scan, seeded.session.id);
			expect(scannedSession).toBeTruthy();
			expect(scannedSession.worktrees).toHaveLength(1);
			expect(scannedSession.worktrees[0]).toMatchObject({
				sessionId: seeded.session.id,
				path: sharedWorktreePath,
				pathExists: true,
				status: "skipped",
				reason: "referenced-by-live-session",
				disposition: "ineligible",
				reasonCategory: "referenced-record",
				actionable: false,
				selectable: false,
				willDeleteBranch: false,
			});
		} finally {
			if (liveSessionId && seeded) seeded.ctx.sessionStore.remove(liveSessionId);
			if (seeded) seeded.ctx.sessionStore.remove(seeded.session.id);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Integration: create a session, terminate (archive) it, check expired-archives
// ---------------------------------------------------------------------------
test("expired archives stats reflect archived sessions", async () => {
	// Create and immediately terminate a session (which archives it)
	const sessionId = await createSession();
	await deleteSession(sessionId);

	// Get expired archive stats — newly archived session shouldn't be expired (< 7 days old)
	const statsResp = await apiFetch("/api/maintenance/expired-archives");
	expect(statsResp.status).toBe(200);
	const stats = await statsResp.json();
	// Fresh archive should NOT be expired — count should stay at 0 in clean test env
	expect(stats.count).toBe(0);
});
