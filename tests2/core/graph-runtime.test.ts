import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	GraphRuntime,
	type GraphChangeSet,
	type GraphJob,
	type GraphRuntimePort,
	type GraphTarget,
} from "../../market-packs/code-intelligence/src/graph-runtime.ts";

class Clock {
	value = 0;
	now = () => this.value;
	advance(ms: number): void { this.value += ms; }
}

const target = (component = "api"): GraphTarget => ({ projectId: "project", component, goalId: "goal", worktreeId: "worktree", primaryRef: "main" });
const settle = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };

function port(overrides: Partial<GraphRuntimePort<{}>> = {}): GraphRuntimePort<{}> {
	return { resolveTargets: async () => [target()], execute: async () => {}, ...overrides };
}

describe("GraphRuntime — non-blocking, deterministic scheduler", () => {
	it("coalesces duplicate provisioning while observing one component base", async () => {
		const clock = new Clock();
		const jobs: GraphJob[] = [];
		const runtime = new GraphRuntime(port({
			observePrimary: async () => "primary-a",
			execute: async job => { jobs.push(job); },
		}), { clock, maxConcurrency: 1 });

		await runtime.goalProvisioned({});
		await runtime.goalProvisioned({});
		await settle();

		assert.deepEqual(jobs.map(job => job.operation), ["base-rebuild", "provision"]);
		assert.equal(runtime.status().queued, 0, "duplicate goalProvisioned did not add another provision job");
	});

	it("debounces and merges committed plus dirty deltas until the injected clock reaches the due time", async () => {
		const clock = new Clock();
		const jobs: GraphJob[] = [];
		let changes: GraphChangeSet = { head: "a", changedPaths: ["src/a.ts"], dirtyPaths: ["docs/a.md"] };
		const runtime = new GraphRuntime(port({
			inspectChanges: async () => changes,
			execute: async job => { jobs.push(job); },
		}), { clock, debounceMs: 100, maxConcurrency: 1 });

		await runtime.afterTurn({});
		clock.advance(50);
		changes = { head: "b", changedPaths: ["src/b.ts", "src/a.ts"], dirtyPaths: ["src/local.ts"] };
		await runtime.afterTurn({});
		clock.advance(99);
		runtime.tick();
		await settle();
		assert.equal(jobs.length, 0);

		clock.advance(1);
		runtime.tick();
		await settle();
		assert.equal(jobs.length, 1);
		assert.equal(jobs[0].operation, "delta");
		assert.equal(jobs[0].noCluster, true);
		assert.deepEqual(jobs[0].changedPaths, ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(jobs[0].dirtyPaths, ["docs/a.md", "src/local.ts"]);
		assert.equal(jobs[0].head, "b");
	});

	it("coalesces primary advances and enforces the five-minute publish floor", async () => {
		const clock = new Clock();
		let primary = "one";
		const jobs: GraphJob[] = [];
		const runtime = new GraphRuntime(port({
			observePrimary: async () => primary,
			execute: async job => { jobs.push(job); },
		}), { clock, basePublishFloorMs: 300_000 });

		await runtime.goalProvisioned({});
		await settle();
		assert.equal(jobs.filter(job => job.operation === "base-rebuild").length, 1);

		primary = "two";
		await runtime.goalProvisioned({});
		primary = "three";
		await runtime.afterTurn({});
		await settle();
		assert.equal(jobs.filter(job => job.operation === "base-rebuild").length, 1);
		assert.equal(runtime.status().queued, 1, "newest base remains queued during floor");

		clock.advance(300_000);
		runtime.tick();
		await settle();
		const rebuilds = jobs.filter(job => job.operation === "base-rebuild");
		assert.equal(rebuilds.length, 2);
		assert.equal(rebuilds[1].primaryHead, "three");
	});

	it("limits workers and records parent advance without blocking a delta", async () => {
		const clock = new Clock();
		const started: GraphJob[] = [];
		const stale: string[] = [];
		const releases: Array<() => void> = [];
		let parentHead = "parent-a";
		const targets = [target("one"), target("two"), target("three")].map(item => ({ ...item, parentGoalId: "parent" }));
		const runtime = new GraphRuntime(port({
			resolveTargets: async () => targets,
			inspectChanges: async () => ({ changedPaths: ["src/a.ts"], parentHeadRev: parentHead }),
			markStale: async item => { stale.push(item.component); },
			execute: async job => {
				started.push(job);
				await new Promise<void>(resolve => releases.push(resolve));
			},
		}), { clock, debounceMs: 1, maxConcurrency: 2 });

		await runtime.goalProvisioned({});
		await settle();
		assert.equal(started.length, 2, "global worker cap is honored");
		releases.splice(0).forEach(release => release());
		await settle();

		await runtime.afterTurn({});
		parentHead = "parent-b";
		await runtime.afterTurn({});
		assert.deepEqual(stale.sort(), ["one", "three", "two"], "direct-parent advance marks each child stale");
		clock.advance(1);
		runtime.tick();
		for (let i = 0; i < 4; i += 1) {
			releases.splice(0).forEach(release => release());
			await settle();
		}
		assert.ok(started.some(job => job.operation === "delta" && job.parentHeadRev === "parent-b"), "child refresh uses its direct parent revision");
	});

	it("reads bounded fresh orientation without scheduling and swallows hook failures", async () => {
		const failures: string[] = [];
		let executed = 0;
		const runtime = new GraphRuntime(port({
			readStatus: async () => ({ state: "fresh", component: "api", headRev: "abcdef" }),
			execute: async () => { executed += 1; },
		}), { orientationChars: 20 });
		const setup = await runtime.sessionSetup({});
		assert.equal(executed, 0);
		assert.equal(setup.blocks.length, 1);
		assert.ok(setup.blocks[0].content.length <= 20);

		const failing = new GraphRuntime(port({
			resolveTargets: async () => { throw new Error("unavailable"); },
			recordFailure: async (_target, operation) => { failures.push(operation); },
		}));
		assert.deepEqual(await failing.afterTurn({}), { blocks: [] });
		assert.deepEqual(failures, ["delta"]);
	});
});
