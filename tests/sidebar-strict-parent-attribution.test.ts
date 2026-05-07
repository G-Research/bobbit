/**
 * Defence-in-depth: strict-parent attribution in `selectSpawnedChildren`.
 *
 * The four-tier cascade in `resolveSpawnedBySessionId` is the principal
 * fix for un-stamped child goals. This file pins the SAFETY NET that
 * keeps the sidebar correct even when tier-5 fires (the cascade returns
 * undefined, e.g. raw cURL spawn against a parent with no live team).
 *
 * Contract:
 *   - A stamped child (spawnedBySessionId set) attaches to its lead
 *     exactly as today — no behaviour change.
 *   - An unstamped child (spawnedBySessionId === undefined) attaches
 *     ONLY when leadId === parentLeadId. It must NEVER appear under a
 *     sibling team-lead.
 *   - When parentLeadId is omitted (legacy callers), the unstamped
 *     branch never matches — historical behaviour preserved.
 *   - The archived flag is honoured per `showArchived` (live + archived
 *     views must apply the same rule).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	selectSpawnedChildren,
	type SpawnedChildLike,
} from "../src/app/sidebar-spawned-children.ts";

function g(over: Partial<SpawnedChildLike> & { id: string }): SpawnedChildLike {
	return {
		parentGoalId: undefined,
		spawnedBySessionId: undefined,
		archived: false,
		createdAt: 0,
		...over,
	};
}

describe("selectSpawnedChildren — strict-parent attribution", () => {
	it("stamped child still attaches to the matching lead", () => {
		const goals = [
			g({ id: "stamped", parentGoalId: "P", spawnedBySessionId: "L_PARENT", createdAt: 1 }),
		];
		const out = selectSpawnedChildren(goals, "P", "L_PARENT", false, "L_PARENT");
		assert.deepEqual(out.map(x => x.id), ["stamped"]);
	});

	it("unstamped child attaches when leadId === parentLeadId", () => {
		const goals = [
			g({ id: "orphan", parentGoalId: "P", spawnedBySessionId: undefined, createdAt: 1 }),
		];
		const out = selectSpawnedChildren(goals, "P", "L_PARENT", false, "L_PARENT");
		assert.deepEqual(out.map(x => x.id), ["orphan"]);
	});

	it("unstamped child does NOT attach when leadId !== parentLeadId (sibling-lead protection)", () => {
		const goals = [
			g({ id: "orphan", parentGoalId: "P", spawnedBySessionId: undefined, createdAt: 1 }),
		];
		// We're rendering sibling lead L_SIBLING. The orphan's parent is P,
		// whose own lead is L_PARENT. The orphan must NOT show under L_SIBLING.
		const out = selectSpawnedChildren(goals, "P", "L_SIBLING", false, "L_PARENT");
		assert.deepEqual(out.map(x => x.id), []);
	});

	it("unstamped child never matches when parentLeadId is omitted (legacy callers)", () => {
		const goals = [
			g({ id: "orphan", parentGoalId: "P", spawnedBySessionId: undefined, createdAt: 1 }),
		];
		const out = selectSpawnedChildren(goals, "P", "L_PARENT", false);
		assert.deepEqual(out.map(x => x.id), []);
	});

	it("mixed stamped + unstamped — each attached only to the right lead", () => {
		const goals = [
			g({ id: "stamped-mine",   parentGoalId: "P", spawnedBySessionId: "L_PARENT",  createdAt: 1 }),
			g({ id: "stamped-sibling", parentGoalId: "P", spawnedBySessionId: "L_SIBLING", createdAt: 2 }),
			g({ id: "orphan",          parentGoalId: "P", spawnedBySessionId: undefined,   createdAt: 3 }),
		];
		// Render the parent's own lead.
		const ownLead = selectSpawnedChildren(goals, "P", "L_PARENT", false, "L_PARENT");
		assert.deepEqual(ownLead.map(x => x.id), ["stamped-mine", "orphan"]);

		// Render a sibling-ish lead (e.g. another team-lead the user has
		// expanded). Orphan must NOT be misattributed.
		const sibling = selectSpawnedChildren(goals, "P", "L_SIBLING", false, "L_PARENT");
		assert.deepEqual(sibling.map(x => x.id), ["stamped-sibling"]);
	});

	it("archived view: orphan still attached to parent's own lead, not sibling", () => {
		const goals = [
			g({ id: "live-orphan",     parentGoalId: "P", spawnedBySessionId: undefined, createdAt: 1, archived: false }),
			g({ id: "archived-orphan", parentGoalId: "P", spawnedBySessionId: undefined, createdAt: 2, archived: true }),
		];
		// showArchived=true, parent's own lead.
		const own = selectSpawnedChildren(goals, "P", "L_PARENT", true, "L_PARENT");
		assert.deepEqual(own.map(x => x.id), ["live-orphan", "archived-orphan"]);

		// showArchived=true, sibling lead — none should appear.
		const sibling = selectSpawnedChildren(goals, "P", "L_SIBLING", true, "L_PARENT");
		assert.deepEqual(sibling.map(x => x.id), []);
	});

	it("archived view filters out archived goals when showArchived=false (orphan path)", () => {
		const goals = [
			g({ id: "live-orphan",     parentGoalId: "P", spawnedBySessionId: undefined, createdAt: 1, archived: false }),
			g({ id: "archived-orphan", parentGoalId: "P", spawnedBySessionId: undefined, createdAt: 2, archived: true }),
		];
		const out = selectSpawnedChildren(goals, "P", "L_PARENT", false, "L_PARENT");
		assert.deepEqual(out.map(x => x.id), ["live-orphan"]);
	});

	it("parentGoalId mismatch — orphan from a different parent never attaches", () => {
		const goals = [
			// This orphan's parent is OTHER, not P. Even with strict-parent
			// attribution active for P, the parentGoalId filter rejects it.
			g({ id: "wrong-parent", parentGoalId: "OTHER", spawnedBySessionId: undefined, createdAt: 1 }),
		];
		const out = selectSpawnedChildren(goals, "P", "L_PARENT", false, "L_PARENT");
		assert.deepEqual(out.map(x => x.id), []);
	});

	it("dedupe + sort still apply with the new strict-parent branch", () => {
		const goals = [
			g({ id: "b", parentGoalId: "P", spawnedBySessionId: undefined, createdAt: 2 }),
			g({ id: "a", parentGoalId: "P", spawnedBySessionId: undefined, createdAt: 1 }),
			// Duplicate id (reducer race) — must collapse.
			g({ id: "a", parentGoalId: "P", spawnedBySessionId: undefined, createdAt: 1 }),
		];
		const out = selectSpawnedChildren(goals, "P", "L_PARENT", false, "L_PARENT");
		assert.deepEqual(out.map(x => x.id), ["a", "b"]);
	});
});
