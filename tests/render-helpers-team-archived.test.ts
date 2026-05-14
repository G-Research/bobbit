/**
 * Pure unit tests for `bucketTeamChildren` \u2014 the pure helper that splits
 * a team-lead's children into live rows (above the "Archived" divider)
 * and recently-terminated/archived rows (below, deduped with the
 * already-purged archived list).
 *
 * Bug being pinned: in `renderTeamGroup`, terminated/archived sessions
 * still present in `state.gatewaySessions` were rendering ABOVE the
 * "Archived" divider mixed with active sessions, because `teamChildren`
 * filtered only the team-lead out and did not consider status. The
 * `archivedForLiveLead` bucket below the divider only pulled from
 * `state.archivedSessions` (the fully-purged collection), so recently
 * terminated members slipped past both filters.
 *
 * `bucketTeamChildren` is the single source of truth for this split.
 * See `src/app/team-archived-bucket.ts` and its call site inside
 * `renderTeamGroup` in `src/app/render-helpers.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	bucketTeamChildren,
	type TeamChildLike,
} from "../src/app/team-archived-bucket.ts";

function s(over: Partial<TeamChildLike> & { id: string }): TeamChildLike {
	return { ...over };
}

describe("bucketTeamChildren \u2014 live vs archived bucketing for team-member rows", () => {
	it("(1) lead + 2 live coders + 3 terminated coders, showArchived=true \u2192 2 live above, 3 archived below", () => {
		// teamChildren is what render-helpers builds: goalSessions minus the lead.
		const teamChildren = [
			s({ id: "live-1", status: "idle" }),
			s({ id: "live-2", status: "busy" }),
			s({ id: "term-1", status: "terminated" }),
			s({ id: "term-2", status: "terminated" }),
			s({ id: "term-3", status: "terminated" }),
		];
		const archivedForLiveLead: TeamChildLike[] = [];
		const { liveTeamChildren, archivedBelow } = bucketTeamChildren(
			teamChildren,
			archivedForLiveLead,
			true,
		);
		assert.deepEqual(
			liveTeamChildren.map(x => x.id),
			["live-1", "live-2"],
			"only non-terminated, non-archived children render above",
		);
		assert.deepEqual(
			archivedBelow.map(x => x.id),
			["term-1", "term-2", "term-3"],
			"terminated children render below the divider",
		);
	});

	it("(2) showArchived=false \u2192 archivedBelow is empty (divider must be hidden by caller)", () => {
		const teamChildren = [
			s({ id: "live-1", status: "idle" }),
			s({ id: "term-1", status: "terminated" }),
			s({ id: "term-2", status: "terminated" }),
		];
		// In render-helpers, archivedForLiveLead is itself gated by
		// `state.showArchived ? ... : []`. Mirror that here: when the user
		// has archived rows hidden, both inputs collapse to empty below.
		const { liveTeamChildren, archivedBelow } = bucketTeamChildren(
			teamChildren,
			[],
			false,
		);
		assert.deepEqual(liveTeamChildren.map(x => x.id), ["live-1"]);
		assert.deepEqual(archivedBelow, [], "showArchived=false hides recently-terminated children");
	});

	it("(2b) helper's showArchived flag only suppresses recentlyTerminated, not the archivedForLiveLead pass-through", () => {
		// Document the contract: gating archivedForLiveLead is the caller's job.
		const { archivedBelow } = bucketTeamChildren(
			[s({ id: "term-1", status: "terminated" })],
			[s({ id: "arc-1" })],
			false,
		);
		assert.deepEqual(archivedBelow.map(x => x.id), ["arc-1"]);
	});

	it("(3) dedup: a session in both teamChildren (terminated) and archivedForLiveLead appears once", () => {
		const teamChildren = [
			s({ id: "live-1", status: "idle" }),
			s({ id: "dup", status: "terminated" }),
		];
		const archivedForLiveLead = [
			s({ id: "dup", status: "archived" }),
			s({ id: "arc-only" }),
		];
		const { liveTeamChildren, archivedBelow } = bucketTeamChildren(
			teamChildren,
			archivedForLiveLead,
			true,
		);
		assert.deepEqual(liveTeamChildren.map(x => x.id), ["live-1"]);
		assert.deepEqual(
			archivedBelow.map(x => x.id),
			["dup", "arc-only"],
			"recentlyTerminated wins the dedup; arc-only still emitted",
		);
		// Defensive: ensure no double-emission.
		const ids = archivedBelow.map(x => x.id);
		assert.equal(new Set(ids).size, ids.length, "no duplicate ids");
	});

	it("(4) `archived: true` flag on a teamChild also routes it to archivedBelow", () => {
		const teamChildren = [
			s({ id: "live-1", status: "idle" }),
			s({ id: "soft-arc", status: "idle", archived: true }),
		];
		const { liveTeamChildren, archivedBelow } = bucketTeamChildren(
			teamChildren,
			[],
			true,
		);
		assert.deepEqual(liveTeamChildren.map(x => x.id), ["live-1"]);
		assert.deepEqual(archivedBelow.map(x => x.id), ["soft-arc"]);
	});

	it("(5) empty inputs yield empty outputs", () => {
		const { liveTeamChildren, archivedBelow } = bucketTeamChildren([], [], true);
		assert.deepEqual(liveTeamChildren, []);
		assert.deepEqual(archivedBelow, []);
	});

	it("(6) order: recentlyTerminated precedes archivedForLiveLead in the merged below-divider list", () => {
		const teamChildren = [
			s({ id: "term-A", status: "terminated" }),
			s({ id: "term-B", status: "terminated" }),
		];
		const archivedForLiveLead = [s({ id: "arc-A" }), s({ id: "arc-B" })];
		const { archivedBelow } = bucketTeamChildren(teamChildren, archivedForLiveLead, true);
		assert.deepEqual(archivedBelow.map(x => x.id), ["term-A", "term-B", "arc-A", "arc-B"]);
	});
});
