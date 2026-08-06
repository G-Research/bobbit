import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

import { GraphQueryService, type GraphComponentSnapshot } from "../../market-packs/code-intelligence/src/graph-query.ts";
import { GraphRuntime, type GraphRuntimePort, type GraphTarget } from "../../market-packs/code-intelligence/src/graph-runtime.ts";

type Fixture = { revision: string; components: Array<{ name: string; repo: string; files: string[] }> };
const fixtureRoot = path.resolve("tests2/fixtures/graph-extension-runtime");
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "fixture.json"), "utf8")) as Fixture;

function target(component = "api"): GraphTarget {
	return { projectId: "integration-project", component, worktreeId: `worktree-${component}`, goalId: "child-goal", parentGoalId: "parent-goal", primaryRef: "main" };
}

function snapshots(state: "fresh" | "base-fallback" | "stale" = "fresh", staleReason?: string): GraphComponentSnapshot[] {
	return [
		{
			component: { name: "api", repo: "." }, revisions: { baseRef: "main", baseRev: "base-api", headRev: "child-api" }, state,
			...(staleReason ? { staleReason } : {}),
			graph: {
				nodes: [
					{ id: "entry", label: "Entry", tier: "code", sourceRoot: "src", sourcePath: "src/entry.ts", community: "api" },
					{ id: "service", label: "Service", tier: "code", sourceRoot: "src", sourcePath: "src/renamed-service.ts", community: "api" },
					{ id: "guide", label: "Service guide", tier: "docs", sourceRoot: "docs", sourcePath: "docs/service-guide.md", community: "api" },
				],
				edges: [{ from: "entry", to: "service", type: "calls" }, { from: "guide", to: "service", type: "documents" }],
			},
		},
		{
			component: { name: "web", repo: "packages/web" }, revisions: { baseRef: "main", baseRev: "base-web", headRev: "child-web" }, state: "fresh",
			graph: { nodes: [{ id: "client", label: "Web client", tier: "code", sourceRoot: "src", sourcePath: "src/client.ts", community: "web" }], edges: [] },
		},
	];
}

describe("Graph Extension Runtime integration", () => {
	it("keeps lifecycle adapters non-blocking and incapable of starting graph work", async () => {
		let resolveCalls = 0;
		let manualCalls = 0;
		const port: GraphRuntimePort = {
			resolveTargets: async () => { resolveCalls += 1; return [target()]; },
			manualRebuild: async () => { manualCalls += 1; return { accepted: true }; },
		};
		const runtime = new GraphRuntime(port);

		assert.deepEqual(await runtime.goalProvisioned({}), { blocks: [] });
		assert.deepEqual(await runtime.afterTurn({}), { blocks: [] });
		assert.equal(resolveCalls, 0, "hooks neither inspect checkouts nor start a worker");
		assert.equal(manualCalls, 0, "hooks cannot escape through the manual rebuild seam");
		assert.deepEqual(await runtime.rebuild({}), { accepted: true });
		assert.equal(resolveCalls, 1);
		assert.equal(manualCalls, 1, "manual execution is direct and route-owned");
	});

	it("fans out by component label, keeps docs opt-in, and records code and code+docs timings", async () => {
		const metrics: Array<{ component: string; scope: string }> = [];
		const service = new GraphQueryService({ list: names => snapshots().filter(snapshot => !names || names.includes(snapshot.component.name)) }, { record: metric => { metrics.push(metric); } });

		const codeOnly = await service.query("guide");
		assert.equal(codeOnly.components.every(component => component.results.every(node => node.tier === "code")), true);
		assert.equal(codeOnly.components.flatMap(component => component.results).length, 0);
		assert.equal(codeOnly.noCrossRepoEdges, true);
		assert.equal(codeOnly.warning, "v1 has no cross-repo edges");
		assert.deepEqual(codeOnly.components.map(component => [component.component.name, component.component.repo]), [["api", "."], ["web", "packages/web"]]);

		const withDocs = await service.query("guide", { includeDocs: true, components: ["api"] });
		assert.deepEqual(withDocs.components[0].results.map(node => [node.id, node.tier]), [["guide", "docs"]]);
		assert.deepEqual(metrics.map(metric => metric.scope), ["code", "code", "codeDocs"]);
	});

	it("retains an honest last-good fallback without claiming lifecycle recomputation", async () => {
		const fallback = new GraphQueryService({ list: names => snapshots("base-fallback", "validation-failed").filter(snapshot => !names || names.includes(snapshot.component.name)) });
		const response = await fallback.query("service", { components: ["api"] });
		assert.equal(response.components[0].banner, "BASE FALLBACK");
		assert.equal(response.components[0].staleReason, "validation-failed");
		assert.deepEqual(response.components[0].results.map(node => node.id), ["service"]);
	});

	it("uses the checked-in, component-labelled corpus fixture", () => {
		assert.equal(fixture.revision, "graph-extension-runtime-v1");
		assert.deepEqual(fixture.components.map(component => [component.name, component.repo]), [["api", "."], ["web", "packages/web"]]);
		assert.equal(fixture.components.flatMap(component => component.files).some(file => file.startsWith("docs/")), true);
	});
});
