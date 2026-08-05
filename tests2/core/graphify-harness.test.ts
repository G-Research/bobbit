import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
	createHarnessAnchor,
	createHarnessCorpus,
	GraphifyChainHarness,
	validateHarnessCandidate,
	type HarnessCorpus,
	type HarnessGraph,
} from "../../market-packs/code-intelligence/src/graphify-harness.ts";

function corpus(count: number): HarnessCorpus {
	return createHarnessCorpus(Array.from({ length: count }, (_, index) => ({
		path: `src/file-${String(index).padStart(3, "0")}.ts`,
		sha256: `content-${index}`,
		tracked: true as const,
	})));
}

const baseGraph: HarnessGraph = { sourcePaths: ["defaults/settings.ts", "src/main.ts", "tests2/main.test.ts"], nodes: 100, edges: 75 };

describe("Graphify correctness harness — pinned identity and validation thresholds", () => {
	it("canonicalizes component-relative roots and corpus metadata independently of invocation order", () => {
		const firstAnchor = createHarnessAnchor(["tests2", "src", "defaults", "src"]);
		const secondAnchor = createHarnessAnchor(["defaults", "src", "tests2"]);
		assert.deepEqual(firstAnchor, { cwdMode: "component-root-relative", scanRoots: ["defaults", "src", "tests2"] });
		assert.deepEqual(firstAnchor, secondAnchor);

		const firstCorpus = createHarnessCorpus([
			{ path: "tests2/main.test.ts", sha256: "test", tracked: true },
			{ path: "src/main.ts", sha256: "code", tracked: true },
		]);
		const secondCorpus = createHarnessCorpus([
			{ path: "src/main.ts", sha256: "code", tracked: true },
			{ path: "tests2/main.test.ts", sha256: "test", tracked: true },
		]);
		assert.deepEqual(firstCorpus, secondCorpus);
		assert.throws(() => createHarnessAnchor(["src", "../outside"]), /invalid component-relative path/);
	});

	it("rejects the 91-node anchor-collapse fixture before a candidate can be accepted", () => {
		const expectedAnchor = createHarnessAnchor(["src", "tests2", "defaults"]);
		const fullCorpus = corpus(100);
		const result = validateHarnessCandidate({
			expectedAnchor,
			observedAnchor: createHarnessAnchor(["src"]),
			expectedCorpus: fullCorpus,
			observedCorpus: fullCorpus,
			previous: baseGraph,
			graph: { sourcePaths: ["src/main.ts"], nodes: 9, edges: 8 },
			maxUnaccountedNodeLoss: 0,
		});

		assert.equal(baseGraph.nodes - 9, 91, "fixed fixture must retain the approximately 91% collapse shape");
		assert.equal(result.ok, false);
		assert.deepEqual(result.failures, ["ANCHOR_MISMATCH", "UNEXPLAINED_SHRINK"]);
	});

	it("rejects the 63-file corpus-drift fixture even when roots and graph source prefixes match", () => {
		const expectedCorpus = corpus(100);
		const observedCorpus = corpus(37);
		const anchor = createHarnessAnchor(["src", "tests2", "defaults"]);
		const result = validateHarnessCandidate({
			expectedAnchor: anchor,
			observedAnchor: anchor,
			expectedCorpus,
			observedCorpus,
			graph: { sourcePaths: ["src/file-000.ts"], nodes: 37, edges: 36 },
		});

		assert.equal(expectedCorpus.files.length - observedCorpus.files.length, 63, "fixed fixture must retain the approximately 63% drift shape");
		assert.deepEqual(result, { ok: false, failures: ["CORPUS_DRIFT"] });
	});

	it("requires all changed paths to be either present or explicitly pruned and rejects outside-root sources", () => {
		const anchor = createHarnessAnchor(["src", "tests2", "defaults"]);
		const expectedCorpus = corpus(1);
		const valid = validateHarnessCandidate({
			expectedAnchor: anchor,
			observedAnchor: anchor,
			expectedCorpus,
			observedCorpus: expectedCorpus,
			changedPaths: ["src/added.ts", "src/modified.ts", "src/deleted.ts", "src/renamed-old.ts", "src/renamed-new.ts"],
			prunedPaths: ["src/deleted.ts", "src/renamed-old.ts"],
			graph: { sourcePaths: ["src/added.ts", "src/modified.ts", "src/renamed-new.ts"], nodes: 4, edges: 3 },
		});
		assert.equal(valid.ok, true);

		const invalid = validateHarnessCandidate({
			expectedAnchor: anchor,
			observedAnchor: anchor,
			expectedCorpus,
			observedCorpus: expectedCorpus,
			changedPaths: ["src/changed.ts"],
			graph: { sourcePaths: ["outside/escape.ts"], nodes: 1, edges: 0 },
		});
		assert.deepEqual(invalid.failures, ["OUTSIDE_PINNED_ROOT", "DELTA_CLOSURE_FAILURE"]);
	});
});

describe("Graphify correctness harness — direct-base lineage and stale children", () => {
	it("requires main → direct parent-derived → child lineage and never returns a stale child as current", () => {
		const chain = new GraphifyChainHarness();
		chain.addBase("main-a", "A", baseGraph);
		chain.derive("parent-b", "derived-base", "main-a", "B", { sourcePaths: [...baseGraph.sourcePaths, "src/parent.ts"], nodes: 104, edges: 78 });
		chain.derive("child-c", "branch", "parent-b", "C", { sourcePaths: ["src/child.ts"], nodes: 106, edges: 80 });

		assert.equal(chain.current("child-c")?.parentId, "parent-b", "a child must be derived from the immediate parent, not main");
		assert.deepEqual(chain.advanceParent("parent-b"), ["parent-b", "child-c"]);
		assert.equal(chain.current("parent-b"), null, "the replaced parent-derived base cannot be selected as current");
		assert.equal(chain.current("child-c"), null, "a stale child cannot be selected as current");

		chain.derive("parent-d", "derived-base", "main-a", "D", { sourcePaths: ["src/parent-v2.ts"], nodes: 108, edges: 82 });
		chain.derive("child-e", "branch", "parent-d", "E", { sourcePaths: ["src/child-v2.ts"], nodes: 110, edges: 84 });
		assert.equal(chain.current("child-e")?.parentId, "parent-d");
	});

	it("rejects a missing or stale direct base instead of silently falling back to main", () => {
		const chain = new GraphifyChainHarness();
		chain.addBase("main-a", "A", baseGraph);
		assert.throws(() => chain.derive("missing", "branch", "unknown-parent", "C", baseGraph), /unknown harness snapshot/);
		chain.derive("parent-b", "derived-base", "main-a", "B", baseGraph);
		chain.derive("child-c", "branch", "parent-b", "C", baseGraph);
		chain.advanceParent("parent-b");
		assert.throws(() => chain.derive("grandchild", "branch", "child-c", "D", baseGraph), /cannot derive from stale snapshot/);
	});
});
