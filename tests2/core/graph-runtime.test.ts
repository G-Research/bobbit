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
import { GraphStore } from "../../market-packs/code-intelligence/src/graph-store.ts";

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
