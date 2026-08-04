import { afterEach, describe, expect, it } from "vitest";
import { planAffectedRun } from "../../scripts/affected/runner.mjs";
import {
	cleanupFixtures,
	makeFixture,
	remove,
	run,
	UNIT_FILES,
} from "./helpers/affected-runner-fixture.js";

afterEach(cleanupFixtures);

describe("affected runner injected change-record policy", () => {
	it("uses rich before/after bytes for semantic selection without collecting Git changes", () => {
		const fixture = makeFixture();
		const semantic = run(fixture, {
			noCache: true,
			dry: true,
			records: [{
				path: "semantic.json",
				status: "M",
				before: "baseline-semantic-value\n",
				after: "changed-semantic-value\n",
			}],
		});
		expect(semantic.status).toBe(0);
		expect(semantic.result.changed).toEqual([{ path: "semantic.json", status: "M" }]);
		expect(semantic.result.reasons).toEqual([
			"semantic:baseline-semantic-value->changed-semantic-value",
		]);
		expect(semantic.result.summary).toBe("BOUNDED selected=1, cache-hit=0, run=1");
		expect(fixture.invocations).toEqual([]);

		const docsOnly = run(fixture, {
			dry: true,
			records: [{ path: "docs/untracked.md", status: "A", after: "fixture docs\n" }],
		});
		expect(docsOnly.result.summary).toBe("SKIP-ALL reason=docs only, selected=0, run=0");
	});

	it("passes direct changed/base options only to the injected collector and normalizes paths", () => {
		const fixture = makeFixture();
		let collectedOptions: unknown;
		const graph = {
			testFiles: [...UNIT_FILES],
			testDeps: new Map(UNIT_FILES.map(file => [file, new Set([file, "src/a.ts"])])),
		};
		const plan = planAffectedRun({
			repoRoot: fixture.root,
			base: "synthetic-base",
			changed: "src\\a.ts, ./src/a.ts",
			noCache: true,
		}, {
			collectChanges: (options: unknown) => {
				collectedOptions = options;
				return { records: [{ path: "src\\a.ts", status: "m" }], base: "base-sha" };
			},
			buildGraph: () => graph,
			affectedTests: () => ({
				kind: "bounded",
				cachePolicy: "eligible",
				affected: new Set([UNIT_FILES[0]]),
				browserAffected: new Set(),
				reasons: ["injected collector"],
				unmapped: [],
			}),
		});
		expect(collectedOptions).toEqual({
			repoRoot: fixture.root,
			base: "synthetic-base",
			changed: ["src\\a.ts", "./src/a.ts"],
		});
		expect(plan.records).toEqual([{
			path: "src/a.ts",
			status: "M",
			before: undefined,
			after: undefined,
		}]);
		expect(plan.base).toBe("base-sha");
	});

	it("preserves rename and delete old-side attribution through tombstones", () => {
		const fixture = makeFixture();
		remove(fixture.root, "src/a.ts");
		const changed = run(fixture, {
			noCache: true,
			dry: true,
			records: [
				{
					path: "semantic-renamed.json",
					oldPath: "semantic.json",
					status: "R",
					before: "baseline-semantic-value\n",
					after: "renamed-semantic-value\n",
				},
				{ path: "src/a.ts", status: "D", before: "export const a = 1;\n" },
			],
		});
		expect(changed.result.changed).toEqual([
			{ path: "semantic-renamed.json", oldPath: "semantic.json", status: "R" },
			{ path: "src/a.ts", status: "D" },
		]);
		expect(changed.result.kind).toBe("run-all");
		expect(changed.result.reasons[0]).toMatch(/unresolved deleted dependency: src\/a\.ts/u);
		expect(changed.result.affected).toEqual(UNIT_FILES);
	});

	it.each(["committed", "staged", "unstaged", "explicit"])(
		"keeps an exact registered input delete bounded for the %s record source",
		() => {
			const fixture = makeFixture();
			remove(fixture.root, "defaults/roles/coder.yaml");
			const deleted = run(fixture, {
				dry: true,
				records: [{
					path: "defaults/roles/coder.yaml",
					status: "D",
					before: "name: coder\n",
				}],
			});
			expect(deleted.result).toMatchObject({
				kind: "bounded",
				cachePolicy: "eligible",
				changed: [{ path: "defaults/roles/coder.yaml", status: "D" }],
				affected: [UNIT_FILES[0]],
				cacheHits: [],
				toRun: [UNIT_FILES[0]],
				outcome: "dry",
				counts: { total: 2, selected: 1, cacheHit: 0, run: 1 },
			});
		},
	);

	it("keeps graph-owned Markdown deletes and rename-outs out of SKIP-ALL", () => {
		const fixture = makeFixture();
		remove(fixture.root, "market-packs/example/README.md");
		const deleted = run(fixture, {
			noCache: true,
			dry: true,
			records: [{ path: "market-packs/example/README.md", status: "D", before: "# example pack\n" }],
		});
		expect(deleted.result).toMatchObject({
			kind: "bounded",
			cachePolicy: "eligible",
			changed: [{ path: "market-packs/example/README.md", status: "D" }],
		});
		expect(deleted.result.summary).not.toContain("SKIP-ALL");

		const renamedOut = run(makeFixture(), {
			noCache: true,
			dry: true,
			records: [{
				path: "docs/example-pack.md",
				oldPath: "market-packs/example/README.md",
				status: "R",
				before: "# example pack\n",
				after: "# example pack\n",
			}],
		});
		expect(renamedOut.result.changed).toEqual([{
			path: "docs/example-pack.md",
			oldPath: "market-packs/example/README.md",
			status: "R",
		}]);
		expect(renamedOut.result.kind).toBe("bounded");
		expect(renamedOut.result.summary).not.toContain("SKIP-ALL");
	});

	it.each([
		[{ path: "../escape.ts", status: "M" }, /repository-relative/u],
		[{ path: "src/a.ts", status: "?" }, /invalid status/u],
		[{ path: "src/a.ts", status: "R" }, /requires oldPath/u],
		[{ path: "src/a.ts", status: "M", before: Buffer.from("bytes") }, /must be a string/u],
	])("fails closed for malformed injected record %#", (record, message) => {
		const fixture = makeFixture();
		expect(() => run(fixture, { records: [record as any] })).toThrow(message);
	});
});
