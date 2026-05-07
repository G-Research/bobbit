/**
 * Pure unit tests for `resolveSpawnedBySessionId` — the four-tier cascade
 * shared by `POST /api/goals/:id/spawn-child` and
 * `verification-harness.runSubgoalStep`.
 *
 * Tier order:
 *   1. body.spawnedBySessionId
 *   2. x-bobbit-spawning-session header
 *   3. x-bobbit-session-id header (defence in depth)
 *   4. teamManager.getTeamState(parentGoalId)?.teamLeadSessionId
 *   5. fallback → undefined (caller logs)
 *
 * The HTTP route-level path is exercised separately in
 * `tests/e2e/api-goals-spawn-child-route.spec.ts`; this file is the
 * single source of truth for the cascade semantics.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveSpawnedBySessionId } from "../src/server/agent/spawn-child-spawnedby.ts";

function fakeTeamManager(map: Record<string, string | null | undefined>): {
	getTeamState(id: string): { teamLeadSessionId?: string | null } | undefined;
} {
	return {
		getTeamState(id: string) {
			if (!(id in map)) return undefined;
			return { teamLeadSessionId: map[id] ?? null };
		},
	};
}

describe("resolveSpawnedBySessionId — four-tier cascade", () => {
	it("tier 1 — body.spawnedBySessionId wins", () => {
		const out = resolveSpawnedBySessionId({
			body: { spawnedBySessionId: "from-body" },
			headers: { "x-bobbit-spawning-session": "from-header" },
			parentGoalId: "p1",
			teamManager: fakeTeamManager({ p1: "from-team" }),
		});
		assert.equal(out.value, "from-body");
		assert.equal(out.tier, 1);
	});

	it("tier 2 — x-bobbit-spawning-session header when body absent", () => {
		const out = resolveSpawnedBySessionId({
			body: {},
			headers: { "x-bobbit-spawning-session": "from-header" },
			parentGoalId: "p1",
			teamManager: fakeTeamManager({ p1: "from-team" }),
		});
		assert.equal(out.value, "from-header");
		assert.equal(out.tier, 2);
	});

	it("tier 2 header is case-insensitive", () => {
		const out = resolveSpawnedBySessionId({
			parentGoalId: "p1",
			headers: { "X-Bobbit-Spawning-Session": "mixed-case" },
		});
		assert.equal(out.value, "mixed-case");
		assert.equal(out.tier, 2);
	});

	it("tier 3 — x-bobbit-session-id header (defence in depth)", () => {
		const out = resolveSpawnedBySessionId({
			body: {},
			headers: { "x-bobbit-session-id": "agent-session-X" },
			parentGoalId: "p1",
			teamManager: fakeTeamManager({ p1: "from-team" }),
		});
		assert.equal(out.value, "agent-session-X");
		assert.equal(out.tier, 3);
	});

	it("tier 4 — parent's live team-lead when nothing else available", () => {
		const out = resolveSpawnedBySessionId({
			parentGoalId: "p1",
			teamManager: fakeTeamManager({ p1: "tl-of-p1" }),
		});
		assert.equal(out.value, "tl-of-p1");
		assert.equal(out.tier, 4);
	});

	it("tier 5 — undefined when nothing resolves", () => {
		const out = resolveSpawnedBySessionId({
			parentGoalId: "p1",
		});
		assert.equal(out.value, undefined);
		assert.equal(out.tier, 5);
	});

	it("tier 5 when parent has no live team-lead (null)", () => {
		const out = resolveSpawnedBySessionId({
			parentGoalId: "p1",
			teamManager: fakeTeamManager({ p1: null }),
		});
		assert.equal(out.value, undefined);
		assert.equal(out.tier, 5);
	});

	it("tier 5 when teamManager has no entry for parent", () => {
		const out = resolveSpawnedBySessionId({
			parentGoalId: "p1",
			teamManager: fakeTeamManager({}),
		});
		assert.equal(out.value, undefined);
		assert.equal(out.tier, 5);
	});

	it("empty / whitespace body field falls through to next tier", () => {
		const out = resolveSpawnedBySessionId({
			body: { spawnedBySessionId: "   " },
			headers: { "x-bobbit-spawning-session": "from-header" },
			parentGoalId: "p1",
		});
		assert.equal(out.value, "from-header");
		assert.equal(out.tier, 2);
	});

	it("empty header at tier 2 falls through to tier 3", () => {
		const out = resolveSpawnedBySessionId({
			headers: {
				"x-bobbit-spawning-session": "",
				"x-bobbit-session-id": "agent-X",
			},
			parentGoalId: "p1",
		});
		assert.equal(out.value, "agent-X");
		assert.equal(out.tier, 3);
	});

	it("empty header at tier 3 falls through to tier 4", () => {
		const out = resolveSpawnedBySessionId({
			headers: {
				"x-bobbit-session-id": "   ",
			},
			parentGoalId: "p1",
			teamManager: fakeTeamManager({ p1: "tl-of-p1" }),
		});
		assert.equal(out.value, "tl-of-p1");
		assert.equal(out.tier, 4);
	});

	it("array-valued header coerces to first element", () => {
		const out = resolveSpawnedBySessionId({
			headers: {
				"x-bobbit-spawning-session": ["first-value", "second-value"],
			},
			parentGoalId: "p1",
		});
		assert.equal(out.value, "first-value");
		assert.equal(out.tier, 2);
	});

	it("non-string body field is ignored", () => {
		const out = resolveSpawnedBySessionId({
			body: { spawnedBySessionId: 12345 as unknown as string },
			parentGoalId: "p1",
			teamManager: fakeTeamManager({ p1: "tl" }),
		});
		assert.equal(out.value, "tl");
		assert.equal(out.tier, 4);
	});

	it("missing body is fine — never throws", () => {
		const out = resolveSpawnedBySessionId({
			parentGoalId: "p1",
			teamManager: fakeTeamManager({ p1: "tl" }),
		});
		assert.equal(out.tier, 4);
	});

	it("harness-style call (no body, no headers) collapses to tier 4 / 5", () => {
		// Mirrors verification-harness.runSubgoalStep's call shape.
		const t4 = resolveSpawnedBySessionId({
			parentGoalId: "parent-with-team",
			teamManager: fakeTeamManager({ "parent-with-team": "tl-session" }),
		});
		assert.equal(t4.tier, 4);
		assert.equal(t4.value, "tl-session");

		const t5 = resolveSpawnedBySessionId({
			parentGoalId: "parent-no-team",
			teamManager: fakeTeamManager({}),
		});
		assert.equal(t5.tier, 5);
		assert.equal(t5.value, undefined);
	});
});
