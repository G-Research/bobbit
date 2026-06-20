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
