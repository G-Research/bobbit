/**
 * Wire mission-orchestration hooks onto a freshly-built (or freshly-fetched)
 * `ProjectContext`. Idempotent: replaces any existing onStatusChange /
 * onIndexUpdate / wakeCommander wiring with the canonical mission-aware
 * version.
 *
 * The hook chain that drives the live "approve plan → child spawns" flow:
 *   1. The user clicks Approve plan, the verification harness signals
 *      `goal-plan` and calls `gateStore.updateGateStatusFor("mission", id,
 *      "goal-plan", "passed")`.
 *   2. That fires `onStatusChange("mission", id, "goal-plan")`.
 *   3. This module's hook auto-freezes the plan (`MissionManager.freezePlan`)
 *      then calls `MissionScheduler.tickMission(id)`.
 *   4. `tickMission` computes the ready set and spawns child goals.
 *
 * Lives in its own file (separate from `server.ts`) so unit/integration tests
 * can wire the same hooks against an in-memory `ProjectContext` without
 * dragging the entire HTTP handler in.
 */

import type { ProjectContext } from "./project-context.js";

/** Subset of `SessionManager` used by the mission hooks. */
export interface MissionHookSessionManager {
	enqueuePrompt(id: string, text: string, opts?: { isSteered?: boolean }): Promise<void> | void;
}

/** Pluggable broadcast — wraps the gateway's `broadcastToAll`. */
export type MissionHookBroadcast = (msg: any) => void;

/**
 * Subset of `TeamManager` + `GoalManager` needed to drive a mission-spawned
 * child goal's worktree setup + team-lead session start. Server passes in
 * closures over the real instances; tests can pass mocks. When omitted,
 * mission children are created but no team-lead spawns — they sit in `todo`.
 */
export interface MissionHookTeamStarter {
	setupWorktreeAndStartTeam(goalId: string, startTeamFn: () => Promise<any>): Promise<void>;
	startTeamForGoal(goalId: string): Promise<unknown>;
}

/**
 * Wire mission hooks. Safe to call repeatedly on the same context.
 * Replaces any previous hooks; preserves search-index hooks via chaining.
 */
export function wireMissionHooks(
	ctx: ProjectContext | null | undefined,
	sessionManager: MissionHookSessionManager,
	broadcastToAll: MissionHookBroadcast,
	teamStarter?: MissionHookTeamStarter,
): void {
	if (!ctx) return;
	const pc = ctx;

	pc.gateStore.onStatusChange = (kind, ownerId, gateId) => {
		pc.goalStore.bumpGeneration();
		if (kind === "mission") {
			// Auto-freeze the plan when goal-plan passes (propose-and-wait gate).
			if (gateId === "goal-plan") {
				const gs = pc.gateStore.getGateFor("mission", ownerId, "goal-plan");
				if (gs?.status === "passed") {
					const m = pc.missionStore.get(ownerId);
					if (m && !m.planFrozenAt && m.plan) {
						try {
							pc.missionManager.freezePlan(ownerId);
							broadcastToAll({ type: "mission_plan_frozen", missionId: ownerId });
						} catch (err) {
							console.error("[mission] freezePlan after goal-plan pass failed", err);
						}
					}
				}
			}
			pc.missionScheduler.tickMission(ownerId).catch(err =>
				console.error(`[mission] tickMission(${ownerId}) failed:`, err));
		} else {
			// Goal-owned gate — if the goal belongs to a mission, tick it.
			const goal = pc.goalStore.get(ownerId);
			if (goal?.missionId) {
				pc.missionScheduler.tickMission(goal.missionId).catch(err =>
					console.error(`[mission] tickMission(${goal.missionId}) failed:`, err));
			}
		}
	};

	const prevGoalIndexUpdate = pc.goalStore.onIndexUpdate;
	pc.goalStore.onIndexUpdate = (goal) => {
		prevGoalIndexUpdate?.(goal);
		if (goal.missionId) {
			pc.missionScheduler.tickMission(goal.missionId).catch(err =>
				console.error(`[mission] tickMission(${goal.missionId}) failed:`, err));
		}
	};

	// Wire team-lead startup for mission-spawned child goals. Without this
	// the goal sits at `state: todo` with `teamLeadSessionId: null` forever.
	// Idempotent — setTeamStarter just overwrites the deps fields.
	if (teamStarter) {
		pc.missionManager.setTeamStarter({
			setupWorktreeAndStartTeam: teamStarter.setupWorktreeAndStartTeam.bind(teamStarter),
			startTeamForGoal: teamStarter.startTeamForGoal.bind(teamStarter),
			onChildTeamStarted: (goalId) => {
				try { broadcastToAll({ type: "goal_setup_complete", goalId }); } catch (err) {
					console.warn(`[mission] broadcast goal_setup_complete(${goalId}) failed:`, err);
				}
			},
			onChildTeamStartFailed: (goalId, err) => {
				try {
					broadcastToAll({
						type: "goal_setup_error",
						goalId,
						error: err.message ?? String(err),
					});
				} catch (cbErr) {
					console.warn(`[mission] broadcast goal_setup_error(${goalId}) failed:`, cbErr);
				}
			},
		});
	}

	pc.missionScheduler.setWakeCommander(async (sessionId, message) => {
		try {
			await sessionManager.enqueuePrompt(sessionId, message, { isSteered: true });
		} catch (err) {
			console.error(`[mission] wakeCommander(${sessionId}) failed:`, err);
		}
	});
}
