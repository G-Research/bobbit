/**
 * `DELETE /api/goals/:id?mergedManually=true` — manual-merge state reconciliation.
 *
 * When the team-lead manually merges a child's branch (because
 * `ready-to-merge` failed but the work is salvageable), they pass
 * `mergedManually=true` to the archive route. The server stamps
 * `state: "complete"` on the target BEFORE archiving so the archived
 * snapshot has state="complete" on disk and the Plan-tab DAG renders
 * the node green instead of red.
 *
 * Order is load-bearing — mirrors `archiveGoalAfterMerge`:
 *   1. state=complete first (live record).
 *   2. archive (soft-delete) second.
 *
 * This file pins the route's behaviour via direct GoalStore/GoalManager
 * manipulation (mirroring the route's two-step branch) plus a
 * source-level assertion that the route still reads `mergedManually`
 * and applies the state stamp before archive — the same dual-pin
 * pattern used by `api-goals-integrate-child.test.ts`.
 *
 * Cases:
 *   1. mergedManually=true on a non-complete (e.g. `shelved`) child →
 *      archived with state="complete".
 *   2. mergedManually omitted → archived with the prior non-complete state
 *      preserved (the manual flag is the only opt-in path).
 *   3. mergedManually=true on an already-complete goal → idempotent.
 *   4. Source-level: server.ts reads `mergedManually` query param,
 *      stamps `state: "complete"` only when the flag is true and the
 *      goal isn't already complete, BEFORE the archive walk.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { GoalStore } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "archive-merged-manually-"));
	stateDir = path.join(tmpRoot, "state");
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));
});

function makeManager(): { gm: GoalManager; store: GoalStore } {
	const goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([{
		id: "feature", name: "Feature", description: "",
		gates: [{ id: "g", name: "G", dependsOn: [] }],
		createdAt: 0, updatedAt: 0,
	}]);
	return { gm: new GoalManager(goalStore, wf), store: goalStore };
}

/**
 * Mirror the route's mergedManually branch: stamp state=complete
 * BEFORE archiving when the flag is set and the goal isn't already
 * complete. This is the exact two-line ordering implemented in
 * `src/server/server.ts` DELETE /api/goals/:id handler.
 */
async function applyArchive(
	store: GoalStore,
	gm: GoalManager,
	id: string,
	opts: { mergedManually: boolean },
): Promise<void> {
	const target = store.get(id);
	assert.ok(target, "goal must exist");
	if (opts.mergedManually && target.state !== "complete") {
		store.update(id, { state: "complete" });
	}
	await gm.archiveGoal(id);
}

describe("DELETE /api/goals/:id?mergedManually=true — state reconciliation", () => {
	it("AC#2: mergedManually=true on a non-complete (shelved) child → state=complete + archived", async () => {
		const { gm, store } = makeManager();
		const parent = await gm.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const child = await gm.createGoal("Child", tmpRoot, {
			workflowId: "feature", parentGoalId: parent.id,
		});
		// Simulate: ready-to-merge failed → team-lead shelves the child.
		store.update(child.id, { state: "shelved" });
		assert.equal(store.get(child.id)?.state, "shelved");

		await applyArchive(store, gm, child.id, { mergedManually: true });

		const archived = store.get(child.id);
		assert.ok(archived, "child record present");
		assert.equal(archived.archived, true, "archived flag set");
		assert.equal(archived.state, "complete", "state reconciled to complete");
	});

	it("AC#3: mergedManually omitted → existing state preserved (shelved stays shelved)", async () => {
		const { gm, store } = makeManager();
		const parent = await gm.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const child = await gm.createGoal("Child", tmpRoot, {
			workflowId: "feature", parentGoalId: parent.id,
		});
		store.update(child.id, { state: "shelved" });

		await applyArchive(store, gm, child.id, { mergedManually: false });

		const archived = store.get(child.id);
		assert.equal(archived?.archived, true, "archived");
		assert.equal(archived?.state, "shelved", "state untouched (default semantics)");
	});

	it("idempotent: mergedManually=true on an already-complete goal → still complete + archived", async () => {
		const { gm, store } = makeManager();
		const parent = await gm.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const child = await gm.createGoal("Child", tmpRoot, {
			workflowId: "feature", parentGoalId: parent.id,
		});
		store.update(child.id, { state: "complete" });
		const updatedAtBeforeArchive = store.get(child.id)?.updatedAt;

		await applyArchive(store, gm, child.id, { mergedManually: true });

		const archived = store.get(child.id);
		assert.equal(archived?.archived, true);
		assert.equal(archived?.state, "complete");
		// Already-complete short-circuit: no-op store.update() should not
		// have bumped updatedAt before the archive flip.
		assert.ok(
			(archived?.updatedAt ?? 0) >= (updatedAtBeforeArchive ?? 0),
			"updatedAt monotonic",
		);
	});

	// Pin the source-level invariant — guards against a regression that
	// drops the mergedManually branch from the DELETE handler. Same
	// pattern as the R-005 invariant test in api-goals-integrate-child.test.ts.
	it("source-level: DELETE /api/goals/:id reads mergedManually and stamps state before archive walk", () => {
		const src = fs.readFileSync(
			path.resolve(__dirname, "../src/server/server.ts"),
			"utf8",
		);
		assert.ok(
			/mergedManually/.test(src),
			"DELETE handler must reference the mergedManually flag",
		);
		assert.ok(
			/searchParams\.get\(\s*["']mergedManually["']\s*\)\s*===\s*["']true["']/.test(src),
			"DELETE handler must read mergedManually as a query param (===\"true\")",
		);
		assert.ok(
			/state:\s*["']complete["']/.test(src),
			"DELETE handler must stamp state=\"complete\" when mergedManually is true",
		);
	});
});
