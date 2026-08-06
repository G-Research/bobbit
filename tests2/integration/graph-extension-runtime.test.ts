import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { GraphQueryService, type GraphComponentSnapshot } from "../../market-packs/code-intelligence/src/graph-query.ts";
import { GraphRuntime, GraphRuntimeFacade, getGraphRuntime, type GraphRuntimePort, type GraphTarget } from "../../market-packs/code-intelligence/src/graph-runtime.ts";
import { GraphStore, type GraphKind, type GraphMeta, type GraphSlot } from "../../market-packs/code-intelligence/src/graph-store.ts";

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

	it("reads only the verified worktree slot and its direct server-derived parent fallback", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-runtime-slots-"));
		try {
			const store = new GraphStore(root, "project");
			const facade = new GraphRuntimeFacade(store, "project");
			const component = { name: "api", repo: "." };
			await publishGraph(store, component, { kind: "branch", goalId: "goal-a", worktreeId: "wt-a", branch: "feature/a" }, "rev-a", "SECRET-A");
			await publishGraph(store, component, { kind: "branch", goalId: "goal-b", worktreeId: "wt-b", branch: "feature/b" }, "rev-b", "SECRET-B");
			await publishGraph(store, component, { kind: "derived-base", goalId: "parent" }, "rev-parent", "PARENT-ONLY");

			const context = authorizedContext();
			const own = await facade.query(context, { op: "query", query: "SECRET", components: ["api", "malicious-sibling"] });
			assert.deepEqual(own.components.map(result => [result.revision, result.results.map(node => node.id)]), [["rev-a", ["SECRET-A"]]]);
			assert.doesNotMatch(JSON.stringify(own), /SECRET-B|rev-b/, "a request component list cannot enumerate a sibling goal/worktree slot");

			const status = await facade.status(context, { component: "malicious-sibling" });
			assert.deepEqual(status.components, [], "an unauthorized component selector does not fall back to another slot");
			const ownStatus = await facade.status(context);
			assert.deepEqual(ownStatus.components.map(result => result.revision), ["rev-a"]);

			const fallback = await facade.query({
				...context,
				worktreeId: "wt-child",
				branch: "feature/child",
				scopeContext: { ...context.scopeContext, goal: { id: "child", ancestry: [{ id: "parent" }, { id: "child" }] } },
			}, { op: "query", query: "PARENT" });
			assert.deepEqual(fallback.components.map(result => [result.revision, result.results.map(node => node.id)]), [["rev-parent", ["PARENT-ONLY"]]]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when project, scope, goal, or worktree identity is absent", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-runtime-missing-context-"));
		try {
			const facade = new GraphRuntimeFacade(new GraphStore(root, "project"), "project");
			for (const context of [
				{ projectId: "project", worktreeId: "wt-a", scopeContext: { component: { name: "api", repo: "." } } },
				{ projectId: "project", worktreeId: "wt-a", scopeContext: { project: { id: "project" }, goal: { id: "goal" } } },
				{ projectId: "project", scopeContext: { project: { id: "project" }, goal: { id: "goal" }, component: { name: "api", repo: "." } } },
			] as const) {
				assert.deepEqual((await facade.status(context)).components, []);
			}
			assert.throws(() => getGraphRuntime({ projectId: "project", scopeContext: { project: { id: "other" } } }), /GRAPH_CONTEXT_PROJECT_REQUIRED/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

function authorizedContext() {
	return {
		projectId: "project", worktreeId: "wt-a", branch: "feature/a",
		scopeContext: { project: { id: "project" }, goal: { id: "goal-a", ancestry: [{ id: "goal-a" }] }, component: { name: "api", repo: "." } },
	};
}

async function publishGraph(store: GraphStore, component: { name: string; repo: string }, slot: GraphSlot, revision: string, marker: string): Promise<void> {
	const candidate = await store.createCandidate(component);
	fs.mkdirSync(path.join(candidate.root, "data"), { recursive: true });
	fs.writeFileSync(path.join(candidate.root, "data", "graph.json"), JSON.stringify({ nodes: [{ id: marker, label: marker, path: "src/index.ts" }], edges: [] }));
	await store.publishCandidate(candidate, graphMeta(component, slot.kind, revision), { slot });
}

function graphMeta(component: { name: string; repo: string }, kind: GraphKind, revision: string): GraphMeta {
	return {
		schema: 1, component, kind,
		anchor: { cwdMode: "component-root-relative", scanRoots: ["src"] },
		corpus: { roots: [{ path: "src", tier: "code" }], trackedOnly: true },
		graphify: { resolvedVersion: "2.3.4", resolvedAt: "2026-01-01T00:00:00.000Z", requiredCapability: "incremental-delta" },
		revisions: { baseRef: "main", baseRev: "base", headRev: revision },
		build: { startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", buildMs: 1, nodes: 1, edges: 0, bytes: 1, clustered: true, tierLatencyMs: { code: 1 } },
		state: "fresh", applied: { changedPaths: [], dirtyPaths: [], deltaNodeCount: 0 },
	};
}
