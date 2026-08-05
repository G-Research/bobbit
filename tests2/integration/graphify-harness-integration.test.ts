import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
	createHarnessAnchor,
	createHarnessCorpus,
	GraphifyChainHarness,
	validateHarnessCandidate,
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

const fixtureRoot = path.resolve("tests2/fixtures/graphify-corpus");
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "fixture.json"), "utf8")) as Fixture;

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

function measure(operation: string, run: () => { nodes: number; edges: number; bytes: number }) {
	const started = performance.now();
	const result = run();
	return { operation, elapsedMs: performance.now() - started, ...result };
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
			maxUnaccountedNodeLoss: 0,
		});

		expect(validation).toEqual({ ok: true, failures: [] });
		expect(after.sourcePaths).not.toContain("src/greeting.ts");
		expect(after.sourcePaths).not.toContain("project-addition/plugin.ts");
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

	it("emits measured base, clone, delta, size, and query benchmark rows without treating timing as a pass budget", () => {
		const baseSources = ["src/entry.ts", "src/greeting.ts", "tests2/entry.test.ts", "defaults/config.ts"];
		const rows = [
			measure("base", () => { const result = graph(baseSources); return { nodes: result.nodes, edges: result.edges, bytes: Buffer.byteLength(JSON.stringify(result)) }; }),
			measure("clone", () => { const result = graph([...baseSources]); return { nodes: result.nodes, edges: result.edges, bytes: Buffer.byteLength(JSON.stringify(result)) }; }),
			measure("delta-no-cluster", () => { const result = graph([...baseSources, "src/added.ts"]); return { nodes: result.nodes, edges: result.edges, bytes: Buffer.byteLength(JSON.stringify(result)) }; }),
			measure("store-size", () => { const body = JSON.stringify({ sources: baseSources }); return { nodes: 0, edges: 0, bytes: Buffer.byteLength(body) }; }),
			measure("query", () => { const result = baseSources.filter(source => source.includes("greeting")); return { nodes: result.length, edges: 0, bytes: Buffer.byteLength(JSON.stringify(result)) }; }),
		];
		const report = {
			fixtureRevision: fixture.revision,
			machine: { platform: process.platform, arch: process.arch, node: process.version },
			graphifyVersion: "harness-contract",
			roots: fixture.roots,
			derivedReclusterThresholdNodes: 10,
			rows,
		};

		expect(rows.map(row => row.operation)).toEqual(["base", "clone", "delta-no-cluster", "store-size", "query"]);
		expect(rows.every(row => Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0)).toBe(true);
		process.stdout.write(`GRAPHIFY_HARNESS_BENCHMARK ${JSON.stringify(report)}\n`);
	});
});
