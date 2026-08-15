import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import {
	GraphRuntime,
	GraphRuntimeFacade,
	type GraphRuntimePort,
	type GraphTarget,
} from "../../market-packs/code-intelligence/src/graph-runtime.ts";
import { GraphStore, type GraphMeta, type GraphSlot } from "../../market-packs/code-intelligence/src/graph-store.ts";

const target = (component = "api"): GraphTarget => ({ projectId: "project", component, goalId: "goal", worktreeId: "worktree", primaryRef: "main" });

function port(overrides: Partial<GraphRuntimePort<{}>> = {}): GraphRuntimePort<{}> {
	return { resolveTargets: async () => [target()], ...overrides };
}

describe("GraphRuntime — EP-8 lifecycle boundary", () => {
	it("makes provision and after-turn cheap no-ops without resolving targets or starting detached work", async () => {
		let resolved = 0;
		let manual = 0;
		const runtime = new GraphRuntime(port({
			resolveTargets: async () => { resolved += 1; return [target()]; },
			manualRebuild: async () => { manual += 1; return { accepted: true }; },
		}));

		assert.deepEqual(await runtime.goalProvisioned({}), { blocks: [] });
		assert.deepEqual(await runtime.afterTurn({}), { blocks: [] });
		assert.equal(resolved, 0, "lifecycle hooks do not inspect or enqueue graph work");
		assert.equal(manual, 0, "lifecycle hooks never invoke the manual route seam");
	});

	it("reads bounded fresh orientation without scheduling work and swallows status failures", async () => {
		let resolved = 0;
		const runtime = new GraphRuntime(port({
			resolveTargets: async () => { resolved += 1; return [target()]; },
			readStatus: async () => ({ state: "fresh", component: "api", headRev: "abcdef" }),
		}), { orientationChars: 80 });
		const setup = await runtime.sessionSetup({});
		assert.equal(resolved, 1);
		assert.equal(setup.blocks.length, 1);
		assert.match(setup.blocks[0].content, /unavailable pending EP-8/);
		assert.ok(setup.blocks[0].content.length <= 80);

		const failing = new GraphRuntime(port({ resolveTargets: async () => { throw new Error("unavailable"); } }));
		assert.deepEqual(await failing.sessionSetup({}), { blocks: [] });
	});

	it("calls a manually supplied bounded rebuilder directly and reports EP-8 unavailability when absent", async () => {
		const calls: GraphTarget[][] = [];
		const available = new GraphRuntime(port({
			manualRebuild: async (_context, targets) => {
				calls.push([...targets]);
				return { accepted: true };
			},
		}));
		assert.deepEqual(await available.rebuild({}), { accepted: true });
		assert.deepEqual(calls, [[target()]], "manual rebuild is awaited directly rather than queued");

		const unavailable = new GraphRuntime(port());
		assert.deepEqual(await unavailable.rebuild({}), { accepted: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8" });
	});

	it("projects bounded language facts, conservative graph state, and honest fallback orientation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-runtime-projection-"));
		try {
			fs.mkdirSync(path.join(root, "src"), { recursive: true });
			fs.writeFileSync(path.join(root, "src", "entry.ts"), "export const entry = true;\n");
			fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
			const store = new GraphStore(root, "project");
			const slot: GraphSlot = { kind: "branch", goalId: "goal", worktreeId: "worktree", branch: "feature/status" };
			await publishStatusGraph(store, { name: "api", repo: "." }, slot, "fresh", "api-rev");
			await publishStatusGraph(store, { name: "web", repo: "packages/web" }, slot, "stale", "web-rev", "parent-advanced");
			const facade = new GraphRuntimeFacade(store, "project");
			const context = {
				projectId: "project", worktreeId: "worktree", branch: "feature/status", workingDir: root,
				scopeContext: {
					project: { id: "project" }, goal: { id: "goal", ancestry: [{ id: "goal" }] },
					components: [{ name: "api", repo: "." }, { name: "web", repo: "packages/web" }],
				},
			};
			const status = await facade.status(context);
			assert.deepEqual(status.aggregate, { state: "not-current", label: "Not current" });
			assert.equal(status.state, "not-current");
			assert.equal(status.components.find(component => component.component.name === "web")?.staleReason, "parent-advanced");
			assert.equal(status.languages.find(language => language.languageId === "typescript")?.lsp.state, "disabled");
			assert.match(status.guidance.join(" "), /breadth-first leads/);
			assert.doesNotMatch(JSON.stringify(status), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

			await publishStatusGraph(store, { name: "api", repo: "." }, slot, "base-fallback", "base-rev", "base-rebuilt");
			const fallback = await facade.status({ ...context, scopeContext: { ...context.scopeContext, components: [{ name: "api", repo: "." }] } });
			assert.deepEqual(fallback.aggregate, { state: "limited", label: "Limited" });
			assert.match((await facade.sessionSetup(context)).blocks[0]?.content ?? "", /last accepted graph at base-rev/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("declares automatic lifecycle processing unavailable in durable runtime status and config", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-runtime-status-"));
		try {
			const facade = new GraphRuntimeFacade(new GraphStore(root, "project"));
			const context = { projectId: "project", component: "api" };
			const status = await facade.status(context);
			assert.deepEqual(status.lifecycle, {
				automaticProcessing: "unavailable",
				pending: "EP-8",
				message: "Automatic lifecycle processing is unavailable pending EP-8.",
			});
			assert.ok(status.warnings.some(warning => warning.includes("pending EP-8")));
			assert.deepEqual(await facade.rebuild(context), {
				accepted: false,
				reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8",
				status,
			});
			const config = await facade.config(context);
			assert.deepEqual(config.manualRebuild, { routeOnly: true, available: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8" });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

async function publishStatusGraph(
	store: GraphStore,
	component: { name: string; repo: string },
	slot: GraphSlot,
	state: GraphMeta["state"],
	revision: string,
	staleReason?: GraphMeta["staleReason"],
): Promise<void> {
	const candidate = await store.createCandidate(component);
	fs.mkdirSync(path.join(candidate.root, "data"), { recursive: true });
	fs.writeFileSync(path.join(candidate.root, "data", "graph.json"), JSON.stringify({ nodes: [], edges: [] }));
	await store.publishCandidate(candidate, {
		schema: 1,
		component,
		kind: slot.kind,
		anchor: { cwdMode: "component-root-relative", scanRoots: ["src"] },
		corpus: { roots: [{ path: "src", tier: "code" }], trackedOnly: true },
		graphify: { resolvedVersion: "test", resolvedAt: "2026-01-01T00:00:00.000Z", requiredCapability: "incremental-delta" },
		revisions: { baseRef: "main", baseRev: "base-rev", headRev: revision },
		build: { startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", buildMs: 1, nodes: 0, edges: 0, bytes: 0, clustered: false, tierLatencyMs: {} },
		state,
		...(staleReason ? { staleReason } : {}),
		applied: { changedPaths: [], dirtyPaths: [], deltaNodeCount: 0 },
	}, { slot });
}
