/**
 * API E2E — the experiment-runner pack ROUTES against a live ServerHostApi.
 *
 * This is the regression guard the code-quality review found missing: nothing
 * exercised the LIVE define → launch → poll → collect → aggregate path, so the
 * panel/backend contract drift (runnable shape, metricId, objective direction,
 * caps keys, index shape, the {definition} envelope, and the parentGoalId →
 * sessionId fallback that made spawnGoal reject with PARENT_MISMATCH) slipped
 * through. This spec pins the canonical contract end-to-end.
 *
 * It drives the SHIPPED `market-packs/experiment-runner/lib/routes.mjs` handlers
 * against a REAL `createServerHostApi` (the same in-process pack store the gateway
 * serves + the same OrchestrationCore-backed `host.agents`), so the route logic,
 * the store I/O, and the `host.agents.spawnGoal` host seam are all genuine. Only
 * two things are stubbed DETERMINISTICALLY so no real compute/LLM is needed:
 *
 *   • the spawn BACKEND (`spawnChildGoal`) — a recorder that returns deterministic
 *     goal ids and captures each arm's distinct metadata (the GoalManager/worktree
 *     machinery is exercised by tests/experiment-spawn-goal.test.ts and
 *     tests/e2e/host-agents-spawn-goal.spec.ts), and
 *   • the outcome reader (`ctx.goalReader`) — a goal-id-keyed map returning canned
 *     RawOutcomes (gates/cost/userMetrics), so poll/collect/iterate advance without
 *     a live goal settling.
 *
 * The routes are invoked in-process (not through the confined worker) BECAUSE the
 * worker reconstructs a sanitized scalar-only ctx across the MessagePort — a
 * function-bearing `ctx.goalReader` cannot cross it. The host calls
 * (`host.store.*`, `host.agents.spawnGoal`) are the real ServerHostApi either way.
 */
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { test, expect } from "./in-process-harness.js";
import { createSession, deleteSession } from "./e2e-setup.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const ROUTES_MODULE = resolve(PROJECT_ROOT, "market-packs", "experiment-runner", "lib", "routes.mjs");
const PACK_ID = "experiment-runner";

type RawOutcome = Record<string, unknown>;
type SpawnRecord = { opts: any; goalId: string };

/** A deterministic spawn backend: records each arm's spawn opts (so we can assert
 *  the per-arm metadata) and is idempotent on runKey (a re-call returns the same
 *  goal id), exactly as the real seam contracts. */
function makeSpawnStub() {
	const spawned: SpawnRecord[] = [];
	const byGoalId = new Map<string, any>();
	let counter = 0;
	const spawnChildGoal = async (_ownerId: string, opts: any): Promise<{ goalId: string }> => {
		const existing = spawned.find((s) => s.opts.runKey === opts.runKey);
		if (existing) return { goalId: existing.goalId };
		const goalId = `stub-goal-${counter++}`;
		spawned.push({ opts, goalId });
		byGoalId.set(goalId, opts);
		return { goalId };
	};
	return { spawned, byGoalId, spawnChildGoal };
}

/** Build a deterministic goal-id-keyed outcome reader. `outcomeFor` maps the
 *  recorded spawn opts → a canned RawOutcome (so AR can key off the iteration). */
function makeGoalReader(byGoalId: Map<string, any>, outcomeFor: (opts: any) => RawOutcome) {
	return {
		readOutcome: async (goalId: string): Promise<RawOutcome> => {
			const opts = byGoalId.get(goalId);
			return outcomeFor(opts || {});
		},
	};
}

async function loadRoutes(): Promise<Record<string, (ctx: any, req: any) => Promise<any>>> {
	const mod = await import(pathToFileURL(ROUTES_MODULE).href);
	return mod.routes as Record<string, (ctx: any, req: any) => Promise<any>>;
}

const ENGINE_MODULE = resolve(PROJECT_ROOT, "market-packs", "experiment-runner", "lib", "engine.mjs");
async function loadCreateGoalReader(): Promise<(io: any) => any> {
	const mod = await import(pathToFileURL(ENGINE_MODULE).href);
	return mod.createGoalReader as (io: any) => any;
}

/**
 * A mock fetch returning the REAL gateway REST response shapes (src/server/server.ts)
 * for every spawned arm, so the SHIPPED engine.parseRawOutcome / createGoalReader is
 * exercised end-to-end (NOT a pre-normalized RawOutcome stub). This is the gap the
 * code-quality review found: the previous reader bypassed the parser entirely.
 */
function makeRestFetch(byGoalId: Map<string, any>) {
	const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
	return async (url: string) => {
		const path = String(url).replace(/^https?:\/\/[^/]+/, "");
		if (path === "/api/goals") {
			const goals = [...byGoalId.entries()].map(([goalId, opts]) => ({
				id: goalId,
				createdAt: 10_000,
				updatedAt: 25_000,
				// Mirror the arm's objective into the goal metadata, exactly as a settled
				// arm would surface it (metadata.experiment.userMetrics).
				metadata: { experiment: { userMetrics: { objective: opts?.metadata?.experiment?.iteration ?? 1 } } },
			}));
			return ok({ generation: 1, goals });
		}
		const m = path.match(/^\/api\/goals\/([^/]+)\/(cost|gates|tasks)$/);
		if (!m) return { ok: false, status: 404, json: async () => ({}) };
		const kind = m[2];
		if (kind === "cost") return ok({ inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.1, cacheHitRate: 0.5 });
		if (kind === "gates") return ok({ gates: [{ gateId: "build", status: "passed" }, { gateId: "review", status: "bypassed" }] });
		return ok({ tasks: [{ state: "complete" }] });
	};
}

async function buildHost(gateway: any, ownerId: string, spawnChildGoal: any): Promise<any> {
	const { createServerHostApi } = await import("../../dist/server/extension-host/server-host-api.js");
	const { getPackStore } = await import("../../dist/server/extension-host/pack-store.js");
	return createServerHostApi({
		sessionId: ownerId,
		packId: PACK_ID,
		contributionId: "experiment-runner/routes",
		packStore: getPackStore(),
		orchestrationCore: gateway.orchestrationCore,
		readChildStatus: (id: string) => gateway.sessionManager.getSession(id)?.status,
		spawnChildGoal,
	});
}

async function packStore(): Promise<any> {
	const { getPackStore } = await import("../../dist/server/extension-host/pack-store.js");
	return getPackStore();
}

const uid = () => Math.random().toString(36).slice(2, 8);

test.describe("experiment-runner routes — A/B fan-out via the spawnGoal seam", () => {
	test("define → launch (2×2) → poll → collect → aggregate, with distinct per-arm metadata", async ({ gateway }) => {
		const owner = await createSession();
		const { spawned, byGoalId, spawnChildGoal } = makeSpawnStub();
		try {
			const routes = await loadRoutes();
			const host = await buildHost(gateway, owner, spawnChildGoal);
			// NO ctx.goalId — pins fix #1: defineExperiment must NOT fall back to the
			// session id for parentGoalId (a session id is never a goal id).
			const reader = makeGoalReader(byGoalId, () => ({
				costUsd: 0.1,
				gateVerdicts: { build: "passed" },
				taskCounts: { complete: 1, total: 1 },
			}));
			const ctx = { host, sessionId: owner, goalReader: reader, toolUseId: "tu-ab", tool: "experiment-runner/routes" };

			const experimentId = `e2e-ab-${uid()}`;
			const def = {
				experimentId,
				title: "ab e2e",
				mode: "ab",
				runnable: { kind: "command", command: "echo metric" },
				variants: [
					{ armId: "baseline", label: "baseline", metadata: { temperature: 0.2 } },
					{ armId: "hi", label: "hi", metadata: { temperature: 0.9 } },
				],
				repeats: 2,
				perRunBudget: 1,
			};

			// defineExperiment reads req.body DIRECTLY (the def IS the body).
			const defined = await routes.defineExperiment(ctx, { body: def });
			expect(defined.error).toBeUndefined();
			expect(defined.experimentId).toBe(experimentId);
			expect(defined.projection.arms).toBe(4); // 2 variants × 2 repeats

			// Fix #1: the stored def carries NO parentGoalId (none asserted, no ctx.goalId).
			const store = await packStore();
			const storedDef = await store.get(PACK_ID, `exp/${experimentId}`);
			expect(storedDef.parentGoalId).toBeUndefined();

			// Fix #4: the index is an ARRAY of id strings (never { experiments: [...] }).
			const index = await store.get(PACK_ID, "index/experiments");
			expect(Array.isArray(index)).toBe(true);
			expect(index).toContain(experimentId);

			// launch fans out variant × repeat through the spawnGoal seam.
			const launched = await routes.launch(ctx, { body: { experimentId } });
			expect(launched.error).toBeUndefined();
			expect(launched.launched).toHaveLength(4);
			expect(spawned).toHaveLength(4);

			// Each arm's DISTINCT treatment reached its child goal's metadata, and the
			// engine namespaced the experiment identity alongside it.
			for (const s of spawned) {
				const exp = s.opts.metadata.experiment;
				expect(exp.experimentId).toBe(experimentId);
				const expectedTemp = exp.armId === "baseline" ? 0.2 : 0.9;
				expect(s.opts.metadata.temperature).toBe(expectedTemp);
				// Fix #1 (engine): no parentGoalId is forwarded when none is set.
				expect(s.opts.parentGoalId).toBeUndefined();
			}
			const baselineTemps = spawned.filter((s) => s.opts.metadata.experiment.armId === "baseline").map((s) => s.opts.metadata.temperature);
			const hiTemps = spawned.filter((s) => s.opts.metadata.experiment.armId === "hi").map((s) => s.opts.metadata.temperature);
			expect(baselineTemps).toEqual([0.2, 0.2]);
			expect(hiTemps).toEqual([0.9, 0.9]);

			// poll advances every run to settled; collect extracts metrics.
			const polled = await routes.poll(ctx, { body: { experimentId } });
			expect(polled.allSettled).toBe(true);
			const collected = await routes.collect(ctx, { body: { experimentId } });
			expect(collected.runs).toHaveLength(4);
			expect(collected.runs.every((r: any) => r.status === "collected")).toBe(true);
			expect(collected.runs.every((r: any) => r.completionBar === "passed")).toBe(true);

			// Fix #5: a fully-collected A/B experiment flips to a terminal "done"
			// state so the panel stops polling it as "running".
			const doneState = await store.get(PACK_ID, `exp/${experimentId}/state`);
			expect(doneState.status).toBe("done");

			// aggregate computes a comparison across both arms from the registry.
			const agg = await routes.aggregate(ctx, { body: { experimentId } });
			expect(agg.mode).toBe("ab");
			const armIds = new Set(agg.aggregates.map((a: any) => a.armId));
			expect(armIds.has("baseline")).toBe(true);
			expect(armIds.has("hi")).toBe(true);
			expect(agg.comparisons.length).toBeGreaterThan(0);
		} finally {
			await deleteSession(owner);
		}
	});
});

test.describe("experiment-runner routes — A/B fan-out through the LIVE REST parser", () => {
	test("define → launch → poll → collect → aggregate via createGoalReader + real REST shapes", async ({ gateway }) => {
		const owner = await createSession();
		const { spawned, byGoalId, spawnChildGoal } = makeSpawnStub();
		try {
			const routes = await loadRoutes();
			const createGoalReader = await loadCreateGoalReader();
			const host = await buildHost(gateway, owner, spawnChildGoal);
			// The REAL reader: an injected fetch returning the gateway's actual cost/gates/
			// tasks/goals-list shapes, so the shipped parser (NOT a normalized stub) runs.
			const reader = createGoalReader({ fetchImpl: makeRestFetch(byGoalId), creds: { gatewayUrl: "https://gw", token: "tok" } });
			const ctx = { host, sessionId: owner, goalReader: reader, toolUseId: "tu-ab-live", tool: "experiment-runner/routes" };

			const experimentId = `e2e-ab-live-${uid()}`;
			const def = {
				experimentId,
				title: "ab live e2e",
				mode: "ab",
				runnable: { kind: "command", command: "echo metric" },
				variants: [
					{ armId: "baseline", label: "baseline", metadata: { temperature: 0.2 } },
					{ armId: "hi", label: "hi", metadata: { temperature: 0.9 } },
				],
				repeats: 2,
				perRunBudget: 1,
			};

			const defined = await routes.defineExperiment(ctx, { body: def });
			expect(defined.error).toBeUndefined();
			const launched = await routes.launch(ctx, { body: { experimentId } });
			expect(launched.error).toBeUndefined();
			expect(spawned).toHaveLength(4);

			// poll/collect must advance THROUGH the live parser: all-passed (+bypassed)
			// gates settle the runs; the real cost shape feeds costUsd.
			const polled = await routes.poll(ctx, { body: { experimentId } });
			expect(polled.allSettled).toBe(true);
			const collected = await routes.collect(ctx, { body: { experimentId } });
			expect(collected.runs).toHaveLength(4);
			expect(collected.runs.every((r: any) => r.status === "collected")).toBe(true);
			expect(collected.runs.every((r: any) => r.completionBar === "passed")).toBe(true);
			// The bypassed gate normalized to passed → verified; cost parsed from totalCost.
			expect(collected.runs.every((r: any) => r.verified === true)).toBe(true);
			expect(collected.runs.every((r: any) => r.cost && r.cost.costUsd === 0.1)).toBe(true);
			expect(collected.runs.every((r: any) => r.rawOutcome && r.rawOutcome.tokensIn === 800)).toBe(true);

			const agg = await routes.aggregate(ctx, { body: { experimentId } });
			expect(agg.mode).toBe("ab");
			const armIds = new Set(agg.aggregates.map((a: any) => a.armId));
			expect(armIds.has("baseline")).toBe(true);
			expect(armIds.has("hi")).toBe(true);
		} finally {
			await deleteSession(owner);
		}
	});
});

test.describe("experiment-runner routes — autoresearch loop on a stub objective", () => {
	test("iterate keeps the best, stops on plateau, and grows the ledger", async ({ gateway }) => {
		const owner = await createSession();
		const { byGoalId, spawnChildGoal } = makeSpawnStub();
		try {
			const routes = await loadRoutes();
			const host = await buildHost(gateway, owner, spawnChildGoal);
			// Deterministic objective series by iteration: improves (1 → 2) then
			// plateaus (2, 2). With plateauK=2 the loop must stop once the last two
			// candidates fail to improve on the best.
			const OBJ = [1, 2, 2, 2];
			const reader = makeGoalReader(byGoalId, (opts) => {
				const iter = opts?.metadata?.experiment?.iteration ?? 0;
				return {
					costUsd: 0.1,
					gateVerdicts: { review: "passed" },
					userMetrics: { objective: OBJ[Math.min(iter, OBJ.length - 1)] },
				};
			});
			const ctx = { host, sessionId: owner, goalReader: reader, toolUseId: "tu-ar", tool: "experiment-runner/routes" };

			const experimentId = `e2e-ar-${uid()}`;
			const def = {
				experimentId,
				title: "ar e2e",
				mode: "autoresearch",
				runnable: { kind: "agent", spec: "optimize the thing" },
				objective: { metricId: "objective.value", direction: "max" },
				caps: { maxIterations: 6 },
				stop: { plateauK: 2 },
				perRunBudget: 1,
			};

			const defined = await routes.defineExperiment(ctx, { body: def });
			expect(defined.error).toBeUndefined();
			expect(defined.experimentId).toBe(experimentId);

			// Fix #1a regression guard: poll/collect must NOT flip an autoresearch
			// experiment to a terminal "done" state. Before the fix, the first collected
			// candidate made every run terminal → state "done" → the panel stopped driving
			// the loop after iteration 0. Terminality is owned ONLY by iterate's stop.
			await routes.iterate(ctx, { body: { experimentId } }); // spawn iter-0
			await routes.poll(ctx, { body: { experimentId } });
			await routes.collect(ctx, { body: { experimentId } });
			const midState = await (await packStore()).get(PACK_ID, `exp/${experimentId}/state`);
			expect(midState.status).not.toBe("done");
			expect(midState.stopped).toBeFalsy();

			// Drive the deterministic loop one step at a time until it stops.
			let res: any = {};
			let guard = 0;
			do {
				res = await routes.iterate(ctx, { body: { experimentId } });
				expect(res.error).toBeUndefined();
			} while (!res.stopped && guard++ < 20);

			expect(res.stopped).toBeTruthy();
			expect(String(res.stopped.reason)).toMatch(/plateau/i);

			// The ledger grew across iterations and recorded the keep-best decisions.
			const store = await packStore();
			const ledger = await store.get(PACK_ID, `exp/${experimentId}/ledger`);
			expect(Array.isArray(ledger)).toBe(true);
			expect(ledger.length).toBe(4);
			const accepted = ledger.filter((e: any) => e.decision === "accepted");
			expect(accepted.length).toBe(2); // iter-0 (1) and iter-1 (2)
			// Best-so-far rose to 2 and the later non-improving candidates were rejected.
			expect(ledger[ledger.length - 1].bestObjectiveAfter).toBe(2);
			expect(ledger.filter((e: any) => e.decision === "rejected").length).toBe(2);

			// The experiment state is terminal with the plateau stop reason.
			const state = await store.get(PACK_ID, `exp/${experimentId}/state`);
			expect(state.stopped.reason).toMatch(/plateau/i);
		} finally {
			await deleteSession(owner);
		}
	});
});

test.describe("experiment-runner routes — autoresearch iteration-0 carries the search seed", () => {
	test("the first candidate's spawn args carry def.seed metadata + inlineRoles", async ({ gateway }) => {
		// Pins fix #2: defineExperiment persists def.seed and seedCandidate returns it
		// for iteration 0, so the user's search-seed treatment actually reaches the
		// first candidate (it was persisted-then-ignored before).
		const owner = await createSession();
		const { spawned, byGoalId, spawnChildGoal } = makeSpawnStub();
		try {
			const routes = await loadRoutes();
			const host = await buildHost(gateway, owner, spawnChildGoal);
			const reader = makeGoalReader(byGoalId, () => ({
				costUsd: 0.1,
				gateVerdicts: { review: "passed" },
				userMetrics: { objective: 1 },
			}));
			const ctx = { host, sessionId: owner, goalReader: reader, toolUseId: "tu-ar-seed", tool: "experiment-runner/routes" };

			const experimentId = `e2e-ar-seed-${uid()}`;
			const def = {
				experimentId,
				title: "ar seed e2e",
				mode: "autoresearch",
				runnable: { kind: "agent", spec: "optimize the thing" },
				objective: { metricId: "objective.value", direction: "max" },
				caps: { maxIterations: 6 },
				stop: { plateauK: 3 },
				perRunBudget: 1,
				seed: { metadata: { tempSeed: 0.5, retries: 3 }, inlineRoles: { coder: { model: "seed-model" } } },
			};
			const defined = await routes.defineExperiment(ctx, { body: def });
			expect(defined.error).toBeUndefined();

			// The seed survives persistence (was dropped before).
			const store = await packStore();
			const storedDef = await store.get(PACK_ID, `exp/${experimentId}`);
			expect(storedDef.seed).toEqual(def.seed);

			// The first candidate carries the seed treatment in its spawn args.
			const first = await routes.iterate(ctx, { body: { experimentId } });
			expect(first.action).toBe("spawned");
			expect(first.candidateRun.iteration).toBe(0);
			expect(spawned).toHaveLength(1);
			expect(spawned[0].opts.metadata.tempSeed).toBe(0.5);
			expect(spawned[0].opts.metadata.retries).toBe(3);
			expect(spawned[0].opts.inlineRoles).toEqual({ coder: { model: "seed-model" } });
		} finally {
			await deleteSession(owner);
		}
	});
});

test.describe("experiment-runner routes — A/B sameCompletionBar gates aggregation", () => {
	test("mixed-bar runs aggregate differently when sameCompletionBar is false vs true", async ({ gateway }) => {
		// Pins fix #3: defineExperiment persists sameCompletionBar and aggregate honours
		// it (false = aggregate across ALL bars; true/default = only the 'passed' bar).
		const owner = await createSession();
		const { byGoalId, spawnChildGoal } = makeSpawnStub();
		try {
			const routes = await loadRoutes();
			const host = await buildHost(gateway, owner, spawnChildGoal);
			// Repeat 0 of each arm passes; repeat 1 fails — so every arm has one passed +
			// one failed collected run, giving same-bar filtering something to drop.
			const reader = makeGoalReader(byGoalId, (opts) => {
				const repeat = opts?.metadata?.experiment?.repeat ?? 0;
				return {
					costUsd: 0.1,
					gateVerdicts: { build: repeat === 0 ? "passed" : "failed" },
					taskCounts: { complete: 1, total: 1 },
				};
			});
			const ctx = { host, sessionId: owner, goalReader: reader, toolUseId: "tu-ab-bar", tool: "experiment-runner/routes" };

			const baseDef = (extra) => ({
				title: "ab bar e2e",
				mode: "ab",
				runnable: { kind: "command", command: "echo metric" },
				variants: [
					{ armId: "baseline", label: "baseline", metadata: { temperature: 0.2 } },
					{ armId: "hi", label: "hi", metadata: { temperature: 0.9 } },
				],
				repeats: 2,
				metrics: [{ metricId: "cost.totalUsd" }],
				perRunBudget: 1,
				...extra,
			});

			const runExperiment = async (experimentId, extra) => {
				await routes.defineExperiment(ctx, { body: { experimentId, ...baseDef(extra) } });
				await routes.launch(ctx, { body: { experimentId } });
				await routes.poll(ctx, { body: { experimentId } });
				await routes.collect(ctx, { body: { experimentId } });
				return routes.aggregate(ctx, { body: { experimentId } });
			};

			// Default (sameCompletionBar omitted → true): only the passed run per arm counts.
			const sameId = `e2e-ab-samebar-${uid()}`;
			const sameAgg = await runExperiment(sameId);
			const sameCost = sameAgg.aggregates.filter((a) => a.metricId === "cost.totalUsd");
			expect(sameCost.length).toBe(2);
			expect(sameCost.every((a) => a.n === 1)).toBe(true);
			expect(sameCost.every((a) => a.droppedN === 1)).toBe(true);

			// sameCompletionBar:false → aggregate across BOTH bars (nothing dropped).
			const allId = `e2e-ab-allbar-${uid()}`;
			const allAgg = await runExperiment(allId, { sameCompletionBar: false });
			const allCost = allAgg.aggregates.filter((a) => a.metricId === "cost.totalUsd");
			expect(allCost.length).toBe(2);
			expect(allCost.every((a) => a.n === 2)).toBe(true);
			expect(allCost.every((a) => a.droppedN === 0)).toBe(true);

			// The persisted def records the choice.
			const store = await packStore();
			expect((await store.get(PACK_ID, `exp/${sameId}`)).sameCompletionBar).toBe(true);
			expect((await store.get(PACK_ID, `exp/${allId}`)).sameCompletionBar).toBe(false);
		} finally {
			await deleteSession(owner);
		}
	});
});

test.describe("experiment-runner routes — autoresearch launches via iterate (not launch)", () => {
	test("the FIRST iterate spawns the first candidate; launch refuses autoresearch", async ({ gateway }) => {
		// Pins panel doLaunch fix #1: autoresearch must launch through `iterate`,
		// because the A/B-only `launch` route returns LAUNCH_AB_ONLY for it. This
		// test asserts the route-level contract the panel branches on.
		const owner = await createSession();
		const { spawned, byGoalId, spawnChildGoal } = makeSpawnStub();
		try {
			const routes = await loadRoutes();
			const host = await buildHost(gateway, owner, spawnChildGoal);
			const reader = makeGoalReader(byGoalId, () => ({
				costUsd: 0.1,
				gateVerdicts: { review: "passed" },
				userMetrics: { objective: 1 },
			}));
			const ctx = { host, sessionId: owner, goalReader: reader, toolUseId: "tu-ar-launch", tool: "experiment-runner/routes" };

			const experimentId = `e2e-ar-launch-${uid()}`;
			const def = {
				experimentId,
				title: "ar launch e2e",
				mode: "autoresearch",
				runnable: { kind: "agent", spec: "optimize the thing" },
				objective: { metricId: "objective.value", direction: "max" },
				caps: { maxIterations: 6 },
				stop: { plateauK: 3 },
				perRunBudget: 1,
			};
			const defined = await routes.defineExperiment(ctx, { body: def });
			expect(defined.error).toBeUndefined();

			// launch refuses an autoresearch experiment — exactly why the panel must
			// branch to `iterate` for this mode.
			const launchAttempt = await routes.launch(ctx, { body: { experimentId } });
			expect(launchAttempt.error).toBe("LAUNCH_AB_ONLY");
			expect(spawned).toHaveLength(0);

			// The first iterate spawns the first candidate (iteration 0).
			const first = await routes.iterate(ctx, { body: { experimentId } });
			expect(first.error).toBeUndefined();
			expect(first.action).toBe("spawned");
			expect(spawned).toHaveLength(1);
			expect(first.candidateRun.iteration).toBe(0);
			expect(first.candidateRun.status).toBe("spawned");
			expect(first.candidateRun.childGoalId).toBeTruthy();
			// The candidate carries its experiment identity + iteration in metadata.
			expect(spawned[0].opts.metadata.experiment.experimentId).toBe(experimentId);
		} finally {
			await deleteSession(owner);
		}
	});
});

test.describe("experiment-runner routes — live A/B poll → collect → aggregate yields non-empty metrics", () => {
	test("collect writes per-run metrics; aggregate exposes them (the panel skipped collect)", async ({ gateway }) => {
		// Pins panel loadDashboard fix #2: `poll` only settles + stores cost; metric
		// extraction happens ONLY in `collect`. Without collect, aggregates are empty.
		const owner = await createSession();
		const { spawned, byGoalId, spawnChildGoal } = makeSpawnStub();
		try {
			const routes = await loadRoutes();
			const host = await buildHost(gateway, owner, spawnChildGoal);
			const reader = makeGoalReader(byGoalId, () => ({
				costUsd: 0.1,
				gateVerdicts: { build: "passed" },
				taskCounts: { complete: 1, total: 1 },
				userMetrics: { objective: 5 },
			}));
			const ctx = { host, sessionId: owner, goalReader: reader, toolUseId: "tu-ab-collect", tool: "experiment-runner/routes" };

			const experimentId = `e2e-ab-collect-${uid()}`;
			const def = {
				experimentId,
				title: "ab collect e2e",
				mode: "ab",
				runnable: { kind: "command", command: "echo metric" },
				variants: [
					{ armId: "baseline", label: "baseline", metadata: { temperature: 0.2 } },
					{ armId: "hi", label: "hi", metadata: { temperature: 0.9 } },
				],
				repeats: 2,
				metrics: [{ metricId: "cost.totalUsd" }, { metricId: "objective.value" }],
				perRunBudget: 1,
			};
			await routes.defineExperiment(ctx, { body: def });
			await routes.launch(ctx, { body: { experimentId } });
			expect(spawned).toHaveLength(4);

			// poll settles the runs but does NOT extract metrics.
			const polled = await routes.poll(ctx, { body: { experimentId } });
			expect(polled.allSettled).toBe(true);
			expect(polled.runs.every((r: any) => !r.metrics || Object.keys(r.metrics).length === 0)).toBe(true);

			// collect extracts metrics onto every settled run.
			const collected = await routes.collect(ctx, { body: { experimentId } });
			expect(collected.runs).toHaveLength(4);
			expect(collected.runs.every((r: any) => r.metrics && Object.keys(r.metrics).length > 0)).toBe(true);
			expect(collected.runs.every((r: any) => typeof r.metrics["cost.totalUsd"] === "number")).toBe(true);
			expect(collected.runs.every((r: any) => r.metrics["objective.value"] === 5)).toBe(true);

			// aggregate now exposes non-empty per-(arm × metric) aggregated values.
			const agg = await routes.aggregate(ctx, { body: { experimentId } });
			expect(agg.mode).toBe("ab");
			expect(agg.aggregates.length).toBeGreaterThan(0);
			// Every aggregate has runs behind it (n > 0) and a finite value — i.e. the
			// metrics actually flowed from collect into aggregation (not empty).
			const haveValues = agg.aggregates.some((a: any) => a.n > 0 && typeof a.value === "number" && Number.isFinite(a.value));
			expect(haveValues).toBe(true);
			const objAgg = agg.aggregates.find((a: any) => a.metricId === "objective.value");
			expect(objAgg).toBeTruthy();
			expect(objAgg.value).toBe(5);
		} finally {
			await deleteSession(owner);
		}
	});
});

test.describe("experiment-runner routes — validateDef guardrails (defineExperiment)", () => {
	test("rejects ineffective AR stops, single-arm A/B, and fractional repeats", async ({ gateway }) => {
		const owner = await createSession();
		const { byGoalId, spawnChildGoal } = makeSpawnStub();
		try {
			const routes = await loadRoutes();
			const host = await buildHost(gateway, owner, spawnChildGoal);
			const reader = makeGoalReader(byGoalId, () => ({}));
			const ctx = { host, sessionId: owner, goalReader: reader, toolUseId: "tu-guard", tool: "experiment-runner/routes" };

			const arBase = {
				title: "ar guard",
				mode: "autoresearch",
				runnable: { kind: "agent", spec: "x" },
				objective: { metricId: "objective.value", direction: "max" },
				caps: { maxIterations: 5 },
				perRunBudget: 1,
			};

			// Fix #3: plateauK ≤ 0 is not an effective stop → AR_NO_STOP.
			const zeroK = await routes.defineExperiment(ctx, { body: { ...arBase, experimentId: `g-${uid()}`, stop: { plateauK: 0 } } });
			expect(zeroK.error).toBe("AR_NO_STOP");
			const negK = await routes.defineExperiment(ctx, { body: { ...arBase, experimentId: `g-${uid()}`, stop: { plateauK: -2 } } });
			expect(negK.error).toBe("AR_NO_STOP");
			// Fix #3: a non-integer plateauK is rejected (must be a whole window).
			const fracK = await routes.defineExperiment(ctx, { body: { ...arBase, experimentId: `g-${uid()}`, stop: { plateauK: 1.5 } } });
			expect(fracK.error).toBe("AR_NO_STOP");
			// Fix #3: NaN / non-finite target is not an effective stop → AR_NO_STOP.
			const nanTarget = await routes.defineExperiment(ctx, { body: { ...arBase, experimentId: `g-${uid()}`, stop: { target: NaN } } });
			expect(nanTarget.error).toBe("AR_NO_STOP");
			// A finite target IS a valid stop (control — accepted).
			const okTarget = await routes.defineExperiment(ctx, { body: { ...arBase, experimentId: `ok-${uid()}`, stop: { target: 0.9 } } });
			expect(okTarget.error).toBeUndefined();
			// An integer plateauK ≥ 1 IS a valid stop (control — accepted).
			const okK = await routes.defineExperiment(ctx, { body: { ...arBase, experimentId: `ok-${uid()}`, stop: { plateauK: 2 } } });
			expect(okK.error).toBeUndefined();

			const abBase = {
				title: "ab guard",
				mode: "ab",
				runnable: { kind: "command", command: "echo" },
			};
			// Fix #4: a single arm is not a comparison → VARIANTS_REQUIRED.
			const oneArm = await routes.defineExperiment(ctx, { body: { ...abBase, experimentId: `g-${uid()}`, variants: [{ armId: "a", label: "a", metadata: {} }], repeats: 1 } });
			expect(oneArm.error).toBe("VARIANTS_REQUIRED");
			// Fix #4: fractional repeats are rejected → REPEATS_REQUIRED.
			const fracRepeats = await routes.defineExperiment(ctx, {
				body: { ...abBase, experimentId: `g-${uid()}`, variants: [{ armId: "a", label: "a", metadata: {} }, { armId: "b", label: "b", metadata: {} }], repeats: 1.5 },
			});
			expect(fracRepeats.error).toBe("REPEATS_REQUIRED");
			// Two arms + integer repeats IS valid (control — accepted).
			const okAb = await routes.defineExperiment(ctx, {
				body: { ...abBase, experimentId: `ok-${uid()}`, variants: [{ armId: "a", label: "a", metadata: {} }, { armId: "b", label: "b", metadata: {} }], repeats: 2 },
			});
			expect(okAb.error).toBeUndefined();
		} finally {
			await deleteSession(owner);
		}
	});
});

test.describe("experiment-runner routes — maxCostUsd is enforced PRE-SPAWN", () => {
	test("the loop stops on budget when cumulative + perRunBudget would exceed the cap, with no extra spawn", async ({ gateway }) => {
		// Pins fix #4: shouldStop passes def.perRunBudget as the projected next-run
		// cost so the hard cap refuses to launch another (over-budget) candidate.
		const owner = await createSession();
		const { spawned, byGoalId, spawnChildGoal } = makeSpawnStub();
		try {
			const routes = await loadRoutes();
			const host = await buildHost(gateway, owner, spawnChildGoal);
			// Each run costs 0.1; perRunBudget=1; cap=1.05. After ONE settled run
			// (cumulative 0.1) the next-spawn projection 0.1+1=1.1 > 1.05 → stop.
			const reader = makeGoalReader(byGoalId, (opts) => {
				const iter = opts?.metadata?.experiment?.iteration ?? 0;
				return {
					costUsd: 0.1,
					gateVerdicts: { review: "passed" },
					userMetrics: { objective: iter + 1 }, // always improving → no plateau stop
				};
			});
			const ctx = { host, sessionId: owner, goalReader: reader, toolUseId: "tu-ar-budget", tool: "experiment-runner/routes" };

			const experimentId = `e2e-ar-budget-${uid()}`;
			const def = {
				experimentId,
				title: "ar budget e2e",
				mode: "autoresearch",
				runnable: { kind: "agent", spec: "optimize" },
				objective: { metricId: "objective.value", direction: "max" },
				caps: { maxIterations: 50, maxCostUsd: 1.05 },
				stop: { plateauK: 50 }, // effectively disabled — budget must be the stop
				perRunBudget: 1,
			};
			await routes.defineExperiment(ctx, { body: def });

			let res: any = {};
			let guard = 0;
			do {
				res = await routes.iterate(ctx, { body: { experimentId } });
				expect(res.error).toBeUndefined();
			} while (!res.stopped && guard++ < 20);

			expect(res.stopped).toBeTruthy();
			expect(String(res.stopped.reason)).toMatch(/budget/i);
			// Only ONE candidate was ever spawned: the pre-spawn cap blocked the second.
			expect(spawned).toHaveLength(1);

			const store = await packStore();
			const state = await store.get(PACK_ID, `exp/${experimentId}/state`);
			expect(state.stopped.reason).toMatch(/budget/i);
		} finally {
			await deleteSession(owner);
		}
	});
});
