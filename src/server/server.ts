import { exec, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import { fileURLToPath } from "node:url";
import { bobbitStateDir, bobbitConfigDir, getProjectRoot } from "./bobbit-dir.js";
import { isSetupComplete } from "./setup-status.js";
export { isSetupComplete };
import { WebSocketServer } from "ws";
import { ColorStore } from "./agent/color-store.js";
import { PrStatusStore } from "./agent/pr-status-store.js";
import { SessionManager } from "./agent/session-manager.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { validateToken } from "./auth/token.js";
import { oauthComplete, oauthFlowStatus, oauthStart, oauthStatus } from "./auth/oauth.js";
import { handleWebSocketConnection } from "./ws/handler.js";
import { paceAndSend, PACE_TIMEOUT_MS } from "./replay-pacing.js";
import { discoverSlashSkills, getSkillDirectories, getSlashSkill, buildSlashSkillPrompt } from "./skills/slash-skills.js";
import { TeamManager, GateDependencyError } from "./agent/team-manager.js";
import { tryHandleNestedGoalRoute, listDescendants } from "./agent/nested-goal-routes.js";
import { walkGoalSubtree, cascadeSubtree as cascadeGoalSubtree } from "./agent/goal-subtree.js";
import { computeTreeCost } from "./agent/cost-tracker.js";
import { collectDescendants } from "./agent/goal-descendants.js";
import type { Workflow } from "./agent/workflow-store.js";
import { buildDefaultWorkflows, buildParentWorkflow } from "./state-migration/seed-default-workflows.js";
import { readSubgoalNestingPrefs } from "./agent/subgoal-nesting-limit.js";
import { checkGateDependencies } from "./agent/gate-dependency-check.js";
import { shouldCreateWorktree } from "./agent/worktree-decision.js";
import { RoleStore } from "./agent/role-store.js";
import { RoleManager } from "./agent/role-manager.js";
import { ToolManager, copyDirRecursive } from "./agent/tool-manager.js";

import { getPromptSections, initPromptDirs, loadPersistedPromptSections } from "./agent/system-prompt.js";
import { recordElapsed } from "./agent/profiling.js";
import { resolveGrantPolicy } from "./agent/tool-activation.js";
import { parseMcpToolName } from "./mcp/mcp-meta.js";
import { initSkillSidecarDir } from "./skills/skill-sidecar.js";
import {
	initCompactionSidecarDir,
	findCompactionSidecarEntry,
} from "./agent/compaction-sidecar.js";
import { readOrphanedBeforeCompaction } from "./agent/transcript-reader.js";
import { buildActivationHeader } from "./skills/skill-manifest.js";
import type { TaskState } from "./agent/task-store.js";
import { TaskManager } from "./agent/task-manager.js";
import { TaskStore } from "./agent/task-store.js";
import { BgProcessManager } from "./agent/bg-process-manager.js";
import { sessionFileRead, type SessionFsContext } from "./agent/session-fs.js";
import { readTranscript, TranscriptReaderError } from "./agent/transcript-reader.js";

import { isGitRepo, getRepoRoot, shouldSkipRemotePush, stripTokenFromGitUrl, detectPrimaryBranch } from "./skills/git.js";
// Helper used by PUT /api/projects/:id/config to validate `base_ref` branch grammar.
// Mirrors git's `check-ref-format` predicate in pure JS so the API can respond
// without an exec round-trip. See docs/design/base-ref.md.
function isValidBaseRefBranchGrammar(name: string): boolean {
	if (!name) return false;
	if (/\s/.test(name)) return false;
	if (name.startsWith("-") || name.endsWith(".")) return false;
	if (name.includes("..") || name.includes("@{")) return false;
	if (/[\x00-\x1f\x7f~^:?*\[\\]/.test(name)) return false;
	return /^[A-Za-z0-9_./-]+$/.test(name);
}
import { runBatchGitStatusNative } from "./skills/git-status-native.js";
import { VerificationHarness, goalBranchContainer } from "./agent/verification-harness.js";
import { validateAnswers, crossValidate, type UserQuestion } from "./agent/ask-user-choices-validation.js";
import { buildAskResponseEnvelope, findAskResponseAnswers } from "../shared/ask-envelope.js";
import { clampThinkingLevel, isKnownThinkingLevel } from "../shared/thinking-levels.js";

// In-memory dedup guard for ask_user_choices /submit. Keyed by
// `${sessionId}::${toolUseId}`. Populated synchronously before enqueuing the
// response envelope so a concurrent duplicate /submit returns alreadySubmitted
// even when the transcript hasn't yet reflected the first envelope.
// Entries are also refilled from the transcript check, so survive process
// restarts via the transcript fallback in findAskResponseAnswers.
const askSubmittedToolUseIds = new Set<string>();
import { inlineFileImages } from "./agent/inline-file-images.js";
import { StaffManager } from "./agent/staff-manager.js";
import { TriggerEngine } from "./agent/staff-trigger-engine.js";
import { PreferencesStore } from "./agent/preferences-store.js";
import { ProjectConfigStore } from "./agent/project-config-store.js";
import { ToolGroupPolicyStore } from "./agent/tool-group-policy-store.js";
import { getAllConfigDirectories, removeBuiltinDirectory, resetConfigDirectories } from "./agent/config-directories.js";
import { checkDockerAvailability, buildSandboxImage, isBuildingImage, ensureImageAgentVersion } from "./agent/sandbox-status.js";
import { SandboxManager, type SandboxBootstrap } from "./agent/sandbox-manager.js";
import { validateSandboxMounts } from "./agent/sandbox-mounts.js";
import { SandboxTokenStore, type SandboxScope } from "./auth/sandbox-token.js";
import { CookieStore, issueIfMissing as issueCookieIfMissing, tryAuth as cookieTryAuth } from "./auth/cookie.js";
import { handlePreviewRequest } from "./preview/content-route.js";
import { progressBus as searchProgressBus } from "./search/progress-bus.js";
import { isSandboxAllowed } from "./auth/sandbox-guard.js";
import * as previewMount from "./preview/mount.js";
import { broadcastPreviewChanged, subscribePreviewChanged } from "./preview/events.js";
import { configureAigw, removeAigw, getAigwUrl, discoverAigwModels, proxyRequest, startupAigwCheck, writeContextWindowOverrides, inferMeta } from "./agent/aigw-manager.js";
import { writeOpenAIModelAdditions } from "./agent/openai-model-additions.js";
import { ReviewAnnotationStore, type ReviewAnnotation } from "./review-annotation-store.js";
import { getAvailableModels, discoverModelsForConfig, invalidateModelCache } from "./agent/model-registry.js";
import type { CustomProviderConfig } from "./agent/model-registry.js";
import { canonicalImageModelPref, defaultImageModelPref, generateImage, getAvailableImageModels, imageModelMentionedInText } from "./agent/image-generation.js";
import { ProjectRegistry, SymlinkProjectRootError, PreflightFailedError, SYSTEM_PROJECT_ID } from "./agent/project-registry.js";
import { runPreflight } from "./agent/project-preflight.js";
import { archiveProjectBobbitDir, ArchiveError } from "./agent/bobbit-archive.js";
import { ProjectContextManager } from "./agent/project-context-manager.js";
import { resolveProjectForRequest } from "./agent/resolve-project.js";
import { GoalManager } from "./agent/goal-manager.js";
import { detectHostTokens, resolveHostTokenValue } from "./agent/host-tokens.js";
import type { PersistedGoal } from "./agent/goal-store.js";
import { migrateToPerProjectState, recoverPreMigrationData } from "./agent/state-migration.js";
import { migrateAllProjects as migrateAllProjectYaml } from "./state-migration/migrate-project-yaml.js";
import { resolveScalarConfig } from "./agent/config-resolver.js";
import { BuiltinConfigProvider } from "./agent/builtin-config.js";
import { ConfigCascade } from "./agent/config-cascade.js";
import { LspSupervisor } from "./lsp/supervisor.js";
import { TypescriptLspFactory } from "./lsp/clients/typescript.js";
import { PyrightLspFactory } from "./lsp/clients/pyright.js";
import { MultiProjectSandboxLspBridge } from "./lsp/sandbox-bridge.js";
import { registerWorktreePreCleanupHook } from "./lsp/cleanup-hook.js";

import { initAssistantRegistry } from "./agent/assistant-registry.js";
import {
	deleteProposalFile,
	editProposalFile,
	isProposalType,
	latestRev,
	listProposalFiles,
	parseProposalFile,
	readProposalFile,
	restoreSnapshot,
	writeProposalFile,
	type ProposalType,
} from "./proposals/proposal-files.js";

const VALID_TASK_STATES = new Set<string>(["todo", "in-progress", "blocked", "complete", "skipped"]);

const execAsync = promisify(exec);
const execFileAsync = promisify(execFileCb);

/**
 * Delete remote branches associated with a goal (integration + agent worktree branches).
 * Fire-and-forget — errors are logged but never block the archive flow.
 */
/**
 * Clamp a thinking-level token against a role's pinned model (if any).
 * - Validates that the token is in the canonical set; returns undefined otherwise.
 * - When `modelStr` is set in canonical `provider/modelId` form, clamps the
 *   level against that model's inferred reasoning/family.
 * - When `modelStr` is empty (role inherits), returns the validated token as-is
 *   — the per-session clamp at spawn time will handle model resolution.
 */
function clampRoleThinking(value: unknown, modelStr: string | undefined): string | undefined {
	const known = isKnownThinkingLevel(value);
	if (!known) return undefined;
	if (!modelStr) return known;
	const slash = modelStr.indexOf("/");
	if (slash <= 0) return known;
	const provider = modelStr.slice(0, slash);
	const modelId = modelStr.slice(slash + 1);
	const meta = inferMeta(modelId);
	return clampThinkingLevel(known, { id: modelId, provider, reasoning: meta.reasoning });
}

async function deleteRemoteGoalBranches(
	goal: PersistedGoal,
	extraBranches: readonly string[],
	repoPath: string,
): Promise<void> {
	const branches = new Set<string>();
	if (goal.branch) branches.add(goal.branch);
	for (const b of extraBranches) {
		if (b) branches.add(b);
	}
	if (branches.size === 0) return;
	if (shouldSkipRemotePush()) return;

	// Multi-repo: iterate all configured repos and run `git push --delete` in
	// each one in parallel. Single-repo collapses to a single repoPath.
	const goalRepoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
	const repoPaths: string[] = goalRepoWorktrees && Object.keys(goalRepoWorktrees).length > 0
		? Object.keys(goalRepoWorktrees).map(repo => repo === "." ? repoPath : path.join(repoPath, repo))
		: [repoPath];

	await Promise.allSettled(repoPaths.flatMap(rp => Array.from(branches).map(async (branch) => {
		try {
			await execFileAsync("git", ["push", "origin", "--delete", branch], {
				cwd: rp,
				timeout: 15_000,
			});
			console.log(`[api] Deleted remote branch: ${branch} (repo: ${rp})`);
		} catch (err) {
			console.warn(`[api] Failed to delete remote branch ${branch} in ${rp}:`, err);
		}
	})));
}

/** Cached Docker availability result to avoid running `docker info` per session creation */
let _dockerAvailCache: { available: boolean; error?: string; ts: number } | null = null;

// ── PR status cache (avoids blocking event loop with gh CLI every poll) ──
const _prCache = new Map<string, { data: any; ts: number; ttl: number }>();
const PR_NULL_CACHE_TTL_MS = 30_000; // 30 seconds for null (no-PR) results
const _prInFlight = new Map<string, Promise<any | null>>();

// Cache viewer permission per repo (rarely changes, long TTL)
const _repoPermCache = new Map<string, { perm: string; ts: number }>();
const REPO_PERM_CACHE_TTL_MS = 300_000; // 5 minutes

async function getViewerIsAdmin(cwd: string): Promise<boolean> {
	const cached = _repoPermCache.get(cwd);
	if (cached && Date.now() - cached.ts < REPO_PERM_CACHE_TTL_MS) return cached.perm === "ADMIN";
	try {
		const { stdout } = await execAsync("gh repo view --json viewerPermission", {
			cwd, encoding: "utf-8", timeout: 10000,
		});
		const perm = JSON.parse(stdout).viewerPermission ?? "";
		_repoPermCache.set(cwd, { perm, ts: Date.now() });
		return perm === "ADMIN";
	} catch {
		_repoPermCache.set(cwd, { perm: "", ts: Date.now() });
		return false;
	}
}

async function _fetchPrStatus(cwd: string, branch?: string, fallbackCwd?: string): Promise<any | null> {
	const cacheKey = branch ? `${cwd}::${branch}` : cwd;
	const ghFields = "--json state,url,number,title,mergeable,headRefName,reviewDecision";
	const branchArg = branch ? ` ${branch}` : "";
	const cmd = `gh pr view${branchArg} ${ghFields}`;

	// Try cwd first, then fallback (e.g. main repo when worktree git link is broken)
	const cwdsToTry = [cwd, ...(fallbackCwd && fallbackCwd !== cwd ? [fallbackCwd] : [])];
	for (const dir of cwdsToTry) {
		try {
			const { stdout } = await execAsync(cmd, { cwd: dir, encoding: "utf-8", timeout: 10000 });
			const pr = JSON.parse(stdout);
			const viewerIsAdmin = await getViewerIsAdmin(dir);
			const data = { number: pr.number, url: pr.url, title: pr.title, state: pr.state, mergeable: pr.mergeable, headRefName: pr.headRefName, reviewDecision: pr.reviewDecision || null, viewerIsAdmin };
			const ttl = pr.state === "OPEN" ? 10_000 : 900_000; // OPEN: 10s, CLOSED/MERGED: 15min
			_prCache.set(cacheKey, { data, ts: Date.now(), ttl });
			return data;
		} catch {
			// Try next cwd
		}
	}
	_prCache.set(cacheKey, { data: null, ts: Date.now(), ttl: PR_NULL_CACHE_TTL_MS });
	return null;
}

async function getCachedPrStatus(cwd: string, branch?: string, fallbackCwd?: string): Promise<any | null> {
	const cacheKey = branch ? `${cwd}::${branch}` : cwd;
	const cached = _prCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < cached.ttl) return cached.data;

	const existing = _prInFlight.get(cacheKey);
	if (existing) return existing;

	const p = _fetchPrStatus(cwd, branch, fallbackCwd);
	_prInFlight.set(cacheKey, p);
	try { return await p; } finally { _prInFlight.delete(cacheKey); }
}

// ── Async git helpers (avoid blocking event loop) ──
async function execGit(cmd: string, cwd: string, timeout = 5000, containerId?: string): Promise<string> {
	if (containerId) {
		// Run inside Docker container
		const { stdout } = await execFileAsync("docker", [
			"exec", "-w", cwd, containerId, "/bin/sh", "-c", cmd,
		], { encoding: "utf-8", timeout, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
		return stdout.trim();
	}
	const { stdout } = await execAsync(cmd, { cwd, encoding: "utf-8", timeout });
	return stdout.trim();
}
async function execGitSafe(cmd: string, cwd: string, fallback = "", containerId?: string): Promise<string> {
	try { return await execGit(cmd, cwd, 5000, containerId); } catch { return fallback; }
}

/** Git status result shape (+ optional partial/untrackedIncluded flags). */
export interface GitStatusResult {
	branch: string; primaryBranch: string; isOnPrimary: boolean;
	status: { file: string; status: string }[];
	hasUpstream: boolean; ahead: number; behind: number;
	aheadOfPrimary: number; behindPrimary: number; mergedIntoPrimary: boolean;
	insertionsVsPrimary: number; deletionsVsPrimary: number;
	clean: boolean; summary: string; unpushed: boolean;
	/** true if porcelain (Phase B) was skipped or timed-out */
	partial?: boolean;
	/** true only when ?untracked=1 was passed (-uall); false on default -uno */
	untrackedIncluded?: boolean;
}

// ── Git status cache + single-flight ──
// Short TTL (2000ms) to coalesce the storm of event-driven refreshes (reconnect,
// agent-idle, session-switch, goal-dashboard fan-out across N sessions sharing
// a cwd) into one underlying git invocation. Native parallel execFile typically
// returns in 50-150 ms on Windows / 10-30 ms on Linux, so 2 s of staleness is
// imperceptible to the widget (which polls every 10 s) and high-value for
// coalescing. Errors are NOT cached (so a transient failure doesn't stick).
// Key includes the untracked flag so dropdown (full) and pill-strip (summary)
// responses never cross-contaminate each other.
const GIT_STATUS_TTL_MS = 2000;
interface GitStatusCacheEntry {
	promise: Promise<GitStatusResult | null>;
	resolvedAt: number; // 0 while in flight
	result: GitStatusResult | null | undefined; // undefined while in flight
}
const gitStatusCache = new Map<string, GitStatusCacheEntry>();

/** Test-only invocation counter (underlying git script runs). */
let _runBatchGitStatusCount = 0;
export function __getGitStatusInvocationCount(): number { return _runBatchGitStatusCount; }
export function __resetGitStatusInvocationCount(): void { _runBatchGitStatusCount = 0; }

/** Test-only hook: if set, replaces the real `runBatchGitStatus` git-spawn
 *  path with a fake. Used by `tests/e2e/git-status-caching.spec.ts` to
 *  exercise the TTL/single-flight/coalesce logic deterministically without
 *  spawning Git Bash under CI load (which fails unpredictably). Production
 *  code never sets this. */
let _gitStatusFake: ((cwd: string, containerId?: string, opts?: { untracked?: boolean; configuredBaseRef?: string }) => Promise<GitStatusResult | null>) | undefined;
export function __setGitStatusFake(fn: typeof _gitStatusFake): void { _gitStatusFake = fn; }
export function __clearGitStatusFake(): void { _gitStatusFake = undefined; }

function gitStatusCacheKey(cwd: string, containerId?: string, untracked?: boolean): string {
	return `${containerId ?? 'host'}::${cwd}::${untracked ? 'u' : 's'}`;
}

/** Invalidate both summary and untracked cache entries for a cwd (optionally
 *  scoped to a container). Call after any local git mutation (commit, pull,
 *  push, rebase, merge). */
export function invalidateGitStatusCache(cwd: string, containerId?: string): void {
	gitStatusCache.delete(gitStatusCacheKey(cwd, containerId, true));
	gitStatusCache.delete(gitStatusCacheKey(cwd, containerId, false));
}

/** Test-only: mark all cache entries for a cwd as TTL-expired without
 *  sleeping. Used by `tests/e2e/git-status-caching.spec.ts` to deterministically
 *  exercise the TTL re-run path without inflating wall-clock time. Sets
 *  `resolvedAt` to a timestamp older than `GIT_STATUS_TTL_MS` so the next
 *  call falls through to a fresh invocation. */
export function __forceGitStatusCacheExpiry(cwd: string, containerId?: string): void {
	const staleAt = Date.now() - GIT_STATUS_TTL_MS - 1000;
	for (const untracked of [true, false]) {
		const entry = gitStatusCache.get(gitStatusCacheKey(cwd, containerId, untracked));
		if (entry && entry.result !== undefined) entry.resolvedAt = staleAt;
	}
}

function evictExpired(now: number): void {
	if (gitStatusCache.size <= 200) return;
	for (const [k, v] of gitStatusCache) {
		if (v.resolvedAt !== 0 && now - v.resolvedAt > 5000) gitStatusCache.delete(k);
	}
}

/** Cached wrapper over runBatchGitStatus with TTL + single-flight.
 *
 * `opts.configuredBaseRef` (when set) drives the `primaryBranch` used for
 * `aheadOfPrimary`/`behindPrimary` counters — see
 * `docs/design/base-ref.md` §5. It's not part of the cache key: each
 * (cwd, containerId) is a project-scoped worktree so `base_ref` is constant
 * for the lifetime of an entry, and the 2 s TTL absorbs the corner case of a
 * mid-flight setting change. */
async function batchGitStatus(
	cwd: string,
	containerId?: string,
	opts?: { untracked?: boolean; configuredBaseRef?: string },
): Promise<GitStatusResult | null> {
	const key = gitStatusCacheKey(cwd, containerId, opts?.untracked);
	const now = Date.now();
	evictExpired(now);
	const existing = gitStatusCache.get(key);
	if (existing) {
		if (existing.result === undefined) return existing.promise; // in flight
		if (now - existing.resolvedAt < GIT_STATUS_TTL_MS) return existing.result; // fresh
		// stale — fall through and re-run
	}

	const promise = runBatchGitStatus(cwd, containerId, opts).then(
		(result) => {
			const entry = gitStatusCache.get(key);
			if (entry && entry.promise === promise) {
				entry.result = result;
				entry.resolvedAt = Date.now();
			}
			return result;
		},
		(err) => {
			// Do NOT cache errors — next caller will retry fresh.
			const entry = gitStatusCache.get(key);
			if (entry && entry.promise === promise) gitStatusCache.delete(key);
			throw err;
		},
	);
	gitStatusCache.set(key, { promise, resolvedAt: 0, result: undefined });
	return promise;
}

/** Batched git status — host path uses native parallel execFile (no shell);
 *  container path keeps the legacy `docker exec sh -c <batch>` round-trip.
 *  Implementation lives in `./skills/git-status-native.ts`. Returns null if
 *  not a git repository. `partial` is reserved for a future degraded-mode
 *  flag and is currently always `false` on success. */
async function runBatchGitStatus(
	cwd: string,
	containerId?: string,
	opts?: { untracked?: boolean; configuredBaseRef?: string },
): Promise<GitStatusResult | null> {
	_runBatchGitStatusCount++;
	if (_gitStatusFake) return _gitStatusFake(cwd, containerId, opts);
	return runBatchGitStatusNative(cwd, { ...opts, containerId });
}

// ── Git diff helper (shared between session and goal endpoints) ──
const DIFF_MAX_BYTES = 500 * 1024; // 500KB

/**
 * The seven legacy top-level QA keys that have moved to per-component
 * `config:` maps. Rejected on PUT and stripped from GET responses as
 * defence in depth (state-migration removes them on boot).
 */
const LEGACY_QA_TOP_LEVEL_KEYS = [
	"qa_start_command",
	"qa_build_command",
	"qa_health_check",
	"qa_browser_entry",
	"qa_env",
	"qa_max_duration_minutes",
	"qa_max_scenarios",
] as const;

/**
 * Validate the per-component `config:` map (post-migration, opaque
 * key→string). Rules mirror the propose_project tool's runtime validator:
 *   - keys must be non-empty strings
 *   - values must be strings
 *   - max 100 entries per component
 *
 * Returns null on success, or a string error message suitable for HTTP 400.
 */
function validateComponentsConfig(components: unknown): string | null {
	if (!Array.isArray(components)) return null;
	for (const c of components) {
		if (!c || typeof c !== "object") continue;
		const cfg = (c as { config?: unknown }).config;
		if (cfg === undefined || cfg === null) continue;
		if (typeof cfg !== "object" || Array.isArray(cfg)) {
			return `components[${(c as { name?: unknown }).name ?? "?"}].config: must be an object`;
		}
		const entries = Object.entries(cfg as Record<string, unknown>);
		if (entries.length > 100) {
			return `components[${(c as { name?: unknown }).name ?? "?"}].config: too many entries (max 100, got ${entries.length})`;
		}
		for (const [k, v] of entries) {
			if (typeof k !== "string" || k.length === 0) {
				return `components[${(c as { name?: unknown }).name ?? "?"}].config: empty key`;
			}
			if (typeof v !== "string") {
				return `components[${(c as { name?: unknown }).name ?? "?"}].config.${k}: must be string, got ${typeof v}`;
			}
		}
	}
	return null;
}

async function getGitDiff(cwd: string, file?: string, containerId?: string): Promise<string> {
	const opts = { cwd, encoding: "utf-8" as const, timeout: 5000 };
	let hasHead = true;
	try { await execGit("git rev-parse --verify HEAD", cwd, 5000, containerId); } catch { hasHead = false; }

	let diff = "";
	if (file) {
		// Sanitize: reject path traversal, absolute paths, drive letters
		if (file.includes("..") || path.isAbsolute(file) || /^[a-zA-Z]:/.test(file)) {
			throw new Error("INVALID_PATH");
		}
		if (containerId) {
			// Run git diff inside container
			if (hasHead) {
				diff = await execGitSafe(`git diff HEAD -- ${file}`, cwd, "", containerId);
			} else {
				diff = await execGitSafe(`git diff --cached -- ${file}`, cwd, "", containerId)
					+ await execGitSafe(`git diff -- ${file}`, cwd, "", containerId);
			}
			if (!diff.trim()) {
				diff = await execGitSafe(`git diff --no-index /dev/null -- ${file}`, cwd, "", containerId);
			}
		} else if (hasHead) {
			const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--", file], opts);
			diff = stdout;
		} else {
			const { stdout: s1 } = await execFileAsync("git", ["diff", "--cached", "--", file], opts);
			const { stdout: s2 } = await execFileAsync("git", ["diff", "--", file], opts);
			diff = s1 + s2;
		}
		// Try untracked if empty (host path only — container path handled above)
		if (!diff.trim() && !containerId) {
			try {
				const devNull = process.platform === "win32" ? "NUL" : "/dev/null";
				const { stdout } = await execFileAsync("git", ["diff", "--no-index", devNull, "--", file], opts);
				diff = stdout;
			} catch (e: any) {
				// git diff --no-index exits 1 when there are differences
				if (e.stdout) diff = e.stdout;
			}
		}
	} else {
		if (containerId) {
			if (hasHead) {
				diff = await execGitSafe("git diff HEAD", cwd, "", containerId);
			} else {
				diff = await execGitSafe("git diff --cached", cwd, "", containerId)
					+ await execGitSafe("git diff", cwd, "", containerId);
			}
		} else if (hasHead) {
			const { stdout } = await execFileAsync("git", ["diff", "HEAD"], opts);
			diff = stdout;
		} else {
			const { stdout: s1 } = await execFileAsync("git", ["diff", "--cached"], opts);
			const { stdout: s2 } = await execFileAsync("git", ["diff"], opts);
			diff = s1 + s2;
		}
	}

	if (!diff.trim()) throw new Error("NO_DIFF");

	if (Buffer.byteLength(diff, "utf-8") > DIFF_MAX_BYTES) {
		diff = diff.slice(0, DIFF_MAX_BYTES) + "\n\n--- Diff truncated (exceeded 500KB) ---";
	}
	return diff;
}

export interface TlsConfig {
	cert: string;  // path to PEM certificate
	key: string;   // path to PEM private key
	caCert?: string;  // path to CA certificate (for mkcert-based certs)
}

export interface GatewayConfig {
	host: string;
	port: number;
	portExplicit?: boolean;
	authToken: string;
	defaultCwd: string;
	staticDir?: string;
	agentCliPath?: string;
	systemPromptPath?: string;
	tls?: TlsConfig;
	/** Force auth even on localhost (used by E2E tests). */
	forceAuth?: boolean;
}

export function createGateway(config: GatewayConfig) {
	const stateDir = bobbitStateDir();
	const configDir = bobbitConfigDir();
	fs.mkdirSync(stateDir, { recursive: true });

	// Initialize module-level caches for parameterized modules
	initPromptDirs(stateDir);
	initSkillSidecarDir(stateDir);
	initCompactionSidecarDir(stateDir);
	initAssistantRegistry(configDir);

	// Project registry — persisted at server level.
	// Zero projects is a valid state: a fresh install has no projects.json and the
	// UI forces the user through "Add Project" before any goal/session work. Bobbit
	// never registers a project implicitly.
	const projectRegistry = new ProjectRegistry(stateDir);

	// Register the synthetic "system" project so system-scope tool-assistant
	// sessions have a valid persistence anchor without forcing the user to
	// register a real project. Idempotent — hidden from UI listings via the
	// `hidden: true` filter on GET /api/projects.
	//
	// Anchor at a dedicated subdir under bobbitDir so the ProjectContext's
	// derived stateDir (`<rootPath>/.bobbit/state`) cannot collide with any
	// user project rooted at the install dir or with the global stateDir —
	// otherwise the system context would load the same goals.json/sessions.json
	// as a user project rooted at getProjectRoot() (e.g. test fixtures).
	try {
		const systemRoot = path.join(stateDir, "system-project");
		fs.mkdirSync(systemRoot, { recursive: true });
		projectRegistry.registerSystemProject(systemRoot);
	} catch (err) {
		console.warn(`[startup] Failed to register system project: ${err}`);
	}

	// Run one-time migration from centralized to per-project state
	migrateToPerProjectState(stateDir, projectRegistry, getProjectRoot());

	// Recover data lost by the original migration bug (unconditional rename
	// when central dir == default project dir). Must run before stores load.
	recoverPreMigrationData(stateDir);

	// One-shot project.yaml migration: synthesize components[] for legacy
	// single-repo projects. Idempotent. Must run BEFORE ProjectContext
	// instantiation so ProjectConfigStore.load() picks up the new shape,
	// and BEFORE the worktree pool fills.
	migrateAllProjectYaml(
		projectRegistry.list().map(p => ({ id: p.id, name: p.name, rootPath: p.rootPath })),
	);

	// Initialize per-project contexts
	const projectContextManager = new ProjectContextManager(projectRegistry);
	projectContextManager.initAll();

	// Migrate inline token values from project.yaml → secrets.json (one-time)
	for (const p of projectRegistry.list()) {
		const ctx = projectContextManager.getOrCreate(p.id);
		if (!ctx) continue;
		const tokens = ctx.projectConfigStore.getSandboxTokens();
		// getSandboxTokens() never includes `value` (typed accessor strips it).
		// We need the raw values, which are still on the in-memory side-table
		// after load() but only accessible via the back-compat flat get().
		const tokensRaw = ctx.projectConfigStore.get("sandbox_tokens");
		if (!tokensRaw) continue;
		try {
			const arr = JSON.parse(tokensRaw);
			if (!Array.isArray(arr)) continue;
			const hasValues = arr.some((e: any) => e.value);
			if (!hasValues) {
				// No inline values to migrate. Only force a rewrite when the
				// on-disk format was legacy JSON-string (isDirty() is set during
				// load()). Without this guard we save() on every server start,
				// which re-flows multi-line workflow strings through
				// yaml.stringify and produces a noisy diff every restart.
				if (ctx.projectConfigStore.isDirty()) {
					ctx.projectConfigStore.setSandboxTokens(tokens);
				}
				continue;
			}
			// Move values to secrets store
			const secretUpdates: Record<string, string> = {};
			for (const e of arr) {
				if (e.value) secretUpdates[e.key] = e.value;
			}
			ctx.secretsStore.update(secretUpdates);
			// Strip values from config (write structured form, no JSON-encoded string).
			ctx.projectConfigStore.setSandboxTokens(
				arr.map((e: any) => ({ key: e.key, enabled: e.enabled !== false })),
			);
			console.log(`[migration] Moved ${Object.keys(secretUpdates).length} token secret(s) to secrets.json for project ${ctx.project.id}`);
		} catch { /* ignore parse errors */ }
	}

	const colorStore = new ColorStore(stateDir);
	const prStatusStore = new PrStatusStore(stateDir);
	const preferencesStore = new PreferencesStore(stateDir);
	const reviewAnnotationStore = new ReviewAnnotationStore(stateDir);
	const projectConfigStore = new ProjectConfigStore(configDir);
	const savedCwd = preferencesStore.get("defaultCwd");
	if (savedCwd && typeof savedCwd === "string") {
		config.defaultCwd = savedCwd;
	}
	const roleStore = new RoleStore(configDir);
	const roleManager = new RoleManager(roleStore);
	const toolManager = new ToolManager(configDir);
	toolManager.generateDetailDocs(stateDir);
	const groupPolicyStore = new ToolGroupPolicyStore(configDir);
	const sandboxTokenStore = new SandboxTokenStore();
	const cookieStore = new CookieStore(stateDir);
	const sessionManager = new SessionManager({
		agentCliPath: config.agentCliPath,
		systemPromptPath: config.systemPromptPath,
		colorStore,
		roleManager,
		toolManager,
		preferencesStore,
		projectConfigStore,
		groupPolicyStore,
		projectContextManager,
		prStatusStore,
	});
	sessionManager.sandboxTokenStore = sandboxTokenStore;

	// LSP supervisor — singleton, lazy-spawning. Adapters registered eagerly
	// but no LSP child processes are spawned until first `ensure()`.
	const lspProjectConfig = projectConfigStore.getWithDefaults();
	const lspDisabled = String(lspProjectConfig.lsp_disabled ?? "false").toLowerCase() === "true";
	const lspPreWarm = String(lspProjectConfig.pre_warm_lsp ?? "true").toLowerCase() !== "false";
	const lspMaxServersRaw = Number(lspProjectConfig.lsp_max_servers ?? 4);
	const lspIdleTtlRaw = Number(lspProjectConfig.lsp_idle_ttl_ms ?? 600000);
	const lspMaxServers = Number.isFinite(lspMaxServersRaw) && lspMaxServersRaw > 0 ? lspMaxServersRaw : 4;
	const lspIdleTtlMs = Number.isFinite(lspIdleTtlRaw) && lspIdleTtlRaw > 0 ? lspIdleTtlRaw : 600000;
	const lspSupervisor = new LspSupervisor({
		factories: [new TypescriptLspFactory(), new PyrightLspFactory()],
		disabled: lspDisabled,
		preWarmEnabled: lspPreWarm,
		maxServers: lspMaxServers,
		idleTtlMs: lspIdleTtlMs,
	});
	// SandboxManager is wired later when sandbox=docker, so the supervisor
	// exposes a setter rather than taking it via constructor.
	sessionManager.setLspSupervisor(lspSupervisor);
	registerWorktreePreCleanupHook(async (wp) => { await lspSupervisor.shutdownForWorktree(wp); });
	// Use the info fields directly: the session has already been removed from
	// the in-memory map by the time listeners fire, so getSession() would
	// return undefined and refcounts would leak.
	sessionManager.addTerminationListener((_sessionId, info) => {
		if (info.cwd) lspSupervisor.release(info.cwd);
		if (info.worktreePath) lspSupervisor.release(info.worktreePath);
		for (const r of info.repoWorktrees ?? []) lspSupervisor.release(r.worktreePath);
	});
	// Wire sessionManager into the project context manager so the search
	// orphan filter can resolve sessions across projects (live, dormant,
	// archived). The registry is already passed via the constructor.
	projectContextManager.setDependencies({ sessionManager });
	// Wire gate status changes to bump goal generation for all project contexts
	for (const ctx of projectContextManager.all()) {
		ctx.gateStore.onStatusChange = () => {
			ctx.goalStore.bumpGeneration();
		};
	}
	const builtinConfigProvider = new BuiltinConfigProvider();
	// Wire builtin defaults into stores (in-memory only, no disk writes).
	// Direct store lookups (roleStore.get()) transparently fall back to
	// builtins, so no seeding to disk is needed. Workflows are project-
	// scoped only — no system layer, no builtin layer.
	roleStore.setBuiltins(builtinConfigProvider.getRoles());
	groupPolicyStore.setBuiltins(builtinConfigProvider.getToolGroupPolicies());
	// Wire the system-scope Subgoals feature gate into the policy cascade.
	// Without this, getSubgoalsEnabled() returns false unconditionally and
	// every tool in the `Children` group (goal_spawn_child, goal_merge_child,
	// goal_pause, goal_resume, goal_plan_propose, goal_set_policy,
	// goal_archive_child, goal_plan_status, goal_decide_mutation) resolves to
	// `never` at policy time — silently dropped from every team-lead's tool
	// surface. See docs/design/subgoals-experimental-toggle.md.
	groupPolicyStore.setSubgoalsEnabledGetter(() => preferencesStore.get("subgoalsEnabled") === true);

	const configCascade = new ConfigCascade(builtinConfigProvider, {
		getRoles: () => roleStore.getAllLocal(),
		getTools: () => toolManager.getLocalTools(),
		getToolGroupPolicies: () => groupPolicyStore.getAll(),
	}, projectContextManager);
	sessionManager.configCascade = configCascade;

	const staffManager = new StaffManager(projectContextManager);
	const triggerEngine = new TriggerEngine(staffManager, sessionManager);
	triggerEngine.start();
	// Placeholder task store for TeamManager construction. Real goal/task operations
	// route through the per-project context (see TeamManager.getTasksForSession). The
	// first registered project's store is used when available, otherwise a server-
	// scoped store is instantiated solely so construction doesn't require a project.
	const firstCtxForInit = projectContextManager.all().next().value as import("./agent/project-context.js").ProjectContext | undefined;
	const taskStore = firstCtxForInit ? firstCtxForInit.taskStore : new TaskStore(stateDir);
	const teamManager = new TeamManager(sessionManager, {
		colorStore,
		taskManager: new TaskManager(taskStore),
		roleStore,
		projectContextManager,
		toolManager,
	});
	const bgProcessManager = new BgProcessManager((sessionId: string) => {
		const session = sessionManager.getSession(sessionId);
		return session?.clients;
	});
	// Expose bg process manager for API routes and session cleanup
	(sessionManager as any).bgProcessManager = bgProcessManager;
	const rateLimiter = new RateLimiter();

	const cleanupInterval = setInterval(() => {
		rateLimiter.cleanup();
	}, 60_000);

	// Verification harness — assigned after wss is created (closure captures the reference)
	let verificationHarness: VerificationHarness;

	// Sandbox manager — assigned in start() when sandbox=docker
	let sandboxManager: SandboxManager | null = null;

	const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
		const url = new URL(req.url || "/", `http://${req.headers.host}`);
		const isLocalhostMode = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");

		// Content-origin preview route — served before API auth so iframe loads
		// can authenticate via the bobbit_session cookie instead of the bearer
		// token (iframes cannot set Authorization headers).
		if (url.pathname.startsWith("/preview/")) {
			await handlePreviewRequest(req, res, url.pathname, {
				cookieStore,
				isLocalhost: isLocalhostMode,
				adminBearerToken: config.authToken,
			});
			return;
		}

		// API routes
		if (url.pathname.startsWith("/api/")) {

			// When serving the UI (same-origin), reflect the request origin; otherwise allow any
			const corsOrigin = config.staticDir ? (req.headers.origin || "*") : "*";
			res.setHeader("Access-Control-Allow-Origin", corsOrigin);
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}

			// Public endpoints — no auth required (CA cert is inherently public).
			const isPublicEndpoint = url.pathname === "/api/ca-cert" && req.method === "GET";

			// Cookie auth short-circuit — if the browser presents a known
			// bobbit_session cookie, treat the request as admin-authenticated
			// and skip the bearer-token check below.
			const hasValidCookie = cookieTryAuth(req, cookieStore);

			// Auth check — skipped in localhost mode (only local processes can connect)
			let sandboxScope: SandboxScope | undefined;
			if (!isLocalhostMode && !isPublicEndpoint && !hasValidCookie) {
				const authHeader = req.headers.authorization;
				const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7)
					: url.searchParams.get("token"); // Allow token in query param for links opened in new tabs
				const ip = req.socket.remoteAddress || "unknown";

				if (rateLimiter.isRateLimited(ip)) {
					res.writeHead(429);
					res.end();
					return;
				}

				if (!token) {
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Unauthorized" }));
					return;
				}

				// Admin token first, then sandbox token
				if (!validateToken(token, config.authToken)) {
					const scope = sandboxTokenStore.lookup(token);
					if (!scope) {
						rateLimiter.recordFailure(ip);
						res.writeHead(401, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Unauthorized" }));
						return;
					}
					sandboxScope = scope;
				} else {
					// Successful admin Bearer auth — mint session cookie if absent
					// so subsequent requests (including iframe content origin) can
					// authenticate without the Bearer token leaking into URLs.
					issueCookieIfMissing(req, res, cookieStore, { localhost: isLocalhostMode });
				}
			} else if (!isPublicEndpoint && isLocalhostMode) {
				// Localhost mode: skip auth check, still mint the cookie so the
				// browser can use the same cookie auth path on non-localhost
				// deployments later (and the SSE endpoint below remains uniform).
				issueCookieIfMissing(req, res, cookieStore, { localhost: true });
			}

			// Enforce sandbox route guard
			if (sandboxScope && !isSandboxAllowed(url.pathname, req.method || "GET", sandboxScope)) {
				res.writeHead(403, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Forbidden: sandbox token cannot access this endpoint" }));
				return;
			}

			// Optional per-request timing for performance profiling.
			// Enable via BOBBIT_TIMING_LOG=1 to print "[timing] METHOD path ms" for each API call.
			const _timingEnabled = process.env.BOBBIT_TIMING_LOG === "1";
			const _timingStart = _timingEnabled ? performance.now() : 0;
			await handleApiRoute(url, req, res, sessionManager, config, colorStore, prStatusStore, teamManager, roleManager, toolManager, projectContextManager, bgProcessManager, staffManager, verificationHarness, preferencesStore, projectConfigStore, groupPolicyStore, broadcastToGoal, broadcastToAll, sandboxManager, projectRegistry, configCascade, sandboxScope, sandboxTokenStore, reviewAnnotationStore, broadcastToSession, roleStore);
			if (_timingEnabled) {
				const dur = performance.now() - _timingStart;
				if (dur >= 100) console.log(`[timing] ${req.method} ${url.pathname}${url.search} ${dur.toFixed(1)}ms`);
			}

			return;
		}

		// Dynamic PWA manifest — when launched from a tokenized URL, bake the token
		// into start_url so the PWA can relaunch authenticated.
		// Only does so for a *valid* token; invalid tokens fall through to a plain
		// manifest (no token baked in). Works in both dev mode (Vite proxies
		// /manifest.json to us) and prod (staticDir serves public/).
		if (url.pathname === "/manifest.json" && req.method === "GET") {
			try {
				const manifest = loadManifest(config.staticDir);
				const providedToken = url.searchParams.get("token");
				if (providedToken && validateToken(providedToken, config.authToken)) {
					manifest.start_url = `/?token=${encodeURIComponent(providedToken)}`;
				}
				res.writeHead(200, {
					"Content-Type": "application/manifest+json",
					// Don't let the manifest be cached — token-validity may change.
					"Cache-Control": "no-store",
					// Prevent token leakage via Referer when the PWA makes cross-origin requests.
					"Referrer-Policy": "no-referrer",
				});
				res.end(JSON.stringify(manifest));
				return;
			} catch {
				// Fall through to static serving on any error.
			}
		}

		// Static file serving
		if (config.staticDir) {
			serveStatic(url.pathname, config.staticDir, res);
			return;
		}

		res.writeHead(404);
		res.end("Not found");
	};

	const server: http.Server | https.Server = config.tls
		? https.createServer(
			{
				cert: fs.readFileSync(config.tls.cert),
				key: fs.readFileSync(config.tls.key),
			},
			requestHandler,
		)
		: http.createServer(requestHandler);

	// Long-polling endpoints (e.g. /api/sessions/:id/wait) can block for 10+ minutes.
	// Node >= 19 defaults requestTimeout to 300s which would kill those requests.
	// Disable the server-level timeout; individual endpoints manage their own.
	server.requestTimeout = 0;
	server.headersTimeout = 0;

	// WebSocket server (noServer mode — we handle upgrade manually).
	//
	// `perMessageDeflate: false` disables per-message compression. The `ws`
	// library's default enables it, which on loopback (where bandwidth is
	// not the bottleneck) can stall the server's WS write loop under bursty
	// JSON event traffic — zlib serialises sends through a single thread,
	// and during a streaming turn we emit dozens of small frames per second.
	// Empirically this contributed to a 'Reconnecting to server…' E2E flake
	// cluster (RP-18, CT-01-d, S-02) where the WS would briefly disconnect
	// during high-volume mock-agent event bursts. Loopback never benefits
	// from compression in production either, so this is a strict win.
	const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

	// Broadcast a message to WebSocket clients belonging to a specific goal
	function broadcastToGoal(goalId: string, event: any): void {
		const data = JSON.stringify(event);
		for (const ws of wss.clients) {
			if ((ws as any).authenticated && ws.readyState === 1 /* OPEN */) {
				const sid = (ws as any).sessionId as string | undefined;
				if (sid) {
					const session = sessionManager.getSession(sid);
					if (session?.teamGoalId === goalId || session?.goalId === goalId) {
						ws.send(data);
						continue;
					}
					// Session is associated with a different goal — skip it
					if (session?.teamGoalId || session?.goalId) continue;
				}
				// Fallback: send to clients with no goal association
				// (e.g. the user's browser session viewing the goal dashboard)
				ws.send(data);
			}
		}
	}

	/** Broadcast to ALL authenticated WebSocket clients (regardless of session/goal). */
	function broadcastToAll(event: any): void {
		const data = JSON.stringify(event);
		for (const ws of wss.clients) {
			if ((ws as any).authenticated && ws.readyState === 1 /* OPEN */) {
				ws.send(data);
			}
		}
	}
	/**
	 * Broadcast to all authenticated WebSocket clients whose active session
	 * belongs to the given project. Clients with no session association (e.g.
	 * the user viewing the dashboard) also receive the event so the UI can
	 * surface index status in project-agnostic chrome.
	 */
	function broadcastToProject(projectId: string, event: any): void {
		const data = JSON.stringify(event);
		for (const ws of wss.clients) {
			if (!(ws as any).authenticated || ws.readyState !== 1 /* OPEN */) continue;
			const sid = (ws as any).sessionId as string | undefined;
			if (sid) {
				const session = sessionManager.getSession(sid);
				if (!session) continue;
				if (session.projectId && session.projectId !== projectId) continue;
			}
			ws.send(data);
		}
	}

	// Bridge search index progress bus → WS. Progress events are debounced
	// to 500ms per-project (design §9). Complete + error events pass through.
	{
		const progressDebounce = new Map<string, { timer: NodeJS.Timeout; latest: any }>();
		const flushProgress = (projectId: string) => {
			const entry = progressDebounce.get(projectId);
			if (!entry) return;
			progressDebounce.delete(projectId);
			clearTimeout(entry.timer);
			broadcastToProject(projectId, entry.latest);
		};
		searchProgressBus.on("index:progress", (ev) => {
			const event = { type: "index:progress" as const, ...ev };
			const existing = progressDebounce.get(ev.projectId);
			if (existing) {
				existing.latest = event;
				return;
			}
			const timer = setTimeout(() => flushProgress(ev.projectId), 500);
			timer.unref();
			progressDebounce.set(ev.projectId, { timer, latest: event });
		});
		searchProgressBus.on("index:complete", (ev) => {
			flushProgress(ev.projectId);
			broadcastToProject(ev.projectId, { type: "index:complete" as const, ...ev });
		});
		searchProgressBus.on("index:error", (ev) => {
			broadcastToProject(ev.projectId, { type: "index:error" as const, ...ev });
		});
	}

	teamManager.setBroadcastToGoal(broadcastToGoal);
	// Push a session_removed broadcast to ALL clients on terminate/archive/purge
	// so sidebars and dashboards update instantly. Replaces a 5s polling tick
	// for a documented class of races (e.g. clicking a stale sidebar entry just
	// after another tab archived the session).
	sessionManager.addTerminationListener((sessionId, info) => {
		try {
			broadcastToAll({ type: "session_removed", sessionId, projectId: info.projectId, reason: info.reason });
		} catch (err) {
			console.error(`[broadcast] session_removed failed for ${sessionId}:`, err);
		}
	});

	sessionManager.setOnPrCreationDetected((session) => {
		const goalId = session.goalId || session.teamGoalId;
		if (!goalId) return;
		const goalCtx = projectContextManager.getContextForGoal(goalId);
		const goal = goalCtx?.goalStore.get(goalId);
		if (!goal) return;
		_prCache.delete(goal.cwd);
		if (goal.branch) _prCache.delete(`${goal.cwd}::${goal.branch}`);
		broadcastToAll({ type: "pr_status_changed", goalId });
	});
	// Broadcast a message to all WebSocket clients subscribed to a specific session.
	function broadcastToSession(sessionId: string, event: any): void {
		const session = sessionManager.getSession(sessionId);
		if (!session) return;
		const data = JSON.stringify(event);
		for (const ws of session.clients) {
			if ((ws as any).readyState === 1 /* OPEN */) ws.send(data);
		}
	}

	verificationHarness = new VerificationHarness(stateDir, undefined, broadcastToGoal, roleStore, preferencesStore, sessionManager, teamManager, projectConfigStore, projectContextManager, configCascade);
	teamManager.setVerificationHarness(verificationHarness);
	verificationHarness.setTeamLeadNotifier((goalId, message) => {
		const team = teamManager.getTeamState(goalId);
		if (!team?.teamLeadSessionId) return;
		const teamLeadSession = sessionManager.getSession(team.teamLeadSessionId);
		if (!teamLeadSession || teamLeadSession.status === "terminated") return;
		try {
			if (teamLeadSession.status === "streaming") {
				sessionManager.deliverLiveSteer(team.teamLeadSessionId, message);
			} else {
				sessionManager.enqueuePrompt(team.teamLeadSessionId, message, { isSteered: true });
			}
			console.log(`[verification] Notified team lead for goal ${goalId}: ${message}`);
		} catch (err) {
			console.error(`[verification] Failed to notify team lead for goal ${goalId}:`, err);
		}
	});

	const isLocalhostServer = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url || "/", `http://${req.headers.host}`);
		const viewerMatch = url.pathname === "/ws/viewer";
		const match = viewerMatch ? null : url.pathname.match(/^\/ws\/([^/]+)$/);

		if (!match && !viewerMatch) {
			socket.destroy();
			return;
		}

		const sessionId = viewerMatch ? "__viewer__" : match![1];

		const ip = req.socket.remoteAddress || "unknown";
		if (!isLocalhostServer && rateLimiter.isRateLimited(ip)) {
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			handleWebSocketConnection(ws, sessionId, req, sessionManager, config.authToken, rateLimiter, projectConfigStore, isLocalhostServer, sandboxTokenStore, projectContextManager);
		});
	});

	return {
		server,
		sessionManager,
		bgProcessManager,
		projectContextManager,
		async start(): Promise<number> {
			// Check internet and auto-configure AI Gateway if offline
			// Runs before session restore so models.json is written before
			// any agent subprocesses start.
			await startupAigwCheck(preferencesStore);
			writeContextWindowOverrides();
			writeOpenAIModelAdditions();

			// Initialize MCP servers (skip in test environments)
			if (!process.env.BOBBIT_SKIP_MCP) {
				try {
					await sessionManager.initMcp(process.cwd());
				} catch (err) {
					console.error('[mcp] MCP init failed:', (err as Error).message);
				}
			}

			// Wire verification harness before session restore so orphan cleanup can skip resuming sessions
			sessionManager.setVerificationHarness(verificationHarness);

			// ── Sandbox manager ──
			// Sandboxes are initialized lazily per-project on first sandbox use
			// (see SandboxManager.ensureForProject). The bootstrap closure below
			// runs the host-side plumbing (image build/version check, mounts,
			// credentials, sandbox network, GitHub token) the first time each
			// project's sandbox is requested by session/goal/staff creation.
			const sandboxBootstrap: SandboxBootstrap = async (projectId) => {
				const project = projectRegistry.get(projectId);
				if (!project) {
					throw new Error(`[sandbox] bootstrap: project ${projectId} not registered`);
				}
				const ctx = projectContextManager.getOrCreate(projectId);
				if (!ctx) {
					throw new Error(`[sandbox] bootstrap: cannot resolve context for project ${projectId}`);
				}
				const cfg = ctx.projectConfigStore;
				const sandboxCfg = cfg.get("sandbox") || "none";
				if (sandboxCfg !== "docker") return null;

				const projectDir = project.rootPath;
				const imageName = cfg.get("sandbox_image") || "bobbit-agent";

				// Auto-build or rebuild image if missing or stale. Images are
				// shared across projects (Docker image tags) so the first project
				// to request a sandbox pays the build cost.
				const imageStatus = await checkDockerAvailability(imageName);
				if (imageStatus.imageExists === false && imageStatus.dockerfileExists === true) {
					const buildResult = await buildSandboxImage(imageName, projectDir);
					if (!buildResult.success) {
						console.error(`[sandbox] Auto-build failed for project ${projectId}; proceeding will likely error`);
					}
				} else if (imageStatus.imageExists === true) {
					await ensureImageAgentVersion(imageName, projectDir);
				}

				const isRepo = await isGitRepo(projectDir);
				if (!isRepo) {
					console.log(`[sandbox] Project ${projectId} is not a git repo — sandbox disabled (worktrees require git)`);
					return null;
				}
				const repoPath = await getRepoRoot(projectDir);

				// Repo URL for cloning inside the container. Strip embedded tokens so
				// they don't leak into .git/config; the container's credential helper
				// reads GITHUB_TOKEN from env instead.
				let repoUrl: string;
				try {
					const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: repoPath, timeout: 5000 });
					repoUrl = stripTokenFromGitUrl(stdout.trim());
				} catch {
					repoUrl = repoPath;
				}

				let poolMounts: string[] = [];
				try {
					const mountsRaw = cfg.get("sandbox_mounts") || "";
					poolMounts = mountsRaw ? validateSandboxMounts(JSON.parse(mountsRaw), "[sandbox]") : [];
				} catch (err) { console.warn(`[sandbox] Invalid sandbox_mounts JSON for project ${projectId}, ignoring: ${err}`); }

				let poolCredentials: Record<string, string> = {};
				try {
					const credsRaw = cfg.get("sandbox_credentials") || "";
					poolCredentials = credsRaw ? JSON.parse(credsRaw) : {};
				} catch (err) { console.warn(`[sandbox] Invalid sandbox_credentials JSON for project ${projectId}, ignoring: ${err}`); }

				const sandboxNetwork = await sessionManager.ensureSandboxNetwork();

				const githubTokenEnabled = cfg.get("sandbox_github_token") !== "false";
				const githubToken = githubTokenEnabled ? resolveHostTokenValue("GITHUB_TOKEN") : undefined;

				const components = ctx.projectConfigStore.getComponents();
				// Multi-repo: try to resolve each repo's clone URL from `<rootPath>/<repo>/.git/config`.
				// Falls back to the project's primary `repoUrl` for any repo without
				// a remote configured (the bootstrap will then clone the same repo
				// into multiple paths — only useful as a defensive default).
				let repoUrlByName: Record<string, string> | undefined;
				if (components.some(c => c.repo !== ".")) {
					repoUrlByName = {};
					const seen = new Set<string>();
					for (const c of components) {
						if (c.repo === "." || seen.has(c.repo)) continue;
						seen.add(c.repo);
						const rp = path.join(projectDir, c.repo);
						try {
							const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: rp, timeout: 5000 });
							repoUrlByName[c.repo] = stripTokenFromGitUrl(stdout.trim());
						} catch {
							repoUrlByName[c.repo] = repoUrl;
						}
					}
				}

				return {
					projectId,
					projectDir,
					repoUrl,
					image: imageName,
					sandboxNetwork,
					sandboxMounts: poolMounts,
					sandboxCredentials: poolCredentials,
					githubToken,
					toolManager: ctx.toolManager,
					components,
					repoUrlByName,
					// Resolver is invoked at worktree-creation time inside the container, so it always
					// reads the current project-config-store value rather than a snapshot taken at
					// sandbox bootstrap. Same shape as the worktree-pool baseRefResolver.
					baseRefResolver: () => cfg.get("base_ref"),
				};
			};
			sandboxManager = new SandboxManager({ bootstrap: sandboxBootstrap });
			sessionManager.setSandboxManager(sandboxManager);
			sessionManager.subscribeSandboxRecovery();
			// Install LSP sandbox bridge now that SandboxManager exists.
			lspSupervisor.setSandboxBridge(
				new MultiProjectSandboxLspBridge(sandboxManager, projectContextManager),
			);

			// Restore persisted sessions before accepting connections
			await sessionManager.restoreSessions();

			// NOTE: Orphaned worktree cleanup and non-interactive session cleanup
			// are no longer automatic on startup. Use the Settings → Maintenance UI
			// or the /api/maintenance/* endpoints to preview and clean up manually.

			sessionManager.startPurgeSchedule();

			// Initialize worktree pools for all git-repo projects
			// (pre-creates worktrees in the background so new sessions start instantly).
			// E2E / CI can skip this entirely via BOBBIT_SKIP_WORKTREE_POOL=1 — the
			// pool fills worktrees aggressively at boot and replenishes on every
			// claim, which costs real CPU on tests that don't need git at all.
			//
			// Boot sweeper + pool fill run AFTER `server.listen()` as a background
			// chain — the sweeper shells out to `git worktree list/repair` per repo
			// with 10–15s timeouts, and the pool readiness check awaits `isGitRepo`
			// per project. Doing them before listen used to leave the gateway
			// unreachable for many seconds on installs with stale worktrees.
			//
			// Concurrency note: the sweeper and the pool init operate on DISJOINT
			// branch sets — `worktree-sweeper.ts` explicitly skips pool branches
			// (`isPoolBranch`), and `WorktreePool.reclaimOrphaned` only inspects
			// pool branches. So the two phases are run concurrently via
			// `Promise.all`, and project-level pool init is also parallelised
			// across projects (each project's pool is independent). This avoids
			// the previous serial chain that left the pool empty for minutes on
			// installs with many stale worktrees, forcing every new session
			// through the cold path (full createWorktree + npm ci).
			const runBootBackgroundTasks = async (): Promise<void> => {
				const t0 = Date.now();

				const sweeperTask = (async () => {
					const tStart = Date.now();
					try {
						const { sweepOrphanedWorktrees } = await import("./agent/worktree-sweeper.js");
						const sweepProjects: Array<{ id: string; rootPath: string; repos?: string[] }> = [];
						const sweepGoals: Array<{ id: string; branch?: string; worktreePath?: string; archived?: boolean; repoWorktrees?: Record<string, string> }> = [];
						const sweepSessions: Array<{ id: string; branch?: string; worktreePath?: string; archived?: boolean; repoWorktrees?: Record<string, string> }> = [];
						const sweepStaff: Array<{ id: string; branch?: string; worktreePath?: string }> = [];
						// Skip hidden contexts (synthetic system project) — it has
						// no goals/sessions/staff and must never drive worktree work.
						for (const ctx of projectContextManager.visible()) {
							const repoNames = ctx.projectConfigStore.repoNames();
							sweepProjects.push({
								id: ctx.project.id,
								rootPath: ctx.project.rootPath,
								repos: repoNames.length > 0 ? repoNames : undefined,
							});
							for (const g of ctx.goalStore.getAll()) {
								sweepGoals.push({
									id: g.id, branch: g.branch, worktreePath: g.worktreePath, archived: !!g.archived,
									repoWorktrees: (g as { repoWorktrees?: Record<string, string> }).repoWorktrees,
								});
							}
							for (const s of ctx.sessionStore.getAll()) {
								sweepSessions.push({
									id: s.id, branch: s.branch, worktreePath: s.worktreePath, archived: !!s.archived,
									repoWorktrees: s.repoWorktrees,
								});
							}
							for (const st of ctx.staffStore.getAll()) {
								sweepStaff.push({ id: st.id, branch: (st as any).branch, worktreePath: (st as any).worktreePath });
							}
						}
						console.log(`[boot] sweeper start (${sweepProjects.length} projects)`);
						const result = await sweepOrphanedWorktrees({
							projects: sweepProjects,
							goals: sweepGoals,
							sessions: sweepSessions,
							staff: sweepStaff,
						});
						console.log(`[boot] sweeper done in ${Date.now() - tStart}ms (reclaimed=${result.reclaimed} cleaned=${result.cleaned} repaired=${result.repaired})`);
					} catch (err) {
						console.warn(`[boot] sweeper failed in ${Date.now() - tStart}ms (non-fatal):`, err);
					}
				})();

				const poolInitTask = (async () => {
					if (process.env.BOBBIT_SKIP_WORKTREE_POOL) return;
					// Hidden contexts (synthetic system project) must NOT seed a
					// worktree pool. When bobbit's state dir is nested inside an
					// unrelated git checkout, `isGitRepo(<state>/system-project)`
					// walks up to find the host repo and the pool would allocate
					// `pool/_pool-*` branches there. See
					// `tests/system-project-pool-leak.test.ts`.
					const contexts = Array.from(projectContextManager.visible());
					console.log(`[boot] pool init start (${contexts.length} projects)`);
					await Promise.all(contexts.map(async (ctx) => {
						const tStart = Date.now();
						try {
							const repoPath = ctx.project.rootPath;
							const components = ctx.projectConfigStore.getComponents();
							const isMulti = components.some(c => c.repo !== ".");
							let poolReady = false;
							if (isMulti) {
								const seen = new Set<string>();
								poolReady = true;
								for (const c of components) {
									if (c.repo === "." || seen.has(c.repo)) continue;
									seen.add(c.repo);
									if (!(await isGitRepo(path.join(repoPath, c.repo)))) { poolReady = false; break; }
								}
							} else {
								poolReady = await isGitRepo(repoPath);
							}
							if (poolReady) {
								const poolSize = parseInt(ctx.projectConfigStore.get("worktree_pool_size") || "2", 10) || 2;
								const wtRoot = ctx.projectConfigStore.get("worktree_root") || undefined;
								const pcs = ctx.projectConfigStore;
								// Single-repo: resolve nested rootPath to the actual git toplevel so
								// pool entries land under <gitRoot>-wt/, not <projectDir>-wt/.
								const poolRepoPath = isMulti ? repoPath : await getRepoRoot(repoPath);
								sessionManager.initWorktreePoolForProject(ctx.project.id, poolRepoPath, () => pcs.getComponents(), poolSize, wtRoot, () => pcs.get("base_ref"));
								console.log(`[boot] pool ready: project=${ctx.project.id} in ${Date.now() - tStart}ms`);
							} else {
								console.log(`[boot] pool skipped (not a git repo): project=${ctx.project.id} in ${Date.now() - tStart}ms`);
							}
						} catch (err) {
							console.warn(`[boot] pool init failed: project=${ctx.project.id} in ${Date.now() - tStart}ms (non-fatal):`, err);
						}
					}));
				})();

				await Promise.all([sweeperTask, poolInitTask]);
				console.log(`[boot] background tasks complete in ${Date.now() - t0}ms`);
			};

			// Wire goal-manager resolvers so goals claim through the pool first and
			// resolve components / project root for multi-repo goal creation.
			// Hidden contexts (synthetic system project) have no goals to wire.
			for (const ctx of projectContextManager.visible()) {
				const projectId = ctx.project.id;
				ctx.goalManager.setPoolResolver(() => sessionManager.getWorktreePool(projectId));
				ctx.goalManager.setComponentsResolver((pid: string) => {
					const c = projectContextManager.getOrCreate(pid);
					return c ? c.projectConfigStore.getComponents() : [];
				});
				ctx.goalManager.setProjectRootResolver((pid: string) => {
					return projectRegistry.get(pid)?.rootPath;
				});
				ctx.goalManager.setWorktreeRootResolver((pid: string) => {
					const c = projectContextManager.getOrCreate(pid);
					return c?.projectConfigStore.get("worktree_root") || undefined;
				});
				ctx.goalManager.setBaseRefResolver((pid: string) => {
					const c = projectContextManager.getOrCreate(pid);
					return c?.projectConfigStore.get("base_ref") || undefined;
				});
			}

			// Now that sessions are live, re-subscribe to team events
			// (must happen after restoreSessions so session objects exist)
			teamManager.resubscribeTeamEvents();

			// Resume any verifications that were interrupted by a server restart (fire-and-forget)
			verificationHarness.resumeInterruptedVerifications().catch(err => {
				console.error("[verification] Error resuming interrupted verifications:", err);
			});

			// Port 0 = let OS assign a free port; skip the auto-increment loop
			if (config.port === 0) {
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(0, config.host, () => {
						server.removeListener("error", reject);
						resolve();
					});
				});
				const addr = server.address() as import("node:net").AddressInfo;
				void runBootBackgroundTasks();
				return addr.port;
			}

			const maxPort = config.portExplicit !== false ? config.port : config.port + 9;
			let port = config.port;

			while (port <= maxPort) {
				try {
					await new Promise<void>((resolve, reject) => {
						server.once("error", reject);
						server.listen(port, config.host, () => {
							server.removeListener("error", reject);
							resolve();
						});
					});
					if (port !== config.port) {
						console.log(`Port ${config.port} in use, using port ${port}`);
					}
					void runBootBackgroundTasks();
					return port;
				} catch (err: any) {
					if (err.code === "EADDRINUSE" && port < maxPort) {
						console.log(`Port ${port} in use, trying ${port + 1}...`);
						port++;
						continue;
					}
					throw err;
				}
			}
			throw new Error(`All ports ${config.port}-${maxPort} in use`);
		},
		async shutdown() {
			clearInterval(cleanupInterval);
			triggerEngine.stop();
			wss.close();
			for (const pool of sessionManager.getAllWorktreePools().values()) {
				await pool.drain();
			}
			await sessionManager.shutdown();
			projectContextManager.closeAll();
			if (sandboxManager) {
				await sandboxManager.shutdownAll();
			}
			await sessionManager.cleanupSandboxNetwork();
			server.close();
		},
	};
}

// isSetupComplete now lives in ./setup-status.ts (re-exported at top of file).

/** Redact token values in sandbox config for API responses. Never send real secrets to the browser.
 *  `sandbox_tokens` is a structured array (post-native-YAML); other fields stay flat strings. */
function redactSandboxSecrets(config: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...config };
	if (Array.isArray(result.sandbox_tokens)) {
		result.sandbox_tokens = (result.sandbox_tokens as Array<any>).map((e: any) => ({
			...e,
			value: e.value ? "__REDACTED__" : "",
		}));
	}
	if (typeof result.sandbox_credentials === "string" && result.sandbox_credentials) {
		try {
			const obj = JSON.parse(result.sandbox_credentials);
			if (typeof obj === "object" && obj !== null) {
				const redacted: Record<string, string> = {};
				for (const [k, v] of Object.entries(obj)) {
					redacted[k] = v ? "__REDACTED__" : "";
				}
				result.sandbox_credentials = JSON.stringify(redacted);
			}
		} catch { /* leave as-is */ }
	}
	return result;
}

/** Redact token values in resolved config (with source annotations).
 *  `sandbox_tokens.value` is now a structured array; sandbox_credentials remains a JSON string. */
function redactSandboxSecretsResolved(config: Record<string, { value: unknown; source: string }>): Record<string, { value: unknown; source: string }> {
	const result = { ...config };
	if (result.sandbox_tokens && Array.isArray(result.sandbox_tokens.value)) {
		result.sandbox_tokens = {
			...result.sandbox_tokens,
			value: (result.sandbox_tokens.value as Array<any>).map((e: any) => ({
				...e,
				value: e.value ? "__REDACTED__" : "",
			})),
		};
	}
	for (const key of ["sandbox_credentials"] as const) {
		if (!result[key]) continue;
		const entry = { ...result[key] };
		if (key === "sandbox_credentials" && typeof entry.value === "string" && entry.value) {
			try {
				const obj = JSON.parse(entry.value);
				if (typeof obj === "object" && obj !== null) {
					const redacted: Record<string, string> = {};
					for (const [k, v] of Object.entries(obj)) {
						redacted[k] = v ? "__REDACTED__" : "";
					}
					entry.value = JSON.stringify(redacted);
					result[key] = entry;
				}
			} catch { /* leave as-is */ }
		}
	}
	return result;
}

/** Merge secrets into sandbox_tokens for GET responses (adds value from SecretsStore).
 *  Operates on a config object whose `sandbox_tokens` is the structured array (or absent). */
function mergeSecretsIntoTokens(config: Record<string, unknown>, secretsStore: import("./agent/secrets-store.js").SecretsStore): void {
	const tokens = config.sandbox_tokens;
	if (!Array.isArray(tokens)) return;
	const secrets = secretsStore.getAll();
	config.sandbox_tokens = (tokens as Array<any>).map((e: any) => ({
		...e,
		value: secrets[e.key] || e.value || "",
	}));
}

/** Strip redacted sentinel from incoming structured sandbox_tokens, persisting real values
 *  to the SecretsStore. Returns the structured array suitable for setSandboxTokens(). */
function mergeSandboxTokensStructured(
	incoming: Array<{ key: string; enabled?: boolean; value?: string }>,
	secretsStore?: import("./agent/secrets-store.js").SecretsStore | null,
): Array<{ key: string; enabled: boolean }> {
	if (secretsStore) {
		const updates: Record<string, string> = {};
		for (const e of incoming) {
			if (!e || typeof e.key !== "string") continue;
			if (e.value === "__REDACTED__") {
				// Keep existing
			} else if (e.value) {
				updates[e.key] = e.value;
			} else {
				updates[e.key] = "";
			}
		}
		secretsStore.update(updates);
	}
	return incoming
		.filter(e => e && typeof e.key === "string")
		.map(e => ({ key: e.key, enabled: e.enabled !== false }));
}

/** Merge redacted sentinel values with existing stored values before saving. */
function mergeSandboxSecrets(updates: Record<string, string>, configStore: import("./agent/project-config-store.js").ProjectConfigStore, secretsStore?: import("./agent/secrets-store.js").SecretsStore | null): void {
	// sandbox_tokens is now handled via mergeSandboxTokensStructured at the
	// migrated-fields layer in the PUT handler. This helper only handles the
	// remaining legacy flat sandbox_credentials key.
	void configStore;
	void secretsStore;
	if (updates.sandbox_credentials) {
		try {
			const incoming = JSON.parse(updates.sandbox_credentials) as Record<string, string>;
			const existingRaw = configStore.get("sandbox_credentials") || "";
			let existingObj: Record<string, string> = {};
			try { existingObj = existingRaw ? JSON.parse(existingRaw) : {}; } catch { /* ignore */ }
			for (const [k, v] of Object.entries(incoming)) {
				if (v === "__REDACTED__") {
					incoming[k] = existingObj[k] || "";
				}
			}
			updates.sandbox_credentials = JSON.stringify(incoming);
		} catch { /* leave as-is */ }
	}
}

async function handleApiRoute(
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	sessionManager: SessionManager,
	config: GatewayConfig,
	colorStore: ColorStore,
	prStatusStore: PrStatusStore,
	teamManager: TeamManager,
	roleManager: RoleManager,
	toolManager: ToolManager,
	projectContextManager: ProjectContextManager,
	bgProcessManager: BgProcessManager,
	staffManager: StaffManager,
	verificationHarness: VerificationHarness,
	preferencesStore: PreferencesStore,
	projectConfigStore: ProjectConfigStore,
	groupPolicyStore: ToolGroupPolicyStore,
	broadcastToGoal: (goalId: string, event: any) => void,
	broadcastToAll: (event: any) => void,
	sandboxManager: SandboxManager | null,
	projectRegistry: ProjectRegistry,
	configCascade: ConfigCascade,
	sandboxScope?: SandboxScope,
	sandboxTokenStore?: SandboxTokenStore,
	reviewAnnotationStore?: ReviewAnnotationStore,
	_broadcastToSession?: (sessionId: string, event: any) => void,
	roleStore?: RoleStore,
) {
	// These are always wired by the sole caller; the optional markers are only to avoid
	// touching every existing signature site.
	const serverRoleStore = roleStore!;
	const json = (data: unknown, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
	};
	const jsonError = (status: number, err: unknown, extra?: Record<string, unknown>) => {
		const e = err instanceof Error ? err : new Error(String(err));
		json({ error: e.message, stack: e.stack, ...extra }, status);
	};

	/** Subgoals feature gate. Writes 403 SUBGOALS_DISABLED + returns false when off. */
	function requireSubgoalsEnabled(): boolean {
		if (preferencesStore.get("subgoalsEnabled") === true) return true;
		json({ error: "Subgoals are disabled", code: "SUBGOALS_DISABLED" }, 403);
		return false;
	}

	// ── Cross-project helper functions ─────────────────────────────

	/** Retrieve a goal from any project context. */
	function getGoalAcrossProjects(goalId: string): PersistedGoal | undefined {
		const ctx = projectContextManager.getContextForGoal(goalId);
		return ctx?.goalStore.get(goalId);
	}

	/** List live goals across all projects, optionally filtered by projectId. */
	function listGoalsAcrossProjects(opts?: { projectId?: string }): PersistedGoal[] {
		if (opts?.projectId) {
			const ctx = projectContextManager.getOrCreate(opts.projectId);
			return ctx ? ctx.goalStore.getLive() : [];
		}
		return projectContextManager.getAllLiveGoals();
	}

	/** Resolve per-project config store, falling back to the default. */
	function resolveProjectConfigStore(pid: string | null): ProjectConfigStore {
		if (pid && projectContextManager) {
			const ctx = projectContextManager.getOrCreate(pid);
			if (ctx) return ctx.projectConfigStore;
		}
		return projectConfigStore;
	}

	/**
	 * Resolve the host-side cwd for slash-skill discovery.
	 * For sandboxed sessions the cwd is a container-internal path (e.g. /workspace-wt/...)
	 * which doesn't exist on the host. Use the project's rootPath instead so skill
	 * files (.claude/skills/, .bobbit/skills/) are found on the host filesystem.
	 */
	function resolveSkillDiscoveryCwd(cwd: string, projectId: string | null | undefined): string {
		if (projectId && projectContextManager) {
			const ctx = projectContextManager.getOrCreate(projectId);
			if (ctx) return ctx.project.rootPath;
		}
		return cwd;
	}

	/** Get a GoalManager for the project that owns the given goal. Throws if not found. */
	function getGoalManagerForGoal(goalId: string): GoalManager {
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) throw new Error(`Goal "${goalId}" not found in any project`);
		return ctx.goalManager;
	}

	/** Get a TaskManager for the project that owns the given goal. Throws if not found. */
	const taskManagerCache = new Map<string, TaskManager>();
	function getTaskManagerForGoal(goalId: string): TaskManager {
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) throw new Error(`Goal "${goalId}" not found in any project`);
		const projectId = ctx.project.id;
		let tm = taskManagerCache.get(projectId);
		if (!tm) {
			tm = new TaskManager(ctx.taskStore);
			taskManagerCache.set(projectId, tm);
		}
		return tm;
	}

	/** Get a TaskManager for a task by looking up which goal it belongs to. Throws if not found. */
	function getTaskManagerForTask(taskId: string): TaskManager {
		// Search all project contexts for the task
		for (const ctx of projectContextManager.all()) {
			const task = ctx.taskStore.get(taskId);
			if (task) return getTaskManagerForGoal(task.goalId);
		}
		throw new Error(`Task "${taskId}" not found in any project`);
	}

	// GET /api/health — unauthenticated so the client can probe localhost mode
	if (url.pathname === "/api/health" && req.method === "GET") {
		const isLocalhost = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");
		json({
			status: "ok",
			sessions: sessionManager.listSessions().length,
			localhost: isLocalhost,
			aigw: !!getAigwUrl(preferencesStore),
			setupComplete: isSetupComplete(),
			orphanedTranscripts: sessionManager.orphanedTranscriptsCount,
		});
		return;
	}

	// POST /api/internal/test/replay-buffered-events/:sessionId — BOBBIT_E2E-only hook
	// used by ST-DEDUP-01 to reproduce live-streaming duplication. Iterates the
	// session's EventBuffer and re-broadcasts each buffered entry on the SAME
	// wire path production uses, so when the fix adds `seq`/`ts` to the
	// broadcast envelope the endpoint will naturally carry them too (because it
	// inspects the buffer's stored entries — which upgrade from raw events to
	// {seq,ts,event} tuples post-fix). Pre-fix: clients receive duplicate
	// events and dupe-append assistant/toolResult messages. Post-fix: clients
	// dedupe by seq and the message list stays stable.
	const replayMatch = url.pathname.match(/^\/api\/internal\/test\/replay-buffered-events\/([^/]+)$/);
	if (replayMatch && req.method === "POST") {
		if (process.env.BOBBIT_E2E !== "1") { json({ error: "BOBBIT_E2E not enabled" }, 403); return; }
		const sessionId = replayMatch[1];
		const session = sessionManager.getSession(sessionId);
		if (!session) { json({ error: "session not found" }, 404); return; }
		const entries = session.eventBuffer.getAll() as any[];
		let replayed = 0;
		const deadline = Date.now() + PACE_TIMEOUT_MS;
		for (const entry of entries) {
			// Accept both raw-event shape (pre-fix) and {seq,ts,event} (post-fix).
			const isWrapped = entry && typeof entry === "object" && "event" in entry && ("seq" in entry || "ts" in entry);
			const framePayload = isWrapped
				? { type: "event" as const, data: entry.event, seq: entry.seq, ts: entry.ts }
				: { type: "event" as const, data: entry };
			const data = JSON.stringify(framePayload);
			for (const client of session.clients) {
				await paceAndSend(client as any, data, deadline);
			}
			replayed++;
		}
		json({ replayed, bufferSize: session.eventBuffer.size });
		return;
	}

	// GET /api/setup-status — check if project setup has been completed
	if (url.pathname === "/api/setup-status" && req.method === "GET") {
		json({ complete: isSetupComplete() });
		return;
	}

	// POST /api/setup-status/dismiss — mark setup as dismissed (writes sentinel file)
	if (url.pathname === "/api/setup-status/dismiss" && req.method === "POST") {
		const stateDir = bobbitStateDir();
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "setup-complete"), "dismissed\n");
		json({ ok: true });
		return;
	}

	// GET /api/system-prompt-context — read the project context section from system-prompt.md
	if (url.pathname === "/api/system-prompt-context" && req.method === "GET") {
		const systemPromptPath = path.join(bobbitConfigDir(), "system-prompt.md");
		if (!fs.existsSync(systemPromptPath)) { json({ context: "" }); return; }
		try {
			const content = fs.readFileSync(systemPromptPath, "utf-8");
			// Extract everything after the last "# Project Context" heading, or return empty
			const marker = "# Project Context";
			const idx = content.lastIndexOf(marker);
			if (idx === -1) { json({ context: "" }); return; }
			const context = content.slice(idx + marker.length).trim();
			json({ context });
		} catch { json({ context: "" }); }
		return;
	}

	// PUT /api/system-prompt-context — append/replace the project context section in system-prompt.md
	if (url.pathname === "/api/system-prompt-context" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body || typeof body.context !== "string") { json({ error: "Missing context" }, 400); return; }
		const systemPromptPath = path.join(bobbitConfigDir(), "system-prompt.md");
		try {
			let existing = "";
			if (fs.existsSync(systemPromptPath)) {
				existing = fs.readFileSync(systemPromptPath, "utf-8");
			}
			const marker = "# Project Context";
			const idx = existing.lastIndexOf(marker);
			const base = idx !== -1 ? existing.slice(0, idx).trimEnd() : existing.trimEnd();
			const newContent = base + "\n\n" + marker + "\n\n" + body.context.trim() + "\n";
			fs.mkdirSync(path.dirname(systemPromptPath), { recursive: true });
			fs.writeFileSync(systemPromptPath, newContent);
			json({ ok: true });
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/system-prompt/customise — copy shipped default to .bobbit/config/system-prompt.md
	//   so the user can edit it. If the file already exists it is left unchanged.
	//   Returns { path, created, content }.
	if (url.pathname === "/api/system-prompt/customise" && req.method === "POST") {
		const userPath = path.join(bobbitConfigDir(), "system-prompt.md");
		const defaultPath = path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"defaults",
			"system-prompt.md",
		);
		let created = false;
		try {
			if (!fs.existsSync(userPath)) {
				if (!fs.existsSync(defaultPath)) {
					json({ error: "Default system-prompt.md not found in install" }, 500);
					return;
				}
				fs.mkdirSync(path.dirname(userPath), { recursive: true });
				fs.copyFileSync(defaultPath, userPath);
				created = true;
			}
			const content = fs.readFileSync(userPath, "utf-8");
			json({ path: userPath, created, content });
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/shutdown — graceful shutdown (used by coverage teardown to flush V8 coverage)
	if (url.pathname === "/api/shutdown" && req.method === "POST") {
		json({ status: "shutting down" });
		// Defer exit to allow the response to be sent
		setTimeout(() => process.exit(0), 500);
		return;
	}

	// GET /api/ca-cert — download the Bobbit CA certificate for device trust
	if (url.pathname === "/api/ca-cert" && req.method === "GET") {
		const caCertPath = config.tls?.caCert;
		if (!caCertPath || !fs.existsSync(caCertPath)) {
			json({ error: "No CA certificate available. Server is using a self-signed certificate." }, 404);
			return;
		}
		const certData = fs.readFileSync(caCertPath);
		res.writeHead(200, {
			// iOS Safari needs this MIME type to offer the profile-install flow.
			"Content-Type": "application/x-x509-ca-cert",
			"Content-Disposition": "attachment; filename=\"bobbit-ca.crt\"",
			"Content-Length": certData.length,
		});
		res.end(certData);
		return;
	}

	// GET /api/sandbox-pool (deprecated — no longer a real pool, returns basic stats)
	if (url.pathname === "/api/sandbox-pool" && req.method === "GET") {
		if (sandboxManager) {
			const stats = sandboxManager.getStats();
			json({ ...stats, type: "sandbox" });
		} else {
			json({ enabled: false });
		}
		return;
	}

	// GET /api/worktree-pool
	if (url.pathname === "/api/worktree-pool" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId");
		if (projectId) {
			const pool = sessionManager.getWorktreePool(projectId);
			json(pool ? pool.getStatus() : { enabled: false, ready: 0, target: 0, filling: false });
		} else {
			const pools: Record<string, any> = {};
			for (const [pid, pool] of sessionManager.getAllWorktreePools()) {
				pools[pid] = pool.getStatus();
			}
			json({ pools });
		}
		return;
	}

	// GET /api/sandbox-status
	if (url.pathname === "/api/sandbox-status" && req.method === "GET") {
		const sandboxConfig = projectConfigStore.get("sandbox") || "none";
		const imageName = projectConfigStore.get("sandbox_image") || "bobbit-agent";
		const configured = sandboxConfig === "docker";
		const status = await checkDockerAvailability(configured ? imageName : undefined);
		json({ ...status, configured });
		return;
	}

	// POST /api/sandbox-image/build
	if (url.pathname === "/api/sandbox-image/build" && req.method === "POST") {
		const imageName = projectConfigStore.get("sandbox_image") || "bobbit-agent";
		if (!fs.existsSync(path.join(config.defaultCwd, "docker", "Dockerfile"))) {
			json({ error: "Dockerfile not found at docker/Dockerfile" }, 404);
			return;
		}
		if (isBuildingImage()) {
			json({ error: "Build already in progress" }, 409);
			return;
		}
		const result = await buildSandboxImage(imageName, config.defaultCwd);
		if (result.success) {
			json({ success: true });
		} else {
			json({ success: false, error: result.error }, 500);
		}
		return;
	}

	// GET /api/sandbox/host-tokens
	if (url.pathname === "/api/sandbox/host-tokens" && req.method === "GET") {
		const tokens = detectHostTokens(preferencesStore);
		json(tokens);
		return;
	}

	// LSP routes — agent-side tool surface
	if (url.pathname === "/api/lsp/state" && req.method === "GET") {
		const supervisor = sessionManager.getLspSupervisor();
		if (!supervisor) { json({ error: "lsp_unavailable", message: "supervisor not initialised" }); return; }
		if (supervisor.disabled) { json({ state: "disabled" }); return; }
		const cwd = url.searchParams.get("cwd") || "";
		const pathArg = url.searchParams.get("path") || undefined;
		try {
			const key = supervisor.resolveKey(cwd, pathArg);
			json({ state: supervisor.stateFor(key), worktreePath: key.worktreePath, language: key.language });
		} catch (err: any) {
			json({ state: "unknown", error: String(err?.message ?? err) });
		}
		return;
	}
	const lspMatch = url.pathname.match(/^\/api\/lsp\/([a-z_]+)$/);
	if (lspMatch && req.method === "POST") {
		const method = lspMatch[1];
		const body = await readBody(req).catch(() => ({}));
		const supervisor = sessionManager.getLspSupervisor();
		if (!supervisor) { json({ error: "lsp_unavailable", message: "supervisor not initialised" }); return; }
		if (supervisor.disabled) {
			json({ error: "lsp_unavailable", message: "disabled by project config" });
			return;
		}
		try {
			const result = await supervisor.dispatch(method, body || {});
			json(result);
		} catch (err: any) {
			if (err?.code === "lsp_unavailable" || err?.code === "lsp_capacity" || err?.code === "lsp_timeout") {
				json({ error: err.code, message: err.message });
			} else {
				jsonError(500, err);
			}
		}
		return;
	}
	if (url.pathname === "/api/lsp/stats" && req.method === "GET") {
		const supervisor = sessionManager.getLspSupervisor();
		json(supervisor ? supervisor.stats() : { error: "lsp_unavailable" });
		return;
	}

	// ── Project Detection & Browse ────────────────────────────────────

	// GET /api/projects/preflight?path=<absolute>
	// Returns a structured PreflightReport — always 200 when path is
	// supplied; the failures are *the* response. 400 only for missing /
	// bad-shape input.
	if (url.pathname === "/api/projects/preflight" && req.method === "GET") {
		const rawPath = url.searchParams.get("path");
		if (!rawPath || typeof rawPath !== "string") {
			json({ error: "Missing path query parameter" }, 400);
			return;
		}
		try {
			const report = runPreflight(rawPath, {
				registeredProjects: projectRegistry.list(),
				gatewayProjectRoot: getProjectRoot(),
				worktreeRootFor: (p) => {
					const ctx = projectContextManager.getOrCreate(p.id);
					return ctx?.projectConfigStore.get("worktree_root") || undefined;
				},
			});
			json(report);
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/projects/archive-bobbit
	// Body: { rootPath }. Moves existing project-scoped .bobbit/ content
	// aside into .bobbit-archive-NNN/ — never touching the
	// GATEWAY_OWNED_FILES allowlist. Does NOT mutate the registry; the
	// client re-runs /preflight afterwards.
	if (url.pathname === "/api/projects/archive-bobbit" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || typeof body.rootPath !== "string") {
			json({ error: "Missing rootPath" }, 400);
			return;
		}
		if (!path.isAbsolute(body.rootPath)) {
			json({ error: "rootPath must be absolute" }, 400);
			return;
		}
		if (!fs.existsSync(body.rootPath)) {
			json({ error: "rootPath does not exist" }, 400);
			return;
		}
		// Compute gateway-owned via the same logic as the preflight check.
		const sameAsGateway = path.resolve(body.rootPath) === path.resolve(getProjectRoot());
		const hasGwUrl = fs.existsSync(path.join(body.rootPath, ".bobbit", "state", "gateway-url"));
		const hasWatchdog = fs.existsSync(path.join(body.rootPath, ".bobbit", "state", "watchdog.json"));
		const gatewayOwned = sameAsGateway || hasGwUrl || hasWatchdog;
		try {
			const result = archiveProjectBobbitDir(body.rootPath, { gatewayOwned });
			json(result);
		} catch (err: any) {
			if (err instanceof ArchiveError) {
				const status = err.code === "empty-bobbit-dir" || err.code === "no-bobbit-dir" ? 409 : 400;
				json({ error: err.message, code: err.code }, status);
				return;
			}
			jsonError(500, err);
		}
		return;
	}

	// POST /api/projects/detect
	if (url.pathname === "/api/projects/detect" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || typeof body.path !== "string") {
			json({ error: "Missing path" }, 400);
			return;
		}
		const dirPath = path.resolve(body.path);
		const exists = fs.existsSync(dirPath);
		let hasBobbit = false;
		let isEmpty = true;
		let hasPackageJson = false;
		let hasCargoToml = false;
		let hasGoMod = false;
		let name = path.basename(dirPath);

		if (exists) {
			try {
				const stat = fs.statSync(dirPath);
				if (stat.isDirectory()) {
					const entries = fs.readdirSync(dirPath);
					isEmpty = entries.length === 0;
					// Source of truth: a configured project is one with .bobbit/config/project.yaml.
					// Mere presence of an empty .bobbit/ (e.g. post-archive shape, ghost dirs) must NOT
					// route the add-project flow to auto-import. See goal: Post-archive → assistant.
					hasBobbit = fs.existsSync(path.join(dirPath, ".bobbit", "config", "project.yaml"));
					hasPackageJson = entries.includes("package.json");
					hasCargoToml = entries.includes("Cargo.toml");
					hasGoMod = entries.includes("go.mod");

					// Try to read name from package.json
					if (hasPackageJson) {
						try {
							const pkg = JSON.parse(fs.readFileSync(path.join(dirPath, "package.json"), "utf-8"));
							if (typeof pkg.name === "string" && pkg.name) {
								name = pkg.name;
							}
						} catch {
							// Ignore parse errors — fall back to directory basename
						}
					}
				} else {
					// Path exists but is not a directory
					json({ error: "Path is not a directory" }, 400);
					return;
				}
			} catch {
				// stat failed — treat as non-existent
				json({ exists: false, hasBobbit: false, isEmpty: true, hasPackageJson: false, hasCargoToml: false, hasGoMod: false, name });
				return;
			}
		}

		json({ exists, hasBobbit, isEmpty, hasPackageJson, hasCargoToml, hasGoMod, name });
		return;
	}

	// POST /api/projects/scan?path=...  → run repo-scan on a folder.
	// Returns { repos: DetectedRepo[] }. Used by the Add-Project flow and
	// Settings → "Re-scan repos". Phase 4b — see docs/design/multi-repo-components.md §8.1.
	if (url.pathname === "/api/projects/scan" && req.method === "POST") {
		const body = await readBody(req).catch(() => ({}));
		const rawPath = url.searchParams.get("path") ?? (body && typeof body.path === "string" ? body.path : "");
		if (!rawPath) { json({ error: "Missing path" }, 400); return; }
		const dirPath = path.resolve(rawPath);
		if (!fs.existsSync(dirPath)) { json({ error: "Path not found" }, 404); return; }
		try {
			const { scanRepos } = await import("./agent/repo-scan.js");
			const { scanMonorepo } = await import("./agent/monorepo-scan.js");
			const repos = await scanRepos(dirPath);
			const monorepo = scanMonorepo(dirPath);
			json({ repos, monorepo });
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// GET /api/projects/:id/structured  → returns { components, workflows,
	// worktree_root } in their structured (non-string) shape. Used by the
	// Settings → Components tab so the UI doesn't have to parse YAML.
	// Phase 4b.
	const projectStructuredMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/structured$/);
	if (projectStructuredMatch && req.method === "GET") {
		const ctx = projectContextManager.getOrCreate(projectStructuredMatch[1]);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		const components = ctx.projectConfigStore.getComponents();
		const workflows = ctx.projectConfigStore.getWorkflows() ?? {};
		const worktreeRoot = ctx.projectConfigStore.get("worktree_root") ?? "";
		json({ components, workflows, worktree_root: worktreeRoot });
		return;
	}

	// POST /api/projects/:id/rescan-repos  → re-run repo-scan on the
	// project's rootPath; returns the same shape as /api/projects/scan.
	// Settings "Re-scan repos" button. Phase 4b.
	const projectRescanMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/rescan-repos$/);
	if (projectRescanMatch && req.method === "POST") {
		const project = projectRegistry.get(projectRescanMatch[1]);
		if (!project) { json({ error: "Project not found" }, 404); return; }
		try {
			const { scanRepos } = await import("./agent/repo-scan.js");
			const { scanMonorepo } = await import("./agent/monorepo-scan.js");
			const repos = await scanRepos(project.rootPath);
			const monorepo = scanMonorepo(project.rootPath);
			json({ repos, monorepo, rootPath: project.rootPath });
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// GET /api/browse-directory
	if (url.pathname === "/api/browse-directory" && req.method === "GET") {
		const rawPath = url.searchParams.get("path");
		const dirPath = rawPath ? path.resolve(rawPath) : config.defaultCwd;

		if (!fs.existsSync(dirPath)) {
			json({ error: "Directory not found" }, 404);
			return;
		}

		try {
			const stat = fs.statSync(dirPath);
			if (!stat.isDirectory()) {
				json({ error: "Path is not a directory" }, 400);
				return;
			}
		} catch {
			json({ error: "Cannot access path" }, 400);
			return;
		}

		const entries: Array<{ name: string; path: string }> = [];
		try {
			const items = fs.readdirSync(dirPath);
			for (const item of items) {
				// Skip hidden directories and node_modules
				if (item.startsWith(".") || item === "node_modules") continue;
				const fullPath = path.join(dirPath, item);
				try {
					const stat = fs.lstatSync(fullPath);
					if (stat.isDirectory() && !stat.isSymbolicLink()) {
						entries.push({ name: item, path: fullPath });
					}
				} catch {
					// Skip entries we can't stat
				}
			}
		} catch {
			json({ error: "Cannot read directory" }, 500);
			return;
		}

		entries.sort((a, b) => a.name.localeCompare(b.name));

		const parsed = path.parse(dirPath);
		const parent = parsed.root === dirPath ? null : path.dirname(dirPath);

		json({ current: dirPath, parent, entries });
		return;
	}

	// ── Project CRUD ──────────────────────────────────────────────────

	// GET /api/projects
	if (url.pathname === "/api/projects" && req.method === "GET") {
		// Filter out hidden projects (e.g. the synthetic "system" project) so
		// they never appear in the client's state.projects.
		json(projectRegistry.list().filter(p => !p.hidden));
		return;
	}

	// POST /api/projects
	if (url.pathname === "/api/projects" && req.method === "POST") {
		const body = await readBody(req);
		if (typeof body?.name !== "string" || typeof body?.rootPath !== "string") {
			json({ error: "Missing name or rootPath" }, 400);
			return;
		}
		// Validate components[].config eagerly (mirrors propose_project tool).
		{
			const err = validateComponentsConfig((body as Record<string, unknown>).components);
			if (err) { json({ error: err }, 400); return; }
		}
		try {
			const upsert = body.upsert === true;
			const color = typeof body.color === "string" ? body.color : undefined;
			const palette = typeof body.palette === "string" ? body.palette : undefined;
			const colorLight = typeof body.colorLight === "string" ? body.colorLight : undefined;
			const colorDark = typeof body.colorDark === "string" ? body.colorDark : undefined;

			// Upsert: if a project already exists at this path, return it
			if (upsert) {
				const existing = projectRegistry.getByPath(body.rootPath);
				if (existing) {
					// Ensure context is initialized
					const ctx = projectContextManager.getOrCreate(existing.id);
					if (ctx) {
						ctx.gateStore.onStatusChange = () => {
							ctx.goalStore.bumpGeneration();
						};
						ctx.goalManager.setPoolResolver(() => sessionManager.getWorktreePool(existing.id));
						ctx.goalManager.setComponentsResolver((pid: string) => {
							const c = projectContextManager.getOrCreate(pid);
							return c ? c.projectConfigStore.getComponents() : [];
						});
						ctx.goalManager.setProjectRootResolver((pid: string) => projectRegistry.get(pid)?.rootPath);
						ctx.goalManager.setWorktreeRootResolver((pid: string) => {
							const c = projectContextManager.getOrCreate(pid);
							return c?.projectConfigStore.get("worktree_root") || undefined;
						});
						ctx.goalManager.setBaseRefResolver((pid: string) => {
							const c = projectContextManager.getOrCreate(pid);
							return c?.projectConfigStore.get("base_ref") || undefined;
						});
					}
					json(existing, 200);
					return;
				}
			}

			const acceptCanonical = body.acceptCanonical === true;
			let project;
			try {
				project = projectRegistry.register(body.name, body.rootPath, { color, palette, colorLight, colorDark, acceptCanonical });
			} catch (regErr: any) {
				if (regErr instanceof SymlinkProjectRootError) {
					json({
						error: "Project root is a symlink",
						code: "symlink_root",
						rootPath: regErr.rootPath,
						canonical: regErr.canonical,
					}, 400);
					return;
				}
				if (regErr instanceof PreflightFailedError) {
					json({
						error: regErr.message,
						code: "preflight_failed",
						report: regErr.report,
					}, 400);
					return;
				}
				throw regErr;
			}
			// Initialize project context for the new project
			const newCtx = projectContextManager.getOrCreate(project.id);
			if (newCtx) {
				newCtx.gateStore.onStatusChange = () => {
					newCtx.goalStore.bumpGeneration();
				};
			}

			// Multi-repo: accept optional components / workflows in the create body.
			// Single-repo without components → fill default `[{name: <project name>, repo: "."}]`.
			const createComponents = (body as Record<string, unknown>).components;
			const createWorkflows = (body as Record<string, unknown>).workflows;
			if (newCtx) {
				if (Array.isArray(createComponents) && createComponents.length > 0) {
					if (createWorkflows && typeof createWorkflows === "object" && !Array.isArray(createWorkflows)) {
						try {
							const { validateAllWorkflows } = await import("./agent/workflow-validator.js");
							const errors = validateAllWorkflows(
								createWorkflows as Parameters<typeof validateAllWorkflows>[0],
								createComponents as Parameters<typeof validateAllWorkflows>[1],
							);
							if (errors.length > 0) {
								projectRegistry.remove(project.id);
								json({ error: "Workflow validation failed", details: errors }, 400);
								return;
							}
						} catch { /* best-effort */ }
					}
					const normalized = (createComponents as Array<Record<string, unknown>>).map(c => ({
						name: String(c.name ?? ""),
						repo: typeof c.repo === "string" && c.repo ? c.repo : ".",
						relativePath: typeof c.relative_path === "string" ? c.relative_path : (typeof c.relativePath === "string" ? c.relativePath as string : undefined),
						worktreeSetupCommand: typeof c.worktree_setup_command === "string" ? c.worktree_setup_command : (typeof c.worktreeSetupCommand === "string" ? c.worktreeSetupCommand as string : undefined),
						commands: c.commands && typeof c.commands === "object" && !Array.isArray(c.commands) ? c.commands as Record<string, string> : undefined,
						config: c.config && typeof c.config === "object" && !Array.isArray(c.config) ? c.config as Record<string, string> : undefined,
					}));
					newCtx.projectConfigStore.setComponents(normalized);
					if (createWorkflows && typeof createWorkflows === "object" && !Array.isArray(createWorkflows)) {
						newCtx.projectConfigStore.setWorkflows(createWorkflows as Record<string, import("./agent/project-config-store.js").InlineWorkflowDef>);
					}
				} else {
					// Default single-repo component named after the project.
					if (newCtx.projectConfigStore.getComponents().length === 0) {
						newCtx.projectConfigStore.setComponents([{ name: project.name, repo: "." }]);
					}
				}
				// No default-workflow seeding. Workflows must be designed by the
				// project assistant; a project may legitimately have zero workflows.
			}
			// Initialize worktree pool if the new project is a git repo.
			// Respect BOBBIT_SKIP_WORKTREE_POOL for E2E/CI.
			if (!process.env.BOBBIT_SKIP_WORKTREE_POOL) {
				try {
					// Multi-repo: rootPath is a container dir, individual repos sit
					// under <rootPath>/<repo>/. We treat that case as "git-ready" if
					// every declared repo subdir is a git repo.
					const components = newCtx?.projectConfigStore.getComponents() ?? [];
					const isMulti = components.some(c => c.repo !== ".");
					let poolReady = false;
					if (isMulti) {
						const seen = new Set<string>();
						poolReady = true;
						for (const c of components) {
							if (c.repo === "." || seen.has(c.repo)) continue;
							seen.add(c.repo);
							if (!(await isGitRepo(path.join(body.rootPath, c.repo)))) { poolReady = false; break; }
						}
					} else {
						poolReady = await isGitRepo(body.rootPath);
					}
					if (poolReady) {
						const poolSize = parseInt(newCtx?.projectConfigStore.get("worktree_pool_size") || "2", 10) || 2;
						const wtRoot = newCtx?.projectConfigStore.get("worktree_root") || undefined;
						const pcs = newCtx?.projectConfigStore;
						// Single-repo: resolve nested rootPath to the actual git toplevel so
						// pool entries land under <gitRoot>-wt/, not <projectDir>-wt/.
						const poolRepoPath = isMulti ? body.rootPath : await getRepoRoot(body.rootPath);
						sessionManager.initWorktreePoolForProject(project.id, poolRepoPath, pcs ? () => pcs.getComponents() : undefined, poolSize, wtRoot, pcs ? () => pcs.get("base_ref") : undefined);
					}
				} catch { /* best-effort */ }
			}
			// Wire the goal-manager pool resolver for the new project (Phase 3 — goals via pool).
			if (newCtx) {
				newCtx.goalManager.setPoolResolver(() => sessionManager.getWorktreePool(project.id));
				newCtx.goalManager.setComponentsResolver((pid: string) => {
					const c = projectContextManager.getOrCreate(pid);
					return c ? c.projectConfigStore.getComponents() : [];
				});
				newCtx.goalManager.setProjectRootResolver((pid: string) => projectRegistry.get(pid)?.rootPath);
				newCtx.goalManager.setWorktreeRootResolver((pid: string) => {
					const c = projectContextManager.getOrCreate(pid);
					return c?.projectConfigStore.get("worktree_root") || undefined;
				});
				newCtx.goalManager.setBaseRefResolver((pid: string) => {
					const c = projectContextManager.getOrCreate(pid);
					return c?.projectConfigStore.get("base_ref") || undefined;
				});
			}
			json(project, 201);
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// GET /api/projects/:id
	const projectGetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
	if (projectGetMatch && req.method === "GET") {
		const project = projectRegistry.get(projectGetMatch[1]);
		if (!project) { json({ error: "Project not found" }, 404); return; }
		json(project);
		return;
	}

	// PUT /api/projects/:id
	if (projectGetMatch && req.method === "PUT") {
		const body = await readBody(req);
		const updates: { name?: string; color?: string; rootPath?: string; palette?: string; colorLight?: string; colorDark?: string } = {};
		if (typeof body?.name === "string") updates.name = body.name;
		if (typeof body?.color === "string") updates.color = body.color;
		if (typeof body?.rootPath === "string") updates.rootPath = body.rootPath;
		if (typeof body?.palette === "string" || body?.palette === null || body?.palette === "") updates.palette = body.palette ?? "";
		if (typeof body?.colorLight === "string") updates.colorLight = body.colorLight;
		if (typeof body?.colorDark === "string") updates.colorDark = body.colorDark;
		try {
			const updated = projectRegistry.update(projectGetMatch[1], updates);
			json(updated);
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// DELETE /api/projects/:id
	//
	// Any project may be removed, including the last visible one. When zero
	// non-hidden projects remain the UI falls back to the existing
	// zero-project first-run state (see GR-09 / splash-no-projects spec).
	if (projectGetMatch && req.method === "DELETE") {
		const projectId = projectGetMatch[1];
		const project = projectRegistry.get(projectId);
		try {
			// Drain the project's worktree pool before removing
			await sessionManager.removeWorktreePool(projectId);
			// Terminate all live sessions belonging to the removed project
			const liveSessions = sessionManager.listSessions().filter(s => s.projectId === projectId);
			for (const s of liveSessions) {
				try { await sessionManager.terminateSession(s.id); } catch {}
			}
			projectContextManager.remove(projectId);
			if (project?.provisional) {
				projectRegistry.removeProvisional(projectId);
			} else {
				projectRegistry.remove(projectId);
			}
			json({ ok: true });
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/projects/:id/promote
	const projectPromoteMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/promote$/);
	if (projectPromoteMatch && req.method === "POST") {
		const projectId = projectPromoteMatch[1];
		try {
			const body = await readBody(req);
			const name = typeof body?.name === "string" ? body.name : undefined;
			const promoted = projectRegistry.promote(projectId, { name });
			json(promoted);
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// GET/PUT /api/projects/:id/config, GET /api/projects/:id/config/defaults, GET /api/projects/:id/config/resolved
	const projectConfigMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/config(?:\/(defaults|resolved))?$/);
	if (projectConfigMatch) {
		const ctx = projectContextManager.getOrCreate(projectConfigMatch[1]);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		const suffix = projectConfigMatch[2]; // undefined | "defaults" | "resolved"

		if (req.method === "GET" && !suffix) {
			const flat = ctx.projectConfigStore.getAll();
			// Upgrade migrated keys to native structured form for the wire response.
			const config: Record<string, unknown> = { ...flat };
			config.config_directories = ctx.projectConfigStore.getConfigDirectories();
			config.sandbox_tokens = ctx.projectConfigStore.getSandboxTokens();
			// Defence in depth: legacy top-level qa_* keys must never appear on
			// the wire. Migration removes them on boot; strip again here in case
			// a stale on-disk value slipped through.
			for (const k of LEGACY_QA_TOP_LEVEL_KEYS) delete config[k];
			mergeSecretsIntoTokens(config, ctx.secretsStore);
			json(redactSandboxSecrets(config));
			return;
		}
		if (req.method === "GET" && suffix === "defaults") {
			json(ctx.projectConfigStore.getDefaults());
			return;
		}
		if (req.method === "GET" && suffix === "resolved") {
			const defaults = ctx.projectConfigStore.getDefaults();
			const result: Record<string, { value: unknown; source: string }> = {};
			// Include all default keys
			for (const key of Object.keys(defaults)) {
				result[key] = resolveScalarConfig(key, ctx.projectConfigStore, projectConfigStore, null, defaults);
			}
			// Also include custom keys from the project's own config that aren't in defaults
			const rawConfig = ctx.projectConfigStore.getAll();
			for (const key of Object.keys(rawConfig)) {
				if (!(key in result)) {
					result[key] = { value: rawConfig[key], source: "project" };
				}
			}
			// Include custom keys from the server-level config that aren't already covered
			const serverRaw = projectConfigStore.getAll();
			for (const key of Object.keys(serverRaw)) {
				if (!(key in result)) {
					result[key] = { value: serverRaw[key], source: "server" };
				}
			}
			// Override migrated fields with structured values (resolveScalarConfig returns flat strings).
			const migratedSource = (key: string): string => {
				return (rawConfig[key] !== undefined && rawConfig[key] !== "") ? "project"
					: (serverRaw[key] !== undefined && serverRaw[key] !== "") ? "server"
					: "default";
			};
			result.config_directories = { value: ctx.projectConfigStore.getConfigDirectories(), source: migratedSource("config_directories") };
			result.sandbox_tokens = { value: ctx.projectConfigStore.getSandboxTokens(), source: migratedSource("sandbox_tokens") };
			// Defence in depth: strip legacy top-level qa_* keys.
			for (const k of LEGACY_QA_TOP_LEVEL_KEYS) delete result[k];
			// Merge secrets into sandbox_tokens (structured) for the resolved response.
			if (Array.isArray(result.sandbox_tokens.value)) {
				const tempConfig: Record<string, unknown> = { sandbox_tokens: result.sandbox_tokens.value };
				mergeSecretsIntoTokens(tempConfig, ctx.secretsStore);
				result.sandbox_tokens = { value: tempConfig.sandbox_tokens, source: result.sandbox_tokens.source };
			}
			json(redactSandboxSecretsResolved(result));
			return;
		}
		if (req.method === "PUT" && !suffix) {
			const body = await readBody(req);
			if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }

			// Reject legacy top-level qa_* keys — they have moved into
			// `components[<name>].config`. Done before any other parsing so the
			// error is fast and unambiguous.
			for (const key of LEGACY_QA_TOP_LEVEL_KEYS) {
				if (key in (body as Record<string, unknown>)) {
					json({ error: `${key} settings have moved to components[].config[]; set components[<name>].config.${key} instead` }, 400);
					return;
				}
			}

			// Validate components[].config eagerly (mirrors propose_project tool).
			{
				const err = validateComponentsConfig((body as Record<string, unknown>).components);
				if (err) { json({ error: err }, 400); return; }
			}

			// `base_ref` validation — runs only when the field is present in the PUT body.
			// On any failure we return HTTP 400 with `{ field: "base_ref", error, details? }`
			// so the Settings UI can render the error inline. Non-fatal warnings (component
			// paths that aren't git repos) bubble up via `baseRefWarnings` and are attached
			// to the success response below. See docs/design/base-ref.md.
			const baseRefWarnings: string[] = [];
			if ("base_ref" in (body as Record<string, unknown>)) {
				const rawBaseRef = (body as Record<string, unknown>).base_ref;
				const baseRefValue = typeof rawBaseRef === "string" ? rawBaseRef.trim() : "";
				if (baseRefValue) {
					// 1. SHA shape (7-40 hex chars). Reject before grammar — a 40-char hex
					//    string is grammatically valid but is rejected for clarity.
					if (/^[0-9a-f]{7,40}$/i.test(baseRefValue)) {
						json({ field: "base_ref", error: `base_ref must be a branch ref, not a commit SHA. Got: ${baseRefValue}` }, 400);
						return;
					}
					// 2. Invalid branch grammar.
					if (!isValidBaseRefBranchGrammar(baseRefValue)) {
						json({ field: "base_ref", error: `base_ref must be a valid branch name. Got: ${baseRefValue}` }, 400);
						return;
					}
					// 3. Non-origin remote prefix. Anything matching `<prefix>/<rest>` where
					//    `<prefix>` is not `origin` is rejected. Local refs (no slash, or
					//    `feature/foo`) are still accepted — the prefix gate only fires when
					//    the first segment looks like a remote name and isn't `origin`.
					//    We treat the first slash-segment as a remote prefix only when the
					//    full value is exactly `<prefix>/<rest>` AND `<rest>` looks like a
					//    branch (rather than e.g. `feature/foo` which has no remote prefix at all).
					//    Practically: if the value starts with anything other than `origin/`
					//    AND the first segment is a known-remote-shaped token, reject.
					//    We use a simple heuristic: if it doesn't start with `origin/` and
					//    its first segment contains no special chars and a slash exists,
					//    treat it as a remote prefix. The error message names the value
					//    so users can correct it.
					//
					// To avoid false positives on local refs like `feature/foo`, we only
					// reject values whose first segment matches the set of typical
					// remote names (upstream/fork/etc.). Today's design says: anything
					// with a remote-style prefix other than `origin/` is rejected, but
					// distinguishing local `feature/foo` from remote `upstream/foo`
					// requires git knowledge we don't have at validate time. The design
					// doc's error inventory specifically calls out `upstream/main` as the
					// example to reject — so we use a conservative allowlist: anything
					// matching a known remote-name pattern that isn't `origin` is rejected.
					// Known remote-shaped tokens: upstream, fork, mirror, github, gitlab,
					// bitbucket. Everything else flows through (local branches with slashes).
					const firstSegment = baseRefValue.split("/")[0];
					const KNOWN_NON_ORIGIN_REMOTES = new Set(["upstream", "fork", "mirror", "github", "gitlab", "bitbucket", "remote"]);
					if (baseRefValue.includes("/") && firstSegment !== "origin" && KNOWN_NON_ORIGIN_REMOTES.has(firstSegment)) {
						json({ field: "base_ref", error: `base_ref only supports the 'origin' remote today. Got: ${baseRefValue}. If you need a different primary remote, configure it as 'origin' in your local clone.` }, 400);
						return;
					}
					// 4. Sandbox + local — when the project runs in a docker sandbox, only
					//    remote refs work because the container has separate ref visibility
					//    from the host.
					const sandboxResolved = ctx.projectConfigStore.getWithDefaults().sandbox || "none";
					if (sandboxResolved === "docker" && !baseRefValue.startsWith("origin/")) {
						json({ field: "base_ref", error: `base_ref must be a remote ref (origin/...) for sandboxed projects. The container has separate ref visibility from the host. Got: ${baseRefValue}` }, 400);
						return;
					}
					// 5. Multi-repo ref existence — `git rev-parse --verify` against every
					//    component repo. Also detect tags up-front: a value that resolves
					//    via `refs/tags/<value>` in ANY component is rejected as a tag.
					const componentsForCheck = ctx.projectConfigStore.getComponents();
					const componentsToCheck = componentsForCheck.length > 0
						? componentsForCheck
						: [{ name: ctx.project.name || "default", repo: "." }];
					const failures: Array<{ component: string; message: string }> = [];
					let checkedRepoCount = 0;
					let tagDetected = false;
					for (const c of componentsToCheck) {
						const repoPath = path.join(ctx.project.rootPath, c.repo);
						const gitRepoCheck = await isGitRepo(repoPath).catch(() => false);
						if (!gitRepoCheck) {
							baseRefWarnings.push(`base_ref validation skipped for component '${c.name}': not a git repo at ${repoPath}`);
							continue;
						}
						checkedRepoCount++;
						// Tag check first — if the value resolves as a tag in any component
						// repo, fail with the tag-specific message rather than the generic
						// "not present" error.
						try {
							await execFileAsync("git", ["rev-parse", "--verify", `refs/tags/${baseRefValue}`], { cwd: repoPath, timeout: 5_000 });
							tagDetected = true;
							break;
						} catch {
							// Not a tag in this repo — continue with branch-ref check below.
						}
						try {
							await execFileAsync("git", ["rev-parse", "--verify", baseRefValue], { cwd: repoPath, timeout: 5_000 });
						} catch {
							failures.push({
								component: c.name,
								message: `ref not found. Try: cd ${c.repo} && git fetch origin`,
							});
						}
					}
					if (tagDetected) {
						json({ field: "base_ref", error: `base_ref must be a branch ref, not a tag. Tags can't be used as git upstreams. Got: ${baseRefValue}` }, 400);
						return;
					}
					if (failures.length > 0) {
						json({
							field: "base_ref",
							error: `base_ref '${baseRefValue}' is not present in ${failures.length} of ${checkedRepoCount} component repos`,
							details: failures,
						}, 400);
						return;
					}
				}
			}

			// Extract structured fields (components / workflows) before flat-key validation.
			let components = (body as Record<string, unknown>).components;
			const workflows = (body as Record<string, unknown>).workflows;
			delete (body as Record<string, unknown>).components;
			delete (body as Record<string, unknown>).workflows;

			// Back-compat: legacy top-level *_command fields (build_command, test_command, etc.)
			// are folded into components[0].commands when no `components` field was supplied.
			// This keeps the propose_project tool, the project assistant, and the provisional
			// promotion path working after Follow-up A removed the legacy schema. Existing
			// components stored on disk are not modified — callers who want to update components
			// must pass a fresh `components` array. See multi-repo follow-up Issue 2 / Issue 5.
			if (!Array.isArray(components)) {
				const LEGACY_KEY_MAP: Record<string, string> = {
					build_command: "build",
					test_command: "test",
					typecheck_command: "check",
					test_unit_command: "unit",
					test_e2e_command: "e2e",
				};
				const legacyCmds: Record<string, string> = {};
				for (const [legacyKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
					const v = (body as Record<string, unknown>)[legacyKey];
					if (typeof v === "string" && v.trim().length > 0) legacyCmds[newKey] = v.trim();
				}
				const legacyHook = (body as Record<string, unknown>).worktree_setup_command;
				const hasAnyLegacy = Object.keys(legacyCmds).length > 0
					|| (typeof legacyHook === "string" && legacyHook.trim().length > 0);
				if (hasAnyLegacy) {
					const existing = ctx.projectConfigStore.getComponents();
					const defaultName = existing[0]?.name || ctx.project.name || "default";
					const defaultRepo = existing[0]?.repo || ".";
					const mergedCommands = { ...(existing[0]?.commands ?? {}), ...legacyCmds };
					const defaultComponent: Record<string, unknown> = {
						name: defaultName,
						repo: defaultRepo,
						commands: mergedCommands,
					};
					if (existing[0]?.relativePath) defaultComponent.relative_path = existing[0].relativePath;
					const hookValue = (typeof legacyHook === "string" && legacyHook.trim().length > 0)
						? legacyHook.trim()
						: existing[0]?.worktreeSetupCommand;
					if (hookValue) defaultComponent.worktree_setup_command = hookValue;
					// Preserve existing per-component config (qa_* keys etc.) — the legacy
					// flat-key write path must not silently wipe it.
					if (existing[0]?.config && Object.keys(existing[0].config).length > 0) {
						defaultComponent.config = { ...existing[0].config };
					}
					// Replace the first component but preserve any additional components on disk.
					const remaining = existing.slice(1).map(c => {
						const entry: Record<string, unknown> = { name: c.name, repo: c.repo };
						if (c.relativePath) entry.relative_path = c.relativePath;
						if (c.worktreeSetupCommand) entry.worktree_setup_command = c.worktreeSetupCommand;
						if (c.commands) entry.commands = c.commands;
						if (c.config && Object.keys(c.config).length > 0) entry.config = { ...c.config };
						return entry;
					});
					components = [defaultComponent, ...remaining];
				}
				// Legacy flat keys remain in `body` so they are ALSO written as legacy
				// flat-config entries (preserves GET round-trip for existing API clients
				// that only know the legacy schema). The structural components mirror is
				// the source of truth for workflow steps and the Components UI.
			}

			// Validate ALL flat keys before writing ANY (atomic: all-or-nothing)
			for (const [key] of Object.entries(body)) {
				if (key.includes(".")) {
					json({ error: `Config key "${key}" must not contain dots` }, 400);
					return;
				}
			}

			// Validate workflows structurally if both components and workflows are present.
			if (components && workflows && Array.isArray(components) && typeof workflows === "object") {
				try {
					const { validateAllWorkflows } = await import("./agent/workflow-validator.js");
					const errors = validateAllWorkflows(
						workflows as Parameters<typeof validateAllWorkflows>[0],
						components as Parameters<typeof validateAllWorkflows>[1],
					);
					if (errors.length > 0) {
						json({ error: "Workflow validation failed", details: errors }, 400);
						return;
					}
				} catch (err) {
					console.warn("[server] workflow validation skipped:", err);
				}
			}

			// Native-YAML migrated fields: reject legacy string payloads (must be structured
			// types or null/empty to clear). For sandbox_tokens we still need to merge
			// redacted values via mergeSandboxSecrets; the merge helper now operates on
			// structured arrays.
			const migratedExtracted: Record<string, unknown> = {};
			const MIGRATED_FIELDS = [
				{ key: "config_directories", expect: "array" as const },
				{ key: "sandbox_tokens", expect: "array" as const },
			];
			for (const { key, expect } of MIGRATED_FIELDS) {
				if (!(key in body)) continue;
				const v = (body as Record<string, unknown>)[key];
				if (v === null || v === "") {
					migratedExtracted[key] = null;
					delete (body as Record<string, unknown>)[key];
					continue;
				}
				if (typeof v === "string") {
					json({ error: `Field "${key}" must be sent as a structured ${expect}, not a JSON-encoded string` }, 400);
					return;
				}
				if (expect === "array" && !Array.isArray(v)) {
					json({ error: `Field "${key}" must be an array` }, 400);
					return;
				}
				migratedExtracted[key] = v;
				delete (body as Record<string, unknown>)[key];
			}

			// Merge secrets for migrated structured sandbox_tokens, and for any legacy
			// keys that still carry inline credentials (sandbox_credentials).
			if (Array.isArray(migratedExtracted.sandbox_tokens)) {
				migratedExtracted.sandbox_tokens = mergeSandboxTokensStructured(
					migratedExtracted.sandbox_tokens as Array<{ key: string; enabled?: boolean; value?: string }>,
					ctx.secretsStore,
				);
			}
			mergeSandboxSecrets(body as Record<string, string>, ctx.projectConfigStore, ctx.secretsStore);

			// Write legacy flat keys.
			for (const [key, value] of Object.entries(body)) {
				if (value === null || value === "") {
					ctx.projectConfigStore.remove(key);
				} else if (typeof value === "string") {
					ctx.projectConfigStore.set(key, value);
				}
			}

			// Apply migrated structured fields via typed setters.
			if ("config_directories" in migratedExtracted) {
				const v = migratedExtracted.config_directories;
				if (v === null) {
					ctx.projectConfigStore.remove("config_directories");
				} else if (Array.isArray(v)) {
					ctx.projectConfigStore.setConfigDirectories(
						v.filter((e: any) => e && typeof e === "object" && typeof e.path === "string").map((e: any) => ({
							path: String(e.path),
							types: Array.isArray(e.types) ? e.types.filter((t: unknown): t is string => typeof t === "string") : [],
						})),
					);
				}
			}
			if ("sandbox_tokens" in migratedExtracted) {
				const v = migratedExtracted.sandbox_tokens;
				if (v === null) {
					ctx.projectConfigStore.remove("sandbox_tokens");
				} else if (Array.isArray(v)) {
					ctx.projectConfigStore.setSandboxTokens(
						v.filter((e: any) => e && typeof e === "object" && typeof e.key === "string").map((e: any) => ({
							key: String(e.key),
							enabled: e.enabled !== false,
						})),
					);
				}
			}

			// Persist structured fields if provided.
			if (Array.isArray(components)) {
				const normalized = (components as Array<Record<string, unknown>>).map(c => ({
					name: String(c.name ?? ""),
					repo: typeof c.repo === "string" && c.repo ? c.repo : ".",
					relativePath: typeof c.relative_path === "string" ? c.relative_path : (typeof c.relativePath === "string" ? c.relativePath as string : undefined),
					worktreeSetupCommand: typeof c.worktree_setup_command === "string" ? c.worktree_setup_command : (typeof c.worktreeSetupCommand === "string" ? c.worktreeSetupCommand as string : undefined),
					commands: c.commands && typeof c.commands === "object" && !Array.isArray(c.commands) ? c.commands as Record<string, string> : undefined,
					config: c.config && typeof c.config === "object" && !Array.isArray(c.config) ? c.config as Record<string, string> : undefined,
				}));
				ctx.projectConfigStore.setComponents(normalized);
			}
			if (workflows && typeof workflows === "object" && !Array.isArray(workflows)) {
				ctx.projectConfigStore.setWorkflows(workflows as Record<string, import("./agent/project-config-store.js").InlineWorkflowDef>);
			}

			if (baseRefWarnings.length > 0) {
				json({ ok: true, warnings: baseRefWarnings });
				return;
			}
			json({ ok: true });
			return;
		}
	}

	// GET /api/projects/:id/qa-testing-config
	const evConfigMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/qa-testing-config$/);
	if (evConfigMatch && req.method === "GET") {
		const ctx = projectContextManager.getOrCreate(evConfigMatch[1]);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		json({ configured: ctx.projectConfigStore.isQaConfiguredOnAnyComponent() });
		return;
	}

	// GET /api/search
	if (url.pathname === "/api/search" && req.method === "GET") {
		const q = url.searchParams.get("q");
		if (!q) {
			json({ error: "Missing query parameter 'q'" }, 400);
			return;
		}
		const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20), 100);
		const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
		const typeParam = url.searchParams.get("type") || "all";
		const validTypes = new Set(["all", "goals", "sessions", "messages", "staff"]);
		const type = validTypes.has(typeParam) ? typeParam as "all" | "goals" | "sessions" | "messages" | "staff" : "all";
		try {
			const projectId = url.searchParams.get("projectId") || undefined;
			const projectNames = new Map(projectRegistry.list().map(p => [p.id, p.name]));
			const results = await projectContextManager.searchAll(q, { type, limit, offset, projectId, projectNames });
			json(results);
		} catch (err) {
			json({ error: `Search failed: ${err}` }, 500);
		}
		return;
	}

	// BFS helper: walk delegateOf, teamLeadSessionId, teamGoalId, and goalId chains
	// from seed IDs through an archived session pool.
	function bfsEnrichArchived(seedIds: string[], allArchived: any[]): any[] {
		const result: any[] = [];
		const seen = new Set<string>();
		const queue = [...seedIds];
		while (queue.length > 0) {
			const parentId = queue.shift()!;
			for (const s of allArchived) {
				if (!seen.has(s.id) && (
					s.delegateOf === parentId ||
					s.teamLeadSessionId === parentId ||
					s.teamGoalId === parentId ||
					s.goalId === parentId
				)) {
					seen.add(s.id);
					result.push(s);
					queue.push(s.id);
				}
			}
		}
		return result;
	}

	// GET /api/sessions
	if (url.pathname === "/api/sessions" && req.method === "GET") {
		const currentGen = projectContextManager.getSessionGeneration();
		const sinceParam = url.searchParams.get("since");
		if (sinceParam !== null) {
			const since = parseInt(sinceParam, 10);
			if (!isNaN(since) && since === currentGen) {
				json({ generation: currentGen, changed: false });
				return;
			}
		}
		const filterProjectId = url.searchParams.get("projectId") || undefined;
		const registeredProjectIds = new Set(projectRegistry.list().map(p => p.id));
		let sessions = sessionManager.listSessions().map((s) => ({
			...s,
			colorIndex: colorStore.get(s.id),
		})).filter(s => !s.projectId || registeredProjectIds.has(s.projectId));
		if (filterProjectId) {
			sessions = sessions.filter(s => s.projectId === filterProjectId);
		}
		// Support ?include=archived to return archived sessions too
		if (url.searchParams.get("include") === "archived") {
			// Collect archived sessions across all project contexts
			const allArchived: typeof sessions = [];
			for (const ctx of projectContextManager.visible()) {
				const store = ctx.sessionStore;
				for (const s of store.getArchived()) {
					allArchived.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" } as any);
				}
			}
			// Sort by archivedAt descending
			allArchived.sort((a: any, b: any) => ((b as any).archivedAt ?? 0) - ((a as any).archivedAt ?? 0));
			// Apply projectId filter if present
			const filteredArchived = filterProjectId
				? allArchived.filter((s: any) => s.projectId === filterProjectId)
				: allArchived;

			// Collect ALL archived sessions for BFS enrichment (not just delegates)
			const allArchivedForBfs: typeof sessions = [];
			for (const ctx of projectContextManager.visible()) {
				for (const s of ctx.sessionStore.getArchived()) {
					allArchivedForBfs.push({ ...s, colorIndex: colorStore.get(s.id), archived: true } as any);
				}
			}
			// Build live goal IDs for BFS seeding
			const liveGoalIds: string[] = [];
			for (const ctx of projectContextManager.visible()) {
				for (const g of ctx.goalStore.getLive()) {
					if (!g.archived) liveGoalIds.push(g.id);
				}
			}

			const limitParam = url.searchParams.get("limit");
			const afterParam = url.searchParams.get("after");
			if (limitParam) {
				// Paginated archived sessions
				const limit = Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200);
				const afterCursor = afterParam ? parseInt(afterParam, 10) : undefined;
				let page = filteredArchived;
				if (afterCursor !== undefined) {
					page = page.filter((s: any) => ((s as any).archivedAt ?? 0) < afterCursor);
				}
				const total = filteredArchived.length;
				const hasMore = page.length > limit;
				const sliced = page.slice(0, limit);
				const nextCursor = sliced.length > 0 ? (sliced[sliced.length - 1] as any).archivedAt : undefined;

				// BFS: collect archived children reachable from live sessions and goals
				const liveIdSet = new Set(sessions.map(s => s.id));
				const archivedDelegatesOfLive = bfsEnrichArchived([...liveIdSet, ...liveGoalIds], allArchivedForBfs);

				json({ generation: currentGen, sessions: [...sessions, ...sliced], total, hasMore, nextCursor, archivedDelegates: archivedDelegatesOfLive });
			} else {
				// BFS: collect archived children reachable from live sessions and goals
				const liveIdSet = new Set(sessions.map(s => s.id));
				const archivedDelegatesOfLive = bfsEnrichArchived([...liveIdSet, ...liveGoalIds], allArchivedForBfs);

				// Backward compatible: return all archived sessions
				json({ generation: currentGen, sessions: [...sessions, ...filteredArchived], archivedDelegates: archivedDelegatesOfLive });
			}
		} else {
			// Always include archived children of live sessions/goals so the sidebar
			// can render chevrons/nesting without a separate fetch.
			const liveIdSet = new Set(sessions.map(s => s.id));
			const allArchivedForBfsNonPaginated: typeof sessions = [];
			for (const ctx of projectContextManager.visible()) {
				for (const s of ctx.sessionStore.getArchived()) {
					allArchivedForBfsNonPaginated.push({ ...s, colorIndex: colorStore.get(s.id), archived: true } as any);
				}
			}
			// Build live goal IDs for BFS seeding
			const liveGoalIdsNonPaginated: string[] = [];
			for (const ctx of projectContextManager.visible()) {
				for (const g of ctx.goalStore.getLive()) {
					if (!g.archived) liveGoalIdsNonPaginated.push(g.id);
				}
			}
			// BFS: live parents/goals → their archived children → children of those, etc.
			const archivedDelegatesOfLive = bfsEnrichArchived([...liveIdSet, ...liveGoalIdsNonPaginated], allArchivedForBfsNonPaginated);
			json({ generation: currentGen, sessions, archivedDelegates: archivedDelegatesOfLive });
		}
		return;
	}

	// POST /api/sessions/:id/activate-skill — autonomous skill activation
	const activateSkillMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/activate-skill$/);
	if (activateSkillMatch && req.method === "POST") {
		const sessionId = activateSkillMatch[1];
		const session = sessionManager.getSession(sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		const body = await readBody(req);
		const skillName = typeof body?.name === "string" ? body.name : "";
		const skillArgs = typeof body?.args === "string" ? body.args : "";
		if (!skillName) {
			json({ error: "name is required" }, 400);
			return;
		}
		// Resolve skill discovery context: host-side cwd + per-project store.
		let resolvedConfigStore: { get(key: string): string | undefined } | undefined = projectConfigStore;
		let skillCwd = session.cwd;
		if (session.projectId) {
			const pcm = (sessionManager as any).projectContextManager as import("./agent/project-context-manager.js").ProjectContextManager | undefined;
			const ctx = pcm?.getOrCreate(session.projectId);
			if (ctx) {
				resolvedConfigStore = ctx.projectConfigStore;
				if (session.sandboxed) skillCwd = ctx.project.rootPath;
			}
		}
		const skill = getSlashSkill(skillCwd, skillName, resolvedConfigStore);
		if (!skill) {
			json({ error: `Skill "${skillName}" not found` }, 404);
			return;
		}
		if (skill.disableModelInvocation === true) {
			json({ error: `Skill "${skillName}" has disable-model-invocation: true and cannot be activated by the model` }, 403);
			return;
		}
		// Inject the activation header so autonomous activation is byte-equal
		// to user `/<name>` invocation.
		const pathRewrite = session.sandboxed
			? (hostPath: string): string | null => {
				// Project worktree mounts at /workspace; rewrite when the host
				// path lives under it. Built-in / personal skills aren't mounted.
				const projectRoot = (session.projectId
					? ((sessionManager as any).projectContextManager as import("./agent/project-context-manager.js").ProjectContextManager | undefined)?.getOrCreate(session.projectId)?.project.rootPath
					: undefined);
				const normHost = hostPath.replace(/\\/g, "/");
				const normProj = projectRoot ? projectRoot.replace(/\\/g, "/") : null;
				const sessionCwdNorm = session.cwd.replace(/\\/g, "/");
				for (const candidate of [normProj, sessionCwdNorm]) {
					if (candidate && (normHost === candidate || normHost.startsWith(candidate + "/"))) {
						const rel = normHost.slice(candidate.length).replace(/^\/+/, "");
						return "/workspace" + (rel ? "/" + rel : "");
					}
				}
				return null;
			}
			: undefined;
		const skillBody = buildSlashSkillPrompt(skill, skillArgs);
		const expanded = buildActivationHeader(skill, pathRewrite) + skillBody;
		json({ ok: true, expanded, source: skill.source, filePath: skill.filePath });
		return;
	}

	// POST /api/sessions/:id/tool-grant-request — long-polling endpoint called by guard extension
	const toolGrantMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/tool-grant-request$/);
	if (toolGrantMatch && req.method === "POST") {

		const sessionId = toolGrantMatch[1];
		const body = await readBody(req);
		if (!body || !body.toolName || !body.toolGroup) {
			json({ error: "toolName and toolGroup required" }, 400);
			return;
		}
		try {
			const result = await sessionManager.requestToolGrant(sessionId, body.toolName, body.toolGroup);
			json(result);
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// GET /api/sessions/:id (exact match — not /api/sessions/:id/output etc.)
	const singleSessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (singleSessionMatch && req.method === "GET") {
		const id = singleSessionMatch[1];
		const session = sessionManager.getSession(id);
		if (!session) {
			// Check if it's an archived session
			const archived = sessionManager.getArchivedSession(id);
			if (archived) {
				json({
					id: archived.id,
					title: archived.title,
					cwd: archived.cwd,
					projectId: archived.projectId,
					status: "archived",
					createdAt: archived.createdAt,
					lastActivity: archived.lastActivity,
					clientCount: 0,
					isCompacting: false,
					goalId: archived.goalId,
					assistantType: archived.assistantType,
					delegateOf: archived.delegateOf,
					role: archived.role,
					teamGoalId: archived.teamGoalId,
					teamLeadSessionId: archived.teamLeadSessionId,
					worktreePath: archived.worktreePath,
					taskId: archived.taskId,
					staffId: archived.staffId,
					colorIndex: colorStore.get(archived.id),
					preview: archived.preview,
					reattemptGoalId: archived.reattemptGoalId,
					archived: true,
					archivedAt: archived.archivedAt,
					imageGenerationModel: sessionManager.getImageModelForSession(archived.id),
				});
				return;
			}
			res.writeHead(404);
			res.end(JSON.stringify({ error: "Session not found" }));
			return;
		}
		const sessionPs = sessionManager.getSessionStore(session.projectId).get(session.id);
		json({
			id: session.id,
			title: session.title,
			cwd: session.cwd,
			status: session.status,
			createdAt: session.createdAt,
			lastActivity: session.lastActivity,
			clientCount: session.clients.size,
			isCompacting: session.isCompacting,
			goalId: session.goalId,
			assistantType: session.assistantType,
			// Legacy boolean fields for backward compat
			goalAssistant: session.assistantType === "goal",
			roleAssistant: session.assistantType === "role",
			toolAssistant: session.assistantType === "tool",
			delegateOf: session.delegateOf,
			role: session.role,
			teamGoalId: session.teamGoalId,
			teamLeadSessionId: session.teamLeadSessionId,
			worktreePath: session.worktreePath,
			branch: session.branch ?? sessionPs?.branch,
			taskId: session.taskId,
			staffId: session.staffId,
			colorIndex: colorStore.get(session.id),
			preview: session.preview,
			reattemptGoalId: sessionPs?.reattemptGoalId,
			projectId: sessionPs?.projectId || session.projectId,
			// Persisted model selection (provider+id). Surfaces the result of
			// the WS `set_model` handler's `persistSessionModel` call so clients
			// (and tests) can verify the selection round-tripped to disk without
			// reaching into the WS state stream.
			modelProvider: sessionPs?.modelProvider,
			modelId: sessionPs?.modelId,
			restoreError: session.restoreError,
			lastTurnErrored: session.lastTurnErrored ?? false,
			consecutiveErrorTurns: session.consecutiveErrorTurns ?? 0,
			completedTurnCount: session.completedTurnCount ?? 0,
			imageGenerationModel: sessionManager.getImageModelForSession(session.id),
		});
		return;
	}

	// POST /api/sessions
	if (url.pathname === "/api/sessions" && req.method === "POST") {
		const __t0 = performance.now();
		try {
		const body = await readBody(req);

		// ── Delegate session creation ──
		if (body?.delegateOf && body?.instructions) {
			// Sandbox guard: delegate parent must be own session or registered child
			if (sandboxScope) {
				const parentId = body.delegateOf;
				if (!sandboxScope.sessionIds.has(parentId)) {
					json({ error: "Forbidden: delegate parent must be own session" }, 403);
					return;
				}
			}
			try {
				const cwd = body.cwd || config.defaultCwd;
				const session = await sessionManager.createDelegateSession(body.delegateOf, {
					instructions: body.instructions,
					cwd,
					title: body.title,
					context: body.context,
				});
				// Register delegate as child in parent's sandbox scope
				if (sandboxScope && sandboxTokenStore) {
					sandboxTokenStore.addSession(sandboxScope.projectId, session.id);
				}
				json({
					id: session.id,
					cwd: session.cwd,
					status: session.status,
					delegateOf: session.delegateOf,
				}, 201);
			} catch (err) {
				jsonError(500, err);
			}
			return;
		}

		// ── Normal session creation ──
		const goalId = body?.goalId;

		// Accept both new assistantType and legacy boolean fields
		let assistantType = body?.assistantType as string | undefined;
		if (!assistantType) {
			if (body?.goalAssistant) assistantType = "goal";
			else if (body?.roleAssistant) assistantType = "role";
			else if (body?.toolAssistant) assistantType = "tool";
		}

		// If creating under a goal, use the goal's cwd as default
		let cwd = body?.cwd || config.defaultCwd;
		// If a projectId is provided and no explicit cwd, use the project's rootPath
		if (!body?.cwd && body?.projectId && typeof body.projectId === "string") {
			const proj = projectRegistry.get(body.projectId);
			if (proj) cwd = proj.rootPath;
		}
		if (goalId) {
			const goal = getGoalAcrossProjects(goalId);
			if (goal) {
				cwd = body?.cwd || goal.cwd;
				// Auto-transition goal to in-progress when first session starts
				if (goal.state === "todo") {
					await getGoalManagerForGoal(goalId).updateGoal(goalId, { state: "in-progress" });
				}
			}
		}

		const args = body?.args;

		// If a roleId is provided, look up the role and pass its prompt/tools/accessory
		const roleId = body?.roleId;
		let createOpts: { rolePrompt?: string; roleName?: string; role?: string; accessory?: string } | undefined;

		if (roleId && typeof roleId === "string") {
			const role = roleManager.getRole(roleId);
			if (!role) {
				json({ error: `Role "${roleId}" not found` }, 404);
				return;
			}
			createOpts = {
				rolePrompt: role.promptTemplate,
				roleName: role.name,
				role: role.name,
				accessory: role.accessory,
			};
		}

		// ── Worktree support ──
		// Non-assistant, non-goal sessions get a worktree by default unless explicitly opted out.
		// Goal sessions have their own worktree logic via goalManager.setupWorktreeAndStartTeam().
		// Resolution of `worktreeOpts` is deferred until after `resolvedProjectId` is
		// finalised below — multi-repo (poly-repo) projects need the project's container
		// rootPath as repoPath, not `getRepoRoot(cwd)` (which fails for non-git containers).
		let worktreeOpts: { repoPath: string } | undefined;
		const wantWorktree = shouldCreateWorktree({ worktree: body?.worktree, assistantType, goalId }, true);

		// ── Re-attempt support ──
		const reattemptGoalId = body?.reattemptGoalId as string | undefined;

		// ── Sandbox validation ──
		// Sandbox-scoped tokens MUST create sandboxed sessions — prevent escape
		let sandboxed = body?.sandboxed === true;
		if (sandboxScope) sandboxed = true;
		if (sandboxed) {
			const sandboxConfig = projectConfigStore.get("sandbox") || "none";
			if (sandboxConfig !== "docker") {
				json({ error: "Docker sandbox is not configured. Set sandbox: \"docker\" in project settings." }, 400);
				return;
			}
			// Skip Docker check if sandbox manager has ready containers.
			// Otherwise use a cached result to avoid running `docker info` on every session creation.
			const hasReadyContainer = sessionManager.getSandboxManager()?.getStats().containers.some(c => c.status === "ready") ?? false;
			if (!hasReadyContainer) {
				if (!_dockerAvailCache || Date.now() - _dockerAvailCache.ts > 60_000) {
					const dockerStatus = await checkDockerAvailability();
					_dockerAvailCache = { available: dockerStatus.available, error: dockerStatus.error, ts: Date.now() };
				}
				if (!_dockerAvailCache.available) {
					json({ error: `Docker is not available: ${_dockerAvailCache.error || "Docker not detected"}` }, 503);
					return;
				}
			}
		}

		// Auto-detect projectId from cwd if not explicitly provided.
		// Project assistant sessions (assistantType "project" or "project-scaffolding") are
		// setting up a NEW project — they get a provisional project registration so sessions
		// persist under their own project context (survives page refresh).
		const isProjectAssistant = assistantType === "project" || assistantType === "project-scaffolding";
		// Role/Tool assistants edit server-scope config and do not require a
		// project. When the client supplies a projectId we still attach to it (the
		// Roles page can be scoped to a project); otherwise we skip project
		// resolution entirely so `npx bobbit` in a non-project directory works.
		// Staff assistants are project-scoped — they must resolve a project the
		// same way `goal` assistants do (see the surface-staff-in-sessions design).
		const isServerScopeAssistant = assistantType === "role" || assistantType === "tool";
		let resolvedProjectId = body?.projectId as string | undefined;
		let provisionalProjectId: string | undefined;

		// If re-attempting a goal, inherit cwd and projectId from the original goal
		if (reattemptGoalId && !body?.cwd) {
			const origGoal = getGoalAcrossProjects(reattemptGoalId);
			if (origGoal) {
				cwd = origGoal.cwd || cwd;
				if (!resolvedProjectId && origGoal.projectId) resolvedProjectId = origGoal.projectId;
			}
		}

		// Guard against stale cwd (e.g. re-attempting a goal whose worktree was deleted,
		// or a project whose rootPath is gone). spawn(process.execPath, { cwd }) on Windows
		// reports a missing cwd as ENOENT, masquerading as if the `node` binary was missing.
		// Fall back to the project rootPath when we have a resolved project to anchor the
		// fallback. If no project is resolved yet, leave cwd alone — the resolver below
		// will reject a bogus cwd with the canonical 400 rather than silently rewriting
		// it to defaultCwd (which would mask user error and match an unrelated project).
		if (cwd && !fs.existsSync(cwd) && resolvedProjectId) {
			const staleCwd = cwd;
			const proj = projectRegistry.get(resolvedProjectId);
			let fallback: string | undefined;
			if (proj && fs.existsSync(proj.rootPath)) fallback = proj.rootPath;
			if (!fallback && fs.existsSync(config.defaultCwd)) fallback = config.defaultCwd;
			if (fallback) {
				console.warn(`[POST /api/sessions] cwd ${staleCwd} does not exist — falling back to ${fallback}`);
				cwd = fallback;
			} else {
				json({ error: `Working directory does not exist: ${staleCwd}` }, 400);
				return;
			}
		}

		// For project assistants, register a provisional project at the target cwd
		if (isProjectAssistant && cwd && !resolvedProjectId) {
			const provisionalProject = projectRegistry.registerProvisional(path.basename(cwd), cwd);
			provisionalProjectId = provisionalProject.id;
			resolvedProjectId = provisionalProject.id;
			// Ensure a ProjectContext exists for the provisional project
			const provCtx = projectContextManager.getOrCreate(provisionalProject.id);
			if (provCtx) {
				provCtx.gateStore.onStatusChange = () => {
					provCtx.goalStore.bumpGeneration();
				};
			}
		}

		// Project must be resolvable explicitly or from cwd — no silent default fallback.
		// (Provisional-project handling above may already have set resolvedProjectId;
		// if so, skip the resolver.)
		// Server-scope assistants (role/tool/staff) without an explicit projectId
		// anchor at the synthetic system project so they have a valid persistence
		// store without forcing the user to register a real project.
		if (!resolvedProjectId && isServerScopeAssistant) {
			resolvedProjectId = SYSTEM_PROJECT_ID;
		} else if (!resolvedProjectId) {
			const resolved = resolveProjectForRequest(projectRegistry, projectContextManager, { projectId: body?.projectId, cwd });
			if (!resolved.ok) { json({ error: resolved.error }, resolved.status); return; }
			resolvedProjectId = resolved.projectId;
		}

		// Now that `resolvedProjectId` is known, resolve `worktreeOpts`.
		// Multi-repo (poly-repo) short-circuit mirrors goal-manager.ts::createGoal:
		// if any component has repo !== ".", the project's rootPath IS the repoPath
		// even though it isn't itself a git repo. Without this, the `isGitRepo(cwd)`
		// check below returns false for the container directory and sessions would
		// run with no worktree at all.
		if (wantWorktree) {
			try {
				const projCtx = resolvedProjectId ? projectContextManager.getOrCreate(resolvedProjectId) : undefined;
				const proj = resolvedProjectId ? projectRegistry.get(resolvedProjectId) : undefined;
				const isMulti = !!projCtx?.projectConfigStore.isMultiRepo();
				if (isMulti && proj?.rootPath) {
					worktreeOpts = { repoPath: proj.rootPath };
				} else if (await isGitRepo(cwd)) {
					const repoPath = await getRepoRoot(cwd);
					worktreeOpts = { repoPath };
				}
			} catch {
				// Not a git repo or git not available — silently ignore
			}
		}

		// ── Sandbox auto-branch ──
		// For sandboxed non-goal, non-assistant sessions, generate a branch so they get
		// a container worktree instead of defaulting to /workspace.
		let autoSandboxBranch: string | undefined;
		if (sandboxed && !goalId && !assistantType) {
			const shortId = randomUUID().slice(0, 8);
			autoSandboxBranch = `session/s-${shortId}`;
		}

		try {
			const session = await sessionManager.createSession(cwd, args, goalId, assistantType, { ...createOpts, worktreeOpts, reattemptGoalId, sandboxed, projectId: resolvedProjectId, ...(autoSandboxBranch ? { sandboxBranch: autoSandboxBranch } : {}) });

			// Set assistant role metadata if no explicit role was provided
			if (!createOpts?.role && assistantType) {
				sessionManager.updateSessionMeta(session.id, { role: "assistant", accessory: "wand" });
				session.role = "assistant";
				session.accessory = "wand";
			}

			// Store reattemptGoalId on the session if provided
			if (reattemptGoalId) {
				sessionManager.getSessionStore(session.projectId).update(session.id, { reattemptGoalId });
			}

			// Store projectId on the session if resolved (explicit or auto-detected).
			// Project assistant sessions keep their provisional projectId so they
			// persist under the provisional project's store and appear in the sidebar.
			if (resolvedProjectId) {
				sessionManager.getSessionStore(session.projectId).update(session.id, { projectId: resolvedProjectId });
			}

			json({
				id: session.id,
				cwd: session.cwd,
				status: session.status,
				goalId: session.goalId,
				assistantType: session.assistantType,
				// Legacy boolean fields for backward compat
				goalAssistant: session.assistantType === "goal",
				roleAssistant: session.assistantType === "role",
				toolAssistant: session.assistantType === "tool",
				role: session.role,
				accessory: session.accessory,
				reattemptGoalId,
				...(provisionalProjectId ? { provisionalProjectId } : {}),
			}, 201);
		} catch (err) {
			// Log full error context server-side so that flaky 500s in tests
			// (e.g. resilience suite under FS contention) leave a usable trail.
			// `String(err)` alone drops the stack and any error.cause chain.
			const e = err as Error & { code?: string; cause?: unknown };
			console.error(
				`[POST /api/sessions] failed cwd=${cwd ?? "(none)"} project=${resolvedProjectId ?? "(none)"} ` +
				`goal=${goalId ?? "(none)"} assistant=${assistantType ?? "(none)"} sandbox=${sandboxed ? "yes" : "no"}: ` +
				`${e.message ?? String(err)}\n${e.stack ?? ""}`,
			);
			if (e.cause) console.error("  caused by:", e.cause);
			json({
				error: String(err),
				message: e.message,
				code: e.code,
				cause: e.cause ? String(e.cause) : undefined,
			}, 500);
		}
		return;
		} finally {
			recordElapsed("POST /api/sessions", performance.now() - __t0);
		}
	}

	// ── Nested-goal endpoints ─────────────────────────────────────
	// REST surface for the team-lead-only `goal_*` tools. Implementation in
	// `nested-goal-routes.ts`. Cascade-affecting routes require explicit
	// `cascade` (422 otherwise). UI is the cascade-policy authority.
	if (await tryHandleNestedGoalRoute(req, url, {
		projectContextManager,
		verificationHarness,
		teamManager,
		sessionManager,
		requireSubgoalsEnabled,
		getGoalAcrossProjects,
		getGoalManagerForGoal,
		readBody,
		json,
		jsonError,
		broadcastToAll,
		getSubgoalNestingPrefs: () => readSubgoalNestingPrefs((k) => preferencesStore.get(k)),
	})) return;

	// ── Goal endpoints ─────────────────────────────────────────────

	// GET /api/goals
	if (url.pathname === "/api/goals" && req.method === "GET") {
		// Paginated archived goals — aggregate across all projects
		if (url.searchParams.get("archived") === "true") {
			const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50), 200);
			const afterParam = url.searchParams.get("after");
			const afterCursor = afterParam ? parseInt(afterParam, 10) : undefined;
			const filterProjectId = url.searchParams.get("projectId") || undefined;
			// Aggregate archived goals across all project contexts
			let allArchived: PersistedGoal[] = [];
			for (const ctx of projectContextManager.visible()) {
				if (filterProjectId && ctx.project.id !== filterProjectId) continue;
				allArchived.push(...ctx.goalStore.getArchived());
			}
			allArchived.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
			const total = allArchived.length;
			if (afterCursor !== undefined) {
				allArchived = allArchived.filter(g => (g.archivedAt ?? 0) < afterCursor);
			}
			const page = allArchived.slice(0, limit);
			const hasMore = allArchived.length > limit;
			const nextCursor = page.length > 0 ? page[page.length - 1].archivedAt : undefined;

			// Collect archived sessions affiliated with goals in this page
			const goalIdsInPage = new Set(page.map((g: any) => g.id));
			const affiliatedSessions: any[] = [];
			const seenSessionIds = new Set<string>();
			for (const ctx of projectContextManager.visible()) {
				for (const s of ctx.sessionStore.getArchived()) {
					if (!seenSessionIds.has(s.id) && (goalIdsInPage.has((s as any).teamGoalId) || goalIdsInPage.has((s as any).goalId))) {
						seenSessionIds.add(s.id);
						affiliatedSessions.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" });
					}
				}
			}
			// BFS walk delegate/team chains from affiliated sessions
			const allArchivedForGoalsBfs: any[] = [];
			for (const ctx of projectContextManager.visible()) {
				for (const s of ctx.sessionStore.getArchived()) {
					allArchivedForGoalsBfs.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" });
				}
			}
			const delegateEnriched = bfsEnrichArchived(affiliatedSessions.map(s => s.id), allArchivedForGoalsBfs);
			for (const s of delegateEnriched) {
				if (!seenSessionIds.has(s.id)) {
					seenSessionIds.add(s.id);
					affiliatedSessions.push(s);
				}
			}

			json({ goals: page, total, hasMore, nextCursor, archivedSessions: affiliatedSessions });
			return;
		}

		const currentGen = projectContextManager.getGoalGeneration();
		const sinceParam = url.searchParams.get("since");
		if (sinceParam !== null) {
			const since = parseInt(sinceParam, 10);
			if (!isNaN(since) && since === currentGen) {
				json({ generation: currentGen, changed: false });
				return;
			}
		}
		const filterProjectId = url.searchParams.get("projectId") || undefined;
		const goals = listGoalsAcrossProjects({ projectId: filterProjectId });
		json({ generation: currentGen, goals });
		return;
	}

	// POST /api/goals
	if (url.pathname === "/api/goals" && req.method === "POST") {
		const body = await readBody(req);
		const title = body?.title;
		let cwd = body?.cwd || config.defaultCwd;
		// If a projectId is provided and no explicit cwd, use the project's rootPath
		if (!body?.cwd && body?.projectId && typeof body.projectId === "string") {
			const proj = projectRegistry.get(body.projectId);
			if (proj) cwd = proj.rootPath;
		}
		const spec = body?.spec || "";
		const workflowId = (body?.workflowId && typeof body.workflowId === "string") ? body.workflowId : "general";
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		try {
			const sandboxed = body.sandboxed === true;
			const autoStartTeam = body.autoStartTeam !== false; // default true
			let enabledOptionalSteps: string[] | undefined;
			if (Array.isArray(body.enabledOptionalSteps) && body.enabledOptionalSteps.every((s: unknown) => typeof s === "string")) {
				enabledOptionalSteps = body.enabledOptionalSteps;
			}
			// Resolve target project — explicit projectId or cwd-match. No fallback.
			const resolved = resolveProjectForRequest(projectRegistry, projectContextManager, { projectId: body.projectId, cwd });
			if (!resolved.ok) { json({ error: resolved.error }, resolved.status); return; }
			const targetProjectId = resolved.projectId;
			// If caller passed a projectId but no cwd, use the project's rootPath.
			if (!body?.cwd) cwd = resolved.project.rootPath;
			const targetCtx = projectContextManager.getOrCreate(targetProjectId);
			if (!targetCtx) {
				json({ error: "Invalid project" }, 400);
				return;
			}
			// Lazy per-project sandbox init — idempotent, deduped by SandboxManager.
			if (sandboxed && sandboxManager) {
				try {
					await sandboxManager.ensureForProject(targetProjectId);
				} catch (err) {
					jsonError(500, err, { error: `Sandbox init failed: ${(err as Error).message || err}` });
					return;
				}
			}
			const targetGoalManager = targetCtx.goalManager;
			// Cascade: body.workflow → workflowId lookup → auto-seed → first match.
			let resolvedWorkflow: Workflow | undefined;
			let resolvedWorkflowId = workflowId;
			const inlineWorkflow = body?.workflow;
			if (inlineWorkflow && typeof inlineWorkflow === "object") {
				resolvedWorkflow = inlineWorkflow as Workflow;
				resolvedWorkflowId = (inlineWorkflow as { id?: string }).id || workflowId;
			} else {
				// Layer 1: cascade lookup (only when workflowId given).
				if (workflowId) {
					const cascadeWorkflows = configCascade.resolveWorkflows(targetProjectId);
					resolvedWorkflow = cascadeWorkflows.find(r => r.item.id === workflowId)?.item;
					// Layer 1b: cascade miss — fall through to project store directly.
					if (!resolvedWorkflow) {
						resolvedWorkflow = targetCtx.workflowStore.get(workflowId);
					}
				}
				// Layer 2: store is empty → auto-seed defaults.
				if (!resolvedWorkflow && targetCtx.workflowStore.getAll().length === 0) {
					const projName = resolved.project.name || "project";
					const seeds = buildDefaultWorkflows(projName);
					seeds.parent = buildParentWorkflow();
					for (const wf of Object.values(seeds)) {
						targetCtx.workflowStore.put(wf as unknown as Workflow);
					}
					console.log(`[api] Auto-seeded ${Object.keys(seeds).length} default workflows for project "${projName}" on first goal creation`);
					if (workflowId) {
						resolvedWorkflow = targetCtx.workflowStore.get(workflowId);
					} else {
						resolvedWorkflow = targetCtx.workflowStore.get("general") ?? targetCtx.workflowStore.getAll()[0];
						resolvedWorkflowId = resolvedWorkflow?.id || "general";
					}
				}
				// Layer 3: explicit id given, store non-empty, still unknown → friendly 400.
				if (workflowId && !resolvedWorkflow && targetCtx.workflowStore.getAll().length > 0) {
					const available = targetCtx.workflowStore.getAll().map(w => w.id);
					jsonError(400, new Error(`Workflow "${workflowId}" not found`), {
						error: `Workflow "${workflowId}" not found. Available: ${available.join(", ")}`,
						code: "WORKFLOW_NOT_FOUND",
						workflowId,
						available,
					});
					return;
				}
			}
			const goal = await targetGoalManager.createGoal(title, cwd, {
				spec,
				workflowId: resolvedWorkflowId,
				workflowStore: targetCtx.workflowStore,
				resolvedWorkflow,
				sandboxed,
				enabledOptionalSteps,
				projectId: targetProjectId,
			});
			// Set projectId (explicit or auto-detected from cwd)
			if (targetProjectId) {
				targetGoalManager.updateGoal(goal.id, { projectId: targetProjectId });
				goal.projectId = targetProjectId;
			}
			// Set reattemptOf if provided
			if (body.reattemptOf && typeof body.reattemptOf === "string") {
				targetGoalManager.updateGoal(goal.id, { reattemptOf: body.reattemptOf });
				goal.reattemptOf = body.reattemptOf;
			}
			// Persist autoStartTeam flag
			targetGoalManager.updateGoal(goal.id, { autoStartTeam });
			goal.autoStartTeam = autoStartTeam;
			// Initialize gate states for the workflow
			if (goal.workflow) {
				targetCtx.gateStore.initGatesForGoal(goal.id, goal.workflow.gates.map(g => g.id));
			}
			json(goal, 201);

			// Fire-and-forget async worktree setup (and optionally start team)
			if (goal.setupStatus === "preparing") {
				if (goal.autoStartTeam) {
					targetGoalManager.setupWorktreeAndStartTeam(goal.id, () => teamManager.startTeam(goal.id)).then(() => {
						broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
					}).catch((err) => {
						const g = targetGoalManager.getGoal(goal.id);
						if (g?.setupStatus === "ready") {
							broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
							console.error("[goal] Auto-start team failed (worktree ready):", err);
						} else {
							broadcastToAll({ type: "goal_setup_error", goalId: goal.id, error: String(err) });
						}
					});
				} else {
					targetGoalManager.setupWorktree(goal.id).then(() => {
						broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
					}).catch((err) => {
						broadcastToAll({ type: "goal_setup_error", goalId: goal.id, error: String(err) });
					});
				}
			}
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/goals/:id/retry-setup � retry worktree setup for a goal in error state
	const retrySetupMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/retry-setup$/);
	if (retrySetupMatch && req.method === "POST") {
		const goalId = retrySetupMatch[1];
		const retryGoalManager = getGoalManagerForGoal(goalId);
		const ok = retryGoalManager.retrySetup(goalId);
		if (!ok) {
			json({ error: "Goal not found or not in error state" }, 400);
			return;
		}
		json({ ok: true });
		// Fire-and-forget async worktree setup (and optionally start team)
		const retryGoal = retryGoalManager.getGoal(goalId);
		if (retryGoal?.autoStartTeam) {
			retryGoalManager.setupWorktreeAndStartTeam(goalId, () => teamManager.startTeam(goalId)).then(() => {
				broadcastToAll({ type: "goal_setup_complete", goalId });
			}).catch((err) => {
				const g = retryGoalManager.getGoal(goalId);
				if (g?.setupStatus === "ready") {
					broadcastToAll({ type: "goal_setup_complete", goalId });
					console.error("[goal] Auto-start team failed on retry (worktree ready):", err);
				} else {
					broadcastToAll({ type: "goal_setup_error", goalId, error: String(err) });
				}
			});
		} else {
			retryGoalManager.setupWorktree(goalId).then(() => {
				broadcastToAll({ type: "goal_setup_complete", goalId });
			}).catch((err) => {
				broadcastToAll({ type: "goal_setup_error", goalId, error: String(err) });
			});
		}
		return;
	}

	// Routes with goal :id parameter
	const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
	if (goalMatch) {
		const id = goalMatch[1];

		if (req.method === "GET") {
			const goal = getGoalAcrossProjects(id);
			if (!goal) { json({ error: "Goal not found" }, 404); return; }
			json(goal);
			return;
		}

		if (req.method === "PUT") {
			const putGoal = getGoalAcrossProjects(id);
			if (putGoal?.archived) { json({ error: "Goal is archived" }, 409); return; }
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const goalMgr = getGoalManagerForGoal(id);
			const ok = await goalMgr.updateGoal(id, {
				title: body.title,
				cwd: body.cwd,
				state: body.state,
				spec: body.spec,
				team: true, // Always-on team mode
				repoPath: body.repoPath,
				branch: body.branch,
				reattemptOf: body.reattemptOf,
			});
			if (!ok) { json({ error: "Goal not found" }, 404); return; }
			json({ ok: true });
			return;
		}

		if (req.method === "DELETE") {
			// `cascade` is REQUIRED — mirrors pause/resume/teardown. The UI is
			// the cascade-policy authority; api.ts always sends ?cascade=.
			const cascadeParam = url.searchParams.get("cascade");
			if (cascadeParam !== "true" && cascadeParam !== "false") {
				json({ error: "cascade=true|false query parameter is required", code: "CASCADE_REQUIRED" }, 422);
				return;
			}
			const cascade = cascadeParam === "true";

			const rootGoal = getGoalAcrossProjects(id);
			if (!rootGoal) { json({ error: "Goal not found" }, 404); return; }

			// cascade=false + live descendants → 409 HAS_DESCENDANTS. The
			// existing UI dialog (showArchiveGoalDialog) uses this preflight
			// to decide whether to show the cascade-confirm dialog.
			if (!cascade) {
				const liveDescendants = listDescendants(projectContextManager, id, { includeArchived: false });
				if (liveDescendants.length > 0) {
					json({
						error: `Goal has ${liveDescendants.length} live descendant(s). Re-call with ?cascade=true to archive them all.`,
						code: "HAS_DESCENDANTS",
						count: liveDescendants.length,
					}, 409);
					return;
				}
			}

			// Manual-merge reconciliation: `?mergedManually=true` stamps state="complete"
			// on the target BEFORE archive (mirrors archiveGoalAfterMerge). Only the
			// root goal gets this stamp — cascade descendants are archived as-is.
			const mergedManually = url.searchParams.get("mergedManually") === "true";

			/** Per-goal archive action (idempotent). */
			const archiveOne = async (g: import("./agent/goal-store.js").PersistedGoal): Promise<boolean> => {
				if (g.archived) return false; // idempotent — already done
				if (mergedManually && g.id === id && g.state !== "complete") {
					await getGoalManagerForGoal(g.id).updateGoal(g.id, { state: "complete" });
				}
				// 1. Cancel in-flight gate verifications (terminates reviewer sessions).
				for (const active of verificationHarness.getActiveVerifications(g.id)) {
					try {
						await verificationHarness.cancelStaleVerifications(g.id, active.gateId);
					} catch (err) {
						console.error(`[api] archive: error cancelling verification for ${g.id}/${active.gateId}:`, err);
					}
				}
				// 2. Capture agent branches BEFORE teardown erases the team
				// store entry (orphan-remote-branch-cleanup invariant).
				const goalProjectCtx = projectContextManager.getContextForGoal(g.id);
				const teamEntry = goalProjectCtx?.teamStore.get(g.id);
				const agentBranches: string[] = [];
				if (teamEntry?.agents) {
					for (const a of teamEntry.agents) {
						if (a.branch) agentBranches.push(a.branch);
					}
				}
				if (teamEntry?.teamLeadSessionId) {
					const tl = goalProjectCtx?.sessionStore.get(teamEntry.teamLeadSessionId);
					if (tl?.branch) agentBranches.push(tl.branch);
				}
				// 3. Tear down any active team.
				if (teamManager.getTeamState(g.id)) {
					try { await teamManager.teardownTeam(g.id); }
					catch (err) { console.error(`[api] archive: teardownTeam ${g.id} failed:`, err); }
				}
				// 4. Archive the goal record.
				const gm = getGoalManagerForGoal(g.id);
				await gm.archiveGoal(g.id);
				// 5. Drop PR status.
				prStatusStore.remove(g.id);
				// 6. Fire-and-forget remote branch cleanup.
				const archivedGoal = gm.getGoal(g.id);
				if (archivedGoal?.repoPath) {
					deleteRemoteGoalBranches(archivedGoal, agentBranches, archivedGoal.repoPath).catch(err => {
						console.warn(`[api] archive: remote branch cleanup failed for ${g.id}:`, err);
					});
				}
				return true;
			};

			if (!cascade) {
				await archiveOne(rootGoal);
				json({ ok: true, archived: 1 });
				return;
			}

			// Cascade=true — bottom-up: children archived before parents.
			// Include already-archived descendants (idempotent archiveOne
			// drops them without counting).
			const ctx = projectContextManager.getContextForGoal(id);
			const allGoals = ctx?.goalStore.getAll() ?? [];
			const result = await cascadeGoalSubtree(
				id,
				allGoals,
				{ includeRoot: true, includeArchived: true },
				{ order: "bottom-up", apply: archiveOne },
			);
			const archivedCount = result.processed.filter(p => p.result === true).length;
			if (result.errors.length > 0) {
				for (const e of result.errors) {
					console.error(`[api] archive cascade: ${e.goalId} failed:`, e.error);
				}
			}
			json({
				ok: true,
				archived: archivedCount,
				...(result.errors.length > 0
					? { errors: result.errors.map(e => ({ goalId: e.goalId, error: e.error.message })) }
					: {}),
			});
			return;
		}
	}

	// ── Role endpoints ─────────────────────────────────────────────

	// GET /api/tools — list available agent tools (with cascade origin)
	if (url.pathname === "/api/tools" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		const resolved = configCascade.resolveTools(projectId);
		const tools: Array<Record<string, unknown>> = resolved.map(r => ({ ...r.item, origin: r.origin, ...(r.overrides ? { overrides: r.overrides } : {}) }));
		// Include MCP/external tools not covered by the config cascade
		if (toolManager) {
			const resolvedNames = new Set(resolved.map(r => r.item.name));
			for (const t of toolManager.getAvailableTools()) {
				if (!resolvedNames.has(t.name)) {
					tools.push({ ...t, origin: "mcp" });
				}
			}
		}
		json({ tools });
		return;
	}

	// Routes with tool :name parameter
	const toolMatch = url.pathname.match(/^\/api\/tools\/([^/]+)$/);
	if (toolMatch) {
		const name = decodeURIComponent(toolMatch[1]);

		if (req.method === "GET") {
			const tool = toolManager.getToolByName(name);
			if (!tool) { json({ error: "Tool not found" }, 404); return; }
			json(tool);
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const ok = toolManager.updateToolMetadata(name, {
				description: body.description,
				group: body.group,
				docs: body.docs,
				detail_docs: body.detail_docs,
				grantPolicy: body.grantPolicy,
			});
			if (!ok) { json({ error: "Tool not found" }, 404); return; }
			json({ ok: true });
			return;
		}
	}

	// Shared helper: find which group subdirectory contains a tool by scanning YAML files.
	function findToolGroupDir(toolName: string, toolsDir: string): string | null {
		try {
			const entries = fs.readdirSync(toolsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const groupPath = path.join(toolsDir, entry.name);
				try {
					const files = fs.readdirSync(groupPath);
					for (const file of files) {
						if (!file.endsWith(".yaml")) continue;
						try {
							const raw = fs.readFileSync(path.join(groupPath, file), "utf-8");
							// Quick check without full YAML parse
							if (raw.includes(`name: ${toolName}`) || raw.includes(`name: "${toolName}"`)) {
								// Verify with proper field check
								const lines = raw.split("\n");
								for (const line of lines) {
									const m = line.match(/^name:\s*"?([^"\n]+)"?\s*$/);
									if (m && m[1].trim() === toolName) return entry.name;
								}
							}
						} catch { /* skip unreadable */ }
					}
				} catch { /* skip */ }
			}
		} catch { /* dir doesn't exist */ }
		return null;
	}

	// POST /api/tools/:name/customize — copy tool group to a target scope
	const toolCustomizeMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/customize$/);
	if (toolCustomizeMatch && req.method === "POST") {
		const name = decodeURIComponent(toolCustomizeMatch[1]);
		const scope = url.searchParams.get("scope") || "server";
		const projectId = url.searchParams.get("projectId") || undefined;

		// Find the tool in the cascade to get its origin
		const resolved = configCascade.resolveTools(projectId);
		const source = resolved.find(r => r.item.name === name);
		if (!source) { json({ error: "Tool not found" }, 404); return; }

		// Find the groupDir by scanning tool directories to locate this tool's YAML
		const builtinToolsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "defaults", "tools");
		const serverToolsDir = path.join(bobbitConfigDir(), "tools");

		// Find groupDir from the source layer
		let groupDir: string | null = null;
		let sourceToolsDir: string;
		if (source.origin === "builtin") {
			sourceToolsDir = builtinToolsDir;
			groupDir = findToolGroupDir(name, builtinToolsDir);
		} else if (source.origin === "project" && projectId) {
			const ctx = projectContextManager.getOrCreate(projectId);
			sourceToolsDir = ctx ? path.join(ctx.configDir, "tools") : serverToolsDir;
			groupDir = findToolGroupDir(name, sourceToolsDir);
		} else {
			sourceToolsDir = serverToolsDir;
			groupDir = findToolGroupDir(name, serverToolsDir);
		}
		// Fallback: try all layers
		if (!groupDir) groupDir = findToolGroupDir(name, builtinToolsDir) || findToolGroupDir(name, serverToolsDir);
		if (!groupDir) { json({ error: "Could not determine tool group directory" }, 400); return; }

		// Determine target directory
		let targetToolsDir: string;
		if (scope === "project" && projectId) {
			const ctx = projectContextManager.getOrCreate(projectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			targetToolsDir = path.join(ctx.configDir, "tools");
		} else {
			targetToolsDir = serverToolsDir;
		}

		// Determine the actual source dir for copying
		let actualSourceDir = sourceToolsDir;
		// If the source layer doesn't have this group, try builtins then server
		if (!fs.existsSync(path.join(actualSourceDir, groupDir))) {
			if (fs.existsSync(path.join(builtinToolsDir, groupDir))) actualSourceDir = builtinToolsDir;
			else if (fs.existsSync(path.join(serverToolsDir, groupDir))) actualSourceDir = serverToolsDir;
		}

		const srcDir = path.join(actualSourceDir, groupDir);
		const destDir = path.join(targetToolsDir, groupDir);

		if (!fs.existsSync(srcDir)) { json({ error: "Source tool group not found" }, 404); return; }

		// Copy entire group directory (recursively handles nested files)
		copyDirRecursive(srcDir, destDir);

		json({ ok: true, groupDir }, 201);
		return;
	}

	// DELETE /api/tools/:name/override — remove tool group override at a scope
	const toolOverrideMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/override$/);
	if (toolOverrideMatch && req.method === "DELETE") {
		const name = decodeURIComponent(toolOverrideMatch[1]);
		const scope = url.searchParams.get("scope") || "server";
		const projectId = url.searchParams.get("projectId") || undefined;

		// Determine the tools directory for the target scope
		let targetToolsDir: string;
		if (scope === "project" && projectId) {
			const ctx = projectContextManager.getOrCreate(projectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			targetToolsDir = path.join(ctx.configDir, "tools");
		} else {
			targetToolsDir = path.join(bobbitConfigDir(), "tools");
		}

		// Find which group directory contains this tool
		const builtinToolsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "defaults", "tools");

		// Find groupDir in the target scope (the override we're deleting)
		let groupDir = findToolGroupDir(name, targetToolsDir);
		// If not found in target, try builtins to at least know the group name
		if (!groupDir) groupDir = findToolGroupDir(name, builtinToolsDir);
		if (!groupDir) { json({ error: "Could not determine tool group directory" }, 400); return; }

		const dirToRemove = path.join(targetToolsDir, groupDir);
		if (fs.existsSync(dirToRemove)) {
			fs.rmSync(dirToRemove, { recursive: true, force: true });
		}

		json({ ok: true });
		return;
	}

	// ── Tool group policies ──

	// GET /api/tool-group-policies
	if (url.pathname === "/api/tool-group-policies" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		json(configCascade.resolveToolGroupPolicies(projectId));
		return;
	}

	// PUT /api/tool-group-policies/:group
	const groupPolicyMatch = url.pathname.match(/^\/api\/tool-group-policies\/(.+)$/);
	if (groupPolicyMatch && req.method === "PUT") {
		const group = decodeURIComponent(groupPolicyMatch[1]);
		const body = await readBody(req);
		if (!body) { json({ error: "Missing body" }, 400); return; }
		const validPolicies = ['allow', 'ask', 'never', 'always-allow', 'ask-once', 'always-ask', 'never-ask'];
		if (body.policy && !validPolicies.includes(body.policy)) {
			json({ error: `Invalid policy. Must be one of: allow, ask, never` }, 400);
			return;
		}
		groupPolicyStore.setGroupPolicy(group, body.policy || null);
		json({ ok: true });
		return;
	}

	// ── Config: default cwd ──

	// GET /api/config/cwd
	if (url.pathname === "/api/config/cwd" && req.method === "GET") {
		json({ cwd: config.defaultCwd });
		return;
	}

	// PUT /api/config/cwd
	if (url.pathname === "/api/config/cwd" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body?.cwd || typeof body.cwd !== "string") {
			json({ error: "Missing or invalid cwd" }, 400);
			return;
		}
		config.defaultCwd = body.cwd;
		preferencesStore.set("defaultCwd", body.cwd);
		json({ cwd: config.defaultCwd });
		return;
	}

	// ── Preferences ──

	/** Return preferences with sensitive keys (providerKey.*) filtered out. */
	function getSafePreferences(): Record<string, unknown> {
		const all = preferencesStore.getAll();
		const filtered: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(all)) {
			if (!key.startsWith("providerKey.")) {
				filtered[key] = value;
			}
		}
		return filtered;
	}

	/** Broadcast preferences_changed with sensitive keys filtered out. */
	function broadcastPreferencesChanged(): void {
		broadcastToAll({ type: "preferences_changed", preferences: getSafePreferences() });
	}

	// GET /api/preferences — return all preferences (filter sensitive keys)
	if (url.pathname === "/api/preferences" && req.method === "GET") {
		json(getSafePreferences());
		return;
	}

	// PUT /api/preferences — merge preferences
	if (url.pathname === "/api/preferences" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
		for (const [key, value] of Object.entries(body)) {
			if (value === null || value === undefined) {
				preferencesStore.remove(key);
			} else {
				preferencesStore.set(key, value);
			}
		}
		json({ ok: true });
		broadcastPreferencesChanged();
		return;
	}

	// GET /api/project-config — return project settings
	if (url.pathname === "/api/project-config" && req.method === "GET") {
		json(projectConfigStore.getWithDefaults());
		return;
	}

	// GET /api/project-config/defaults — return just the defaults
	if (url.pathname === "/api/project-config/defaults" && req.method === "GET") {
		json(projectConfigStore.getDefaults());
		return;
	}

	// GET /api/config-directories — return all scanned config directories
	if (url.pathname === "/api/config-directories" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId");
		const resolvedStore = resolveProjectConfigStore(projectId);
		const resolvedCwd = projectId && projectContextManager
			? projectContextManager.getOrCreate(projectId)?.project.rootPath ?? config.defaultCwd
			: config.defaultCwd;
		json(getAllConfigDirectories(resolvedCwd, resolvedStore));
		return;
	}

	// DELETE /api/config-directories — remove a built-in directory from scanning
	if (url.pathname === "/api/config-directories" && req.method === "DELETE") {
		const body = await readBody(req);
		if (!body || typeof body !== "object" || typeof (body as any).path !== "string") {
			json({ error: "Missing 'path' in body" }, 400);
			return;
		}
		const projectId = (body as any).projectId as string | null ?? null;
		const resolvedStore = resolveProjectConfigStore(projectId);
		removeBuiltinDirectory(resolvedStore, (body as any).path);
		json({ ok: true });
		return;
	}

	// POST /api/config-directories/reset — reset all config dirs to defaults
	if (url.pathname === "/api/config-directories/reset" && req.method === "POST") {
		const body = await readBody(req);
		const projectId = body && typeof body === "object" ? ((body as any).projectId as string | null ?? null) : null;
		const resolvedStore = resolveProjectConfigStore(projectId);
		resetConfigDirectories(resolvedStore);
		json({ ok: true });
		return;
	}

	// PUT /api/project-config — update server-scope project config fields
	if (url.pathname === "/api/project-config" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
		const bodyMap = body as Record<string, unknown>;

		// Reject legacy top-level qa_* keys — they have moved into
		// `components[<name>].config`.
		for (const key of LEGACY_QA_TOP_LEVEL_KEYS) {
			if (key in bodyMap) {
				json({ error: `${key} settings have moved to components[].config[]; set components[<name>].config.${key} instead` }, 400);
				return;
			}
		}

		// Native-YAML migrated fields: must be sent as structured types.
		const MIGRATED_FIELDS = [
			{ key: "config_directories", expect: "array" as const },
			{ key: "sandbox_tokens", expect: "array" as const },
		];
		const migratedExtracted: Record<string, unknown> = {};
		for (const { key, expect } of MIGRATED_FIELDS) {
			if (!(key in bodyMap)) continue;
			const v = bodyMap[key];
			if (v === null || v === "") { migratedExtracted[key] = null; delete bodyMap[key]; continue; }
			if (typeof v === "string") {
				json({ error: `Field "${key}" must be sent as a structured ${expect}, not a JSON-encoded string` }, 400);
				return;
			}
			if (expect === "array" && !Array.isArray(v)) { json({ error: `Field "${key}" must be an array` }, 400); return; }
			migratedExtracted[key] = v;
			delete bodyMap[key];
		}

		for (const [key, value] of Object.entries(bodyMap)) {
			if (key.includes(".")) {
				json({ error: `Config key "${key}" must not contain dots` }, 400);
				return;
			}
			if (value === null || value === "") {
				projectConfigStore.remove(key);
			} else if (typeof value === "string") {
				projectConfigStore.set(key, value);
			}
		}

		// Apply migrated structured fields via typed setters.
		if ("config_directories" in migratedExtracted) {
			const v = migratedExtracted.config_directories;
			if (v === null) projectConfigStore.remove("config_directories");
			else if (Array.isArray(v)) {
				projectConfigStore.setConfigDirectories(
					v.filter((e: any) => e && typeof e === "object" && typeof e.path === "string").map((e: any) => ({
						path: String(e.path),
						types: Array.isArray(e.types) ? e.types.filter((t: unknown): t is string => typeof t === "string") : [],
					})),
				);
			}
		}
		if ("sandbox_tokens" in migratedExtracted) {
			const v = migratedExtracted.sandbox_tokens;
			if (v === null) projectConfigStore.remove("sandbox_tokens");
			else if (Array.isArray(v)) {
				projectConfigStore.setSandboxTokens(
					v.filter((e: any) => e && typeof e === "object" && typeof e.key === "string").map((e: any) => ({
						key: String(e.key), enabled: e.enabled !== false,
					})),
				);
			}
		}

		json({ ok: true });
		return;
	}

	// ── Unified Model Registry ──

	// GET /api/models — unified model list from all sources
	if (url.pathname === "/api/models" && req.method === "GET") {
		try {
			const models = await getAvailableModels(preferencesStore);
			json(models);
		} catch (err: any) {
			jsonError(500, err, { error: `Failed to load models: ${err.message}` });
		}
		return;
	}

	// GET /api/image-models — image generation model list
	if (url.pathname === "/api/image-models" && req.method === "GET") {
		try {
			json(getAvailableImageModels(preferencesStore));
		} catch (err: any) {
			jsonError(500, err, { error: `Failed to load image models: ${err.message}` });
		}
		return;
	}

	// POST /api/image-generation/generate — gateway-side image generation for the generate_image tool
	if (url.pathname === "/api/image-generation/generate" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || typeof body !== "object" || typeof body.prompt !== "string") {
			json({ error: "Missing prompt" }, 400);
			return;
		}
		const MAX_PROMPT_CHARS = 8192;
		if (body.prompt.length > MAX_PROMPT_CHARS) {
			json({ error: "prompt exceeds 8192 chars" }, 400);
			return;
		}
		// Clamp `n` to integer in [1,4]; reject non-integers / out-of-range.
		let n: number | undefined;
		if (body.n !== undefined && body.n !== null) {
			if (typeof body.n !== "number" || !Number.isInteger(body.n) || body.n < 1 || body.n > 4) {
				json({ error: "n must be 1..4" }, 400);
				return;
			}
			n = body.n;
		}
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
		// Sandbox guard: callers under a sandbox-scoped token must identify a
		// session in their scope. Without sessionId we cannot prove ownership,
		// so refuse rather than silently broadcasting credentials.
		if (sandboxScope && (!sessionId || !sandboxScope.sessionIds.has(sessionId))) {
			json({ error: "session not in sandbox scope" }, 403);
			return;
		}
		const sessionPref = sessionId ? sessionManager.getImageModelForSession(sessionId) : undefined;
		const defaultPref = (preferencesStore.get("default.imageModel") as string | undefined) || defaultImageModelPref();
		// Canonicalise both sides so equality compares apples-to-apples (e.g. user
		// pref "google/nano-banana" vs requested "google/gemini-2.5-flash-image").
		const selectedModelRaw = sessionPref ? `${sessionPref.provider}/${sessionPref.id}` : defaultPref;
		const selectedModel = canonicalImageModelPref(selectedModelRaw) || selectedModelRaw;
		const requestedModel = typeof body.model === "string" && body.model ? canonicalImageModelPref(body.model) : undefined;
		const lastUserPrompt = sessionId ? sessionManager.getLastPromptText(sessionId) : undefined;
		const model = requestedModel
			&& (
				!sessionId
				|| requestedModel === selectedModel
				|| imageModelMentionedInText(preferencesStore, requestedModel, lastUserPrompt)
			)
			? requestedModel
			: selectedModel;
		try {
			const result = await generateImage(preferencesStore, {
				prompt: body.prompt,
				model,
				size: typeof body.size === "string" ? body.size : undefined,
				quality: typeof body.quality === "string" ? body.quality : undefined,
				background: typeof body.background === "string" ? body.background : undefined,
				format: typeof body.format === "string" ? body.format : undefined,
				aspectRatio: typeof body.aspectRatio === "string" ? body.aspectRatio : undefined,
				imageSize: typeof body.imageSize === "string" ? body.imageSize : undefined,
				n,
			});
			json({
				model: { provider: result.model.provider, id: result.model.id, name: result.model.name, api: result.model.api },
				images: result.images,
			});
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// ── Custom Providers ──

	// GET /api/custom-providers — list all custom provider configs
	if (url.pathname === "/api/custom-providers" && req.method === "GET") {
		const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
		json(configs);
		return;
	}

	// POST /api/custom-providers/test — discover models without persisting
	if (url.pathname === "/api/custom-providers/test" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || !body.type || !body.baseUrl) {
			json({ error: "Missing required fields: type, baseUrl" }, 400);
			return;
		}
		const config: CustomProviderConfig = {
			id: body.id || "test-" + Date.now(),
			name: body.name || body.type,
			type: body.type,
			baseUrl: body.baseUrl,
			...(body.apiKey ? { apiKey: body.apiKey } : {}),
		};
		try {
			const models = await discoverModelsForConfig(config);
			json({ models });
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/custom-providers — add or update a custom provider config
	if (url.pathname === "/api/custom-providers" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || !body.id || !body.type || !body.baseUrl) {
			json({ error: "Missing required fields: id, type, baseUrl" }, 400);
			return;
		}
		const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
		const existing = configs.findIndex((c: CustomProviderConfig) => c.id === body.id);
		const config: CustomProviderConfig = {
			id: body.id,
			name: body.name || body.id,
			type: body.type,
			baseUrl: body.baseUrl,
			...(body.apiKey ? { apiKey: body.apiKey } : {}),
			...(body.models ? { models: body.models } : {}),
		};
		if (existing >= 0) {
			configs[existing] = config;
		} else {
			configs.push(config);
		}
		preferencesStore.set("customProviders", configs);
		json({ ok: true, config });
		return;
	}

	// DELETE /api/custom-providers/:id — remove a custom provider config
	if (url.pathname.startsWith("/api/custom-providers/") && req.method === "DELETE") {
		const providerId = decodeURIComponent(url.pathname.slice("/api/custom-providers/".length));
		if (!providerId) {
			json({ error: "Missing provider id" }, 400);
			return;
		}
		const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
		const filtered = configs.filter((c: CustomProviderConfig) => c.id !== providerId);
		preferencesStore.set("customProviders", filtered);
		json({ ok: true });
		return;
	}

	// ── Provider Keys ──

	// GET /api/provider-keys — list providers that have keys set (no key values)
	if (url.pathname === "/api/provider-keys" && req.method === "GET") {
		const all = preferencesStore.getAll();
		const providers = Object.keys(all)
			.filter(k => k.startsWith("providerKey.") && all[k])
			.map(k => k.slice("providerKey.".length));
		json({ providers });
		return;
	}

	// POST /api/provider-keys/:provider — store a provider API key
	if (url.pathname.startsWith("/api/provider-keys/") && req.method === "POST") {
		const provider = decodeURIComponent(url.pathname.slice("/api/provider-keys/".length));
		if (!provider) {
			json({ error: "Missing provider name" }, 400);
			return;
		}
		const body = await readBody(req);
		if (!body?.key || typeof body.key !== "string") {
			json({ error: "Missing 'key' field" }, 400);
			return;
		}
		preferencesStore.set(`providerKey.${provider}`, body.key);
		json({ ok: true });
		return;
	}

	// DELETE /api/provider-keys/:provider — remove a provider API key
	if (url.pathname.startsWith("/api/provider-keys/") && req.method === "DELETE") {
		const provider = decodeURIComponent(url.pathname.slice("/api/provider-keys/".length));
		if (!provider) {
			json({ error: "Missing provider name" }, 400);
			return;
		}
		preferencesStore.remove(`providerKey.${provider}`);
		json({ ok: true });
		return;
	}

	// ── AI Gateway ──

	// GET /api/aigw/status — check if aigw is configured
	if (url.pathname === "/api/aigw/status" && req.method === "GET") {
		const aigwUrl = getAigwUrl(preferencesStore);
		if (!aigwUrl) {
			json({ configured: false });
		} else {
			// Discover fresh models instead of reading from preferences cache
			try {
				const models = await discoverAigwModels(aigwUrl);
				json({ configured: true, url: aigwUrl, models });
			} catch {
				json({ configured: true, url: aigwUrl, models: [] });
			}
		}
		return;
	}

	// POST /api/aigw/configure — set aigw URL, discover models, write models.json
	if (url.pathname === "/api/aigw/configure" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.url || typeof body.url !== "string") {
			json({ error: "Missing 'url' field" }, 400);
			return;
		}
		try {
			const models = await configureAigw(body.url, preferencesStore);
			invalidateModelCache();
			broadcastPreferencesChanged();
			json({ ok: true, models });
		} catch (err: any) {
			jsonError(502, err, { error: `Failed to configure AI Gateway: ${err.message}` });
		}
		return;
	}

	// DELETE /api/aigw/configure — remove aigw config
	if (url.pathname === "/api/aigw/configure" && req.method === "DELETE") {
		removeAigw(preferencesStore);
		invalidateModelCache();
		broadcastPreferencesChanged();
		json({ ok: true });
		return;
	}

	// POST /api/aigw/test — test connection to a URL without saving
	if (url.pathname === "/api/aigw/test" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.url || typeof body.url !== "string") {
			json({ error: "Missing 'url' field" }, 400);
			return;
		}
		try {
			const models = await discoverAigwModels(body.url);
			json({ ok: true, models });
		} catch (err: any) {
			jsonError(502, err);
		}
		return;
	}

	// POST /api/aigw/refresh — re-discover models from the configured gateway
	if (url.pathname === "/api/aigw/refresh" && req.method === "POST") {
		const aigwUrl = getAigwUrl(preferencesStore);
		if (!aigwUrl) {
			json({ error: "No AI Gateway configured" }, 400);
			return;
		}
		try {
			const models = await configureAigw(aigwUrl, preferencesStore);
			invalidateModelCache();
			broadcastPreferencesChanged();
			json({ models });
		} catch (err: any) {
			jsonError(502, err);
		}
		return;
	}

	// POST /api/models/test — send a trivial "Reply with OK" completion to verify
	// that a default-model preference actually resolves and responds. Used by
	// the Settings > Models tab per-row Test button.
	if (url.pathname === "/api/models/test" && req.method === "POST") {
		const body = await readBody(req);
		const pref = typeof body?.pref === "string" ? body.pref.trim() : "";
		if (!pref) {
			json({ ok: false, error: "Missing 'pref' field" }, 400);
			return;
		}
		const slash = pref.indexOf("/");
		if (slash <= 0) {
			json({ ok: false, error: "Malformed pref — expected 'provider/modelId'" }, 400);
			return;
		}
		const provider = pref.slice(0, slash);
		const modelId = pref.slice(slash + 1);
		try {
			const models = await getAvailableModels(preferencesStore);
			const resolved = models.find((m) => m.provider === provider && m.id === modelId);
			if (!resolved) {
				json({
					ok: false,
					error: `Model "${pref}" is not in the current available-models list. It may be a stale preference.`,
				}, 404);
				return;
			}
			if (provider !== "aigw") {
				json({
					ok: false,
					modelResolved: resolved.id,
					error: "Test not supported for this provider yet — only AI Gateway models can be tested from here.",
				}, 422);
				return;
			}
			const aigwUrl = getAigwUrl(preferencesStore);
			if (!aigwUrl) {
				json({ ok: false, error: "No AI Gateway configured." });
				return;
			}
			const baseUrl = aigwUrl.replace(/\/+$/, "");
			const chatUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

			// The aigw registry strips the provider prefix (e.g. "aws/") from Claude
			// model IDs; reconstruct the full ID by querying the gateway's /v1/models.
			let sendId = modelId;
			try {
				const modelsUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
				const r = await fetch(modelsUrl, { signal: AbortSignal.timeout(5000) });
				if (r.ok) {
					const data = await r.json() as { data?: Array<{ id: string }> };
					if (Array.isArray(data.data)) {
						const exact = data.data.find((m) => m.id === modelId);
						if (exact) sendId = exact.id;
						else {
							const match = data.data.find((m) => {
								const idx = m.id.indexOf("/");
								return idx >= 0 && m.id.slice(idx + 1) === modelId;
							});
							if (match) sendId = match.id;
						}
					}
				}
			} catch {
				/* keep sendId = modelId — gateway will reject if wrong */
			}
			const started = Date.now();
			try {
				const resp = await fetch(chatUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: sendId,
						max_tokens: 5,
						messages: [
							{ role: "user", content: "Reply with OK" },
						],
					}),
					signal: AbortSignal.timeout(15000),
				});
				const latencyMs = Date.now() - started;
				if (!resp.ok) {
					const errText = (await resp.text().catch(() => "")).slice(0, 300);
					json({ ok: false, modelResolved: sendId, latencyMs, error: `Gateway ${resp.status}: ${errText || resp.statusText}` });
					return;
				}
				// Best-effort parse; we don't require specific text content—just a successful round-trip.
				await resp.json().catch(() => ({}));
				json({ ok: true, modelResolved: sendId, latencyMs });
			} catch (err: any) {
				const latencyMs = Date.now() - started;
				json({ ok: false, modelResolved: sendId, latencyMs, error: err?.message || "Request failed" });
			}
		} catch (err: any) {
			jsonError(500, err, { ok: false, error: err?.message || "Test failed" });
		}
		return;
	}

	// Proxy: /api/aigw/v1/* → forward to configured aigw URL
	if (url.pathname.startsWith("/api/aigw/v1/") && getAigwUrl(preferencesStore)) {
		const aigwUrl = getAigwUrl(preferencesStore)!;
		const subPath = url.pathname.replace("/api/aigw/v1/", "/v1/");
		const targetUrl = `${aigwUrl}${subPath}${url.search}`;
		proxyRequest(targetUrl, req, res);
		return;
	}

	// GET /api/roles/assistant/prompts — must come before :name route
	if (url.pathname === "/api/roles/assistant/prompts" && req.method === "GET") {
		const { ASSISTANT_REGISTRY } = await import("./agent/assistant-registry.js");
		const prompts = Object.values(ASSISTANT_REGISTRY).map((def) => ({
			type: def.type,
			title: def.title,
			promptTitle: def.promptTitle,
			prompt: def.prompt,
		}));
		json({ prompts });
		return;
	}

	// PUT /api/roles/assistant/prompts/:type
	if (url.pathname.startsWith("/api/roles/assistant/prompts/") && req.method === "PUT") {
		const type = url.pathname.slice("/api/roles/assistant/prompts/".length);
		if (!type) {
			json({ error: "Missing type parameter" }, 400);
			return;
		}
		const body = await readBody(req);
		const { updateAssistantDef } = await import("./agent/assistant-registry.js");
		const updated = updateAssistantDef(type, {
			prompt: body?.prompt,
			title: body?.title,
			promptTitle: body?.promptTitle,
		});
		if (!updated) {
			json({ error: `Unknown assistant type: ${type}` }, 404);
			return;
		}
		json(updated);
		return;
	}

	// GET /api/roles (with cascade origin)
	if (url.pathname === "/api/roles" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		const resolved = configCascade.resolveRoles(projectId);
		json({ roles: resolved.map(r => ({ ...r.item, origin: r.origin, ...(r.overrides ? { overrides: r.overrides } : {}) })) });
		return;
	}

	// POST /api/roles (scope-aware: body.projectId → create in that project's store)
	if (url.pathname === "/api/roles" && req.method === "POST") {
		const body = await readBody(req);
		const targetProjectId = body?.projectId;
		try {
			if (targetProjectId) {
				const ctx = projectContextManager.getOrCreate(targetProjectId);
				if (!ctx) { json({ error: "Project not found" }, 404); return; }
				const now = Date.now();
				const modelStr = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
				const role = {
					name: body?.name,
					label: body?.label ?? body?.name,
					promptTemplate: body?.promptTemplate || "",
					accessory: body?.accessory ?? "none",
					toolPolicies: body?.toolPolicies,
					model: modelStr,
					thinkingLevel: clampRoleThinking(body?.thinkingLevel, modelStr),
					createdAt: now,
					updatedAt: now,
				};
				if (!role.name || typeof role.name !== "string") throw new Error("Missing name");
				const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
				if (!NAME_PATTERN.test(role.name)) throw new Error("Role name must be lowercase alphanumeric + hyphens");
				ctx.roleStore.put(role);
				json(role, 201);
			} else {
				const modelStr = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
				const role = roleManager.createRole({
					name: body?.name,
					label: body?.label,
					promptTemplate: body?.promptTemplate || "",
					accessory: body?.accessory,
					toolPolicies: body?.toolPolicies,
					model: modelStr,
					thinkingLevel: clampRoleThinking(body?.thinkingLevel, modelStr),
				});
				json(role, 201);
			}
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/roles/:name/customize — copy resolved role to a target scope
	const roleCustomizeMatch = url.pathname.match(/^\/api\/roles\/([^/]+)\/customize$/);
	if (roleCustomizeMatch && req.method === "POST") {
		const name = decodeURIComponent(roleCustomizeMatch[1]);
		const scope = url.searchParams.get("scope") || "server";
		const projectId = url.searchParams.get("projectId") || undefined;

		const resolved = configCascade.resolveRoles(projectId);
		const source = resolved.find(r => r.item.name === name);
		if (!source) { json({ error: "Role not found" }, 404); return; }

		let targetStore;
		if (scope === "project") {
			if (!projectId) { json({ error: "projectId required for project scope" }, 400); return; }
			const ctx = projectContextManager.getOrCreate(projectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			targetStore = ctx.roleStore;
		} else {
			// scope === "server" (or unspecified) → system/server layer
			targetStore = serverRoleStore;
		}

		const now = Date.now();
		const copy = { ...source.item, createdAt: now, updatedAt: now };
		targetStore.put(copy);
		json(copy, 201);
		return;
	}

	// DELETE /api/roles/:name/override — remove override at a scope, reverting to inherited
	const roleOverrideMatch = url.pathname.match(/^\/api\/roles\/([^/]+)\/override$/);
	if (roleOverrideMatch && req.method === "DELETE") {
		const name = decodeURIComponent(roleOverrideMatch[1]);
		const scope = url.searchParams.get("scope") || "server";
		const projectId = url.searchParams.get("projectId") || undefined;

		let targetStore;
		if (scope === "project") {
			if (!projectId) { json({ error: "projectId required for project scope" }, 400); return; }
			const ctx = projectContextManager.getOrCreate(projectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			targetStore = ctx.roleStore;
		} else {
			// scope === "server" (or unspecified) → system/server layer
			targetStore = serverRoleStore;
		}

		targetStore.remove(name);
		json({ ok: true });
		return;
	}

	// Routes with role :name parameter
	const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
	if (roleMatch) {
		const name = decodeURIComponent(roleMatch[1]);

		if (req.method === "GET") {
			const qProjectId = url.searchParams.get("projectId") || undefined;
			if (qProjectId) {
				const resolved = configCascade.resolveRoles(qProjectId);
				const found = resolved.find(r => r.item.name === name);
				if (!found) { json({ error: "Role not found" }, 404); return; }
				json({ ...found.item, origin: found.origin, ...(found.overrides ? { overrides: found.overrides } : {}) });
			} else {
				const role = roleManager.getRole(name);
				if (!role) { json({ error: "Role not found" }, 404); return; }
				json(role);
			}
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const qProjectId = url.searchParams.get("projectId") || undefined;
			if (qProjectId) {
				const ctx = projectContextManager.getOrCreate(qProjectId);
				if (!ctx) { json({ error: "Project not found" }, 404); return; }
				const existing = ctx.roleStore.get(name);
				if (!existing) { json({ error: "Role not found in project" }, 404); return; }
				const validPolicies = new Set(['allow', 'ask', 'never', 'always-allow', 'ask-once', 'always-ask', 'never-ask']);
				let toolPolicies = existing.toolPolicies;
				if (body.toolPolicies !== undefined) {
					const cleaned: Record<string, any> = {};
					if (body.toolPolicies && typeof body.toolPolicies === 'object') {
						for (const [k, v] of Object.entries(body.toolPolicies)) {
							if (typeof v === 'string' && validPolicies.has(v)) cleaned[k] = v;
						}
					}
					toolPolicies = cleaned;
				}
				// model / thinkingLevel: explicit empty string clears the field; absent leaves unchanged.
				let model = existing.model;
				if (body.model !== undefined) {
					model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
				}
				let thinkingLevel = existing.thinkingLevel;
				if (body.thinkingLevel !== undefined) {
					thinkingLevel = clampRoleThinking(body.thinkingLevel, model);
				}
				const updated = {
					...existing,
					label: body.label ?? existing.label,
					promptTemplate: body.promptTemplate ?? existing.promptTemplate,
					accessory: body.accessory ?? existing.accessory,
					toolPolicies,
					model,
					thinkingLevel,
					name,
					updatedAt: Date.now(),
				};
				ctx.roleStore.put(updated);
				json({ ok: true });
			} else {
				// model / thinkingLevel: explicit empty string clears the field; absent leaves unchanged.
				const modelUpdate = body.model !== undefined
					? (typeof body.model === "string" && body.model.trim() ? body.model.trim() : "")
					: undefined;
				const thinkingUpdate = body.thinkingLevel !== undefined
					? (clampRoleThinking(body.thinkingLevel, typeof modelUpdate === "string" ? modelUpdate : undefined) ?? "")
					: undefined;
				// Apply model/thinking via direct store update to support clearing (yaml-store update treats undefined as "don't change").
				if (modelUpdate !== undefined || thinkingUpdate !== undefined) {
					const existing = roleManager.getRole(name);
					if (existing) {
						const patched = {
							...existing,
							model: modelUpdate !== undefined ? (modelUpdate || undefined) : existing.model,
							thinkingLevel: thinkingUpdate !== undefined ? (thinkingUpdate || undefined) : existing.thinkingLevel,
							updatedAt: Date.now(),
						};
						serverRoleStore.put(patched);
					}
				}
				const ok = roleManager.updateRole(name, {
					label: body.label,
					promptTemplate: body.promptTemplate,
					accessory: body.accessory,
					toolPolicies: body.toolPolicies !== undefined ? (() => {
						const validPolicies = new Set(['allow', 'ask', 'never', 'always-allow', 'ask-once', 'always-ask', 'never-ask']);
						const cleaned: Record<string, import("./agent/role-store.js").GrantPolicy> = {};
						if (body.toolPolicies && typeof body.toolPolicies === 'object') {
							for (const [k, v] of Object.entries(body.toolPolicies)) {
								if (typeof v === 'string' && validPolicies.has(v)) cleaned[k] = v as import("./agent/role-store.js").GrantPolicy;
							}
						}
						return cleaned;
					})() : undefined,
				});
				if (!ok) { json({ error: "Role not found" }, 404); return; }
				json({ ok: true });
			}
			return;
		}

		if (req.method === "DELETE") {
			const qProjectId = url.searchParams.get("projectId") || undefined;
			if (qProjectId) {
				const ctx = projectContextManager.getOrCreate(qProjectId);
				if (!ctx) { json({ error: "Project not found" }, 404); return; }
				ctx.roleStore.remove(name);
				json({ ok: true });
			} else {
				const ok = roleManager.deleteRole(name);
				if (!ok) { json({ error: "Role not found" }, 404); return; }
				json({ ok: true });
			}
			return;
		}
	}

	// ── Task endpoints ─────────────────────────────────────────────

	// GET /api/goals/:goalId/tasks — list tasks for a goal
	const goalTasksMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/tasks$/);
	if (goalTasksMatch && req.method === "GET") {
		const tasks = getTaskManagerForGoal(goalTasksMatch[1]).getTasksForGoal(goalTasksMatch[1]);
		if (url.searchParams.get("view") === "summary") {
			const slim = tasks.map(t => ({
				id: t.id,
				title: t.title,
				type: t.type,
				state: t.state,
				assignedSessionId: t.assignedSessionId,
				branch: t.branch,
				headSha: t.headSha,
				workflowGateId: t.workflowGateId,
				dependsOn: t.dependsOn || [],
			}));
			json({ tasks: slim });
			return;
		}
		json({ tasks });
		return;
	}

	// POST /api/goals/:goalId/tasks — create a task
	if (goalTasksMatch && req.method === "POST") {
		const goalId = goalTasksMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }

		const body = await readBody(req);
		const title = body?.title;
		const type = body?.type;
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		if (!type || typeof type !== "string") {
			json({ error: "Missing type" }, 400);
			return;
		}
		try {
			const task = getTaskManagerForGoal(goalId).createTask(goalId, title, type, {
				parentTaskId: body.parentTaskId,
				spec: body.spec,
				dependsOn: body.dependsOn,
				workflowGateId: typeof body.workflowGateId === "string" ? body.workflowGateId : undefined,
				inputGateIds: Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined,
			});
			json(task, 201);
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// ── Gate endpoints ─────────────────────────────────────────────

	// GET /api/goals/:goalId/gates — list gates for a goal
	const goalGatesMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates$/);
	if (goalGatesMatch && req.method === "GET") {
		const goalId = goalGatesMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const gateCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateCtx.gateStore;
		const gates = gateStore.getGatesForGoal(goalId);
		// Enrich with workflow gate definitions
		const enriched = gates.map(g => {
			const def = goal.workflow?.gates.find(wg => wg.id === g.gateId);
			return { ...g, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream, metadata: def?.metadata || g.currentMetadata, signalCount: g.signals.length };
		});
		if (url.searchParams.get("view") === "summary") {
			const slim = enriched.map(g => {
				const base: Record<string, unknown> = {
					gateId: g.gateId,
					name: g.name,
					status: g.status,
					dependsOn: g.dependsOn || [],
					signalCount: g.signalCount,
				};
				if (g.signals.length > 0) base.updatedAt = g.updatedAt;
				if (g.status === "failed") {
					const latest = g.signals[g.signals.length - 1];
					if (latest?.verification?.steps) {
						base.failedSteps = latest.verification.steps
							.filter((s: any) => !s.passed && !s.skipped)
							.map((s: any) => s.name);
					}
				}
				return base;
			});
			json({ gates: slim });
			return;
		}
		json({ gates: enriched });
		return;
	}

	// GET /api/goals/:goalId/gates/:gateId — gate detail
	const gateDetailMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)$/);
	if (gateDetailMatch && req.method === "GET") {
		const [, goalId, gateId] = gateDetailMatch;
		const gateDetailCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateDetailCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateDetailCtx.gateStore;
		const gate = gateStore.getGate(goalId, gateId);
		if (!gate) { json({ error: "Gate not found" }, 404); return; }
		const goal = getGoalAcrossProjects(goalId);
		const def = goal?.workflow?.gates.find(wg => wg.id === gateId);
		if (url.searchParams.get("view") === "summary") {
			const latestSignal = gate.signals[gate.signals.length - 1];
			const MAX_TAIL_LINES = 40;
			const slim: Record<string, unknown> = {
				gateId: gate.gateId,
				name: def?.name,
				status: gate.status,
				dependsOn: def?.dependsOn || [],
				signalCount: gate.signals.length,
				updatedAt: gate.updatedAt,
				hasContent: !!gate.currentContent,
				contentLength: gate.currentContent?.length || 0,
			};
			if (gate.currentMetadata) slim.currentMetadata = gate.currentMetadata;
			if (latestSignal) {
				slim.latestSignal = {
					id: latestSignal.id,
					sessionId: latestSignal.sessionId,
					timestamp: latestSignal.timestamp,
					commitSha: latestSignal.commitSha,
					verification: latestSignal.verification ? {
						status: latestSignal.verification.status,
						steps: latestSignal.verification.steps.map(s => {
							const base: Record<string, unknown> = { name: s.name, passed: s.passed };
							if (!s.passed && !s.skipped && s.output) {
								const lines = s.output.split("\n");
								base.output = lines.length > MAX_TAIL_LINES
									? lines.slice(-MAX_TAIL_LINES).join("\n")
									: s.output;
							}
							return base;
						}),
					} : undefined,
				};
			}
			json(slim);
			return;
		}
		json({ ...gate, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream });
		return;
	}

	// GET /api/goals/:goalId/gates/:gateId/inspect — scoped gate data retrieval
	const gateInspectMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/inspect$/);
	if (gateInspectMatch && req.method === "GET") {
		const [, goalId, gateId] = gateInspectMatch;
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) { json({ error: "Goal not found" }, 404); return; }
		const gate = ctx.gateStore.getGate(goalId, gateId);
		if (!gate) { json({ error: "Gate not found" }, 404); return; }

		const section = url.searchParams.get("section");
		if (!section || !["content", "verification", "signals"].includes(section)) {
			json({ error: "section query parameter is required: 'content', 'verification', or 'signals'" }, 400);
			return;
		}

		const resolveSignal = () => {
			const idxStr = url.searchParams.get("signal_index");
			let idx = idxStr !== null ? parseInt(idxStr, 10) : -1;
			if (isNaN(idx)) idx = -1;
			if (idx < 0) idx = gate.signals.length + idx;
			if (idx < 0 || idx >= gate.signals.length) return null;
			return { signal: gate.signals[idx], index: idx };
		};

		if (section === "content") {
			const resolved = resolveSignal();
			if (!resolved) { json({ error: "Signal not found" }, 404); return; }
			json({
				gateId, section: "content",
				signalIndex: resolved.index,
				signalId: resolved.signal.id,
				text: resolved.signal.content || null,
			});
			return;
		}

		if (section === "verification") {
			const resolved = resolveSignal();
			if (!resolved) { json({ error: "Signal not found" }, 404); return; }
			const v = resolved.signal.verification;
			json({
				gateId, section: "verification",
				signalIndex: resolved.index,
				signalId: resolved.signal.id,
				steps: v ? v.steps.map(s => ({
					name: s.name,
					type: s.type,
					passed: s.passed,
					skipped: s.skipped || undefined,
					duration_ms: s.duration_ms,
					output: s.output,
				})) : [],
			});
			return;
		}

		if (section === "signals") {
			json({
				gateId, section: "signals",
				signals: gate.signals.map((s, i) => ({
					index: i,
					id: s.id,
					timestamp: s.timestamp,
					sessionId: s.sessionId,
					commitSha: s.commitSha,
					verdict: s.verification?.status || "running",
					hasContent: !!s.content,
					metadataKeys: s.metadata ? Object.keys(s.metadata) : [],
				})),
			});
			return;
		}
	}

	// POST /api/goals/:goalId/gates/:gateId/signal — signal a gate
	const gateSignalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/signal$/);
	if (gateSignalMatch && req.method === "POST") {
		const [, goalId, gateId] = gateSignalMatch;
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
		if (!goal.workflow) { json({ error: "Goal has no workflow" }, 400); return; }
		const gateSignalCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateSignalCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateSignalCtx.gateStore;
		const gateDef = goal.workflow.gates.find(g => g.id === gateId);
		if (!gateDef) { json({ error: `Unknown gate: ${gateId}` }, 404); return; }

		const body = await readBody(req);
		const signalSessionId = body?.sessionId || "unknown";

		// Validate dependencies are met
		for (const depId of gateDef.dependsOn) {
			const depGate = gateStore.getGate(goalId, depId);
			if (!depGate || depGate.status !== "passed") {
				const depDef = goal.workflow.gates.find(g => g.id === depId);
				json({ error: `Upstream gate "${depDef?.name || depId}" has not passed yet` }, 409);
				return;
			}
		}

		// Validate metadata against gate's schema
		if (gateDef.metadata && body?.metadata) {
			for (const key of Object.keys(gateDef.metadata)) {
				if (!(key in body.metadata)) {
					json({ error: `Missing required metadata field: ${key}` }, 400);
					return;
				}
			}
		} else if (gateDef.metadata && !body?.metadata) {
			const required = Object.keys(gateDef.metadata);
			if (required.length > 0) {
				json({ error: `Missing required metadata fields: ${required.join(", ")}` }, 400);
				return;
			}
		}

		// Get commit SHA
		let commitSha = "unknown";
		try {
			commitSha = await execGitSafe("git rev-parse HEAD", goal.cwd, "unknown");
		} catch { /* ignore */ }

		// Reject if verification is already running for this gate+commit
		if (commitSha !== "unknown") {
			const activeVers = verificationHarness.getActiveVerifications(goalId);
			const runningDup = activeVers.find(v => {
				if (v.gateId !== gateId || v.overallStatus !== "running") return false;
				const gs = gateStore.getGate(goalId, gateId);
				const s = gs?.signals.find(s => s.id === v.signalId);
				return s?.commitSha === commitSha;
			});
			if (runningDup) {
				// Check if sessions are actually alive — auto-cancel zombies
				const alive = verificationHarness.areVerificationSessionsAlive(runningDup.signalId);
				if (!alive) {
					console.log(`[api] Auto-cancelling zombie verification ${runningDup.signalId} for gate ${gateId}`);
					await verificationHarness.cancelStaleVerifications(goalId, gateId);
					// Fall through to create new signal
				} else {
					// Surface the step states so a future 409 is diagnosable from
					// logs alone — see goal "Unstick verification lock on restart".
					const stepSummary = runningDup.steps.map((s: any) => ({
						name: s.name,
						status: s.status,
						pid: s.pid,
						bootEpoch: s.bootEpoch,
						sessionId: s.sessionId,
					}));
					console.warn(`[api] Rejecting gate_signal as duplicate: gate=${gateId} signalId=${runningDup.signalId} aliveCheck=true steps=${JSON.stringify(stepSummary)}`);
					json({ error: "Verification already in progress for this commit", existingSignalId: runningDup.signalId }, 409);
					return;
				}
			}
		}

		// Auto-pass if a prior signal for the same commit already fully passed
		if (commitSha !== "unknown") {
			const existingGateForCache = gateStore.getGate(goalId, gateId);
			if (existingGateForCache) {
				const priorPassed = existingGateForCache.signals.find(s =>
					s.commitSha === commitSha && s.verification?.status === "passed"
				);
				if (priorPassed?.verification) {
					// Create a signal record with cached results
					const cachedSignal = {
						id: randomUUID(),
						gateId,
						goalId,
						sessionId: body?.sessionId || "unknown",
						timestamp: Date.now(),
						commitSha,
						metadata: body?.metadata,
						content: body?.content,
						contentVersion: body?.content ? (existingGateForCache.currentContentVersion || 0) + 1 : undefined,
						verification: {
							status: "passed" as const,
							steps: priorPassed.verification.steps.map(s => ({ ...s, output: `[cached from prior signal] ${s.output}` })),
						},
					};
					gateStore.recordSignal(cachedSignal);
					if (body?.content && cachedSignal.contentVersion) {
						gateStore.updateGateContent(goalId, gateId, body.content, cachedSignal.contentVersion);
					}
					if (body?.metadata) {
						gateStore.updateGateMetadata(goalId, gateId, body.metadata);
					}
					gateStore.updateGateStatus(goalId, gateId, "passed");
					broadcastToGoal(goalId, { type: "gate_signal_received", goalId, gateId, signalId: cachedSignal.id });
					broadcastToGoal(goalId, { type: "gate_verification_complete", goalId, gateId, signalId: cachedSignal.id, status: "passed" });
					broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId, status: "passed" });
					const verifySteps = (gateDef.verify || []).map((s: any) => ({ name: s.name, type: s.type }));
					json({ signal: { id: cachedSignal.id, gateId, goalId, status: "passed", steps: verifySteps, cached: true } }, 201);
					return;
				}
			}
		}

		// Compute content version
		const existingGate = gateStore.getGate(goalId, gateId);
		const contentVersion = body?.content ? (existingGate?.currentContentVersion || 0) + 1 : undefined;

		// Check if this is a re-signal of a passed gate — cascade reset
		if (existingGate && existingGate.status === "passed") {
			gateStore.cascadeReset(goalId, gateId, goal.workflow);
			// Broadcast resets for downstream gates
			for (const g of goal.workflow.gates) {
				if (g.dependsOn.includes(gateId) || hasTransitiveDep(goal.workflow, g.id, gateId)) {
					const downstream = gateStore.getGate(goalId, g.id);
					if (downstream) {
						broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId: g.id, status: downstream.status });
					}
				}
			}
		}

		// Create signal record
		const signal = {
			id: randomUUID(),
			gateId,
			goalId,
			sessionId: signalSessionId,
			timestamp: Date.now(),
			commitSha,
			metadata: body?.metadata,
			content: body?.content,
			contentVersion,
			verification: { status: "running" as const, steps: [] },
		};

		gateStore.recordSignal(signal);

		// Update gate content/metadata if provided
		if (body?.content && contentVersion) {
			gateStore.updateGateContent(goalId, gateId, body.content, contentVersion);
		}
		if (body?.metadata) {
			gateStore.updateGateMetadata(goalId, gateId, body.metadata);
		}

		// Broadcast signal received
		broadcastToGoal(goalId, { type: "gate_signal_received", goalId, gateId, signalId: signal.id });

		// Build gate state map for metadata variable resolution + LLM reviewer context
		const allGateStates = new Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>();
		for (const gs of gateStore.getGatesForGoal(goalId)) {
			const def = goal.workflow?.gates?.find((g: any) => g.id === gs.gateId);
			allGateStates.set(gs.gateId, {
				metadata: gs.currentMetadata,
				content: gs.currentContent,
				status: gs.status,
				injectDownstream: def?.injectDownstream,
			});
		}

		// Cancel any in-flight verifications for the same gate before starting new ones
		await verificationHarness.cancelStaleVerifications(goalId, gateId);

		// Fire-and-forget verification — resolve primary branch dynamically so
		// diff baselines use the repo's actual primary (origin/HEAD), not a stale
		// hardcoded "master". See docs/goals-workflows-tasks.md — Gate baselines.
		const branchContainer = goalBranchContainer(goal);
		const primary = await detectPrimaryBranch(branchContainer).catch(() => "master");
		verificationHarness.verifyGateSignal(
			signal, gateDef, branchContainer, goal.branch, primary, allGateStates, goal.spec,
		).catch(err => console.error("[verification] Gate signal error:", err));

		const verifySteps = (gateDef.verify || []).map((s: any) => ({ name: s.name, type: s.type }));
		json({ signal: { id: signal.id, gateId, goalId, status: "running", steps: verifySteps } }, 201);
		return;
	}

	// GET /api/goals/:goalId/gates/:gateId/signals — signal history
	const gateSignalsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/signals$/);
	if (gateSignalsMatch && req.method === "GET") {
		const [, goalId, gateId] = gateSignalsMatch;
		const gateSignalsCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateSignalsCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateSignalsCtx.gateStore;
		const gate = gateStore.getGate(goalId, gateId);
		if (!gate) { json({ error: "Gate not found" }, 404); return; }
		json({ signals: gate.signals });
		return;
	}

	// GET /api/goals/:goalId/verifications/active — get in-flight verification state
	const activeVerifMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/verifications\/active$/);
	if (activeVerifMatch && req.method === "GET") {
		const [, goalId] = activeVerifMatch;
		const active = verificationHarness.getActiveVerifications(goalId);
		json({ verifications: active });
		return;
	}

	// POST /api/goals/:goalId/gates/:gateId/cancel-verification — cancel a stuck verification
	const cancelVerifMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/cancel-verification$/);
	if (cancelVerifMatch && req.method === "POST") {
		const [, goalId, gateId] = cancelVerifMatch;
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
		if (goal.state === "shelved") { json({ error: "Goal is shelved" }, 400); return; }

		const activeVers = verificationHarness.getActiveVerifications(goalId);
		const running = activeVers.find(v => v.gateId === gateId && v.overallStatus === "running");
		if (!running) {
			json({ cancelled: false, message: "No running verification to cancel" }, 200);
			return;
		}

		await verificationHarness.cancelStaleVerifications(goalId, gateId);
		// Explicit user cancel: also update gate status to "failed"
		const cancelCtx = projectContextManager.getContextForGoal(goalId);
		if (cancelCtx) cancelCtx.gateStore.updateGateStatus(goalId, gateId, "failed");
		json({ cancelled: true }, 200);
		return;
	}

	// GET /api/goals/:goalId/gates/:gateId/content — gate content
	const gateContentMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/content$/);
	if (gateContentMatch && req.method === "GET") {
		const [, goalId, gateId] = gateContentMatch;
		const gateContentCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateContentCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateContentCtx.gateStore;
		const gate = gateStore.getGate(goalId, gateId);
		if (!gate) { json({ error: "Gate not found" }, 404); return; }
		json({ content: gate.currentContent, version: gate.currentContentVersion });
		return;
	}

	// GET /api/goals/:goalId/workflow-context/:gateId — get dependency context for a gate
	const workflowContextMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/workflow-context\/([^/]+)$/);
	if (workflowContextMatch && req.method === "GET") {
		const goalId = workflowContextMatch[1];
		const gateId = workflowContextMatch[2];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!goal.workflow) { json({ error: "Goal has no workflow" }, 404); return; }
		const gateDef = goal.workflow.gates.find(g => g.id === gateId);
		if (!gateDef) { json({ error: "Gate not found" }, 404); return; }

		const context = teamManager.buildDependencyContext(goalId, gateId);
		json({ context, gate: gateDef });
		return;
	}

	// Routes with task :id parameter
	const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
	if (taskMatch) {
		const id = taskMatch[1];

		// GET /api/tasks/:id
		if (req.method === "GET") {
			try {
				const task = getTaskManagerForTask(id).getTask(id);
				if (!task) { json({ error: "Task not found" }, 404); return; }
				json(task);
			} catch {
				json({ error: "Task not found" }, 404);
			}
			return;
		}

		// PUT /api/tasks/:id
		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			try {
				const tm = getTaskManagerForTask(id);
				const task = tm.getTask(id);
				const prevState = task?.state;
				const ok = tm.updateTask(id, {
					title: body.title,
					spec: body.spec,
					state: body.state,
					assignedSessionId: body.assignedSessionId,
					dependsOn: body.dependsOn,
					workflowGateId: typeof body.workflowGateId === "string" ? body.workflowGateId : undefined,
					inputGateIds: Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined,
					headSha: typeof body.headSha === "string" ? body.headSha : undefined,
					baseSha: typeof body.baseSha === "string" ? body.baseSha : undefined,
					branch: typeof body.branch === "string" ? body.branch : undefined,
					resultSummary: typeof body.resultSummary === "string" ? body.resultSummary : undefined,
				});
				if (!ok) { json({ error: "Task not found" }, 404); return; }

				// Notify team lead when state transitions to terminal or blocked via PUT
				if (body.state && body.state !== prevState && (body.state === "complete" || body.state === "skipped" || body.state === "blocked") && task?.goalId) {
					teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, body.state);
				}

				json({ ok: true });
			} catch (err: any) {
				jsonError(400, err);
			}
			return;
		}

		// DELETE /api/tasks/:id
		if (req.method === "DELETE") {
			try {
				const ok = getTaskManagerForTask(id).deleteTask(id);
				if (!ok) { json({ error: "Task not found" }, 404); return; }
				json({ ok: true });
			} catch {
				json({ error: "Task not found" }, 404);
			}
			return;
		}
	}

	// POST /api/tasks/:id/assign — assign task to session
	const taskAssignMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/assign$/);
	if (taskAssignMatch && req.method === "POST") {
		const body = await readBody(req);
		const sessionId = body?.sessionId;
		if (!sessionId || typeof sessionId !== "string") {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		try {
			const taskId = taskAssignMatch[1];
			const tm = getTaskManagerForTask(taskId);
			const ok = tm.assignTask(taskId, sessionId);
			if (!ok) { json({ error: "Task not found" }, 400); return; }

			// Auto-populate baseSha and branch from TeamAgent record
			const agent = teamManager.findAgentBySessionId(sessionId);
			if (agent) {
				const task = tm.getTask(taskId);
				if (task) {
					const fields: Record<string, string> = {};
					if (agent.baseSha && !task.baseSha) fields.baseSha = agent.baseSha;
					if (agent.branch && !task.branch) fields.branch = agent.branch;
					if (Object.keys(fields).length) {
						tm.updateTask(taskId, fields);
					}
				}
			}

			json({ ok: true });
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/tasks/:id/transition — state transition
	const taskTransitionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/transition$/);
	if (taskTransitionMatch && req.method === "POST") {
		const body = await readBody(req);
		const state = body?.state;
		if (!state || typeof state !== "string") {
			json({ error: "Missing state" }, 400);
			return;
		}
		if (!VALID_TASK_STATES.has(state)) {
			json({ error: `Invalid task state: ${state}` }, 400);
			return;
		}
		try {
			const taskId = taskTransitionMatch[1];
			const tm = getTaskManagerForTask(taskId);
			const task = tm.getTask(taskId);
			const ok = tm.transitionTask(taskId, state as TaskState);
			if (!ok) { json({ error: "Task not found" }, 400); return; }

			// Notify team lead when a task reaches a terminal or blocked state
			if ((state === "complete" || state === "skipped" || state === "blocked") && task?.goalId) {
				teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, state);
			}

			json({ ok: true });
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// ── Team endpoints ─────────────────────────────────────────────
	// Routes accept both /team/ and legacy /swarm/ paths

	// POST /api/goals/:id/team/start — start a team for a goal
	const teamStartMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/start$/);
	if (teamStartMatch && req.method === "POST") {
		const goalId = teamStartMatch[1];
		try {
			const session = await teamManager.startTeam(goalId);
			json({ sessionId: session.id, title: session.title }, 201);
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/goals/:id/team/spawn — spawn a role agent
	const teamSpawnMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/spawn$/);
	if (teamSpawnMatch && req.method === "POST") {
		const goalId = teamSpawnMatch[1];
		// Guard: reject spawn if goal is archived
		const spawnGoal = getGoalAcrossProjects(goalId);
		if (spawnGoal?.archived) {
			json({ error: "Goal is archived" }, 409);
			return;
		}
		// Pause-cascade: refuse to spawn role agents on a paused goal.
		if (spawnGoal?.paused) {
			json({ error: `Goal ${goalId} is paused`, code: "GOAL_PAUSED", goalId }, 409);
			return;
		}
		// Guard: reject spawn if goal worktree is not ready
		if (spawnGoal && spawnGoal.setupStatus !== "ready") {
			json({ error: "Goal setup not complete" }, 409);
			return;
		}
		const body = await readBody(req);
		if (!body?.role || !body?.task) {
			json({ error: "Missing role or task" }, 400);
			return;
		}
		try {
			const spawnOpts: { workflowGateId?: string; inputGateIds?: string[] } = {};
			if (typeof body.workflowGateId === "string") spawnOpts.workflowGateId = body.workflowGateId;
			if (Array.isArray(body.inputGateIds)) spawnOpts.inputGateIds = body.inputGateIds as string[];
			const result = await teamManager.spawnRole(goalId, body.role, body.task, spawnOpts);
			json(result, 201);
		} catch (err) {
			if (err instanceof GateDependencyError) {
				jsonError(409, err);
			} else {
				jsonError(400, err);
			}
		}
		return;
	}

	// POST /api/goals/:id/team/dismiss — dismiss a role agent
	const teamDismissMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/dismiss$/);
	if (teamDismissMatch && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.sessionId) {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		try {
			const ok = await teamManager.dismissRole(body.sessionId);
			json({ ok });
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// GET /api/goals/:id/commits — get commit history for goal branch
	const commitsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/commits$/);
	if (commitsMatch && req.method === "GET") {
		const goalId = commitsMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!fs.existsSync(goal.cwd)) { json({ commits: [] }); return; }
		const branch = goal.branch || "HEAD";
		// Validate branch name to prevent injection
		if (!/^[a-zA-Z0-9/_.\-]+$/.test(branch)) { json({ error: "Invalid branch name" }, 400); return; }
		const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 100);
		try {
			let primaryBranch = "master";
			try {
				const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", goal.cwd);
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { await execGit("git rev-parse --verify refs/heads/master", goal.cwd); primaryBranch = "master"; }
				catch { try { await execGit("git rev-parse --verify refs/heads/main", goal.cwd); primaryBranch = "main"; } catch { /* keep default */ } }
			}

			let rangeSpec = `-${limit} ${branch}`;
			if (branch !== primaryBranch && branch !== "HEAD") {
				let primaryRef = primaryBranch;
				try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, goal.cwd); primaryRef = `origin/${primaryBranch}`; } catch { /* use local */ }
				try { await execGit(`git rev-parse ${primaryRef}`, goal.cwd); rangeSpec = `-${limit} ${primaryRef}..${branch}`; } catch { /* fall back */ }
			}

			const out = await execGit(`git log --format="%H|%h|%s|%an|%aI" ${rangeSpec}`, goal.cwd);
			const commits = out.trim().split("\n").filter(Boolean).map((line: string) => {
				const [sha, shortSha, message, author, timestamp] = line.split("|");
				return { sha, shortSha, message, author, timestamp };
			});
			json({ commits });
		} catch (e: any) {
			json({ error: "Failed to read git log", detail: e.message }, 500);
		}
		return;
	}

	// GET /api/goals/:id/git-status — git status for goal worktree (async)
	const goalGitMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/git-status$/);
	if (goalGitMatch && req.method === "GET") {
		const goalId = goalGitMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;

		// Resolve container ID for sandboxed goals + project `base_ref` config
		// for the `aheadOfPrimary`/`behindPrimary` counter — see
		// `docs/design/base-ref.md` §5.
		let cid: string | undefined;
		let goalBaseRef: string | undefined;
		try {
			const goalCtx = projectContextManager.getContextForGoal(goalId);
			if (goalCtx) {
				goalBaseRef = goalCtx.projectConfigStore.get("base_ref") || undefined;
				if (goal.sandboxed) {
					const sandbox = sessionManager.getSandboxManager()?.get(goalCtx.project.id);
					cid = sandbox ? await sandbox.getContainerId() : undefined;
				}
			}
		} catch { /* container/config unavailable — fall through */ }

		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const goalUntracked = url.searchParams.get('untracked') === '1';
		if (url.searchParams.get('fetch') === 'true') {
			try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch { /* best-effort */ }
			invalidateGitStatusCache(cwd, cid);
		}
		try {
			const result = await batchGitStatus(cwd, cid, { untracked: goalUntracked, configuredBaseRef: goalBaseRef });
			if (!result) { json({ error: "Not a git repository" }, 400); return; }

			// Multi-repo aware envelope: include `repos` map + `aggregate` for back-compat.
			const repoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
			if (repoWorktrees && Object.keys(repoWorktrees).length > 0) {
				const repos: Record<string, typeof result> = {};
				for (const [repoName, repoPath] of Object.entries(repoWorktrees)) {
					try {
						if (cid || fs.existsSync(repoPath)) {
							const r = await batchGitStatus(repoPath, cid, { untracked: goalUntracked, configuredBaseRef: goalBaseRef });
							if (r) repos[repoName] = r;
						}
					} catch { /* per-repo failure non-fatal */ }
				}
				json({ ...result, aggregate: result, repos });
			} else {
				// Single-repo: include `repos: { ".": result }, aggregate: result` for back-compat.
				json({ ...result, aggregate: result, repos: { ".": result } });
			}
		} catch (err: any) {
			jsonError(500, err, { error: err.stderr?.trim() || err.message || "git status failed" });
		}
		return;
	}

	// GET /api/goals/:id/git-diff — unified diff for goal worktree
	const goalDiffMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/git-diff$/);
	if (goalDiffMatch && req.method === "GET") {
		const goalId = goalDiffMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;

		// Resolve container ID for sandboxed goals
		let cid: string | undefined;
		if (goal.sandboxed) {
			try {
				const goalCtx = projectContextManager.getContextForGoal(goalId);
				const sandbox = goalCtx ? sessionManager.getSandboxManager()?.get(goalCtx.project.id) : undefined;
				cid = sandbox ? await sandbox.getContainerId() : undefined;
			} catch { /* container unavailable */ }
		}

		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const file = url.searchParams.get("file") || undefined;
		const repoParam = url.searchParams.get("repo") || undefined;
		const goalRepoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
		let diffCwd = cwd;
		if (repoParam && goalRepoWorktrees && goalRepoWorktrees[repoParam]) {
			diffCwd = goalRepoWorktrees[repoParam];
		}
		try {
			const diff = await getGitDiff(diffCwd, file, cid);
			json({ diff });
		} catch (err: any) {
			if (err.message === "INVALID_PATH") { json({ error: "Invalid file path" }, 400); return; }
			if (err.message === "NO_DIFF") { json({ error: "No diff found" }, 404); return; }
			jsonError(500, err);
		}
		return;
	}

	// GET /api/pr-status-cache — bulk PR status from disk cache (startup hydration)
	if (req.method === "GET" && url.pathname === "/api/pr-status-cache") {
		json(prStatusStore.getAll());
		return;
	}

	// GET /api/goals/:id/pr-status — PR status for goal branch (async + cached)
	const goalPrStatusMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pr-status$/);
	if (goalPrStatusMatch && req.method === "GET") {
		const goalId = goalPrStatusMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;
		if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		// Pass process.cwd() as fallback — if the goal's worktree has a broken git link
		// (e.g. pruned worktree), gh can still query by branch name from the main repo.
		const pr = await getCachedPrStatus(cwd, goal.branch, process.cwd());
		if (pr) { prStatusStore.set(goalId, pr); json(pr); } else { json({ error: "No PR found" }, 404); }
		return;
	}

	// POST /api/goals/:id/pr-cache-bust — invalidate PR cache for a goal
	const goalPrCacheBustMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pr-cache-bust$/);
	if (req.method === 'POST' && goalPrCacheBustMatch) {
		const goalId = goalPrCacheBustMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;
		_prCache.delete(cwd);
		if (goal.branch) _prCache.delete(`${cwd}::${goal.branch}`);
		broadcastToAll({ type: "pr_status_changed", goalId });
		json({ ok: true });
		return;
	}

	// POST /api/goals/:id/pr-merge — merge PR for goal branch
	const goalPrMergeMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pr-merge$/);
	if (goalPrMergeMatch && req.method === "POST") {
		const goalId = goalPrMergeMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;
		if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const body = await readBody(req);
		const method = body?.method ?? "squash";
		if (!["merge", "squash", "rebase"].includes(method)) {
			json({ error: "Invalid merge method. Must be merge, squash, or rebase." }, 400);
			return;
		}
		const goalAdminFlag = body?.admin ? " --admin" : "";
		const clientGoalBranch = typeof body?.branch === "string" ? body.branch : undefined;
		const resolvedGoalBranch = clientGoalBranch || goal.branch;
		const goalMergeBranch = resolvedGoalBranch ? ` ${resolvedGoalBranch}` : "";
		try {
			await execAsync(`gh pr merge${goalMergeBranch} --${method}${goalAdminFlag}`, { cwd, encoding: "utf-8", timeout: 30000 });
			_prCache.delete(cwd);
			if (goal.branch) _prCache.delete(`${cwd}::${goal.branch}`);
			json({ ok: true });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// GET /api/goals/:id/team — get team state
	const teamStateMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)$/);
	if (teamStateMatch && req.method === "GET") {
		const goalId = teamStateMatch[1];
		const state = teamManager.getTeamState(goalId);
		if (!state) {
			json({ error: "No active team for this goal" }, 404);
			return;
		}
		json(state);
		return;
	}

	// POST /api/goals/:id/team/steer — steer a team agent mid-turn
	const teamSteerMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/steer$/);
	if (teamSteerMatch && req.method === "POST") {
		const goalId = teamSteerMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId || !body?.message) {
			json({ error: "Missing sessionId or message" }, 400);
			return;
		}
		// Validate target is a team agent
		const agents = teamManager.listAgents(goalId);
		if (!agents.find(a => a.sessionId === body.sessionId)) {
			json({ error: "Session is not a member of this team" }, 403);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		// Allow steering non-interactive sessions (e.g. verification reviewers)
		// so the user can redirect them mid-run
		if (session.status !== "streaming") {
			json({ error: "Agent is not currently streaming — use team/prompt instead" }, 409);
			return;
		}
		try {
			await sessionManager.deliverLiveSteer(session.id, body.message);
			json({ ok: true, dispatched: true });
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/goals/:id/team/abort — force-abort a stuck team agent
	const teamAbortMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/abort$/);
	if (teamAbortMatch && req.method === "POST") {
		const goalId = teamAbortMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId) {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		// Validate target is a team agent
		const agents = teamManager.listAgents(goalId);
		if (!agents.find(a => a.sessionId === body.sessionId)) {
			json({ error: "Session is not a member of this team" }, 403);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		try {
			await sessionManager.forceAbort(body.sessionId);
			const afterSession = sessionManager.getSession(body.sessionId);
			json({ ok: true, status: afterSession?.status || "idle" });
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/goals/:id/team/prompt — send a prompt to a team agent (queued or immediate)
	const teamPromptMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/prompt$/);
	if (teamPromptMatch && req.method === "POST") {
		const goalId = teamPromptMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId || !body?.message) {
			json({ error: "Missing sessionId or message" }, 400);
			return;
		}
		// Validate target is a team agent OR a direct-child team-lead
		const agents = teamManager.listAgents(goalId);
		let allowed = !!agents.find(a => a.sessionId === body.sessionId);
		if (!allowed) {
			const targetSession = sessionManager.getSession(body.sessionId);
			if (targetSession?.role === "team-lead" && targetSession.goalId) {
				const targetGoal = getGoalAcrossProjects(targetSession.goalId);
				if (targetGoal?.parentGoalId === goalId) {
					allowed = true;
				}
			}
		}
		if (!allowed) {
			json({
				error: "Session is not a member of this team and is not a direct-child team-lead",
				code: "NOT_TEAM_MEMBER_OR_DIRECT_CHILD",
			}, 403);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		if (session.nonInteractive) {
			json({ error: "Cannot prompt a non-interactive (automated review) session" }, 400);
			return;
		}
		// Enforce gate dependency check for team/prompt
		const wfGateId = typeof body.workflowGateId === "string" ? body.workflowGateId : undefined;
		const inputIds = Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined;
		if (wfGateId) {
			const goal = getGoalAcrossProjects(goalId);
			const goalGateCtx = projectContextManager.getContextForGoal(goalId);
			const goalGateStore = goalGateCtx?.gateStore;
			if (goal?.workflow && goalGateStore) {
				const gateStates = goalGateStore.getGatesForGoal(goalId);
				const depError = checkGateDependencies(wfGateId, goal.workflow.gates, gateStates);
				if (depError) {
					json({ error: depError }, 409);
					return;
				}
			}
		}
		try {
			// Resolve workflow gate context and prepend to message if provided
			let message = body.message as string;
			if (wfGateId || inputIds?.length) {
				const ctx = teamManager.buildDependencyContext(goalId, wfGateId, inputIds);
				if (ctx) {
					message = ctx + "\n\n---\n\n" + message;
				}
			}
			await sessionManager.enqueuePrompt(body.sessionId, message);
			json({ ok: true, status: session.status === "idle" ? "dispatched" : "queued" });
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// GET /api/goals/:id/team/agents — list agents for a team goal
	const teamAgentsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/agents$/);
	if (teamAgentsMatch && req.method === "GET") {
		const goalId = teamAgentsMatch[1];
		const agents = teamManager.listAgents(goalId);

		// Include archived (dismissed) agents when ?include=archived is set
		const includeArchived = url.searchParams.get("include") === "archived";
		let archivedAgents: unknown[] = [];
		if (includeArchived) {
			const liveSessionIds = new Set(agents.map((a: any) => a.sessionId));
			archivedAgents = sessionManager.listArchivedSessions()
				.filter(s => s.teamGoalId === goalId && !liveSessionIds.has(s.id))
				.map(s => ({
					sessionId: s.id,
					role: s.role || "unknown",
					status: "archived",
					worktreePath: s.worktreePath || "",
					branch: "",
					task: "",
					createdAt: s.createdAt,
					archivedAt: s.archivedAt,
					title: s.title,
					accessory: s.accessory,
					taskId: s.taskId,
					teamLeadSessionId: s.teamLeadSessionId,
					teamGoalId: s.teamGoalId,
					delegateOf: s.delegateOf,
				}));
		}

		json({ agents: [...agents, ...archivedAgents] });
		return;
	}

	// POST /api/goals/:id/team/complete — complete a team (dismiss agents, keep team lead)
	const teamCompleteMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/complete$/);
	if (teamCompleteMatch && req.method === "POST") {
		const goalId = teamCompleteMatch[1];
		try {
			await teamManager.completeTeam(goalId);
			json({ ok: true });
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/goals/:id/team/teardown — fully tear down a team (dismiss agents + terminate team lead).
	// Cascade required — mirror of `tests/api-team-teardown-cascade.test.ts::teardownRoute`.
	const teamTeardownMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/teardown$/);
	if (teamTeardownMatch && req.method === "POST") {
		const goalId = teamTeardownMatch[1];
		const cascadeParam = url.searchParams.get("cascade");
		if (cascadeParam !== "true" && cascadeParam !== "false") {
			json({ error: "cascade=true|false query parameter is required", code: "CASCADE_REQUIRED" }, 422);
			return;
		}
		const cascade = cascadeParam === "true";
		const tdCtx = projectContextManager.getContextForGoal(goalId);
		const tdAllGoals = tdCtx?.goalStore.getAll() ?? [];

		// cascade=false + live descendant teams → 409 HAS_DESCENDANT_TEAMS.
		if (!cascade) {
			const descendants = walkGoalSubtree(goalId, tdAllGoals, { includeRoot: false, includeArchived: false });
			const descendantsWithTeams = descendants
				.filter(d => !!teamManager.getTeamState(d.id))
				.map(d => ({ id: d.id, title: d.title }));
			if (descendantsWithTeams.length > 0) {
				json({
					code: "HAS_DESCENDANT_TEAMS",
					count: descendantsWithTeams.length,
					descendants: descendantsWithTeams,
					message: `Goal has ${descendantsWithTeams.length} descendant team(s) still running. Re-call with ?cascade=true to stop them all.`,
				}, 409);
				return;
			}
		}

		// Bottom-up: children torn down before parents. Skip archived
		// nodes. cascade=false collapses to root-only by capping depth at 0.
		const result = await cascadeGoalSubtree(
			goalId,
			tdAllGoals,
			{ includeRoot: true, includeArchived: false, ...(cascade ? {} : { maxDepth: 0 }) },
			{
				order: "bottom-up",
				apply: async (g) => {
					if (!teamManager.getTeamState(g.id)) return false;
					await teamManager.teardownTeam(g.id);
					return true;
				},
			},
		);
		const toreDown = result.processed.filter(p => p.result === true).length;
		json({
			ok: true,
			toreDown,
			errors: result.errors.map(e => ({ goalId: e.goalId, error: e.error.message })),
		});
		return;
	}

	// Routes with :id parameter
	const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (sessionMatch) {
		const id = sessionMatch[1];

		if (req.method === "GET") {
			const session = sessionManager.getSession(id);
			if (!session) {
				json({ error: "Session not found" }, 404);
				return;
			}
			json({
				id: session.id,
				title: session.title,
				cwd: session.cwd,
				status: session.status,
				createdAt: session.createdAt,
				clientCount: session.clients.size,
			});
			return;
		}

		if (req.method === "DELETE") {
			const purge = url.searchParams.get("purge") === "true";
			// Check if it's an archived session — purge immediately
			const archivedSession = sessionManager.getArchivedSession(id);
			if (archivedSession) {
				await sessionManager.purgeArchivedSession(id);
				json({ ok: true });
				return;
			}
			const terminated = await sessionManager.terminateSession(id);
			if (!terminated) {
				// Session not in memory — check if it's a dormant store entry (e.g. completed delegate)
				if (purge) {
					// Archive it first so purge can find it, then purge
					sessionManager.storeArchive(id);
					const purged = await sessionManager.purgeArchivedSession(id);
					if (purged) {
						json({ ok: true });
						return;
					}
				}
				json({ error: "Session not found" }, 404);
				return;
			}
			// If purge requested, also purge the now-archived session immediately
			if (purge) {
				await sessionManager.purgeArchivedSession(id);
			}
			json({ ok: true });
			return;
		}
	}

	// POST /api/sessions/:id/wait — block until session becomes idle
	// Uses chunked transfer with periodic heartbeat newlines to prevent
	// HTTP client body-timeout (undici defaults to 300s between chunks).
	const waitMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/wait$/);
	if (waitMatch && req.method === "POST") {
		const id = waitMatch[1];
		const body = await readBody(req);
		const timeoutMs = body?.timeout_ms ?? 600_000;

		// Stream chunked response with heartbeat to keep connection alive
		res.writeHead(200, {
			"Content-Type": "application/json",
			"Transfer-Encoding": "chunked",
			"Cache-Control": "no-cache",
		});

		// Send a heartbeat newline every 60s to prevent client body-timeout
		const heartbeat = setInterval(() => {
			try { res.write("\n"); } catch { /* connection gone */ }
		}, 60_000);

		try {
			await sessionManager.waitForIdle(id, timeoutMs);
			const output = await sessionManager.getSessionOutput(id);
			const session = sessionManager.getSession(id);
			res.end(JSON.stringify({
				status: session?.status || "idle",
				output,
			}));
		} catch (err) {
			res.end(JSON.stringify({ error: String(err) }));
		} finally {
			clearInterval(heartbeat);
		}
		return;
	}

	// POST /api/sessions/:archivedId/continue — Continue-Archived (lossless)
	//
	// Clones the archived session's `.jsonl` into a fresh slot, registers it
	// as the new session's `agentSessionFile`, and lets the agent CLI rehydrate
	// from it via `switch_session` — same mechanism the restart-resume path
	// uses for live sessions. No transcript stringification, no system-prompt
	// seeding, no byte budget.
	const continueMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/continue$/);
	if (continueMatch && req.method === "POST") {
		const archivedId = continueMatch[1];
		// Body is read for parity but no fields are required — the legacy `mode`
		// parameter is ignored.
		await readBody(req).catch(() => ({}));

		// Resolve the archived session across all project contexts.
		const ps = sessionManager.getPersistedSession(archivedId);
		if (!ps) { json({ error: "session not found" }, 404); return; }
		if (!ps.archived) { json({ error: "source not archived" }, 409); return; }
		if (ps.goalId || ps.delegateOf || ps.teamGoalId || ps.assistantType) {
			json({ error: "goal, delegate, team, or assistant sessions cannot be continued" }, 422);
			return;
		}
		if (!ps.projectId || !projectRegistry.get(ps.projectId)) {
			json({ error: "source project no longer registered" }, 410);
			return;
		}

		// Resolve source `.jsonl` path — fall back to the recovery scan for legacy
		// sessions whose persisted `agentSessionFile` was never populated.
		const { sessionFileCopy, CrossRealmCopyError } = await import("./agent/session-fs.js");
		const { formatAgentSessionFilePath } = await import("./agent/agent-session-path.js");
		const { copyToolContentDirIfPresent, cleanupFailedContinue } = await import("./agent/continue-archived.js");
		const nodeFs = await import("node:fs");
		const { randomUUID } = await import("node:crypto");

		let sourceJsonl = ps.agentSessionFile;
		if (!sourceJsonl) {
			const recovered = sessionManager.recoverSessionFile(ps);
			if (recovered) sourceJsonl = recovered;
		}
		if (!sourceJsonl) {
			json({ error: "archived transcript missing or empty" }, 404);
			return;
		}

		// Verify the source file actually exists and is non-empty. For non-sandboxed
		// sessions a quick host-side stat suffices; sandboxed sessions defer to the
		// copy step (which surfaces the failure as a 500). Empty / missing → 404.
		if (!ps.sandboxed) {
			try {
				const st = nodeFs.statSync(sourceJsonl);
				if (!st.isFile() || st.size === 0) {
					json({ error: "archived transcript missing or empty" }, 404);
					return;
				}
			} catch {
				json({ error: "archived transcript missing or empty" }, 404);
				return;
			}
		}

		const proj = projectRegistry.get(ps.projectId)!;
		const projCwd = proj.rootPath;
		const wantWorktree = !!ps.worktreePath;
		let worktreeOpts: { repoPath: string } | undefined;
		if (wantWorktree) {
			try {
				if (await isGitRepo(projCwd)) {
					worktreeOpts = { repoPath: await getRepoRoot(projCwd) };
				}
			} catch { /* ignore — no worktree */ }
		}

		// Pre-compute the cloned `.jsonl` path. We use the project root cwd here;
		// for worktree-backed sessions the agent CLI will rotate to a new file
		// once the worktree cwd is final, but the cloned file we hand it via
		// `switch_session` is what gets adopted.
		const newSessionId = randomUUID();
		const destJsonl = formatAgentSessionFilePath(projCwd, Date.now(), newSessionId);

		// Copy the source `.jsonl`. Cross-realm → 422; any other failure → 500.
		const srcCtx = { sandboxed: !!ps.sandboxed, projectId: ps.projectId };
		const dstCtx = { sandboxed: !!ps.sandboxed, projectId: ps.projectId };
		try {
			await sessionFileCopy(srcCtx, sourceJsonl, dstCtx, destJsonl, sandboxManager ?? null);
		} catch (err) {
			if (err instanceof CrossRealmCopyError) {
				json({ error: "cross-realm continue not supported" }, 422);
				return;
			}
			cleanupFailedContinue(destJsonl, newSessionId, bobbitStateDir());
			jsonError(500, err, { error: `failed to clone session file: ${err instanceof Error ? err.message : String(err)}` });
			return;
		}

		// Defensive forward-compat: copy the lazy tool-content cache if present.
		try {
			copyToolContentDirIfPresent(archivedId, newSessionId, bobbitStateDir());
		} catch (err) {
			console.warn(`[continue-archived] tool-content copy failed (non-fatal): ${err}`);
		}

		const role = ps.role ? roleManager.getRole(ps.role) : undefined;
		const createOpts: any = {
			sessionId: newSessionId,
			projectId: ps.projectId,
			sandboxed: !!ps.sandboxed,
			worktreeOpts,
			preExistingAgentSessionFile: destJsonl,
			// We'll set the model explicitly below; skip the auto-selection fire-and-forget.
			skipAutoModel: !!(ps.modelProvider && ps.modelId),
		};
		// Pin the persisted model at spawn time so pi-coding-agent doesn't emit a
		// redundant initial `model_change` event with its hardcoded default.
		if (ps.modelProvider && ps.modelId) {
			createOpts.initialModel = `${ps.modelProvider}/${ps.modelId}`;
		}
		if (role) {
			createOpts.rolePrompt = role.promptTemplate;
			createOpts.roleName = role.name;
			createOpts.role = role.name;
			createOpts.accessory = role.accessory;
		}

		let newSession;
		try {
			newSession = await sessionManager.createSession(
				projCwd, undefined, undefined, undefined, createOpts,
			);
		} catch (err) {
			cleanupFailedContinue(destJsonl, newSessionId, bobbitStateDir());
			jsonError(500, err, { error: `failed to create session: ${err instanceof Error ? err.message : String(err)}` });
			return;
		}

		const baseTitle = (ps.title || "session").trim() || "session";
		const continuedTitle = `Continued: ${baseTitle}`;
		// markGenerated: prevents the first-message auto-titler from overwriting
		// "Continued: …" once the user sends their first prompt in the new session.
		sessionManager.setTitle(newSession.id, continuedTitle, { markGenerated: true });

		if (ps.modelProvider && ps.modelId) {
			// Model is pinned at spawn via createOpts.initialModel above; just
			// persist the choice so a later restore picks it up. No redundant
			// post-spawn setModel — that's the whole point of spawn-time pinning.
			sessionManager.persistSessionModel(newSession.id, ps.modelProvider, ps.modelId);
		}

		json({
			id: newSession.id,
			cwd: newSession.cwd,
			status: newSession.status,
			title: continuedTitle,
		}, 201);
		return;
	}

	// GET /api/sessions/:id/output — get final assistant output
	const outputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/output$/);
	if (outputMatch && req.method === "GET") {
		const id = outputMatch[1];
		try {
			const output = await sessionManager.getSessionOutput(id);
			json({ output });
		} catch {
			json({ error: "Failed to get output" }, 500);
		}
		return;
	}

	// PATCH /api/sessions/:id — update session properties (title, colorIndex, etc.)
	const patchMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (patchMatch && req.method === "PATCH") {
		const id = patchMatch[1];
		const body = await readBody(req);
		if (!body || typeof body !== "object") {
			json({ error: "Invalid body" }, 400);
			return;
		}

		if (typeof body.title === "string") {
			const ok = sessionManager.setTitle(id, body.title);
			if (!ok) { json({ error: "Session not found" }, 404); return; }
		}

		if (typeof body.colorIndex === "number") {
			if (body.colorIndex < 0 || body.colorIndex > 13) {
				json({ error: "colorIndex must be 0-13" }, 400);
				return;
			}
			colorStore.set(id, body.colorIndex);
		}

		if (typeof body.projectId === "string") {
			const session = sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			const oldProjectId = session.projectId;
			const newProjectId = body.projectId || undefined;
			session.projectId = newProjectId;
			// Update in both old and new project stores to ensure consistency
			sessionManager.getSessionStore(oldProjectId).update(id, { projectId: newProjectId });
			if (newProjectId !== oldProjectId) {
				sessionManager.getSessionStore(newProjectId).update(id, { projectId: newProjectId });
			}
		}

		if (typeof body.preview === "boolean") {
			const session = sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			session.preview = body.preview;
			sessionManager.persistSessionMetadata(session).catch(() => {});
			broadcastToAll({ type: "preview_changed", sessionId: id, preview: body.preview });
		}

		if (typeof body.roleId === "string" && body.roleId !== "") {
			const role = roleManager.getRole(body.roleId);
			if (!role) { json({ error: `Role "${body.roleId}" not found` }, 404); return; }
			try {
				const ok = await sessionManager.assignRole(id, role);
				if (!ok) { json({ error: "Session not found" }, 404); return; }
			} catch (err) {
				jsonError(400, err);
				return;
			}
		} else if (typeof body.roleId === "string" && body.roleId === "") {
			// Clear role assignment
			const session = sessionManager.getSession(id);
			if (session) {
				session.role = undefined;
				session.accessory = undefined;
				sessionManager.persistSessionMetadata(session).catch(() => {});
			}
		}

		if (typeof body.assistantType === "string" || typeof body.goalAssistant === "boolean" || typeof body.goalId === "string") {
			const session = sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			if (typeof body.assistantType === "string") session.assistantType = body.assistantType || undefined;
			else if (typeof body.goalAssistant === "boolean") session.assistantType = body.goalAssistant ? "goal" : undefined;
			if (typeof body.goalId === "string") session.goalId = body.goalId;
			sessionManager.persistSessionMetadata(session).catch(() => {});
		}

		if (typeof body.accessory === "string") {
			const session = sessionManager.getSession(id);
			if (session) {
				session.accessory = body.accessory || undefined;
				sessionManager.persistSessionMetadata(session).catch(() => {});
			}
		}

		if (typeof body.delegateOf === "string") {
			const session = sessionManager.getSession(id);
			if (session) {
				session.delegateOf = body.delegateOf || undefined;
				sessionManager.updateSessionMeta(id, { delegateOf: body.delegateOf || undefined });
			} else {
				sessionManager.updateSessionMeta(id, { delegateOf: body.delegateOf || undefined });
			}
		}

		if (typeof body.teamLeadSessionId === "string") {
			// Update teamLeadSessionId — works for both live and archived sessions
			const session = sessionManager.getSession(id);
			if (session) {
				sessionManager.updateSessionMeta(id, { teamLeadSessionId: body.teamLeadSessionId });
			} else {
				// Try archived session — update store directly
				const archived = sessionManager.getArchivedSession(id);
				if (archived) {
					sessionManager.updateArchivedMeta(id, { teamLeadSessionId: body.teamLeadSessionId });
				} else {
					json({ error: "Session not found" }, 404); return;
				}
			}
		}

		if (body.archived === true) {
			// Try to terminate live session first (which archives it)
			const session = sessionManager.getSession(id);
			if (session) {
				try { await sessionManager.terminateSession(id); } catch {}
			} else {
				// Dormant/store-only session — archive directly in the store
				sessionManager.storeArchive(id);
			}
		}

		json({ ok: true });
		return;
	}

	// POST /api/sessions/:id/mark-read — record that the user viewed this session
	const markReadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mark-read$/);
	if (markReadMatch && req.method === "POST") {
		const id = markReadMatch[1];
		const ok = sessionManager.markSessionRead(id);
		if (!ok) { json({ error: "session not found" }, 404); return; }
		json({ ok: true });
		return;
	}

	// ── Editable proposals (file-on-disk source of truth) ──────────────
	// docs/design/editable-proposals.md §6.4
	const proposalRouteMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/proposal\/([^/]+)(\/edit|\/seed|\/restore)?$/);
	if (proposalRouteMatch) {
		const sessionId = proposalRouteMatch[1];
		const typeStr = proposalRouteMatch[2];
		const suffix = proposalRouteMatch[3] || "";
		if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		if (!isProposalType(typeStr)) {
			json({ error: `Unknown proposal type: ${typeStr}` }, 400);
			return;
		}
		const proposalType = typeStr as ProposalType;
		const proposalStateDir = bobbitStateDir();

		// GET /api/sessions/:id/proposal/:type — read raw file
		if (suffix === "" && req.method === "GET") {
			try {
				const content = await readProposalFile(proposalStateDir, sessionId, proposalType);
				if (content === undefined) {
					json({ ok: false, code: "FILE_NOT_FOUND", message: `No ${proposalType} proposal draft. Call propose_${proposalType} first.` }, 404);
					return;
				}
				const contentType = proposalType === "goal" ? "text/markdown; charset=utf-8" : "application/yaml; charset=utf-8";
				res.writeHead(200, { "Content-Type": contentType });
				res.end(content);
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// DELETE /api/sessions/:id/proposal/:type
		if (suffix === "" && req.method === "DELETE") {
			try {
				await deleteProposalFile(proposalStateDir, sessionId, proposalType);
				if (_broadcastToSession) {
					_broadcastToSession(sessionId, { type: "proposal_cleared", sessionId, proposalType });
				}
				res.writeHead(204);
				res.end();
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// POST /api/sessions/:id/proposal/:type/edit — surgical edit
		if (suffix === "/edit" && req.method === "POST") {
			const body = await readBody(req);
			if (!body || typeof body !== "object") {
				json({ ok: false, code: "INVALID_BODY", message: "body must be JSON object" }, 400);
				return;
			}
			const { old_text, new_text } = body as { old_text?: unknown; new_text?: unknown };
			if (typeof old_text !== "string" || typeof new_text !== "string") {
				json({ ok: false, code: "INVALID_BODY", message: "old_text and new_text must be strings" }, 400);
				return;
			}
			try {
				const result = await editProposalFile(proposalStateDir, sessionId, proposalType, old_text, new_text);
				if (!result.ok) {
					const status = result.code === "FILE_NOT_FOUND" ? 404 : 400;
					json(result, status);
					return;
				}
				if (_broadcastToSession) {
					_broadcastToSession(sessionId, {
						type: "proposal_update",
						sessionId,
						proposalType,
						fields: result.parsed.fields,
						rev: result.rev,
						streaming: false,
						source: "edit",
					});
				}
				json({ ok: true, newContent: result.newContent, rev: result.rev });
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// POST /api/sessions/:id/proposal/:type/seed — called from propose_* execute()
		if (suffix === "/seed" && req.method === "POST") {
			const body = await readBody(req);
			if (!body || typeof body !== "object") {
				json({ ok: false, code: "INVALID_BODY", message: "body must be JSON object" }, 400);
				return;
			}
			const args = (body as { args?: unknown }).args;
			if (!args || typeof args !== "object" || Array.isArray(args)) {
				json({ ok: false, code: "INVALID_BODY", message: "args must be an object" }, 400);
				return;
			}
			try {
				const writeRes = await writeProposalFile(proposalStateDir, sessionId, proposalType, args as Record<string, unknown>);
				const parsed = await parseProposalFile(proposalStateDir, sessionId, proposalType);
				if (!parsed.ok) {
					json(parsed, 400);
					return;
				}
				if (_broadcastToSession) {
					_broadcastToSession(sessionId, {
						type: "proposal_update",
						sessionId,
						proposalType,
						fields: parsed.value.fields,
						rev: writeRes.rev,
						streaming: false,
						source: "seed",
					});
				}
				json({ ok: true, rev: writeRes.rev });
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// POST /api/sessions/:id/proposal/:type/restore — restore a snapshot
		if (suffix === "/restore" && req.method === "POST") {
			const body = await readBody(req);
			if (!body || typeof body !== "object") {
				json({ ok: false, code: "INVALID_BODY", message: "body must be JSON object" }, 400);
				return;
			}
			const rev = (body as { rev?: unknown }).rev;
			if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1) {
				json({ ok: false, code: "INVALID_BODY", message: "rev must be a positive integer" }, 400);
				return;
			}
			try {
				const result = await restoreSnapshot(proposalStateDir, sessionId, proposalType, rev);
				if (!result.ok) {
					const status = (result as any).code === "SNAPSHOT_NOT_FOUND" ? 404 : 400;
					json(result, status);
					return;
				}
				if (_broadcastToSession) {
					_broadcastToSession(sessionId, {
						type: "proposal_update",
						sessionId,
						proposalType,
						fields: result.fields,
						rev: result.newRev,
						streaming: false,
						source: "restore",
					});
				}
				json({ ok: true, newRev: result.newRev, fields: result.fields });
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		json({ error: "Method not allowed" }, 405);
		return;
	}

	// GET /api/sessions/:id/proposals — list all parsed proposal drafts for the session.
	//
	// Mirrors the WS-auth `proposal_update {source:"rehydrate"}` broadcast in
	// `ws/handler.ts` but as a one-shot REST call. Used by the client's fast-path
	// session switch-back (no fresh WS auth fires, so the broadcast doesn't run
	// and the client's in-memory proposal slot would otherwise stay stale).
	const proposalsListMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/proposals$/);
	if (proposalsListMatch && req.method === "GET") {
		const sessionId = proposalsListMatch[1];
		if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		const stateDir = bobbitStateDir();
		try {
			const types = await listProposalFiles(stateDir, sessionId);
			const proposals: Array<{ proposalType: string; fields: Record<string, unknown>; rev: number }> = [];
			for (const proposalType of types) {
				const parsed = await parseProposalFile(stateDir, sessionId, proposalType);
				if (parsed.ok) {
					const rev = await latestRev(stateDir, sessionId, proposalType);
					proposals.push({ proposalType, fields: parsed.value.fields, rev });
				}
			}
			json({ proposals });
		} catch (err) {
			json({ error: String((err as Error)?.message ?? err) }, 500);
		}
		return;
	}

	// POST /api/sessions/:id/generate-title — auto-generate a title from chat history.
	// Works for live sessions (calls SessionManager.autoGenerateTitle) and archived
	// sessions (parses .jsonl). Used by the rename dialog when the session is not
	// the currently focused one (no live WebSocket).
	const genTitleMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/generate-title$/);
	if (genTitleMatch && req.method === "POST") {
		const id = genTitleMatch[1];
		try {
			const title = await sessionManager.generateTitleForAnySession(id);
			if (!title) {
				json({ error: "Could not generate title (session not found or no messages)" }, 404);
				return;
			}
			json({ title });
		} catch (err) {
			json({ error: String((err as Error)?.message ?? err) }, 500);
		}
		return;
	}

	// PUT /api/sessions/:id/title — legacy rename endpoint
	const titleMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/title$/);
	if (titleMatch && req.method === "PUT") {
		const id = titleMatch[1];
		const body = await readBody(req);
		const title = body?.title;
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		const ok = sessionManager.setTitle(id, title);
		if (!ok) {
			json({ error: "Session not found" }, 404);
			return;
		}
		json({ ok: true });
		return;
	}

	// GET /api/connection-info — LAN addresses for multi-device access
	if (url.pathname === "/api/connection-info" && req.method === "GET") {
		const interfaces = await import("node:os").then((os) => os.networkInterfaces());
		const addresses: { ip: string; name: string }[] = [];
		for (const [name, addrs] of Object.entries(interfaces)) {
			if (!addrs) continue;
			for (const addr of addrs) {
				if (addr.family === "IPv4" && !addr.internal) {
					addresses.push({ ip: addr.address, name });
				}
			}
		}
		json({ addresses, port: config.port });
		return;
	}

	// GET /api/oauth/status
	if (url.pathname === "/api/oauth/status" && req.method === "GET") {
		try {
			json(oauthStatus(url.searchParams.get("provider") ?? undefined));
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// GET /api/oauth/flow-status?flowId=<id>[&provider=…] — callback-based OAuth progress
	if (url.pathname === "/api/oauth/flow-status" && req.method === "GET") {
		const flowId = url.searchParams.get("flowId");
		if (!flowId) {
			json({ error: "Missing flowId" }, 400);
			return;
		}
		const provider = url.searchParams.get("provider") || undefined;
		const status = oauthFlowStatus(flowId, provider);
		if (status.error === "flow not found") {
			json(status, 404);
			return;
		}
		json(status);
		return;
	}

	// POST /api/oauth/start — begin OAuth flow, returns auth URL
	if (url.pathname === "/api/oauth/start" && req.method === "POST") {
		try {
			const body = await readBody(req).catch(() => ({}));
			const result = await oauthStart(body?.provider);
			json(result);
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/oauth/complete — exchange code for tokens
	if (url.pathname === "/api/oauth/complete" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.flowId || !body?.code) {
			json({ error: "Missing flowId or code" }, 400);
			return;
		}
		try {
			const result = await oauthComplete(body.flowId, body.code);
			json(result, result.success ? 200 : 400);
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// GET /api/sessions/:id/file-content?path=<relative-or-absolute>&snapshotId=<id>
	// Reads a text file for inline preview. When snapshotId is provided:
	//   - If a snapshot exists on disk, returns the snapshot (historical state)
	//   - Otherwise reads the live file and saves a snapshot for future refreshes
	if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/file-content")) {
		const id = url.pathname.split("/")[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }

		const filePath = url.searchParams.get("path");
		if (!filePath) { json({ error: "Missing path parameter" }, 400); return; }

		const snapshotId = url.searchParams.get("snapshotId");
		const snapshotDir = path.join(bobbitStateDir(), "html-snapshots");
		const snapshotFile = snapshotId ? path.join(snapshotDir, `${snapshotId.replace(/[^a-zA-Z0-9_-]/g, "")}.html`) : null;

		// Return existing snapshot if available
		if (snapshotFile && fs.existsSync(snapshotFile)) {
			try {
				const content = fs.readFileSync(snapshotFile, "utf-8");
				json({ content });
			} catch {
				json({ error: "Snapshot read failed" }, 500);
			}
			return;
		}

		// Read live file
		const resolved = path.isAbsolute(filePath)
			? path.resolve(filePath)
			: path.resolve(session.cwd, filePath);

		try {
			const stat = fs.statSync(resolved);
			if (stat.isDirectory() || stat.size > 512 * 1024) {
				json({ error: "File too large or is a directory" }, 400);
				return;
			}
			const content = fs.readFileSync(resolved, "utf-8");

			// Save snapshot for future refreshes
			if (snapshotFile) {
				try {
					fs.mkdirSync(snapshotDir, { recursive: true });
					fs.writeFileSync(snapshotFile, content, "utf-8");
				} catch { /* best-effort */ }
			}

			json({ content });
		} catch {
			json({ error: "File not found" }, 404);
		}
		return;
	}

	// GET /api/sessions/:id/git-status — get git status for session's working directory (async)
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-status')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;

		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }

		// Resolve project `base_ref` config for the `aheadOfPrimary`/`behindPrimary`
		// counter — see `docs/design/base-ref.md` §5.
		let sessionBaseRef: string | undefined;
		try {
			const sessCtx = projectContextManager.getContextForSession(id);
			if (sessCtx) sessionBaseRef = sessCtx.projectConfigStore.get("base_ref") || undefined;
		} catch { /* config unavailable — fall through */ }

		// Optional: run git fetch first when ?fetch=true is passed
		const sessUntracked = url.searchParams.get('untracked') === '1';
		if (url.searchParams.get('fetch') === 'true') {
			try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch { /* best-effort */ }
			invalidateGitStatusCache(cwd, cid);
		}

		// Single attempt — native parallel execFile is fast (50–150 ms p50 on
		// Windows) and errors are not cached, so the client retry loop in
		// `git-status-refresh.ts` (4 attempts × 0/500/2000/5000 ms backoff) is
		// the resilience layer for transient failures.
		let result: Awaited<ReturnType<typeof batchGitStatus>> | undefined;
		try {
			result = await batchGitStatus(cwd, cid, { untracked: sessUntracked, configuredBaseRef: sessionBaseRef });
		} catch (err: any) {
			console.error("[git-status handler] error for session", id, "cwd=", cwd, "code=", err?.code, "signal=", err?.signal, "killed=", err?.killed, "stderr=", err?.stderr, "message=", err?.message);
			jsonError(500, err, { error: err?.stderr?.trim() || err?.message || "git status failed" });
			return;
		}
		if (!result) { json({ error: "Not a git repository" }, 400); return; }

		json(result);

		// Auto-push: for feature branches with unpushed commits, push in background
		if (!shouldSkipRemotePush()) {
			if (!result.isOnPrimary && result.ahead > 0 && result.hasUpstream) {
				execAsync('git push', { cwd, encoding: "utf-8", timeout: 30000 }).catch(() => {});
			} else if (!result.isOnPrimary && !result.hasUpstream && result.branch && /^session\//.test(result.branch)) {
				// Session branches without upstream: set up tracking and push
				execAsync(`git push -u origin ${result.branch}`, { cwd, encoding: "utf-8", timeout: 30000 }).catch(() => {});
			}
		}
		return;
	}
	// GET /api/sessions/:id/tool-content/:messageIndex/:blockIndex — lazy-load full tool input content
	const toolContentMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/tool-content\/(\d+)\/(\d+)$/);
	if (toolContentMatch && req.method === "GET") {
		const [, id, msgIdxStr, blkIdxStr] = toolContentMatch;
		const messageIndex = parseInt(msgIdxStr, 10);
		const blockIndex = parseInt(blkIdxStr, 10);
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		try {
			const msgsResp = await session.rpcClient.getMessages();
			const messages = msgsResp?.data?.messages || msgsResp?.data;
			if (!Array.isArray(messages)) { json({ error: "Could not retrieve messages" }, 500); return; }
			const msg = messages[messageIndex];
			if (!msg) { json({ error: "Message not found" }, 404); return; }
			const content = Array.isArray(msg.content) ? msg.content : [];
			const block = content[blockIndex];
			if (!block) { json({ error: "Block not found" }, 404); return; }
			let toolContent = block.arguments?.content ?? block.input?.content;
			// Fallback: text blocks (e.g. preview_open snapshot blocks in
			// toolResult messages) store their payload in `block.text`.
			if (toolContent === undefined && block.type === "text" && typeof block.text === "string") {
				toolContent = block.text;
			}
			if (toolContent === undefined) { json({ error: "No content in block" }, 404); return; }
			json({ content: toolContent });
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// GET /api/sessions/:id/transcript — paginated, regex-filterable transcript reader
	// Backs the `read_session` tool extension. See `src/server/agent/transcript-reader.ts`.
	const transcriptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
	if (transcriptMatch && req.method === "GET") {
		const [, targetId] = transcriptMatch;
		// Resolve target session (live or persisted).
		const targetPs = sessionManager.getPersistedSession(targetId);
		if (!targetPs) { json({ error: "session_not_found" }, 404); return; }
		if (!targetPs.agentSessionFile) { json({ error: "transcript_unavailable" }, 404); return; }

		// Authorization: caller must belong to the same project as the target.
		// Caller session id is propagated via `x-bobbit-session-id` header by the
		// extension; if missing, fall back to allow (e.g. UI-initiated calls go
		// through Bearer auth which already gates by project).
		const callerSid = req.headers["x-bobbit-session-id"];
		const callerSidStr = Array.isArray(callerSid) ? callerSid[0] : callerSid;
		if (callerSidStr) {
			const callerPs = sessionManager.getPersistedSession(callerSidStr);
			if (callerPs && targetPs.projectId && callerPs.projectId && callerPs.projectId !== targetPs.projectId) {
				json({ error: "permission_denied" }, 403); return;
			}
		}

		// Parse query params.
		const qp = url.searchParams;
		function parseIntParam(name: string): number | undefined {
			const raw = qp.get(name);
			if (raw === null) return undefined;
			const n = Number(raw);
			if (!Number.isFinite(n)) {
				throw new TranscriptReaderError("invalid_params", `${name} is not a number`);
			}
			return n;
		}
		try {
			const params = {
				offset: parseIntParam("offset"),
				limit: parseIntParam("limit"),
				pattern: qp.get("pattern") ?? undefined,
				caseSensitive: qp.get("case_sensitive") === "1" || qp.get("case_sensitive") === "true",
				context: parseIntParam("context"),
				verbose: qp.get("verbose") === "1" || qp.get("verbose") === "true",
			};
			const ctx: SessionFsContext = { sandboxed: targetPs.sandboxed, projectId: targetPs.projectId };
			const envelope = await readTranscript(params, {
				readContent: () => sessionFileRead(ctx, targetPs.agentSessionFile, sandboxManager),
			});
			json(envelope);
		} catch (err) {
			if (err instanceof TranscriptReaderError) {
				const status = err.code === "transcript_unavailable" ? 404 : 400;
				json({ error: err.code, detail: err.message }, status);
			} else {
				jsonError(500, err, { error: "internal_error", detail: String(err) });
			}
		}
		return;
	}

	// GET /api/sessions/:id/transcript/before-compaction — orphaned
	// pre-compaction history for the named sidecar compaction id, paginated.
	// See docs/design/persist-compaction-history.md §4.2.
	const beforeCompactionMatch = url.pathname.match(
		/^\/api\/sessions\/([^/]+)\/transcript\/before-compaction$/,
	);
	if (beforeCompactionMatch && req.method === "GET") {
		const [, targetId] = beforeCompactionMatch;
		const targetPs = sessionManager.getPersistedSession(targetId);
		if (!targetPs) { json({ error: "session_not_found" }, 404); return; }
		if (!targetPs.agentSessionFile) { json({ error: "transcript_unavailable" }, 404); return; }

		// Caller-project authorisation header check — same shape as the
		// sibling transcript route.
		const callerSid = req.headers["x-bobbit-session-id"];
		const callerSidStr = Array.isArray(callerSid) ? callerSid[0] : callerSid;
		if (callerSidStr) {
			const callerPs = sessionManager.getPersistedSession(callerSidStr);
			if (callerPs && targetPs.projectId && callerPs.projectId && callerPs.projectId !== targetPs.projectId) {
				json({ error: "permission_denied" }, 403); return;
			}
		}

		const compactionId = url.searchParams.get("compactionId");
		if (!compactionId) {
			json({ error: "invalid_params", detail: "compactionId required" }, 400);
			return;
		}
		const entry = findCompactionSidecarEntry(targetId, compactionId);
		if (!entry) {
			json({ error: "compaction_not_found" }, 404);
			return;
		}
		const qp2 = url.searchParams;
		let cursor: number | undefined;
		let limit: number | undefined;
		const verbose = qp2.get("verbose") === "1" || qp2.get("verbose") === "true";
		try {
			if (qp2.has("cursor")) {
				const c = Number(qp2.get("cursor"));
				if (!Number.isFinite(c) || !Number.isInteger(c) || c < 0) {
					throw new TranscriptReaderError("invalid_params", "cursor must be a non-negative integer");
				}
				cursor = c;
			}
			if (qp2.has("limit")) {
				const n = Number(qp2.get("limit"));
				if (!Number.isFinite(n) || !Number.isInteger(n)) {
					throw new TranscriptReaderError("invalid_params", "limit must be an integer");
				}
				limit = n;
			}
		} catch (err) {
			if (err instanceof TranscriptReaderError) {
				json({ error: err.code, detail: err.message }, 400);
			} else {
				jsonError(500, err, { error: "internal_error", detail: String(err) });
			}
			return;
		}
		const ctx2: SessionFsContext = { sandboxed: targetPs.sandboxed, projectId: targetPs.projectId };
		try {
			const envelope = await readOrphanedBeforeCompaction(
				{ compactionId, cursor, limit, verbose },
				{
					readContent: () => sessionFileRead(ctx2, targetPs.agentSessionFile!, sandboxManager),
					firstKeptEntryId: entry.firstKeptEntryId,
				},
			);
			json(envelope);
		} catch (err) {
			if (err instanceof TranscriptReaderError) {
				const status = err.code === "transcript_unavailable" ? 404 : 400;
				json({ error: err.code, detail: err.message }, status);
			} else {
				jsonError(500, err, { error: "internal_error", detail: String(err) });
			}
		}
		return;
	}

	// GET /api/sessions/:id/git-diff — unified diff for session working directory
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-diff')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const file = url.searchParams.get("file") || undefined;
		try {
			const diff = await getGitDiff(cwd, file, cid);
			json({ diff });
		} catch (err: any) {
			if (err.message === "INVALID_PATH") { json({ error: "Invalid file path" }, 400); return; }
			if (err.message === "NO_DIFF") { json({ error: "No diff found" }, 404); return; }
			jsonError(500, err);
		}
		return;
	}
	// GET /api/sessions/:id/commits — unpushed commits for session
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/commits')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: 'Session not found' }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ commits: [] }); return; }
		try {
			let branch = '';
			try { branch = await execGit('git rev-parse --abbrev-ref HEAD', cwd, 5000, cid); }
			catch { json({ commits: [] }); return; }

			let hasUpstream = false;
			try { await execGit(`git rev-parse --abbrev-ref ${branch}@{u}`, cwd, 5000, cid); hasUpstream = true; } catch {}

			const limit = 50;
			const direction = url.searchParams.get('direction'); // 'behind' to show incoming commits
			const vs = url.searchParams.get('vs'); // 'primary' to compare vs origin/master
			let rangeSpec: string;
			if (vs === 'primary') {
				// Compare against origin/<primary>
				let primaryBranch = 'master';
				try {
					const remoteHead = await execGit('git symbolic-ref refs/remotes/origin/HEAD', cwd, 5000, cid);
					primaryBranch = remoteHead.replace('refs/remotes/origin/', '');
				} catch {
					try { await execGit('git rev-parse --verify refs/heads/master', cwd, 5000, cid); primaryBranch = 'master'; }
					catch { try { await execGit('git rev-parse --verify refs/heads/main', cwd, 5000, cid); primaryBranch = 'main'; } catch {} }
				}
				let primaryRef = primaryBranch;
				try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, cwd, 5000, cid); primaryRef = `origin/${primaryBranch}`; } catch {}
				rangeSpec = direction === 'behind' ? `HEAD..${primaryRef}` : `${primaryRef}..HEAD`;
			} else {
				rangeSpec = direction === 'behind' && hasUpstream
					? 'HEAD..@{u}'
					: hasUpstream ? '@{u}..HEAD' : `-${limit} HEAD`;
			}

			const out = await execGit(`git log --format="%H|%h|%s|%an|%aI" --shortstat ${rangeSpec}`, cwd, 10000, cid);
			const lines = out.split('\n');
			const commits: Array<{sha: string; shortSha: string; message: string; author: string; timestamp: string; filesChanged: number; insertions: number; deletions: number}> = [];

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (!line.includes('|')) continue;
				const parts = line.split('|');
				if (parts.length < 5) continue;
				const [sha, shortSha, message, author, timestamp] = parts;
				// Next non-empty line should be the shortstat
				let filesChanged = 0, insertions = 0, deletions = 0;
				for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
					const statLine = lines[j].trim();
					if (statLine.includes('file') && statLine.includes('changed')) {
						const fm = statLine.match(/(\d+) file/);
						const im = statLine.match(/(\d+) insertion/);
						const dm = statLine.match(/(\d+) deletion/);
						if (fm) filesChanged = parseInt(fm[1], 10);
						if (im) insertions = parseInt(im[1], 10);
						if (dm) deletions = parseInt(dm[1], 10);
						break;
					}
				}
				commits.push({ sha, shortSha, message, author, timestamp, filesChanged, insertions, deletions });
			}

			json({ commits });
		} catch (e: any) {
			json({ error: 'Failed to read git log', detail: e.message }, 500);
		}
		return;
	}
	// GET /api/sessions/:id/pr-status — PR status for session's branch
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/pr-status')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		// Use goal branch if available so we find the right PR even if the worktree HEAD diverged.
		// For non-goal sessions, fall back to the session's persisted branch — needed for sandbox
		// sessions where the host worktree may not have the right branch checked out.
		const goalBranch = session.goalId ? getGoalAcrossProjects(session.goalId)?.branch : undefined;
		let sessionBranch = goalBranch || sessionManager.getPersistedSession(id)?.branch;
		// For sandboxed sessions, the persisted branch may not match the actual container branch
		// (e.g. gateway assigns a different worktree name). Detect the real branch from the container.
		if (cid && cwd) {
			try {
				const actualBranch = await execGit("git rev-parse --abbrev-ref HEAD", cwd, 5000, cid);
				if (actualBranch && actualBranch !== "HEAD") sessionBranch = actualBranch;
			} catch { /* fall back to persisted branch */ }
		}
		// PR status uses `gh` CLI which needs host filesystem — use worktreePath for sandboxed sessions
		const prCwd = cid ? (session.worktreePath || process.cwd()) : cwd;
		const pr = await getCachedPrStatus(prCwd, sessionBranch, process.cwd());
		if (pr) {
			const goalId = session.goalId;
			if (goalId) prStatusStore.set(goalId, pr);
			json(pr);
		} else { json({ error: "No PR found" }, 404); }
		return;
	}

	// POST /api/sessions/:id/git-pull — pull latest from remote
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-pull')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			const output = await execGit('git pull', cwd, 30000, cid);
			invalidateGitStatusCache(cwd, cid);
			json({ ok: true, output });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// POST /api/sessions/:id/git-push — push local commits to remote
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-push')) {
		if (shouldSkipRemotePush()) { json({ ok: true, output: "skipped (test mode)" }); return; }
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			const output = await execGit('git push', cwd, 30000, cid);
			invalidateGitStatusCache(cwd, cid);
			json({ ok: true, output });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// POST /api/sessions/:id/git-squash-push — squash all branch commits and push directly to master
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-squash-push')) {
		if (shouldSkipRemotePush()) { json({ ok: true, output: "skipped (test mode)" }); return; }
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			// Detect primary branch
			let primaryBranch = "master";
			try {
				const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", cwd, 5000, cid);
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { await execGit("git rev-parse --verify refs/heads/master", cwd, 5000, cid); primaryBranch = "master"; }
				catch { try { await execGit("git rev-parse --verify refs/heads/main", cwd, 5000, cid); primaryBranch = "main"; } catch { /* keep default */ } }
			}

			// Fetch latest master
			await execGit(`git fetch origin ${primaryBranch}`, cwd, 30000, cid);
			const primaryRef = `origin/${primaryBranch}`;

			// Check we have commits ahead
			const aheadCount = parseInt(await execGit(`git rev-list --count ${primaryRef}..HEAD`, cwd, 5000, cid), 10) || 0;
			if (aheadCount === 0) { json({ error: "No commits ahead of master" }, 400); return; }

			// Build commit message from branch commits
			const logOutput = await execGit(`git log --format="%s" ${primaryRef}..HEAD`, cwd, 5000, cid);
			const commitMessages = logOutput.trim().split("\n").filter(Boolean);
			const branch = await execGit("git rev-parse --abbrev-ref HEAD", cwd, 5000, cid);
			const summary = commitMessages.length === 1
				? commitMessages[0]
				: `Squash ${branch} (${commitMessages.length} commits)`;
			const body = commitMessages.length > 1
				? commitMessages.map(m => `- ${m}`).join("\n")
				: "";
			const fullMessage = body ? `${summary}\n\n${body}` : summary;

			// Create squash commit on top of origin/master using plumbing (no checkout needed)
			// 1. Create a tree that represents the merge result
			const mergeTree = await execGit(`git merge-tree --write-tree ${primaryRef} HEAD`, cwd, 5000, cid);
			// 2. Create a commit object with that tree, parented on origin/master
			// For sandboxed sessions, write temp file inside container
			const msgFile = cid ? `/tmp/SQUASH_MSG_${Date.now()}` : path.join(cwd, ".git", "SQUASH_MSG");
			if (cid) {
				await execFileAsync("docker", [
					"exec", "-w", cwd, cid, "/bin/sh", "-c", `cat > ${msgFile} << 'BOBBIT_EOF'\n${fullMessage}\nBOBBIT_EOF`,
				], { encoding: "utf-8", timeout: 5000, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
			} else {
				fs.writeFileSync(msgFile, fullMessage, "utf-8");
			}
			const squashCommit = await execGit(`git commit-tree ${mergeTree} -p ${primaryRef} -F "${msgFile}"`, cwd, 5000, cid);
			if (cid) {
				await execGit(`rm -f ${msgFile}`, cwd, 5000, cid).catch(() => {});
			} else {
				fs.unlinkSync(msgFile);
			}
			// 3. Push that commit to master
			await execGit(`git push origin ${squashCommit}:refs/heads/${primaryBranch}`, cwd, 30000, cid);
			invalidateGitStatusCache(cwd, cid);

			json({ ok: true, output: `Squash pushed ${aheadCount} commit${aheadCount > 1 ? "s" : ""} to ${primaryBranch}` });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			// Check for merge conflicts from merge-tree
			if (msg.includes("CONFLICT") || msg.includes("merge-tree")) {
				json({ error: "Merge conflicts with master. Use 'Merge master' first to resolve." }, 409);
			} else {
				json({ error: msg }, 500);
			}
		}
		return;
	}

	// POST /api/sessions/:id/git-merge-primary — merge origin/master into current branch
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-merge-primary')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			// Detect primary branch
			let primaryBranch = "master";
			try {
				const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", cwd, 5000, cid);
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { await execGit("git rev-parse --verify refs/heads/master", cwd, 5000, cid); primaryBranch = "master"; }
				catch { try { await execGit("git rev-parse --verify refs/heads/main", cwd, 5000, cid); primaryBranch = "main"; } catch { /* keep default */ } }
			}
			await execGit(`git fetch origin ${primaryBranch}`, cwd, 30000, cid);
			const output = await execGit(`git rebase origin/${primaryBranch}`, cwd, 30000, cid);

			// After rebase, check if orphaned commits remain (common after squash-merge PRs).
			// If the tree is identical to origin/primary (no diff), the commits are redundant —
			// reset to origin/primary to clean them up.
			const aheadAfter = parseInt(await execGitSafe(`git rev-list --count origin/${primaryBranch}..HEAD`, cwd, "0", cid), 10) || 0;
			if (aheadAfter > 0) {
				const diff = await execGitSafe(`git diff origin/${primaryBranch}..HEAD`, cwd, "", cid);
				if (diff.trim() === "") {
					// Tree is identical — these are orphaned commits from a squash merge
					await execGit(`git reset --hard origin/${primaryBranch}`, cwd, 10000, cid);
					invalidateGitStatusCache(cwd, cid);
					json({ ok: true, output: `Rebased and reset ${aheadAfter} orphaned commit(s) from squash merge` });
					return;
				}
			}
			invalidateGitStatusCache(cwd, cid);

			json({ ok: true, output });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// POST /api/sessions/:id/pr-merge — merge PR for session's branch
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/pr-merge')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const body = await readBody(req);
		const method = body?.method ?? "squash";
		if (!["merge", "squash", "rebase"].includes(method)) {
			json({ error: "Invalid merge method. Must be merge, squash, or rebase." }, 400);
			return;
		}
		const sessAdminFlag = body?.admin ? " --admin" : "";
		// Prefer the client-provided branch (headRefName from PR status) so the merge
		// targets the exact PR the widget displayed — avoids mismatches when the session's
		// persisted branch differs from the PR's head ref (e.g. staff/team agent worktrees).
		const clientBranch = typeof body?.branch === "string" ? body.branch : undefined;
		const goalBranch = session.goalId ? getGoalAcrossProjects(session.goalId)?.branch : undefined;
		const sessMergeBranch = clientBranch || goalBranch || sessionManager.getPersistedSession(id)?.branch;
		const sessMergeBranchArg = sessMergeBranch ? ` ${sessMergeBranch}` : "";
		try {
			// PR merge uses `gh` CLI — for sandboxed sessions, run on host worktree
			const mergeCwd = cid ? (session.worktreePath || cwd) : cwd;
			await execAsync(`gh pr merge${sessMergeBranchArg} --${method}${sessAdminFlag}`, { cwd: mergeCwd, encoding: "utf-8", timeout: 30000 });
			_prCache.delete(cwd);
			if (sessMergeBranch) _prCache.delete(`${cwd}::${sessMergeBranch}`);
			json({ ok: true });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// GET /api/slash-skills — discover .claude/skills/ SKILL.md files for autocomplete
	if (url.pathname === "/api/slash-skills" && req.method === "GET") {
		const rawCwd = url.searchParams.get("cwd") || process.cwd();
		const projectId = url.searchParams.get("projectId");
		const resolvedStore = resolveProjectConfigStore(projectId);
		// For sandboxed sessions the cwd is a container-internal path (e.g. /workspace-wt/...).
		// Skill files live on the host, so resolve the project rootPath for discovery.
		const cwd = resolveSkillDiscoveryCwd(rawCwd, projectId);
		const skills = discoverSlashSkills(cwd, resolvedStore);
		json({ skills: skills.map((s) => ({ name: s.name, description: s.description, argumentHint: s.argumentHint, source: s.source })) });
		return;
	}

	// GET /api/slash-skills/details — full slash skill details including content and file paths
	if (url.pathname === "/api/slash-skills/details" && req.method === "GET") {
		const rawCwd = url.searchParams.get("cwd") || process.cwd();
		const projectId = url.searchParams.get("projectId");
		const resolvedStore = resolveProjectConfigStore(projectId);
		const cwd = resolveSkillDiscoveryCwd(rawCwd, projectId);
		const skills = discoverSlashSkills(cwd, resolvedStore);
		const directories = getSkillDirectories(cwd, resolvedStore);
		json({ skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source, filePath: s.filePath, content: s.content })), directories });
		return;
	}

	// ── Workflow endpoints ──────────────────────────────────────────

	// GET /api/workflows — project-scoped only. Without projectId returns [].
	const workflowsMatch = url.pathname === "/api/workflows";
	if (workflowsMatch && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		const resolved = configCascade.resolveWorkflows(projectId);
		json({ workflows: resolved.map(r => ({ ...r.item, origin: r.origin, ...(r.overrides ? { overrides: r.overrides } : {}) })) });
		return;
	}

	// POST /api/workflows — requires projectId.
	if (workflowsMatch && req.method === "POST") {
		const body = await readBody(req);
		if (!body) { json({ error: "Missing body" }, 400); return; }
		const targetProjectId = body?.projectId;
		if (!targetProjectId) { json({ error: "projectId required" }, 400); return; }
		try {
			const ctx = projectContextManager.getOrCreate(targetProjectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			const now = Date.now();
			const workflow = {
				id: body.id as string,
				name: (body.name as string) ?? body.id,
				description: (body.description as string) ?? "",
				gates: body.gates || [],
				createdAt: now,
				updatedAt: now,
			};
			if (!workflow.id || typeof workflow.id !== "string") throw new Error("Missing id");
			ctx.workflowStore.put(workflow);
			json(workflow, 201);
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/workflows/:id/customize — copy resolved workflow into a project.
	const workflowCustomizeMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/customize$/);
	if (workflowCustomizeMatch && req.method === "POST") {
		const id = decodeURIComponent(workflowCustomizeMatch[1]);
		const projectId = url.searchParams.get("projectId") || undefined;
		if (!projectId) { json({ error: "projectId required" }, 400); return; }

		const resolved = configCascade.resolveWorkflows(projectId);
		const source = resolved.find(r => r.item.id === id);
		if (!source) { json({ error: "Workflow not found" }, 404); return; }

		const ctx = projectContextManager.getOrCreate(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }

		const now = Date.now();
		const copy = { ...source.item, createdAt: now, updatedAt: now };
		ctx.workflowStore.put(copy);
		json(copy, 201);
		return;
	}

	// DELETE /api/workflows/:id/override — remove project-level override.
	const workflowOverrideMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/override$/);
	if (workflowOverrideMatch && req.method === "DELETE") {
		const id = decodeURIComponent(workflowOverrideMatch[1]);
		const projectId = url.searchParams.get("projectId") || undefined;
		if (!projectId) { json({ error: "projectId required" }, 400); return; }

		const ctx = projectContextManager.getOrCreate(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }

		ctx.workflowStore.remove(id);
		json({ ok: true });
		return;
	}

	// GET /api/workflows/:id
	const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
	if (workflowMatch && req.method === "GET") {
		const id = decodeURIComponent(workflowMatch[1]);
		const qProjectId = url.searchParams.get("projectId") || undefined;
		if (!qProjectId) { json({ error: "Workflow not found" }, 404); return; }
		const resolved = configCascade.resolveWorkflows(qProjectId);
		const found = resolved.find(r => r.item.id === id);
		if (!found) { json({ error: "Workflow not found" }, 404); return; }
		json({ ...found.item, origin: found.origin, ...(found.overrides ? { overrides: found.overrides } : {}) });
		return;
	}

	// PUT /api/workflows/:id — requires projectId.
	if (workflowMatch && req.method === "PUT") {
		const id = decodeURIComponent(workflowMatch[1]);
		const body = await readBody(req);
		if (!body) { json({ error: "Missing body" }, 400); return; }
		const qProjectId = url.searchParams.get("projectId") || undefined;
		if (!qProjectId) { json({ error: "projectId required" }, 400); return; }
		const ctx = projectContextManager.getOrCreate(qProjectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		const existing = ctx.workflowStore.get(id);
		if (!existing) { json({ error: "Workflow not found in project" }, 404); return; }
		const updated = {
			...existing,
			name: body.name ?? existing.name,
			description: body.description ?? existing.description,
			gates: Array.isArray(body.gates) ? body.gates : existing.gates,
			id,
			updatedAt: Date.now(),
		};
		ctx.workflowStore.put(updated);
		json(updated);
		return;
	}

	// DELETE /api/workflows/:id — requires projectId.
	if (workflowMatch && req.method === "DELETE") {
		const id = decodeURIComponent(workflowMatch[1]);
		const qProjectId = url.searchParams.get("projectId") || undefined;
		if (!qProjectId) { json({ error: "projectId required" }, 400); return; }
		const ctx = projectContextManager.getOrCreate(qProjectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		ctx.workflowStore.remove(id);
		json({ ok: true });
		return;
	}

	// ── Cost endpoints ─────────────────────────────────────────────

	// GET /api/sessions/:id/cost/breakdown — cost breakdown including delegates
	const sessionCostBreakdownMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cost\/breakdown$/);
	if (sessionCostBreakdownMatch && req.method === "GET") {
		const sessionId = sessionCostBreakdownMatch[1];
		const live = sessionManager.getSession(sessionId);
		const sessionForCost = live ?? sessionManager.getPersistedSession(sessionId);
		if (!sessionForCost?.projectId) {
			json({ error: "Session not found or has no project" }, 404);
			return;
		}
		const costTracker = sessionManager.getCostTracker(sessionForCost.projectId);
		const allCosts = costTracker.getAllCosts();
		const sessionCost = allCosts.get(sessionId);
		if (!sessionCost) {
			json({ error: "No cost data" }, 404);
			return;
		}

		// Find delegate sessions
		const delegates: any[] = [];
		const allSessions = [...sessionManager.listSessions(), ...sessionManager.listArchivedSessions()];
		for (const s of allSessions) {
			if ((s as any).delegateOf === sessionId) {
				const dCost = allCosts.get(s.id);
				if (dCost && dCost.totalCost > 0) {
					delegates.push({
						sessionId: s.id,
						title: (s as any).title || s.id.slice(0, 8),
						...dCost,
					});
				}
			}
		}
		delegates.sort((a, b) => b.totalCost - a.totalCost);

		json({
			session: { sessionId, ...sessionCost },
			delegates,
		});
		return;
	}

	// GET /api/sessions/:id/cost — cost for a single session
	const sessionCostMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cost$/);
	if (sessionCostMatch && req.method === "GET") {
		const id = sessionCostMatch[1];
		const liveSession = sessionManager.getSession(id);
		const sessionForCost = liveSession ?? sessionManager.getPersistedSession(id);
		if (!sessionForCost?.projectId) {
			json({ error: "Session not found or has no project" }, 404);
			return;
		}
		const cost = sessionManager.getCostTracker(sessionForCost.projectId).getSessionCost(id);
		if (!cost) {
			json({ error: "No cost data for this session" }, 404);
			return;
		}
		json(cost);
		return;
	}

	// GET /api/goals/:goalId/cost/breakdown — per-session cost breakdown for a goal
	const goalCostBreakdownMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/cost\/breakdown$/);
	if (goalCostBreakdownMatch && req.method === "GET") {
		const goalId = goalCostBreakdownMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) {
			json({ error: "Goal not found" }, 404);
			return;
		}
		if (!goal.projectId) {
			json({ aggregate: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 }, sessions: [] });
			return;
		}
		const sessionIds = sessionManager.getAllSessionIdsForGoal(goalId);
		const costTracker = sessionManager.getCostTracker(goal.projectId);
		const allCosts = costTracker.getAllCosts();

		// Build per-session breakdown with metadata
		const sessions: any[] = [];
		for (const sid of sessionIds) {
			const cost = allCosts.get(sid);
			if (!cost || cost.totalCost === 0) continue;

			// Get session metadata from live sessions or store
			const live = sessionManager.listSessions().find(s => s.id === sid);
			const archived = !live ? sessionManager.listArchivedSessions().find(s => s.id === sid) : null;
			const meta = live || archived;

			sessions.push({
				sessionId: sid,
				title: (meta as any)?.title || sid.slice(0, 8),
				role: (meta as any)?.role || null,
				delegateOf: (meta as any)?.delegateOf || null,
				assistantType: (meta as any)?.assistantType || null,
				taskId: (meta as any)?.taskId || null,
				...cost,
			});
		}

		// Sort by cost descending
		sessions.sort((a, b) => b.totalCost - a.totalCost);

		// Compute aggregate
		const aggregate = costTracker.getGoalCost(goalId, sessionIds);

		json({ aggregate, sessions });
		return;
	}

	// GET /api/goals/:goalId/cost — aggregate cost across all sessions linked to a goal
	const goalCostMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/cost$/);
	if (goalCostMatch && req.method === "GET") {
		const goalId = goalCostMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) {
			json({ error: "Goal not found" }, 404);
			return;
		}
		if (!goal.projectId) {
			json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
			return;
		}
		const sessionIds = sessionManager.getAllSessionIdsForGoal(goalId);
		const cost = sessionManager.getCostTracker(goal.projectId).getGoalCost(goalId, sessionIds);
		json(cost);
		return;
	}

	// GET /api/goals/:goalId/tree-cost — sum of cost across the descendant goal tree
	const goalTreeCostMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/tree-cost$/);
	if (goalTreeCostMatch && req.method === "GET") {
		if (!requireSubgoalsEnabled()) return;
		const goalId = goalTreeCostMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const rootGoalId = goal.rootGoalId ?? goal.id;
		if (!goal.projectId) {
			json({ rootGoalId, totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0, breakdown: [] });
			return;
		}
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) { json({ error: "Goal project context not found" }, 404); return; }
		const allGoals = ctx.goalStore.getAll();
		const costTracker = sessionManager.getCostTracker(goal.projectId);
		const result = computeTreeCost(
			rootGoalId,
			allGoals,
			costTracker,
			(gid) => sessionManager.getAllSessionIdsForGoal(gid),
		);
		json(result);
		return;
	}

	// GET /api/goals/:goalId/descendants — full descendant goal records (live + archived)
	// Powers the Plan tab's data source so archived children remain visible in
	// the DAG independently of the sidebar's "See Archived" toggle.
	const goalDescendantsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/descendants$/);
	if (goalDescendantsMatch && req.method === "GET") {
		const goalId = goalDescendantsMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!goal.projectId) { json({ goals: [] }); return; }
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) { json({ error: "Goal project context not found" }, 404); return; }
		const allGoals = ctx.goalStore.getAll();
		const descendants = collectDescendants(goalId, allGoals);
		json({ goals: descendants });
		return;
	}

	// GET /api/tasks/:id/cost — cost for the session(s) assigned to a task
	const taskCostMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cost$/);
	if (taskCostMatch && req.method === "GET") {
		const taskId = taskCostMatch[1];
		const task = getTaskManagerForTask(taskId).getTask(taskId);
		if (!task) {
			json({ error: "Task not found" }, 404);
			return;
		}
		if (!task.assignedSessionId) {
			json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
			return;
		}
		const taskSessionLive = sessionManager.getSession(task.assignedSessionId);
		const taskSession = taskSessionLive ?? sessionManager.getPersistedSession(task.assignedSessionId);
		if (!taskSession?.projectId) {
			json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
			return;
		}
		const cost = sessionManager.getCostTracker(taskSession.projectId).getSessionCost(task.assignedSessionId);
		json(cost ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
		return;
	}

	// ── Preview mount endpoints ──────────────────────────────────────
	const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

	// POST /api/preview/mount?sessionId=<sid> — v3 per-session preview mount.
	// Accepts {html} (with optional {entry}) or {file: absolutePath}. Returns
	// {url, path, entry, mtime}. See docs/design/embedded-html-preview-rewrite.md §6.
	if (url.pathname === "/api/preview/mount" && req.method === "POST") {
		const sessionId = url.searchParams.get("sessionId") || "";
		if (!VALID_SESSION_ID.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		if (sandboxScope && !sandboxScope.sessionIds.has(sessionId)) {
			json({ error: "Forbidden: session out of scope" }, 403);
			return;
		}
		const body = await readBody(req).catch(() => ({}));
		const hasHtml = typeof body?.html === "string";
		const hasFile = typeof body?.file === "string" && body.file.length > 0;
		const hasAssets = Array.isArray(body?.assets);
		const hasManifest = typeof body?.manifest === "string" && body.manifest.length > 0;
		if (!hasHtml && !hasFile) {
			json({ error: "Body must contain one of 'html' or 'file'" }, 400);
			return;
		}
		if (hasHtml && (hasAssets || hasManifest)) {
			json({ error: "`assets`/`manifest` only valid with `file`" }, 400);
			return;
		}
		try {
			let result: previewMount.MountResult | previewMount.MountFileResult;
			if (hasHtml) {
				// `html` wins over `file` when both are provided.
				let entry: string | undefined;
				if (typeof body.entry === "string" && body.entry.length > 0) {
					const e = body.entry;
					if (e.includes("/") || e.includes("\\") || e.includes("..") || e.includes("\0")) {
						json({ error: "Invalid entry name" }, 400);
						return;
					}
					entry = e;
				}
				result = previewMount.writeInline(sessionId, body.html as string, entry);
			} else {
				const filePath = body.file as string;
				if (!path.isAbsolute(filePath)) {
					json({ error: "file path must be absolute" }, 400);
					return;
				}
				if (!fs.existsSync(filePath)) {
					json({ error: "file not found" }, 404);
					return;
				}
				let stat: fs.Stats;
				try { stat = fs.statSync(filePath); } catch {
					json({ error: "file not found" }, 404);
					return;
				}
				if (!stat.isFile()) {
					json({ error: "path is not a regular file" }, 404);
					return;
				}
				const base = path.basename(filePath).toLowerCase();
				if (!base.endsWith(".html") && !base.endsWith(".htm")) {
					json({ error: "file must end in .html or .htm" }, 400);
					return;
				}
				// Collect assets from inline `assets[]` and optional `manifest` JSON.
				const declared: string[] = [];
				if (hasAssets) {
					for (const a of body.assets as unknown[]) {
						if (typeof a !== "string") {
							json({ error: "`assets[]` entries must be strings" }, 400);
							return;
						}
						declared.push(a);
					}
				}
				if (hasManifest) {
					const manifestRel = body.manifest as string;
					if (path.isAbsolute(manifestRel) || manifestRel.includes("\0") ||
						manifestRel.includes("\\") || manifestRel.split("/").some(s => s === "..")) {
						json({ error: "Invalid manifest path" }, 400);
						return;
					}
					const manifestAbs = path.resolve(path.dirname(filePath), manifestRel);
					if (!fs.existsSync(manifestAbs)) {
						json({ error: `Manifest '${manifestRel}' not found` }, 404);
						return;
					}
					let manifestParsed: any;
					try {
						manifestParsed = JSON.parse(fs.readFileSync(manifestAbs, "utf-8"));
					} catch (err: any) {
						jsonError(400, err, { error: `Manifest JSON parse error: ${err?.message ?? err}` });
						return;
					}
					if (!manifestParsed || !Array.isArray(manifestParsed.assets)) {
						json({ error: "Manifest must be an object with an `assets[]` array" }, 400);
						return;
					}
					for (const a of manifestParsed.assets) {
						if (typeof a !== "string") {
							json({ error: "Manifest `assets[]` entries must be strings" }, 400);
							return;
						}
						declared.push(a);
					}
				}
				// De-duplicate while preserving order.
				const seen = new Set<string>();
				const dedup: string[] = [];
				for (const a of declared) {
					const k = a.trim();
					if (seen.has(k)) continue;
					seen.add(k);
					dedup.push(a);
				}
				result = previewMount.mountFile(sessionId, filePath, dedup);
			}
			broadcastPreviewChanged(sessionId, {
				entry: result.entry,
				mtime: result.mtime,
				url: result.url,
				path: result.path,
			});
			json(result);
			return;
		} catch (err: any) {
			if (err && err instanceof previewMount.PreviewMountError) {
				jsonError(err.statusCode, err);
				return;
			}
			jsonError(500, err, { error: `preview mount failed: ${err?.message ?? String(err)}` });
			return;
		}
	}

	// GET /api/preview/mount?sessionId=<sid> — bootstrap the preview panel after
	// session select. Returns the current entry/mtime/url/path for the mount,
	// or 404 if the mount is empty / nonexistent. Same auth as the POST.
	if (url.pathname === "/api/preview/mount" && req.method === "GET") {
		const sessionId = url.searchParams.get("sessionId") || "";
		if (!VALID_SESSION_ID.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		if (sandboxScope && !sandboxScope.sessionIds.has(sessionId)) {
			json({ error: "Forbidden: session out of scope" }, 403);
			return;
		}
		try {
			const { pickEntry } = await import("./preview/content-route.js");
			const dir = previewMount.mountDir(sessionId);
			const entry = pickEntry(dir);
			if (!entry) {
				json({ error: "no preview mount" }, 404);
				return;
			}
			const entryPath = path.join(dir, entry);
			let stat: fs.Stats;
			try { stat = fs.statSync(entryPath); } catch {
				json({ error: "no preview mount" }, 404);
				return;
			}
			json({
				url: `/preview/${sessionId}/${entry}`,
				path: entryPath,
				entry,
				mtime: Math.floor(stat.mtimeMs),
			});
			return;
		} catch (err: any) {
			if (err && err instanceof previewMount.PreviewMountError) {
				jsonError(err.statusCode, err);
				return;
			}
			jsonError(500, err, { error: `preview mount lookup failed: ${err?.message ?? String(err)}` });
			return;
		}
	}

	// GET /api/sessions/:sid/preview-events — SSE stream of preview-changed events
	// for the per-session preview mount. Cookie auth (or admin bearer) only;
	// sandbox tokens are not permitted (handled by the route-guard above).
	const previewEventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/preview-events$/);
	if (previewEventsMatch && req.method === "GET") {
		const sid = previewEventsMatch[1];
		if (!VALID_SESSION_ID.test(sid)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		if (sandboxScope) {
			json({ error: "Forbidden" }, 403);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no",
		});
		try { (res as { flushHeaders?: () => void }).flushHeaders?.(); } catch { /* ok */ }
		// Initial hello so the client knows the stream is live.
		res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

		// Subscribe to the in-process preview-changed channel populated by the
		// mount POST endpoint. Payload shape `{entry, mtime, url, path}` is
		// forwarded verbatim — the client reads `entry` to seed the iframe.
		const unsubscribe = subscribePreviewChanged(sid, payload => {
			try {
				res.write(`event: preview-changed\ndata: ${JSON.stringify(payload)}\n\n`);
			} catch { /* socket closed */ }
		});
		// Bootstrap: if a mount already exists for this session, emit the
		// current state synchronously so the just-connected client doesn't
		// wait for the next agent write. Avoids a race where
		// broadcastPreviewChanged fires between EventSource open and the
		// subscription being registered. Payload shape `{entry, mtime, url,
		// path}` matches broadcastPreviewChanged so the client doesn't need
		// to distinguish bootstrap from live events.
		try {
			const { pickEntry } = await import("./preview/content-route.js");
			const dir = previewMount.mountDir(sid);
			if (fs.existsSync(dir)) {
				const entry = pickEntry(dir);
				if (entry) {
					const entryPath = path.join(dir, entry);
					const stat = fs.statSync(entryPath);
					res.write(`event: preview-changed\ndata: ${JSON.stringify({
						entry,
						mtime: Math.floor(stat.mtimeMs),
						url: `/preview/${sid}/${entry}`,
						path: entryPath,
					})}\n\n`);
				}
			}
		} catch { /* ok — bootstrap is best-effort */ }
		const keepalive = setInterval(() => {
			try { res.write(":keepalive\n\n"); } catch { /* ok */ }
		}, 25_000);
		if (typeof keepalive.unref === "function") keepalive.unref();
		const cleanup = () => {
			clearInterval(keepalive);
			try { unsubscribe(); } catch { /* ok */ }
		};
		req.on("close", cleanup);
		req.on("error", cleanup);
		return;
	}

	// ── Background process endpoints ──────────────────────────────

	// POST /api/sessions/:id/bg-processes — create a background process
	const bgCreateMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes$/);
	if (bgCreateMatch && req.method === "POST") {
		const id = bgCreateMatch[1];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const body = await readBody(req);
		if (!body?.command) { json({ error: "command is required" }, 400); return; }
		try {
			const info = bgProcessManager.create(id, body.command, session.cwd, session.containerId, session.sandboxed, body.name);
			json(info, 201);
		} catch (err: any) {
			if (err?.message?.includes("Sandboxed session without containerId")) {
				json({ error: "Sandboxed session cannot run host processes" }, 403);
			} else {
				throw err;
			}
		}
		return;
	}

	// GET /api/sessions/:id/bg-processes — list background processes
	if (bgCreateMatch && req.method === "GET") {
		const id = bgCreateMatch[1];
		json({ processes: bgProcessManager.list(id) });
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/logs — get logs
	const bgLogsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/logs$/);
	if (bgLogsMatch && req.method === "GET") {
		const [, sessionId, processId] = bgLogsMatch;
		const logs = bgProcessManager.getLogs(sessionId, processId);
		if (!logs) { json({ error: "Process not found" }, 404); return; }
		const tail = parseInt(url.searchParams.get("tail") || "200", 10);
		json({
			log: logs.log.slice(-tail),
			stdout: logs.stdout.slice(-tail),
			stderr: logs.stderr.slice(-tail),
		});
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/grep — search logs
	const bgGrepMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/grep$/);
	if (bgGrepMatch && req.method === "GET") {
		const [, sessionId, processId] = bgGrepMatch;
		const pattern = url.searchParams.get("pattern") || "";
		if (!pattern) { json({ error: "pattern is required" }, 400); return; }
		const context = parseInt(url.searchParams.get("context") || "0", 10);
		const maxResults = parseInt(url.searchParams.get("max") || "50", 10);
		const result = bgProcessManager.grepLogs(sessionId, processId, pattern, context, maxResults);
		if (!result) { json({ error: "Process not found" }, 404); return; }
		json(result);
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/head — first N lines
	const bgHeadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/head$/);
	if (bgHeadMatch && req.method === "GET") {
		const [, sessionId, processId] = bgHeadMatch;
		const lines = parseInt(url.searchParams.get("lines") || "50", 10);
		const result = bgProcessManager.headLogs(sessionId, processId, lines);
		if (!result) { json({ error: "Process not found" }, 404); return; }
		json(result);
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/slice — line range (1-indexed)
	const bgSliceMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/slice$/);
	if (bgSliceMatch && req.method === "GET") {
		const [, sessionId, processId] = bgSliceMatch;
		const from = parseInt(url.searchParams.get("from") || "1", 10);
		const to = parseInt(url.searchParams.get("to") || "50", 10);
		const result = bgProcessManager.sliceLogs(sessionId, processId, from, to);
		if (!result) { json({ error: "Process not found" }, 404); return; }
		json(result);
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/wait — block until exit or timeout
	const bgWaitMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/wait$/);
	if (bgWaitMatch && req.method === "GET") {
		const [, sessionId, processId] = bgWaitMatch;
		const timeout = parseInt(url.searchParams.get("timeout") || "300", 10);
		const controller = new AbortController();
		bgProcessManager.registerWait(sessionId, controller);
		try {
			const result = await bgProcessManager.waitForExit(sessionId, processId, timeout * 1000, controller.signal);
			if (!result) { json({ error: "Process not found" }, 404); return; }
			json(result);
		} finally {
			bgProcessManager.unregisterWait(sessionId, controller);
		}
		return;
	}

	// DELETE /api/sessions/:id/bg-processes/:pid — kill or remove a background process
	const bgKillMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)$/);
	if (bgKillMatch && req.method === "DELETE") {
		const [, sessionId, processId] = bgKillMatch;
		// Try kill first (running), then remove (exited)
		const killed = bgProcessManager.kill(sessionId, processId);
		if (!killed) {
			const removed = bgProcessManager.remove(sessionId, processId);
			if (!removed) { json({ error: "Process not found" }, 404); return; }
		}
		json({ ok: true });
		return;
	}
	// ── Draft endpoints ─────────────────────────────────────────────

	// PUT|POST /api/sessions/:id/draft — upsert a draft
	// POST is accepted alongside PUT because navigator.sendBeacon (used for
	// beforeunload draft flush) always sends POST requests.
	const draftPutMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/);
	if (draftPutMatch && (req.method === "PUT" || req.method === "POST")) {
		const id = draftPutMatch[1];
		const body = await readBody(req);
		if (!body || typeof body.type !== "string") {
			json({ error: "Missing type" }, 400);
			return;
		}
		const ok = sessionManager.setDraft(id, body.type, body.data);
		if (!ok) { json({ error: "Session not found" }, 404); return; }
		json({ ok: true });
		return;
	}

	// POST /api/sessions/:id/abort — force-abort a streaming session (graceful + force-kill)
	const abortMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
	if (abortMatch && req.method === "POST") {
		const id = abortMatch[1];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		if (session.status !== "streaming") { json({ ok: true, status: session.status }); return; }
		await sessionManager.forceAbort(id);
		json({ ok: true, status: "idle" });
		return;
	}

	// GET /api/sessions/:id/prompt-sections — return system prompt broken into labeled sections
	const promptSectionsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt-sections$/);
	if (promptSectionsMatch && req.method === "GET") {
		const id = promptSectionsMatch[1];

		// Try persisted snapshot first (captures the actual prompt at creation time)
		const persisted = loadPersistedPromptSections(id);
		if (persisted) {
			json(persisted);
			return;
		}

		// Fallback: reconstruct for legacy sessions without a persisted snapshot
		const parts = sessionManager.getPromptParts(id);
		if (!parts) { json({ error: "Session not found or no prompt data" }, 404); return; }

		// Ensure tool docs are populated (they may have been injected at assemblePrompt time,
		// but re-inject if missing to handle edge cases)
		if (!parts.toolDocs && toolManager) {
			parts.toolDocs = toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir());
		}

		const sections = getPromptSections(parts);
		const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
		json({ sections, totalTokens });
		return;
	}

	// GET /api/sessions/:id/draft?type=prompt — retrieve a draft
	const draftGetMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/);
	if (draftGetMatch && req.method === "GET") {
		const id = draftGetMatch[1];
		const type = url.searchParams.get("type");
		if (!type) { json({ error: "Missing type query param" }, 400); return; }
		const data = sessionManager.getDraft(id, type);
		if (data === undefined) {
			// Check if session exists at all
			const session = sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			json({ error: "Draft not found" }, 404);
			return;
		}
		json({ type, data });
		return;
	}

	// DELETE /api/sessions/:id/draft?type=prompt — clear a draft
	const draftDelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/);
	if (draftDelMatch && req.method === "DELETE") {
		const id = draftDelMatch[1];
		const type = url.searchParams.get("type");
		if (!type) { json({ error: "Missing type query param" }, 400); return; }
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		sessionManager.deleteDraft(id, type);
		json({ ok: true });
		return;
	}

	// ── Review annotation endpoints ────────────────────────────────

	// POST /api/sessions/:id/review/annotations/bulk — bulk save all annotations + submitted flag (used by sendBeacon on page unload)
	if (req.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/annotations/bulk")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json({ error: "Invalid body" }, 400); return; }
		const annotations: Record<string, ReviewAnnotation[]> = {};
		if (body.annotations && typeof body.annotations === "object") {
			for (const [docTitle, anns] of Object.entries(body.annotations)) {
				if (Array.isArray(anns)) {
					annotations[docTitle] = anns as ReviewAnnotation[];
				}
			}
		}
		// If `submitted` is omitted (or non-boolean), preserve whatever is
		// already on disk. This is critical: the page-unload beacon historically
		// sent `submitted: false` whenever the local cache hadn't observed a
		// `true`, which clobbered out-of-band PUT(submitted=true) calls (other
		// tabs, REST clients, the test harness) on the next page reload (RP-09).
		// The client now omits the field unless it positively wants to write
		// `true`; the legacy clear path still goes through the dedicated
		// /review/submitted PUT.
		const submitted = typeof body.submitted === "boolean"
			? body.submitted
			: reviewAnnotationStore.isSubmitted(sessionId);
		reviewAnnotationStore.writeAll(sessionId, annotations, submitted);
		json({ ok: true });
		return;
	}

	// GET /api/sessions/:id/review/annotations
	if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/annotations")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		const data = reviewAnnotationStore.getAll(sessionId);
		json(data);
		return;
	}

	// POST /api/sessions/:id/review/annotations
	if (req.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/annotations")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		const body = await readBody(req);
		if (!body?.docTitle || !body?.annotation) {
			json({ error: "docTitle and annotation required" }, 400);
			return;
		}
		reviewAnnotationStore.addAnnotation(sessionId, body.docTitle, body.annotation);
		json({ ok: true });
		return;
	}

	// DELETE /api/sessions/:id/review/annotations[/:annotationId]
	if (req.method === "DELETE" && url.pathname.startsWith("/api/sessions/") && url.pathname.includes("/review/annotations")) {
		const parts = url.pathname.split("/");
		const sessionId = parts[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		if (parts.length >= 7 && parts[6]) {
			// DELETE /api/sessions/:id/review/annotations/:annotationId
			const annotationId = decodeURIComponent(parts[6]);
			const docTitle = url.searchParams.get("docTitle");
			if (!docTitle) { json({ error: "docTitle query parameter is required" }, 400); return; }
			reviewAnnotationStore.removeAnnotation(sessionId, docTitle, annotationId);
			json({ ok: true });
		} else {
			// DELETE /api/sessions/:id/review/annotations — clear all or by docTitle
			const body = await readBody(req);
			const docTitle = body?.docTitle;
			if (docTitle) {
				reviewAnnotationStore.clearAnnotations(sessionId, docTitle);
			} else {
				reviewAnnotationStore.clearAll(sessionId);
			}
			json({ ok: true });
		}
		return;
	}

	// GET /api/sessions/:id/review/submitted
	if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/submitted")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		json({ submitted: reviewAnnotationStore.isSubmitted(sessionId) });
		return;
	}

	// PUT /api/sessions/:id/review/submitted
	if (req.method === "PUT" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/submitted")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		const body = await readBody(req);
		reviewAnnotationStore.setSubmitted(sessionId, !!body?.submitted);
		json({ ok: true });
		return;
	}

	// ── Staff endpoints ────────────────────────────────────────────

	// GET /api/staff/orphaned — staff with missing projectId or stuck on the system project
	if (url.pathname === "/api/staff/orphaned" && req.method === "GET") {
		const list = staffManager.listOrphaned().map(s => {
			const sandboxed = s.projectId ? (projectContextManager.getOrCreate(s.projectId)?.projectConfigStore.get("sandbox") === "docker") : false;
			return { ...s, sandboxed };
		});
		json({ staff: list });
		return;
	}

	// GET /api/staff
	if (url.pathname === "/api/staff" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		const list = staffManager.listStaff(projectId).map(s => {
			const sandboxed = s.projectId ? (projectContextManager.getOrCreate(s.projectId)?.projectConfigStore.get("sandbox") === "docker") : false;
			return { ...s, sandboxed };
		});
		json({ staff: list });
		return;
	}

	// POST /api/staff
	if (url.pathname === "/api/staff" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.name || typeof body.name !== "string") {
			json({ error: "Missing name" }, 400);
			return;
		}
		if (!body?.systemPrompt || typeof body.systemPrompt !== "string") {
			json({ error: "Missing systemPrompt" }, 400);
			return;
		}
		const cwd = body.cwd || config.defaultCwd;
		const resolved = resolveProjectForRequest(projectRegistry, projectContextManager, { projectId: body.projectId, cwd });
		if (!resolved.ok) {
			json({ error: resolved.error }, resolved.status);
			return;
		}
		const projectId = resolved.projectId;
		try {
			const staff = await staffManager.createStaff(
				body.name,
				body.description || "",
				body.systemPrompt,
				cwd,
				sessionManager,
				{ triggers: body.triggers, roleId: body.roleId, projectId, sandboxed: body.sandboxed },
			);
			json(staff, 201);
		} catch (err: any) {
			console.error("[server] Failed to create staff agent:", err);
			jsonError(500, err);
		}
		return;
	}

	// Routes with staff :id parameter
	const staffMatch = url.pathname.match(/^\/api\/staff\/([^/]+)$/);
	if (staffMatch) {
		const id = staffMatch[1];

		if (req.method === "GET") {
			const staff = staffManager.getStaff(id);
			if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
			const sandboxed = staff.projectId ? (projectContextManager.getOrCreate(staff.projectId)?.projectConfigStore.get("sandbox") === "docker") : false;
			json({ ...staff, sandboxed });
			return;
		}

		if (req.method === "PATCH") {
			const body = await readBody(req);
			if (!body || typeof body.projectId !== "string" || !body.projectId.trim()) {
				json({ error: "Missing projectId" }, 400);
				return;
			}
			const targetProject = projectRegistry.get(body.projectId);
			if (!targetProject) { json({ error: "Project not found" }, 404); return; }
			try {
				const staff = staffManager.reassignProject(id, body.projectId);
				if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
				json(staff);
			} catch (err: any) {
				jsonError(400, err);
			}
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const ok = staffManager.updateStaff(id, {
				name: body.name,
				description: body.description,
				systemPrompt: body.systemPrompt,
				cwd: body.cwd,
				state: body.state,
				triggers: body.triggers,
				memory: body.memory,
				roleId: body.roleId,
			});
			if (!ok) { json({ error: "Staff agent not found" }, 404); return; }
			json(staffManager.getStaff(id));
			return;
		}

		if (req.method === "DELETE") {
			const ok = await staffManager.deleteStaff(id, sessionManager);
			if (!ok) { json({ error: "Staff agent not found" }, 404); return; }
			json({ ok: true });
			return;
		}
	}

	// POST /api/staff/:id/wake — manually trigger a wake cycle
	const staffWakeMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/wake$/);
	if (staffWakeMatch && req.method === "POST") {
		const id = staffWakeMatch[1];
		const staff = staffManager.getStaff(id);
		if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
		const body = await readBody(req);
		try {
			const sessionId = await staffManager.wake(id, body?.prompt, sessionManager);
			json({ sessionId }, 201);
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// GET /api/staff/:id/sessions — DEPRECATED (staff agents have a single permanent session)
	const staffSessionsMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/sessions$/);
	if (staffSessionsMatch && req.method === "GET") {
		json({ error: "Deprecated. Staff agents have a single permanent session. Use GET /api/staff/:id." }, 410);
		return;
	}

	// GET /api/mcp-servers
	if (url.pathname === "/api/mcp-servers" && req.method === "GET") {
		const mcpManager = sessionManager.getMcpManager();
		if (!mcpManager) {
			json([]);
			return;
		}
		const statuses = mcpManager.getServerStatuses();
		const toolInfos = mcpManager.getToolInfos();
		const result = statuses.map(s => ({
			...s,
			tools: toolInfos.filter(t => t.serverName === s.name).map(t => {
				const parsed = parseMcpToolName(t.name);
				return {
					name: t.name,
					description: t.description,
					subNamespace: parsed?.sub,
					op: parsed?.op ?? t.mcpToolName,
				};
			}),
		}));
		json(result);
		return;
	}

	// POST /api/mcp-servers/:name/restart
	const mcpRestartMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/restart$/);
	if (mcpRestartMatch && req.method === "POST") {
		const mcpManager = sessionManager.getMcpManager();
		if (!mcpManager) {
			json({ error: "MCP not initialized" }, 500);
			return;
		}
		const serverName = decodeURIComponent(mcpRestartMatch[1]);
		let statuses = mcpManager.getServerStatuses();
		let existing = statuses.find(s => s.name === serverName);
		if (!existing || !existing.config) {
			// Re-discover servers in case config was added after startup
			const discovered = mcpManager.discoverServers();
			if (!discovered[serverName]) {
				json({ error: `MCP server "${serverName}" not found` }, 404);
				return;
			}
			// Connect the newly discovered server
			await mcpManager.connectServer(serverName, discovered[serverName]);
		} else {
			await mcpManager.disconnectServer(serverName);
			// Re-discover to pick up any config changes from disk
			const refreshed = mcpManager.discoverServers();
			const config = refreshed[serverName] || existing.config;
			await mcpManager.connectServer(serverName, config);
		}
		// Re-register MCP tools with ToolManager
		if (toolManager) {
			toolManager.removeExternalTools("mcp__");
			const infos = mcpManager.getToolInfos();
			toolManager.registerExternalTools(infos.map(info => ({
				name: info.name,
				description: info.description,
				summary: info.description,
				group: info.group,
				docs: info.docs,
				provider: { type: 'mcp' as const, server: info.serverName, mcpTool: info.mcpToolName },
			})));
		}
		const updated = mcpManager.getServerStatuses().find(s => s.name === serverName);
		json({ ok: true, ...updated });
		return;
	}

	// POST /api/internal/mcp-call
	if (url.pathname === "/api/internal/mcp-call" && req.method === "POST") {
		const mcpManager = sessionManager.getMcpManager();
		if (!mcpManager) {
			json({ error: "MCP not initialized" }, 500);
			return;
		}
		let parsedToolForError: string | undefined;
		try {
			const body = await new Promise<string>((resolve) => {
				let data = "";
				req.on("data", (chunk: Buffer) => data += chunk.toString());
				req.on("end", () => resolve(data));
			});
			const { tool, args } = JSON.parse(body);
			parsedToolForError = typeof tool === "string" ? tool : undefined;
			if (!tool) {
				json({ error: "Missing 'tool' field" }, 400);
				return;
			}

			// Enforce allowedTools for the calling session.
			// This endpoint is internal — only MCP proxy extensions should call it.
			// Require session ID header to prevent direct curl bypass.
			const mcpSessionId = req.headers["x-bobbit-session-id"] as string | undefined;
			if (!mcpSessionId) {
				json({ error: "Missing X-Bobbit-Session-Id header" }, 403);
				return;
			}
			// Verify the session exists (live or persisted).
			const mcpSession = sessionManager.getSession(mcpSessionId);
			const persistedSession = mcpSession ? null : (
				// Search across all project stores for persisted session
				projectContextManager.getContextForSession(mcpSessionId)?.sessionStore.get(mcpSessionId)
				?? null
			);
			if (!mcpSession && !persistedSession) {
				json({ error: `Session "${mcpSessionId}" not found` }, 403);
				return;
			}
			// Enforce allowedTools for non-MCP tools on live sessions.
			// MCP tools (mcp__*) are dynamically discovered and governed by the
			// grant policy system — they may not appear in the session's static
			// allowedTools list, so we skip the check for them.
			const toolStr = tool as string;
			if (!toolStr.startsWith("mcp__") && mcpSession?.allowedTools && mcpSession.allowedTools.length > 0) {
				if (!mcpSession.allowedTools.some((t: string) => t.toLowerCase() === toolStr.toLowerCase())) {
					json({ error: `Tool "${tool}" is not allowed for this session` }, 403);
					return;
				}
			}

			// Layer B per-op never-policy enforcement (§4.3). Resolves the per-op
			// policy for `mcp__<server>__<op>` even though the model only sees the
			// aggregated `mcp_<server>` meta-tool — keeps `never` denials honoured
			// after the meta-tool is granted wholesale.
			if (toolStr.startsWith("mcp__")) {
				const roleName = mcpSession?.role ?? (persistedSession as any)?.role;
				const role = roleName ? roleManager.getRole(roleName) : undefined;
				const parsed = parseMcpToolName(toolStr);
				const opGroup = parsed?.server ? `MCP: ${parsed.server}` : undefined;
				const policy = resolveGrantPolicy(toolStr, opGroup, role, toolManager, groupPolicyStore);
				if (policy === "never") {
					json({ error: `tool ${toolStr} denied by policy`, tool: toolStr, reason: "policy=never" }, 403);
					return;
				}
			}

			const result = await mcpManager.callTool(tool, args || {});
			json(result);
		} catch (err) {
			const e = err as Error;
			console.error(`[mcp] Tool call failed:`, e.stack || e);
			// Parse `mcp__<server>__<op>` into structured fields (§5.4).
			let parsedServer: string | undefined;
			let parsedOperation: string | undefined;
			if (parsedToolForError && parsedToolForError.startsWith("mcp__")) {
				const parsedErr = parseMcpToolName(parsedToolForError);
				if (parsedErr) {
					parsedServer = parsedErr.server;
					parsedOperation = parsedErr.sub ? `${parsedErr.sub}__${parsedErr.op}` : parsedErr.op;
				}
			}
			json({ error: e.message, server: parsedServer, operation: parsedOperation, stack: e.stack }, 500);
		}
		return;
	}

	// POST /api/internal/mcp-describe — discovery endpoint for the `mcp_describe` tool (§3.3)
	if (url.pathname === "/api/internal/mcp-describe" && req.method === "POST") {
		const mcpManager = sessionManager.getMcpManager();
		if (!mcpManager) {
			json({ error: "MCP not initialized" }, 500);
			return;
		}
		try {
			const body = await new Promise<string>((resolve) => {
				let data = "";
				req.on("data", (chunk: Buffer) => data += chunk.toString());
				req.on("end", () => resolve(data));
			});
			const parsed = JSON.parse(body || "{}");
			const server: string | undefined = parsed?.server;
			const operation: string | undefined = parsed?.operation;
			if (!server || typeof server !== "string") {
				json({ error: "Missing 'server' field" }, 400);
				return;
			}

			const describeSessionId = req.headers["x-bobbit-session-id"] as string | undefined;
			if (!describeSessionId) {
				json({ error: "Missing X-Bobbit-Session-Id header" }, 403);
				return;
			}
			const liveSession = sessionManager.getSession(describeSessionId);
			const persistedSession = liveSession ? null : (
				projectContextManager.getContextForSession(describeSessionId)?.sessionStore.get(describeSessionId)
				?? null
			);
			if (!liveSession && !persistedSession) {
				json({ error: `Session "${describeSessionId}" not found` }, 403);
				return;
			}

			const statuses = mcpManager.getServerStatuses();
			const status = statuses.find(s => s.name === server);
			if (!status || status.status !== "connected") {
				const reason = status?.error ?? (status ? status.status : "unknown server");
				json({ error: `server ${server} not connected: ${reason}` }, 503);
				return;
			}

			const infos = mcpManager.getToolInfos().filter(i => i.serverName === server);
			if (operation) {
				const match = infos.find(i => i.mcpToolName === operation);
				if (!match) {
					json({ error: "operation not found" }, 404);
					return;
				}
				json({ tool: { name: match.mcpToolName, description: match.description, inputSchema: match.inputSchema } });
				return;
			}
			json({
				tools: infos.map(i => ({
					name: i.mcpToolName,
					description: i.description,
					inputSchema: i.inputSchema,
				})),
			});
		} catch (err) {
			const e = err as Error;
			console.error(`[mcp] Describe failed:`, e.stack || e);
			json({ error: e.message, stack: e.stack }, 500);
		}
		return;
	}

	// POST /api/internal/verification-result
	if (url.pathname === "/api/internal/verification-result" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.sessionId || !body?.verdict || !body?.summary || typeof body.sessionId !== "string" || typeof body.verdict !== "string" || typeof body.summary !== "string") {
			json({ error: "Missing required fields: sessionId, verdict, summary" }, 400);
			return;
		}
		const resolver = verificationHarness.pendingResults.get(body.sessionId);
		if (!resolver) {
			json({ error: "No pending verification for this session" }, 404);
			return;
		}
		// Support report_html_file: server reads file directly (avoids tool output limits for large reports)
		if (typeof body.report_html === "string" && typeof body.report_html_file === "string") {
			json({ error: "Provide either report_html or report_html_file, not both" }, 400);
			return;
		}
		let reportHtml: string | undefined = typeof body.report_html === "string" ? body.report_html : undefined;
		if (!reportHtml && typeof body.report_html_file === "string") {
			try {
				let filePath = body.report_html_file;
				// Resolve relative paths against the session's CWD
				if (!path.isAbsolute(filePath)) {
					const session = sessionManager.getSession(body.sessionId);
					if (session) filePath = path.resolve(session.cwd, filePath);
				}
				// On Windows, POSIX paths from Git Bash (/tmp/...) resolve to C:\tmp\... which doesn't exist.
				// Fall back to the system TEMP directory for /tmp/ paths.
				if (process.platform === "win32" && !fs.existsSync(filePath) && body.report_html_file.startsWith("/tmp/")) {
					const tempDir = process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
					const tempResolved = path.join(tempDir, body.report_html_file.slice(5));
					if (fs.existsSync(tempResolved)) filePath = tempResolved;
				}
				const stat = fs.statSync(filePath);
				const MAX_REPORT_SIZE = 10 * 1024 * 1024; // 10 MB
				if (stat.size > MAX_REPORT_SIZE) {
					json({ error: `Report file too large (${stat.size} bytes, max ${MAX_REPORT_SIZE})` }, 400);
					return;
				}
				reportHtml = fs.readFileSync(filePath, "utf-8");
			} catch (e: any) {
				json({ error: `Failed to read report file: ${e.message}` }, 400);
				return;
			}
		}
		// Inline any <img src="file://..."> references so the report renders from
		// the browser's blob origin (cross-origin file:// loads are blocked).
		if (reportHtml) {
			const session = sessionManager.getSession(body.sessionId);
			if (session?.cwd) {
				try {
					reportHtml = inlineFileImages(reportHtml, session.cwd, {
						logger: (msg) => console.warn(msg),
					});
				} catch (err: any) {
					console.warn(`[verification] inlineFileImages failed: ${err?.message || err}`);
				}
			}
		}
		resolver({
			verdict: body.verdict === "pass",
			summary: body.summary,
			reportHtml,
		});
		json({ ok: true });
		return;
	}

	// POST /api/internal/user-question/submit  — called by the UI widget with answers.
	// Non-blocking model: appends a tagged user message to the session transcript
	// via `enqueuePrompt` (the normal user-prompt path), which persists to .jsonl,
	// broadcasts, and wakes the agent. Idempotent: duplicate submits for the same
	// tool_use_id are a no-op (the second tab's submit is swallowed).
	// See src/shared/ask-envelope.ts for the envelope format.
	if (url.pathname === "/api/internal/user-question/submit" && req.method === "POST") {
		const body = await readBody(req);
		const { sessionId, toolUseId, answers } = body || {};
		if (typeof sessionId !== "string" || typeof toolUseId !== "string" || !Array.isArray(answers)) {
			json({ error: "Missing required fields: sessionId, toolUseId, answers" }, 400);
			return;
		}
		const answerErr = validateAnswers(answers);
		if (answerErr) { json({ error: answerErr }, 400); return; }
		const session = sessionManager.getSession(sessionId);
		if (!session) { json({ error: "Unknown session" }, 404); return; }

		// Pull the transcript to locate the original tool_use (for cross-validation)
		// and to detect duplicate submits (multi-tab / network retry).
		let messages: any[] = [];
		try {
			const msgsResp = await session.rpcClient.getMessages();
			const raw = msgsResp?.data?.messages || msgsResp?.data;
			if (Array.isArray(raw)) messages = raw;
		} catch (e: any) {
			json({ error: `Could not load transcript: ${e?.message || String(e)}` }, 500);
			return;
		}

		// Idempotency: if a response envelope for this toolUseId already exists,
		// return success without appending again. Check in-memory guard first
		// (covers the race where a duplicate /submit arrives before the first
		// envelope has propagated into the transcript), then the transcript
		// (covers process restart / external writers).
		const dedupKey = `${sessionId}::${toolUseId}`;
		if (askSubmittedToolUseIds.has(dedupKey)) {
			json({ ok: true, alreadySubmitted: true });
			return;
		}
		const existing = findAskResponseAnswers(messages, toolUseId);
		if (existing) {
			askSubmittedToolUseIds.add(dedupKey);
			json({ ok: true, alreadySubmitted: true });
			return;
		}

		// Locate the ask_user_choices tool_use block; use its input to cross-validate.
		let matchedQuestions: UserQuestion[] | null = null;
		for (const m of messages) {
			if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
			for (const b of m.content) {
				if (!b) continue;
				const isToolUse = b.type === "toolCall" || b.type === "tool_use";
				if (!isToolUse) continue;
				if (b.name !== "ask_user_choices") continue;
				if (b.id !== toolUseId) continue;
				const args = b.arguments ?? b.input;
				if (args && Array.isArray(args.questions)) {
					matchedQuestions = args.questions as UserQuestion[];
				}
				break;
			}
			if (matchedQuestions) break;
		}
		if (!matchedQuestions) {
			json({ error: "No matching ask_user_choices tool call in transcript" }, 404);
			return;
		}
		const crossErr = crossValidate(matchedQuestions, answers);
		if (crossErr) { json({ error: crossErr }, 400); return; }

		const envelope = buildAskResponseEnvelope(toolUseId, answers);
		// Mark as submitted BEFORE awaiting enqueuePrompt so a concurrent
		// duplicate /submit is rejected deterministically.
		askSubmittedToolUseIds.add(dedupKey);
		try {
			await sessionManager.enqueuePrompt(sessionId, envelope);
		} catch (e: any) {
			// Roll back the dedup flag so the caller can retry.
			askSubmittedToolUseIds.delete(dedupKey);
			json({ error: `Failed to enqueue response: ${e?.message || String(e)}` }, 500);
			return;
		}
		json({ ok: true });
		return;
	}

	// ─── Maintenance endpoints ──────────────────────────────────────────
	// These replace the old automatic cleanup-on-startup behavior.
	// Users can preview orphaned resources and choose to clean them up.

	// GET /api/maintenance/orphaned-worktrees
	if (url.pathname === "/api/maintenance/orphaned-worktrees" && req.method === "GET") {
		const allOrphans: Array<{ path: string; branch: string; repoPath: string }> = [];
		// Hidden contexts (synthetic system project) have no worktrees and
		// resolving their repoPath can leak into an unrelated host repo.
		for (const ctx of projectContextManager.visible()) {
			try {
				const repoPath = ctx.project.rootPath;
				if (await isGitRepo(repoPath)) {
					const orphans = await sessionManager.listOrphanedSessionWorktrees(repoPath);
					for (const o of orphans) {
						allOrphans.push({ ...o, repoPath });
					}
				}
			} catch { /* best-effort */ }
		}
		json({ worktrees: allOrphans });
		return;
	}

	// POST /api/maintenance/cleanup-worktrees
	if (url.pathname === "/api/maintenance/cleanup-worktrees" && req.method === "POST") {
		const body = await readBody(req);
		let cleaned = 0;
		if (body?.worktrees && Array.isArray(body.worktrees)) {
			// Clean specific worktrees — validate each against registered projects and orphan list
			const validRepoPaths = new Set([...projectContextManager.visible()].map(ctx => ctx.project.rootPath));
			for (const wt of body.worktrees) {
				if (wt.path && wt.branch && wt.repoPath) {
					// Validate repoPath is a registered project
					if (!validRepoPaths.has(wt.repoPath)) continue;
					// Validate this worktree is actually orphaned
					try {
						const orphans = await sessionManager.listOrphanedSessionWorktrees(wt.repoPath);
						const isOrphan = orphans.some(o => o.path === wt.path && o.branch === wt.branch);
						if (!isOrphan) continue;
					} catch { continue; }
					try {
						const { cleanupWorktree } = await import("./skills/git.js");
						await cleanupWorktree(wt.repoPath, wt.path, wt.branch, true);
						cleaned++;
					} catch { /* best-effort */ }
				}
			}
		} else {
			// Clean all orphans across all projects (hidden contexts excluded).
			for (const ctx of projectContextManager.visible()) {
				try {
					const repoPath = ctx.project.rootPath;
					if (await isGitRepo(repoPath)) {
						await sessionManager.cleanupOrphanedSessionWorktrees(repoPath);
						cleaned++; // count projects cleaned, not individual worktrees
					}
				} catch { /* best-effort */ }
			}
		}
		json({ cleaned });
		return;
	}

	// GET /api/maintenance/orphaned-sessions
	if (url.pathname === "/api/maintenance/orphaned-sessions" && req.method === "GET") {
		const sessions = await sessionManager.listOrphanedNonInteractiveSessions();
		json({ sessions });
		return;
	}

	// POST /api/maintenance/cleanup-sessions
	if (url.pathname === "/api/maintenance/cleanup-sessions" && req.method === "POST") {
		const body = await readBody(req);
		const orphans = await sessionManager.listOrphanedNonInteractiveSessions();
		const orphanIds = new Set(orphans.map(o => o.id));
		const idsToTerminate = (body?.sessionIds && Array.isArray(body.sessionIds))
			? (body.sessionIds as string[]).filter(id => orphanIds.has(id))
			: orphans.map(o => o.id);
		const terminated = await sessionManager.terminateOrphanedSessions(idsToTerminate);
		json({ terminated });
		return;
	}

	// GET /api/maintenance/expired-archives
	if (url.pathname === "/api/maintenance/expired-archives" && req.method === "GET") {
		const stats = await sessionManager.getExpiredArchiveStats();
		json(stats);
		return;
	}

	// POST /api/maintenance/purge-archives
	if (url.pathname === "/api/maintenance/purge-archives" && req.method === "POST") {
		await sessionManager.purgeExpiredArchives();
		const stats = await sessionManager.getExpiredArchiveStats();
		json({ purged: true, remaining: stats });
		return;
	}

	// ─── Search admin endpoints (design §9, §11) ─────────────────────

	function resolveSearchProject(pid: string | undefined | null) {
		if (!pid) return null;
		const ctx = projectContextManager.getOrCreate(pid);
		return ctx;
	}

	function searchUnavailableResponse(state: string) {
		const reasonMap: Record<string, string> = {
			"disabled": "disabled",
			"closed": "closed",
			"initializing": "initializing",
		};
		const reason = reasonMap[state] ?? state;
		return { error: "search-unavailable", reason, state };
	}

	// POST /api/search/rebuild
	if (url.pathname === "/api/search/rebuild" && req.method === "POST") {
		const body = await readBody(req);
		const projectId = body && typeof body === "object" ? (body as any).projectId : undefined;
		if (!projectId || typeof projectId !== "string") {
			json({ error: "Missing projectId" }, 400);
			return;
		}
		const ctx = resolveSearchProject(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		await ctx.searchIndex.whenReady();
		const state = ctx.searchIndex.getState();
		if (state !== "ready") {
			json(searchUnavailableResponse(state), 503);
			return;
		}
		// Kick off in background — client observes progress over WS.
		ctx.searchIndex
			.rebuildFromStores(ctx.goalStore, ctx.sessionStore, undefined, ctx.staffStore)
			.catch((err) => console.error("[search] rebuild failed:", err));
		json({ ok: true }, 202);
		return;
	}

	// GET /api/search/stats?projectId=...
	if (url.pathname === "/api/search/stats" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		if (!projectId) { json({ error: "Missing projectId" }, 400); return; }
		const ctx = resolveSearchProject(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		await ctx.searchIndex.whenReady();
		const stats = await ctx.searchIndex.getStats();
		json(stats);
		return;
	}

	// POST /api/search/compact
	if (url.pathname === "/api/search/compact" && req.method === "POST") {
		const body = await readBody(req);
		const projectId = body && typeof body === "object" ? (body as any).projectId : undefined;
		if (!projectId || typeof projectId !== "string") {
			json({ error: "Missing projectId" }, 400);
			return;
		}
		const ctx = resolveSearchProject(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		await ctx.searchIndex.whenReady();
		const state = ctx.searchIndex.getState();
		if (state !== "ready") {
			json(searchUnavailableResponse(state), 503);
			return;
		}
		try {
			await ctx.searchIndex.compact();
			json({ ok: true });
		} catch (err) {
			json({ error: `Compact failed: ${(err as Error).message}` }, 500);
		}
		return;
	}

	// GET /api/maintenance/orphaned-index-rows?projectId=...
	if (url.pathname === "/api/maintenance/orphaned-index-rows" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		if (!projectId) { json({ error: "Missing projectId" }, 400); return; }
		const ctx = resolveSearchProject(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		await ctx.searchIndex.whenReady();
		const store = ctx.searchIndex.getStore();
		if (!store) {
			json(searchUnavailableResponse(ctx.searchIndex.getState()), 503);
			return;
		}
		try {
			const rows = store.list({ limit: 100000 });
			const orphans: Array<{ id: string; source_id: string; parent_id: string | null }> = [];
			for (const row of rows) {
				const sourceId = String(row.source_id ?? "");
				const id = String(row.id ?? "");
				let isOrphan = false;
				if (sourceId === "goals") {
					const goalId = id.replace(/^goal:/, "");
					isOrphan = !ctx.goalStore.get(goalId);
				} else if (sourceId === "sessions") {
					const sessionId = id.replace(/^session:/, "");
					isOrphan = !ctx.sessionStore.get(sessionId);
				} else if (sourceId === "messages") {
					const sessionId = String(row.session_id ?? "");
					isOrphan = !sessionId || !ctx.sessionStore.get(sessionId);
				} else if (sourceId === "staff") {
					const staffId = id.replace(/^staff:/, "");
					isOrphan = !ctx.staffStore.get(staffId);
				}
				if (isOrphan) {
					orphans.push({
						id,
						source_id: sourceId,
						parent_id: row.parent_id != null ? String(row.parent_id) : null,
					});
				}
			}
			json({ count: orphans.length, sample: orphans.slice(0, 100) });
		} catch (err) {
			json({ error: `Orphan scan failed: ${(err as Error).message}` }, 500);
		}
		return;
	}

	// POST /api/maintenance/cleanup-index-rows
	if (url.pathname === "/api/maintenance/cleanup-index-rows" && req.method === "POST") {
		const body = await readBody(req);
		const projectId = body && typeof body === "object" ? (body as any).projectId : undefined;
		if (!projectId || typeof projectId !== "string") {
			json({ error: "Missing projectId" }, 400);
			return;
		}
		const ctx = resolveSearchProject(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		await ctx.searchIndex.whenReady();
		const store = ctx.searchIndex.getStore();
		if (!store) {
			json(searchUnavailableResponse(ctx.searchIndex.getState()), 503);
			return;
		}
		try {
			const rows = store.list({ limit: 100000 });
			const toDelete: string[] = [];
			for (const row of rows) {
				const sourceId = String(row.source_id ?? "");
				const id = String(row.id ?? "");
				let isOrphan = false;
				if (sourceId === "goals") {
					isOrphan = !ctx.goalStore.get(id.replace(/^goal:/, ""));
				} else if (sourceId === "sessions") {
					isOrphan = !ctx.sessionStore.get(id.replace(/^session:/, ""));
				} else if (sourceId === "messages") {
					const sessionId = String(row.session_id ?? "");
					isOrphan = !sessionId || !ctx.sessionStore.get(sessionId);
				} else if (sourceId === "staff") {
					isOrphan = !ctx.staffStore.get(id.replace(/^staff:/, ""));
				}
				if (isOrphan) toDelete.push(id);
			}
			if (toDelete.length) await store.deleteByIds(toDelete);
			json({ deleted: toDelete.length });
		} catch (err) {
			json({ error: `Cleanup failed: ${(err as Error).message}` }, 500);
		}
		return;
	}

	json({ error: "Not found" }, 404);
}

/** Check if gateId transitively depends on targetId in the workflow DAG */
function hasTransitiveDep(workflow: import("./agent/workflow-store.js").Workflow, gateId: string, targetId: string, visited = new Set<string>()): boolean {
	if (visited.has(gateId)) return false;
	visited.add(gateId);
	const gate = workflow.gates.find(g => g.id === gateId);
	if (!gate) return false;
	for (const dep of gate.dependsOn) {
		if (dep === targetId) return true;
		if (hasTransitiveDep(workflow, dep, targetId, visited)) return true;
	}
	return false;
}

function readBody(req: http.IncomingMessage): Promise<any> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString()));
			} catch {
				resolve(null);
			}
		});
	});
}

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
};

/**
 * Load the PWA manifest JSON. In prod the UI is embedded under `staticDir`;
 * in dev mode (--no-ui) the Vite public/ folder is used instead.
 */
function loadManifest(staticDir: string | undefined): { start_url?: string;[k: string]: unknown } {
	const candidates: string[] = [];
	if (staticDir) candidates.push(path.join(path.resolve(staticDir), "manifest.json"));
	candidates.push(path.resolve(process.cwd(), "public", "manifest.json"));
	for (const p of candidates) {
		if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
	}
	throw new Error("manifest.json not found");
}

function serveStatic(pathname: string, staticDir: string, res: http.ServerResponse) {
	const resolvedStaticDir = path.resolve(staticDir);
	let filePath = path.resolve(staticDir, pathname === "/" ? "index.html" : pathname.slice(1));

	// Prevent directory traversal
	if (!filePath.startsWith(resolvedStaticDir)) {
		res.writeHead(403);
		res.end();
		return;
	}

	try {
		if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
			// SPA fallback — serve index.html for unmatched routes
			filePath = path.join(resolvedStaticDir, "index.html");
			if (!fs.existsSync(filePath)) {
				res.writeHead(404);
				res.end("Not found");
				return;
			}
		}

		const ext = path.extname(filePath).toLowerCase();
		const contentType = MIME_TYPES[ext] || "application/octet-stream";
		const content = fs.readFileSync(filePath);

		const headers: Record<string, string> = { "Content-Type": contentType };
		// Service-worker file: never cache. Browsers byte-compare SWs for
		// updates, but an intermediate proxy/CDN serving a stale copy would
		// silently keep users on the old build's CACHE_NAME. Same goes for
		// the SPA shell (index.html) — it references hashed bundle names
		// that change every build.
		const basename = path.basename(filePath);
		if (basename === "sw.js" || basename === "index.html") {
			headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
		}

		res.writeHead(200, headers);
		res.end(content);
	} catch {
		res.writeHead(500);
		res.end("Internal server error");
	}
}
