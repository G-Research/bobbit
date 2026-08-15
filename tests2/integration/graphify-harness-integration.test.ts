import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createHarnessAnchor,
	createHarnessCorpus,
	GraphifyChainHarness,
	GraphifyPublicationHarness,
	validateHarnessCandidate,
	type HarnessCorpus,
	type HarnessCorpusFile,
	type HarnessGraph,
} from "../../market-packs/code-intelligence/src/graphify-harness.ts";

type Fixture = {
	revision: string;
	roots: string[];
	regressions: {
		anchorCollapse: { sourceFiles: number; collapsedSourceFiles: number; expectedLossPercent: number };
		corpusDrift: { sourceFiles: number; driftedSourceFiles: number; expectedLossPercent: number };
	};
};
type Benchmark = {
	graphify: { available: boolean; version: string | null; reason?: string };
	measurement: { status: "unavailable"; command: string };
	contractFixture: { identity: "contract-fixture"; command: string; fixtureRevision: string; rootDigest: string; measuredAt: string; graph: { nodes: number; edges: number } };
	rows: Array<{ fixture: "contract-fixture"; operation: string; elapsedMs: number; bytes?: number; matches?: number }>;
};
type Timing = { samplesMs: number[]; p50Ms: number; p95Ms: number };
type LinkedWorktreeBenchmark = {
	installedGraphify: { available: boolean; version: string | null; probeCommand: string; reason: string };
	measurement: { identity: "graphify-contract-fixture"; executable: string; notice: string };
	scenarios: Record<"code-only" | "code-plus-docs", {
		scanRoots: string[];
		baseBuild: Timing;
		clone: Timing;
		deltaNoCluster: Timing;
		query: Timing;
		graph: { bytes: { samples: number[]; min: number; max: number }; nodes: number; edges: number };
		guard: { linkedWorktreeGuardCalls: number; samples: number };
	}>;
};

const fixtureRoot = path.resolve("tests2/fixtures/graphify-corpus");
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "fixture.json"), "utf8")) as Fixture;
const benchmark = JSON.parse(fs.readFileSync(path.resolve("tests2/fixtures/graphify-benchmarks/harness-contract.json"), "utf8")) as Benchmark;
const linkedWorktreeBenchmark = JSON.parse(fs.readFileSync(path.resolve("tests2/fixtures/graphify-benchmarks/linked-worktree-contract.json"), "utf8")) as LinkedWorktreeBenchmark;

function corpus(prefix: string, count: number) {
	const files: HarnessCorpusFile[] = Array.from({ length: count }, (_, index) => ({
		path: `${prefix}/module-${String(index + 1).padStart(2, "0")}.ts`,
		sha256: `fixture-sha-${index + 1}`,
		tracked: true,
	}));
	return createHarnessCorpus(files);
}

function graph(sourcePaths: string[], nodes = sourcePaths.length * 3, edges = sourcePaths.length): HarnessGraph {
	return { sourcePaths, nodes, edges };
}

function corpusFromFilesystem(root: string, roots: readonly string[]): HarnessCorpus {
	const files: HarnessCorpusFile[] = [];
	const collect = (directory: string) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) collect(absolute);
			else if (entry.isFile()) files.push({
				path: path.relative(root, absolute).replaceAll(path.sep, "/"),
				sha256: createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"),
				tracked: true,
			});
		}
	};
	for (const scanRoot of roots) collect(path.join(root, scanRoot));
	return createHarnessCorpus(files);
}

function writeFile(root: string, relative: string, content: string): void {
	const file = path.join(root, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function writeGraph(directory: string, corpusValue: HarnessCorpus): HarnessGraph {
	const value = graph(corpusValue.files.map(file => file.path));
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, "graph.json"), JSON.stringify(value, null, 2));
	return value;
}

describe("Graphify correctness harness integration", () => {
	it("accepts a complete add/modify/delete/rename delta over the pinned fixture roots", () => {
		const anchor = createHarnessAnchor(fixture.roots);
		const before = graph(["src/entry.ts", "src/greeting.ts", "tests2/entry.test.ts", "defaults/config.ts", "project-addition/plugin.ts"], 15, 9);
		const after = graph(["src/entry.ts", "src/renamed-greeting.ts", "tests2/entry.test.ts", "defaults/config.ts", "project-addition/new-plugin.ts"], 14, 8);
		const expectedCorpus = createHarnessCorpus([
			{ path: "src/entry.ts", sha256: "changed-entry", tracked: true },
			{ path: "src/renamed-greeting.ts", sha256: "renamed", tracked: true },
			{ path: "tests2/entry.test.ts", sha256: "stable-test", tracked: true },
			{ path: "defaults/config.ts", sha256: "stable-default", tracked: true },
			{ path: "project-addition/new-plugin.ts", sha256: "added", tracked: true },
		]);

		const validation = validateHarnessCandidate({
			expectedAnchor: anchor,
			observedAnchor: createHarnessAnchor([...fixture.roots].reverse()),
			expectedCorpus,
			observedCorpus: expectedCorpus,
			graph: after,
			previous: before,
			changedPaths: ["src/entry.ts", "src/greeting.ts", "src/renamed-greeting.ts", "project-addition/plugin.ts", "project-addition/new-plugin.ts"],
			prunedPaths: ["src/greeting.ts", "project-addition/plugin.ts"],
			prunedNodeCounts: { "src/greeting.ts": 1, "project-addition/plugin.ts": 0 },
			maxUnaccountedNodeLoss: 0,
		});

		expect(validation).toEqual({ ok: true, failures: [] });
		expect(after.sourcePaths).not.toContain("src/greeting.ts");
		expect(after.sourcePaths).not.toContain("project-addition/plugin.ts");
	});

	it("uses only external filesystem candidates for clone, delta, validation, promotion, and rollback", () => {
		const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "graphify-publication-fixture-"));
		const component = path.join(sandbox, "component");
		const state = path.join(sandbox, "host-state");
		const roots = ["src", "tests2", "defaults", "project-addition"];
		try {
			writeFile(component, "src/entry.ts", "export const entry = 'base';\n");
			writeFile(component, "src/greeting.ts", "export const greeting = 'base';\n");
			writeFile(component, "tests2/entry.test.ts", "export const testEntry = true;\n");
			writeFile(component, "defaults/config.ts", "export const config = true;\n");
			writeFile(component, "project-addition/plugin.ts", "export const plugin = 'base';\n");
			const anchor = createHarnessAnchor(roots);
			const baseCorpus = corpusFromFilesystem(component, roots);
			const current = path.join(state, "accepted", "current");
			const baseGraph = writeGraph(current, baseCorpus);
			const baseGraphBytes = fs.readFileSync(path.join(current, "graph.json"));

			const candidate = path.join(state, "candidates", "feature-delta");
			fs.cpSync(current, candidate, { recursive: true });
			expect(fs.readFileSync(path.join(candidate, "graph.json"))).toEqual(baseGraphBytes);
			expect(path.relative(component, state).startsWith("..")).toBe(true);

			// One delta contains modify, rename, delete, and add operations.
			writeFile(component, "src/entry.ts", "export const entry = 'modified';\n");
			fs.renameSync(path.join(component, "src/greeting.ts"), path.join(component, "src/renamed-greeting.ts"));
			fs.rmSync(path.join(component, "project-addition/plugin.ts"));
			writeFile(component, "project-addition/new-plugin.ts", "export const plugin = 'added';\n");
			const observedCorpus = corpusFromFilesystem(component, roots);
			const observedGraph = writeGraph(candidate, observedCorpus);
			const validation = validateHarnessCandidate({
				expectedAnchor: anchor,
				observedAnchor: createHarnessAnchor([...roots].reverse()),
				expectedCorpus: observedCorpus,
				observedCorpus,
				graph: observedGraph,
				previous: baseGraph,
				changedPaths: ["src/entry.ts", "src/greeting.ts", "src/renamed-greeting.ts", "project-addition/plugin.ts", "project-addition/new-plugin.ts"],
				prunedPaths: ["src/greeting.ts", "project-addition/plugin.ts"],
			});
			expect(validation).toEqual({ ok: true, failures: [] });

			fs.renameSync(current, path.join(state, "accepted", "prior-base"));
			fs.renameSync(candidate, current);
			const published = fs.readFileSync(path.join(current, "graph.json"));
			expect(JSON.parse(published.toString())).toMatchObject({ sourcePaths: expect.arrayContaining(["src/renamed-greeting.ts", "project-addition/new-plugin.ts"]) });

			const rejectedCandidate = path.join(state, "candidates", "bad-anchor");
			fs.cpSync(current, rejectedCandidate, { recursive: true });
			const rejected = validateHarnessCandidate({
				expectedAnchor: anchor,
				observedAnchor: createHarnessAnchor(["src"]),
				expectedCorpus: observedCorpus,
				observedCorpus,
				graph: observedGraph,
			});
			expect(rejected).toEqual({ ok: false, failures: ["ANCHOR_MISMATCH"] });
			fs.rmSync(rejectedCandidate, { recursive: true, force: true });
			expect(fs.readFileSync(path.join(current, "graph.json"))).toEqual(published);
			expect(fs.existsSync(path.join(component, "graph.json"))).toBe(false);
		} finally {
			fs.rmSync(sandbox, { recursive: true, force: true });
		}
	});

	it("rejects the fixed ~91% anchor-collapse trap before a candidate can be published", () => {
		const { sourceFiles, collapsedSourceFiles, expectedLossPercent } = fixture.regressions.anchorCollapse;
		const expected = corpus("src", sourceFiles);
		const observed = corpus("src", collapsedSourceFiles);
		const base = graph(expected.files.map(file => file.path), sourceFiles * 3, sourceFiles * 2);
		const collapsed = graph(observed.files.map(file => file.path), collapsedSourceFiles * 3, collapsedSourceFiles * 2);
		const loss = (1 - collapsedSourceFiles / sourceFiles) * 100;

		expect(loss).toBeCloseTo(expectedLossPercent, 8);
		expect(validateHarnessCandidate({
			expectedAnchor: createHarnessAnchor(["src", "tests2", "defaults"]),
			observedAnchor: createHarnessAnchor(["src"]),
			expectedCorpus: expected,
			observedCorpus: observed,
			graph: collapsed,
			previous: base,
			maxUnaccountedNodeLoss: 0,
		}).failures).toEqual(expect.arrayContaining(["ANCHOR_MISMATCH", "CORPUS_DRIFT", "UNEXPLAINED_SHRINK"]));
	});

	it("rejects the fixed ~63% full-corpus drift trap even when a worker graph is internally consistent", () => {
		const { sourceFiles, driftedSourceFiles, expectedLossPercent } = fixture.regressions.corpusDrift;
		const complete = corpus("src", sourceFiles);
		const drifted = corpus("src", driftedSourceFiles);
		const loss = (1 - driftedSourceFiles / sourceFiles) * 100;

		expect(loss).toBeCloseTo(expectedLossPercent, 8);
		const validation = validateHarnessCandidate({
			expectedAnchor: createHarnessAnchor(["src", "tests2", "defaults"]),
			observedAnchor: createHarnessAnchor(["src", "tests2", "defaults"]),
			expectedCorpus: complete,
			observedCorpus: drifted,
			graph: graph(drifted.files.map(file => file.path)),
		});
		expect(validation).toEqual({ ok: false, failures: ["CORPUS_DRIFT"] });
	});

	it("models main to parent-derived to child lineage and never selects a stale child as current", () => {
		const chain = new GraphifyChainHarness();
		chain.addBase("main-A", "A", graph(["src/entry.ts"]));
		chain.derive("parent-B", "derived-base", "main-A", "B", graph(["src/entry.ts", "src/parent.ts"]));
		chain.derive("child-D", "branch", "parent-B", "D", graph(["src/entry.ts", "src/parent.ts", "src/child.ts"]));

		expect(chain.advanceParent("parent-B")).toEqual(["parent-B", "child-D"]);
		expect(chain.current("parent-B")).toBeNull();
		expect(chain.current("child-D")).toBeNull();
		expect(() => chain.derive("child-rebuild-wrong", "branch", "parent-B", "E", graph(["src/child.ts"]))).toThrow("stale snapshot");
		chain.derive("parent-C", "derived-base", "main-A", "C", graph(["src/entry.ts", "src/parent-v2.ts"]));
		chain.derive("child-E", "branch", "parent-C", "E", graph(["src/entry.ts", "src/parent-v2.ts", "src/child.ts"]));
		expect(chain.current("child-E")?.parentId).toBe("parent-C");
	});

	it("keeps the accepted snapshot when either fixed validation trap rejects a candidate", () => {
		const publication = new GraphifyPublicationHarness();
		const complete = corpus("src", fixture.regressions.anchorCollapse.sourceFiles);
		const acceptedGraph = graph(complete.files.map(file => file.path));
		publication.stage({ id: "accepted", kind: "base", head: "main-A", graph: acceptedGraph, state: "fresh" });
		expect(publication.promote("accepted", { ok: true, failures: [] })).toBe(true);

		const anchorCollapsed = corpus("src", fixture.regressions.anchorCollapse.collapsedSourceFiles);
		const anchorFailure = validateHarnessCandidate({
			expectedAnchor: createHarnessAnchor(["src", "tests2", "defaults"]),
			observedAnchor: createHarnessAnchor(["src"]),
			expectedCorpus: complete,
			observedCorpus: anchorCollapsed,
			graph: graph(anchorCollapsed.files.map(file => file.path)),
		});
		expect(anchorFailure.failures).toContain("ANCHOR_MISMATCH");
		publication.stage({ id: "anchor-collapse", kind: "branch", head: "bad-anchor", graph: graph(anchorCollapsed.files.map(file => file.path)), state: "fresh" });
		expect(publication.promote("anchor-collapse", anchorFailure)).toBe(false);

		const corpusDrifted = corpus("src", fixture.regressions.corpusDrift.driftedSourceFiles);
		const corpusFailure = validateHarnessCandidate({
			expectedAnchor: createHarnessAnchor(["src", "tests2", "defaults"]),
			observedAnchor: createHarnessAnchor(["src", "tests2", "defaults"]),
			expectedCorpus: complete,
			observedCorpus: corpusDrifted,
			graph: graph(corpusDrifted.files.map(file => file.path)),
		});
		expect(corpusFailure.failures).toContain("CORPUS_DRIFT");
		publication.stage({ id: "corpus-drift", kind: "branch", head: "bad-corpus", graph: graph(corpusDrifted.files.map(file => file.path)), state: "fresh" });
		expect(publication.promote("corpus-drift", corpusFailure)).toBe(false);

		expect(publication.current()).toEqual({ id: "accepted", kind: "base", head: "main-A", graph: acceptedGraph, state: "fresh" });
		expect(publication.hasCandidate("anchor-collapse")).toBe(false);
		expect(publication.hasCandidate("corpus-drift")).toBe(false);
	});

	it("records actual contract-fixture timings while keeping installed Graphify availability separate", () => {
		expect(benchmark.graphify).toMatchObject({ available: false, version: null });
		expect(benchmark.graphify.reason).toMatch(/import graphify failed/);
		expect(benchmark.measurement).toEqual({ status: "unavailable", command: "python3 -c 'import graphify'" });
		expect(benchmark.contractFixture).toMatchObject({ identity: "contract-fixture", fixtureRevision: fixture.revision, rootDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
		expect(benchmark.contractFixture.graph).toMatchObject({ nodes: expect.any(Number), edges: expect.any(Number) });
		expect(benchmark.contractFixture.graph.nodes).toBeGreaterThan(0);
		expect(benchmark.rows.map(row => row.operation)).toEqual(["base", "clone", "delta-no-cluster", "size", "query"]);
		for (const row of benchmark.rows) {
			expect(row.fixture).toBe("contract-fixture");
			expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
		}
	});

	it("records code-only and code-plus-docs linked-worktree measurements without calling an unavailable Graphify", () => {
		expect(linkedWorktreeBenchmark.installedGraphify).toMatchObject({ available: false, version: null, probeCommand: "python3 -c 'import graphify'" });
		expect(linkedWorktreeBenchmark.installedGraphify.reason).toMatch(/import graphify failed/);
		expect(linkedWorktreeBenchmark.measurement).toMatchObject({ identity: "graphify-contract-fixture", executable: expect.stringContaining("graphify_fixture.py invoke") });
		expect(linkedWorktreeBenchmark.measurement.notice).toMatch(/not Graphify performance/);
		for (const [name, scenario] of Object.entries(linkedWorktreeBenchmark.scenarios)) {
			expect(scenario.scanRoots.length, name).toBeGreaterThan(0);
			for (const timing of [scenario.baseBuild, scenario.clone, scenario.deltaNoCluster, scenario.query]) {
				expect(timing.samplesMs).toHaveLength(scenario.guard.samples);
				expect(timing.samplesMs.every(sample => sample >= 0)).toBe(true);
				expect(timing.p50Ms).toBeGreaterThanOrEqual(0);
				expect(timing.p95Ms).toBeGreaterThanOrEqual(timing.p50Ms);
			}
			expect(scenario.graph.bytes.samples).toHaveLength(scenario.guard.samples);
			expect(scenario.graph.bytes.min).toBeGreaterThan(0);
			expect(scenario.graph.bytes.max).toBeGreaterThanOrEqual(scenario.graph.bytes.min);
			expect(scenario.graph).toMatchObject({ nodes: expect.any(Number), edges: expect.any(Number) });
			expect(scenario.guard).toEqual({ linkedWorktreeGuardCalls: 0, samples: 7 });
		}
		expect(linkedWorktreeBenchmark.scenarios["code-only"].scanRoots).toEqual(["src"]);
		expect(linkedWorktreeBenchmark.scenarios["code-plus-docs"].scanRoots).toEqual(expect.arrayContaining(["src", "docs"]));
	});
});
