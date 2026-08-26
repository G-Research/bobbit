import { describe, expect, expectTypeOf, it } from "vitest";
import {
	HOST_API_VERSION,
	HOST_CONTRACT_VERSION,
	type HostGateSummary,
	type HostGoalReadError,
	type HostGoalSummary,
	type HostLookupResult,
	type HostProjectApi,
	type HostProjectIdsSelector,
	type HostProjectPage,
	type HostProjectPageSelector,
	type HostProjectRead,
	type HostProjectSelector,
	type HostPullRequestSummary,
	type HostSessionSummary,
	type HostStaffSummary,
	type HostTaskSummary,
} from "../../src/shared/extension-host/host-api.ts";
import {
	HostProjectReadInputError,
	parseHostProjectSelector,
	projectHostGateSummary,
	projectHostGoalSummary,
	projectHostSessionSummary,
	projectHostStaffSummary,
	projectHostTaskSummary,
	selectHostProjectRead,
} from "../../src/server/extension-host/project-read.ts";
import { projectHostPullRequestSummary } from "../../src/server/agent/pr-status-store.ts";
import type { PersistedGoal } from "../../src/server/agent/goal-store.ts";
import type { PersistedStaff } from "../../src/server/agent/staff-store.ts";
import type { PersistedTask } from "../../src/server/agent/task-store.ts";

describe("Extension Host project read v7 contract", () => {
	it("keeps Host v1 and exposes exactly six granular project reads at contract v7", () => {
		expect(HOST_API_VERSION).toBe(1);
		expect(HOST_CONTRACT_VERSION).toBe(7);
		expectTypeOf<Exclude<keyof HostProjectApi, "notifications">>().toEqualTypeOf<
			| "readStaff"
			| "readSessions"
			| "readGoals"
			| "readGoalTasks"
			| "readGoalGates"
			| "readGoalPullRequest"
		>();
		expectTypeOf<HostProjectSelector>().toEqualTypeOf<HostProjectPageSelector | HostProjectIdsSelector>();
		expectTypeOf<HostProjectRead<HostGoalSummary>>().toEqualTypeOf<
			HostProjectPage<HostGoalSummary> | { mode: "ids"; results: HostLookupResult<HostGoalSummary>[] }
		>();
		expectTypeOf<HostGoalReadError>().toEqualTypeOf<{
			goalId: string;
			status: "not-found" | "unauthorized";
		}>();
		expectTypeOf<Awaited<ReturnType<HostProjectApi["readGoalTasks"]>>>().toEqualTypeOf<
			HostProjectRead<HostTaskSummary> | HostGoalReadError
		>();
		expectTypeOf<Awaited<ReturnType<HostProjectApi["readGoalPullRequest"]>>>().toEqualTypeOf<
			HostLookupResult<HostPullRequestSummary | null>
		>();
		const childError: HostGoalReadError = { goalId: "goal-missing", status: "not-found" };
		const pullRequestError: HostLookupResult<HostPullRequestSummary | null> = { id: "goal-missing", status: "not-found" };
		expect(childError).toEqual({ goalId: "goal-missing", status: "not-found" });
		expect(pullRequestError).toEqual({ id: "goal-missing", status: "not-found" });
	});

	it("normalizes bounded pages with offset continuation", () => {
		expect(parseHostProjectSelector(undefined)).toEqual({ mode: "page", cursor: 0, limit: 50 });
		expect(parseHostProjectSelector({ mode: "page", cursor: 2, limit: 999 })).toEqual({ mode: "page", cursor: 2, limit: 200 });
		expect(parseHostProjectSelector({ limit: 0 })).toEqual({ mode: "page", cursor: 0, limit: 1 });

		const rows = Array.from({ length: 5 }, (_, id) => ({ id: String(id) }));
		expect(selectHostProjectRead(rows, { cursor: 1, limit: 2 }, row => row.id)).toEqual({
			mode: "page",
			items: [{ id: "1" }, { id: "2" }],
			page: { cursor: 1, limit: 2, total: 5, hasMore: true, nextCursor: 3 },
		});
		expect(selectHostProjectRead(rows, { cursor: 5, limit: 2 }, row => row.id)).toEqual({
			mode: "page",
			items: [],
			page: { cursor: 5, limit: 2, total: 5, hasMore: false },
		});
	});

	it("returns one complete ordered result per requested ID, including duplicates and explicit foreign outcomes", () => {
		const rows = [{ id: "owned-1", value: "safe" }];
		expect(selectHostProjectRead(
			rows,
			{ mode: "ids", ids: ["owned-1", "foreign-1", "missing-1", "owned-1"] },
			row => row.id,
			id => id.startsWith("foreign") ? "unauthorized" : "not-found",
		)).toEqual({
			mode: "ids",
			results: [
				{ id: "owned-1", status: "found", value: { id: "owned-1", value: "safe" } },
				{ id: "foreign-1", status: "unauthorized" },
				{ id: "missing-1", status: "not-found" },
				{ id: "owned-1", status: "found", value: { id: "owned-1", value: "safe" } },
			],
		});
	});

	it("rejects malformed selectors wholly instead of truncating ID results", () => {
		const invalid = [
			null,
			{ mode: "query" },
			{ mode: "page", cursor: -1 },
			{ mode: "page", cursor: 0.5 },
			{ mode: "page", projectId: "caller-selected" },
			{ mode: "ids", ids: [] },
			{ mode: "ids", ids: ["bad id"] },
			{ mode: "ids", ids: Array.from({ length: 101 }, (_, index) => `id-${index}`) },
		];
		for (const selector of invalid) {
			expect(() => parseHostProjectSelector(selector)).toThrow(HostProjectReadInputError);
		}
	});
});

describe("Extension Host project read closed projections", () => {
	it("projects exact staff keys and excludes prompts, triggers, paths, branches, and metadata", () => {
		const raw = {
			id: "staff-1",
			name: "Staff",
			description: "DESCRIPTION_SECRET",
			systemPrompt: "PROMPT_SECRET",
			cwd: "/PATH_SECRET",
			state: "active",
			triggers: [{ prompt: "TRIGGER_SECRET" }],
			memory: "MEMORY_SECRET",
			roleId: "reviewer",
			accessory: "crown",
			createdAt: 1,
			updatedAt: 2,
			lastWakeAt: 3,
			currentSessionId: "session-1",
			worktreePath: "/WORKTREE_SECRET",
			branch: "BRANCH_SECRET",
			projectId: "PROJECT_INTERNAL",
			sandboxed: true,
		} as PersistedStaff;
		const summary: HostStaffSummary = projectHostStaffSummary(raw);
		expect(summary).toEqual({
			id: "staff-1",
			name: "Staff",
			state: "active",
			accessory: "crown",
			createdAt: 1,
			updatedAt: 2,
			roleId: "reviewer",
			currentSessionId: "session-1",
			lastWakeAt: 3,
		});
		expect(JSON.stringify(summary)).not.toMatch(/SECRET|projectId|sandboxed|triggers|memory/);
	});

	it("projects exact live and archived session keys without transport, transcript, path, model, or tag state", () => {
		const raw = {
			id: "session-1",
			title: "Session",
			status: "terminated",
			createdAt: 10,
			lastActivity: 20,
			archived: true,
			archivedAt: 30,
			goalId: "goal-1",
			teamGoalId: "goal-1",
			taskId: "task-1",
			staffId: "staff-1",
			delegateOf: "session-parent",
			parentSessionId: "session-parent",
			childKind: "delegate",
			teamLeadSessionId: "session-lead",
			role: "coder",
			readOnly: true,
			hasUnansweredQuestion: false,
			cwd: "/PATH_SECRET",
			worktreePath: "/WORKTREE_SECRET",
			spawnPinnedModel: "MODEL_SECRET",
			server_tags: ["TAG_SECRET"],
		};
		const summary: HostSessionSummary | undefined = projectHostSessionSummary(raw);
		expect(summary).toEqual({
			id: "session-1",
			title: "Session",
			status: "archived",
			createdAt: 10,
			lastActivity: 20,
			archived: true,
			archivedAt: 30,
			goalId: "goal-1",
			teamGoalId: "goal-1",
			taskId: "task-1",
			staffId: "staff-1",
			delegateOf: "session-parent",
			parentSessionId: "session-parent",
			childKind: "delegate",
			teamLeadSessionId: "session-lead",
			role: "coder",
			readOnly: true,
			hasUnansweredQuestion: false,
		});
		expect(JSON.stringify(summary)).not.toMatch(/SECRET|cwd|worktree|model|tags|transcript|messages/);
		expect(projectHostSessionSummary({ ...raw, archived: false, status: "unknown" })).toBeUndefined();
	});

	it("projects exact goal keys and excludes spec, workflow body, paths, git, metadata, and setup evidence", () => {
		const raw = {
			id: "goal-1",
			title: "Goal",
			cwd: "/PATH_SECRET",
			state: "in-progress",
			spec: "SPEC_SECRET",
			createdAt: 100,
			updatedAt: 200,
			team: true,
			archived: true,
			archivedAt: 300,
			workflowId: "workflow-1",
			workflow: { secret: "WORKFLOW_SECRET" },
			parentGoalId: "parent-1",
			rootGoalId: "root-1",
			teamLeadSessionId: "session-lead",
			setupStatus: "error",
			setupError: "EVIDENCE_SECRET",
			paused: true,
			mergeConflict: true,
			branch: "BRANCH_SECRET",
			metadata: { secret: "METADATA_SECRET" },
		} as unknown as PersistedGoal;
		const summary: HostGoalSummary = projectHostGoalSummary(raw);
		expect(summary).toEqual({
			id: "goal-1",
			title: "Goal",
			state: "in-progress",
			createdAt: 100,
			updatedAt: 200,
			team: true,
			archived: true,
			archivedAt: 300,
			workflowId: "workflow-1",
			parentGoalId: "parent-1",
			rootGoalId: "root-1",
			teamLeadSessionId: "session-lead",
			setupStatus: "error",
			paused: true,
			mergeConflict: true,
		});
		expect(JSON.stringify(summary)).not.toMatch(/SECRET|spec|workflow":|setupError|branch|metadata|cwd/);
	});

	it("projects exact task keys and copies dependencies without git, specs, results, inputs, or handoffs", () => {
		const raw = {
			id: "task-1",
			goalId: "goal-1",
			parentTaskId: "parent-task",
			title: "Task",
			type: "implementation",
			state: "complete",
			assignedSessionId: "session-1",
			spec: "SPEC_SECRET",
			createdAt: 1,
			updatedAt: 2,
			completedAt: 3,
			dependsOn: ["dep-1"],
			baseSha: "BASE_SECRET",
			headSha: "HEAD_SECRET",
			branch: "BRANCH_SECRET",
			resultSummary: "RESULT_SECRET",
			workflowGateId: "implementation",
			inputGateIds: ["design-doc"],
			gitHandoff: { repo: { branch: "HANDOFF_SECRET" } },
		} as PersistedTask;
		const summary: HostTaskSummary = projectHostTaskSummary(raw);
		expect(summary).toEqual({
			id: "task-1",
			goalId: "goal-1",
			title: "Task",
			type: "implementation",
			state: "complete",
			createdAt: 1,
			updatedAt: 2,
			dependsOn: ["dep-1"],
			parentTaskId: "parent-task",
			assignedSessionId: "session-1",
			completedAt: 3,
			workflowGateId: "implementation",
		});
		expect(summary.dependsOn).not.toBe(raw.dependsOn);
		expect(JSON.stringify(summary)).not.toMatch(/SECRET|spec|Sha|branch|result|inputGateIds|gitHandoff/);
	});

	it("projects exact safe gate fields and excludes failed-step evidence and signal content", () => {
		const summary: HostGateSummary = projectHostGateSummary({
			gateId: "implementation",
			name: "Implementation",
			status: "failed",
			effectiveStatus: "running",
			running: true,
			awaitingSignoffCount: 1,
			dependsOn: ["design-doc"],
			signalCount: 2,
			updatedAt: 123,
			failedSteps: ["EVIDENCE_SECRET"],
		});
		expect(summary).toEqual({
			gateId: "implementation",
			name: "Implementation",
			status: "failed",
			effectiveStatus: "running",
			running: true,
			awaitingSignoffCount: 1,
			dependsOn: ["design-doc"],
			signalCount: 2,
			updatedAt: 123,
		});
		expect(JSON.stringify(summary)).not.toMatch(/EVIDENCE|failedSteps|signal.*content|verification/);
	});

	it("projects only closed PR enums and a sanitized URL, with null review decision omitted", () => {
		const summary: HostPullRequestSummary | undefined = projectHostPullRequestSummary("goal-1", {
			state: "OPEN",
			number: 42,
			title: "Safe title",
			url: "https://github.com/org/repo/pull/42",
			updatedAt: "2027-01-02T03:04:05.000Z",
			reviewDecision: null,
			mergeable: "MERGEABLE",
			viewerIsAdmin: true,
			headRefName: "BRANCH_SECRET",
		});
		expect(summary).toEqual({
			goalId: "goal-1",
			state: "OPEN",
			number: 42,
			title: "Safe title",
			url: "https://github.com/org/repo/pull/42",
			updatedAt: "2027-01-02T03:04:05.000Z",
			mergeability: "MERGEABLE",
		});
		expect(JSON.stringify(summary)).not.toMatch(/viewer|headRef|BRANCH_SECRET|reviewDecision/);
		expect(projectHostPullRequestSummary("goal-1", { state: "DRAFT" })).toBeUndefined();
		expect(projectHostPullRequestSummary("goal-1", { state: "OPEN", reviewDecision: "MALFORMED" })).toBeUndefined();
		expect(projectHostPullRequestSummary("goal-1", {
			state: "OPEN",
			url: "https://user:secret@github.com/org/repo/pull/42",
		})).toEqual({ goalId: "goal-1", state: "OPEN" });
	});
});
