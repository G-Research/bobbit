/**
 * Unit tests for the auto-pause side effect of the replan cap.
 *
 * Spec: docs/design/nested-goals.md §14.3 + §4.3.
 *
 * The 5.2 dispatcher (`GoalManager.decideMutation`) already returns
 * `409 { error: "replan-cap" }` when a post-freeze, non-noop mutation
 * would push `replanCount` past 5. 5.4 layers an auto-pause side effect
 * on top: the goal flips to `paused: true` and a `goal_paused
 * { by: "auto-replan-cap" }` event is broadcast.
 *
 * Coverage:
 *   - 5 sequential post-freeze mutations with replanCount 0..4 do NOT
 *     auto-pause (decision varies per matrix; paused stays false).
 *   - 6th mutation (replanCount === 5) returns the `replan-cap` reject
 *     AND flips `paused = true` AND broadcasts exactly one `goal_paused`
 *     event with `by: "auto-replan-cap"`.
 *   - Idempotency: a 7th mutation against the already-paused goal still
 *     returns `replan-cap` but does NOT re-broadcast.
 *   - Without a wired broadcaster the auto-pause still flips
 *     `paused: true` (broadcast is best-effort; persistence is the
 *     source of truth).
 *
 * Filename note: written as `*.test.ts` to run under `tsx --test`,
 * matching the precedent set by `tests/goal-manager-nesting.test.ts`
 * and `tests/plan-mutation.test.ts`.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import type { VerifyStep } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let stateDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-replan-cap-"));
	stateDir = path.join(tmpRoot, "state");
	fs.mkdirSync(stateDir, { recursive: true });
});

function subgoalStep(planId: string, opts: {
	title?: string;
	spec?: string;
	phase?: number;
} = {}): VerifyStep {
	return {
		name: opts.title ?? planId,
		type: "subgoal",
		phase: opts.phase ?? 1,
		subgoal: {
			planId,
			title: opts.title ?? planId,
			spec: opts.spec ?? `# ${planId}\n\nWork on ${planId}.`,
		},
	} as VerifyStep;
}

function seedGoal(store: GoalStore, overrides: Partial<PersistedGoal> = {}): PersistedGoal {
	const g: PersistedGoal = {
		id: overrides.id ?? "g_root",
		title: "Root goal",
		cwd: tmpRoot,
		state: "in-progress",
		spec: "# Root goal\n\nFix everything.\n",
		createdAt: 0,
		updatedAt: 0,
		// balanced policy → fix-up auto-applies (`apply`); expansion still
		// prompts. We use balanced for non-cap mutations so the test exercises
		// the apply path without buffer side effects.
		divergencePolicy: "balanced",
		...overrides,
	};
	store.put(g);
	return g;
}

describe("GoalManager.decideMutation — auto-pause on replan-cap (§14.3)", () => {
	it("5 successful post-freeze mutations do not auto-pause", () => {
		const store = new GoalStore(stateDir);
		const gm = new GoalManager(store);
		const events: any[] = [];
		gm.setBroadcastToGoal((id, ev) => events.push({ id, ev }));

		const goal = seedGoal(store);
		const base: VerifyStep[] = [subgoalStep("p1", { phase: 1 })];

		for (let i = 0; i < 5; i++) {
			// Mutation: append a new leaf at phase 1 (a fix-up under balanced
			// → auto-applies, no buffer, no broadcast). The classifier looks
			// at structural shape; we simulate the post-apply replanCount
			// bump by updating the store between rounds.
			const after: VerifyStep[] = [
				...base,
				...Array.from({ length: i + 1 }, (_, k) => subgoalStep(`p2-${i}-${k}`, { phase: 1 })),
			];
			const decision = gm.decideMutation(goal.id, base, after, true);
			assert.notEqual(
				decision.kind,
				"reject",
				`mutation #${i + 1} (replanCount=${i}) must not be rejected — got ${decision.kind} (${(decision as any).body?.error ?? ""})`,
			);
			// Simulate the server's post-apply bump.
			store.update(goal.id, { replanCount: i + 1 });
		}

		const after5 = store.get(goal.id);
		assert.equal(after5?.replanCount, 5);
		assert.equal(after5?.paused, undefined, "goal must not be paused before the cap is hit");
		assert.equal(events.length, 0, "no goal_paused broadcast before the cap");
	});

	it("6th post-freeze mutation hits cap, auto-pauses, and broadcasts once", () => {
		const store = new GoalStore(stateDir);
		const gm = new GoalManager(store);
		const events: Array<{ id: string; ev: any }> = [];
		gm.setBroadcastToGoal((id, ev) => events.push({ id, ev }));

		const goal = seedGoal(store, { replanCount: 5 });
		const before: VerifyStep[] = [subgoalStep("p1", { phase: 1 })];
		const after: VerifyStep[] = [...before, subgoalStep("p2", { phase: 1 })];

		const decision = gm.decideMutation(goal.id, before, after, true);

		assert.equal(decision.kind, "reject");
		assert.equal((decision as any).status, 409);
		assert.equal((decision as any).body.error, "replan-cap");
		assert.equal((decision as any).body.replanCount, 5);

		const reloaded = store.get(goal.id);
		assert.equal(reloaded?.paused, true, "goal must be paused after the cap is hit");

		assert.equal(events.length, 1, "exactly one broadcast on the cap-hit decision");
		assert.equal(events[0].id, goal.id);
		assert.equal(events[0].ev.type, "goal_paused");
		assert.equal(events[0].ev.goalId, goal.id);
		assert.equal(events[0].ev.by, "auto-replan-cap");
	});

	it("subsequent mutations on an already-paused goal still 409 but do not re-broadcast", () => {
		const store = new GoalStore(stateDir);
		const gm = new GoalManager(store);
		const events: any[] = [];
		gm.setBroadcastToGoal((id, ev) => events.push({ id, ev }));

		// Already paused (e.g. by a prior cap-hit) with replanCount === 5.
		const goal = seedGoal(store, { replanCount: 5, paused: true });
		const before: VerifyStep[] = [subgoalStep("p1", { phase: 1 })];
		const after: VerifyStep[] = [...before, subgoalStep("p2", { phase: 1 })];

		const decision1 = gm.decideMutation(goal.id, before, after, true);
		const decision2 = gm.decideMutation(goal.id, before, after, true);

		assert.equal(decision1.kind, "reject");
		assert.equal((decision1 as any).body.error, "replan-cap");
		assert.equal(decision2.kind, "reject");
		assert.equal((decision2 as any).body.error, "replan-cap");
		// Neither decision should broadcast — paused was already true.
		assert.equal(events.length, 0, `expected 0 broadcasts, got ${events.length}`);
		assert.equal(store.get(goal.id)?.paused, true);
	});

	it("noop mutations at the cap do not pause and do not 409", () => {
		const store = new GoalStore(stateDir);
		const gm = new GoalManager(store);
		const events: any[] = [];
		gm.setBroadcastToGoal((id, ev) => events.push({ id, ev }));

		const goal = seedGoal(store, { replanCount: 6 });
		const same: VerifyStep[] = [subgoalStep("p1", { phase: 1 })];
		const decision = gm.decideMutation(goal.id, same, same, true);

		assert.equal(decision.kind, "apply", "noop is exempt from replan-cap");
		assert.equal(store.get(goal.id)?.paused, undefined);
		assert.equal(events.length, 0);
	});

	it("pre-freeze mutations at the cap are exempt (matrix bypass)", () => {
		const store = new GoalStore(stateDir);
		const gm = new GoalManager(store);
		const events: any[] = [];
		gm.setBroadcastToGoal((id, ev) => events.push({ id, ev }));

		const goal = seedGoal(store, { replanCount: 6 });
		const before: VerifyStep[] = [subgoalStep("p1", { phase: 1 })];
		const after: VerifyStep[] = [...before, subgoalStep("p2", { phase: 1 })];

		// frozen = false → matrix and replan-cap both bypassed.
		const decision = gm.decideMutation(goal.id, before, after, false);
		assert.equal(decision.kind, "apply");
		assert.equal(store.get(goal.id)?.paused, undefined);
		assert.equal(events.length, 0);
	});

	it("auto-pause persists even when no broadcaster is wired", () => {
		const store = new GoalStore(stateDir);
		const gm = new GoalManager(store);
		// Deliberately do NOT call setBroadcastToGoal.

		const goal = seedGoal(store, { replanCount: 5 });
		const before: VerifyStep[] = [subgoalStep("p1", { phase: 1 })];
		const after: VerifyStep[] = [...before, subgoalStep("p2", { phase: 1 })];

		const decision = gm.decideMutation(goal.id, before, after, true);
		assert.equal(decision.kind, "reject");
		assert.equal((decision as any).body.error, "replan-cap");
		assert.equal(store.get(goal.id)?.paused, true, "persistence is the source of truth");
	});
});

describe("GOAL_ASSISTANT_PROMPT — multi-phase recognition heuristic (§14.3)", () => {
	it("includes the parent-workflow heuristic block", async () => {
		const { GOAL_ASSISTANT_PROMPT } = await import("../src/server/agent/goal-assistant.ts");
		assert.ok(
			GOAL_ASSISTANT_PROMPT.includes("Multi-phase work"),
			"prompt must include the multi-phase heuristic heading",
		);
		assert.ok(
			GOAL_ASSISTANT_PROMPT.includes("parent"),
			"prompt must mention the `parent` workflow",
		);
		assert.ok(
			GOAL_ASSISTANT_PROMPT.includes("Parent Goal"),
			"prompt must surface the user-facing 'Parent Goal' label",
		);
		assert.ok(
			GOAL_ASSISTANT_PROMPT.includes("v0.1") || GOAL_ASSISTANT_PROMPT.includes("milestones"),
			"prompt must mention version-style or phase/milestone signals",
		);
		assert.ok(
			GOAL_ASSISTANT_PROMPT.includes("Acceptance criteria"),
			"prompt must instruct adding an Acceptance criteria section",
		);
	});

	it("places the heuristic before the workflow picker so the assistant reads it first", async () => {
		const { GOAL_ASSISTANT_PROMPT } = await import("../src/server/agent/goal-assistant.ts");
		const heur = GOAL_ASSISTANT_PROMPT.indexOf("Multi-phase work");
		const picker = GOAL_ASSISTANT_PROMPT.indexOf("Choosing a workflow");
		assert.ok(heur > -1 && picker > -1);
		assert.ok(heur < picker, "Multi-phase heuristic must precede 'Choosing a workflow'");
	});
});
