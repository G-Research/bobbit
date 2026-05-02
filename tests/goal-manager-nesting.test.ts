/**
 * Phase 1 — Nested goals: GoalManager.createGoal nesting derivation.
 *
 * Verifies:
 *   - Top-level goals (no parentGoalId): rootGoalId === id, mergeTarget === "master".
 *   - Child goals: rootGoalId == parent.rootGoalId (or parent.id if missing),
 *     mergeTarget === "parent".
 *   - Three-generation tree preserves the rootGoalId chain.
 *   - Cycle prevention rejects creation when the new id appears in the parent chain.
 *   - Cycle walk capped at 64 — doesn't infinite-loop on a synthetic 65-deep chain.
 *   - divergencePolicy / maxConcurrentChildren are NOT auto-inherited from parent.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import { GoalManager, deriveNestingFields, NESTING_WALK_DEPTH_CAP } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let configDir: string;
let stateDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-manager-nesting-"));
	configDir = path.join(tmpRoot, "config");
	stateDir = path.join(tmpRoot, "state");
	fs.mkdirSync(configDir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	// Seed an empty project.yaml so the InlineWorkflowStore has something to read.
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));
});

function makeManager(): { gm: GoalManager; store: GoalStore } {
	const goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([{
		id: "general",
		name: "General",
		description: "",
		gates: [{ id: "g", name: "G", dependsOn: [] }],
		createdAt: 0,
		updatedAt: 0,
	}]);
	const gm = new GoalManager(goalStore, wf);
	return { gm, store: goalStore };
}

describe("GoalManager.createGoal — nesting derivation", () => {
	it("top-level goal (no parentGoalId): rootGoalId === id, mergeTarget === 'master'", async () => {
		const { gm } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		assert.equal(root.parentGoalId, undefined);
		assert.equal(root.rootGoalId, root.id);
		assert.equal(root.mergeTarget, "master");
	});

	it("child goal (parentGoalId set): rootGoalId == parent.rootGoalId, mergeTarget === 'parent'", async () => {
		const { gm } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		const child = await gm.createGoal("Child", tmpRoot, {
			workflowId: "general",
			parentGoalId: root.id,
		});
		assert.equal(child.parentGoalId, root.id);
		assert.equal(child.rootGoalId, root.id);
		assert.equal(child.mergeTarget, "parent");
	});

	it("three-generation tree (root → child → grandchild): grandchild.rootGoalId === root.id", async () => {
		const { gm } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		const child = await gm.createGoal("Child", tmpRoot, {
			workflowId: "general",
			parentGoalId: root.id,
		});
		const grand = await gm.createGoal("Grand", tmpRoot, {
			workflowId: "general",
			parentGoalId: child.id,
		});
		assert.equal(grand.parentGoalId, child.id);
		assert.equal(grand.rootGoalId, root.id);
		assert.equal(grand.mergeTarget, "parent");
		// Sanity: child's chain still points at root.
		assert.equal(child.rootGoalId, root.id);
	});

	it("child of a parent that is missing rootGoalId falls back to parent.id", async () => {
		// Simulates a legacy parent record loaded from a pre-Phase-1 goals.json
		// (rootGoalId=undefined). The fallback rule guarantees the chain links.
		const { gm, store } = makeManager();
		// Direct store write to bypass createGoal so the legacy parent has no
		// rootGoalId.
		const legacyParent: PersistedGoal = {
			id: "legacy-parent",
			title: "Legacy parent",
			cwd: tmpRoot,
			state: "in-progress",
			spec: "",
			createdAt: 1,
			updatedAt: 1,
			team: true,
		};
		store.put(legacyParent);
		const child = await gm.createGoal("Child of legacy", tmpRoot, {
			workflowId: "general",
			parentGoalId: legacyParent.id,
		});
		assert.equal(child.rootGoalId, legacyParent.id);
		assert.equal(child.mergeTarget, "parent");
	});

	it("rejects unknown parentGoalId", async () => {
		const { gm } = makeManager();
		await assert.rejects(
			() => gm.createGoal("Orphan", tmpRoot, {
				workflowId: "general",
				parentGoalId: "does-not-exist",
			}),
			/parentGoalId="does-not-exist" not found/,
		);
	});
});

describe("GoalManager.createGoal — cycle prevention", () => {
	it("does not infinite-loop on a deeper-than-cap synthetic chain", async () => {
		const { gm, store } = makeManager();
		// Build a chain longer than the cap (cap + 2 records) so a naïve
		// walk would visit more than NESTING_WALK_DEPTH_CAP records.
		// The walk must still terminate quickly.
		const N = NESTING_WALK_DEPTH_CAP + 2;
		for (let i = 0; i < N; i++) {
			const id = `chain-${i}`;
			const goal: PersistedGoal = {
				id,
				title: `Chain ${i}`,
				cwd: tmpRoot,
				state: "todo",
				spec: "",
				createdAt: i,
				updatedAt: i,
				...(i === 0
					? { rootGoalId: id, mergeTarget: "master" as const }
					: {
						parentGoalId: `chain-${i - 1}`,
						rootGoalId: "chain-0",
						mergeTarget: "parent" as const,
					}),
			};
			store.put(goal);
		}

		const start = Date.now();
		const newChild = await gm.createGoal("Tip", tmpRoot, {
			workflowId: "general",
			parentGoalId: `chain-${N - 1}`,
		});
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 2000, `createGoal must terminate quickly even on deep chains (took ${elapsed}ms)`);
		assert.equal(newChild.rootGoalId, "chain-0");
		assert.equal(newChild.mergeTarget, "parent");
	});

	it("does not infinite-loop on a self-referential ancestor (loop in store)", async () => {
		// A corrupt store record with parentGoalId === id is a self-loop.
		// The walk must terminate (via the depth cap) instead of spinning.
		const { store } = makeManager();
		store.put({
			id: "loop", title: "Loop", cwd: tmpRoot, state: "todo", spec: "",
			createdAt: 1, updatedAt: 1,
			parentGoalId: "loop", rootGoalId: "loop", mergeTarget: "parent",
		});
		const start = Date.now();
		const result = deriveNestingFields("new-id-123", "loop", (id) => store.get(id));
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 500, `walk must terminate via depth cap (took ${elapsed}ms)`);
		assert.equal(result.parentGoalId, "loop");
		assert.equal(result.rootGoalId, "loop");
		assert.equal(result.mergeTarget, "parent");
	});

	it("rejects when the new goal's id already appears in the ancestor chain", () => {
		// Direct test of deriveNestingFields: build a chain a -> b -> c, then
		// ask to create a new goal whose id == "a" and parent == "c". The
		// walk reaches "a" in the chain and must throw.
		const lookup = (id: string): PersistedGoal | undefined => {
			const records: Record<string, PersistedGoal> = {
				a: { id: "a", title: "A", cwd: "/", state: "todo", spec: "", createdAt: 1, updatedAt: 1, rootGoalId: "a", mergeTarget: "master" },
				b: { id: "b", title: "B", cwd: "/", state: "todo", spec: "", createdAt: 2, updatedAt: 2, parentGoalId: "a", rootGoalId: "a", mergeTarget: "parent" },
				c: { id: "c", title: "C", cwd: "/", state: "todo", spec: "", createdAt: 3, updatedAt: 3, parentGoalId: "b", rootGoalId: "a", mergeTarget: "parent" },
			};
			return records[id];
		};
		assert.throws(
			() => deriveNestingFields("a", "c", lookup),
			/Cycle detected: parent c already has a in its ancestor chain/,
		);
	});

	it("self-cycle: rejects when newId matches the parent itself", () => {
		const lookup = (id: string): PersistedGoal | undefined => {
			if (id === "x") return { id: "x", title: "X", cwd: "/", state: "todo", spec: "", createdAt: 1, updatedAt: 1, rootGoalId: "x", mergeTarget: "master" };
			return undefined;
		};
		assert.throws(
			() => deriveNestingFields("x", "x", lookup),
			/Cycle detected: parent x already has x in its ancestor chain/,
		);
	});

	it("deriveNestingFields: top-level (no parent) → rootGoalId === newId, mergeTarget === 'master'", () => {
		const result = deriveNestingFields("brand-new", undefined, () => undefined);
		assert.equal(result.parentGoalId, undefined);
		assert.equal(result.rootGoalId, "brand-new");
		assert.equal(result.mergeTarget, "master");
	});

	it("deriveNestingFields: missing parent throws clearly", () => {
		assert.throws(
			() => deriveNestingFields("new", "missing-parent", () => undefined),
			/parentGoalId="missing-parent" not found/,
		);
	});
});

describe("GoalManager.createGoal — divergencePolicy / maxConcurrentChildren are NOT auto-inherited", () => {
	it("child goal does not inherit root's divergencePolicy", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		// Stamp root with a non-default policy AFTER creation (root-only
		// semantics — written by REST or the team-lead, not by createGoal).
		store.update(root.id, { divergencePolicy: "strict", maxConcurrentChildren: 7 });

		const child = await gm.createGoal("Child", tmpRoot, {
			workflowId: "general",
			parentGoalId: root.id,
		});
		assert.equal(child.divergencePolicy, undefined,
			"child must NOT inherit root.divergencePolicy");
		assert.equal(child.maxConcurrentChildren, undefined,
			"child must NOT inherit root.maxConcurrentChildren");
	});

	// The current createGoal API does not accept divergencePolicy /
	// maxConcurrentChildren on the opts object — those fields are root-only
	// and stamped via REST. Sub-goals can persist their own value (forward
	// compat) but it's inert. Verified at the data layer in
	// goal-store-nesting.test.ts.
	it("child goal that has a non-default policy stored on disk keeps the value (inert, forward-compat)", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		const child = await gm.createGoal("Child", tmpRoot, {
			workflowId: "general",
			parentGoalId: root.id,
		});
		// Direct store write — simulating a future REST endpoint stamping
		// divergencePolicy on a sub-goal. The harness ignores it; we just
		// verify it round-trips.
		store.update(child.id, { divergencePolicy: "autonomous", maxConcurrentChildren: 8 });
		const reloaded = store.get(child.id);
		assert.equal(reloaded?.divergencePolicy, "autonomous");
		assert.equal(reloaded?.maxConcurrentChildren, 8);
	});
});
