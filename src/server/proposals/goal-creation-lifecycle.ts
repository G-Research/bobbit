import type { PersistedGoal } from "../agent/goal-store.js";

export type GoalCreationContext = {
	goalManager: {
		getGoal(id: string): PersistedGoal | undefined;
		updateGoal(id: string, updates: { state?: PersistedGoal["state"] }): void;
		setupWorktree(goalId: string): Promise<void>;
		setupWorktreeAndStartTeam(goalId: string, startTeam: () => Promise<unknown>): Promise<void>;
	};
};

export type GoalCreationLifecycleDeps = {
	getContextForGoal(goalId: string): GoalCreationContext | undefined;
	getContext(projectId: string): GoalCreationContext | undefined;
	requestChildStart(goalId: string): "capacity-blocked" | string;
	startTeam(goalId: string): Promise<unknown>;
	broadcast(message: { type: "goal_setup_complete"; goalId: string } | { type: "goal_setup_error"; goalId: string; error: string } | { type: "goal_state_changed"; goalId: string }): void;
	logLifecycleSchedulingError(error: unknown): void;
};

/**
 * The public goal route and import-proposal replay both create durable goals.
 * Keep their asynchronous setup behavior in one owner so neither route can
 * accidentally report a failed team start after the worktree is ready.
 */
export function createGoalCreationLifecycle(deps: GoalCreationLifecycleDeps): {
	onAfterCreateError(error: unknown, goal: PersistedGoal): void;
	afterCreate(goal: PersistedGoal, parentGoalId?: string): void;
} {
	return {
		onAfterCreateError(error, goal) {
			deps.logLifecycleSchedulingError(error);
			deps.broadcast({ type: "goal_setup_error", goalId: goal.id, error: String(error) });
		},
		afterCreate(goal, parentGoalId) {
			const context = deps.getContextForGoal(goal.id) ?? (goal.projectId ? deps.getContext(goal.projectId) : undefined);
			if (!context) throw new Error(`Goal project context is unavailable for ${goal.id}`);

			if (goal.autoStartTeam && parentGoalId) {
				if (goal.state !== "blocked" && deps.requestChildStart(goal.id) === "capacity-blocked") {
					context.goalManager.updateGoal(goal.id, { state: "blocked" });
					deps.broadcast({ type: "goal_state_changed", goalId: goal.id });
				}
				return;
			}
			if (goal.setupStatus !== "preparing") return;

			const complete = () => deps.broadcast({ type: "goal_setup_complete", goalId: goal.id });
			const failed = (error: unknown) => deps.broadcast({ type: "goal_setup_error", goalId: goal.id, error: String(error) });
			if (!goal.autoStartTeam) {
				void context.goalManager.setupWorktree(goal.id).then(complete).catch(failed);
				return;
			}
			void context.goalManager.setupWorktreeAndStartTeam(goal.id, () => deps.startTeam(goal.id)).then(complete).catch(error => {
				if (context.goalManager.getGoal(goal.id)?.setupStatus === "ready") {
					complete();
					console.error("[goal] Auto-start team failed (worktree ready):", error);
				} else {
					failed(error);
				}
			});
		},
	};
}
