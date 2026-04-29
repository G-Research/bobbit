// Client-side mirrors of mission types defined in src/server/agent/mission-store.ts.
// Keep in sync with the server types — additive fields only.

import type { Goal, GoalState } from "./state.js";

export type MissionState =
	| "planning"
	| "in-progress"
	| "paused"
	| "complete"
	| "shelved"
	| "failed";

export type DivergencePolicy = "strict" | "balanced" | "autonomous";

export interface PlanEdge {
	from: string;
	to: string;
}

export interface PlannedGoal {
	planId: string;
	title: string;
	spec: string;
	workflowId: string;
	suggestedRole?: string;
	enabledOptionalSteps?: string[];
	goalId?: string;
	state?: GoalState;
	spawnedAt?: number;
	completedAt?: number;
	mergedAt?: number;
	failedAttempts?: number;
}

export interface MissionPlan {
	goals: PlannedGoal[];
	dependencies: PlanEdge[];
	rationale: string;
	estimatedConcurrency: number;
	version: number;
}

export interface PersistedMission {
	id: string;
	projectId: string;
	projects: string[];
	title: string;
	spec: string;
	state: MissionState;
	createdAt: number;
	updatedAt: number;
	plan?: MissionPlan;
	planFrozenAt?: number;
	commanderSessionId?: string;
	workflowId: string;
	integrationBranch?: string;
	integrationWorktree?: string;
	baseRef?: string;
	prUrl?: string;
	divergencePolicy: DivergencePolicy;
	maxConcurrentGoals: number;
	sandboxed?: boolean;
	enabledOptionalSteps?: string[];
	archived?: boolean;
	archivedAt?: number;
	pausedAt?: number;
	pausedReason?: string;
}

export interface MissionDetailChild {
	planId: string;
	goal: Goal | null;
	state?: GoalState | string;
	lastGate?: string;
}

export interface MissionDetail {
	mission: PersistedMission;
	plan: MissionPlan | null;
	children: MissionDetailChild[];
	gates: Array<{
		gateId: string;
		name?: string;
		status: string;
		dependsOn?: string[];
	}>;
	integrationBranch?: string;
	commanderSessionId?: string;
}

export const MISSION_STATE_LABELS: Record<MissionState, string> = {
	planning: "Planning",
	"in-progress": "In Progress",
	paused: "Paused",
	complete: "Complete",
	shelved: "Shelved",
	failed: "Failed",
};

/** Tailwind-compatible color hint for a node based on goal state / merge status. */
export function plannedGoalColor(node: PlannedGoal): {
	fill: string;
	stroke: string;
	label: string;
} {
	if (node.mergedAt) return { fill: "#bbf7d0", stroke: "#16a34a", label: "merged" };
	if (node.state === "complete") return { fill: "#d9f99d", stroke: "#65a30d", label: "complete" };
	if (node.state === "in-progress") return { fill: "#fde68a", stroke: "#d97706", label: "in-progress" };
	if ((node.failedAttempts ?? 0) > 0 || node.state === "shelved") {
		return { fill: "#fecaca", stroke: "#dc2626", label: "failed" };
	}
	if (node.goalId) return { fill: "#dbeafe", stroke: "#2563eb", label: "spawned" };
	return { fill: "#e5e7eb", stroke: "#9ca3af", label: "pending" };
}
