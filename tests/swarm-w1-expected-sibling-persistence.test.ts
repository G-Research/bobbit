/**
 * SWARM-W1 carry-forward fix (SWARM-W0 tracker note): "expected-sibling set
 * must be persisted at group creation (capture-time scan can fire the
 * barrier early)". design/swarm-orchestration.md §5.2/§14 item 4.
 *
 * Two layers pinned here:
 *   1. `SwarmGroupStore.createGroup` persists `expectedSiblingIds` up
 *      front; `recordArtifact` MUST honour that persisted set over
 *      whatever it's separately handed, so a barrier can never fire
 *      against a set that is still growing.
 *   2. `VerificationHarness._captureSwarmArtifactIfTagged` (exercised via
 *      the public `notifyChildTerminal`) prefers the persisted set over a
 *      fresh `goalStore` scan — reproduced here with a scan that would be
 *      WRONG (missing a third sibling not yet visible to the store) to
 *      prove the persisted set wins.
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
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-w1-expected-set-"));
	stateDir = path.join(tmpRoot, "state");
	fs.mkdirSync(stateDir);
});

describe("SwarmGroupStore.createGroup — persisted expected set wins over recordArtifact's own param", () => {
	it("a group created up-front with 3 expected siblings does NOT fire the barrier on a recordArtifact call scanning only 2 (the stale-scan bug this fix closes)", () => {
		const store = new SwarmGroupStore(stateDir);
		store.createGroup("grp-persisted", ["a", "b", "c"], "root-1");

		// Simulate the OLD bug: a caller passes a scan result that only saw 2 of
		// the 3 real siblings (e.g. sibling "c" hadn't been created yet at scan
		// time). With the fix, this WRONG scan must be ignored in favor of the
		// persisted set.
		const rec = store.recordArtifact(
			"grp-persisted",
			{ goalId: "a", output: "", status: "done", verifierScore: null, capturedAt: Date.now() },
			["a", "b"], // WRONG/stale scan — omits "c"
			"root-1",
		);
		assert.deepEqual(rec.expectedSiblingIds, ["a", "b", "c"], "the persisted set must be untouched by the stale scan param");
		assert.equal(rec.barrierFired, false, "only 1 of the TRUE 3 expected siblings is captured");

		store.recordArtifact("grp-persisted", { goalId: "b", output: "", status: "done", verifierScore: null, capturedAt: Date.now() }, ["a", "b"], "root-1");
		let rec2 = store.get("grp-persisted")!;
		assert.equal(rec2.barrierFired, false, "2 of 3 — still must not fire even though the stale scan thinks the group is exhausted");

		rec2 = store.recordArtifact("grp-persisted", { goalId: "c", output: "", status: "done", verifierScore: null, capturedAt: Date.now() }, ["a", "b"], "root-1");
		assert.equal(rec2.barrierFired, true, "all 3 TRUE siblings now terminal — fires correctly against the persisted set");
	});

	it("createGroup is idempotent — a second call for the same id is a no-op (never resets an in-flight group)", () => {
		const store = new SwarmGroupStore(stateDir);
		const first = store.createGroup("grp-idem", ["a", "b"], "root-1");
		store.recordArtifact("grp-idem", { goalId: "a", output: "", status: "done", verifierScore: null, capturedAt: Date.now() }, ["a", "b"]);
		const second = store.createGroup("grp-idem", ["a", "b", "c"], "root-1"); // different set — must be ignored
		assert.deepEqual(second.expectedSiblingIds, ["a", "b"], "createGroup must not reset an existing group's expected set");
		assert.equal(store.get("grp-idem")!.artifacts.length, 1, "the artifact recorded before the second createGroup call must survive");
	});

	it("a group that never went through createGroup falls back to recordArtifact's own param (legacy / direct callers, incl. SWARM-W0's own pinning tests)", () => {
		const store = new SwarmGroupStore(stateDir);
		const rec = store.recordArtifact("grp-legacy", { goalId: "x", output: "", status: "done", verifierScore: null, capturedAt: Date.now() }, ["x", "y"]);
		assert.deepEqual(rec.expectedSiblingIds, undefined, "recordArtifact alone (no createGroup) does not itself set expectedSiblingIds on the record");
		assert.equal(rec.barrierFired, false, "1 of 2 (the scan-supplied set) — correct legacy behavior preserved byte-for-byte");
	});

	it("recordVerifyResult / recordIntegration persist and survive a fresh store instance over the same stateDir (restart durability)", () => {
		const store1 = new SwarmGroupStore(stateDir);
		store1.createGroup("grp-verify", ["a", "b"], "root-1");
		store1.recordVerifyResult("grp-verify", { outcome: "picked", winnerGoalId: "a", scores: [{ goalId: "a", passed: true, score: 1, exitCode: 0, timedOut: false }], verifiedAt: Date.now() });
		store1.recordIntegration("grp-verify", "a");

		const store2 = new SwarmGroupStore(stateDir);
		const rec = store2.get("grp-verify");
		assert.ok(rec);
		assert.equal(rec!.lastVerify?.outcome, "picked");
		assert.equal(rec!.lastVerify?.winnerGoalId, "a");
		assert.equal(rec!.integratedGoalId, "a");
		assert.equal(typeof rec!.integratedAt, "number");
	});
});

function makeGoal(over: Partial<PersistedGoal> & Pick<PersistedGoal, "id">): PersistedGoal {
	return { title: over.id, cwd: tmpRoot, state: "todo", spec: "", createdAt: 0, updatedAt: 0, ...over };
}

function makeHarness(opts: { goalStore: GoalStore; swarmGroupStore: SwarmGroupStore }) {
	const ctx = { goalStore: opts.goalStore, swarmGroupStore: opts.swarmGroupStore };
	const projectContextManager: any = { getContextForGoal: (_id: string) => ctx };
	const sessionManager: any = { getSessionOutput: async () => "" };
	return new VerificationHarness(
		stateDir, undefined, () => {}, { get: () => null, getAll: () => [] } as any,
		undefined, sessionManager, undefined, undefined, projectContextManager, undefined,
	);
}

describe("VerificationHarness.notifyChildTerminal — prefers the persisted expected set over a live goalStore scan", () => {
	it("a sibling created AFTER two others have already terminated is still counted — the pre-created group's persisted set includes it", async () => {
		const goalStore = new GoalStore(stateDir);
		const swarmGroupStore = new SwarmGroupStore(stateDir);
		// Pre-create the group with all 3 expected siblings BEFORE any of them
		// exist in goalStore yet — mirrors `createBestOfNSwarm` persisting the
		// set immediately after generating ids, before any sibling can start.
		swarmGroupStore.createGroup("grp-early", ["c1", "c2", "c3"], "root");

		goalStore.put(makeGoal({ id: "c1", parentGoalId: "root", rootGoalId: "root", swarmGroup: "grp-early", state: "complete" }));
		goalStore.put(makeGoal({ id: "c2", parentGoalId: "root", rootGoalId: "root", swarmGroup: "grp-early", state: "complete" }));
		// c3 does not exist in goalStore YET when c1/c2 terminate — a live scan
		// at THIS moment would only see c1+c2 and (with the old bug) fire the
		// barrier early.
		const harness = makeHarness({ goalStore, swarmGroupStore });

		await harness.notifyChildTerminal("c1", "done");
		let rec = swarmGroupStore.get("grp-early")!;
		assert.equal(rec.barrierFired, false, "a live scan at this point sees only c1+c2 as ever having existed — must not fire early");

		await harness.notifyChildTerminal("c2", "done");
		rec = swarmGroupStore.get("grp-early")!;
		assert.equal(rec.barrierFired, false, "2 of the TRUE 3 expected siblings — c3 hasn't terminated yet");

		// c3 shows up late (created after c1/c2 already went terminal).
		goalStore.put(makeGoal({ id: "c3", parentGoalId: "root", rootGoalId: "root", swarmGroup: "grp-early", state: "complete" }));
		await harness.notifyChildTerminal("c3", "done");
		rec = swarmGroupStore.get("grp-early")!;
		assert.equal(rec.barrierFired, true, "all 3 TRUE expected siblings now terminal");
	});
});
