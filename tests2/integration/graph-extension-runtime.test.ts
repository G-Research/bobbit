import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

import { copyGitTemplate } from "../harness/git-template.js";
import { createRunChild, removeOwnedRunChild } from "../harness/run-isolation.js";
import {
	GraphQueryService,
	type GraphComponentSnapshot,
} from "../../market-packs/code-intelligence/src/graph-query.ts";
import {
	GraphRuntime,
	type GraphJob,
	type GraphRuntimePort,
	type GraphTarget,
} from "../../market-packs/code-intelligence/src/graph-runtime.ts";

type Fixture = {
	revision: string;
	components: Array<{ name: string; repo: string; files: string[] }>;
};

const fixtureRoot = path.resolve("tests2/fixtures/graph-extension-runtime");
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "fixture.json"), "utf8")) as Fixture;

class Clock {
	value = 0;
	now = () => this.value;
	advance(ms: number): void { this.value += ms; }
}

function settle(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

function copyFixtureCorpus(checkout: string): void {
	fs.cpSync(path.join(fixtureRoot, "api"), checkout, { recursive: true });
}

/**
 * The immutable template is a real initialized repository. Tier-1 deliberately
 * cannot spawn Git after setup, so the runtime seam receives this deterministic
 * name-status path set; real Git status behavior is covered in the E2E lane.
 */
function applyRecordedTrackedDelta(checkout: string): string[] {
	fs.writeFileSync(path.join(checkout, "src/entry.ts"), "export { service } from './renamed-service';\n");
	fs.renameSync(path.join(checkout, "src/service.ts"), path.join(checkout, "src/renamed-service.ts"));
	fs.rmSync(path.join(checkout, "src/obsolete.ts"));
	fs.writeFileSync(path.join(checkout, "src/added.ts"), "export const added = true;\n");

	return ["src/added.ts", "src/entry.ts", "src/obsolete.ts", "src/renamed-service.ts", "src/service.ts"];
}

function target(component = "api"): GraphTarget {
	return { projectId: "integration-project", component, worktreeId: `worktree-${component}`, goalId: "child-goal", parentGoalId: "parent-goal", primaryRef: "main" };
}

function snapshots(state: "fresh" | "base-fallback" | "stale" = "fresh", staleReason?: string): GraphComponentSnapshot[] {
	return [
		{
			component: { name: "api", repo: "." },
			revisions: { baseRef: "main", baseRev: "base-api", headRev: "child-api" },
			state,
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
			component: { name: "web", repo: "packages/web" },
			revisions: { baseRef: "main", baseRev: "base-web", headRev: "child-web" },
			state: "fresh",
			graph: { nodes: [{ id: "client", label: "Web client", tier: "code", sourceRoot: "src", sourcePath: "src/client.ts", community: "web" }], edges: [] },
		},
	];
}

describe("Graph Extension Runtime integration", () => {
	it("runs one external no-cluster delta for a recorded add/modify/delete/rename set", async () => {
		const sandbox = createRunChild("graph-extension-runtime");
		const checkout = path.join(sandbox, "api");
		try {
			copyGitTemplate(checkout);
			copyFixtureCorpus(checkout);
			assert.equal(fs.existsSync(path.join(checkout, ".git")), true, "fixture keeps a real initialized repository");
			const paths = applyRecordedTrackedDelta(checkout);
			assert.deepEqual(paths, ["src/added.ts", "src/entry.ts", "src/obsolete.ts", "src/renamed-service.ts", "src/service.ts"]);

			const clock = new Clock();
			const executed: GraphJob[] = [];
			const port: GraphRuntimePort = {
				resolveTargets: async () => [target()],
				inspectChanges: async () => ({ head: "child-api", parentHeadRev: "parent-a", changedPaths: paths, dirtyPaths: ["docs/service-guide.md"] }),
				execute: async job => { executed.push(job); },
			};
			const runtime = new GraphRuntime(port, { clock, debounceMs: 5 });
			await runtime.afterTurn({});
			clock.advance(5);
			runtime.tick();
			await settle();

			assert.equal(executed.length, 1);
			assert.equal(executed[0].operation, "delta");
			assert.deepEqual(executed[0].target, target());
			assert.equal(executed[0].head, "child-api");
			assert.equal(executed[0].parentHeadRev, "parent-a");
			assert.deepEqual(executed[0].changedPaths, paths);
			assert.deepEqual(executed[0].dirtyPaths, ["docs/service-guide.md"]);
			assert.equal(executed[0].noCluster, true);
			assert.equal(executed[0].enqueuedAt, 0);
			assert.equal(fs.existsSync(path.join(checkout, "graph.json")), false, "runtime scheduling never writes graph artifacts into a checkout");
		} finally {
			removeOwnedRunChild(sandbox);
		}
	});

	it("fans out by component label, keeps docs opt-in, and records code and code+docs timings", async () => {
		const metrics: Array<{ component: string; scope: string }> = [];
		const service = new GraphQueryService({
			list: names => snapshots().filter(snapshot => !names || names.includes(snapshot.component.name)),
		}, { record: metric => { metrics.push(metric); } });

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

	it("marks child graph lineage stale on a parent advance while retaining an honest last-good fallback", async () => {
		const clock = new Clock();
		let parentHead = "parent-a";
		const stale: string[] = [];
		const executed: GraphJob[] = [];
		const runtime = new GraphRuntime({
			resolveTargets: async () => [target()],
			inspectChanges: async () => ({ head: "child-api", parentHeadRev: parentHead, changedPaths: ["src/entry.ts"] }),
			markStale: async (_target, reason) => { stale.push(reason); },
			execute: async job => { executed.push(job); },
		}, { clock, debounceMs: 1 });

		await runtime.afterTurn({});
		clock.advance(1);
		runtime.tick();
		await settle();
		parentHead = "parent-b";
		await runtime.afterTurn({});
		assert.deepEqual(stale, ["parent-advanced"]);

		const fallback = new GraphQueryService({
			list: names => snapshots("base-fallback", "validation-failed").filter(snapshot => !names || names.includes(snapshot.component.name)),
		});
		const response = await fallback.query("service", { components: ["api"] });
		assert.equal(response.components[0].banner, "BASE FALLBACK");
		assert.equal(response.components[0].staleReason, "validation-failed");
		assert.deepEqual(response.components[0].results.map(node => node.id), ["service"]);
		assert.equal(executed.every(job => job.target.parentGoalId === "parent-goal"), true, "child deltas retain their direct parent identity");
	});

	it("uses the checked-in, component-labelled corpus fixture", () => {
		assert.equal(fixture.revision, "graph-extension-runtime-v1");
		assert.deepEqual(fixture.components.map(component => [component.name, component.repo]), [["api", "."], ["web", "packages/web"]]);
		assert.equal(fixture.components.flatMap(component => component.files).some(file => file.startsWith("docs/")), true);
	});
});
