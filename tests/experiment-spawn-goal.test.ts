/**
 * Unit tests for the experiment-runner gateway closure
 * `spawnExperimentChildGoal` (src/server/agent/experiment-spawn-goal.ts). Drives
 * the real closure over FAKE project-context / GoalManager / scheduler deps so
 * the createGoal option mapping, parent derivation + assertion, idempotency,
 * inheritance, nesting/pause guards, and scheduled-start request are pinned.
 *
 * Pinned invariants (docs/design/experiment-runner-spawn-goal.md):
 *   • Parent is server-derived (goalId ?? teamGoalId); a mismatched assertion
 *     `parentGoalId` is rejected (PARENT_MISMATCH).
 *   • Arm metadata + merged inlineRoles + resolved workflow map onto createGoal.
 *   • projectId + sandboxed are inherited from the parent goal (never caller).
 *   • runKey is idempotent — a re-call returns the first child id, no 2nd create.
 *   • NO_EFFECTIVE_GOAL / GOAL_PAUSED / SUBGOALS_DISABLED /
 *     NESTING_DEPTH_EXCEEDED are refused with coded errors.
 *   • A scheduled (cap-aware) team start is requested exactly once on success.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	spawnExperimentChildGoal,
	SpawnGoalError,
	type SpawnExperimentChildGoalDeps,
	type SpawnChildGoalOpts,
} from "../src/server/agent/experiment-spawn-goal.ts";
import type { ProjectContextManager } from "../src/server/agent/project-context-manager.ts";
import type { SessionManager } from "../src/server/agent/session-manager.ts";
import type { VerificationHarness } from "../src/server/agent/verification-harness.ts";
import type { SubgoalNestingPrefs } from "../src/server/agent/subgoal-nesting-limit.ts";

type Goal = Record<string, any>;

const PARENT_WORKFLOW = {
	id: "feature",
	name: "Feature",
	gates: [{ id: "design-doc", verify: [] }, { id: "execution", verify: [] }],
};

class Harness {
	goals = new Map<string, Goal>();
	createGoalCalls: Array<{ title: string; cwd: string; opts: any }> = [];
	updateGoalCalls: Array<{ id: string; updates: any }> = [];
	initGatesCalls: Array<{ goalId: string; gateIds: string[] }> = [];
	startCalls: string[] = [];
	broadcasts: any[] = [];
	prefs: SubgoalNestingPrefs = { subgoalsEnabled: true, maxNestingDepth: 3 };
	owner: { goalId?: string; teamGoalId?: string } | undefined = { goalId: "exp-goal" };
	private seq = 0;

	constructor() {
		this.goals.set("exp-goal", {
			id: "exp-goal",
			title: "Experiment",
			cwd: "/repo",
			repoPath: "/repo",
			worktreePath: undefined,
			projectId: "proj-1",
			sandboxed: true,
			paused: false,
			inlineRoles: { lead: { name: "lead", label: "Lead", promptTemplate: "p" } },
			workflow: structuredClone(PARENT_WORKFLOW),
			subgoalsAllowed: true,
		});
	}

	private goalStore = {
		get: (id: string) => this.goals.get(id),
		getAll: () => [...this.goals.values()],
	};
	private goalManager = {
		createGoal: async (title: string, cwd: string, opts: any) => {
			this.createGoalCalls.push({ title, cwd, opts });
			const id = `child-${++this.seq}`;
			const g: Goal = {
				id,
				title,
				cwd,
				parentGoalId: opts.parentGoalId,
				projectId: opts.projectId,
				sandboxed: opts.sandboxed,
				metadata: opts.metadata,
				inlineRoles: opts.inlineRoles,
				workflow: opts.resolvedWorkflow,
				workflowId: opts.workflowId,
			};
			this.goals.set(id, g);
			return g;
		},
		updateGoal: async (id: string, updates: any) => {
			this.updateGoalCalls.push({ id, updates });
			Object.assign(this.goals.get(id) ?? {}, updates);
		},
	};
	private gateStore = {
		initGatesForGoal: (goalId: string, gateIds: string[]) => {
			this.initGatesCalls.push({ goalId, gateIds });
		},
	};
	private ctx = {
		goalStore: this.goalStore,
		goalManager: this.goalManager,
		gateStore: this.gateStore,
		workflowStore: undefined,
	};

	deps(): SpawnExperimentChildGoalDeps {
		return {
			sessionManager: { getPersistedSession: () => this.owner } as unknown as Pick<SessionManager, "getPersistedSession">,
			projectContextManager: { getContextForGoal: () => this.ctx } as unknown as Pick<ProjectContextManager, "getContextForGoal">,
			verificationHarness: { requestChildStart: (id: string) => { this.startCalls.push(id); return "started" as const; } } as unknown as Pick<VerificationHarness, "requestChildStart">,
			getSubgoalNestingPrefs: () => this.prefs,
			broadcastToAll: (ev: unknown) => { this.broadcasts.push(ev); },
		};
	}
}

const baseOpts = (over?: Partial<SpawnChildGoalOpts>): SpawnChildGoalOpts => ({
	title: "Variant A",
	spec: "run the arm",
	runKey: "arm-a#0",
	...over,
});

describe("spawnExperimentChildGoal — createGoal option mapping", () => {
	let h: Harness;
	beforeEach(() => { h = new Harness(); });

	it("maps arm metadata + merged inlineRoles + resolved workflow onto createGoal", async () => {
		const armRole = { name: "arm", label: "Arm", promptTemplate: "x" };
		const res = await spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts({
			metadata: { exp: { armId: "a" }, bobbit: { disabledTools: ["t"] } },
			inlineRoles: { arm: armRole as never },
		}));
		assert.match(res.goalId, /^child-/);
		assert.equal(h.createGoalCalls.length, 1);
		const opts = h.createGoalCalls[0].opts;
		assert.deepEqual(opts.metadata, { exp: { armId: "a" }, bobbit: { disabledTools: ["t"] } });
		// inlineRoles = parent ⊕ arm (arm wins per name).
		assert.deepEqual(opts.inlineRoles, {
			lead: { name: "lead", label: "Lead", promptTemplate: "p" },
			arm: armRole,
		});
		// Tier-3 workflow inheritance → a resolved snapshot is passed.
		assert.equal(opts.resolvedWorkflow.id, "feature");
		assert.equal(opts.workflowId, "feature");
	});

	it("inherits projectId + sandboxed from the parent goal (never caller-supplied)", async () => {
		await spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts());
		const opts = h.createGoalCalls[0].opts;
		assert.equal(opts.projectId, "proj-1");
		assert.equal(opts.sandboxed, true);
		assert.equal(opts.parentGoalId, "exp-goal");
	});

	it("stamps the runKey via updateGoal, inits gate states, broadcasts, and requests a scheduled start exactly once", async () => {
		const res = await spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts({ runKey: "k-1" }));
		assert.equal(h.updateGoalCalls.length, 1);
		assert.deepEqual(h.updateGoalCalls[0].updates, { spawnedFromPlanId: "k-1" });
		assert.deepEqual(h.initGatesCalls, [{ goalId: res.goalId, gateIds: ["design-doc", "execution"] }]);
		assert.deepEqual(h.broadcasts, [{ type: "goal_created", goalId: res.goalId, parentGoalId: "exp-goal" }]);
		assert.deepEqual(h.startCalls, [res.goalId]);
	});

	it("resolves an explicit inline workflow snapshot (highest precedence)", async () => {
		const wf = { id: "wf-inline", name: "Inline", gates: [{ id: "g1", verify: [] }] };
		await spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts({ workflow: wf as never }));
		const opts = h.createGoalCalls[0].opts;
		assert.equal(opts.resolvedWorkflow.id, "wf-inline");
		assert.equal(opts.workflowId, "wf-inline");
	});
});

describe("spawnExperimentChildGoal — parent derivation + assertion", () => {
	let h: Harness;
	beforeEach(() => { h = new Harness(); });

	it("derives the parent from owner.goalId", async () => {
		h.owner = { goalId: "exp-goal" };
		await spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts());
		assert.equal(h.createGoalCalls[0].opts.parentGoalId, "exp-goal");
	});

	it("falls back to owner.teamGoalId when goalId is absent", async () => {
		h.owner = { teamGoalId: "exp-goal" };
		await spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts());
		assert.equal(h.createGoalCalls[0].opts.parentGoalId, "exp-goal");
	});

	it("accepts a matching parentGoalId assertion", async () => {
		await spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts({ parentGoalId: "exp-goal" }));
		assert.equal(h.createGoalCalls.length, 1);
	});

	it("rejects a mismatched parentGoalId assertion (PARENT_MISMATCH) without creating a goal", async () => {
		await assert.rejects(
			spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts({ parentGoalId: "some-other-goal" })),
			(err: unknown) => err instanceof SpawnGoalError && err.code === "PARENT_MISMATCH",
		);
		assert.equal(h.createGoalCalls.length, 0);
	});

	it("refuses NO_EFFECTIVE_GOAL when the owner has no goal", async () => {
		h.owner = {};
		await assert.rejects(
			spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts()),
			(err: unknown) => err instanceof SpawnGoalError && err.code === "NO_EFFECTIVE_GOAL",
		);
	});
});

describe("spawnExperimentChildGoal — idempotency", () => {
	it("is idempotent on runKey — the second call returns the first child id with no second createGoal", async () => {
		const h = new Harness();
		const first = await spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts({ runKey: "dup" }));
		const second = await spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts({ runKey: "dup" }));
		assert.equal(second.goalId, first.goalId);
		assert.equal(h.createGoalCalls.length, 1);
		assert.equal(h.startCalls.length, 1);
	});
});

describe("spawnExperimentChildGoal — guard refusals", () => {
	let h: Harness;
	beforeEach(() => { h = new Harness(); });

	it("refuses GOAL_PAUSED when the parent goal is paused", async () => {
		h.goals.get("exp-goal")!.paused = true;
		await assert.rejects(
			spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts()),
			(err: unknown) => err instanceof SpawnGoalError && err.code === "GOAL_PAUSED",
		);
		assert.equal(h.createGoalCalls.length, 0);
	});

	it("refuses SUBGOALS_DISABLED when subgoals are off for the tree", async () => {
		h.prefs = { subgoalsEnabled: false, maxNestingDepth: 3 };
		await assert.rejects(
			spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts()),
			(err: unknown) => err instanceof SpawnGoalError && err.code === "SUBGOALS_DISABLED",
		);
	});

	it("refuses NESTING_DEPTH_EXCEEDED at the depth ceiling", async () => {
		// Parent at depth 3 with ceiling 3 → a child would be depth 4.
		h.goals.set("g-root", { id: "g-root" });
		h.goals.set("g-mid", { id: "g-mid", parentGoalId: "g-root" });
		const parent = h.goals.get("exp-goal")!;
		parent.parentGoalId = "g-mid";
		h.prefs = { subgoalsEnabled: true, maxNestingDepth: 3 };
		await assert.rejects(
			spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts()),
			(err: unknown) => err instanceof SpawnGoalError && err.code === "NESTING_DEPTH_EXCEEDED",
		);
	});

	it("rejects non-plain-object metadata / inlineRoles before createGoal", async () => {
		await assert.rejects(
			spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts({ metadata: [1, 2] as never })),
			(err: unknown) => err instanceof SpawnGoalError && err.code === "INVALID_METADATA",
		);
		await assert.rejects(
			spawnExperimentChildGoal(h.deps(), "owner-1", baseOpts({ inlineRoles: "nope" as never })),
			(err: unknown) => err instanceof SpawnGoalError && err.code === "INVALID_INLINE_ROLES",
		);
		assert.equal(h.createGoalCalls.length, 0);
	});
});
