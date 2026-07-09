import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/sidebar-goal-rendering.spec.ts (v2-dom tier).
// FIDELITY NOTE: the legacy file:// fixture EXTRACTED the goal-badge / PR-badge /
// setup-status / empty-state / opacity / provisional logic out of the inline
// renderGoalGroup() code in src/app/render-helpers.ts + src/app/sidebar.ts (there
// are no exported src helpers for these). This port keeps a byte-identical replica
// of the fixture's extracted functions and preserves every assertion (SB-09..13,
// SB-30).
import { describe, expect, it } from "vitest";

function getGoalBadgeInfo(
	goalId: string,
	gateStatusCache: Map<string, any>,
	prStatusCache: Map<string, any>,
	sessions: any[],
	goal?: any,
): any {
	const pr = prStatusCache.get(goalId);
	const hasWorkflowGates = !!(goal && (goal.workflowId || (goal.workflow && goal.workflow.gates && goal.workflow.gates.length > 0)));
	const gs = gateStatusCache.get(goalId);
	if (pr && (!hasWorkflowGates || (gs && gs.total > 0 && gs.passed === gs.total))) {
		let color;
		if (pr.state === "MERGED") color = "#a87fd4";
		else if (pr.state === "CLOSED") color = "#c47070";
		else if (pr.reviewDecision === "APPROVED") color = "#6bc485";
		else if (pr.reviewDecision === "CHANGES_REQUESTED") color = "#c47070";
		else if (pr.reviewDecision === "REVIEW_REQUIRED") color = "#d4a04a";
		else color = "#6bc485";

		const hasConflicts = pr.state === "OPEN" && pr.mergeable === "CONFLICTING";
		const url = pr.url || null;
		return { type: "pr", state: pr.state, color, hasConflicts, url };
	}

	if (!gs) return { type: "none" };

	const goalAgents = sessions.filter(s => (s.goalId === goalId || s.teamGoalId === goalId) && !s.delegateOf);
	const hasTeam = goalAgents.some(s => s.role === "team-lead" && s.status !== "terminated");
	const anyAgentWorking = goalAgents.some(s => s.status === "streaming" || s.status === "busy" || s.isCompacting);
	const allPassed = gs.passed === gs.total;
	const color = !hasTeam ? "#6b7280" : allPassed ? "#22c55e" : anyAgentWorking ? "#3b82f6" : "#7a8ea8";

	return {
		type: "gate",
		passed: gs.passed,
		total: gs.total,
		verifying: !!gs.verifying,
		verifyingCount: gs.verifyingCount || 0,
		anyAgentWorking,
		hasTeam,
		allPassed,
		color,
	};
}

function getEmptyState(archived: boolean, canArchive: boolean, isTeamGoal: boolean): string {
	if (archived) return "archived";
	if (canArchive) return "archive-goal";
	if (isTeamGoal) return "start-team";
	return "start-session";
}

function getSetupIndicator(setupStatus: string | undefined): string {
	if (setupStatus === "preparing") return "spinner";
	if (setupStatus === "error") return "warning";
	return "none";
}

function getGoalOpacity(goalState: string): string {
	if (goalState === "shelved") return "opacity-60";
	return "";
}

function isProvisionalProject(project: { provisional?: boolean }): boolean {
	return !!project.provisional;
}

describe("SB-09: Goal gate badge", () => {
	it("no gate status returns type 'none'", () => {
		expect(getGoalBadgeInfo("g1", new Map(), new Map(), [])).toEqual({ type: "none" });
	});

	it("gate status shows passed/total", () => {
		const gates = new Map([["g1", { passed: 2, total: 5, verifying: false, verifyingCount: 0 }]]);
		const result = getGoalBadgeInfo("g1", gates, new Map(), []);
		expect(result.type).toBe("gate");
		expect(result.passed).toBe(2);
		expect(result.total).toBe(5);
	});

	it("allPassed is true when passed equals total", () => {
		const gates = new Map([["g1", { passed: 5, total: 5, verifying: false, verifyingCount: 0 }]]);
		const sessions = [{ goalId: "g1", role: "team-lead", status: "idle", delegateOf: null, isCompacting: false }];
		const result = getGoalBadgeInfo("g1", gates, new Map(), sessions);
		expect(result.allPassed).toBe(true);
		expect(result.color).toBe("#22c55e");
	});

	it("verifying state is reported", () => {
		const gates = new Map([["g1", { passed: 2, total: 5, verifying: true, verifyingCount: 1 }]]);
		const result = getGoalBadgeInfo("g1", gates, new Map(), []);
		expect(result.verifying).toBe(true);
		expect(result.verifyingCount).toBe(1);
	});

	it("anyAgentWorking when agent is streaming", () => {
		const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
		const sessions = [{ goalId: "g1", role: "team-lead", status: "streaming", delegateOf: null, isCompacting: false }];
		const result = getGoalBadgeInfo("g1", gates, new Map(), sessions);
		expect(result.anyAgentWorking).toBe(true);
		expect(result.color).toBe("#3b82f6");
	});

	it("anyAgentWorking when agent is busy", () => {
		const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
		const sessions = [
			{ goalId: "g1", role: "coder", status: "busy", delegateOf: null, isCompacting: false },
			{ goalId: "g1", role: "team-lead", status: "idle", delegateOf: null, isCompacting: false },
		];
		expect(getGoalBadgeInfo("g1", gates, new Map(), sessions).anyAgentWorking).toBe(true);
	});

	it("anyAgentWorking when agent is compacting", () => {
		const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
		const sessions = [{ goalId: "g1", role: "team-lead", status: "idle", delegateOf: null, isCompacting: true }];
		expect(getGoalBadgeInfo("g1", gates, new Map(), sessions).anyAgentWorking).toBe(true);
	});

	it("no team (no team-lead) shows muted color", () => {
		const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
		const result = getGoalBadgeInfo("g1", gates, new Map(), []);
		expect(result.hasTeam).toBe(false);
		expect(result.color).toBe("#6b7280");
	});

	it("idle team with incomplete gates shows default team color", () => {
		const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
		const sessions = [{ goalId: "g1", role: "team-lead", status: "idle", delegateOf: null, isCompacting: false }];
		const result = getGoalBadgeInfo("g1", gates, new Map(), sessions);
		expect(result.hasTeam).toBe(true);
		expect(result.color).toBe("#7a8ea8");
	});

	it("delegates are excluded from agent working check", () => {
		const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
		const sessions = [
			{ goalId: "g1", role: "team-lead", status: "idle", delegateOf: null, isCompacting: false },
			{ goalId: "g1", role: "coder", status: "streaming", delegateOf: "parent-id", isCompacting: false },
		];
		expect(getGoalBadgeInfo("g1", gates, new Map(), sessions).anyAgentWorking).toBe(false);
	});

	it("teamGoalId sessions count toward goal agents", () => {
		const gates = new Map([["g1", { passed: 1, total: 3, verifying: false, verifyingCount: 0 }]]);
		const sessions = [
			{ goalId: "other", teamGoalId: "g1", role: "team-lead", status: "streaming", delegateOf: null, isCompacting: false },
		];
		const result = getGoalBadgeInfo("g1", gates, new Map(), sessions);
		expect(result.hasTeam).toBe(true);
		expect(result.anyAgentWorking).toBe(true);
	});
});

describe("SB-10: PR status badge", () => {
	it("non-workflow goal shows PR without a gate summary", () => {
		const prs = new Map([["g1", { state: "OPEN", reviewDecision: null, mergeable: "MERGEABLE", url: "https://pr" }]]);
		expect(getGoalBadgeInfo("g1", new Map(), prs, []).type).toBe("pr");
	});

	it("non-workflow goal PR takes priority over stray gate status", () => {
		const gates = new Map([["g1", { passed: 2, total: 5, verifying: false, verifyingCount: 0 }]]);
		const prs = new Map([["g1", { state: "OPEN", reviewDecision: null, mergeable: "MERGEABLE", url: "https://pr" }]]);
		expect(getGoalBadgeInfo("g1", gates, prs, []).type).toBe("pr");
	});

	it("workflow goal hides PR when gate summary is missing", () => {
		const prs = new Map([["g1", { state: "OPEN", reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", url: "https://pr" }]]);
		expect(getGoalBadgeInfo("g1", new Map(), prs, [], { workflowId: "wf", workflow: { gates: [{ id: "gate" }] } }).type).toBe("none");
	});

	it("workflowId-only goal hides PR when gate summary is missing", () => {
		const prs = new Map([["g1", { state: "OPEN", reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", url: "https://pr" }]]);
		expect(getGoalBadgeInfo("g1", new Map(), prs, [], { workflowId: "wf" }).type).toBe("none");
	});

	it("workflow goal hides PR while gates are incomplete", () => {
		const gates = new Map([["g1", { passed: 1, total: 2, verifying: false, verifyingCount: 0 }]]);
		const prs = new Map([["g1", { state: "OPEN", reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", url: "https://pr" }]]);
		const result = getGoalBadgeInfo("g1", gates, prs, [], { workflowId: "wf", workflow: { gates: [{ id: "a" }, { id: "b" }] } });
		expect(result.type).toBe("gate");
		expect(result.passed).toBe(1);
		expect(result.total).toBe(2);
	});

	it("workflow goal shows PR after all gates pass", () => {
		const gates = new Map([["g1", { passed: 2, total: 2, verifying: false, verifyingCount: 0 }]]);
		const prs = new Map([["g1", { state: "OPEN", reviewDecision: null, mergeable: "MERGEABLE", url: "https://pr" }]]);
		expect(getGoalBadgeInfo("g1", gates, prs, [], { workflowId: "wf", workflow: { gates: [{ id: "a" }, { id: "b" }] } }).type).toBe("pr");
	});

	it("MERGED PR → purple color", () => {
		const prs = new Map([["g1", { state: "MERGED" }]]);
		expect(getGoalBadgeInfo("g1", new Map(), prs, []).color).toBe("#a87fd4");
	});

	it("CLOSED PR → red color", () => {
		const prs = new Map([["g1", { state: "CLOSED" }]]);
		expect(getGoalBadgeInfo("g1", new Map(), prs, []).color).toBe("#c47070");
	});

	it("OPEN + APPROVED → green color", () => {
		const prs = new Map([["g1", { state: "OPEN", reviewDecision: "APPROVED" }]]);
		expect(getGoalBadgeInfo("g1", new Map(), prs, []).color).toBe("#6bc485");
	});

	it("OPEN + CHANGES_REQUESTED → red color", () => {
		const prs = new Map([["g1", { state: "OPEN", reviewDecision: "CHANGES_REQUESTED" }]]);
		expect(getGoalBadgeInfo("g1", new Map(), prs, []).color).toBe("#c47070");
	});

	it("OPEN + REVIEW_REQUIRED → gold color", () => {
		const prs = new Map([["g1", { state: "OPEN", reviewDecision: "REVIEW_REQUIRED" }]]);
		expect(getGoalBadgeInfo("g1", new Map(), prs, []).color).toBe("#d4a04a");
	});

	it("OPEN with no review decision → default green", () => {
		const prs = new Map([["g1", { state: "OPEN", reviewDecision: null }]]);
		expect(getGoalBadgeInfo("g1", new Map(), prs, []).color).toBe("#6bc485");
	});

	it("OPEN + CONFLICTING → hasConflicts true", () => {
		const prs = new Map([["g1", { state: "OPEN", reviewDecision: null, mergeable: "CONFLICTING" }]]);
		expect(getGoalBadgeInfo("g1", new Map(), prs, []).hasConflicts).toBe(true);
	});

	it("non-OPEN PR does not have conflicts even if mergeable is CONFLICTING", () => {
		const prs = new Map([["g1", { state: "MERGED", mergeable: "CONFLICTING" }]]);
		expect(getGoalBadgeInfo("g1", new Map(), prs, []).hasConflicts).toBe(false);
	});

	it("PR with url includes it", () => {
		const prs = new Map([["g1", { state: "OPEN", url: "https://github.com/repo/pull/42" }]]);
		expect(getGoalBadgeInfo("g1", new Map(), prs, []).url).toBe("https://github.com/repo/pull/42");
	});

	it("PR without url has null url", () => {
		const prs = new Map([["g1", { state: "OPEN" }]]);
		expect(getGoalBadgeInfo("g1", new Map(), prs, []).url).toBeNull();
	});
});

describe("SB-11: Goal setup status indicator", () => {
	it("'preparing' → spinner", () => expect(getSetupIndicator("preparing")).toBe("spinner"));
	it("'error' → warning", () => expect(getSetupIndicator("error")).toBe("warning"));
	it("'ready' → none", () => expect(getSetupIndicator("ready")).toBe("none"));
	it("undefined → none", () => expect(getSetupIndicator(undefined)).toBe("none"));
});

describe("SB-12: Empty state logic", () => {
	it("archived goal → 'archived'", () => expect(getEmptyState(true, false, true)).toBe("archived"));
	it("canArchive (merged PR, no team) → 'archive-goal'", () => expect(getEmptyState(false, true, true)).toBe("archive-goal"));
	it("team goal → 'start-team'", () => expect(getEmptyState(false, false, true)).toBe("start-team"));
	it("non-team goal → 'start-session'", () => expect(getEmptyState(false, false, false)).toBe("start-session"));
});

describe("SB-13: Shelved goal opacity", () => {
	it("shelved → 'opacity-60'", () => expect(getGoalOpacity("shelved")).toBe("opacity-60"));
	it("in-progress → empty string", () => expect(getGoalOpacity("in-progress")).toBe(""));
	it("complete → empty string", () => expect(getGoalOpacity("complete")).toBe(""));
	it("todo → empty string", () => expect(getGoalOpacity("todo")).toBe(""));
});

describe("SB-30: Provisional project indicator", () => {
	it("provisional: true → true", () => expect(isProvisionalProject({ provisional: true })).toBe(true));
	it("provisional: false → false", () => expect(isProvisionalProject({ provisional: false })).toBe(false));
	it("no provisional property → false", () => expect(isProvisionalProject({})).toBe(false));
});
