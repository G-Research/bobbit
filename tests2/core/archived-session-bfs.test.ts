import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	bfsEnrichArchivedIndexed,
	bfsEnrichArchivedNaive,
	type ArchivedBfsSession,
} from "../../src/server/agent/archived-session-bfs.js";

interface Row extends ArchivedBfsSession {
	label: string;
}

const row = (id: string, relationships: Partial<Row> = {}): Row => ({
	id,
	label: relationships.label ?? id,
	...relationships,
});
const ids = (rows: Row[]): string[] => rows.map(session => session.id);

function assertEquivalent(seeds: string[], archived: Row[]): void {
	const expected = bfsEnrichArchivedNaive(seeds, archived);
	const actual = bfsEnrichArchivedIndexed(seeds, archived, session => ({ ...session }));
	assert.deepEqual(actual, expected);
}

describe("indexed archived-session BFS", () => {
	it("walks every relationship field in stable seed, source, and BFS order", () => {
		const archived = [
			row("delegate", { delegateOf: "seed-b" }),
			row("parent", { parentSessionId: "seed-a" }),
			row("lead", { teamLeadSessionId: "seed-a" }),
			row("team-goal", { teamGoalId: "seed-b" }),
			row("goal", { goalId: "seed-a" }),
			row("grandchild", { delegateOf: "parent" }),
		];

		const actual = bfsEnrichArchivedIndexed(["seed-a", "seed-b"], archived, session => ({ ...session }));
		assert.deepEqual(ids(actual), ["parent", "lead", "goal", "delegate", "team-goal", "grandchild"]);
		assertEquivalent(["seed-a", "seed-b"], archived);
	});

	it("deduplicates repeated seeds, relationship values, ids, and cycles", () => {
		const archived = [
			row("first", { delegateOf: "seed", parentSessionId: "seed", label: "first record" }),
			row("first", { goalId: "seed", label: "duplicate corrupt record" }),
			row("second", { delegateOf: "first", teamLeadSessionId: "first" }),
			row("cycle", { parentSessionId: "second", goalId: "cycle" }),
			row("back-edge", { delegateOf: "cycle", teamGoalId: "first" }),
		];

		const actual = bfsEnrichArchivedIndexed(["seed", "seed"], archived, session => ({ ...session }));
		assert.deepEqual(ids(actual), ["first", "second", "back-edge", "cycle"]);
		assert.equal(actual[0].label, "first record", "first reachable legacy record wins for a duplicate id");
		assertEquivalent(["seed", "seed"], archived);
	});

	it("does not clone unreachable rows and leaves raw reachable rows immutable", () => {
		const reachable = row("reachable", { delegateOf: "seed" });
		const unreachable = Array.from({ length: 1_000 }, (_, index) => row(`unreachable-${index}`, { goalId: "other" }));
		let clones = 0;
		const actual = bfsEnrichArchivedIndexed(["seed"], [reachable, ...unreachable], session => {
			clones++;
			return { ...session, label: `cloned-${session.label}` };
		});

		assert.equal(clones, 1);
		assert.deepEqual(ids(actual), ["reachable"]);
		assert.equal(actual[0].label, "cloned-reachable");
		assert.equal(reachable.label, "reachable");
	});

	it("handles wide fan-out and clones exactly the reachable set", () => {
		const width = 5_000;
		const archived = Array.from({ length: width }, (_, index) => row(`child-${index}`, { delegateOf: "seed" }));
		archived.push(row("grandchild", { parentSessionId: "child-0" }));
		archived.push(row("unreachable", { delegateOf: "missing" }));
		let clones = 0;

		const actual = bfsEnrichArchivedIndexed(["seed"], archived, session => {
			clones++;
			return { ...session };
		});

		assert.equal(actual.length, width + 1);
		assert.equal(clones, width + 1);
		assert.deepEqual(ids(actual.slice(0, 3)), ["child-0", "child-1", "child-2"]);
		assert.equal(actual.at(-1)?.id, "grandchild");
		assertEquivalent(["seed"], archived);
	});

	it("matches the naive traversal across deterministic randomized graphs", () => {
		const fields: Array<keyof ArchivedBfsSession> = [
			"delegateOf",
			"parentSessionId",
			"teamLeadSessionId",
			"teamGoalId",
			"goalId",
		];
		for (let trial = 1; trial <= 150; trial++) {
			const random = mulberry32(trial);
			const seeds = ["seed-a", "seed-b", ...(trial % 5 === 0 ? ["seed-a"] : [])];
			const archived: Row[] = [];
			const ids = Array.from({ length: 60 }, (_, index) => `row-${index}`);
			for (let index = 0; index < ids.length; index++) {
				const relationships: Partial<Row> = {};
				const linkCount = Math.floor(random() * 4);
				for (let link = 0; link < linkCount; link++) {
					const field = fields[Math.floor(random() * fields.length)];
					const possibleParents = [...seeds, ...ids, "missing"];
					(relationships as Record<string, string>)[field] = possibleParents[Math.floor(random() * possibleParents.length)];
				}
				archived.push(row(ids[index], relationships));
				if (random() < 0.08) archived.push(row(ids[index], { ...relationships, label: `duplicate-${index}` }));
			}
			assertEquivalent(seeds, archived);
		}
	});
});

function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6D2B79F5) | 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}
