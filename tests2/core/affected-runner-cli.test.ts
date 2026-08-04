import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadCache,
	record,
	runnerFingerprint,
	snapshotTestHashes,
	testHash,
} from "../../scripts/affected/cache.mjs";
import { executeAffectedRun, planAffectedRun } from "../../scripts/affected/runner.mjs";
import {
	cachedTests,
	cleanupFixtures,
	makeFixture,
	remove,
	run,
	UNIT_FILES,
	write,
} from "./helpers/affected-runner-fixture.js";

afterEach(cleanupFixtures);

function executeReportedBatch(
	fixture: ReturnType<typeof makeFixture>,
	status: number | null,
	report?: unknown,
) {
	const graph = {
		testFiles: [...UNIT_FILES],
		testDeps: new Map(UNIT_FILES.map(file => [file, new Set([file])])),
	};
	const plan = planAffectedRun({ repoRoot: fixture.root, all: true }, {
		buildGraph: () => graph,
	});
	return executeAffectedRun(plan, {}, {
		executeTests: () => ({ status, report }),
	});
}

describe("affected runner in-process cache and fallback policy", () => {
	it("runs all for unexplained executable deletes and bypasses prior cache hits", () => {
		const fixture = makeFixture();
		expect(run(fixture, { all: true }).status).toBe(0);
		remove(fixture.root, "src/deleted-tool.ts");
		const deleted = run(fixture, {
			records: [{ path: "src/deleted-tool.ts", status: "D", before: "export const deletedTool = 1;\n" }],
		});
		expect(deleted.status).toBe(0);
		expect(deleted.result).toMatchObject({
			kind: "run-all",
			cachePolicy: "bypass",
			changed: [{ path: "src/deleted-tool.ts", status: "D" }],
			cacheHits: [],
			toRun: UNIT_FILES,
			counts: { total: 2, selected: 2, cacheHit: 0, run: 2 },
		});
		expect(deleted.result.reasons[0]).toMatch(/unresolved deleted dependency/u);
		expect(fixture.invocations).toEqual([UNIT_FILES, UNIT_FILES]);
	});

	it("bypasses a warmed cache when root package.json is renamed out", () => {
		const fixture = makeFixture();
		expect(run(fixture, { all: true }).status).toBe(0);
		const renamed = run(fixture, {
			records: [{ path: "package.saved.json", oldPath: "package.json", status: "R" }],
		});
		expect(renamed.result).toMatchObject({
			kind: "run-all",
			cachePolicy: "bypass",
			changed: [{ path: "package.saved.json", oldPath: "package.json", status: "R" }],
			cacheHits: [],
			toRun: UNIT_FILES,
			counts: { total: 2, selected: 2, cacheHit: 0, run: 2 },
		});
		expect(renamed.result.reasons).toEqual([
			"root package topology change: package.json -> package.saved.json",
		]);
		expect(fixture.invocations).toEqual([UNIT_FILES, UNIT_FILES]);
	});

	it("retains only explicit fresh PASS verdicts across RUN-ALL, failures, and missing reports", () => {
		const fixture = makeFixture();
		expect(run(fixture, { all: true }).result.counts).toMatchObject({ selected: 2, cacheHit: 0, run: 2 });

		const boundedHit = run(fixture, { records: [{ path: "src/a.ts", status: "M" }] });
		expect(boundedHit.result.outcome).toBe("cache-hit-all");
		expect(boundedHit.result.summary).toBe("CACHE-HIT-ALL selected=1, cache-hit=1, run=0");
		expect(fixture.invocations).toHaveLength(1);

		const broad = run(fixture, { records: [{ path: "unknown.bin", status: "A" }] });
		expect(broad.result.summary).toContain("RUN-ALL");
		expect(broad.result.counts).toMatchObject({ selected: 2, cacheHit: 0, run: 2 });

		const mixed = run(fixture, {
			records: [{ path: "unknown.bin", status: "A" }],
			fail: [UNIT_FILES[1]],
		});
		expect(mixed.status).toBe(1);
		expect(mixed.result.outcome).toBe("fail");
		expect(cachedTests(fixture)).toEqual([UNIT_FILES[0]]);

		expect(run(fixture, { records: [{ path: "src/a.ts", status: "M" }] }).result.outcome).toBe("cache-hit-all");
		expect(run(fixture, { records: [{ path: "src/b.ts", status: "M" }] }).result.counts)
			.toMatchObject({ selected: 1, cacheHit: 0, run: 1 });

		const ambiguous = run(fixture, {
			records: [{ path: "unknown.bin", status: "A" }],
			fail: [UNIT_FILES[1]],
			missingReport: true,
		});
		expect(ambiguous.status).toBe(1);
		expect(run(fixture, { records: [{ path: "src/a.ts", status: "M" }] }).result.counts)
			.toMatchObject({ selected: 1, cacheHit: 0, run: 1 });
	});

	it("fails closed for incomplete, malformed, duplicate, and contradictory batch verdicts", () => {
		const fixture = makeFixture();
		const result = (name: string, status: "passed" | "failed") => ({
			name: path.join(fixture.root, name),
			status,
		});
		const cases: Array<{ label: string; status: number | null; report?: unknown }> = [
			{ label: "missing report", status: 0 },
			{ label: "malformed report", status: 0, report: "not json" },
			{
				label: "partial report",
				status: 0,
				report: { testResults: [result(UNIT_FILES[0], "passed")] },
			},
			{
				label: "duplicate verdict",
				status: 0,
				report: {
					testResults: [
						result(UNIT_FILES[0], "passed"),
						result(UNIT_FILES[0], "passed"),
						result(UNIT_FILES[1], "passed"),
					],
				},
			},
			{
				label: "conflicting duplicate verdict",
				status: 1,
				report: {
					testResults: [
						result(UNIT_FILES[0], "passed"),
						result(UNIT_FILES[0], "failed"),
						result(UNIT_FILES[1], "passed"),
					],
				},
			},
			{
				label: "zero exit with a failed verdict",
				status: 0,
				report: {
					testResults: [result(UNIT_FILES[0], "passed"), result(UNIT_FILES[1], "failed")],
				},
			},
			{
				label: "nonzero exit with only passing verdicts",
				status: 1,
				report: {
					testResults: [result(UNIT_FILES[0], "passed"), result(UNIT_FILES[1], "passed")],
				},
			},
		];

		for (const testCase of cases) {
			rmSync(path.join(fixture.root, ".profiles", "test-cache", "results.json"), { force: true });
			const outcome = executeReportedBatch(fixture, testCase.status, testCase.report);
			expect(outcome.outcome, testCase.label).toBe("fail");
			expect(outcome.certifiedPassing, testCase.label).toEqual(new Set());
			expect(cachedTests(fixture), testCase.label).toEqual([]);
		}
	});

	it("fails a multi-batch run without certifying any file from a partial batch", () => {
		const fixture = makeFixture();
		const files = ["a", "b", "c", "d"].map(prefix =>
			`tests2/core/${prefix}${"x".repeat(11_000)}.test.ts`);
		const graph = {
			testFiles: files,
			testDeps: new Map(files.map(file => [file, new Set([file])])),
		};
		const plan = planAffectedRun({ repoRoot: fixture.root, all: true }, {
			buildGraph: () => graph,
		});
		const batches: string[][] = [];
		const outcome = executeAffectedRun(plan, { platform: "win32" }, {
			executeTests: ({ files: batch, index }: { files: string[]; index: number }) => {
				batches.push(batch);
				const reported = index === 0 ? batch : batch.slice(0, 1);
				return {
					status: 0,
					report: {
						testResults: reported.map(file => ({ name: file, status: "passed" })),
					},
				};
			},
		});

		expect(batches).toEqual([files.slice(0, 2), files.slice(2)]);
		expect(outcome.outcome).toBe("fail");
		expect(outcome.certifiedPassing).toEqual(new Set(files.slice(0, 2)));
		expect(cachedTests(fixture)).toEqual(files.slice(0, 2));
	});

	it("bypasses warm cache for every transitive Vitest configuration input, including tombstones", () => {
		const fixture = makeFixture();
		run(fixture, { all: true });
		for (const [index, configInput] of [...fixture.configInputs].entries()) {
			const result = run(fixture, { records: [{ path: configInput, status: "M" }] });
			expect(result.result, configInput).toMatchObject({
				kind: "run-all",
				cachePolicy: "bypass",
				cacheHits: [],
				toRun: UNIT_FILES,
				counts: { total: 2, selected: 2, cacheHit: 0, run: 2 },
			});
			expect(fixture.invocations, configInput).toHaveLength(index + 2);
		}

		const dynamicInput = "tests2/harness/dynamic-config-input.ts";
		fixture.configInputs.add(dynamicInput);
		write(fixture.root, dynamicInput, "export const dynamicConfigInput = true;\n");
		expect(run(fixture, { records: [{ path: dynamicInput, status: "M" }] }).result.kind).toBe("run-all");
		remove(fixture.root, dynamicInput);
		expect(run(fixture, { records: [{ path: dynamicInput, status: "D" }] }).result.kind).toBe("run-all");
	});

	it("does not certify code, non-code, or runner inputs mutated during execution", () => {
		const fixture = makeFixture();
		const cacheFile = path.join(fixture.root, ".profiles", "test-cache", "results.json");

		run(fixture, {
			records: [{ path: "src/a.ts", status: "M" }],
			mutatePath: "src/a.ts",
		});
		expect(cachedTests(fixture)).not.toContain(UNIT_FILES[0]);
		expect(run(fixture, { records: [{ path: "src/a.ts", status: "M" }] }).result.counts)
			.toMatchObject({ selected: 1, cacheHit: 0, run: 1 });
		expect(run(fixture, { records: [{ path: "src/a.ts", status: "M" }] }).result.outcome).toBe("cache-hit-all");

		rmSync(cacheFile, { force: true });
		run(fixture, {
			records: [{ path: "defaults/roles/coder.yaml", status: "M" }],
			mutatePath: "defaults/roles/coder.yaml",
		});
		expect(cachedTests(fixture)).not.toContain(UNIT_FILES[0]);

		rmSync(cacheFile, { force: true });
		const mutation = run(fixture, { all: true, mutatePath: "vitest.config.ts" });
		expect(mutation.result).toMatchObject({
			kind: "run-all",
			cachePolicy: "bypass",
			counts: { selected: 2, cacheHit: 0, run: 2 },
		});
		expect(cachedTests(fixture)).toEqual([]);
		expect(run(fixture, { records: [{ path: "src/a.ts", status: "M" }] }).result.counts)
			.toMatchObject({ selected: 1, cacheHit: 0, run: 1 });
	});

	it("invalidates dependency hashes and fingerprints every execution boundary", () => {
		const fixture = makeFixture();
		const options = { repoRoot: fixture.root };
		const deps = new Set([UNIT_FILES[0], "defaults/roles/coder.yaml"]);
		const initialHash = testHash(UNIT_FILES[0], deps, options);
		write(fixture.root, "defaults/roles/coder.yaml", "name: reviewer\n");
		expect(testHash(UNIT_FILES[0], deps, options)).not.toBe(initialHash);

		const packagePath = path.join(fixture.root, "package.json");
		const initialPackage = JSON.parse(readFileSync(packagePath, "utf8"));
		const initialFingerprint = runnerFingerprint(options);
		writeFileSync(packagePath, JSON.stringify({ ...initialPackage, scripts: { test: "metadata-only-change" } }));
		expect(runnerFingerprint(options)).toBe(initialFingerprint);
		writeFileSync(packagePath, JSON.stringify({
			...initialPackage,
			dependencies: { ...initialPackage.dependencies, beta: "2.0.0" },
		}));
		expect(runnerFingerprint(options)).not.toBe(initialFingerprint);
		writeFileSync(packagePath, JSON.stringify(initialPackage));

		for (const file of [
			"package-lock.json", "tsconfig.json", "vitest.config.ts", "tests2/tests-map.json",
			"scripts/testing-v2/test-map-execution.mjs", "scripts/testing-v2/repo-source-closure.mjs",
			"tests2/harness/run-isolation.ts", "scripts/testing-v2/environment-policy.mjs",
			"tests2/harness/unit-file-budget-reporter.ts", "scripts/affected/graph.mjs",
			"scripts/affected/impact-rules.mjs", "scripts/affected/classification.mjs",
			"scripts/affected/run.mjs", "scripts/affected/runner.mjs", "scripts/affected/cache.mjs",
		]) {
			const target = path.join(fixture.root, file);
			const before = readFileSync(target, "utf8");
			const fingerprint = runnerFingerprint(options);
			appendFileSync(target, "\n// fingerprint mutation\n");
			expect(runnerFingerprint(options), file).not.toBe(fingerprint);
			writeFileSync(target, before);
		}

		write(fixture.root, ".profiles/test-cache/results.json", "not json");
		expect(loadCache(options)).toEqual({});
		const graph = { testDeps: new Map([[UNIT_FILES[0], deps]]) };
		const tests = new Set([UNIT_FILES[0]]);
		const stableHashes = snapshotTestHashes(graph, tests, options);
		const records = record({}, "fp", tests, "pass", stableHashes);
		expect(records.fp[UNIT_FILES[0]]).toEqual({ hash: stableHashes.get(UNIT_FILES[0]), verdict: "pass" });
		record(records, "fp", tests, "fail");
		expect(records.fp).toEqual({});
	});

	it("batches long Windows command lines without subprocesses", () => {
		const fixture = makeFixture();
		const files = ["a", "b", "c"].map(prefix => `tests2/core/${prefix}${"x".repeat(12_000)}.test.ts`);
		const graph = { testFiles: files, testDeps: new Map(files.map(file => [file, new Set([file])])) };
		const plan = planAffectedRun({ repoRoot: fixture.root, all: true, noCache: true }, {
			buildGraph: () => graph,
		});
		const batches: string[][] = [];
		const result = executeAffectedRun(plan, { platform: "win32" }, {
			executeTests: ({ files: batch }: { files: string[] }) => {
				batches.push(batch);
				return { status: 0, report: { testResults: batch.map(file => ({ name: path.join(fixture.root, file), status: "passed" })) } };
			},
		});
		expect(result.outcome).toBe("pass");
		expect(batches).toEqual(files.map(file => [file]));
	});
});
