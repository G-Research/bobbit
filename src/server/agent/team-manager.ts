import { execFile as execFileCb } from "node:child_process";
import type { Clock, CommandRunner } from "../gateway-deps.js";
import { realClock, realCommandRunner } from "../gateway-deps.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { PromptSource, SessionManager, SessionInfo } from "./session-manager.js";
import { isNonRetryableAgentError, isProviderBackoffError, isRetryableGenericAgentError, isTransientReviewError } from "./verification-logic.js";
import { GoalManager } from "./goal-manager.js";
import { GoalStore, type PersistedGoal } from "./goal-store.js";
import { createWorktree, cleanupWorktree } from "../skills/git.js";
import { applyPromptConditionals } from "./prompt-conditionals.js";
import type { RoleStore, Role } from "./role-store.js";
import { resolveRole, listAvailableRoles, type RoleSource } from "./resolve-role.js";
import { GoalPausedError } from "./goal-paused-guard.js";
import { TeamStore } from "./team-store.js";
import { bobbitStateDir } from "../bobbit-dir.js";
import type { PersistedTeamEntry } from "./team-store.js";
import { generateTeamName, generateTeamNameSync } from "./team-names.js";
import type { ToolManager } from "./tool-manager.js";
import type { ColorStore } from "./color-store.js";
import type { GateStore } from "./gate-store.js";
import type { VerificationHarness } from "./verification-harness.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import { checkGateDependencies } from "./gate-dependency-check.js";
import { anyInFlightChild } from "./team-manager-helpers.js";
import { buildParentCompletionNotification } from "./notify-team-lead-child-passed.js";
import {
	findOrphanTeamEntries,
	pickCanonicalTeamLeadJsonl,
	reconstructTeamLeadSessionRecord,
	reconstructAgentSessionRecord,
	discoverAgentsForGoal,
	scanSlugDirForJsonlsAt,
	isStaleRecoveredTeamLeadTitle,
} from "./team-store-consistency.js";
import {
	readSessionSidecarAsync,
	reconcileRecoveredSessionWithSidecar,
	sidecarPathFor,
	buildSessionSidecar,
	type SessionSidecar,
} from "./session-sidecar.js";
import { trustedAgentSessionsRoots } from "./agent-session-path.js";
import {
	realRecoveryFs,
	type RecoveryFs,
} from "./bounded-async-work.js";
import { isHeadquartersProject } from "./project-registry.js";

const execFile = promisify(execFileCb);

/** Production wrapper around the testable `scanSlugDirForJsonlsAt`. */
async function scanSlugDirForJsonls(worktreePath: string, recoveryFs: RecoveryFs) {
	const out: Awaited<ReturnType<typeof scanSlugDirForJsonlsAt>> = [];
	const seen = new Set<string>();
	for (const sessionsRoot of trustedAgentSessionsRoots()) {
		for (const candidate of await scanSlugDirForJsonlsAt(sessionsRoot, worktreePath, recoveryFs, path.join)) {
			const key = path.resolve(candidate.jsonlPath);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(candidate);
		}
	}
	return out;
}

async function discoverAgentsForGoalAcrossSessionRoots(teamLeadWorktreePath: string, recoveryFs: RecoveryFs) {
	const out: Awaited<ReturnType<typeof discoverAgentsForGoal>> = [];
	const seen = new Set<string>();
	for (const sessionsRoot of trustedAgentSessionsRoots()) {
		for (const agent of await discoverAgentsForGoal(
			sessionsRoot,
			teamLeadWorktreePath,
			recoveryFs,
			path.join,
			path.dirname,
			path.basename,
		)) {
			const key = path.resolve(agent.agentWorktreePath);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(agent);
		}
	}
	return out;
}

export interface TeamRecoverySidecars {
	exists(filePath: string): Promise<boolean>;
	read(jsonlPath: string): Promise<SessionSidecar | null>;
	write(jsonlPath: string, sidecar: SessionSidecar): Promise<void>;
}

async function readRecoverySidecar(
	sidecars: TeamRecoverySidecars,
	jsonlPath: string,
): Promise<SessionSidecar | null> {
	try {
		return await sidecars.read(jsonlPath);
	} catch {
		return null;
	}
}

function createRealTeamRecoverySidecars(recoveryFs: RecoveryFs): TeamRecoverySidecars {
	return {
		async exists(filePath) {
			try {
				await recoveryFs.access(filePath);
				return true;
			} catch {
				return false;
			}
		},
		read: (jsonlPath) => readSessionSidecarAsync(jsonlPath, recoveryFs),
		async write(jsonlPath, sidecar) {
			const target = sidecarPathFor(jsonlPath);
			try {
				await fs.promises.mkdir(path.dirname(target), { recursive: true });
				const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
				await fs.promises.writeFile(tmp, JSON.stringify(sidecar, null, 2), { encoding: "utf-8" });
				await fs.promises.rename(tmp, target);
			} catch (err) {
				console.warn(`[session-sidecar] Failed to write sidecar for ${jsonlPath}: ${err}`);
			}
		},
	};
}

const BOUNDED_ERRORED_IDLE_AUTO_RETRY_ATTEMPTS = 3;

function isErroredIdleAutoRetryEligible(session: SessionInfo): boolean {
	const errMsg = session.lastTurnErrorMessage || "";
	if (!errMsg || isNonRetryableAgentError(errMsg)) return false;

	const isBackoff = isProviderBackoffError(errMsg);
	const isTransient = isTransientReviewError(errMsg);
	const isGenericRetryable = !isTransient && isRetryableGenericAgentError(errMsg);
	// OpenAI/Codex reports retryable 5xx failures with a compact `server_error`
	// code; keep team-manager recovery consistent with the visible Retry path for
	// that provider code without treating arbitrary unknown errors as retryable.
	const isRetryableServerErrorCode = /\bserver_error\b/i.test(errMsg);
	if (!isBackoff && !isTransient && !isGenericRetryable && !isRetryableServerErrorCode) return false;
	if (isBackoff) return true;

	return (session.transientRetryAttempts ?? 0) < BOUNDED_ERRORED_IDLE_AUTO_RETRY_ATTEMPTS
		&& (session.consecutiveErrorTurns ?? 0) < BOUNDED_ERRORED_IDLE_AUTO_RETRY_ATTEMPTS;
}

async function gitRefExists(repoPath: string, ref: string): Promise<boolean> {
	try {
		await execFile("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repoPath, timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

async function resolveTeamMemberStartPoint(goal: PersistedGoal): Promise<string | undefined> {
	if (!goal.branch || !goal.repoPath) return undefined;
	if (await gitRefExists(goal.repoPath, `refs/heads/${goal.branch}`)) return goal.branch;
	if (await gitRefExists(goal.repoPath, `refs/remotes/origin/${goal.branch}`)) return `origin/${goal.branch}`;
	return undefined;
}

function splitWorkerResultSummary(resultSummary: string): { summary?: string; branch?: string; commit?: string; checks?: string } {
	let rest = resultSummary.trim();
	let branch: string | undefined;
	let commit: string | undefined;
	let checks: string | undefined;

	const branchMatch = rest.match(/\bBranch\s+(\S+)\s+pushed\s+at\s+([0-9a-f]{7,40})\.?/i);
	if (branchMatch) {
		branch = branchMatch[1];
		commit = branchMatch[2];
		rest = `${rest.slice(0, branchMatch.index)} ${rest.slice((branchMatch.index ?? 0) + branchMatch[0].length)}`.trim();
	}

	rest = rest.replace(/\bWorking copy clean after push\.?/i, "").trim();

	const validationMatch = rest.match(/\bValidation(?:\s+passed)?:\s*([\s\S]*)$/i);
	if (validationMatch) {
		checks = validationMatch[1].trim().replace(/\.$/, "");
		rest = rest.slice(0, validationMatch.index).trim();
	}

	return {
		summary: rest.replace(/\s+/g, " ").replace(/\.$/, "").trim() || undefined,
		branch,
		commit,
		checks: checks?.replace(/\s+/g, " ").trim() || undefined,
	};
}

/**
 * Build a markdown list of available roles (excluding team-lead and assistant)
 * for injection into the team lead prompt via {{AVAILABLE_ROLES}}.
 * Accepts anything with a getAll() method (RoleStore or RoleManager).
 */
export function buildAvailableRolesList(roleSource?: { getAll?: () => Role[]; listRoles?: () => Role[] }): string {
	if (!roleSource) return "coder, reviewer, test-engineer";
	const allRoles = roleSource.getAll?.() ?? roleSource.listRoles?.() ?? [];
	const roles = allRoles.filter(r => r.name !== "team-lead" && r.name !== "assistant");
	if (roles.length === 0) return "No spawnable roles defined.";
	return roles.map(r => {
		const tools = r.toolPolicies ? Object.keys(r.toolPolicies).filter(k => r.toolPolicies![k] === 'allow').slice(0, 8).join(', ') || 'default' : 'default';
		return `- **${r.name}** (${r.label}) — tools: ${tools}`;
	}).join("\n");
}

export class GateDependencyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GateDependencyError";
	}
}

/**
 * Format elapsed time since a timestamp as a human-readable string.
 * Exported for testing.
 */
export function formatElapsed(sinceMs: number): string {
	const mins = Math.floor((Date.now() - sinceMs) / 60_000);
	if (mins < 60) return `${mins}m`;
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return `${h}h ${m}m`;
}

// Team lead extension path is resolved lazily via ToolManager.getExtensionPath().
import { TaskManager } from "./task-manager.js";
import type { DismissResult, OrchestrationCore } from "./orchestration-core.js";


export interface TeamAgent {
	sessionId: string;
	role: string;
	/**
	 * Distinguishes verification reviewer sessions (managed by VerificationHarness)
	 * from regular worker agents spawned via spawnRole. Reviewer agents must NOT
	 * fire team-lead nudges on agent_end — the harness manages their lifecycle.
	 * Defaults to "worker" if missing on load.
	 */
	kind: "worker" | "reviewer";
	/** In-memory marker for pre-kind reviewer records that need legacy safeguards. */
	legacyMissingKind?: boolean;
	worktreePath?: string;
	branch?: string;
	baseSha?: string;
	task: string;
	createdAt: number;
	/** Unsubscribe from the agent_end event listener (cleanup on dismiss). */
	unsubscribeEvent?: () => void;
}

export interface TeamAgentInfo {
	sessionId: string;
	role: string;
	status: string;
	worktreePath?: string;
	branch?: string;
	task: string;
	createdAt: number;
}

export interface TeamState {
	goalId: string;
	teamLeadSessionId: string | null;
	agents: TeamAgentInfo[];
	maxConcurrent: number;
}

/** Internal tracking for a team associated with a goal. */
interface TeamEntry {
	goalId: string;
	teamLeadSessionId: string | null;
	agents: TeamAgent[];
	maxConcurrent: number;
	/** Unsubscribe from team lead RPC events (runtime-only, not persisted). */
	unsubscribeTeamLeadEvents?: () => void;
}



/**
 * Manages team goal lifecycles — team lead sessions and role agent sessions
 * with isolated git worktrees.
 */
export interface TeamManagerConfig {
	/** Color store for assigning unique palette indices to team sessions */
	colorStore: ColorStore;
	/** Task manager for looking up tasks assigned to sessions */
	taskManager: TaskManager;
	/** Role store for looking up role definitions (prompts, accessories, tools) */
	roleStore?: RoleStore;
	/** Cascade-aware single-role resolver (project→server→builtin→market-packs). server.ts wires resolveRoleForProject. */
	resolveRoleForProject?: (roleName: string, projectId?: string) => Role | undefined;
	/** Cascade-aware all-roles resolver for a project scope. server.ts wires configCascade.resolveRoles(projectId).map(r=>r.item). */
	resolveRolesForProject?: (projectId?: string) => Role[];
	/** @deprecated Gate store — resolve per-goal via projectContextManager instead. */
	gateStore?: GateStore;
	/** Broadcast a WS event to all clients viewing a goal */
	broadcastToGoal?: (goalId: string, event: any) => void;
	/** Project context manager for per-project store resolution */
	projectContextManager?: ProjectContextManager;
	/** Tool manager for resolving extension paths via the cascade */
	toolManager?: ToolManager;
	/** Command runner implementation. Defaults to real child_process execution. */
	commandRunner?: CommandRunner;
	/** Injectable asynchronous filesystem for boot recovery scans. */
	recoveryFs?: RecoveryFs;
	/** Injectable asynchronous sidecar operations for boot recovery/backfill. */
	recoverySidecars?: TeamRecoverySidecars;
	/**
	 * OrchestrationCore — the goal-agnostic child-agent lifecycle core
	 * (docs/design/orchestration-core.md). The team-manager is the GOAL ADAPTER:
	 * it keeps all goal-specific logic (worktree-on-sub-branch, role injection,
	 * gate checks, idle-nudge/stuck-watchdog, team_complete, maxConcurrent) but
	 * routes the generic spawn/dismiss bookkeeping through the core so team
	 * children are visible to the shared orchestration index. Behaviour-preserving
	 * and additive — optional so the test path can omit it.
	 */
	orchestrationCore?: OrchestrationCore;
}

export class TeamManager {
	private sessionManager: SessionManager;
	private config: TeamManagerConfig;
	private taskManager: TaskManager;
	private teams = new Map<string, TeamEntry>();
	/** Local team store — used only in the non-PCM (test) path. */
	private localStore: TeamStore | null;
	/** Local GoalManager — used only in the non-PCM (test) path. */
	private _localGoalManager: GoalManager | null = null;
	/** goalId → idle-nudge timer (one-shot, exponential reschedule). */
	private idleNudgeTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** goalId → consecutive workers-nudge count (reset on agent_start). */
	private idleNudgeCount = new Map<string, number>();
	/** Separate timer for nudging when no workers remain (goalId → timer). One-shot setTimeouts that reschedule with exponential backoff. */
	private noWorkersNudgeTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Count of consecutive no-workers nudges sent for a goal (goalId → count).
	 *  Reset only by external prompts (source "user" or "system"). */
	private noWorkersNudgeCount = new Map<string, number>();
	/** Guard flag: true while an auto-nudge prompt is pending (not yet processed by the agent). */
	private nudgePending = new Map<string, boolean>();
	/** goalId → callbacks for an attempted auto-nudge that has not yet started a lead turn. */
	private pendingNudgeAccounting = new Map<string, { onStarted?: () => void; onNoStart?: () => void }>();
	/** goalId → consecutive no-workers nudge attempts used only for no-start backoff. */
	private noWorkersNudgeAttemptCount = new Map<string, number>();
	/** goalId → consecutive workers-nudge attempts used only for no-start backoff. */
	private idleNudgeAttemptCount = new Map<string, number>();
	/** goalId → last spec-edit nudge ms (throttle). */
	private lastSpecNudgeTs = new Map<string, number>();
	/** Spec-edit nudge throttle window. */
	private static readonly SPEC_NUDGE_THROTTLE_MS = 30_000;
	/** goalId → ms when team-lead became idle. */
	private leadIdleSinceByGoal = new Map<string, number>();
	/** goalId → last stuck-nudge ms (5-min floor). */
	private lastNudgeAtPerGoal = new Map<string, number>();
	/** Goals whose completed team runtime has already been rearmed after a reset. */
	private rearmedCompletedTeams = new Set<string>();
	/** Periodic 60s sweep that detects fully-idle teams. */
	private stuckSweepTimer: ReturnType<typeof setInterval> | null = null;
	private verificationHarness?: VerificationHarness;
	/** Base workers-active idle nudge delay (ms); exponential up to MAX. */
	private static readonly IDLE_NUDGE_DELAY_MS = 600_000;
	private static readonly MAX_IDLE_NUDGE_DELAY_MS = 12 * 60 * 60 * 1000; // 12h
	private static readonly NO_WORKERS_NUDGE_DELAY_MS = 300_000;
	/** Debounce before nudging the lead that a worker went idle; cancelled if the worker resumes. */
	private static readonly WORKER_IDLE_NUDGE_DEBOUNCE_MS = 5_000;
	/** Maximum delay between no-workers nudges (ms). Caps the exponential backoff. */
	private static readonly MAX_NO_WORKERS_NUDGE_DELAY_MS = 12 * 60 * 60 * 1000; // 12h
	/**
	 * If any team member is actively streaming, suppress the workers-nudge unless at
	 * least one has been streaming longer than this threshold. Prevents nagging the
	 * team lead while workers are making real progress.
	 */
	private static readonly LONG_STREAMING_THRESHOLD_MS = 30 * 60 * 1000; // 30m
	private static readonly STUCK_SWEEP_INTERVAL_MS = 60_000;
	/** Quiet threshold before watchdog fires; reused as inter-nudge floor. */
	private static readonly STUCK_QUIET_THRESHOLD_MS = 5 * 60_000;

	/** Reverse lookup: sessionId → goalId for quick dismissal. */
	private sessionToGoal = new Map<string, string>();
	/** sessionId → goalId for idempotent duplicate dismiss classification after live team tracking is removed. */
	private dismissedSessionToGoal = new Map<string, string>();
	/** Per-session dismiss mutex. Prevents overlapping duplicate dismisses from mutating stale agent indexes. */
	private dismissLocks = new Map<string, Promise<void>>();

	/** Track last notification time per worker session to debounce rapid agent_end events. */
	private lastNotifyTime = new Map<string, number>();

	/** Per-worker-session pending idle-notify timer (5s debounce); cancelled if the worker resumes. */
	private pendingIdleNotify = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * Effective worker-idle nudge debounce (ms). Defaults to the static
	 * constant; exposed as an instance field so in-process tests can shrink it
	 * to a negligible value and assert via fast polling instead of waiting out
	 * the real 5s window. Production never reassigns this.
	 */
	private workerIdleNudgeDebounceMs = TeamManager.WORKER_IDLE_NUDGE_DEBOUNCE_MS;

	/** In-flight startTeam promises to prevent concurrent team creation for the same goal. */
	private startTeamLocks = new Map<string, Promise<SessionInfo>>();
	private readonly commandRunner: CommandRunner;
	private readonly recoveryFs: RecoveryFs;
	private readonly recoverySidecars: TeamRecoverySidecars;
	private readonly restorePromise: Promise<void>;
	private restoreCompleted = false;
	private startStuckSweepAfterRestore = true;

	constructor(sessionManager: SessionManager, config: TeamManagerConfig, stateDir?: string, private readonly clock: Clock = realClock) {
		this.sessionManager = sessionManager;
		this.config = config;
		this.taskManager = config.taskManager;
		this.commandRunner = config.commandRunner ?? realCommandRunner;
		this.recoveryFs = config.recoveryFs ?? realRecoveryFs;
		this.recoverySidecars = config.recoverySidecars ?? createRealTeamRecoverySidecars(this.recoveryFs);
		if (config.projectContextManager) {
			this.localStore = null;
		} else {
			const dir = stateDir ?? bobbitStateDir();
			this.localStore = new TeamStore(dir);
			// Non-PCM test path: create a local GoalManager from the same stateDir
			this._localGoalManager = new GoalManager(new GoalStore(dir), undefined, undefined, { commandRunner: this.commandRunner, clock: this.clock });
		}
		this.restorePromise = this.restoreTeams().then(() => {
			this.restoreCompleted = true;
			if (this.startStuckSweepAfterRestore) this.startStuckSweep();
		});
	}

	/** Wait until all required boot-time team recovery has completed. */
	waitForRestore(): Promise<void> {
		return this.restorePromise;
	}

	/** Stop watchdog timers (idempotent). */
	dispose(): void {
		this.stopStuckSweep();
	}

	/** Start the periodic stuck-team watchdog (idempotent). */
	startStuckSweep(): void {
		this.startStuckSweepAfterRestore = true;
		if (!this.restoreCompleted || this.stuckSweepTimer) return;
		const t = this.clock.setInterval(() => {
			try {
				this._stuckSweepTick();
			} catch (err) {
				console.error("[team-manager] Stuck-team watchdog tick failed:", err);
			}
		}, TeamManager.STUCK_SWEEP_INTERVAL_MS);
		t.unref?.();
		this.stuckSweepTimer = t;
	}

	stopStuckSweep(): void {
		this.startStuckSweepAfterRestore = false;
		if (this.stuckSweepTimer) {
			this.clock.clearInterval(this.stuckSweepTimer);
			this.stuckSweepTimer = null;
		}
	}

	/**
	 * Stuck-team watchdog tick. Fires a recovery nudge when lead is idle,
	 * workers > 0 are all idle, lead-idle and last-nudge are both older than
	 * STUCK_QUIET_THRESHOLD_MS, and !shouldSkipNudge.
	 * See docs/design/auto-nudge-stuck-team-leads.md.
	 */
	_stuckSweepTick(now: number = this.clock.now()): void {
		for (const [goalId, entry] of this.teams) {
			if (!entry.teamLeadSessionId) continue;
			if (this.shouldSkipNudge(goalId)) continue;

			const lead = this.sessionManager.getSession(entry.teamLeadSessionId);
			if (!lead || lead.status !== "idle") continue;

			const workers = this.getActiveWorkers(goalId);
			if (workers.length === 0) continue; // no-workers timer owns this case

			const allIdle = workers.every((agent) => {
				const s = this.sessionManager.getSession(agent.sessionId);
				return !!s && s.status === "idle";
			});
			if (!allIdle) continue;

			const leadIdleSince = this.leadIdleSinceByGoal.get(goalId);
			if (typeof leadIdleSince !== "number") continue;
			if (now - leadIdleSince < TeamManager.STUCK_QUIET_THRESHOLD_MS) continue;

			const lastNudgeAt = this.lastNudgeAtPerGoal.get(goalId);
			if (typeof lastNudgeAt === "number" && now - lastNudgeAt < TeamManager.STUCK_QUIET_THRESHOLD_MS) continue;

			this._fireStuckNudge(goalId, entry, workers, now, leadIdleSince);
		}
	}

	private _fireStuckNudge(
		goalId: string,
		entry: TeamEntry,
		workers: TeamAgent[],
		now: number,
		leadIdleSince: number,
	): void {
		const minutes = Math.max(0, Math.floor((now - leadIdleSince) / 60_000));
		const message =
			`[AUTO-NUDGE] Your team is fully idle and the workflow has stalled.\n` +
			`All ${workers.length} team agent(s) are idle and you have been idle for ${minutes} minutes.\n` +
			"Check `task_list` and `gate_list` to identify the next action — either\n" +
			"merge a finished branch, mark a task complete, or signal the next gate.\n" +
			"If all gates have passed, call `team_complete`.";

		if (!this.enqueueAutoNudge(goalId, entry.teamLeadSessionId!, message, { isSteered: true, source: "auto-nudge" }, "Stuck-team watchdog")) return;
		this.lastNudgeAtPerGoal.set(goalId, now);
		console.log(`[team-manager] Stuck-team watchdog fired for goal ${goalId} after ${minutes}m idle`);
	}

	private resolveTeamStore(goalId: string): TeamStore {
		if (this.config.projectContextManager) {
			const ctx = this.config.projectContextManager.getContextForGoal(goalId);
			if (ctx) return ctx.teamStore;
			throw new Error(`Cannot resolve team store: goal "${goalId}" not found in any project`);
		}
		return this.localStore!;
	}

	private resolveGateStore(goalId: string): GateStore | undefined {
		if (this.config.projectContextManager) {
			const ctx = this.config.projectContextManager.getContextForGoal(goalId);
			if (ctx) return ctx.gateStore;
			throw new Error(`Cannot resolve gate store: goal "${goalId}" not found in any project`);
		}
		// No PCM configured (test path) — no gate store available
		return undefined;
	}

	/** Set the broadcastToGoal function (called after WebSocket server is created). */
	setBroadcastToGoal(fn: (goalId: string, event: any) => void): void {
		this.config.broadcastToGoal = fn;
	}

	/** Wire in the verification harness so nudge logic can check for active verifications. */
	setVerificationHarness(harness: VerificationHarness): void {
		this.verificationHarness = harness;
	}

	/** Pick a palette index (0-19) not already used by any session, with randomisation. */
	private assignUniqueColor(sessionId: string): void {
		const PALETTE_SIZE = 20;
		const used = new Set<number>();
		for (const [, idx] of Object.entries(this.config.colorStore.getAll())) {
			used.add(idx);
		}
		// Collect available indices and pick one at random
		const available: number[] = [];
		for (let i = 0; i < PALETTE_SIZE; i++) {
			if (!used.has(i)) available.push(i);
		}
		const idx = available.length > 0
			? available[Math.floor(Math.random() * available.length)]
			: Math.floor(Math.random() * PALETTE_SIZE);
		this.config.colorStore.set(sessionId, idx);
	}

	/**
	 * Convert an in-memory TeamEntry to a PersistedTeamEntry for storage.
	 */
	private toPersistedEntry(entry: TeamEntry): PersistedTeamEntry {
		return {
			goalId: entry.goalId,
			teamLeadSessionId: entry.teamLeadSessionId,
			agents: entry.agents.map((a) => ({
				sessionId: a.sessionId,
				role: a.role,
				kind: a.kind,
				worktreePath: a.worktreePath,
				branch: a.branch,
				baseSha: a.baseSha,
				task: a.task,
				createdAt: a.createdAt,
			})),
			maxConcurrent: entry.maxConcurrent,
		};
	}

	/**
	 * Persist the current state of a team entry to disk.
	 */
	private persistEntry(goalId: string): void {
		const entry = this.teams.get(goalId);
		if (entry) {
			this.resolveTeamStore(goalId).put(this.toPersistedEntry(entry));
		}
	}

	/**
	 * Restore teams from disk. Called from the constructor (before sessions
	 * are restored). Event subscriptions deferred to resubscribeTeamEvents().
	 */
	private async restoreTeams(): Promise<void> {
		// orphan team-store cleanup — Boot-time orphan cleanup. Walk every persisted team
		// entry FIRST and drop entries whose `goalId` is not present in the
		// owning project's goal store. This prevents the zombie-reviewer sweep
		// in `resubscribeTeamEvents` from blowing up later (it ultimately calls
		// `unregisterReviewerSession` → `persistEntry` → `resolveTeamStore`,
		// which would throw because the goal is unknown).
		//
		// Symptom this fixes: server crashes on boot, harness restarts in 1s,
		// server crashes on boot again — endless loop the user has to
		// manually intervene to break.
		//
		// We only drop entries when we have a project-context manager wired
		// in (the production path). In the local/test path, `resolveTeamStore`
		// always returns `this.localStore` so no resolution-time throw can
		// happen and the cleanup is a no-op.
		let droppedOrphans = 0;
		if (this.config.projectContextManager) {
			for (const ctx of this.config.projectContextManager.all()) {
				for (const entry of ctx.teamStore.getAll()) {
					const goal = ctx.goalStore.get(entry.goalId);
					if (!goal) {
						try {
							ctx.teamStore.remove(entry.goalId);
							droppedOrphans++;
							console.warn(
								`[team-manager] Boot cleanup: dropped orphan team entry for unknown goal "${entry.goalId}" ` +
								`(team lead session ${entry.teamLeadSessionId ?? "<none>"}).`,
							);
						} catch (err) {
							console.error(
								`[team-manager] Failed to drop orphan team entry for goalId=${entry.goalId}:`,
								err,
							);
						}
					}
				}
			}
			if (droppedOrphans > 0) {
				console.log(`[team-manager] Cleaned ${droppedOrphans} orphan team entries on boot.`);
			}

			// Second pass — handle team entries whose `teamLeadSessionId` points
			// at a session that no longer exists in the owning project's
			// session store.
			//
			// Cause class: a session record can disappear from sessions.json
			// (race / partial save / DELETE-with-immediate-purge / past bug)
			// while the agent's .jsonl transcript and the team-store entry
			// both survive on disk. Naively dropping the team-store entry
			// here would destroy the user's only handle on the surviving
			// transcript and force them to start a new team-lead from scratch.
			//
			// Recovery policy:
			//   1. Try to locate the canonical .jsonl in the team-lead's
			//      worktree slug-dir under active, historical, or legacy agent
			//      sessions roots. If found → reconstruct a fresh session record pointing
			//      at the surviving .jsonl and write it via sessionStore.put().
			//      Team-store entry is preserved untouched.
			//   2. If no .jsonl can be found → there is genuinely nothing
			//      to restore; drop the team-store entry so `Start Team`
			//      works for the user.
			//
			// Source-side leaks that could create these orphans are plugged
			// in `session-manager.ts::purgeOneSession` (refusal guard for
			// live team-leads) and `server.ts::DELETE /api/sessions/:id`
			// (no auto-purge of archived sessions). This boot pass is the
			// final safety net for existing damaged state and for future
			// unknown leak sources.
			let recovered = 0;
			let droppedDanglingLead = 0;
			for (const ctx of this.config.projectContextManager.all()) {
				const orphans = findOrphanTeamEntries(
					ctx.teamStore.getAll(),
					(id) => ctx.sessionStore.get(id) !== undefined,
				);
				for (const goalId of orphans) {
					const entry = ctx.teamStore.get(goalId);
					const tlid = entry?.teamLeadSessionId ?? "<none>";
					try {
						// Step 1 — try recovery from a surviving .jsonl.
						const goal = ctx.goalStore.get(goalId);
						let recoveredOk = false;
						if (goal?.worktreePath && entry?.teamLeadSessionId) {
							const candidates = await scanSlugDirForJsonls(goal.worktreePath, this.recoveryFs);
							const chosen = pickCanonicalTeamLeadJsonl(candidates);
							if (chosen) {
								const funName = generateTeamNameSync();
								const reconstructed = reconstructTeamLeadSessionRecord({
									teamLeadSessionId: entry.teamLeadSessionId,
									goal: {
										id: goal.id,
										title: goal.title,
										projectId: goal.projectId,
										worktreePath: goal.worktreePath,
										repoPath: goal.repoPath,
										branch: goal.branch,
										sandboxed: goal.sandboxed,
										archived: goal.archived,
									},
									chosenJsonl: chosen,
									funName,
								});
								if (reconstructed) {
									// Sidecar wins over heuristic: if a `.bobbit.json`
									// exists next to the chosen .jsonl, prefer its
									// exact values (original session id, title, role,
									// team links, model prefs).
									const sidecar = await readRecoverySidecar(this.recoverySidecars, chosen.jsonlPath);
									const finalRecord = sidecar
										? reconcileRecoveredSessionWithSidecar(reconstructed as unknown as Record<string, unknown>, sidecar)
										: reconstructed;
									ctx.sessionStore.put(finalRecord as Parameters<typeof ctx.sessionStore.put>[0]);
									recovered++;
									recoveredOk = true;
									console.log(
										`[team-manager] Boot recovery: reconstructed team-lead session ` +
										`${entry.teamLeadSessionId.slice(0, 8)} for goal "${goal.title}" ` +
										`(${goalId.slice(0, 8)}) from surviving .jsonl ${chosen.jsonlPath}.`,
									);
								}
							}
						}
						// Step 2 — fall back to drop only when recovery
						// genuinely isn't possible.
						if (!recoveredOk) {
							ctx.teamStore.remove(goalId);
							droppedDanglingLead++;
							console.warn(
								`[team-manager] Boot cleanup: dropped team entry for goal "${goalId}" — ` +
								`team-lead session ${tlid} missing AND no surviving .jsonl found in ` +
								`worktree slug-dir. The team is no longer recoverable.`,
							);
						}
					} catch (err) {
						console.error(
							`[team-manager] Boot recovery/cleanup failed for goalId=${goalId}:`,
							err,
						);
					}
				}
			}
			if (recovered > 0) {
				console.log(`[team-manager] Boot recovery: reconstructed ${recovered} team-lead session record(s) from surviving .jsonl files.`);
			}
			if (droppedDanglingLead > 0) {
				console.log(`[team-manager] Cleaned ${droppedDanglingLead} unrecoverable team entries on boot.`);
			}

			// Third pass — fully-orphaned team-mode goals.
			//
			// Shape this handles: the parent's team-store entry was lost AND
			// the session record was lost, but the agent's .jsonl transcripts
			// still survive in the worktree slug-dir. The user's 18 subgoals
			// under "Audit subgoals branch" looked exactly like this: every
			// archived team-mode subgoal had 7-9 surviving .jsonls and zero
			// pointers into them. The second pass above only catches orphans
			// the team-store still references; this third pass catches goals
			// the team-store has forgotten about entirely.
			//
			// We don't re-create the team-store entry — these goals are
			// archived (the team is done), so there's no need for a live
			// team-store row. We just stamp the team-lead session record
			// back into sessionStore (archived=true matching the goal). The
			// sidebar's archived branch then surfaces the team-lead under
			// the goal again, with the full .jsonl history available via
			// continue-archived if the user wants to read it.
			let fullyOrphanRecovered = 0;
			for (const ctx of this.config.projectContextManager.all()) {
				for (const goal of ctx.goalStore.getAll()) {
					if (!goal.team) continue;
					if (!goal.worktreePath) continue;
					// Skip if a team-store entry exists (already handled by the
					// pass above) — even orphan entries.
					if (ctx.teamStore.get(goal.id)) continue;
					// Skip if any session record already references this goal
					// as its team-lead — recovery isn't needed.
					const existingLead = ctx.sessionStore.getAll()
						.find(s => s.teamGoalId === goal.id && s.role === "team-lead");
					if (existingLead) continue;
					// Look for surviving .jsonl(s) in the worktree slug-dir.
					const candidates = await scanSlugDirForJsonls(goal.worktreePath, this.recoveryFs);
					const chosen = pickCanonicalTeamLeadJsonl(candidates);
					if (!chosen) continue;
					// Generate a fresh-but-stable bobbit session id. The
					// original is unknowable (never persisted).
					const newSessionId = randomUUID();
					try {
						const funName = generateTeamNameSync();
						const reconstructed = reconstructTeamLeadSessionRecord({
							teamLeadSessionId: newSessionId,
							goal: {
								id: goal.id,
								title: goal.title,
								projectId: goal.projectId,
								worktreePath: goal.worktreePath,
								repoPath: goal.repoPath,
								branch: goal.branch,
								sandboxed: goal.sandboxed,
								archived: goal.archived,
							},
							chosenJsonl: chosen,
							funName,
						});
						if (reconstructed) {
							const sidecar = await readRecoverySidecar(this.recoverySidecars, chosen.jsonlPath);
							const finalRecord = sidecar
								? reconcileRecoveredSessionWithSidecar(reconstructed as unknown as Record<string, unknown>, sidecar)
								: reconstructed;
							ctx.sessionStore.put(finalRecord as Parameters<typeof ctx.sessionStore.put>[0]);
							fullyOrphanRecovered++;
							console.log(
								`[team-manager] Boot recovery: reconstructed fully-orphan team-lead ` +
								`session ${newSessionId.slice(0, 8)} for goal "${goal.title}" ` +
								`(${goal.id.slice(0, 8)}, archived=${!!goal.archived}) from ` +
								`surviving .jsonl ${chosen.jsonlPath}.`,
							);
						}
					} catch (err) {
						console.error(
							`[team-manager] Fully-orphan recovery failed for goalId=${goal.id}:`,
							err,
						);
					}
				}
			}
			if (fullyOrphanRecovered > 0) {
				console.log(`[team-manager] Boot recovery: reconstructed ${fullyOrphanRecovered} fully-orphan team-lead session(s).`);
			}

			// Fourth pass — rename stale recovered team-lead titles.
			//
			// Earlier recovered sessions used the goal-title in the title
			// ("Team Lead: Audit subgoals branch (recovered)") which doesn't
			// match bobbit's normal "Team Lead: Jira Springer" shape. Upgrade
			// them to use a generated fun-name on first boot after this fix.
			// Idempotent: the predicate detects the OLD shape only, so after
			// rename the predicate stays false on subsequent boots.
			let titlesUpgraded = 0;
			for (const ctx of this.config.projectContextManager.all()) {
				for (const session of ctx.sessionStore.getAll()) {
					if (session.role !== "team-lead" || !session.teamGoalId) continue;
					const goal = ctx.goalStore.get(session.teamGoalId);
					if (!isStaleRecoveredTeamLeadTitle(session.title, goal?.title)) continue;
					const funName = generateTeamNameSync();
					const newTitle = `Team Lead: ${funName} (recovered)`;
					try {
						ctx.sessionStore.update(session.id, { title: newTitle });
						titlesUpgraded++;
						console.log(`[team-manager] Boot recovery: renamed recovered session ${session.id.slice(0, 8)} to "${newTitle}" (was "${session.title}").`);
					} catch (err) {
						console.error(`[team-manager] Title upgrade failed for session ${session.id}:`, err);
					}
				}
			}
			if (titlesUpgraded > 0) {
				console.log(`[team-manager] Boot recovery: upgraded ${titlesUpgraded} stale recovered title(s) to fun-name shape.`);
			}

			// Fifth pass — recover non-team-lead agent sessions (coders,
			// reviewers, qa-testers, etc.) for every team-mode goal whose
			// team-lead is now reachable.
			//
			// Shape: agent worktrees are siblings of the team-lead worktree
			// (e.g. `goal-audit-subg-225e4d3d/` vs `goal-goal-audit-subg-
			// 225e4d3d-coder-ad801c01/`). The worktree dirs themselves get
			// cleaned up after the agent merges back, but the agent's .jsonl
			// transcripts under the active/historical/legacy agent sessions roots are
			// preserved. The user's "Audit subgoals branch" had 14+ agent
			// slug-dirs surviving with zero session records pointing at them.
			//
			// For each agent slug-dir discovered, we reconstruct a session
			// record with role parsed from the worktree name, teamGoalId
			// pointing at the goal, and teamLeadSessionId pointing at the
			// recovered team-lead. Archived flag mirrors the goal. The
			// sidebar's archived branch then nests them under their
			// team-lead via the existing `teamLeadSessionId === lead.id`
			// filter in render-helpers.ts.
			//
			// Idempotent: each agent worktree path is uniquely keyed; we
			// skip any agent whose worktreePath already has a session record.
			let agentsRecovered = 0;
			for (const ctx of this.config.projectContextManager.all()) {
				for (const goal of ctx.goalStore.getAll()) {
					if (!goal.team || !goal.worktreePath) continue;
					// Find the team-lead session for this goal (recovered or
					// original). Without one we can't attribute the agents.
					const teamLead = ctx.sessionStore.getAll()
						.find(s => s.teamGoalId === goal.id && s.role === "team-lead");
					if (!teamLead) continue;
					// Collect existing agent worktreePaths so we skip them.
					const existingAgentWorktrees = new Set(
						ctx.sessionStore.getAll()
							.filter(s => s.teamGoalId === goal.id && s.role !== "team-lead" && s.worktreePath)
							.map(s => s.worktreePath!),
					);
					const discovered = await discoverAgentsForGoalAcrossSessionRoots(goal.worktreePath, this.recoveryFs);
					for (const agent of discovered) {
						if (existingAgentWorktrees.has(agent.agentWorktreePath)) continue;
						const chosen = pickCanonicalTeamLeadJsonl(agent.candidates);
						if (!chosen) continue;
						try {
							const funName = generateTeamNameSync(agent.role);
							const newSessionId = randomUUID();
							const record = reconstructAgentSessionRecord({
								newSessionId,
								role: agent.role,
								funName,
								teamLeadSessionId: teamLead.id,
								goal: {
									id: goal.id,
									projectId: goal.projectId,
									repoPath: goal.repoPath,
									sandboxed: goal.sandboxed,
									archived: goal.archived,
								},
								agentWorktreePath: agent.agentWorktreePath,
								chosenJsonl: chosen,
							});
							const sidecar = await readRecoverySidecar(this.recoverySidecars, chosen.jsonlPath);
							const finalRecord = sidecar
								? reconcileRecoveredSessionWithSidecar(record as unknown as Record<string, unknown>, sidecar)
								: record;
							ctx.sessionStore.put(finalRecord as Parameters<typeof ctx.sessionStore.put>[0]);
							existingAgentWorktrees.add(agent.agentWorktreePath);
							agentsRecovered++;
						} catch (err) {
							console.error(`[team-manager] Agent recovery failed for ${agent.agentWorktreePath}:`, err);
						}
					}
				}
			}
			if (agentsRecovered > 0) {
				console.log(`[team-manager] Boot recovery: reconstructed ${agentsRecovered} non-team-lead agent session(s) from surviving .jsonl files.`);
			}

			// Sixth pass — boot-time sidecar backfill.
			//
			// Walk every session record and write a sidecar alongside its
			// .jsonl if one doesn't already exist. This makes legacy
			// pre-sidecar sessions recoverable-exact going forward: a future
			// data-loss event will preserve whatever identity is on disk now
			// rather than invent a fresh UUID + fun-name again.
			//
			// Idempotent: the helper is a no-op if the file already exists
			// with matching content (atomic rename overwrites in-place
			// either way, so we don't even need to compare).
			//
			// We process `(recovered)`-titled sessions first so the freshly
			// rolled identity from THIS boot's recovery passes gets a sidecar
			// before any other race could disturb the record again.
			let sidecarsBackfilled = 0;
			for (const ctx of this.config.projectContextManager.all()) {
				const allSessions = ctx.sessionStore.getAll();
				const ordered = [
					...allSessions.filter(s => typeof s.title === "string" && s.title.includes("(recovered)")),
					...allSessions.filter(s => !(typeof s.title === "string" && s.title.includes("(recovered)"))),
				];
				for (const s of ordered) {
					if (!s.agentSessionFile) continue;
					try {
						const sidecarPath = sidecarPathFor(s.agentSessionFile);
						if (await this.recoverySidecars.exists(sidecarPath)) continue;
						// Skip if the .jsonl itself is missing — nothing to attach
						// the sidecar to and the session is non-recoverable anyway.
						if (!await this.recoverySidecars.exists(s.agentSessionFile)) continue;
						const agentSessionId = path.basename(s.agentSessionFile).replace(/\.jsonl$/, "");
						const sidecar = buildSessionSidecar(s, agentSessionId, undefined);
						await this.recoverySidecars.write(s.agentSessionFile, sidecar);
						sidecarsBackfilled++;
					} catch (err) {
						console.warn(`[team-manager] Sidecar backfill failed for session ${s.id}:`, err);
					}
				}
			}
			if (sidecarsBackfilled > 0) {
				console.log(`[team-manager] Boot backfill: wrote ${sidecarsBackfilled} session sidecar(s) for legacy sessions.`);
			}
		}

		let persisted: PersistedTeamEntry[];
		if (this.config.projectContextManager) {
			persisted = [];
			for (const ctx of this.config.projectContextManager.all()) {
				persisted.push(...ctx.teamStore.getAll());
			}
		} else {
			persisted = this.localStore!.getAll();
		}
		for (const p of persisted) {
			const entry: TeamEntry = {
				goalId: p.goalId,
				teamLeadSessionId: p.teamLeadSessionId,
				agents: p.agents.map((a) => {
					const hasPersistedKind = a.kind === "reviewer" || a.kind === "worker";
					return {
						sessionId: a.sessionId,
						role: a.role,
						// Default to "worker" for back-compat with persisted entries
						// written before the kind field was introduced.
						kind: (a.kind === "reviewer" ? "reviewer" : "worker"),
						legacyMissingKind: !hasPersistedKind && a.role === "reviewer" ? true : undefined,
						worktreePath: a.worktreePath,
						branch: a.branch,
						baseSha: a.baseSha,
						task: a.task,
						createdAt: a.createdAt,
					};
				}),
				maxConcurrent: p.maxConcurrent,
			};
			this.teams.set(p.goalId, entry);

			// Rebuild reverse lookup
			if (p.teamLeadSessionId) {
				this.sessionToGoal.set(p.teamLeadSessionId, p.goalId);
			}
			for (const agent of entry.agents) {
				this.sessionToGoal.set(agent.sessionId, p.goalId);
			}

			// Per-team restore detail is debug-only; the `Re-subscribed to events for
			// N team(s)` summary covers the routine boot case.
			if (process.env.BOBBIT_DEBUG)
				console.log(
					`[team-manager] Restored team for goal ${p.goalId} — team lead: ${p.teamLeadSessionId}, agents: ${entry.agents.length}`,
				);
		}
	}

	/**
	 * Re-subscribe to team-lead and worker agent events. Must run AFTER
	 * restoreSessions() — needs live session objects.
	 */
	resubscribeTeamEvents(): void {
		// zombie-reviewer sweep — Zombie-reviewer sweep. After a server restart, reviewer
		// sessions belonging to a verification that was running mid-flight are
		// torn down by the harness's resume logic. The persisted `team-state.json`
		// can still carry a stale agent entry pointing at the dead session; if
		// nothing reaps it, every subsequent team_list / dashboard render
		// surfaces it as a phantom reviewer. This defensive sweep removes
		// reviewer agents whose underlying session no longer exists in the
		// session manager.
		//
		// `unregisterReviewerSession` is wrapped in try/catch so one bad reviewer
		// entry can't take down the whole boot path — the symptom would be
		// indistinguishable from orphan team-store cleanup (endless restart loop) but
		// triggered later in the boot sequence.
		for (const [goalId, entry] of this.teams) {
			const reviewers = entry.agents.filter((a) => this.isVerificationReviewerAgent(a));
			for (const reviewer of reviewers) {
				const session = this.sessionManager.getSession(reviewer.sessionId);
				if (!session || session.status === "terminated") {
					try {
						this.unregisterReviewerSession(goalId, reviewer.sessionId);
						console.log(
							`[team-manager] Zombie-reviewer sweep: unregistered terminated reviewer session ` +
							`${reviewer.sessionId} from goal ${goalId}.`,
						);
					} catch (err) {
						console.error(
							`[team-manager] Zombie-reviewer sweep failed for goal=${goalId} session=${reviewer.sessionId}:`,
							err,
						);
						// Continue processing other reviewers / goals — one bad
						// entry must not block boot.
					}
				}
			}
		}

		for (const [goalId, entry] of this.teams) {
			try {
				this.reapStaleWorkers(goalId, entry);
			} catch (err) {
				console.error(`[team-manager] Stale-worker reap failed for goal=${goalId}:`, err);
			}
		}

		for (const [goalId, entry] of this.teams) {
			// Re-subscribe to team lead events and restart idle timer if needed
			if (entry.teamLeadSessionId) {
				const tlSession = this.sessionManager.getSession(entry.teamLeadSessionId);
				if (tlSession && tlSession.status !== "terminated") {
					this.subscribeTeamLeadEvents(goalId);
					if (tlSession.status === "idle") {
						this.startIdleNudgeTimer(goalId);
					}
				}
			}

			// Re-subscribe to worker agent events so the team lead is notified
			// when workers go idle (these subscriptions are lost on restart).
			// Verification reviewer sessions are managed by VerificationHarness — never attach
			// the agent_end → notifyTeamLead listener for them.
			for (const agent of entry.agents) {
				if (this.isVerificationReviewerAgent(agent)) continue;
				const workerSession = this.sessionManager.getSession(agent.sessionId);
				if (!workerSession || workerSession.status === "terminated") continue;
				const { role, sessionId } = agent;
				const agentId = `${role}-${sessionId.slice(0, 8)}`;
				agent.unsubscribeEvent = this.subscribeWorkerEvents(
					goalId, sessionId, role, agentId, workerSession.rpcClient,
				);
			}
		}
		// boot-resume idle team-leads with outstanding work. The stuck-sweep
		// would catch these after STUCK_QUIET_THRESHOLD_MS (5 min) but that
		// leaves a gap where the operator sees a freshly-restored team-lead
		// sitting idle on a failed gate / open task with no progress signal.
		// Fire a one-shot wake-up immediately for teams whose state implies
		// concrete pending work. shouldSkipNudge handles paused/complete/
		// archived/in-flight-child so dormant goals are not woken.
		this._bootResumeIdleTeamLeads();

		console.log(`[team-manager] Re-subscribed to events for ${this.teams.size} team(s)`);
	}

	/**
	 * Detect teams whose lead is idle on boot AND that have concrete
	 * outstanding work (an unresolved gate or an open task). Send a one-shot
	 * boot-resume nudge so the operator doesn't have to wait for the 5-min
	 * stuck-sweep tick before progress resumes after a gateway restart.
	 *
	 * Conservatism rules:
	 *  - Skip everything `shouldSkipNudge` skips (paused/complete/shelved/
	 *    archived/in-flight-child/nudge-pending/active-verification).
	 *  - Skip teams with no unresolved gate AND no open task — a goal with all
	 *    gates passed or bypassed and no pending tasks is genuinely dormant; nudging
	 *    it would just re-invoke an LLM for no reason.
	 *  - Stamp `nudgePending` + `lastNudgeAtPerGoal` so the stuck-sweep
	 *    doesn't double-fire within STUCK_QUIET_THRESHOLD_MS.
	 */
	private _bootResumeIdleTeamLeads(): void {
		const now = this.clock.now();
		let resumed = 0;
		for (const [goalId, entry] of this.teams) {
			if (!entry.teamLeadSessionId) continue;
			const session = this.sessionManager.getSession(entry.teamLeadSessionId);
			if (!session || session.status !== "idle") continue;
			if (this.shouldSkipNudge(goalId)) continue;
			// A session that was mid-turn (wasStreaming) is already being
			// re-prompted by SessionManager.restoreSession's mid-turn path;
			// nudging it here too would race two prompts at the same cold agent.
			if (this.sessionManager.wasBootReprompted?.(entry.teamLeadSessionId)) continue;
			const summary = this._outstandingWorkSummary(goalId);
			if (!summary) continue;

			const msg =
				`[BOOT-RESUME] The gateway restarted; you were idle with outstanding work.\n` +
				`${summary}\n\n` +
				"Check `task_list` and `gate_list` to confirm, then resume — fix any\n" +
				"failed gate, assign or complete open tasks, or call `team_complete`\n" +
				"if everything is genuinely done.";
			// enqueuePrompt drains ASYNCHRONOUSLY: for an idle lead with an empty
			// queue it awaits dispatchDirectPrompt → rpcClient.prompt(), which on
			// a cold agent rejects with the cold-start timeout. The helper owns
			// async rejection handling so it never escapes as `[gateway] Unhandled rejection`.
			if (!this.enqueueAutoNudge(goalId, entry.teamLeadSessionId, msg, { isSteered: true, source: "system", coldStart: true }, "Boot-resume nudge")) continue;
			this.lastNudgeAtPerGoal.set(goalId, now);
			resumed++;
			console.log(`[team-manager] Boot-resume nudge sent for goal=${goalId} (${summary})`);
		}
		if (resumed > 0) {
			console.log(`[team-manager] Boot-resume nudged ${resumed} idle team-lead(s) with outstanding work.`);
		}
	}

	private enqueueAutoNudge(
		goalId: string,
		sessionId: string,
		message: string,
		opts: { isSteered: true; source: PromptSource; coldStart?: boolean },
		label: string,
		accounting?: { onStarted?: () => void; onNoStart?: () => void },
	): boolean {
		if (this.recoverErroredIdleSessionBeforeNudge(goalId, sessionId, label)) return true;

		this.nudgePending.set(goalId, true);
		if (accounting) this.pendingNudgeAccounting.set(goalId, accounting);

		let delivery: unknown;
		try {
			delivery = this.sessionManager.enqueuePrompt(sessionId, message, opts);
		} catch (err) {
			this.clearPendingNudgeNoStart(goalId);
			console.error(`[team-manager] ${label} enqueuePrompt failed for goal ${goalId}:`, err);
			return false;
		}

		this.handleNudgeDeliveryResult(goalId, delivery);
		if (this.isThenable(delivery)) {
			// A parked/capped enqueue returns a resolved promise while the lead stays idle.
			// Clear on the next macrotask if no agent_start/status transition happened.
			this.clock.setTimeout(() => {
				if (this.isTeamLeadIdle(goalId)) this.clearPendingNudgeNoStart(goalId);
			}, 0);
			void delivery.then(
				(result) => this.handleNudgeDeliveryResult(goalId, result),
				(err) => {
					this.clearPendingNudgeNoStart(goalId);
					console.error(`[team-manager] ${label} failed for goal ${goalId}:`, err);
				},
			);
		}

		return true;
	}

	private recoverErroredIdleSessionBeforeNudge(goalId: string, sessionId: string, label: string): boolean {
		const session = this.sessionManager.getSession(sessionId);
		if (!session || session.status !== "idle" || !session.lastTurnErrored) return false;

		// Treat the errored idle state as handled by the session retry/manual Retry path.
		// This guard prevents every team-manager watchdog from appending fresh
		// [AUTO-NUDGE] cards behind the visible error affordance.
		this.nudgePending.set(goalId, true);

		if (session.pendingAutoRetryTimer) {
			console.log(`[team-manager] ${label} skipped for goal ${goalId}; session ${sessionId} already has an auto-retry pending`);
			return true;
		}

		if (!isErroredIdleAutoRetryEligible(session)) {
			const errMsg = session.lastTurnErrorMessage || "";
			const exhausted = (session.consecutiveErrorTurns ?? 0) >= BOUNDED_ERRORED_IDLE_AUTO_RETRY_ATTEMPTS
				|| (session.transientRetryAttempts ?? 0) >= BOUNDED_ERRORED_IDLE_AUTO_RETRY_ATTEMPTS;
			const reason = exhausted
				? " after exhausted retries"
				: isNonRetryableAgentError(errMsg)
					? " for a non-retryable error"
					: " for an unclassified error";
			console.log(
				`[team-manager] ${label} suppressed for errored idle session ${sessionId}; ` +
				`manual Retry required${reason}`,
			);
			return true;
		}

		try {
			const retry = this.sessionManager.retryLastPrompt(sessionId, { auto: true });
			if (this.isThenable(retry)) {
				void retry.catch((err) => {
					console.error(`[team-manager] ${label} retryLastPrompt failed for goal ${goalId}:`, err);
				});
			}
			console.log(`[team-manager] ${label} recovered errored idle session ${sessionId} via retryLastPrompt(auto)`);
		} catch (err) {
			console.error(`[team-manager] ${label} retryLastPrompt failed for goal ${goalId}:`, err);
		}
		return true;
	}

	private handleNudgeDeliveryResult(goalId: string, delivery: unknown): void {
		if (!delivery || typeof delivery !== "object") return;
		const result = delivery as { status?: unknown; parked?: unknown };
		if (result.status === "dispatched") {
			this.confirmPendingNudgeStarted(goalId);
		} else if (result.parked === true || (result.status === "queued" && this.isTeamLeadIdle(goalId))) {
			this.clearPendingNudgeNoStart(goalId);
		}
	}

	private confirmPendingNudgeStarted(goalId: string): void {
		this.nudgePending.delete(goalId);
		const accounting = this.pendingNudgeAccounting.get(goalId);
		if (!accounting) return;
		this.pendingNudgeAccounting.delete(goalId);
		accounting.onStarted?.();
	}

	private clearPendingNudgeNoStart(goalId: string): void {
		this.nudgePending.delete(goalId);
		const accounting = this.pendingNudgeAccounting.get(goalId);
		if (!accounting) return;
		this.pendingNudgeAccounting.delete(goalId);
		accounting.onNoStart?.();
	}

	private isThenable(value: unknown): value is PromiseLike<unknown> {
		return !!value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
	}

	private isTeamLeadIdle(goalId: string): boolean {
		const entry = this.teams.get(goalId);
		if (!entry?.teamLeadSessionId) return false;
		return this.sessionManager.getSession(entry.teamLeadSessionId)?.status === "idle";
	}

	/**
	 * Return a one-line description of a goal's concrete outstanding work,
	 * or null if there is none. "Outstanding" = unresolved gate OR open task
	 * (state in todo/in-progress). Passed/bypassed gates and complete tasks don't
	 * count; this is about "the team-lead has a concrete next action".
	 */
	private _outstandingWorkSummary(goalId: string): string | null {
		const ctx = this.config.projectContextManager?.getContextForGoal(goalId);
		if (!ctx) return null;
		let unresolvedGates = 0;
		try {
			const gateStates = ctx.gateStore.getGatesForGoal(goalId);
			unresolvedGates = gateStates.filter(g => g.status !== "passed" && g.status !== "bypassed").length;
		} catch { /* gate store may be unavailable for a freshly-recovered goal */ }
		let openTasks = 0;
		try {
			const tasks = ctx.taskStore.getByGoalId(goalId);
			openTasks = tasks.filter(t => t.state === "todo" || t.state === "in-progress").length;
		} catch { /* task store may be unavailable */ }
		if (unresolvedGates === 0 && openTasks === 0) return null;
		const parts: string[] = [];
		if (unresolvedGates > 0) parts.push(`${unresolvedGates} unresolved gate(s)`);
		if (openTasks > 0) parts.push(`${openTasks} open task(s)`);
		return parts.join(", ");
	}

	/** Clear and remove all idle-nudge timers for a goal. */
	private clearIdleNudgeTimer(goalId: string): void {
		const timer = this.idleNudgeTimers.get(goalId);
		if (timer) {
			this.clock.clearTimeout(timer);
			this.idleNudgeTimers.delete(goalId);
		}
		this.idleNudgeCount.delete(goalId);
		const nwTimer = this.noWorkersNudgeTimers.get(goalId);
		if (nwTimer) {
			this.clock.clearTimeout(nwTimer);
			this.noWorkersNudgeTimers.delete(goalId);
		}
		this.noWorkersNudgeCount.delete(goalId);
		this.noWorkersNudgeAttemptCount.delete(goalId);
		this.idleNudgeAttemptCount.delete(goalId);
		this.nudgePending.delete(goalId);
		this.pendingNudgeAccounting.delete(goalId);
	}

	private formatElapsed(sinceMs: number): string {
		return formatElapsed(sinceMs);
	}

	/** Common pre-checks for nudge timer ticks. True → skip the nudge. */
	private shouldSkipNudge(goalId: string): boolean {
		const entry = this.teams.get(goalId);
		if (!entry?.teamLeadSessionId) return true;
		const tl = this.sessionManager.getSession(entry.teamLeadSessionId);
		if (!tl || tl.status !== "idle") return true;
		if (this.verificationHarness?.getActiveVerifications(goalId).length) return true;
		if (this.nudgePending.get(goalId)) return true;
		// Don't nudge a team lead whose goal has already finished or is paused.
		// Paused goals are sticky-by-operator-intent (see goal-paused-guard.ts):
		// the operator explicitly stopped progress, so the watchdog must not
		// resume it via an idle-nudge. The team-lead's pause cascade already
		// terminated its workers; nudging would re-enter the workflow loop.
		const goal = this.resolveGoal(goalId);
		if (!goal || goal.archived || goal.state === "complete" || goal.state === "shelved" || goal.paused) return true;
		// Skip if any subgoal is in-flight — the parent-notification path
		// will wake the parent on RTM/fail/pause. paused children DO count
		// as in-flight=false (a paused child can't progress without parent
		// intervention, so the nudge IS wanted then).
		try {
			const gm = this.resolveGoalManager(goalId);
			const allGoals = typeof gm.listLiveGoals === "function" ? gm.listLiveGoals() : [];
			if (anyInFlightChild(goalId, allGoals)) return true;
		} catch { /* mock path or PCM lookup miss — treat as no children */ }
		return false;
	}

	private isVerificationReviewerAgent(agent: TeamAgent): boolean {
		return agent.kind === "reviewer" || (agent.legacyMissingKind === true && agent.role === "reviewer");
	}

	private hasLiveSession(sessionId: string): boolean {
		const session = this.sessionManager.getSession(sessionId);
		return !!session && session.status !== "terminated";
	}

	private clearReapedWorkerRuntimeState(goalId: string, agent: TeamAgent): void {
		try {
			agent.unsubscribeEvent?.();
		} catch (err) {
			console.warn(
				`[team-manager] Failed to unsubscribe stale worker ${agent.sessionId} for goal ${goalId}:`,
				err,
			);
		}
		agent.unsubscribeEvent = undefined;

		this.sessionToGoal.delete(agent.sessionId);
		this.lastNotifyTime.delete(agent.sessionId);
		const pending = this.pendingIdleNotify.get(agent.sessionId);
		if (pending) {
			this.clock.clearTimeout(pending);
			this.pendingIdleNotify.delete(agent.sessionId);
		}
		try { this.config.orchestrationCore?.forgetChild(agent.sessionId); } catch { /* best-effort */ }
	}

	/**
	 * Remove non-reviewer worker records whose backing session is missing or terminated.
	 * This is a passive reap only: it updates tracking state and never terminates,
	 * archives, broadcasts, or cleans up worktrees for already-dead sessions.
	 */
	private reapStaleWorkers(goalId: string, entry: TeamEntry | undefined = this.teams.get(goalId)): number {
		if (!entry) return 0;
		let reaped = 0;
		for (let i = entry.agents.length - 1; i >= 0; i--) {
			const agent = entry.agents[i];
			if (this.isVerificationReviewerAgent(agent)) continue;
			if (this.hasLiveSession(agent.sessionId)) continue;

			this.clearReapedWorkerRuntimeState(goalId, agent);
			entry.agents.splice(i, 1);
			reaped++;
			console.log(
				`[team-manager] Reaped stale worker ${agent.sessionId} (${agent.role}) from goal ${goalId}`,
			);
		}
		if (reaped > 0) this.persistEntry(goalId);
		return reaped;
	}

	/** Get active workers, excluding only VerificationHarness reviewers and terminated sessions. */
	private getActiveWorkers(goalId: string): TeamAgent[] {
		const entry = this.teams.get(goalId);
		if (!entry) return [];
		return entry.agents.filter((agent) => {
			if (this.isVerificationReviewerAgent(agent)) return false;
			return this.hasLiveSession(agent.sessionId);
		});
	}

	/**
	 * Start both idle-nudge timers (no-workers 5min one-shot + workers 10min
	 * exponential). See docs/design/auto-nudge-stuck-team-leads.md.
	 */
	private startIdleNudgeTimer(goalId: string): void {
		// Clear any pending timers but PRESERVE counters — callers either come
		// from teardown (clearIdleNudgeTimer already ran) or from agent_end
		// (where we want continued backoff). Reset is the job of
		// clearIdleNudgeTimer / the external-prompt branch of subscribeTeamLeadEvents.
		const existingWorkers = this.idleNudgeTimers.get(goalId);
		if (existingWorkers) { this.clock.clearTimeout(existingWorkers); this.idleNudgeTimers.delete(goalId); }
		const existingNoWorkers = this.noWorkersNudgeTimers.get(goalId);
		if (existingNoWorkers) { this.clock.clearTimeout(existingNoWorkers); this.noWorkersNudgeTimers.delete(goalId); }
		this.nudgePending.delete(goalId);

		// --- No-workers timer (one-shot, reschedules with exponential backoff) ---
		// Each successive nudge (without the lead acting on external input) doubles
		// the delay: 5m, 10m, 20m, 40m, … capped at MAX_NO_WORKERS_NUDGE_DELAY_MS (12h).
		// The counter resets only on external (user/system) prompt via
		// clearIdleNudgeTimer() in subscribeTeamLeadEvents.
		this.scheduleNoWorkersNudge(goalId);

		// --- Workers timer (one-shot, reschedules with exponential backoff) ---
		// Each successive nudge (without the lead acting) doubles the delay:
		// 10m, 20m, 40m, 80m, … capped at MAX_IDLE_NUDGE_DELAY_MS (12h).
		// The counter resets on external prompt via clearIdleNudgeTimer().
		this.scheduleWorkersNudge(goalId);
	}

	/**
	 * Schedule the next no-workers nudge for a goal using exponential backoff.
	 * Delay = NO_WORKERS_NUDGE_DELAY_MS * 2^count, capped at MAX_NO_WORKERS_NUDGE_DELAY_MS.
	 * Aborts cleanly without incrementing the counter if a worker appears before
	 * the timer fires — the workers-nudge takes over that case.
	 */
	private scheduleNoWorkersNudge(goalId: string): void {
		const successCount = this.noWorkersNudgeCount.get(goalId) ?? 0;
		const attemptCount = this.noWorkersNudgeAttemptCount.get(goalId) ?? successCount;
		const count = Math.max(successCount, attemptCount);
		const delay = Math.min(
			TeamManager.NO_WORKERS_NUDGE_DELAY_MS * Math.pow(2, count),
			TeamManager.MAX_NO_WORKERS_NUDGE_DELAY_MS,
		);

		const timer = this.clock.setTimeout(() => {
			this.noWorkersNudgeTimers.delete(goalId);

			if (this.shouldSkipNudge(goalId)) return;
			if (this.getActiveWorkers(goalId).length > 0) {
				// Workers appeared — workers-nudge owns this case. Don't increment, don't reschedule.
				return;
			}

			const entry = this.teams.get(goalId)!;
			const goal = this.resolveGoal(goalId);
			const goalTitle = goal?.title || goalId.slice(0, 8);
			const message =
				`[AUTO-NUDGE] You have been idle for a while and have no active team agents. ` +
				`Goal: "${goalTitle}". ` +
				`Check your progress — use task_list and gate_list to review what's done and what remains. ` +
				`If there's more work to do, spawn agents or do it yourself. ` +
				`If all work is complete and gates are passed, call team_complete to finish the goal.`;

			if (!this.enqueueAutoNudge(goalId, entry.teamLeadSessionId!, message, { isSteered: true, source: "auto-nudge" }, "No-workers nudge", {
				onStarted: () => {
					const nextSuccess = (this.noWorkersNudgeCount.get(goalId) ?? 0) + 1;
					this.noWorkersNudgeCount.set(goalId, nextSuccess);
					this.noWorkersNudgeAttemptCount.set(goalId, Math.max(this.noWorkersNudgeAttemptCount.get(goalId) ?? 0, count + 1));
					const nextDelay = Math.min(
						TeamManager.NO_WORKERS_NUDGE_DELAY_MS * Math.pow(2, Math.max(nextSuccess, count + 1)),
						TeamManager.MAX_NO_WORKERS_NUDGE_DELAY_MS,
					);
					console.log(
						`[team-manager] Sent no-workers nudge #${nextSuccess} to team lead for goal ${goalId}; ` +
						`next nudge in ${Math.round(nextDelay / 60000)}m`,
					);
				},
				onNoStart: () => {
					this.noWorkersNudgeAttemptCount.set(goalId, count + 1);
					this.scheduleNoWorkersNudge(goalId);
				},
			})) return;
		}, delay);

		this.noWorkersNudgeTimers.set(goalId, timer);
	}

	/**
	 * Schedule the next workers-nudge for a goal using exponential backoff.
	 * Delay = IDLE_NUDGE_DELAY_MS * 2^count, capped at MAX_IDLE_NUDGE_DELAY_MS.
	 */
	private scheduleWorkersNudge(goalId: string): void {
		const successCount = this.idleNudgeCount.get(goalId) ?? 0;
		const attemptCount = this.idleNudgeAttemptCount.get(goalId) ?? successCount;
		const count = Math.max(successCount, attemptCount);
		const delay = Math.min(
			TeamManager.IDLE_NUDGE_DELAY_MS * Math.pow(2, count),
			TeamManager.MAX_IDLE_NUDGE_DELAY_MS,
		);

		const timer = this.clock.setTimeout(() => {
			this.idleNudgeTimers.delete(goalId);

			if (this.shouldSkipNudge(goalId)) return;

			const activeWorkers = this.getActiveWorkers(goalId);
			if (activeWorkers.length === 0) {
				// No workers — handled by the other timer. Don't increment backoff.
				this.scheduleWorkersNudge(goalId);
				return;
			}

			// If any workers are actively streaming, only nudge when at least one has
			// been streaming for longer than LONG_STREAMING_THRESHOLD_MS. Workers that
			// are streaming quickly are making progress — don't interrupt the lead
			// to nag about them.
			const streamingWorkers = activeWorkers
				.map((a) => this.sessionManager.getSession(a.sessionId))
				.filter((s): s is NonNullable<typeof s> => !!s && s.status === "streaming");
			if (streamingWorkers.length > 0) {
				const now = this.clock.now();
				const anyLongRunning = streamingWorkers.some((s) => {
					const since = s.streamingStartedAt;
					return typeof since === "number" && now - since > TeamManager.LONG_STREAMING_THRESHOLD_MS;
				});
				if (!anyLongRunning) {
					console.log(
						`[team-manager] Skipping workers-nudge for goal ${goalId} — ` +
						`${streamingWorkers.length} worker(s) streaming, none beyond threshold`,
					);
					// Don't increment backoff — the workers are making progress.
					this.scheduleWorkersNudge(goalId);
					return;
				}
			}

			const entry = this.teams.get(goalId)!;
			const lines = activeWorkers.map((agent) => {
				const s = this.sessionManager.getSession(agent.sessionId);
				const status = s?.status ?? "unknown";
				const tasks = this.resolveTasksForSession(goalId, agent.sessionId);
				const taskInfo = tasks.length > 0
					? `task "${tasks[0].title}" (${tasks[0].state})`
					: "no assigned task";
				const elapsed = this.formatElapsed(agent.createdAt);
				const shortId = agent.sessionId.slice(0, 4);
				return `- Agent ${agent.role}-${shortId} (${agent.role}): ${status}, ${taskInfo}, running ${elapsed}`;
			});

			const message =
				`[AUTO-NUDGE] Team check-in — your agents' current status:\n${lines.join("\n")}\n\n` +
				`Review their progress. If an agent appears stuck or going in the wrong direction, steer them back on track. ` +
				`If an agent is idle and their work looks complete, mark their task as done and dismiss them. ` +
				`If idle agents have more to do, prompt them to continue.`;

			if (!this.enqueueAutoNudge(goalId, entry.teamLeadSessionId!, message, { isSteered: true, source: "auto-nudge" }, "Idle nudge", {
				onStarted: () => {
					const nextSuccess = (this.idleNudgeCount.get(goalId) ?? 0) + 1;
					this.idleNudgeCount.set(goalId, nextSuccess);
					this.idleNudgeAttemptCount.set(goalId, Math.max(this.idleNudgeAttemptCount.get(goalId) ?? 0, count + 1));
					const nextDelay = Math.min(
						TeamManager.IDLE_NUDGE_DELAY_MS * Math.pow(2, Math.max(nextSuccess, count + 1)),
						TeamManager.MAX_IDLE_NUDGE_DELAY_MS,
					);
					console.log(
						`[team-manager] Sent idle nudge #${nextSuccess} to team lead for goal ${goalId}; ` +
						`next nudge in ${Math.round(nextDelay / 60000)}m`,
					);
				},
				onNoStart: () => {
					this.idleNudgeAttemptCount.set(goalId, count + 1);
					this.scheduleWorkersNudge(goalId);
				},
			})) return;
		}, delay);

		this.idleNudgeTimers.set(goalId, timer);
	}

	/**
	 * Subscribe to a worker session's RPC events to nudge the team lead when the
	 * worker goes idle. Mirrors the team-lead idle-nudge pattern: `agent_end`
	 * starts a one-shot 5s timer that fires `notifyTeamLead`; an `agent_start`
	 * within that window cancels it (the worker only blipped — e.g. a flaky tool
	 * call — and is not actually done). A single shared `pendingIdleNotify` map
	 * (keyed by worker sessionId) guarantees a worker never has two pending
	 * timers: we always clear-before-set.
	 */
	private subscribeWorkerEvents(
		goalId: string,
		sessionId: string,
		role: string,
		agentId: string,
		rpcClient: { onEvent: (cb: (event: any) => void) => () => void },
		opts?: { broadcastFinished?: boolean; roleName?: string },
	): () => void {
		return rpcClient.onEvent((event: any) => {
			if (event.type === "agent_end") {
				if (opts?.broadcastFinished) {
					// Broadcast team agent finished event
					this.config.broadcastToGoal?.(goalId, {
						type: "team_agent_finished", goalId, sessionId, role, name: opts.roleName,
					});
				}
				// Clear-before-set so a worker never has two pending timers.
				const existing = this.pendingIdleNotify.get(sessionId);
				if (existing) this.clock.clearTimeout(existing);
				const timer = this.clock.setTimeout(() => {
					this.pendingIdleNotify.delete(sessionId);
					this.notifyTeamLead(goalId, sessionId, role, agentId).catch((err) => {
						console.error("[team-manager] Failed to notify team lead:", err);
					});
				}, this.workerIdleNudgeDebounceMs);
				this.pendingIdleNotify.set(sessionId, timer);
			} else if (event.type === "agent_start") {
				// Worker resumed — cancel any pending idle nudge.
				const existing = this.pendingIdleNotify.get(sessionId);
				if (existing) {
					this.clock.clearTimeout(existing);
					this.pendingIdleNotify.delete(sessionId);
				}
			}
		});
	}

	/**
	 * Subscribe to the team lead session's RPC events to manage the idle-nudge timer.
	 * On agent_end (idle): start the timer. On agent_start (streaming): clear it.
	 */
	private subscribeTeamLeadEvents(goalId: string): boolean {
		const entry = this.teams.get(goalId);
		if (!entry?.teamLeadSessionId) return false;

		const session = this.sessionManager.getSession(entry.teamLeadSessionId);
		if (!session) return false;

		// Do not install a replacement unless the previous listener was definitely
		// removed. A throwing unsubscribe may be transient; retaining it lets a
		// later reopen retry cleanup without risking duplicate subscriptions.
		const previousUnsubscribe = entry.unsubscribeTeamLeadEvents;
		if (previousUnsubscribe) {
			try {
				previousUnsubscribe();
			} catch (err) {
				console.warn(`[team-manager] Failed to unsubscribe team lead events for goal ${goalId}:`, err);
				return false;
			}
			if (entry.unsubscribeTeamLeadEvents === previousUnsubscribe) {
				entry.unsubscribeTeamLeadEvents = undefined;
			}
		}

		let unsubscribe: (() => void) | undefined;
		try {
			unsubscribe = session.rpcClient.onEvent((event: any) => {
				if (event.type === "agent_end") {
					this.leadIdleSinceByGoal.set(goalId, this.clock.now());
					this.startIdleNudgeTimer(goalId);
				} else if (event.type === "agent_start") {
					this.leadIdleSinceByGoal.delete(goalId);
					const tl = this.sessionManager.getSession(entry.teamLeadSessionId!);
					const lastSource = tl?.lastPromptSource ?? "user";
					if (lastSource !== "user" && lastSource !== "system") this.confirmPendingNudgeStarted(goalId);
					else this.clearPendingNudgeNoStart(goalId);
					if (lastSource === "user" || lastSource === "system") {
						// External signal — fresh idle cycle starts from base delay.
						this.clearIdleNudgeTimer(goalId);
					} else {
						// Team lead is replying to its own auto-nudge / task-notification / verification.
						// Cancel pending timers (shouldSkipNudge would block them while streaming anyway),
						// but PRESERVE counters so backoff continues to grow across cycles.
						const t1 = this.idleNudgeTimers.get(goalId);
						if (t1) { this.clock.clearTimeout(t1); this.idleNudgeTimers.delete(goalId); }
						const t2 = this.noWorkersNudgeTimers.get(goalId);
						if (t2) { this.clock.clearTimeout(t2); this.noWorkersNudgeTimers.delete(goalId); }
						// idleNudgeCount and noWorkersNudgeCount intentionally preserved.
					}
				}
			});
		} catch (err) {
			console.warn(`[team-manager] Failed to subscribe to team lead events for goal ${goalId}:`, err);
			return false;
		}

		entry.unsubscribeTeamLeadEvents = unsubscribe;
		// Seed only after subscription succeeds so a failed attempt leaves no
		// partial watchdog state that could make the retry appear successful.
		if (session.status === "idle" && !this.leadIdleSinceByGoal.has(goalId)) {
			this.leadIdleSinceByGoal.set(goalId, this.clock.now());
		}
		return true;
	}

	private get goalManager(): GoalManager {
		// PCM-active paths should use resolveGoalManager() instead.
		// This getter is only for the non-PCM test path.
		if (this.config.projectContextManager) {
			throw new Error("goalManager getter must not be called when PCM is active; use resolveGoalManager(goalId) instead");
		}
		// Support mock SessionManagers that expose goalManager directly (test path)
		if ((this.sessionManager as any).goalManager) return (this.sessionManager as any).goalManager;
		if (this._localGoalManager) return this._localGoalManager;
		throw new Error("goalManager getter requires PCM or local GoalManager");
	}

	/**
	 * Resolve tasks for a session using the correct project's TaskManager.
	 * When PCM is active, resolves via the goal's project context.
	 */
	private resolveTasksForSession(goalId: string, sessionId: string): ReturnType<TaskManager["getTasksForSession"]> {
		if (this.config.projectContextManager) {
			const ctx = this.config.projectContextManager.getContextForGoal(goalId);
			if (ctx) return new TaskManager(ctx.taskStore).getTasksForSession(sessionId);
			return []; // Goal not found in any project — no tasks to return
		}
		return this.taskManager.getTasksForSession(sessionId);
	}

	/**
	 * Build a cascade-aware RoleSource scoped to a goal's project. Prefers the
	 * config-cascade resolvers (project→server→builtin→market-packs) with the
	 * bare RoleStore as a fallback, de-duplicating by name with cascade
	 * precedence first. Falls back to the bare RoleStore when no cascade
	 * resolvers are wired (e.g. in tests).
	 */
	private resolveRoleSource(goal: PersistedGoal | undefined): RoleSource {
		const projectId = goal?.projectId;
		const one = this.config.resolveRoleForProject;
		const all = this.config.resolveRolesForProject;
		if (one || all) {
			return {
				get: (name) => one?.(name, projectId) ?? this.config.roleStore?.get(name),
				getAll: () => {
					const seen = new Set<string>();
					const out: Role[] = [];
					for (const r of [...(all?.(projectId) ?? []), ...(this.config.roleStore?.getAll() ?? [])]) {
						if (!seen.has(r.name)) { seen.add(r.name); out.push(r); }
					}
					return out;
				},
			};
		}
		return this.config.roleStore ?? { get: () => undefined, getAll: () => [] };
	}

	/** Resolve a goal across all project contexts. */
	private resolveGoal(goalId: string): PersistedGoal | undefined {
		if (this.config.projectContextManager) {
			const ctx = this.config.projectContextManager.getContextForGoal(goalId);
			if (ctx) return ctx.goalStore.get(goalId);
			return undefined; // Don't fall back to default project
		}
		return this.goalManager.getGoal(goalId); // non-PCM test path only
	}

	/** Get a GoalManager scoped to the project owning the given goal. */
	private resolveGoalManager(goalId: string): GoalManager {
		if (this.config.projectContextManager) {
			const ctx = this.config.projectContextManager.getContextForGoal(goalId);
			if (ctx) return ctx.goalManager;
			throw new Error(`Cannot resolve GoalManager: goal "${goalId}" not found in any project`);
		}
		return this.goalManager; // non-PCM test path only
	}

	/**
	 * Start a team for the given goal.
	 * Creates a Team Lead session and returns it.
	 */
	async startTeam(goalId: string): Promise<SessionInfo> {
		// Prevent concurrent startTeam calls for the same goal (race condition guard).
		// If another call is already in flight, return its result instead of creating a second team lead.
		const inflight = this.startTeamLocks.get(goalId);
		if (inflight) {
			return inflight;
		}
		const promise = this._startTeamImpl(goalId);
		this.startTeamLocks.set(goalId, promise);
		try {
			return await promise;
		} finally {
			this.startTeamLocks.delete(goalId);
		}
	}

	private async _startTeamImpl(goalId: string): Promise<SessionInfo> {
		const goal = this.resolveGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}
		if (!goal.team) {
			throw new Error(`Goal "${goal.title}" does not have team mode enabled`);
		}
		if (this.teams.has(goalId)) {
			throw new Error(`Team already active for goal: ${goalId}`);
		}
		// Pause-cascade guard — refuse to spawn a team-lead for a paused goal.
		if (goal.paused) throw new GoalPausedError(goalId);
		// Scheduler-block guard — refuse to start a goal that still has
		// unresolved dependsOn deps. 'blocked' is set at spawn time and
		// cleared by integrate-child when all deps merge. Manual team/start
		// must be gated here so a user cannot bypass the scheduler block.
		if (goal.state === "blocked") throw new GoalPausedError(goalId);

		const headquartersGoal = isHeadquartersProject(goal.projectId);
		// Use the goal's worktree/cwd for the team lead. Headquarters is always
		// no-worktree, even if a legacy record still carries branch/worktree fields.
		const cwd = headquartersGoal ? goal.cwd : (goal.worktreePath || goal.cwd);

		// Build the Team Lead role prompt with structural placeholders only
		// Secrets (gateway URL, auth token, goal ID) are passed as env vars, NOT embedded in prompt text
		// Resolve via the goal's inline-roles snapshot first, then the
		// config cascade (project→server→builtin→market-packs) — same precedence as spawnRole().
		const roleSource = this.resolveRoleSource(goal);
		const storedRole = resolveRole(goal, "team-lead", roleSource);
		if (!storedRole) {
			throw new Error('Role "team-lead" not found. Ensure roles/team-lead.yaml exists.');
		}
		const teamLeadPromptTemplate = storedRole.promptTemplate;
		const teamLeadPrompt = applyPromptConditionals(
			teamLeadPromptTemplate
				.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch || "main")
				.replace(/\{\{AGENT_ID\}\}/g, `team-lead-${goalId.slice(0, 8)}`)
				.replace(/\{\{AVAILABLE_ROLES\}\}/g, buildAvailableRolesList(roleSource)),
			{ subGoalsEnabled: this.sessionManager.isSubgoalsEnabled },
		);

		// Create the team lead session with the team tools extension.
		// The extension registers first-class tools (team_spawn, task_create, etc.) in the agent.
		// When sandboxed, create a worktree inside the per-project container for the goal branch.
		const sandboxed = goal.sandboxed ?? this.sessionManager.isSandboxEnabled;

		// Resolve team-lead extension via cascade (ToolManager) or fall back to deprecated TOOLS_DIR
		let teamLeadExtPath: string;
		if (this.config.toolManager) {
			teamLeadExtPath = this.config.toolManager.getExtensionPath("team", "extension.ts");
		} else {
			const { TOOLS_DIR } = await import("./tool-manager.js");
			teamLeadExtPath = path.join(TOOLS_DIR, "team", "extension.ts");
		}
		const session = await this.sessionManager.createSession(
			cwd,
			["--extension", teamLeadExtPath],
			goalId,
			undefined,
			{
				rolePrompt: teamLeadPrompt,
				roleName: "team-lead",
				env: { BOBBIT_GOAL_ID: goalId },
				sandboxed,
				// For sandboxed goals, create a worktree at the goal branch inside the container.
				// Headquarters is always no-worktree, so never pass a branch to sandbox wiring.
				sandboxBranch: sandboxed && !headquartersGoal && goal.branch ? goal.branch : undefined,
				// Honour role-level model / thinking-level override (cascade-resolved above).
				// Empty string falls through to undefined → system default.
				initialModel: storedRole.model || undefined,
				initialThinkingLevel: storedRole.thinkingLevel || undefined,
			},
		);

		// Assign a unique color and title
		this.assignUniqueColor(session.id);
		const teamLeadName = await generateTeamName("team-lead");
		this.sessionManager.setTitle(session.id, `Team Lead: ${teamLeadName}`);
		session.titleGenerated = true;
		const teamLeadAccessory = storedRole?.accessory ?? "crown";
		this.sessionManager.updateSessionMeta(session.id, {
			role: "team-lead",
			teamGoalId: goalId,
			worktreePath: headquartersGoal ? undefined : goal.worktreePath,
			accessory: teamLeadAccessory,
		});

		// Initialize team tracking
		const entry: TeamEntry = {
			goalId,
			teamLeadSessionId: session.id,
			agents: [],
			maxConcurrent: 12,
		};
		this.teams.set(goalId, entry);
		this.sessionToGoal.set(session.id, goalId);
		this.persistEntry(goalId);

		// Subscribe to team lead lifecycle events for idle-nudge timer
		this.subscribeTeamLeadEvents(goalId);

		// Transition goal to in-progress if needed
		if (goal.state === "todo") {
			await this.resolveGoalManager(goalId).updateGoal(goalId, { state: "in-progress" });
		}

		// Kick off the team lead with an initial prompt (same pattern as delegate sessions).
		// Re-read goal so we pick up any spec edits that happened during session setup.
		const freshGoal = this.resolveGoal(goalId) ?? goal;
		const specBody = (freshGoal.spec ?? "").trim();
		const kickoff = specBody
			? `# Goal Spec\n\n${specBody}\n\n---\n\nExecute the task described in your system prompt. Follow the instructions carefully.`
			: "Execute the task described in your system prompt. Follow the instructions carefully.";
		this.sessionManager.enqueuePrompt(session.id, kickoff, {
			source: "system",
			suppressTitleGen: true,
		}).catch((err: any) => {
			console.error("[team-manager] Failed to send team lead kickoff prompt:", err);
		});

		console.log(`[team-manager] Started team for goal "${goal.title}" — team lead: ${session.id}`);
		return session;
	}

	/**
	 * Spawn a role agent for a team goal.
	 * Creates an isolated git worktree and a session with the role's system prompt.
	 * Sends the task as the first prompt.
	 */
	/**
	 * Build context from passed upstream dependency gates.
	 *
	 * If `explicitInputIds` is provided, those workflow gate IDs are used directly.
	 * Otherwise, auto-resolves from the DAG's `dependsOn` for `workflowGateId`.
	 */
	buildDependencyContext(goalId: string, workflowGateId?: string, explicitInputIds?: string[]): string {
		const goal = this.resolveGoal(goalId);
		if (!goal?.workflow) return "";
		const resolvedGateStore = this.resolveGateStore(goalId);
		if (!resolvedGateStore) return "";

		// Determine which gate IDs to inject content from
		let inputIds: string[];
		if (explicitInputIds && explicitInputIds.length > 0) {
			inputIds = explicitInputIds;
		} else if (workflowGateId) {
			const wfGate = goal.workflow.gates.find(g => g.id === workflowGateId);
			if (!wfGate || !wfGate.dependsOn?.length) return "";
			inputIds = wfGate.dependsOn;
		} else {
			return "";
		}

		const gateStates = resolvedGateStore.getGatesForGoal(goalId);
		const parts: string[] = [];

		for (const depId of inputIds) {
			const gateDef = goal.workflow.gates.find(g => g.id === depId);
			const gateState = gateStates.find(g => g.gateId === depId);
			if (gateDef && gateState && gateState.status === "passed" && gateDef.injectDownstream && gateState.currentContent) {
				parts.push(`## Gate: ${gateDef.name} (passed)\n\n${gateState.currentContent}`);
			}
		}

		if (parts.length === 0 && inputIds.length > 0) {
			const injectableCount = inputIds.filter(depId => {
				const gateDef = goal.workflow!.gates.find(g => g.id === depId);
				return gateDef?.injectDownstream;
			}).length;
			if (injectableCount > 0) {
				console.warn(
					`[team-manager] buildDependencyContext: workflowGateId="${workflowGateId}" has ${injectableCount} ` +
					`injectable upstream gate(s) but none produced content. Gates checked: ${inputIds.join(", ")}`
				);
			}
		}

		if (parts.length === 0) return "";
		return "\n\n# Upstream Gates\n\nContent from passed upstream gates:\n\n" + parts.join("\n\n---\n\n");
	}

	/**
	 * Try to extract a workflowGateId from the task description.
	 * Looks for a pattern like `[gate:some-id]` in the task text.
	 */
	private extractWorkflowGateId(task: string, goalId: string): string | undefined {
		// Check for explicit tag
		const tagMatch = task.match(/\[gate:([^\]]+)\]/);
		if (tagMatch) return tagMatch[1];

		// Try to match against workflow gate names/IDs in the goal
		const goal = this.resolveGoal(goalId);
		if (!goal?.workflow) return undefined;

		const taskLower = task.toLowerCase();
		for (const gate of goal.workflow.gates) {
			if (taskLower.includes(gate.name.toLowerCase()) || task.includes(gate.id)) {
				return gate.id;
			}
		}
		return undefined;
	}

	async spawnRole(
		goalId: string,
		role: string,
		task: string,
		opts?: { workflowGateId?: string; inputGateIds?: string[] },
	): Promise<{ sessionId: string; worktreePath?: string }> {
		// Resolve via the goal's inline-roles snapshot first, then the
		// config cascade (project→server→builtin→market-packs). See resolveRole()
		// and the PersistedGoal.inlineRoles field doc for the precedence rule.
		const goalForRole = this.resolveGoal(goalId);
		const roleSource = this.resolveRoleSource(goalForRole);
		const storedRoleDef = resolveRole(goalForRole, role, roleSource);
		if (!storedRoleDef) {
			const available = listAvailableRoles(goalForRole, roleSource).join(", ") || "none";
			throw new Error(`Role "${role}" not found. Available roles: ${available}`);
		}

		if (role === 'team-lead') {
			throw new Error('Cannot spawn team-lead role via spawnRole — use startTeam() instead');
		}

		const entry = this.teams.get(goalId);
		if (!entry) {
			throw new Error(`No active team for goal: ${goalId}`);
		}

		// Check concurrency limit using the same live-worker semantics as sidebar/listing.
		this.reapStaleWorkers(goalId, entry);
		const activeWorkerCount = this.getActiveWorkers(goalId).length;
		if (activeWorkerCount >= entry.maxConcurrent) {
			throw new Error(
				`Team for goal ${goalId} already has ${activeWorkerCount} agents (active workers; max: ${entry.maxConcurrent})`,
			);
		}

		const goal = this.resolveGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}
		// Pause-cascade guard — in-process callers (team-lead extension
		// invoking the team_spawn MCP tool) bypass REST. Defense-in-depth.
		if (goal.paused) throw new GoalPausedError(goalId);

		// repoPath is only set when the goal's cwd is inside a git repo.
		// If absent, skip worktree creation and use the goal's cwd directly.
		// Headquarters never gets member worktrees, even if a legacy goal record
		// still has repo/branch fields from the pre-split implementation.
		const useWorktree = !isHeadquartersProject(goal.projectId) && !!goal.repoPath && !!goal.branch;

		// Enforce gate dependency check: upstream gates must be passed before spawning for a gate
		const resolvedWorkflowGateId = opts?.workflowGateId ?? this.extractWorkflowGateId(task, goalId);
		const spawnGateStore = this.resolveGateStore(goalId);
		if (resolvedWorkflowGateId && goal.workflow && spawnGateStore) {
			const gateStates = spawnGateStore.getGatesForGoal(goalId);
			const depError = checkGateDependencies(resolvedWorkflowGateId, goal.workflow.gates, gateStates);
			if (depError) {
				throw new GateDependencyError(depError);
			}
		}

		// Create a worktree for this role agent (only when the goal is in a git repo).
		// Branch shape pinned by tests/team-branch-shape.test.ts:
		//   goal/<goalId8>/<role>-<short4>
		// `createWorktree` flattens slashes to hyphens for the worktree dirname,
		// so the on-disk directory is `goal-<goalId8>-<role>-<short4>`.
		const shortId = randomUUID().slice(0, 4);
		let worktreeResult: { worktreePath: string; branchName: string } | undefined;
		let branchName: string | undefined;
		let agentCwd: string;
		let memberStartPoint: string | undefined;
		const memberSandboxed = goal.sandboxed ?? this.sessionManager.isSandboxEnabled;

		if (useWorktree) {
			const goalId8 = goalId.slice(0, 8);
			branchName = `goal/${goalId8}/${role}-${shortId}`;

			memberStartPoint = await resolveTeamMemberStartPoint(goal);

			// Compute subdirectory offset from the goal's worktree root to its cwd.
			// If the project rootPath is a subdirectory of the repo, goal.cwd includes
			// the offset (e.g. worktreePath + "/packages/my-app"), and we must apply
			// the same offset to the member's worktree.
			const memberSubdirOffset = goal.worktreePath
				? path.relative(goal.worktreePath, goal.cwd)
				: "";

			if (memberSandboxed && this.sessionManager.getSandboxManager()) {
				// Sandboxed: worktree created inside the container by applySandboxWiring
				// via ProjectSandbox.createWorktree(). Use goal.cwd as placeholder.
				agentCwd = goal.cwd; // placeholder — sandbox wiring overrides this
			} else {
				// Non-sandboxed: create the member worktree from local goal state. Goal
				// branches may be unpublished, so prefer local refs before origin refs.
				const worktreeOptions = { startPoint: memberStartPoint, commandRunner: this.commandRunner };
				worktreeResult = await createWorktree(goal.repoPath!, branchName, worktreeOptions);
				// Apply subdirectory offset to member worktree cwd
				agentCwd = memberSubdirOffset && memberSubdirOffset !== "."
					? path.join(worktreeResult.worktreePath, memberSubdirOffset)
					: worktreeResult.worktreePath;
			}
		} else {
			agentCwd = goal.cwd;
		}

		// Fire the `goalProvisioned` lifecycle hook for this freshly created member
		// worktree. team-manager creates member worktrees directly via
		// `createWorktree()` and hands the pre-built cwd to `createSession`, so the
		// session-setup provisioning dispatch never runs for them — without this,
		// metadata-driven filesystem treatments would be missing on normal member
		// worktrees. Resolves the member's effective (inherited) goal metadata via
		// the single SessionManager resolver — no ad-hoc ancestry walk. Skipped for
		// sandboxed members here because their worktree lives inside the container
		// and is created later by applySandboxWiring, which fires the hook itself
		// (with the actual container worktree path). Non-fatal.
		if (worktreeResult) {
			await this.sessionManager.dispatchGoalProvisionedForWorktree({
				goalId,
				projectId: goal.projectId,
				worktreePath: worktreeResult.worktreePath,
				cwd: agentCwd,
				branch: branchName,
			});
		}

		try {
			const agentId = `${role}-${shortId}`;
			const rolePromptTemplate = storedRoleDef.promptTemplate;
			const rolePrompt = rolePromptTemplate
				.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch || "main")
				.replace(/\{\{AGENT_ID\}\}/g, agentId);

			// Build workflow dependency context for the system prompt
			let workflowContext: string | undefined;
			const wfGateId = opts?.workflowGateId ?? this.extractWorkflowGateId(task, goalId);
			const explicitInputs = opts?.inputGateIds;
			if (explicitInputs?.length || wfGateId) {
				const ctx = this.buildDependencyContext(goalId, wfGateId, explicitInputs);
				if (ctx) workflowContext = ctx;
			}

			// Create the session with the role agent's cwd.
			// For sandboxed members, create a worktree inside the per-project container.
			const session = await this.sessionManager.createSession(
				agentCwd,
				undefined,
				goalId,
				undefined,
				{
					rolePrompt, roleName: role, workflowContext, sandboxed: memberSandboxed,
					// Pass branch info so applySandboxWiring creates the worktree inside the container.
					// The base branch is local-ref-first because sandbox goal branches may be unpublished.
					sandboxBranch: memberSandboxed && branchName ? branchName : undefined,
					sandboxBaseBranch: memberSandboxed && branchName ? memberStartPoint : undefined,
					// Honour role-level model / thinking-level override (cascade-resolved above).
					// Empty string falls through to undefined → system default.
					initialModel: storedRoleDef.model || undefined,
					initialThinkingLevel: storedRoleDef.thinkingLevel || undefined,
				},
			);

			// Assign a unique color and title
			this.assignUniqueColor(session.id);
			const roleName = await generateTeamName(role);
			const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
			this.sessionManager.setTitle(session.id, `${roleLabel}: ${roleName}`);
			session.titleGenerated = true;
			const roleAccessory = storedRoleDef.accessory;
			// For sandboxed sessions, the actual worktree is session.cwd (set by ProjectSandbox.createWorktree).
			// No-worktree goals, including Headquarters, must not persist cwd as a worktree.
			const actualWorktreePath = worktreeResult?.worktreePath || (memberSandboxed && useWorktree ? session.cwd : undefined);
			const memberSessionMeta = {
				role,
				teamGoalId: goalId,
				worktreePath: actualWorktreePath,
				accessory: roleAccessory,
				teamLeadSessionId: entry.teamLeadSessionId ?? undefined,
			};
			this.sessionManager.updateSessionMeta(session.id, memberSessionMeta as any);

			// Resolve baseSha from the agent's working directory.
			// For sandboxed sessions, run git inside the container.
			let baseSha: string | undefined;
			try {
				const effectiveCwd = actualWorktreePath || session.cwd || agentCwd;
				if (memberSandboxed && this.sessionManager.getSandboxManager()) {
					const sandbox = this.sessionManager.getSandboxManager()!.get(goal.projectId || "");
					if (sandbox) {
						const output = await sandbox.exec(["git", "rev-parse", "HEAD"], { cwd: effectiveCwd });
						baseSha = output.trim() || undefined;
					}
				} else {
					const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: effectiveCwd, timeout: 5_000 });
					baseSha = stdout.trim() || undefined;
				}
			} catch { /* non-fatal — baseSha stays undefined */ }

			// Track the agent
			const agent: TeamAgent = {
				sessionId: session.id,
				role,
				kind: "worker",
				worktreePath: actualWorktreePath,
				branch: branchName,
				baseSha,
				task,
				createdAt: this.clock.now(),
			};
			entry.agents.push(agent);
			this.sessionToGoal.set(session.id, goalId);
			this.persistEntry(goalId);

			// Goal adapter ↔ OrchestrationCore (M2). The team worker's CREATE call
			// stays here (not routed through OrchestrationCore.spawn) on purpose —
			// after an honest attempt, routing it through the core would REGRESS goal
			// semantics that the goal-agnostic core deliberately does not model:
			//   • Tool set: core.spawn computes the child's allowedTools as the OWNER's
			//     effective set minus the spawn verbs. A team worker must instead get
			//     ITS ROLE's default tools (reviewer ≠ team-lead-minus-spawn) — which
			//     createSession derives from `roleName`. Routing through the core would
			//     silently hand workers the lead's tool set.
			//   • Worktree: team-manager PRE-CREATES the sub-branch worktree (with
			//     subdir-offset / sandbox-container handling) and passes the resolved
			//     cwd; core.spawn's sub-branch mode instead asks createSession to create
			//     the worktree (worktreeOpts) — a different, double-creating strategy.
			//   • Dropped fields: rolePrompt (resolved template text), workflowContext,
			//     sandboxBaseBranch and `sandboxed` are goal-specific and absent from
			//     SpawnOpts; the live `session` object and its event subscription below
			//     are needed back, not just a ChildHandle.
			// The core still OWNS tracking/lifecycle/reap for this child via
			// registerChild: it is keyed on the team-lead in the shared index, so the
			// unified orchestration verbs, archive cascade-reap and restart rebuild all
			// cover it. Team children are nudged on restart by team-manager (the core's
			// reminder filters childKind!=="team").
			if (entry.teamLeadSessionId) {
				try {
					this.config.orchestrationCore?.registerChild({
						sessionId: session.id,
						ownerSessionId: entry.teamLeadSessionId,
						childKind: "team",
						title: this.sessionManager.getSession(session.id)?.title,
					});
				} catch (err) {
					console.warn(`[team-manager] OrchestrationCore.registerChild failed for ${session.id}:`, err);
				}
			}

			// Enrich task prompt with upstream dependency context if available
			const enrichedTask = workflowContext ? task + workflowContext : task;

			// Send the team lead's task as the first prompt.
			const ownerAuthor = entry.teamLeadSessionId
				? this.sessionManager.resolveSessionAgentAuthor(entry.teamLeadSessionId)
				: undefined;
			this.sessionManager.enqueuePrompt(session.id, enrichedTask, {
				source: "agent",
				author: ownerAuthor,
			}).catch((err: any) => {
				console.error('[team-manager] Failed to send task prompt:', err);
			});

			// Subscribe to worker events to steer the team lead when the worker goes idle
			agent.unsubscribeEvent = this.subscribeWorkerEvents(
				goalId, session.id, role, agentId, session.rpcClient,
				{ broadcastFinished: true, roleName },
			);

			console.log(
				`[team-manager] Spawned ${role} agent (${session.id}) for goal "${goal.title}" — cwd: ${agentCwd}`,
			);

			// Broadcast team agent spawned event
			this.config.broadcastToGoal?.(goalId, {
				type: "team_agent_spawned", goalId, sessionId: session.id, role, name: roleName,
			});

			return { sessionId: session.id, worktreePath: worktreeResult?.worktreePath };
		} catch (err) {
			// Clean up the orphaned worktree on failure (only if one was created)
			if (worktreeResult && goal.repoPath) {
				try {
					await cleanupWorktree(goal.repoPath, worktreeResult.worktreePath, branchName, true);
					console.log(`[team-manager] Cleaned up orphaned worktree after spawnRole failure: ${worktreeResult.worktreePath}`);
				} catch (cleanupErr) {
					console.error(`[team-manager] Failed to clean up orphaned worktree ${worktreeResult.worktreePath}:`, cleanupErr);
				}
			}
			throw err;
		}
	}

	/**
	 * Notify the team lead that a worker agent has gone idle.
	 * Sends a steer message with task context so the team lead can decide next steps.
	 */
	private async notifyTeamLead(goalId: string, workerSessionId: string, role: string, agentId: string): Promise<void> {
		const entry = this.teams.get(goalId);
		if (!entry?.teamLeadSessionId) return;

		// Defensive guard: never nudge the team lead about a verification reviewer session.
		// Reviewer sessions managed by VerificationHarness have kind="reviewer"; legacy
		// pre-kind reviewer records carry an in-memory marker from restore.
		const firingAgent = entry.agents.find((a) => a.sessionId === workerSessionId);
		if (firingAgent && this.isVerificationReviewerAgent(firingAgent)) {
			return;
		}

		const teamLeadSession = this.sessionManager.getSession(entry.teamLeadSessionId);
		if (!teamLeadSession || teamLeadSession.status === "terminated") return;
		if (this.recoverErroredIdleSessionBeforeNudge(goalId, entry.teamLeadSessionId, "Worker-idle notification")) return;

		// Debounce: skip if we notified about this worker in the last 30 seconds
		const now = this.clock.now();
		const lastNotify = this.lastNotifyTime.get(workerSessionId);
		if (lastNotify && now - lastNotify < 30_000) {
			console.log(`[team-manager] notifyTeamLead deferred for ${role}/${agentId} — ${now - lastNotify}ms ago`);
			return;
		}
		this.lastNotifyTime.set(workerSessionId, now);

		// Look up tasks assigned to the worker
		const tasks = this.resolveTasksForSession(goalId, workerSessionId);

		let message: string;
		if (tasks.length > 0) {
			const heading = tasks.every(t => t.state === "complete") ? "Task complete" : "Agent finished";
			const taskSummaries = tasks.map(t => `**${t.title}** (\`${t.state}\`)`).join("; ");
			const resultSummary = tasks.map(t => t.resultSummary?.trim()).filter(Boolean).join(" ");
			const result = resultSummary ? splitWorkerResultSummary(resultSummary) : undefined;
			const lines = [
				`**${heading}**`,
				"",
				`- **Agent:** \`${agentId}\` (\`${role}\`)`,
				`- **Task:** ${taskSummaries}`,
			];
			if (result?.summary) lines.push(`- **Result:** ${result.summary}`);
			if (result?.branch) lines.push(`- **Branch:** \`${result.branch}\`${result.commit ? ` @ \`${result.commit.slice(0, 8)}\`` : ""}`);
			if (result?.checks) lines.push(`- **Checks:** ${result.checks}`);
			lines.push("- **Next:** `task_list`, then review task and decide next step.");
			message = lines.join("\n");
		} else {
			message = `**Agent finished**\n\n- **Agent:** \`${agentId}\` (\`${role}\`)\n- **Task:** no assigned tasks\n- **Next:** \`task_list\`, then review tasks and decide next step.`;
		}

		try {
			if (teamLeadSession.status === "streaming") {
				// Mid-turn: inject directly as a real-time steer interrupt
				await this.sessionManager.deliverLiveSteer(entry.teamLeadSessionId, message, { source: "auto-nudge" });
			} else {
				// Idle: enqueue as a steered prompt so it drains immediately
				this.sessionManager.enqueuePrompt(entry.teamLeadSessionId, message, { isSteered: true, source: "auto-nudge" });
			}
			// The full message body (agent completion summary) is already visible in
			// the UI transcript — log only a concise reference here.
			console.log(`[team-manager] Notified team lead for goal ${goalId} (status=${teamLeadSession.status}, ${message.length} chars)`);
		} catch (err) {
			console.error(`[team-manager] Failed to notify team lead for goal ${goalId}:`, err);
		}
	}

	/**
	 * Notify the team lead when a task transitions to a terminal state.
	 * Called from the task transition REST endpoint so the team lead wakes up
	 * even if the worker continues with another task without going idle.
	 */
	/**
	 * Notify the team lead that the goal's spec has been edited mid-flight.
	 * The agent read the spec once at session startup; this nudge tells it to
	 * re-read via `view_goal_spec` and decide whether the change affects the
	 * plan. Throttled to one nudge per SPEC_NUDGE_THROTTLE_MS so a flurry of
	 * edits doesn't spam the agent.
	 */
	notifyTeamLeadOfSpecChange(goalId: string, prevLen: number, newLen: number): void {
		const entry = this.teams.get(goalId);
		if (!entry?.teamLeadSessionId) return;

		const teamLeadSession = this.sessionManager.getSession(entry.teamLeadSessionId);
		if (!teamLeadSession || teamLeadSession.status === "terminated") return;

		const now = this.clock.now();
		const last = this.lastSpecNudgeTs.get(goalId) ?? 0;
		if (now - last < TeamManager.SPEC_NUDGE_THROTTLE_MS) {
			console.log(`[team-manager] Skipping spec-edit nudge for goal ${goalId} (throttled, last ${now - last}ms ago)`);
			return;
		}
		this.lastSpecNudgeTs.set(goalId, now);

		const message =
			`**Your goal's spec has been edited** (length changed from ${prevLen} to ${newLen} chars). ` +
			`The change has NOT been re-injected into your system prompt — re-read the latest spec via ` +
			`\`view_goal_spec\` (or \`GET /api/goals/${goalId}\`) to see what changed, then decide whether the new ` +
			`content changes your plan, requires new tasks, or invalidates an upstream gate signal.`;

		if (teamLeadSession.status === "streaming") {
			this.sessionManager.deliverLiveSteer(entry.teamLeadSessionId, message, { source: "system" }).catch((err: any) => {
				console.error(`[team-manager] Failed to steer team lead on spec change for goal ${goalId}:`, err);
			});
		} else {
			this.sessionManager.enqueuePrompt(entry.teamLeadSessionId, message, { isSteered: true, source: "system" });
		}
		if (process.env.BOBBIT_DEBUG) console.log(`[team-manager] Notified team lead of spec change for goal ${goalId} (${prevLen} → ${newLen} chars)`);
	}

	notifyTeamLeadOfTaskCompletion(goalId: string, taskTitle: string, taskState: string): void {
		const entry = this.teams.get(goalId);
		if (!entry?.teamLeadSessionId) return;

		const teamLeadSession = this.sessionManager.getSession(entry.teamLeadSessionId);
		if (!teamLeadSession || teamLeadSession.status === "terminated") return;

		const message = `Task "${taskTitle}" transitioned to ${taskState}. Use task_list for result summaries and gate_status for verification details.`;

		if (teamLeadSession.status === "streaming") {
			this.sessionManager.deliverLiveSteer(entry.teamLeadSessionId, message, { source: "task-notification" }).catch((err: any) => {
				console.error(`[team-manager] Failed to steer team lead on task completion for goal ${goalId}:`, err);
			});
		} else {
			this.sessionManager.enqueuePrompt(entry.teamLeadSessionId, message, { isSteered: true, source: "task-notification" });
		}
		if (process.env.BOBBIT_DEBUG) console.log(`[team-manager] Notified team lead of task completion for goal ${goalId}: ${taskTitle} → ${taskState}`);
	}

	/**
	 * Dismiss (terminate) a role agent session and clean up its worktree.
	 */
	async dismissRole(sessionId: string): Promise<DismissResult> {
		const goalId = this.sessionToGoal.get(sessionId);
		if (!goalId) {
			return this.classifyUntrackedDismiss(undefined, sessionId);
		}
		return this.dismissRoleForGoal(goalId, sessionId);
	}

	/** Dismiss a role agent for a specific goal, preserving structured authz/not-found outcomes. */
	async dismissRoleForGoal(goalId: string, sessionId: string): Promise<DismissResult> {
		return this.runDismissLocked(sessionId, () => this.dismissRoleForGoalLocked(goalId, sessionId));
	}

	private async runDismissLocked<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
		for (;;) {
			const previous = this.dismissLocks.get(sessionId);
			if (!previous) break;
			await previous.catch(() => undefined);
		}

		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		this.dismissLocks.set(sessionId, current);
		try {
			return await action();
		} finally {
			if (this.dismissLocks.get(sessionId) === current) {
				this.dismissLocks.delete(sessionId);
			}
			release();
		}
	}

	private async dismissRoleForGoalLocked(goalId: string, sessionId: string): Promise<DismissResult> {
		const mappedGoalId = this.sessionToGoal.get(sessionId);
		if (mappedGoalId && mappedGoalId !== goalId) {
			return { ok: false, status: "not-owned", sessionId, message: `Team agent ${sessionId} belongs to a different goal.`, retryable: false };
		}

		const entry = this.teams.get(goalId);
		if (!entry) {
			return this.classifyUntrackedDismiss(goalId, sessionId);
		}

		// Don't allow dismissing the team lead via this method.
		if (entry.teamLeadSessionId === sessionId) {
			return { ok: false, status: "not-owned", sessionId, message: "Cannot dismiss the team lead — use completeTeam() instead.", retryable: false };
		}

		const agentIndex = entry.agents.findIndex((a) => a.sessionId === sessionId);
		if (agentIndex === -1) {
			return this.classifyUntrackedDismiss(goalId, sessionId);
		}

		const agent = entry.agents[agentIndex];

		// Stamp durable ownership before terminal/archive cleanup. Duplicate dismiss
		// classification cannot rely on sessionToGoal because successful dismiss
		// removes that live index below.
		this.sessionManager.updateSessionMeta(sessionId, {
			role: agent.role,
			teamGoalId: goalId,
			teamLeadSessionId: entry.teamLeadSessionId ?? undefined,
		} as any);

		// Forget the worker from the OrchestrationCore runtime index (goal adapter).
		try { this.config.orchestrationCore?.forgetChild(sessionId); } catch { /* best-effort */ }

		// Unsubscribe from agent_end events before terminating
		if (agent.unsubscribeEvent) {
			agent.unsubscribeEvent();
		}

		// Persist repoPath and branch before archiving so worktree can be cleaned up later
		const goal = this.resolveGoal(goalId);
		if (goal?.repoPath && agent.worktreePath) {
			this.sessionManager.updateSessionMeta(sessionId, {
				worktreePath: agent.worktreePath,
				teamGoalId: goalId,
			} as any);
			// Store repoPath and branch in the session store for later purge cleanup
			const projectCtx = goalId && this.config.projectContextManager
				? this.config.projectContextManager.getContextForGoal(goalId)
				: null;
			if (projectCtx) {
				projectCtx.sessionStore.update(sessionId, { repoPath: goal.repoPath, branch: agent.branch, teamGoalId: goalId } as any);
			}
		}

		let terminated = false;
		try {
			(this.sessionManager as any).markChildTerminal?.(sessionId);
		} catch (err) {
			console.error(`[team-manager] markChildTerminal failed for ${sessionId}:`, err);
		}
		try {
			terminated = await this.sessionManager.terminateSession(sessionId);
		} catch (err) {
			return { ok: false, status: "failed", sessionId, message: `Failed to dismiss team agent ${sessionId}: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
		}

		// Worktree is preserved for archived session review — cleanup happens at purge time

		// Remove from tracking. Re-find by sessionId after awaits so a duplicate or
		// external cleanup cannot make us splice a stale index and remove another agent.
		const removalIndex = entry.agents.findIndex((a) => a.sessionId === sessionId);
		if (removalIndex === -1) {
			this.dismissedSessionToGoal.set(sessionId, goalId);
			return this.classifyUntrackedDismiss(goalId, sessionId);
		}
		entry.agents.splice(removalIndex, 1);
		this.dismissedSessionToGoal.set(sessionId, goalId);
		this.sessionToGoal.delete(sessionId);
		this.lastNotifyTime.delete(sessionId);
		// Cancel any pending idle-notify timer so no nudge fires against the
		// torn-down session.
		const pending = this.pendingIdleNotify.get(sessionId);
		if (pending) {
			this.clock.clearTimeout(pending);
			this.pendingIdleNotify.delete(sessionId);
		}
		this.persistEntry(goalId);

		// If no workers remain and team lead is idle, restart timers so the
		// 5-minute no-workers nudge fires from this point.
		if (entry.agents.length === 0) {
			const tlSession = entry.teamLeadSessionId
				? this.sessionManager.getSession(entry.teamLeadSessionId)
				: null;
			if (tlSession && tlSession.status === "idle") {
				this.startIdleNudgeTimer(goalId);
			} else {
				this.clearIdleNudgeTimer(goalId);
			}
		}

		console.log(`[team-manager] Dismissed ${agent.role} agent (${sessionId}) for goal ${goalId}`);

		// Broadcast team agent dismissed event
		const sessionMeta = this.sessionManager.getSession(sessionId);
		const dismissedName = sessionMeta?.title || `${agent.role}-${sessionId.slice(0, 8)}`;
		this.config.broadcastToGoal?.(goalId, {
			type: "team_agent_dismissed", goalId, sessionId, role: agent.role, name: dismissedName,
		});

		return terminated
			? { ok: true, status: "dismissed", sessionId, message: `Team agent ${sessionId} dismissed.`, retryable: false }
			: { ok: true, status: "already-dismissed", sessionId, message: `Team agent ${sessionId} is already dismissed.`, retryable: false };
	}

	private classifyUntrackedDismiss(goalId: string | undefined, sessionId: string): DismissResult {
		const live = this.sessionManager.getSession(sessionId) as any;
		const persisted = (this.sessionManager as any).getPersistedSession?.(sessionId) as any;
		const rememberedGoalId = this.dismissedSessionToGoal.get(sessionId);
		const teamGoalId = live?.teamGoalId ?? persisted?.teamGoalId ?? rememberedGoalId;
		if (goalId && teamGoalId === goalId) {
			return { ok: true, status: "already-dismissed", sessionId, message: `Team agent ${sessionId} is already dismissed.`, retryable: false };
		}
		if (teamGoalId && (!goalId || teamGoalId !== goalId)) {
			return { ok: false, status: "not-owned", sessionId, message: `Team agent ${sessionId} belongs to a different goal.`, retryable: false };
		}
		if (live || persisted) {
			return { ok: false, status: "not-owned", sessionId, message: `Session ${sessionId} is not a team agent for this goal.`, retryable: false };
		}
		return { ok: false, status: "not-found", sessionId, message: `Team agent ${sessionId} was not found.`, retryable: false };
	}

	/**
	 * Register a verification reviewer session as a team agent without creating a worktree.
	 * The verification harness manages the session lifecycle — no agent_end subscription is needed.
	 * Silently returns if no team exists for the goal (handles manual gate signals).
	 */
	registerReviewerSession(goalId: string, sessionId: string, stepName: string): void {
		const entry = this.teams.get(goalId);
		if (!entry) return; // No active team — skip registration silently

		const agent: TeamAgent = {
			sessionId,
			role: 'reviewer',
			kind: "reviewer",
			worktreePath: undefined,
			branch: undefined,
			task: `Verification review: ${stepName}`,
			createdAt: this.clock.now(),
		};
		entry.agents.push(agent);
		this.sessionToGoal.set(sessionId, goalId);
		this.sessionManager.updateSessionMeta(sessionId, {
			role: agent.role,
			teamGoalId: goalId,
			teamLeadSessionId: entry.teamLeadSessionId ?? undefined,
		} as any);
		this.assignUniqueColor(sessionId);
		this.persistEntry(goalId);
	}

	/**
	 * Unregister a verification reviewer session from the team.
	 * Called after the session is terminated so archiving happens first.
	 */
	unregisterReviewerSession(goalId: string, sessionId: string): void {
		const entry = this.teams.get(goalId);
		if (!entry) return;

		const idx = entry.agents.findIndex(a => a.sessionId === sessionId);
		if (idx !== -1) {
			const agent = entry.agents[idx];
			if (agent.unsubscribeEvent) agent.unsubscribeEvent();
			entry.agents.splice(idx, 1);
		}
		this.sessionToGoal.delete(sessionId);
		this.persistEntry(goalId);
	}

	/**
	 * List all active agents for a goal.
	 */
	listAgents(goalId: string): TeamAgentInfo[] {
		const entry = this.teams.get(goalId);
		if (!entry) {
			return [];
		}

		return entry.agents.map((agent) => {
			const session = this.sessionManager.getSession(agent.sessionId);
			return {
				sessionId: agent.sessionId,
				role: agent.role,
				status: session?.status ?? "terminated",
				worktreePath: agent.worktreePath,
				branch: agent.branch,
				task: agent.task,
				createdAt: agent.createdAt,
			};
		});
	}

	/**
	 * Find a team agent by session ID across all goals.
	 * Returns the TeamAgent record if found, undefined otherwise.
	 */
	findAgentBySessionId(sessionId: string): TeamAgent | undefined {
		const goalId = this.sessionToGoal.get(sessionId);
		if (!goalId) return undefined;
		const entry = this.teams.get(goalId);
		if (!entry) return undefined;
		return entry.agents.find(a => a.sessionId === sessionId);
	}

	/** Re-read workflow truth and reject completion while any required gate is unresolved. */
	private validateCompletionGates(goalId: string, opts?: { allowBypassedGates?: boolean }): PersistedGoal | undefined {
		const goal = this.resolveGoal(goalId);
		const gateStore = this.resolveGateStore(goalId);
		const skipReqs = goal?.skipGateRequirements;
		if (!goal?.workflow || !gateStore || skipReqs?.includes("workflow")) return goal;

		const gateStates = gateStore.getGatesForGoal(goalId);
		const statusById = new Map(gateStates.map(g => [g.gateId, g.status]));
		const isResolved = (id: string) => statusById.get(id) === "passed" || statusById.get(id) === "bypassed";
		const failedGates = goal.workflow.gates.filter(g => !isResolved(g.id));
		if (failedGates.length > 0) {
			throw new Error(`Cannot complete: gates not passed: ${failedGates.map(g => g.name).join(", ")}`);
		}
		const bypassedGates = goal.workflow.gates.filter(g => statusById.get(g.id) === "bypassed");
		if (bypassedGates.length > 0 && !opts?.allowBypassedGates) {
			throw new Error(`Cannot complete: ${bypassedGates.length} gate(s) were bypassed and require human confirmation`);
		}
		return goal;
	}

	/**
	 * Rearm the existing team lead after a completed goal is explicitly reopened.
	 * The caller owns the persisted `complete` → `in-progress` transition; this
	 * method only restores runtime subscriptions and base-delay nudge timers.
	 * Returns true only when this call completed the rearm. Failed attempts return
	 * false and remain retryable; calls after a successful rearm are idempotent.
	 */
	reopenCompletedTeam(goalId: string): boolean {
		if (this.rearmedCompletedTeams.has(goalId)) return false;

		const entry = this.teams.get(goalId);
		if (!entry?.teamLeadSessionId) return false;
		const goal = this.resolveGoal(goalId);
		if (!goal || goal.state !== "in-progress" || goal.archived || goal.paused) return false;

		const lead = this.sessionManager.getSession(entry.teamLeadSessionId);
		if (!lead || lead.status === "terminated") return false;

		// Completion removes the lead subscription and clears its timers, but idle
		// and stuck-nudge timestamps can survive. Reset all completion-era runtime
		// state so this is a fresh base-delay cycle, then replace the subscription.
		this.clearIdleNudgeTimer(goalId);
		this.leadIdleSinceByGoal.delete(goalId);
		this.lastNudgeAtPerGoal.delete(goalId);
		if (!this.subscribeTeamLeadEvents(goalId)) return false;
		if (lead.status === "idle") this.startIdleNudgeTimer(goalId);

		this.rearmedCompletedTeams.add(goalId);
		console.log(`[team-manager] Rearmed completed team for reopened goal ${goalId}; team lead remains ${entry.teamLeadSessionId}`);
		return true;
	}

	/**
	 * Complete a team: dismiss all role agents but keep the team lead alive.
	 * The team lead remains active to await further instructions.
	 */
	async completeTeam(goalId: string, opts?: { allowBypassedGates?: boolean }): Promise<void> {
		const entry = this.teams.get(goalId);
		if (!entry) {
			throw new Error(`No active team for goal: ${goalId}`);
		}

		// Cancel any in-flight verifications before completing — prevents zombie reviewers
		if (this.verificationHarness) {
			await this.verificationHarness.cancelAllVerifications(goalId);
		}

		// Enforce gate requirements before allowing completion.
		let goal = this.validateCompletionGates(goalId, opts);

		// Cancel idle-nudge timer and unsubscribe from team lead events. A new
		// completion attempt invalidates any earlier reopen idempotency marker.
		this.rearmedCompletedTeams.delete(goalId);
		this.clearIdleNudgeTimer(goalId);
		entry.unsubscribeTeamLeadEvents?.();
		entry.unsubscribeTeamLeadEvents = undefined;

		// Dismiss all role agents
		const agentSessionIds = entry.agents.map((a) => a.sessionId);
		for (const sessionId of agentSessionIds) {
			try {
				await this.dismissRole(sessionId);
			} catch (err) {
				console.error(`[team-manager] Error dismissing agent ${sessionId} during team completion:`, err);
			}
		}

		// Keep the team lead session alive — do NOT terminate it.
		// The team lead will await further instructions.

		// Worker dismissal awaits above allow a gate reset to interleave after the
		// first validation. Re-read workflow truth immediately before committing the
		// completed state. If reset won the race, restore the lead runtime and leave
		// the goal in progress rather than persisting complete with unresolved gates.
		try {
			goal = this.validateCompletionGates(goalId, opts);
		} catch (err) {
			const rearmed = this.reopenCompletedTeam(goalId);
			if (!rearmed) {
				console.warn(`[team-manager] Completion aborted for goal ${goalId}, but its team lead runtime could not be rearmed; a later reopen may retry`);
			}
			throw err;
		}
		await this.resolveGoalManager(goalId).updateGoal(goalId, { state: "complete" });
		this.rearmedCompletedTeams.delete(goalId);

		// Notify parent team lead when a child goal completes, regardless of workflow shape.
		// This ensures the parent is woken up even if the child's workflow has no
		// ready-to-merge gate (which is the only prior notification path).
		try {
			const parentNotify = buildParentCompletionNotification(goal ?? undefined);
			if (parentNotify) {
				const parentEntry = this.teams.get(parentNotify.parentGoalId);
				if (parentEntry?.teamLeadSessionId) {
					const parentLeadSession = this.sessionManager.getSession(parentEntry.teamLeadSessionId);
					if (parentLeadSession && parentLeadSession.status !== "terminated") {
						if (parentLeadSession.status === "streaming") {
							this.sessionManager.deliverLiveSteer(parentEntry.teamLeadSessionId, parentNotify.message, { source: "child-complete" }).catch((e: any) => {
								console.error("[team-manager] Failed to steer parent team-lead on child completion:", e);
							});
						} else {
							this.sessionManager.enqueuePrompt(parentEntry.teamLeadSessionId, parentNotify.message, { isSteered: true, source: "child-complete" });
						}
						console.log(`[team-manager] Notified parent team-lead (goal ${parentNotify.parentGoalId}) that child ${goalId} completed`);
					}
				}
			}
		} catch (err) {
			console.warn("[team-manager] Failed to notify parent team-lead on child goal completion:", err);
		}

		// Keep team tracking alive so the team lead can still be found
		// but persist the updated state (agents cleared)
		this.persistEntry(goalId);

		console.log(`[team-manager] Completed team for goal ${goalId} — team lead remains active: ${entry.teamLeadSessionId}`);
	}

	/**
	 * Fully tear down a team: dismiss all agents AND terminate the team lead.
	 * Use this when explicitly shutting down everything.
	 */
	async teardownTeam(goalId: string): Promise<void> {
		const entry = this.teams.get(goalId);
		if (!entry) {
			throw new Error(`No active team for goal: ${goalId}`);
		}

		// Cancel any in-flight verifications before teardown — prevents zombie reviewers
		if (this.verificationHarness) {
			await this.verificationHarness.cancelAllVerifications(goalId);
		}

		// Cancel idle-nudge timer and unsubscribe from team lead events
		this.clearIdleNudgeTimer(goalId);
		entry.unsubscribeTeamLeadEvents?.();

		// Dismiss all role agents
		const agentSessionIds = entry.agents.map((a) => a.sessionId);
		for (const sessionId of agentSessionIds) {
			try {
				await this.dismissRole(sessionId);
			} catch (err) {
				console.error(`[team-manager] Error dismissing agent ${sessionId} during team teardown:`, err);
			}
		}

		// Terminate the team lead session — persist worktree info first so purge can clean up
		if (entry.teamLeadSessionId) {
			const goal = this.resolveGoal(goalId);
			if (goal?.repoPath) {
				const projectCtx = this.config.projectContextManager
					? this.config.projectContextManager.getContextForGoal(goalId)
					: null;
				if (projectCtx) {
					projectCtx.sessionStore.update(entry.teamLeadSessionId, {
						repoPath: goal.repoPath,
						branch: goal.branch,
						worktreePath: goal.worktreePath,
					});
				}
			}
			try {
				await this.sessionManager.terminateSession(entry.teamLeadSessionId);
			} catch (err) {
				console.error(`[team-manager] Error terminating team lead ${entry.teamLeadSessionId}:`, err);
			}
			this.sessionToGoal.delete(entry.teamLeadSessionId);
		}

		// Remove team tracking entirely
		this.teams.delete(goalId);
		this.leadIdleSinceByGoal.delete(goalId);
		this.lastNudgeAtPerGoal.delete(goalId);
		this.rearmedCompletedTeams.delete(goalId);
		this.resolveTeamStore(goalId).remove(goalId);

		console.log(`[team-manager] Tore down team for goal ${goalId}`);
	}

	/**
	 * Get the full team state for a goal.
	 */
	getTeamState(goalId: string): TeamState | undefined {
		const entry = this.teams.get(goalId);
		if (!entry) {
			return undefined;
		}

		return {
			goalId: entry.goalId,
			teamLeadSessionId: entry.teamLeadSessionId,
			agents: this.listAgents(goalId),
			maxConcurrent: entry.maxConcurrent,
		};
	}
}
