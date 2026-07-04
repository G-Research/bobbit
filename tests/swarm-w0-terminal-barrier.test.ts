/**
 * SWARM-W0 — terminal barrier + artifact capture, fired off the EXISTING
 * `notifyChildTerminal` seam (design/swarm-orchestration.md §5.2;
 * docs/design/swarm-orchestration-w0.md).
 *
 * `VerificationHarness.notifyChildTerminal(childGoalId, status)` is called by
 * both existing callers (REST `integrate-child`, the general goal-archive
 * route) at the moment a child goal reaches a terminal state. This wave adds:
 * when the terminating child carries `swarmGroup`, capture a per-sibling
 * artifact into `ctx.swarmGroupStore` and recompute the barrier. A non-swarm
 * child must see ZERO additional effect (no swarm-group record ever created).
 *
 * Constructs a real `VerificationHarness` with a minimal stubbed
 * `projectContextManager` (real `GoalStore` + real `SwarmGroupStore`, both
 * pointed at a tmp stateDir) and a fake `sessionManager.getSessionOutput` —
 * reusing the exact collected-output seam the design mandates, without
 * inventing a new transcript reader.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import { SwarmGroupStore } from "../src/server/agent/swarm-group-store.ts";
import { VerificationHarness } from "../src/server/agent/verification-harness.ts";

let tmpRoot: string;
let stateDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-w0-barrier-"));
	stateDir = path.join(tmpRoot, "state");
	fs.mkdirSync(stateDir);
});

function makeGoal(over: Partial<PersistedGoal> & Pick<PersistedGoal, "id">): PersistedGoal {
	return {
		title: over.id,
		cwd: tmpRoot,
		state: "todo",
		spec: "",
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

function makeHarness(opts: { goalStore: GoalStore; swarmGroupStore: SwarmGroupStore; sessionOutputs?: Record<string, string> }) {
	const ctx = {
		goalStore: opts.goalStore,
		swarmGroupStore: opts.swarmGroupStore,
	};
	const projectContextManager: any = {
		getContextForGoal: (_id: string) => ctx,
	};
	const sessionManager: any = {
		getSessionOutput: async (sessionId: string) => opts.sessionOutputs?.[sessionId] ?? "",
	};
	return new VerificationHarness(
		stateDir,
		undefined,
		() => {},
		{ get: () => null, getAll: () => [] } as any,
		undefined,
		sessionManager,
		undefined,
		undefined,
		projectContextManager,
		undefined,
	);
}

describe("SWARM-W0 — notifyChildTerminal captures a swarm artifact + evaluates the barrier", () => {
	it("zero overhead: a non-swarm child's terminal event creates NO swarm-group record", async () => {
		const goalStore = new GoalStore(stateDir);
		const swarmGroupStore = new SwarmGroupStore(stateDir);
		const child = makeGoal({ id: "plain-child", parentGoalId: "root", state: "complete" });
		goalStore.put(child);
		const harness = makeHarness({ goalStore, swarmGroupStore });

		await harness.notifyChildTerminal("plain-child", "done");

		assert.deepEqual(swarmGroupStore.getAll(), []);
	});

	it("captures one artifact per sibling; the barrier does NOT fire until every sibling in the group is terminal", async () => {
		const goalStore = new GoalStore(stateDir);
		const swarmGroupStore = new SwarmGroupStore(stateDir);
		goalStore.put(makeGoal({
			id: "sib-a", parentGoalId: "root", rootGoalId: "root", state: "complete",
			swarmGroup: "grp-x", teamLeadSessionId: "sess-a", branch: "goal/sib-a",
		}));
		goalStore.put(makeGoal({
			id: "sib-b", parentGoalId: "root", rootGoalId: "root", state: "in-progress",
			swarmGroup: "grp-x", teamLeadSessionId: "sess-b", branch: "goal/sib-b",
		}));
		const harness = makeHarness({
			goalStore, swarmGroupStore,
			sessionOutputs: { "sess-a": "sibling A's distilled output" },
		});

		await harness.notifyChildTerminal("sib-a", "done");

		let rec = swarmGroupStore.get("grp-x");
		assert.ok(rec, "expected a swarm-group record to exist after the first sibling's terminal event");
		assert.equal(rec!.artifacts.length, 1);
		assert.equal(rec!.barrierFired, false, "only 1 of 2 siblings terminal — must not fire yet");

		const artifact = rec!.artifacts[0];
		assert.equal(artifact.goalId, "sib-a");
		assert.equal(artifact.sessionId, "sess-a");
		assert.equal(artifact.output, "sibling A's distilled output");
		assert.equal(artifact.branch, "goal/sib-a");
		assert.equal(artifact.status, "done");
		assert.equal(artifact.verifierScore, null);
		assert.equal(typeof artifact.capturedAt, "number");

		await harness.notifyChildTerminal("sib-b", "failed");
		rec = swarmGroupStore.get("grp-x");
		assert.equal(rec!.artifacts.length, 2);
		assert.equal(rec!.barrierFired, true, "both siblings now terminal — barrier must fire");
		assert.equal(rec!.allFailed, false, "sib-a succeeded (done) — must not be flagged all-failed");
	});

	it("all-failed mix (failed + killed, no done) sets allFailed=true once the barrier fires", async () => {
		const goalStore = new GoalStore(stateDir);
		const swarmGroupStore = new SwarmGroupStore(stateDir);
		goalStore.put(makeGoal({ id: "sib-c", parentGoalId: "root", rootGoalId: "root", swarmGroup: "grp-y" }));
		goalStore.put(makeGoal({ id: "sib-d", parentGoalId: "root", rootGoalId: "root", swarmGroup: "grp-y" }));
		const harness = makeHarness({ goalStore, swarmGroupStore });

		await harness.notifyChildTerminal("sib-c", "failed");
		await harness.notifyChildTerminal("sib-d", "killed");

		const rec = swarmGroupStore.get("grp-y");
		assert.ok(rec);
		assert.equal(rec!.barrierFired, true);
		assert.equal(rec!.allFailed, true, "no sibling succeeded — must surface for human escalation, never silently resolved");
	});

	it("swarm artifact capture failing (e.g. no projectContextManager) does not throw out of notifyChildTerminal (best-effort)", async () => {
		const harness = new VerificationHarness(
			stateDir, undefined, () => {}, { get: () => null, getAll: () => [] } as any,
			undefined, undefined, undefined, undefined, undefined, undefined,
		);
		await assert.doesNotReject(() => harness.notifyChildTerminal("whatever", "done"));
	});
});
