/**
 * Mission scheduler — event-driven loop that drives a mission forward.
 *
 * Owned by Coder C (Mission orchestration — Workflow + Scheduler + Git).
 * See `docs/design/mission-orchestration.md` §11.
 *
 * Responsibilities (per design):
 *   1. On every relevant event (gate pass/fail, goal state change,
 *      mission_resumed, periodic safety-net tick), recompute and act on
 *      the mission state.
 *   2. Mirror child goal states into plan nodes.
 *   3. Auto-merge children whose `ready-to-merge` gate has passed; broadcast
 *      conflicts (no auto-resolve — strict policy).
 *   4. Spawn ready nodes up to `maxConcurrentGoals - inFlight`.
 *   5. Wake the Commander when all children are merged.
 *
 * Idempotency:
 *   - Per-mission async lock prevents concurrent ticks for the same mission.
 *   - `spawnChild` is keyed on `(missionId, planId)` and is the
 *     MissionManager's responsibility to make idempotent (we just call it).
 *   - `mergeChild` detects already-merged in `MissionGit.mergeChild`.
 *   - Plan node state writes are diff-checked.
 *
 * This module deliberately keeps the manager-shape interfaces minimal — the
 * concrete `MissionManager` (Coder A) and `GoalManager` (existing) only need
 * to satisfy the small surface declared here.
 */

import type { GateState } from "./gate-store.js";
import type { GoalState, PersistedGoal } from "./goal-store.js";
import type { MergeResult } from "./mission-git.js";

// ---------------------------------------------------------------------------
// Local re-declaration of mission types
// ---------------------------------------------------------------------------
//
// We do not import from `mission-store.ts` (Coder A's file) — that lets this
// module compile and unit-test independently of the in-flight mission-store
// branch. The structural shapes match design §2.1.
// TODO(mission-core): once Coder A's mission-store.ts lands, replace these
// with `import type { ... } from "./mission-store.js"`.
// ---------------------------------------------------------------------------

export type MissionState =
	| "planning"
	| "in-progress"
	| "paused"
	| "complete"
	| "shelved"
	| "failed";

export interface PlannedGoalLite {
	planId: string;
	title: string;
	goalId?: string;
	state?: GoalState;
	spawnedAt?: number;
	completedAt?: number;
	mergedAt?: number;
	failedAttempts?: number;
}

export interface PlanEdgeLite {
	from: string;
	to: string;
}

export interface MissionPlanLite {
	goals: PlannedGoalLite[];
	dependencies: PlanEdgeLite[];
	version: number;
}

export interface MissionView {
	id: string;
	title: string;
	state: MissionState;
	maxConcurrentGoals: number;
	plan?: MissionPlanLite;
	planFrozenAt?: number;
	integrationBranch?: string;
	integrationWorktree?: string;
	commanderSessionId?: string;
	archived?: boolean;
}

// ---------------------------------------------------------------------------
// Dependency interfaces — implemented by other coders' modules.
// ---------------------------------------------------------------------------

/** Subset of `MissionManager` (Coder A) used by the scheduler. */
export interface SchedulerMissionManager {
	getMission(id: string): MissionView | undefined;
	listMissions(): MissionView[];
	updatePlanNodeState(
		missionId: string,
		planId: string,
		patch: Partial<PlannedGoalLite>,
	): boolean;
	/** Idempotent on (missionId, planId). May throw. */
	spawnChild(missionId: string, planId: string): Promise<PersistedGoal>;
	/** Drives MissionGit.mergeChild and writes mergedAt on success. */
	integrateChildForScheduler(missionId: string, planId: string): Promise<MergeResult>;
}

/** Subset of `GoalStore` (existing) used by the scheduler. */
export interface SchedulerGoalLookup {
	get(id: string): PersistedGoal | undefined;
}

/** Subset of `GateStore` used by the scheduler. */
export interface SchedulerGateLookup {
	/**
	 * Look up a gate state. The implementation is free to forward to the
	 * generalised `getGateFor(ownerKind, ownerId, gateId)` once Coder B's
	 * gate-store ownerKind work lands. Until then, the legacy
	 * `getGate(goalId, gateId)` works because every child goal of a mission
	 * still has its own goal-keyed gate records.
	 */
	getGate(ownerId: string, gateId: string): GateState | undefined;
}

export type SchedulerWsBroadcast = (msg: SchedulerWsMessage) => void;

export type SchedulerWsMessage =
	| { type: "mission_child_spawned"; missionId: string; planId: string; goalId: string }
	| { type: "mission_child_state_changed"; missionId: string; planId: string; goalId: string; state: GoalState }
	| { type: "mission_child_merged"; missionId: string; planId: string; goalId: string; mergeSha: string }
	| { type: "mission_child_merge_conflict"; missionId: string; planId: string; goalId: string; conflictFiles: string[] }
	| { type: "mission_execution_ready"; missionId: string };

export interface SchedulerLogger {
	info(msg: string, ...args: unknown[]): void;
	warn(msg: string, ...args: unknown[]): void;
	error(msg: string, ...args: unknown[]): void;
}

export interface MissionSchedulerDeps {
	missionManager: SchedulerMissionManager;
	goalStore: SchedulerGoalLookup;
	gateStore: SchedulerGateLookup;
	broadcast?: SchedulerWsBroadcast;
	logger?: SchedulerLogger;
	/** Wake the Commander session — supplied by the team manager. */
	wakeCommander?: (sessionId: string, message: string) => Promise<void> | void;
	/** Periodic tick interval in ms. Default 60_000. Set to 0 to disable. */
	tickIntervalMs?: number;
	/** Test seam — allows fake timers. */
	now?: () => number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Compute the set of plan nodes ready to spawn — every node that has not
 * been spawned yet AND whose direct dependencies are all merged.
 * Pure function; exposed for unit testing.
 */
export function computeReadySet(plan: MissionPlanLite): PlannedGoalLite[] {
	const result: PlannedGoalLite[] = [];
	const byId = new Map(plan.goals.map(g => [g.planId, g] as const));
	for (const node of plan.goals) {
		if (node.goalId) continue; // already spawned
		const deps = plan.dependencies
			.filter(e => e.to === node.planId)
			.map(e => e.from);
		const allMerged = deps.every(d => {
			const dep = byId.get(d);
			return dep && dep.mergedAt;
		});
		if (allMerged) result.push(node);
	}
	return result;
}

/** Count plan nodes that are spawned but not yet merged. */
export function countInFlight(plan: MissionPlanLite): number {
	let n = 0;
	for (const g of plan.goals) {
		if (g.goalId && !g.mergedAt) n++;
	}
	return n;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const DEFAULT_TICK_MS = 60_000;

const NULL_LOGGER: SchedulerLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

export class MissionScheduler {
	private readonly deps: MissionSchedulerDeps;
	private readonly logger: SchedulerLogger;
	private readonly broadcast: SchedulerWsBroadcast;
	private readonly tickIntervalMs: number;
	private readonly now: () => number;

	private readonly inflight = new Map<string, Promise<void>>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private started = false;

	constructor(deps: MissionSchedulerDeps) {
		this.deps = deps;
		this.logger = deps.logger ?? NULL_LOGGER;
		this.broadcast = deps.broadcast ?? (() => {});
		this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_MS;
		this.now = deps.now ?? (() => Date.now());
	}

	/** Start the periodic safety-net tick. Idempotent. */
	start(): void {
		if (this.started) return;
		this.started = true;
		if (this.tickIntervalMs > 0) {
			this.timer = setInterval(() => {
				this.tickAll().catch(err => this.logger.error("[scheduler] tickAll failed", err));
			}, this.tickIntervalMs);
			// Don't keep the event loop alive purely for the scheduler.
			if (typeof (this.timer as { unref?: () => void }).unref === "function") {
				(this.timer as { unref: () => void }).unref();
			}
		}
	}

	stop(): void {
		this.started = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Tick every live mission. Errors in one mission do not poison the others.
	 */
	async tickAll(): Promise<void> {
		const missions = this.deps.missionManager.listMissions();
		for (const m of missions) {
			if (m.archived) continue;
			if (m.state !== "planning" && m.state !== "in-progress") continue;
			try {
				await this.tickMission(m.id);
			} catch (err) {
				this.logger.error(`[scheduler] tick failed for mission ${m.id}`, err);
			}
		}
	}

	/**
	 * Tick a single mission. Re-entrant calls for the same mission are
	 * serialised via a per-mission async lock — see design §11.2.
	 */
	tickMission(missionId: string): Promise<void> {
		const prev = this.inflight.get(missionId);
		const next = (async () => {
			if (prev) {
				try { await prev; } catch { /* swallow upstream errors; we'll do our own work */ }
			}
			await this.doTick(missionId);
		})();
		this.inflight.set(missionId, next);
		return next.finally(() => {
			if (this.inflight.get(missionId) === next) {
				this.inflight.delete(missionId);
			}
		});
	}

	// -------------------------------------------------------------------------

	private async doTick(missionId: string): Promise<void> {
		const m = this.deps.missionManager.getMission(missionId);
		if (!m || m.archived) return;
		if (m.state === "paused" || m.state === "complete" || m.state === "failed" || m.state === "shelved") return;
		if (!m.plan || !m.planFrozenAt) return; // not yet approved

		// 1) Mirror child goal states into plan nodes.
		this.mirrorChildStates(m);

		// 2) Auto-merge children whose ready-to-merge has passed.
		await this.autoMergeReadyChildren(m);

		// Re-fetch — integrateChild may have updated mergedAt timestamps.
		const fresh = this.deps.missionManager.getMission(missionId);
		if (!fresh || !fresh.plan) return;

		// 3) Spawn ready nodes up to concurrency cap.
		await this.spawnReady(fresh);

		// 4) If every node is merged, signal the Commander to drive `execution`.
		const finalView = this.deps.missionManager.getMission(missionId);
		if (finalView?.plan && finalView.plan.goals.length > 0) {
			const allMerged = finalView.plan.goals.every(n => n.mergedAt);
			if (allMerged) {
				this.broadcast({ type: "mission_execution_ready", missionId });
				if (finalView.commanderSessionId && this.deps.wakeCommander) {
					try {
						await this.deps.wakeCommander(
							finalView.commanderSessionId,
							"All child goals are merged into the integration branch. Signal the `execution` mission gate.",
						);
					} catch (err) {
						this.logger.warn("[scheduler] wakeCommander failed", err);
					}
				}
			}
		}
	}

	private mirrorChildStates(m: MissionView): void {
		if (!m.plan) return;
		for (const node of m.plan.goals) {
			if (!node.goalId) continue;
			const goal = this.deps.goalStore.get(node.goalId);
			if (!goal) continue;
			if (goal.state !== node.state) {
				const updated = this.deps.missionManager.updatePlanNodeState(m.id, node.planId, {
					state: goal.state,
					...(goal.state === "complete" && !node.completedAt ? { completedAt: this.now() } : {}),
				});
				if (updated) {
					this.broadcast({
						type: "mission_child_state_changed",
						missionId: m.id,
						planId: node.planId,
						goalId: node.goalId,
						state: goal.state,
					});
				}
			}
		}
	}

	private async autoMergeReadyChildren(m: MissionView): Promise<void> {
		if (!m.plan) return;
		for (const node of m.plan.goals) {
			if (!node.goalId || node.mergedAt) continue;
			const rtm = this.deps.gateStore.getGate(node.goalId, "ready-to-merge");
			if (rtm?.status !== "passed") continue;

			let result: MergeResult;
			try {
				result = await this.deps.missionManager.integrateChildForScheduler(m.id, node.planId);
			} catch (err) {
				this.logger.warn(`[scheduler] integrateChild failed for plan ${node.planId}`, err);
				continue;
			}

			if (result.status === "merged") {
				this.broadcast({
					type: "mission_child_merged",
					missionId: m.id,
					planId: node.planId,
					goalId: node.goalId,
					mergeSha: result.mergeSha,
				});
			} else if (result.status === "conflict") {
				this.broadcast({
					type: "mission_child_merge_conflict",
					missionId: m.id,
					planId: node.planId,
					goalId: node.goalId,
					conflictFiles: result.conflictFiles,
				});
				// No auto-resolve under strict policy. Commander handles.
			}
			// already-merged → silent; mergedAt should already be set by manager.
		}
	}

	private async spawnReady(m: MissionView): Promise<void> {
		if (!m.plan) return;
		const inFlight = countInFlight(m.plan);
		const slots = Math.max(0, m.maxConcurrentGoals - inFlight);
		if (slots <= 0) return;

		const ready = computeReadySet(m.plan).slice(0, slots);
		for (const node of ready) {
			try {
				const goal = await this.deps.missionManager.spawnChild(m.id, node.planId);
				this.broadcast({
					type: "mission_child_spawned",
					missionId: m.id,
					planId: node.planId,
					goalId: goal.id,
				});
			} catch (err) {
				this.logger.warn(
					`[scheduler] spawnChild failed for mission=${m.id} plan=${node.planId}`,
					err,
				);
			}
		}
	}
}
