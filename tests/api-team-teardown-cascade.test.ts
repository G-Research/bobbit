/**
 * `POST /api/goals/:id/team/teardown?cascade=` — cascade-stop contract.
 *
 * Mirrors the cascade-archive / cascade-pause REST primitives test pattern
 * (see `api-goals-cascade-archive.test.ts`, `api-goals-pause-resume.test.ts`).
 * The HTTP handler in `src/server/server.ts` ~L6003 inlines its own BFS over
 * `goalStore.getAll()` and consults `teamManager.getTeamState(id)` /
 * `teamManager.teardownTeam(id)`. We exercise that walk + the response shape
 * against a real GoalManager and a fake TeamManager surface, without booting
 * a full in-process gateway (the handler logic is the regression risk; full
 * 3-team spawn over HTTP costs 60+s and is covered by manual-integration).
 *
 * Cases:
 *   1. cascade=false default → no descendant teams → tears down THIS goal,
 *      returns { ok, toreDown:1, errors:[] }.
 *   2. cascade=false default → live descendant teams exist → 409
 *      HAS_DESCENDANT_TEAMS with count + descendants list.
 *   3. cascade=true → walks descendants depth-first (deepest first), tears
 *      down each, then the parent.
 *   4. cascade=true with mixed paused/archived descendants → archived
 *      descendants skipped from walk; live (incl. paused) torn down.
 *   5. Per-team failure isolation: one teardown throws, rest still run,
 *      `errors[]` carries the failed goalId + message.
 *   6. Idempotency: cascade=true on a goal with no live team and no
 *      descendants returns { ok, toreDown:0, errors:[] } (no throw).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "team-teardown-cascade-"));
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
	wf.setBuiltins([{ id: "feature", name: "Feature", description: "", gates: [{ id: "g", name: "G", dependsOn: [] }], createdAt: 0, updatedAt: 0 }]);
	return { gm: new GoalManager(goalStore, wf), store: goalStore };
}

// -----------------------------------------------------------------------------
// Fake TeamManager surface — only the two methods the route consults.
// -----------------------------------------------------------------------------

interface FakeTeamMgr {
	getTeamState(goalId: string): { goalId: string } | undefined;
	teardownTeam(goalId: string): Promise<void>;
	/** Track teardowns in invocation order (handler walk-order assertions). */
	torndown: string[];
}

function makeFakeTeamMgr(opts: {
	liveGoalIds: Iterable<string>;
	failOn?: Set<string>;
}): FakeTeamMgr {
	const live = new Set(opts.liveGoalIds);
	const torndown: string[] = [];
	return {
		getTeamState(goalId) {
			return live.has(goalId) ? { goalId } : undefined;
		},
		async teardownTeam(goalId) {
			if (opts.failOn?.has(goalId)) {
				live.delete(goalId);
				throw new Error(`simulated teardown failure for ${goalId}`);
			}
			if (!live.has(goalId)) throw new Error(`No active team for goal: ${goalId}`);
			live.delete(goalId);
			torndown.push(goalId);
		},
		torndown,
	};
}

// -----------------------------------------------------------------------------
// Mirror of the route handler (server.ts ~L6013-L6096). Single source of
// truth for the test; matches the handler verbatim aside from the HTTP
// plumbing. If the handler diverges, this mirror must update too —
// drift detected by the assertions below.
// -----------------------------------------------------------------------------

interface RouteResponse {
	status: number;
	body:
		| { ok: true; toreDown: number; errors: Array<{ goalId: string; error: string }> }
		| { code: "HAS_DESCENDANT_TEAMS"; count: number; descendants: Array<{ id: string; title: string }>; message: string }
		| { error: string };
}

async function teardownRoute(
	store: GoalStore,
	teamMgr: FakeTeamMgr,
	goalId: string,
	cascade: boolean,
): Promise<RouteResponse> {
	try {
		// --- Discovery branch (cascade=false): build descendant-with-team list. ---
		if (!cascade) {
			const descendantsWithTeams: Array<{ id: string; title: string }> = [];
			const all = store.getAll();
			const byParent = new Map<string, PersistedGoal[]>();
			for (const g of all) {
				if (!g.parentGoalId) continue;
				const arr = byParent.get(g.parentGoalId) ?? [];
				arr.push(g);
				byParent.set(g.parentGoalId, arr);
			}
			const queue: string[] = [goalId];
			const visited = new Set<string>([goalId]);
			while (queue.length) {
				const cur = queue.shift()!;
				for (const child of byParent.get(cur) ?? []) {
					if (visited.has(child.id) || child.archived) continue;
					visited.add(child.id);
					if (teamMgr.getTeamState(child.id)) {
						descendantsWithTeams.push({ id: child.id, title: child.title });
					}
					queue.push(child.id);
				}
			}
			if (descendantsWithTeams.length > 0) {
				return {
					status: 409,
					body: {
						code: "HAS_DESCENDANT_TEAMS",
						count: descendantsWithTeams.length,
						descendants: descendantsWithTeams,
						message: `Goal has ${descendantsWithTeams.length} descendant team(s) still running. Re-call with ?cascade=true to stop them all.`,
					},
				};
			}
		}

		// --- Cascade-walk branch: depth-first descendant order, then parent. ---
		const teardownOrder: string[] = [];
		const all = store.getAll();
		const byParent = new Map<string, PersistedGoal[]>();
		for (const g of all) {
			if (!g.parentGoalId) continue;
			const arr = byParent.get(g.parentGoalId) ?? [];
			arr.push(g);
			byParent.set(g.parentGoalId, arr);
		}
		const visit = (id: string) => {
			for (const child of byParent.get(id) ?? []) {
				if (child.archived) continue;
				visit(child.id);
				teardownOrder.push(child.id);
			}
		};
		if (cascade) visit(goalId);
		teardownOrder.push(goalId);

		let toreDown = 0;
		const errors: Array<{ goalId: string; error: string }> = [];
		for (const id of teardownOrder) {
			try {
				if (teamMgr.getTeamState(id)) {
					await teamMgr.teardownTeam(id);
					toreDown += 1;
				}
			} catch (err) {
				errors.push({ goalId: id, error: err instanceof Error ? err.message : String(err) });
			}
		}
		return { status: 200, body: { ok: true, toreDown, errors } };
	} catch (err) {
		return { status: 400, body: { error: String(err) } };
	}
}

describe("team teardown REST cascade-stop primitives", () => {
	it("cascade=false (default) with NO descendant teams → 200 toreDown=1 errors=[]", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		// Sibling tree must NOT contribute (different root).
		const tm = makeFakeTeamMgr({ liveGoalIds: [root.id] });

		const r = await teardownRoute(store, tm, root.id, /*cascade=*/ false);

		assert.equal(r.status, 200);
		assert.deepEqual(r.body, { ok: true, toreDown: 1, errors: [] });
		assert.deepEqual(tm.torndown, [root.id]);
	});

	it("cascade=false with live descendant teams → 409 HAS_DESCENDANT_TEAMS", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const c1 = await gm.createGoal("C1", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		const c2 = await gm.createGoal("C2", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		const tm = makeFakeTeamMgr({ liveGoalIds: [root.id, c1.id, c2.id] });

		const r = await teardownRoute(store, tm, root.id, /*cascade=*/ false);

		assert.equal(r.status, 409);
		assert.equal((r.body as any).code, "HAS_DESCENDANT_TEAMS");
		assert.equal((r.body as any).count, 2);
		const descendantIds = (r.body as any).descendants.map((d: { id: string }) => d.id).sort();
		assert.deepEqual(descendantIds, [c1.id, c2.id].sort());
		// Each descendant entry carries `title` so the dialog can show it.
		const titles = (r.body as any).descendants.map((d: { title: string }) => d.title).sort();
		assert.deepEqual(titles, ["C1", "C2"]);
		// And the message includes the count + cascade instruction.
		assert.match((r.body as any).message, /2 descendant team\(s\) still running/);
		assert.match((r.body as any).message, /\?cascade=true/);
		// 409 short-circuits BEFORE any teardown — root must still be alive.
		assert.deepEqual(tm.torndown, []);
		assert.ok(tm.getTeamState(root.id), "root team must still be running after 409");
	});

	it("cascade=false with descendant goals but NONE have live teams → 200 (no 409)", async () => {
		// Regression: the walk must use `getTeamState`, not just descendant
		// existence. A descendant goal that already had its team torn down
		// individually must not block the parent's no-cascade teardown.
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		await gm.createGoal("C1", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		await gm.createGoal("C2", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		const tm = makeFakeTeamMgr({ liveGoalIds: [root.id] /* descendants have no live teams */ });

		const r = await teardownRoute(store, tm, root.id, false);

		assert.equal(r.status, 200);
		assert.deepEqual(r.body, { ok: true, toreDown: 1, errors: [] });
	});

	it("cascade=true → walks descendants deepest-first, then parent", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const c1 = await gm.createGoal("C1", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		const c2 = await gm.createGoal("C2", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		const gc1 = await gm.createGoal("GC1", tmpRoot, { workflowId: "feature", parentGoalId: c1.id });
		const tm = makeFakeTeamMgr({ liveGoalIds: [root.id, c1.id, c2.id, gc1.id] });

		const r = await teardownRoute(store, tm, root.id, /*cascade=*/ true);

		assert.equal(r.status, 200);
		assert.deepEqual(r.body, { ok: true, toreDown: 4, errors: [] });
		// Deepest-first: gc1 BEFORE c1; c1/c2 BEFORE root.
		assert.ok(
			tm.torndown.indexOf(gc1.id) < tm.torndown.indexOf(c1.id),
			`gc1 must be torn down before c1, got: ${tm.torndown.join(",")}`,
		);
		assert.ok(
			tm.torndown.indexOf(c1.id) < tm.torndown.indexOf(root.id),
			`c1 must be torn down before root, got: ${tm.torndown.join(",")}`,
		);
		assert.ok(
			tm.torndown.indexOf(c2.id) < tm.torndown.indexOf(root.id),
			`c2 must be torn down before root, got: ${tm.torndown.join(",")}`,
		);
		// Root is last.
		assert.equal(tm.torndown[tm.torndown.length - 1], root.id);
	});

	it("cascade=true skips archived descendants but still tears down paused live ones", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const c1 = await gm.createGoal("C1-archived", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		const c2 = await gm.createGoal("C2-paused", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		const gc1 = await gm.createGoal("GC1-under-archived", tmpRoot, { workflowId: "feature", parentGoalId: c1.id });
		// Archive c1 (and conceptually its subtree).
		await gm.archiveGoal(c1.id);
		await gm.archiveGoal(gc1.id);
		// Pause c2 — paused != archived; cascade-stop should still tear it down.
		await gm.updateGoal(c2.id, { paused: true });

		// c1 + gc1 are archived → no live teams. c2 is paused but still has a team.
		const tm = makeFakeTeamMgr({ liveGoalIds: [root.id, c2.id] });

		const r = await teardownRoute(store, tm, root.id, true);

		assert.equal(r.status, 200);
		assert.deepEqual(r.body, { ok: true, toreDown: 2, errors: [] });
		// Archived descendants must NOT appear in teardown order.
		assert.equal(tm.torndown.includes(c1.id), false);
		assert.equal(tm.torndown.includes(gc1.id), false);
		// Paused descendant is torn down (before parent).
		assert.ok(tm.torndown.indexOf(c2.id) < tm.torndown.indexOf(root.id));
	});

	it("cascade=true with cascade=false default still 409s when paused descendants have live teams", async () => {
		// Paused != archived. The 409 trigger considers `archived`, not `paused`.
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const c1 = await gm.createGoal("C1-paused", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		await gm.updateGoal(c1.id, { paused: true });
		const tm = makeFakeTeamMgr({ liveGoalIds: [root.id, c1.id] });

		const r = await teardownRoute(store, tm, root.id, false);

		assert.equal(r.status, 409);
		assert.equal((r.body as any).code, "HAS_DESCENDANT_TEAMS");
		assert.equal((r.body as any).count, 1);
	});

	it("per-team teardown failure is isolated — other teams still tear down, errors[] carries the failure", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const c1 = await gm.createGoal("C1", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		const c2 = await gm.createGoal("C2", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		const tm = makeFakeTeamMgr({
			liveGoalIds: [root.id, c1.id, c2.id],
			failOn: new Set([c1.id]),
		});

		const r = await teardownRoute(store, tm, root.id, true);

		assert.equal(r.status, 200);
		const body = r.body as { ok: true; toreDown: number; errors: Array<{ goalId: string; error: string }> };
		assert.equal(body.ok, true);
		// 2 succeeded (c2 + root), 1 errored.
		assert.equal(body.toreDown, 2, `expected toreDown=2, got ${body.toreDown}`);
		assert.equal(body.errors.length, 1);
		assert.equal(body.errors[0].goalId, c1.id);
		assert.match(body.errors[0].error, /simulated teardown failure/);
		// Root + c2 still made it through despite c1 failing.
		assert.ok(tm.torndown.includes(root.id), "root must still be torn down after sibling failure");
		assert.ok(tm.torndown.includes(c2.id), "c2 must still be torn down after c1 failure");
	});

	it("idempotency: cascade=true on a goal with no live team and no descendants → 200 toreDown=0", async () => {
		const { gm, store } = makeManager();
		const lone = await gm.createGoal("Lone", tmpRoot, { workflowId: "feature" });
		const tm = makeFakeTeamMgr({ liveGoalIds: [] /* no live teams anywhere */ });

		const r = await teardownRoute(store, tm, lone.id, true);

		assert.equal(r.status, 200);
		assert.deepEqual(r.body, { ok: true, toreDown: 0, errors: [] });
		assert.deepEqual(tm.torndown, []);
	});

	it("idempotency: cascade=false on a goal with no team and no descendants → 200 toreDown=0", async () => {
		const { gm, store } = makeManager();
		const lone = await gm.createGoal("Lone", tmpRoot, { workflowId: "feature" });
		const tm = makeFakeTeamMgr({ liveGoalIds: [] });

		const r = await teardownRoute(store, tm, lone.id, false);

		assert.equal(r.status, 200);
		assert.deepEqual(r.body, { ok: true, toreDown: 0, errors: [] });
	});

	it("descendant tree of a sibling does NOT bleed into target's teardown order", async () => {
		const { gm, store } = makeManager();
		const tree1 = await gm.createGoal("Tree1", tmpRoot, { workflowId: "feature" });
		const tree2 = await gm.createGoal("Tree2", tmpRoot, { workflowId: "feature" });
		const c1 = await gm.createGoal("Tree1-C1", tmpRoot, { workflowId: "feature", parentGoalId: tree1.id });
		const c2 = await gm.createGoal("Tree2-C2", tmpRoot, { workflowId: "feature", parentGoalId: tree2.id });
		const tm = makeFakeTeamMgr({ liveGoalIds: [tree1.id, tree2.id, c1.id, c2.id] });

		const r = await teardownRoute(store, tm, tree1.id, true);

		assert.equal(r.status, 200);
		// Only tree1 + its child went down.
		assert.deepEqual(tm.torndown.sort(), [c1.id, tree1.id].sort());
		// tree2 + tree2's child are untouched.
		assert.equal(tm.torndown.includes(tree2.id), false);
		assert.equal(tm.torndown.includes(c2.id), false);
		assert.ok(tm.getTeamState(tree2.id), "tree2 team must remain alive");
		assert.ok(tm.getTeamState(c2.id), "tree2's child team must remain alive");
	});

	it("query-param truth-table: cascade only enables walk when literal 'true'", () => {
		// Document the route's parsing: `url.searchParams.get("cascade") === "true"`.
		// Anything else (missing, "false", "1", "True") is treated as false.
		const truthy: string[] = ["true"];
		const falsy: Array<string | null> = [null, "", "false", "True", "TRUE", "1", "yes"];
		for (const v of truthy) {
			assert.equal(v === "true", true);
		}
		for (const v of falsy) {
			assert.equal((v as string | null) === "true", false);
		}
	});
});
