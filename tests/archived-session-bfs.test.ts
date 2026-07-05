/**
 * PERF-03: GET /api/sessions' default (non `include=archived`) path used to
 * clone EVERY archived session across every visible project context on
 * every poll, then re-scan that full clone array once per BFS-queued node
 * (server.ts's `bfsEnrichArchived`, called from the default branch). Cost
 * scaled with total archive size, not the reachable set the sidebar
 * actually renders.
 *
 * `bfsEnrichArchivedIndexed` (src/server/agent/archived-session-bfs.ts)
 * replaces that with a parent-key index built once (O(N), no cloning),
 * then a BFS walk that only clones/enriches sessions actually reachable
 * from the live seeds. These tests pin that it is byte-identical (same
 * set, same order) to the original `bfsEnrichArchivedNaive` algorithm
 * across hand-built multi-level/cross-goal trees and randomized fuzzing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	bfsEnrichArchivedIndexed,
	bfsEnrichArchivedNaive,
	type ArchivedBfsSession,
} from "../src/server/agent/archived-session-bfs.ts";

interface FakeSession extends ArchivedBfsSession {
	title: string;
}

function s(id: string, overrides: Partial<FakeSession> = {}): FakeSession {
	return { id, title: `session-${id}`, ...overrides };
}

/** Mirrors server.ts's clone shape: `{...s, colorIndex, archived: true}`. */
function enrich(colors: Map<string, number>): (s: FakeSession) => FakeSession {
	return (sess) => ({ ...sess, colorIndex: colors.get(sess.id), archived: true } as any);
}

describe("bfsEnrichArchivedIndexed — equivalence with the naive/original algorithm", () => {
	it("returns nothing when there are no archived sessions", () => {
		const naive = bfsEnrichArchivedNaive(["live-1"], []);
		const indexed = bfsEnrichArchivedIndexed(["live-1"], [], enrich(new Map()));
		assert.deepEqual(indexed, []);
		assert.deepEqual(naive, []);
	});

	it("finds a direct delegate of a live session", () => {
		const archived = [s("child-1", { delegateOf: "live-1" }), s("unrelated")];
		const colors = new Map([["child-1", 3]]);
		const naive = bfsEnrichArchivedNaive(["live-1"], archived);
		const indexed = bfsEnrichArchivedIndexed(["live-1"], archived, enrich(colors));

		assert.deepEqual(naive.map(x => x.id), ["child-1"]);
		assert.deepEqual(indexed.map(x => x.id), ["child-1"]);
		assert.equal((indexed[0] as any).colorIndex, 3);
		assert.equal((indexed[0] as any).archived, true);
	});

	it("walks a multi-level delegate chain (grandchild reachable transitively)", () => {
		const archived = [
			s("gen3", { delegateOf: "gen2" }),
			s("gen2", { delegateOf: "gen1" }),
			s("gen1", { delegateOf: "live-1" }),
			s("sibling-not-reachable", { delegateOf: "some-other-live" }),
		];
		const naive = bfsEnrichArchivedNaive(["live-1"], archived);
		const indexed = bfsEnrichArchivedIndexed(["live-1"], archived, enrich(new Map()));

		assert.deepEqual(naive.map(x => x.id), indexed.map(x => x.id));
		assert.deepEqual(indexed.map(x => x.id).sort(), ["gen1", "gen2", "gen3"]);
		assert.ok(!indexed.some(x => x.id === "sibling-not-reachable"));
	});

	it("reaches cross-goal children via goalId/teamGoalId seeds, independent of delegate chains", () => {
		const archived = [
			s("goal-child-a", { goalId: "goal-1" }),
			s("goal-child-b", { teamGoalId: "goal-2" }),
			s("delegate-of-goal-child", { delegateOf: "goal-child-a" }),
			s("other-goal-child", { goalId: "goal-3" }), // goal-3 not a live seed
		];
		const seeds = ["goal-1", "goal-2"];
		const naive = bfsEnrichArchivedNaive(seeds, archived);
		const indexed = bfsEnrichArchivedIndexed(seeds, archived, enrich(new Map()));

		assert.deepEqual(naive.map(x => x.id), indexed.map(x => x.id));
		assert.deepEqual(
			indexed.map(x => x.id).sort(),
			["delegate-of-goal-child", "goal-child-a", "goal-child-b"].sort(),
		);
	});

	it("dedupes a session reachable via multiple relation fields pointing at the same parent", () => {
		// Both delegateOf and parentSessionId point at the same live id —
		// must appear exactly once, matching the naive OR-condition match.
		const archived = [s("dual-linked", { delegateOf: "live-1", parentSessionId: "live-1" })];
		const naive = bfsEnrichArchivedNaive(["live-1"], archived);
		const indexed = bfsEnrichArchivedIndexed(["live-1"], archived, enrich(new Map()));
		assert.equal(naive.length, 1);
		assert.equal(indexed.length, 1);
	});

	it("does not clone/enrich sessions outside the reachable set (verifies no full-pool materialization)", () => {
		const archived = [s("reachable", { delegateOf: "live-1" }), s("far-away", { goalId: "goal-99" })];
		let cloneCalls = 0;
		const spyClone = (sess: FakeSession) => {
			cloneCalls++;
			return { ...sess, colorIndex: undefined, archived: true } as any;
		};
		const indexed = bfsEnrichArchivedIndexed(["live-1"], archived, spyClone);
		assert.equal(indexed.length, 1);
		assert.equal(cloneCalls, 1, "clone() must only run for sessions actually included in the result");
	});

	it("fuzzes random mixed live/archived trees (incl. multi-level chains and cross-goal children) for exact equivalence", () => {
		const RELATIONS: Array<keyof ArchivedBfsSession> = [
			"delegateOf", "parentSessionId", "teamLeadSessionId", "teamGoalId", "goalId",
		];
		for (let trial = 0; trial < 200; trial++) {
			const rand = mulberry32(trial + 1);
			const liveSeeds = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => `live-${i}`);
			const goalSeeds = Array.from({ length: Math.floor(rand() * 3) }, (_, i) => `goal-${i}`);
			const seeds = [...liveSeeds, ...goalSeeds];

			// Pool of possible parent targets: seeds plus some archived ids
			// created earlier in the loop, so chains can go multiple levels deep.
			const archived: FakeSession[] = [];
			const n = 5 + Math.floor(rand() * 40);
			for (let i = 0; i < n; i++) {
				const id = `arch-${i}`;
				const possibleParents = [...seeds, ...archived.map(a => a.id), "dangling-nonexistent-parent"];
				const overrides: Partial<FakeSession> = {};
				// Randomly attach 0-2 relation fields.
				const numLinks = Math.floor(rand() * 3);
				for (let l = 0; l < numLinks; l++) {
					const field = RELATIONS[Math.floor(rand() * RELATIONS.length)];
					const parent = possibleParents[Math.floor(rand() * possibleParents.length)];
					(overrides as any)[field] = parent;
				}
				archived.push(s(id, overrides));
			}
			// Shuffle-ish: interleave order shouldn't matter for set equality, but keep
			// order stable across both algorithms since it's derived from the same array.
			const naive = bfsEnrichArchivedNaive(seeds, archived);
			const indexed = bfsEnrichArchivedIndexed(seeds, archived, (x) => ({ ...x }));

			assert.deepEqual(
				indexed.map(x => x.id),
				naive.map(x => x.id),
				`trial ${trial} mismatched order/set. seeds=${JSON.stringify(seeds)} archived=${JSON.stringify(archived)}`,
			);
		}
	});
});

/** Deterministic PRNG so fuzz failures are reproducible from the trial index. */
function mulberry32(seed: number): () => number {
	let a = seed;
	return function () {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
