import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	MAX_GOAL_SPEC_LENGTH,
	MAX_GOAL_STRUCTURED_BYTES,
	MAX_GOAL_TITLE_LENGTH,
	validateGoalCandidate,
	type GoalCandidateDeps,
	type GoalCandidateSource,
	type RawGoalCandidate,
} from "../../src/server/agent/goal-candidate-validator.js";
import type { PersistedGoal } from "../../src/server/agent/goal-store.js";
import type { Workflow } from "../../src/server/agent/workflow-store.js";

const FEATURE_WORKFLOW: Workflow = {
	id: "feature",
	name: "Feature",
	description: "Canonical candidate fixture",
	createdAt: 0,
	updatedAt: 0,
	gates: [{
		id: "implementation",
		name: "Implementation",
		dependsOn: [],
		verify: [{
			name: "QA testing",
			type: "command",
			run: "echo test",
			optional: true,
			optionalLabel: "Enable QA testing",
		}],
	}],
};

interface Fixture {
	root: string;
	outside: string;
	projectId: string;
	otherProjectId: string;
	goals: Map<string, PersistedGoal>;
	sessions: Map<string, Map<string, Record<string, unknown>>>;
	workflows: Map<string, Workflow[]>;
	prefs: { subgoalsEnabled: boolean; maxNestingDepth: number };
	deps: GoalCandidateDeps;
}

let fixture: Fixture;

function project(id: string, rootPath: string, hidden = false) {
	return {
		id,
		name: id,
		rootPath,
		createdAt: 1,
		colorLight: "#fff",
		colorDark: "#000",
		...(hidden ? { hidden: true } : {}),
	};
}

function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-candidate-project-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "goal-candidate-outside-"));
	const projectId = "candidate-project";
	const otherProjectId = "other-project";
	const projects = new Map([
		[projectId, project(projectId, root)],
		[otherProjectId, project(otherProjectId, outside)],
		["hidden-project", project("hidden-project", path.join(root, "hidden"), true)],
	]);
	const goals = new Map<string, PersistedGoal>();
	const sessions = new Map<string, Map<string, Record<string, unknown>>>([
		[projectId, new Map()],
		[otherProjectId, new Map()],
	]);
	const workflows = new Map<string, Workflow[]>([
		[projectId, [structuredClone(FEATURE_WORKFLOW)]],
		[otherProjectId, [structuredClone(FEATURE_WORKFLOW)]],
	]);
	const prefs = { subgoalsEnabled: true, maxNestingDepth: 3 };
	const registry = { get: (id: string) => projects.get(id) };
	const projectContextManager = {
		getOrCreate: (id: string) => ({
			project: projects.get(id),
			sessionStore: { get: (sessionId: string) => sessions.get(id)?.get(sessionId) },
		}),
		all: () => [...projects.values()].map(record => ({
			project: record,
			sessionStore: { get: (sessionId: string) => sessions.get(record.id)?.get(sessionId) },
		})),
		getContextForGoal: (goalId: string) => {
			const goal = goals.get(goalId);
			return goal ? { project: projects.get(goal.projectId!), goalStore: { get: (id: string) => goals.get(id) } } : undefined;
		},
	};
	return {
		root,
		outside,
		projectId,
		otherProjectId,
		goals,
		sessions,
		workflows,
		prefs,
		deps: {
			registry: registry as any,
			projectContextManager: projectContextManager as any,
			workflows: id => workflows.get(id) ?? [],
			workflow: (projectId, workflowId) => workflows.get(projectId)?.find(workflow => workflow.id === workflowId),
			defaultWorkflows: () => [structuredClone(FEATURE_WORKFLOW)],
			components: () => [{ name: "app", repo: ".", commands: { test: "echo test" } }],
			getGoal: id => goals.get(id),
			nestingPrefs: () => ({ ...prefs }),
		},
	};
}

function candidate(overrides: RawGoalCandidate = {}): RawGoalCandidate {
	return {
		title: "Candidate",
		spec: "Canonical candidate validation.",
		projectId: fixture.projectId,
		workflow: "feature",
		...overrides,
	};
}

function validate(overrides: RawGoalCandidate = {}, source: GoalCandidateSource = { kind: "user-input" }) {
	return validateGoalCandidate(candidate(overrides), { source }, fixture.deps);
}

function expectCode(result: ReturnType<typeof validate>, code: string): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.code).toBe(code);
}

function parent(overrides: Partial<PersistedGoal> = {}): PersistedGoal {
	const id = overrides.id ?? `parent-${fixture.goals.size + 1}`;
	const value: PersistedGoal = {
		id,
		title: "Parent",
		cwd: fixture.root,
		state: "todo",
		spec: "Parent fixture",
		createdAt: 1,
		updatedAt: 1,
		projectId: fixture.projectId,
		rootGoalId: id,
		setupStatus: "ready",
		subgoalsAllowed: true,
		...overrides,
	};
	fixture.goals.set(id, value);
	return value;
}

beforeEach(() => {
	fixture = makeFixture();
});

afterEach(() => {
	fs.rmSync(fixture.root, { recursive: true, force: true });
	fs.rmSync(fixture.outside, { recursive: true, force: true });
});

describe("canonical goal candidate — cwd and ownership", () => {
	it("defaults an omitted cwd to the selected project root", () => {
		const result = validate();
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.candidate.cwd).toBe(fs.realpathSync(fixture.root));
	});

	it("accepts an existing project subdirectory and a non-existent suffix below it", () => {
		const existing = path.join(fixture.root, "packages");
		fs.mkdirSync(existing);
		for (const cwd of [existing, path.join(existing, "future", "child")]) {
			const result = validate({ cwd });
			expect(result.ok, cwd).toBe(true);
			if (result.ok) expect(result.candidate.cwd).toBe(path.resolve(cwd));
		}
	});

	it("rejects an outside path and a user-supplied Bobbit worktree", () => {
		for (const cwd of [fixture.outside, path.join(fixture.outside, "owned-worktree")]) {
			expectCode(validate({ cwd }), "CWD_OUTSIDE_PROJECT");
		}
	});

	it("accepts only the server-derived worktree of the current promotion owner", () => {
		const ownerId = "owner-session";
		const worktree = path.join(fixture.outside, "owned-worktree");
		fs.mkdirSync(worktree);
		fixture.sessions.get(fixture.projectId)!.set(ownerId, {
			id: ownerId,
			projectId: fixture.projectId,
			cwd: worktree,
			worktreePath: worktree,
		});
		const source: GoalCandidateSource = {
			kind: "current-session-promotion",
			sessionId: ownerId,
			serverDerivedProjectId: fixture.projectId,
			serverDerivedCwd: worktree,
		};
		const accepted = validate({ cwd: worktree }, source);
		expect(accepted.ok).toBe(true);
		if (accepted.ok) expect(accepted.candidate.cwd).toBe(fs.realpathSync(worktree));

		expectCode(validate({ cwd: path.join(worktree, "forged-sibling") }, source), "CWD_OUTSIDE_PROJECT");
	});

	it("rejects other-project, stale, and forged ownership records", () => {
		const worktree = path.join(fixture.outside, "foreign-worktree");
		fs.mkdirSync(worktree);
		fixture.sessions.get(fixture.otherProjectId)!.set("foreign-owner", {
			id: "foreign-owner",
			projectId: fixture.otherProjectId,
			cwd: worktree,
			worktreePath: worktree,
		});
		for (const sessionId of ["foreign-owner", "stale-owner", "forged-owner"]) {
			const source: GoalCandidateSource = {
				kind: "current-session-promotion",
				sessionId,
				serverDerivedProjectId: fixture.projectId,
				serverDerivedCwd: worktree,
			};
			expectCode(validate({ cwd: worktree }, source), "CWD_OUTSIDE_PROJECT");
		}
	});

	it.skipIf(process.platform !== "win32")("accepts Windows case and separator aliases", () => {
		const alias = path.join(fixture.root.toUpperCase().replaceAll("\\", "/"), "future", "child");
		const result = validate({ cwd: alias });
		expect(result.ok).toBe(true);
	});

	it("rejects a symlink or junction escape from inside the project", () => {
		const escape = path.join(fixture.root, "escape");
		fs.symlinkSync(fixture.outside, escape, process.platform === "win32" ? "junction" : "dir");
		expectCode(validate({ cwd: path.join(escape, "future") }), "CWD_OUTSIDE_PROJECT");
	});
});

describe("canonical goal candidate — project, workflow, and structured fields", () => {
	it.each([
		[{ projectId: undefined }, "PROJECT_ID_REQUIRED"],
		[{ projectId: "missing-project" }, "PROJECT_NOT_FOUND"],
		[{ projectId: "hidden-project" }, "PROJECT_NOT_VISIBLE"],
		[{ workflow: "missing" }, "UNKNOWN_WORKFLOW"],
		[{ workflow: "feature", options: "Not optional" }, "UNKNOWN_OPTIONAL_STEP"],
		[{ workflow: "feature", enabledOptionalSteps: ["QA testing", 1] }, "UNKNOWN_OPTIONAL_STEP"],
	])("rejects invalid project/workflow input %#", (overrides, code) => {
		expectCode(validate(overrides), code);
	});

	it("accepts a registered workflow and canonical optional step", () => {
		const result = validate({ options: "QA testing" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.candidate.workflowId).toBe("feature");
			expect(result.candidate.enabledOptionalSteps).toEqual(["QA testing"]);
			expect(result.candidate.workflow).not.toBe(FEATURE_WORKFLOW);
		}
	});

	it("uses exact creation-time workflow lookup for store-only runtime entries", () => {
		fixture.deps.workflows = () => [];
		const accepted = validate({ workflow: "feature", options: "QA testing" });
		expect(accepted.ok).toBe(true);
		if (accepted.ok) {
			expect(accepted.candidate.workflowId).toBe("feature");
			expect(accepted.candidate.enabledOptionalSteps).toEqual(["QA testing"]);
			expect(accepted.candidate.seedDefaultWorkflows).toBeUndefined();
		}
		expectCode(validate({ workflow: "feature", options: "Not optional" }), "UNKNOWN_OPTIONAL_STEP");
	});

	it("validates an empty live store against the defaults creation would persist", () => {
		fixture.workflows.set(fixture.projectId, []);
		expectCode(validate({ workflow: "missing" }), "UNKNOWN_WORKFLOW");
		expectCode(validate({ workflow: "feature", options: "Not optional" }), "UNKNOWN_OPTIONAL_STEP");

		const accepted = validate({ workflow: "feature", options: "QA testing" });
		expect(accepted.ok).toBe(true);
		if (accepted.ok) {
			expect(accepted.candidate.workflowId).toBe("feature");
			expect(accepted.candidate.enabledOptionalSteps).toEqual(["QA testing"]);
			expect(accepted.candidate.seedDefaultWorkflows).toBe(true);
		}
	});

	it("accepts ordinary goal workflow snapshots above the child-inline cap", () => {
		const largeWorkflow = structuredClone(FEATURE_WORKFLOW);
		largeWorkflow.id = "large-workflow";
		largeWorkflow.description = "x".repeat(300_000);
		fixture.workflows.get(fixture.projectId)!.push(largeWorkflow);
		const result = validate({ workflow: largeWorkflow.id });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.candidate.workflow?.description).toHaveLength(300_000);
	});

	it("retains the ordinary goal structured payload bound", () => {
		const oversizedWorkflow = structuredClone(FEATURE_WORKFLOW);
		oversizedWorkflow.id = "oversized-workflow";
		oversizedWorkflow.description = "x".repeat(MAX_GOAL_STRUCTURED_BYTES);
		fixture.workflows.get(fixture.projectId)!.push(oversizedWorkflow);
		expectCode(validate({ workflow: oversizedWorkflow.id }), "WORKFLOW_TOO_LARGE");
	});

	it.each([
		[{ id: "bad", name: "Bad", gates: [{ id: "one", name: "One", dependsOn: ["missing"], verify: [] }] }],
		[{ id: "bad", name: "Bad", gates: [
			{ id: "one", name: "One", dependsOn: ["two"], verify: [] },
			{ id: "two", name: "Two", dependsOn: ["one"], verify: [] },
		] }],
		[{ id: "bad", name: "Bad", gates: [{ id: "one", name: "One", dependsOn: [], verify: [{ name: "Run", type: "unknown" }] }] }],
	])("rejects a fully malformed inline workflow %#", inlineWorkflow => {
		expectCode(validate({ workflow: undefined, inlineWorkflow }), "WORKFLOW_INVALID");
	});

	it.each([
		[{ reviewer: { name: "other", label: "Reviewer", promptTemplate: "Review" } }],
		[{ "Bad Name": { name: "Bad Name", label: "Reviewer", promptTemplate: "Review" } }],
		[{ reviewer: { name: "reviewer", label: "Reviewer", promptTemplate: "Review", model: "malformed" } }],
	])("rejects invalid inline roles %#", inlineRoles => {
		expectCode(validate({ inlineRoles }), "INLINE_ROLES_INVALID");
	});

	it.each([
		[{ metadata: [] }, "METADATA_INVALID"],
		[{ metadata: "not-an-object" }, "METADATA_INVALID"],
		[{ metadata: { payload: "x".repeat(MAX_GOAL_STRUCTURED_BYTES) } }, "METADATA_TOO_LARGE"],
		[{ inlineRoles: { reviewer: { name: "reviewer", label: "R", promptTemplate: "x".repeat(MAX_GOAL_STRUCTURED_BYTES) } } }, "ROLES_TOO_LARGE"],
	])("rejects malformed or oversized structured input %#", (overrides, code) => {
		expectCode(validate(overrides), code);
	});

	it("accepts legacy descriptive titles through the canonical bound", () => {
		const title = "x".repeat(MAX_GOAL_TITLE_LENGTH);
		const result = validate({ title });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.candidate.title).toBe(title);
	});

	it.each([
		[{ title: "" }, "TITLE_REQUIRED"],
		[{ title: "x".repeat(MAX_GOAL_TITLE_LENGTH + 1) }, "TITLE_TOO_LONG"],
		[{ spec: 42 }, "SPEC_INVALID"],
		[{ spec: "x".repeat(MAX_GOAL_SPEC_LENGTH + 1) }, "SPEC_TOO_LONG"],
		[{ subgoalsAllowed: "yes" }, "SUBGOALS_ALLOWED_INVALID"],
		[{ maxNestingDepth: Number.NaN }, "MAX_NESTING_DEPTH_INVALID"],
		[{ divergencePolicy: "free" }, "DIVERGENCE_POLICY_INVALID"],
		[{ maxConcurrentChildren: 0 }, "MAX_CONCURRENT_CHILDREN_INVALID"],
		[{ maxConcurrentChildren: 9 }, "MAX_CONCURRENT_CHILDREN_INVALID"],
		[{ maxConcurrentChildren: 1.5 }, "MAX_CONCURRENT_CHILDREN_INVALID"],
	])("rejects invalid scalar bounds %#", (overrides, code) => {
		expectCode(validate(overrides), code);
	});
});

describe("canonical goal candidate — parent and root/child policy", () => {
	it.each([
		["missing", "PARENT_NOT_FOUND"],
		["", "PARENT_NOT_FOUND"],
	])("rejects missing parent %j", (parentGoalId, code) => {
		expectCode(validate({ parentGoalId }), code);
	});

	it("rejects a cross-project parent", () => {
		const foreign = parent({ id: "foreign-parent", projectId: fixture.otherProjectId, cwd: fixture.outside });
		expectCode(validate({ parentGoalId: foreign.id }), "PARENT_CROSS_PROJECT");
	});

	it("applies authenticated parent authorization before accepting a child", () => {
		const root = parent();
		const result = validateGoalCandidate(candidate({ parentGoalId: root.id }), {
			source: { kind: "user-input" },
			authorizeParent: () => ({
				ok: false,
				status: 403,
				code: "NOT_TEAM_LEAD",
				message: "Caller is not the authenticated parent team lead",
			}),
		}, fixture.deps);
		expectCode(result, "NOT_TEAM_LEAD");
	});

	it("rejects paused ancestors, disabled spawning, and exhausted nesting depth", () => {
		const pausedRoot = parent({ id: "paused-root", paused: true });
		const child = parent({ id: "paused-child", parentGoalId: pausedRoot.id, rootGoalId: pausedRoot.id });
		expectCode(validate({ parentGoalId: child.id }), "GOAL_PAUSED");

		const disabled = parent({ id: "disabled-parent", subgoalsAllowed: false });
		expectCode(validate({ parentGoalId: disabled.id }), "PARENT_SUBGOALS_DISABLED");

		const shallow = parent({ id: "shallow-parent", maxNestingDepth: 1 });
		expectCode(validate({ parentGoalId: shallow.id }), "NESTING_DEPTH_EXCEEDED");

		fixture.prefs.subgoalsEnabled = false;
		expectCode(validate({ parentGoalId: shallow.id }), "SUBGOALS_DISABLED");
	});

	it("rejects root-only divergence and concurrency policy on children", () => {
		const root = parent();
		for (const overrides of [
			{ divergencePolicy: "strict" },
			{ maxConcurrentChildren: 2 },
		]) {
			expectCode(validate({ parentGoalId: root.id, ...overrides }), "ROOT_POLICY_ON_CHILD");
		}
	});

	it("accepts bounded root policy and inherited child nesting policy", () => {
		const rootResult = validate({
			subgoalsAllowed: true,
			maxNestingDepth: 10,
			divergencePolicy: "autonomous",
			maxConcurrentChildren: 8,
		});
		expect(rootResult.ok).toBe(true);
		if (rootResult.ok) expect(rootResult.candidate).toMatchObject({
			subgoalsAllowed: true,
			maxNestingDepth: fixture.prefs.maxNestingDepth,
			divergencePolicy: "autonomous",
			maxConcurrentChildren: 8,
		});

		const root = parent({ maxNestingDepth: 2 });
		const childResult = validate({ parentGoalId: root.id, maxNestingDepth: 9 });
		expect(childResult.ok).toBe(true);
		if (childResult.ok) expect(childResult.candidate).toMatchObject({
			parentGoalId: root.id,
			maxNestingDepth: 2,
			subgoalsAllowed: true,
		});
	});
});
