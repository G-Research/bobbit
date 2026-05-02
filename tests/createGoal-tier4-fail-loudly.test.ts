/**
 * Pinned regression: GoalManager.createGoal throws loudly when given
 * `workflowId` but no `workflowStore` and no `resolvedWorkflow`.
 *
 * Live test (PR #409 v0.2-embeddings, context-fencing leaf 48c314fd):
 * `ProjectContext` constructed `GoalManager` without passing the
 * project's `workflowStore` (constructor ordering bug — workflowStore
 * was created on a later line). When the verification harness's
 * `runSubgoalStep` spawned `context-fencing` with `workflowId:
 * "feature"`, createGoal hit Tier-4 (`workflowId && workflowStore`)
 * but `workflowStore` was undefined, so the branch was skipped. The
 * goal landed with `workflow: undefined` and `gates: []`. Keanu Threads
 * (the coder) ran his work and exited cleanly, but the child had no
 * `ready-to-merge` gate, so no signal could ever bubble up to the
 * parent's `runSubgoalStep` wait loop.
 *
 * Result: child goal stuck forever in `state: complete, archived: None,
 * workflow: null, gates: []`. Parent's wait loop polled the missing
 * `ready-to-merge` gate forever.
 *
 * Fix is two-fold:
 *
 *   1. Reorder ProjectContext constructor so `workflowStore` exists
 *      before `goalManager`, and pass it. (Commits where this was
 *      done: see project-context.ts diff at PR #409.)
 *
 *   2. Make createGoal throw at the silent-fallthrough site instead
 *      of silently producing a workflow-less goal. Future regressions
 *      surface at spawn-time, not 30 minutes later when a parent
 *      verification stays stuck on a missing gate.
 *
 * This test pins behavior #2 — the loud-throw contract.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { GoalStore } from "../src/server/agent/goal-store.ts";

function tmpStateDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "createGoal-tier4-fail-"));
	return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

describe("createGoal Tier-4 fail-loudly when workflowId given but no resolution path", () => {
	it("THE bug regression: workflowId without workflowStore AND without resolvedWorkflow throws loudly", async () => {
		const { dir, cleanup } = tmpStateDir();
		try {
			const store = new GoalStore(dir);
			// GoalManager constructed WITHOUT a workflowStore — this is
			// the bug pattern from project-context.ts. Pre-fix, the
			// createGoal call below would silently land a workflow-less
			// goal. Post-fix, it throws.
			const gm = new GoalManager(store);
			await assert.rejects(
				() => gm.createGoal("test goal", dir, { workflowId: "feature" }),
				/no workflowStore wired/,
				"Expected createGoal to throw when workflowId given but no resolution path"
			);
		} finally { cleanup(); }
	});

	it("workflowId + resolvedWorkflow (config-cascade hit) succeeds (no workflowStore needed)", async () => {
		const { dir, cleanup } = tmpStateDir();
		try {
			const store = new GoalStore(dir);
			const gm = new GoalManager(store);
			// Caller passes resolvedWorkflow — Tier 3 — so the missing
			// workflowStore doesn't matter.
			const fakeWorkflow = {
				id: "feature",
				name: "Feature",
				description: "test",
				gates: [{ id: "design-doc", name: "Design Doc", type: "content" as const }],
			};
			const goal = await gm.createGoal("test goal", dir, {
				workflowId: "feature",
				resolvedWorkflow: fakeWorkflow as any,
			});
			assert.equal(goal.workflowId, "feature");
			assert.ok(goal.workflow, "Expected goal.workflow to be set from resolvedWorkflow");
			assert.equal(goal.workflow?.gates.length, 1);
		} finally { cleanup(); }
	});

	it("no workflowId + no workflowStore is allowed (uses 'general' default OR no workflow)", async () => {
		// This case is the existing fallback — silent no-workflow if
		// nothing else resolves. Not the bug we're fixing. Verify it
		// still works (no regression).
		const { dir, cleanup } = tmpStateDir();
		try {
			const store = new GoalStore(dir);
			const gm = new GoalManager(store);
			const goal = await gm.createGoal("test goal", dir, {}); // no workflowId
			// Goal is created; workflow may or may not be set depending
			// on environment — we just verify no throw.
			assert.ok(goal.id, "Expected goal to be created");
		} finally { cleanup(); }
	});
});
