/**
 * Pure unit test for the archived-forest dedupe filter that prevents
 * archived sub-goals from rendering TWICE — once as a forest node under
 * their archived parent goal, and again under their archived team-lead's
 * `renderLeadWithMembers` spawned-children block.
 *
 * The actual filter lives inline in src/app/render-helpers.ts inside
 * `renderArchivedGoalsForest`. We re-implement it here to lock the
 * invariant against drift; the production code is the same shape.
 *
 * User reported symptom (image #43): a single root goal had 19 real
 * children (verified via goals.json). The sidebar rendered ~38 rows —
 * each child appeared once via the forest's nested-tree path AND a
 * second time under the team-lead's expanded block. The fix excludes
 * goals whose `spawnedBySessionId` points at any archived team-lead in
 * the same archived-sessions set; those goals only render under their
 * team-lead, never via the forest.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface Goal {
	id: string;
	parentGoalId?: string;
	spawnedBySessionId?: string;
	archived: boolean;
	title: string;
}

interface Session {
	id: string;
	role: string;
	teamGoalId?: string;
	archived: boolean;
}

/**
 * Mirror of the production filter in render-helpers.ts::renderArchivedGoalsForest.
 * Goals whose `spawnedBySessionId` points to an archived team-lead are
 * excluded from the forest — they appear under that team-lead's block only.
 */
function filterArchivedGoalsForForest(
	archivedGoals: Goal[],
	archivedSessions: Session[],
): Goal[] {
	const archivedTeamLeadIds = new Set(
		archivedSessions
			.filter(s => s.role === "team-lead")
			.map(s => s.id),
	);
	return archivedGoals.filter(g =>
		!g.spawnedBySessionId || !archivedTeamLeadIds.has(g.spawnedBySessionId),
	);
}

describe("renderArchivedGoalsForest — dedupe vs renderLeadWithMembers", () => {
	it("excludes goals whose spawnedBySessionId points at an archived team-lead", () => {
		const archivedGoals: Goal[] = [
			{ id: "root", archived: true, title: "REAL-TASKS" },
			{ id: "child-a", parentGoalId: "root", spawnedBySessionId: "tl-1", archived: true, title: "Audit A" },
			{ id: "child-b", parentGoalId: "root", spawnedBySessionId: "tl-1", archived: true, title: "Audit B" },
		];
		const archivedSessions: Session[] = [
			{ id: "tl-1", role: "team-lead", teamGoalId: "root", archived: true },
		];
		const out = filterArchivedGoalsForForest(archivedGoals, archivedSessions);
		// Only the root remains in the forest input. The two children are
		// excluded — they'll render via the team-lead's spawned-children block.
		assert.deepEqual(out.map(g => g.id), ["root"]);
	});

	it("keeps goals with no spawnedBySessionId (legacy data without attribution)", () => {
		const archivedGoals: Goal[] = [
			{ id: "root", archived: true, title: "REAL-TASKS" },
			{ id: "orphan", parentGoalId: "root", archived: true, title: "Pre-attribution child" },
		];
		const archivedSessions: Session[] = [
			{ id: "tl-1", role: "team-lead", teamGoalId: "root", archived: true },
		];
		const out = filterArchivedGoalsForForest(archivedGoals, archivedSessions);
		// `orphan` has no spawnedBySessionId, so it stays in the forest —
		// otherwise legacy goals would be unreachable.
		assert.deepEqual(out.map(g => g.id), ["root", "orphan"]);
	});

	it("keeps goals attributed to a non-team-lead session (worker, reviewer, etc.)", () => {
		const archivedGoals: Goal[] = [
			{ id: "root", archived: true, title: "REAL-TASKS" },
			{ id: "child", parentGoalId: "root", spawnedBySessionId: "worker-1", archived: true, title: "Spawned by a worker somehow" },
		];
		const archivedSessions: Session[] = [
			{ id: "worker-1", role: "coder", teamGoalId: "root", archived: true },
		];
		const out = filterArchivedGoalsForForest(archivedGoals, archivedSessions);
		// Only team-leads exclude. workers can't drive renderLeadWithMembers,
		// so the goal must appear in the forest or it'd be unreachable.
		assert.deepEqual(out.map(g => g.id), ["root", "child"]);
	});

	it("keeps goals attributed to a session that's not in the archived set (cross-tree)", () => {
		const archivedGoals: Goal[] = [
			{ id: "child", parentGoalId: "root", spawnedBySessionId: "tl-from-other-tree", archived: true, title: "X" },
		];
		const archivedSessions: Session[] = [
			// Note: tl-from-other-tree is NOT in this session list.
			{ id: "tl-1", role: "team-lead", teamGoalId: "root", archived: true },
		];
		const out = filterArchivedGoalsForForest(archivedGoals, archivedSessions);
		// The attributing team-lead isn't in the archived sessions of THIS
		// view, so renderLeadWithMembers won't render the child under it. The
		// child stays in the forest as an orphan to remain reachable.
		assert.deepEqual(out.map(g => g.id), ["child"]);
	});

	it("user image #43 reproduction: 19 children spawnedBy archived team-lead → all excluded from forest", () => {
		const tl = { id: "al-truist", role: "team-lead", teamGoalId: "real-tasks", archived: true };
		const archivedGoals: Goal[] = [
			{ id: "real-tasks", archived: true, title: "REAL-TASKS COMPARISON AUDIT" },
			...Array.from({ length: 19 }, (_, i) => ({
				id: `child-${i}`,
				parentGoalId: "real-tasks",
				spawnedBySessionId: "al-truist",
				archived: true,
				title: `Child ${i}`,
			})),
		];
		const out = filterArchivedGoalsForForest(archivedGoals, [tl]);
		// Only the root survives — all 19 children are deduped out so the
		// forest renders only the parent. The team-lead's block then carries
		// the 19 spawned children. No double-render.
		assert.equal(out.length, 1);
		assert.equal(out[0].id, "real-tasks");
	});
});
