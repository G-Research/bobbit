/**
 * Unit tests for the plan-mutation classifier.
 *
 * See `docs/design/nested-goals.md` §4 and
 * `src/server/agent/plan-mutation.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyMutation } from "../src/server/agent/plan-mutation.ts";
import type { VerifyStep } from "../src/server/agent/workflow-store.ts";
import type { PersistedGoal } from "../src/server/agent/goal-store.ts";

// ── Test fixtures ───────────────────────────────────────────────────────

function makeRoot(overrides: Partial<PersistedGoal> = {}): PersistedGoal {
	return {
		id: "g_root",
		title: "Root goal",
		cwd: "/tmp/wt",
		state: "in-progress",
		spec: "# Root goal\n\nBuild the agent-memory v0.1 schema.\n",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function subgoalStep(planId: string, opts: {
	title?: string;
	spec?: string;
	phase?: number;
	workflowId?: string;
} = {}): VerifyStep {
	return {
		name: opts.title ?? planId,
		type: "subgoal",
		phase: opts.phase ?? 1,
		subgoal: {
			planId,
			title: opts.title ?? planId,
			spec: opts.spec ?? `# ${planId}\n\nWork on ${planId}.`,
			workflowId: opts.workflowId,
		},
	};
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("classifyMutation", () => {
	describe("noop", () => {
		it("classifies identical plan as noop", () => {
			const a = subgoalStep("p1", { phase: 1 });
			const b = subgoalStep("p2", { phase: 2 });
			const root = makeRoot();
			const out = classifyMutation([a, b], [a, b], root);
			assert.equal(out.cls, "noop");
			assert.deepEqual(out.addedNodes, []);
			assert.deepEqual(out.removedNodes, []);
			assert.deepEqual(out.droppedCriteria, []);
			assert.equal(out.changedDeps, false);
		});

		it("classifies empty before + empty after as noop", () => {
			const out = classifyMutation([], [], makeRoot());
			assert.equal(out.cls, "noop");
		});

		it("does not flag criteria-drop on noop even with uncovered criteria", () => {
			// Adherence check is skipped for noop — design doc §4.1 priority order.
			const a = subgoalStep("p1");
			const root = makeRoot({
				spec: "# Root goal\n",
				acceptanceCriteria: ["unrelated criterion that is long enough to anchor"],
			});
			const out = classifyMutation([a], [a], root);
			assert.equal(out.cls, "noop");
			assert.deepEqual(out.droppedCriteria, []);
		});
	});

	describe("fix-up", () => {
		it("classifies an added leaf at an existing phase as fix-up", () => {
			const before = [
				subgoalStep("p1", { phase: 1 }),
				subgoalStep("p2", { phase: 2 }),
			];
			const after = [
				...before,
				subgoalStep("p3", { phase: 2, title: "extra leaf" }),
			];
			const out = classifyMutation(before, after, makeRoot());
			assert.equal(out.cls, "fix-up");
			assert.deepEqual(out.addedNodes, ["extra leaf"]);
			assert.deepEqual(out.removedNodes, []);
			assert.equal(out.changedDeps, false);
			assert.match(out.summary, /leaf subgoal/i);
		});

		it("classifies multiple leaves at existing phases as fix-up", () => {
			const before = [subgoalStep("p1", { phase: 1 })];
			const after = [
				...before,
				subgoalStep("p2", { phase: 1, title: "leaf-a" }),
				subgoalStep("p3", { phase: 1, title: "leaf-b" }),
			];
			const out = classifyMutation(before, after, makeRoot());
			assert.equal(out.cls, "fix-up");
			assert.equal(out.addedNodes.length, 2);
		});
	});

	describe("expansion", () => {
		it("classifies empty before + non-empty after as expansion (pre-freeze proposal)", () => {
			const after = [subgoalStep("p1", { phase: 1, title: "first" })];
			const out = classifyMutation([], after, makeRoot());
			assert.equal(out.cls, "expansion");
			assert.deepEqual(out.addedNodes, ["first"]);
		});

		it("classifies a new top-level branch (phase > max(before)) as expansion", () => {
			const before = [
				subgoalStep("p1", { phase: 1 }),
				subgoalStep("p2", { phase: 2 }),
			];
			const after = [
				...before,
				subgoalStep("p3", { phase: 3, title: "new branch" }),
			];
			const out = classifyMutation(before, after, makeRoot());
			assert.equal(out.cls, "expansion");
			assert.deepEqual(out.addedNodes, ["new branch"]);
			assert.equal(out.changedDeps, false);
		});
	});

	describe("restructure", () => {
		it("classifies a removed node as restructure", () => {
			const before = [
				subgoalStep("p1", { phase: 1, title: "alpha" }),
				subgoalStep("p2", { phase: 2, title: "beta" }),
			];
			const after = [before[0]];
			const out = classifyMutation(before, after, makeRoot());
			assert.equal(out.cls, "restructure");
			assert.deepEqual(out.removedNodes, ["beta"]);
			assert.deepEqual(out.addedNodes, []);
		});

		it("classifies a phase change on a survivor as restructure", () => {
			const before = [
				subgoalStep("p1", { phase: 1 }),
				subgoalStep("p2", { phase: 2 }),
			];
			const after = [
				before[0],
				subgoalStep("p2", { phase: 3 }), // moved
			];
			const out = classifyMutation(before, after, makeRoot());
			assert.equal(out.cls, "restructure");
			assert.equal(out.changedDeps, true);
		});

		it("classifies a workflowId change on a survivor as restructure", () => {
			const before = [subgoalStep("p1", { phase: 1, workflowId: "feature" })];
			const after = [subgoalStep("p1", { phase: 1, workflowId: "bug-fix" })];
			const out = classifyMutation(before, after, makeRoot());
			assert.equal(out.cls, "restructure");
			assert.equal(out.changedDeps, true);
		});

		it("removed node + added node together is restructure (removal dominates)", () => {
			const before = [subgoalStep("p1", { phase: 1, title: "old" })];
			const after = [subgoalStep("p2", { phase: 1, title: "new" })];
			const out = classifyMutation(before, after, makeRoot());
			assert.equal(out.cls, "restructure");
			assert.deepEqual(out.removedNodes, ["old"]);
			assert.deepEqual(out.addedNodes, ["new"]);
		});
	});

	describe("criteria-drop", () => {
		it("flags an uncovered criterion as criteria-drop", () => {
			// The criterion is not in rootSpec and not in any after subgoal spec.
			const before = [subgoalStep("p1", { phase: 1, spec: "covers nothing relevant" })];
			const after = [
				...before,
				subgoalStep("p2", { phase: 1, title: "extra", spec: "also off-topic" }),
			];
			const root = makeRoot({
				spec: "# Root\nUnrelated prose only.",
				acceptanceCriteria: [
					"User can configure the per-row timeout slider correctly",
				],
			});
			const out = classifyMutation(before, after, root);
			assert.equal(out.cls, "criteria-drop");
			assert.deepEqual(out.droppedCriteria, [
				"User can configure the per-row timeout slider correctly",
			]);
			assert.match(out.summary, /Drops coverage/);
		});

		it("does not drop when the criterion appears verbatim in the root spec", () => {
			const before: VerifyStep[] = [];
			const after = [subgoalStep("p1", { phase: 1, spec: "off-topic" })];
			const root = makeRoot({
				spec: "# Root\n- A user can configure a timeout slider correctly.\n",
				acceptanceCriteria: ["A user can configure a timeout slider correctly."],
			});
			const out = classifyMutation(before, after, root);
			assert.equal(out.cls, "expansion");
			assert.deepEqual(out.droppedCriteria, []);
		});

		it("does not drop when the criterion appears in an after subgoal spec", () => {
			const before = [subgoalStep("p1", { phase: 1 })];
			const after = [
				...before,
				subgoalStep("p2", {
					phase: 1,
					title: "covers it",
					spec: "We will implement: configure the per-row timeout slider correctly here.",
				}),
			];
			const root = makeRoot({
				spec: "# Root\nUnrelated prose only.",
				acceptanceCriteria: ["configure the per-row timeout slider correctly"],
			});
			const out = classifyMutation(before, after, root);
			assert.equal(out.cls, "fix-up");
			assert.deepEqual(out.droppedCriteria, []);
		});

		it("auto-passes criteria shorter than 8 normalised chars", () => {
			const before: VerifyStep[] = [];
			const after = [subgoalStep("p1", { phase: 1, spec: "off-topic" })];
			const root = makeRoot({
				spec: "# Root\nUnrelated prose only.",
				// 7-char criterion + lots of whitespace → still 7 chars after normalise.
				acceptanceCriteria: ["  fast   ui  "],
			});
			const out = classifyMutation(before, after, root);
			assert.equal(out.cls, "expansion");
			assert.deepEqual(out.droppedCriteria, []);
		});

		it("matches case-insensitively across whitespace differences", () => {
			const before: VerifyStep[] = [];
			const after = [
				subgoalStep("p1", {
					phase: 1,
					spec: "Will   IMPLEMENT  the\n\tper-row\ttimeout slider\nproperly",
				}),
			];
			const root = makeRoot({
				spec: "# Root",
				// Different whitespace + different case from the after spec.
				acceptanceCriteria: ["per-row timeout slider"],
			});
			const out = classifyMutation(before, after, root);
			assert.equal(out.cls, "expansion");
			assert.deepEqual(out.droppedCriteria, []);
		});

		it("flags drop when coverage was only in a removed step", () => {
			// The criterion was satisfied by a subgoal that is now being removed,
			// and no other surviving subgoal covers it.
			const before = [
				subgoalStep("p1", {
					phase: 1,
					title: "covering",
					spec: "Implements the per-row timeout slider correctly.",
				}),
			];
			const after: VerifyStep[] = [];
			const root = makeRoot({
				spec: "# Root\nUnrelated prose.",
				acceptanceCriteria: ["per-row timeout slider correctly"],
			});
			const out = classifyMutation(before, after, root);
			// Removal alone classifies as restructure; criteria-drop overrides
			// because the previously-covering subgoal is no longer in `after`.
			assert.equal(out.cls, "criteria-drop");
			assert.deepEqual(out.removedNodes, ["covering"]);
			assert.deepEqual(out.droppedCriteria, ["per-row timeout slider correctly"]);
		});

		it("reports multiple dropped criteria when several are uncovered", () => {
			const before: VerifyStep[] = [];
			const after = [subgoalStep("p1", { phase: 1, spec: "off-topic" })];
			const root = makeRoot({
				spec: "# Root",
				acceptanceCriteria: [
					"the very first acceptance criterion text",
					"the very second acceptance criterion text",
				],
			});
			const out = classifyMutation(before, after, root);
			assert.equal(out.cls, "criteria-drop");
			assert.equal(out.droppedCriteria.length, 2);
		});
	});

	describe("non-subgoal verify steps are ignored", () => {
		it("ignores command-type steps in before/after", () => {
			const cmdStep: VerifyStep = { name: "build", type: "command", run: "npm run build" };
			const sg = subgoalStep("p1", { phase: 1 });
			const before = [cmdStep, sg];
			const after = [cmdStep, sg];
			const out = classifyMutation(before, after, makeRoot());
			assert.equal(out.cls, "noop");
		});

		it("treats added command-type step alone as noop (no plan-level change)", () => {
			const cmdStep: VerifyStep = { name: "extra", type: "command", run: "echo hi" };
			const sg = subgoalStep("p1", { phase: 1 });
			const before = [sg];
			const after = [sg, cmdStep];
			const out = classifyMutation(before, after, makeRoot());
			assert.equal(out.cls, "noop");
		});
	});

	describe("MutationDiff.summary", () => {
		it("includes node labels in the summary text", () => {
			const before: VerifyStep[] = [];
			const after = [subgoalStep("p1", { phase: 1, title: "Build schema" })];
			const out = classifyMutation(before, after, makeRoot());
			assert.match(out.summary, /Build schema/);
		});

		it("renders a noop summary as 'No structural changes'", () => {
			const out = classifyMutation([], [], makeRoot());
			assert.equal(out.summary, "No structural changes.");
		});
	});
});
