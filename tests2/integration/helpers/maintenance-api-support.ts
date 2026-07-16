/**
 * E2E tests for the /api/maintenance/* endpoints.
 *
 * Tests Phase 1 (no auto-cleanup on restart) and Phase 4a (maintenance REST API).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandRunner } from "../../../src/server/gateway-deps.js";
import { copyGitTemplate } from "../../harness/git-template.js";
import { test, expect } from "../_e2e/in-process-harness.js";
import { readE2EToken, apiFetch as gatewayApiFetch, createSession, deleteSession, registerProject } from "../_e2e/e2e-setup.js";
import { MaintenanceGitModel } from "./maintenance-git-model.js";

export let maintenanceGateway: any;
export function gateway(): any {
	if (!maintenanceGateway) throw new Error("maintenance fixture gateway is not ready");
	return maintenanceGateway;
}
let maintenanceProjectId: string;
let maintenanceProjectContext: any;
export const maintenanceGit = new MaintenanceGitModel();

type PersistenceInstallation = {
	original: () => void;
	replacement: () => void;
	leases: Set<symbol>;
};
type MaintenanceHookGlobalState = {
	persistenceInstallations: WeakMap<object, PersistenceInstallation>;
};
const MAINTENANCE_HOOK_STATE_KEY = Symbol.for("bobbit.tests2.maintenance-api-support.hooks");

function maintenanceHookState(): MaintenanceHookGlobalState {
	const scope = globalThis as typeof globalThis & { [MAINTENANCE_HOOK_STATE_KEY]?: MaintenanceHookGlobalState };
	return scope[MAINTENANCE_HOOK_STATE_KEY] ??= { persistenceInstallations: new WeakMap() };
}

function suppressSessionStorePersistence(sessionStore: { saveNow?: () => void }): () => void {
	if (typeof sessionStore.saveNow !== "function") return () => {};
	const state = maintenanceHookState();
	let installation = state.persistenceInstallations.get(sessionStore);
	if (!installation) {
		installation = { original: sessionStore.saveNow, replacement: () => {}, leases: new Set() };
		state.persistenceInstallations.set(sessionStore, installation);
	}
	if (sessionStore.saveNow !== installation.replacement) {
		installation.original = sessionStore.saveNow;
		sessionStore.saveNow = installation.replacement;
	}
	const lease = Symbol("maintenance-session-store-persistence-lease");
	installation.leases.add(lease);
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		installation!.leases.delete(lease);
		if (installation!.leases.size > 0) return;
		if (sessionStore.saveNow === installation!.replacement) sessionStore.saveNow = installation!.original;
		if (state.persistenceInstallations.get(sessionStore) === installation) state.persistenceInstallations.delete(sessionStore);
	};
}

/** Buffer every real HTTP response before returning it so fixture teardown cannot race an open body. */
async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	const response = await gatewayApiFetch(path, opts);
	const body = await response.arrayBuffer();
	return new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

export function registerMaintenanceHooks(): void {
	let restoreCommandRunner: (() => void) | undefined;
	let restoreSessionStorePersistence: (() => void) | undefined;

	test.beforeAll(({ gateway }) => {
		maintenanceGit.reset();
		readE2EToken();
		maintenanceGateway = gateway;
		maintenanceProjectId = gateway.defaultProjectId;
		maintenanceProjectContext = gateway.projectContextManager.getOrCreate(maintenanceProjectId);
		if (!maintenanceProjectId || !maintenanceProjectContext) throw new Error("maintenance fixture requires the stable default project context");
		const commandRunner = (gateway.sessionManager as { commandRunner?: CommandRunner }).commandRunner;
		if (!commandRunner) throw new Error("maintenance fixture requires the gateway command-runner seam");
		restoreCommandRunner = maintenanceGit.install(commandRunner);
		const sessionStore = maintenanceProjectContext.sessionStore as { saveNow?: () => void };
		restoreSessionStorePersistence = suppressSessionStorePersistence(sessionStore);
	});

	test.afterAll(() => {
		restoreSessionStorePersistence?.();
		restoreCommandRunner?.();
		maintenanceGit.reset();
	});
}

export type SeededSession = {
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
	return maintenanceGit.run(repoPath, args).trim();
}

function branchExists(repoPath: string, branch: string): boolean {
	return maintenanceGit.branchExists(repoPath, branch);
}

function normalizeTestPath(path: string): string {
	return path.replace(/\\/g, "/").toLowerCase();
}

function listedWorktreePaths(repoPath: string): string[] {
	return maintenanceGit.listedWorktreePaths(repoPath).map(normalizeTestPath);
}

/** Seed Git bytes only where the template contract matters; command decisions stay in-memory. */
function initGitRepo(path: string, copyTemplate = false): void {
	if (copyTemplate) {
		copyGitTemplate(path);
	} else {
		mkdirSync(join(path, ".git"), { recursive: true });
		writeFileSync(join(path, "README.md"), "# maintenance fixture\n");
	}
	maintenanceGit.registerRepo(path);
}

function tryRemoveWorktree(repoPath: string, worktreePath: string): void {
	maintenanceGit.removeWorktree(repoPath, worktreePath);
}

function tryDeleteBranches(repoPath: string, branches: string[]): void {
	maintenanceGit.deleteBranches(repoPath, branches);
}

function tryDeleteBranch(repoPath: string, branch: string): void {
	tryDeleteBranches(repoPath, [branch]);
}

type ArchivedSessionOverrides = Partial<any> & { id?: string; title?: string; baseDir?: string };

/** Keep ephemeral maintenance records in memory; persistence is covered by SessionStore tests. */
function batchSessionStoreMutations(ctx: any, mutate: (store: any) => void): void {
	const store = ctx.sessionStore as any;
	const saveNow = store.saveNow;
	if (typeof saveNow !== "function") {
		mutate(store);
		return;
	}
	store.saveNow = () => {};
	try {
		mutate(store);
	} finally {
		store.saveNow = saveNow;
	}
}

function buildArchivedSession(overrides: ArchivedSessionOverrides = {}): SeededSession {
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
		projectId: maintenanceProjectId,
		...overrides,
	};
	delete session.baseDir;
	return { ctx: maintenanceProjectContext, session, projectId: maintenanceProjectId };
}

function seedArchivedSessions(gateway: any, overrides: ArchivedSessionOverrides[]): SeededSession[] {
	if (gateway !== maintenanceGateway || gateway.defaultProjectId !== maintenanceProjectId) {
		throw new Error("maintenance fixture gateway/default project identity changed during the suite");
	}
	const seeded = overrides.map(buildArchivedSession);
	batchSessionStoreMutations(maintenanceProjectContext, store => {
		for (const seed of seeded) store.put(seed.session);
	});
	return seeded;
}

async function seedArchivedSession(gateway: any, overrides: ArchivedSessionOverrides = {}): Promise<SeededSession> {
	return seedArchivedSessions(gateway, [overrides])[0];
}

function restoreSeededSessions(seeded: SeededSession[]): void {
	if (seeded.length === 0) return;
	batchSessionStoreMutations(maintenanceProjectContext, store => {
		for (const seed of seeded) store.put(seed.session);
	});
}

function removeSeededSessions(seeded: SeededSession[], extraSessionIds: Array<string | undefined> = []): void {
	const ids = [...seeded.map(seed => seed.session.id), ...extraSessionIds.filter((id): id is string => !!id)];
	if (ids.length === 0) return;
	batchSessionStoreMutations(maintenanceProjectContext, store => {
		for (const id of ids) store.remove(id);
	});
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


export {
	test, expect, registerProject, createSession, deleteSession,
	existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
	tmpdir, dirname, join,
	apiFetch, expectNumberCounts, expectNumberMap,
	expectArchivedScanShape, expectArchivedCleanupShape,
	git, branchExists, normalizeTestPath, listedWorktreePaths, initGitRepo,
	tryRemoveWorktree, tryDeleteBranches, tryDeleteBranch,
	seedArchivedSessions, seedArchivedSession, restoreSeededSessions, removeSeededSessions,
	findArchivedSession, findArchivedWorktreeItem, findArchivedWorktreeGroup,
	getArchivedWorktreeScan,
};
