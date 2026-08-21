import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	evaluateSessionGoalPromotion,
	lookupSessionGoalPromotion,
	type EvaluateSessionGoalPromotionInput,
	type SessionGoalPromotionLiveSession,
	type SessionGoalPromotionPersistedSession,
} from "../../src/server/agent/session-goal-promotion.js";

const OWNER = "session-owner";
const PROJECT = "project-one";
const WORKTREE = "/projects/example-wt/session-owner";

type Fixture = {
	input: EvaluateSessionGoalPromotionInput;
	live: SessionGoalPromotionLiveSession;
	persisted: SessionGoalPromotionPersistedSession;
};

function fixture(): Fixture {
	const live: SessionGoalPromotionLiveSession = {
		id: OWNER,
		projectId: PROJECT,
		cwd: `${WORKTREE}/packages/app`,
		worktreePath: WORKTREE,
		repoPath: "/projects/example",
		branch: "session/owner",
		status: "idle",
		sandboxed: false,
	};
	const persisted: SessionGoalPromotionPersistedSession = {
		id: OWNER,
		projectId: PROJECT,
		cwd: live.cwd,
		worktreePath: live.worktreePath,
		repoPath: live.repoPath,
		branch: live.branch,
		agentSessionFile: "/state/sessions/session-owner.jsonl",
		sandboxed: false,
	};
	return {
		live,
		persisted,
		input: {
			ownerSessionId: OWNER,
			proposalProjectId: PROJECT,
			project: { id: PROJECT, rootPath: "/projects/example" },
			liveSession: live,
			persistedSession: persisted,
			transcriptAvailable: true,
			workspaceAvailable: true,
			gitComponentRepos: ["."],
		},
	};
}

function assertIneligible(input: EvaluateSessionGoalPromotionInput, code: string): void {
	const result = evaluateSessionGoalPromotion(input);
	assert.equal(result.eligible, false, JSON.stringify(result));
	if (!result.eligible) {
		assert.equal(result.code, code);
		assert.ok(result.reason.length > 0);
	}
}

describe("evaluateSessionGoalPromotion", () => {
	it("returns exact canonical coordinates for an eligible single-repo session", () => {
		const { input } = fixture();
		const result = evaluateSessionGoalPromotion({
			...input,
			// Unknown caller-shaped values are ignored rather than becoming authority.
			branch: "attacker/branch",
			worktreePath: "/attacker/worktree",
		} as EvaluateSessionGoalPromotionInput);
		assert.equal(result.eligible, true, JSON.stringify(result));
		if (!result.eligible) return;
		assert.deepEqual(result.coordinates, {
			sessionId: OWNER,
			projectId: PROJECT,
			cwd: `${WORKTREE}/packages/app`,
			worktreePath: WORKTREE,
			repoPath: "/projects/example",
			branch: "session/owner",
			repoWorktrees: undefined,
			sandboxed: false,
			containerId: undefined,
		});
	});

	it("returns exact multi-repo coordinates only when every Git component appears once", () => {
		const { input, live, persisted } = fixture();
		const repoWorktrees = {
			api: `${WORKTREE}/api`,
			web: `${WORKTREE}/web`,
		};
		live.repoPath = "/projects/polyrepo";
		persisted.repoPath = live.repoPath;
		live.repoWorktrees = [
			{ repo: "api", worktreePath: repoWorktrees.api },
			{ repo: "web", worktreePath: repoWorktrees.web },
		];
		persisted.repoWorktrees = { ...repoWorktrees };
		input.gitComponentRepos = ["api", "web"];

		const result = evaluateSessionGoalPromotion(input);
		assert.equal(result.eligible, true, JSON.stringify(result));
		if (result.eligible) assert.deepEqual(result.coordinates.repoWorktrees, repoWorktrees);
	});

	it("preserves an eligible reachable sandbox realm", () => {
		const { input, live, persisted } = fixture();
		live.cwd = "/workspace-wt/session/owner/packages/app";
		live.worktreePath = "/workspace-wt/session/owner";
		live.repoPath = "/workspace";
		live.sandboxed = true;
		live.containerId = "container-existing";
		persisted.cwd = live.cwd;
		persisted.worktreePath = live.worktreePath;
		persisted.repoPath = live.repoPath;
		persisted.sandboxed = true;
		input.sandboxReachable = true;

		const result = evaluateSessionGoalPromotion(input);
		assert.equal(result.eligible, true, JSON.stringify(result));
		if (result.eligible) {
			assert.equal(result.coordinates.sandboxed, true);
			assert.equal(result.coordinates.containerId, "container-existing");
		}
	});

	it("rejects every forbidden relation and unsafe session kind", () => {
		const relationCases: Array<{
			name: string;
			target: "live" | "persisted";
			patch: Record<string, unknown>;
			code: string;
		}> = [
			{ name: "goal", target: "live", patch: { goalId: "goal-1" }, code: "SESSION_HAS_RELATION" },
			{ name: "team", target: "persisted", patch: { teamGoalId: "goal-1" }, code: "SESSION_HAS_RELATION" },
			{ name: "team role", target: "live", patch: { role: "coder" }, code: "SESSION_HAS_RELATION" },
			{ name: "team child", target: "persisted", patch: { teamLeadSessionId: "lead-1" }, code: "SESSION_HAS_RELATION" },
			{ name: "assistant", target: "live", patch: { assistantType: "goal" }, code: "SESSION_HAS_RELATION" },
			{ name: "legacy assistant", target: "persisted", patch: { goalAssistant: true }, code: "SESSION_HAS_RELATION" },
			{ name: "staff", target: "persisted", patch: { staffId: "staff-1" }, code: "SESSION_HAS_RELATION" },
			{ name: "delegate", target: "live", patch: { delegateOf: "parent" }, code: "SESSION_HAS_RELATION" },
			{ name: "child", target: "persisted", patch: { parentSessionId: "parent", childKind: "review" }, code: "SESSION_HAS_RELATION" },
			{ name: "task", target: "live", patch: { taskId: "task-1" }, code: "SESSION_HAS_RELATION" },
			{ name: "read-only", target: "persisted", patch: { readOnly: true }, code: "SESSION_UNSAFE" },
			{ name: "noninteractive", target: "live", patch: { nonInteractive: true }, code: "SESSION_UNSAFE" },
			{ name: "borrower", target: "persisted", patch: { borrowsWorktree: true }, code: "SESSION_UNSAFE" },
			{ name: "borrowed owner marker", target: "live", patch: { borrowedWorktreeOwnerSessionId: "owner" }, code: "SESSION_UNSAFE" },
			{ name: "terminal child", target: "persisted", patch: { childTerminal: true }, code: "SESSION_UNSAFE" },
		];

		for (const testCase of relationCases) {
			const { input, live, persisted } = fixture();
			Object.assign(testCase.target === "live" ? live : persisted, testCase.patch);
			assertIneligible(input, testCase.code);
		}
	});

	it("rejects archived, terminal, busy, compacting, dormant, fenced, and pending sessions", () => {
		const cases: Array<{
			mutate: (f: Fixture) => void;
			code: string;
		}> = [
			{ mutate: ({ persisted }) => { persisted.archived = true; }, code: "SESSION_NOT_LIVE" },
			{ mutate: ({ live }) => { live.status = "terminated"; }, code: "SESSION_NOT_IDLE" },
			{ mutate: ({ live }) => { live.status = "streaming"; }, code: "SESSION_NOT_IDLE" },
			{ mutate: ({ live }) => { live.isCompacting = true; }, code: "SESSION_NOT_IDLE" },
			{ mutate: ({ persisted }) => { persisted.wasStreaming = true; }, code: "SESSION_NOT_IDLE" },
			{ mutate: ({ live }) => { live.restoreStartupWasStreaming = true; }, code: "SESSION_NOT_IDLE" },
			{ mutate: ({ live }) => { live.dormant = true; }, code: "SESSION_NOT_IDLE" },
			{ mutate: ({ live }) => { live.lifecycleFenced = true; }, code: "SESSION_NOT_IDLE" },
			{ mutate: ({ input }) => { input.hasPendingWork = true; }, code: "SESSION_NOT_IDLE" },
		];
		for (const testCase of cases) {
			const f = fixture();
			testCase.mutate(f);
			assertIneligible(f.input, testCase.code);
		}
	});

	it("requires the proposal owner and both canonical records to identify the same registered project", () => {
		const missing = fixture();
		missing.input.project = undefined;
		assertIneligible(missing.input, "PROJECT_UNAVAILABLE");

		const proposalMismatch = fixture();
		proposalMismatch.input.proposalProjectId = "project-two";
		assertIneligible(proposalMismatch.input, "PROJECT_UNAVAILABLE");

		const liveMismatch = fixture();
		liveMismatch.live.projectId = "project-two";
		assertIneligible(liveMismatch.input, "PROJECT_MISMATCH");

		const wrongOwner = fixture();
		wrongOwner.input.ownerSessionId = "arbitrary-caller-session";
		assertIneligible(wrongOwner.input, "SESSION_NOT_LIVE");
	});

	it("rejects missing, stale, mismatched, or non-dedicated workspace metadata", () => {
		const cases: Array<{
			mutate: (f: Fixture) => void;
			code: string;
		}> = [
			{ mutate: ({ input }) => { input.transcriptAvailable = false; }, code: "TRANSCRIPT_UNAVAILABLE" },
			{ mutate: ({ persisted }) => { persisted.agentSessionFile = ""; }, code: "TRANSCRIPT_UNAVAILABLE" },
			{ mutate: ({ live }) => { live.branch = undefined; }, code: "WORKTREE_UNAVAILABLE" },
			{ mutate: ({ persisted }) => { persisted.worktreePath = undefined; }, code: "WORKTREE_UNAVAILABLE" },
			{ mutate: ({ input }) => { input.workspaceAvailable = false; }, code: "WORKTREE_UNAVAILABLE" },
			{ mutate: ({ live }) => { live.branch = "different/branch"; }, code: "WORKSPACE_MISMATCH" },
			{ mutate: ({ persisted }) => { persisted.cwd = `${WORKTREE}/other`; }, code: "WORKSPACE_MISMATCH" },
			{ mutate: ({ live, persisted }) => {
				live.cwd = "/projects/example";
				live.worktreePath = "/projects/example";
				persisted.cwd = live.cwd;
				persisted.worktreePath = live.worktreePath;
			}, code: "WORKTREE_UNAVAILABLE" },
		];
		for (const testCase of cases) {
			const f = fixture();
			testCase.mutate(f);
			assertIneligible(f.input, testCase.code);
		}
	});

	it("rejects incomplete, extra, duplicate, divergent, and aliased multi-repo coordinates", () => {
		function multi(): Fixture {
			const f = fixture();
			const repoWorktrees = { api: `${WORKTREE}/api`, web: `${WORKTREE}/web` };
			f.live.repoWorktrees = Object.entries(repoWorktrees).map(([repo, worktreePath]) => ({ repo, worktreePath }));
			f.persisted.repoWorktrees = { ...repoWorktrees };
			f.input.gitComponentRepos = ["api", "web"];
			return f;
		}
		const cases: Array<(f: Fixture) => void> = [
			f => { f.input.gitComponentRepos = ["api", "api"]; },
			f => { delete (f.persisted.repoWorktrees as Record<string, string>).web; },
			f => { (f.persisted.repoWorktrees as Record<string, string>).docs = `${WORKTREE}/docs`; },
			f => { (f.live.repoWorktrees as Array<{ repo: string; worktreePath: string }>)[1].repo = "api"; },
			f => { (f.live.repoWorktrees as Array<{ repo: string; worktreePath: string }>)[1].worktreePath = `${WORKTREE}/api`; },
			f => { (f.live.repoWorktrees as Array<{ repo: string; worktreePath: string }>)[1].worktreePath = "/outside/web"; },
		];
		for (const mutate of cases) {
			const f = multi();
			mutate(f);
			assertIneligible(f.input, "MULTI_REPO_MISMATCH");
		}
	});

	it("requires the exact existing sandbox container to remain reachable", () => {
		for (const mutate of [
			(f: Fixture) => { f.live.containerId = undefined; },
			(f: Fixture) => { f.input.sandboxReachable = false; },
		]) {
			const f = fixture();
			f.live.cwd = "/workspace-wt/session/owner";
			f.live.worktreePath = f.live.cwd;
			f.live.repoPath = "/workspace";
			f.live.sandboxed = true;
			f.live.containerId = "container-existing";
			f.persisted.cwd = f.live.cwd;
			f.persisted.worktreePath = f.live.worktreePath;
			f.persisted.repoPath = f.live.repoPath;
			f.persisted.sandboxed = true;
			f.input.sandboxReachable = true;
			mutate(f);
			assertIneligible(f.input, "SANDBOX_UNAVAILABLE");
		}
	});

	it("rejects conflicting claims but allows the source session and exact retry provenance", () => {
		const conflict = fixture();
		conflict.input.workspaceClaims = [{
			kind: "staff",
			id: "staff-one",
			projectId: PROJECT,
			worktreePath: WORKTREE,
		}];
		assertIneligible(conflict.input, "WORKSPACE_CLAIMED");

		const allowed = fixture();
		allowed.input.goals = [{ id: "goal-retry", projectId: PROJECT, worktreeOwnerSessionId: OWNER }];
		allowed.input.workspaceClaims = [
			{ kind: "session", id: OWNER, sessionId: OWNER, projectId: PROJECT, worktreePath: WORKTREE },
			{ kind: "goal", id: "goal-retry", goalId: "goal-retry", projectId: PROJECT, worktreePath: WORKTREE },
		];
		assert.equal(evaluateSessionGoalPromotion(allowed.input).eligible, true);

		const duplicate = fixture();
		duplicate.input.goals = [
			{ id: "goal-one", projectId: PROJECT, worktreeOwnerSessionId: OWNER },
			{ id: "goal-two", projectId: PROJECT, worktreeOwnerSessionId: OWNER },
		];
		assertIneligible(duplicate.input, "PROMOTION_CONFLICT");
	});
});

describe("lookupSessionGoalPromotion", () => {
	it("uses only live server-owned provenance and fails closed on duplicates", () => {
		const archived = { id: "archived", archived: true, worktreeOwnerSessionId: OWNER };
		const unrelated = { id: "same-path-is-irrelevant" };
		assert.deepEqual(lookupSessionGoalPromotion([archived, unrelated], OWNER), { status: "none" });

		const goal = { id: "goal-one", projectId: PROJECT, worktreeOwnerSessionId: OWNER };
		assert.deepEqual(lookupSessionGoalPromotion([archived, goal], OWNER), { status: "found", goal });

		const other = { id: "goal-two", projectId: PROJECT, worktreeOwnerSessionId: OWNER };
		const conflict = lookupSessionGoalPromotion([goal, other], OWNER);
		assert.equal(conflict.status, "conflict");
		if (conflict.status === "conflict") assert.deepEqual(conflict.goals, [goal, other]);
	});
});
