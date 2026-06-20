// Experiment-runner pack SERVER routes — the orchestration brain.
//
// ESM `export const routes`, executed in the confined worker, reaching only its
// own pack store (ctx.host.store) + ctx.host.agents (incl. the spawnGoal host
// capability). Worker statelessness: a fresh worker per call, so ALL cross-call
// state lives in the store (last-write-wins + reconcile; never an in-memory map).
//
// Mutating routes are POST; read routes are GET. The route names are the canonical
// catalogue pinned by pack.yaml:
//   defineExperiment, projectCost, launch, poll, collect, aggregate, iterate,
//   listExperiments, getExperiment, saveMetrics, saveDashboard, report,
//   listMetrics, listWidgets, cancel.

import * as keys from "./store-keys.mjs";
import {
	planAbRuns,
	buildAbSpawnArgs,
	buildCandidateSpawnArgs,
	newRunRecord,
	completionBarFromRaw,
	isSettledFromRaw,
	costSummaryFromRaw,
	applyBudget,
	projectCost as projectCostPure,
	createGoalReader,
} from "./engine.mjs";
import { aggregateExperiment, buildReportModel, renderReportHtml } from "./experiment-report.mjs";
import { extractMetrics, resolveSelection, listMetrics as listMetricExtractors } from "./metrics.mjs";
import { listWidgets as listWidgetDescriptors } from "./widgets.mjs";
import { buildLedger, shouldStop } from "./autoresearch.mjs";

const DEFAULT_AB_METRICS = ["cost.totalUsd", "gates.passRate", "tasks.completionRate"];

function bodyOf(req) {
	return (req && req.body) || {};
}
function queryOf(req) {
	return (req && req.query) || {};
}
function strOf(v) {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function nowMs() {
	return Date.now();
}

function goalReaderFor(ctx) {
	return ctx && ctx.goalReader ? ctx.goalReader : createGoalReader();
}

async function loadDef(ctx, experimentId) {
	return ctx.host.store.get(keys.experimentKey(experimentId));
}

async function loadRuns(ctx, experimentId) {
	const runKeys = await ctx.host.store.list(keys.runPrefix(experimentId));
	const runs = await Promise.all(runKeys.map((k) => ctx.host.store.get(k)));
	return runs.filter((r) => r && typeof r === "object");
}

async function loadSelection(ctx, experimentId) {
	const sel = await ctx.host.store.get(keys.metricsKey(experimentId));
	return Array.isArray(sel) ? sel : [];
}

async function resolvedMetricsFor(ctx, experimentId, def) {
	let selection = await loadSelection(ctx, experimentId);
	if (selection.length === 0) {
		// Seed a sensible default selection per mode (collected, never re-run).
		selection = def && def.mode === "autoresearch" && def.objective ? [{ metricId: def.objective.metricId }] : DEFAULT_AB_METRICS.map((metricId) => ({ metricId }));
	}
	return { selection, resolved: resolveSelection(selection) };
}

async function addToIndex(ctx, experimentId) {
	const idx = await ctx.host.store.get(keys.INDEX_KEY);
	const list = Array.isArray(idx) ? idx.slice() : [];
	if (!list.includes(experimentId)) list.push(experimentId);
	await ctx.host.store.put(keys.INDEX_KEY, list);
}

/** Validate an incoming experiment definition. Returns { ok, error?, def? }. */
function validateDef(input) {
	if (!input || typeof input !== "object") return { ok: false, error: "INVALID_DEF" };
	const mode = input.mode === "autoresearch" ? "autoresearch" : "ab";
	if (!input.runnable || typeof input.runnable !== "object") return { ok: false, error: "RUNNABLE_REQUIRED" };
	if (mode === "ab") {
		const variants = Array.isArray(input.variants) ? input.variants : [];
		if (variants.length < 1) return { ok: false, error: "VARIANTS_REQUIRED" };
		const repeats = Number(input.repeats);
		if (!Number.isFinite(repeats) || repeats < 1) return { ok: false, error: "REPEATS_REQUIRED" };
	} else {
		// Autoresearch guardrails: objective + at least one finite cap + at least one stop.
		const obj = input.objective;
		if (!obj || !strOf(obj.metricId) || (obj.direction !== "max" && obj.direction !== "min")) {
			return { ok: false, error: "OBJECTIVE_REQUIRED" };
		}
		const caps = input.caps || {};
		const hasCap = [caps.maxIterations, caps.maxWallClockMs, caps.maxCostUsd].some((v) => Number.isFinite(v) && v > 0);
		if (!hasCap) return { ok: false, error: "AR_UNCAPPED" };
		const stop = input.stop || {};
		const hasStop = Number.isFinite(stop.plateauK) || typeof stop.target === "number";
		if (!hasStop) return { ok: false, error: "AR_NO_STOP" };
		// The fixed-per-iteration-budget guardrail: autoresearch refuses to run without
		// a positive comparable per-run budget (A/B keeps perRunBudget optional).
		if (!(Number.isFinite(input.perRunBudget) && input.perRunBudget > 0)) {
			return { ok: false, error: "PER_RUN_BUDGET_REQUIRED" };
		}
	}
	return { ok: true, mode };
}

function makeExperimentId(input) {
	return strOf(input.experimentId) || `exp-${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const routes = {
	// ── defineExperiment ──────────────────────────────────────────────────────
	// Validate (mode default ab; AR refuses uncapped), persist exp/<id> + index,
	// return a bounded cost projection. No spawns.
	defineExperiment: async (ctx, req) => {
		const input = bodyOf(req);
		const validation = validateDef(input);
		if (!validation.ok) return { error: validation.error };
		const experimentId = makeExperimentId(input);
		// parentGoalId is only a caller ASSERTION the spawnGoal seam verifies against the
		// server-derived parent (a mismatch → PARENT_MISMATCH). A session id is never a
		// goal id, so NEVER fall back to ctx.sessionId: take an explicit real goal id
		// (input.parentGoalId or ctx.goalId) or leave it undefined so the seam derives it.
		const parentGoalId = strOf(input.parentGoalId) || strOf(ctx && ctx.goalId);
		const def = {
			experimentId,
			title: strOf(input.title) || experimentId,
			mode: validation.mode,
			parentGoalId,
			workflowId: strOf(input.workflowId),
			runnable: input.runnable,
			variants: Array.isArray(input.variants) ? input.variants : undefined,
			repeats: validation.mode === "ab" ? Math.max(1, Number(input.repeats) || 1) : undefined,
			objective: input.objective,
			caps: input.caps,
			stop: input.stop,
			maxConcurrency: Number.isFinite(input.maxConcurrency) ? input.maxConcurrency : undefined,
			perRunBudget: Number.isFinite(input.perRunBudget) ? input.perRunBudget : undefined,
			createdAt: nowMs(),
		};
		await ctx.host.store.put(keys.experimentKey(experimentId), def);
		await ctx.host.store.put(keys.stateKey(experimentId), { status: "defined", createdAt: def.createdAt });
		// Seed editable metric selection + dashboard (stored separately so edits don't rewrite the def).
		if (Array.isArray(input.metrics) && input.metrics.length) await ctx.host.store.put(keys.metricsKey(experimentId), input.metrics);
		if (input.dashboard && Array.isArray(input.dashboard.widgets)) await ctx.host.store.put(keys.dashboardKey(experimentId), input.dashboard);
		await addToIndex(ctx, experimentId);
		return { experimentId, projection: projectCostPure(def) };
	},

	// ── projectCost ───────────────────────────────────────────────────────────
	// Pure projection (no persist) — drives the pre-launch confirmation.
	projectCost: async (ctx, req) => {
		const body = bodyOf(req);
		const experimentId = strOf(body.experimentId);
		const def = experimentId ? await loadDef(ctx, experimentId) : body;
		if (!def) return { error: "NOT_FOUND" };
		return projectCostPure(def);
	},

	// ── launch (A/B only) ───────────────────────────────────────────────────────
	// Fan out variant × repeat child goals via spawnGoal. Idempotent on runKey, so
	// re-invoking for a parked arm never double-spawns. Writes exp/<id>/run/*.
	launch: async (ctx, req) => {
		const experimentId = strOf(bodyOf(req).experimentId);
		if (!experimentId) return { error: "EXPERIMENT_ID_REQUIRED" };
		const def = await loadDef(ctx, experimentId);
		if (!def) return { error: "NOT_FOUND" };
		if (def.mode !== "ab") return { error: "LAUNCH_AB_ONLY" };
		if (typeof ctx.host.agents.spawnGoal !== "function") return { error: "SPAWN_GOAL_UNAVAILABLE" };

		const existing = await loadRuns(ctx, experimentId);
		const byRunId = new Map(existing.map((r) => [r.runId, r]));
		const plan = planAbRuns(def);
		const launched = [];
		for (const item of plan) {
			let run = byRunId.get(item.runId);
			if (run && run.status !== "pending" && run.status !== "failed") {
				launched.push(run);
				continue; // already spawned/settled/collected — idempotent
			}
			const variant = def.variants.find((v) => v.armId === item.armId);
			run = run || newRunRecord(def, item);
			try {
				const { goalId } = await ctx.host.agents.spawnGoal(buildAbSpawnArgs(def, variant, item.repeat));
				run.childGoalId = goalId;
				run.status = "spawned";
				run.spawnedAt = nowMs();
				run.error = undefined;
			} catch (e) {
				run.status = "failed";
				run.error = e && e.message ? String(e.message) : String(e);
			}
			await ctx.host.store.put(keys.runRecordKey(experimentId, run.runId), run);
			launched.push(run);
		}
		await ctx.host.store.put(keys.stateKey(experimentId), { status: "running", createdAt: def.createdAt });
		return { launched };
	},

	// ── poll ──────────────────────────────────────────────────────────────────
	// Advance run status from goal-id-keyed gate reads. Idempotent. Enforces
	// per-run budget in framework space (over-budget → failed/over_budget).
	poll: async (ctx, req) => {
		const experimentId = strOf(bodyOf(req).experimentId);
		if (!experimentId) return { error: "EXPERIMENT_ID_REQUIRED" };
		const def = await loadDef(ctx, experimentId);
		if (!def) return { error: "NOT_FOUND" };
		const reader = goalReaderFor(ctx);
		const runs = await loadRuns(ctx, experimentId);
		let allSettled = runs.length > 0;
		for (const run of runs) {
			if (["collected", "failed", "cancelled"].includes(run.status)) continue;
			if (!run.childGoalId) {
				allSettled = false;
				continue;
			}
			const raw = await reader.readOutcome(run.childGoalId);
			run.cost = costSummaryFromRaw(raw) || run.cost;
			applyBudget(run, def.perRunBudget);
			if (run.status === "failed") {
				await ctx.host.store.put(keys.runRecordKey(experimentId, run.runId), run);
				continue;
			}
			if (isSettledFromRaw(raw)) {
				if (run.status !== "settled") {
					run.status = "settled";
					run.settledAt = nowMs();
				}
			} else {
				run.status = run.status === "spawned" ? "running" : run.status;
				allSettled = false;
			}
			await ctx.host.store.put(keys.runRecordKey(experimentId, run.runId), run);
		}
		return { runs, allSettled };
	},

	// ── collect ──────────────────────────────────────────────────────────────
	// For settled runs: read cost/gates/tasks/meta by childGoalId, extract metrics,
	// write rawOutcome + metrics + completionBar + verified + cost; flip collected.
	collect: async (ctx, req) => {
		const body = bodyOf(req);
		const experimentId = strOf(body.experimentId);
		if (!experimentId) return { error: "EXPERIMENT_ID_REQUIRED" };
		const def = await loadDef(ctx, experimentId);
		if (!def) return { error: "NOT_FOUND" };
		const onlyRunId = strOf(body.runId);
		const reader = goalReaderFor(ctx);
		const { selection } = await resolvedMetricsFor(ctx, experimentId, def);
		const runs = await loadRuns(ctx, experimentId);
		for (const run of runs) {
			if (onlyRunId && run.runId !== onlyRunId) continue;
			if (run.status !== "settled") continue;
			if (run.childGoalId) {
				const raw = await reader.readOutcome(run.childGoalId);
				run.rawOutcome = raw;
				run.cost = costSummaryFromRaw(raw) || run.cost;
				run.completionBar = completionBarFromRaw(raw);
				run.verified = run.completionBar === "passed";
			}
			run.metrics = extractMetrics(run.rawOutcome || {}, { def, run }, selection);
			applyBudget(run, def.perRunBudget);
			if (run.status === "settled") {
				run.status = "collected";
				run.collectedAt = nowMs();
			}
			await ctx.host.store.put(keys.runRecordKey(experimentId, run.runId), run);
		}
		return { runs: runs.filter((r) => !onlyRunId || r.runId === onlyRunId) };
	},

	// ── aggregate ──────────────────────────────────────────────────────────────
	// Computed on read via the shared lib from RunRecords (no persisted agg key).
	aggregate: async (ctx, req) => {
		const experimentId = strOf(bodyOf(req).experimentId);
		if (!experimentId) return { error: "EXPERIMENT_ID_REQUIRED" };
		const def = await loadDef(ctx, experimentId);
		if (!def) return { error: "NOT_FOUND" };
		const runs = await loadRuns(ctx, experimentId);
		const { resolved } = await resolvedMetricsFor(ctx, experimentId, def);
		if (def.mode === "autoresearch") {
			const ledger = buildLedger({ runs, objective: def.objective });
			return { mode: "autoresearch", ledger, aggregation: aggregateExperiment({ def, runs, metrics: resolved }) };
		}
		return aggregateExperiment({ def, runs, metrics: resolved });
	},

	// ── iterate (autoresearch only) — ONE deterministic loop step ──────────────
	// 1. stop-check first; 2. collect settled candidates; 3. evaluate stop again;
	// 4. spawn the next candidate under the per-iteration budget if not stopped.
	iterate: async (ctx, req) => {
		const experimentId = strOf(bodyOf(req).experimentId);
		if (!experimentId) return { error: "EXPERIMENT_ID_REQUIRED" };
		const def = await loadDef(ctx, experimentId);
		if (!def) return { error: "NOT_FOUND" };
		if (def.mode !== "autoresearch") return { error: "ITERATE_AR_ONLY" };
		if (typeof ctx.host.agents.spawnGoal !== "function") return { error: "SPAWN_GOAL_UNAVAILABLE" };

		const state = (await ctx.host.store.get(keys.stateKey(experimentId))) || { status: "running", createdAt: def.createdAt };
		if (state.stopped) return { stopped: state.stopped, iteration: state.iteration || 0 };

		const reader = goalReaderFor(ctx);
		const { selection } = await resolvedMetricsFor(ctx, experimentId, def);
		let runs = await loadRuns(ctx, experimentId);

		// Collect any settled-but-uncollected candidates first (so decisions are current).
		for (const run of runs) {
			if (run.status !== "spawned" && run.status !== "running" && run.status !== "settled") continue;
			if (!run.childGoalId) continue;
			const raw = await reader.readOutcome(run.childGoalId);
			run.cost = costSummaryFromRaw(raw) || run.cost;
			run.rawOutcome = raw;
			if (isSettledFromRaw(raw)) {
				run.completionBar = completionBarFromRaw(raw);
				run.verified = run.completionBar === "passed";
				run.metrics = extractMetrics(raw, { def, run }, selection);
				run.status = "collected";
				run.collectedAt = nowMs();
				if (!run.settledAt) run.settledAt = nowMs();
			} else {
				run.status = run.status === "spawned" ? "running" : run.status;
			}
			applyBudget(run, def.perRunBudget);
			await ctx.host.store.put(keys.runRecordKey(experimentId, run.runId), run);
		}
		runs = await loadRuns(ctx, experimentId);

		// A candidate still in flight ⇒ wait (one step at a time; no concurrent candidate).
		const inFlight = runs.find((r) => r.status === "spawned" || r.status === "running");
		if (inFlight) {
			return { iteration: state.iteration || 0, action: "awaiting", candidateRun: inFlight };
		}

		// Deterministic ledger + stop evaluation from the registry.
		const ledger = buildLedger({ runs, objective: def.objective });
		await ctx.host.store.put(keys.ledgerKey(experimentId), ledger);
		const cumulativeCostUsd = runs.reduce((acc, r) => acc + (r.cost && typeof r.cost.costUsd === "number" ? r.cost.costUsd : 0), 0);
		const elapsedMs = nowMs() - (def.createdAt || nowMs());
		const stop = shouldStop({ runs, def, cumulativeCostUsd, elapsedMs });
		if (stop.stopped) {
			const stopped = { reason: stop.reason };
			await ctx.host.store.put(keys.stateKey(experimentId), { ...state, status: "done", stopped });
			return { stopped, iteration: state.iteration || 0, ledger, decision: ledger.length ? ledger[ledger.length - 1] : undefined };
		}

		// Generate + evaluate the next candidate (ledger-seeded; treatment from body).
		const nextIteration = runs.filter((r) => typeof r.iteration === "number").length;
		const candidate = bodyOf(req).candidate || seedCandidate(ledger, def);
		const item = { armId: `iter-${nextIteration}`, iteration: nextIteration, runId: keys.arRunId(nextIteration), runKey: keys.spawnRunKey(experimentId, keys.arRunId(nextIteration)) };
		const run = newRunRecord(def, item);
		try {
			const { goalId } = await ctx.host.agents.spawnGoal(buildCandidateSpawnArgs(def, nextIteration, candidate));
			run.childGoalId = goalId;
			run.status = "spawned";
			run.spawnedAt = nowMs();
		} catch (e) {
			run.status = "failed";
			run.error = e && e.message ? String(e.message) : String(e);
		}
		await ctx.host.store.put(keys.runRecordKey(experimentId, run.runId), run);
		await ctx.host.store.put(keys.stateKey(experimentId), { ...state, status: "running", iteration: nextIteration });
		return { iteration: nextIteration, action: "spawned", candidateRun: run, ledger };
	},

	// ── listExperiments ────────────────────────────────────────────────────────
	listExperiments: async (ctx) => {
		const idx = await ctx.host.store.get(keys.INDEX_KEY);
		const ids = Array.isArray(idx) ? idx : [];
		const defs = await Promise.all(ids.map((id) => loadDef(ctx, id)));
		return defs.filter((d) => d && typeof d === "object");
	},

	// ── getExperiment ──────────────────────────────────────────────────────────
	getExperiment: async (ctx, req) => {
		const experimentId = strOf(queryOf(req).experimentId) || strOf(bodyOf(req).experimentId);
		if (!experimentId) return { error: "EXPERIMENT_ID_REQUIRED" };
		const def = await loadDef(ctx, experimentId);
		if (!def) return { error: "NOT_FOUND" };
		const [state, runs, ledger, dashboard, metrics] = await Promise.all([
			ctx.host.store.get(keys.stateKey(experimentId)),
			loadRuns(ctx, experimentId),
			ctx.host.store.get(keys.ledgerKey(experimentId)),
			ctx.host.store.get(keys.dashboardKey(experimentId)),
			ctx.host.store.get(keys.metricsKey(experimentId)),
		]);
		return { def, state: state || null, runs, ledger: Array.isArray(ledger) ? ledger : [], dashboard: dashboard || null, metrics: Array.isArray(metrics) ? metrics : [] };
	},

	// ── saveMetrics — edit selection; re-extract from stored rawOutcome (no re-run) ──
	saveMetrics: async (ctx, req) => {
		const body = bodyOf(req);
		const experimentId = strOf(body.experimentId);
		if (!experimentId) return { error: "EXPERIMENT_ID_REQUIRED" };
		const def = await loadDef(ctx, experimentId);
		if (!def) return { error: "NOT_FOUND" };
		const metrics = Array.isArray(body.metrics) ? body.metrics : [];
		await ctx.host.store.put(keys.metricsKey(experimentId), metrics);
		// Re-extract from stored rawOutcome for already-collected runs (no re-spawn).
		const runs = await loadRuns(ctx, experimentId);
		for (const run of runs) {
			if (run.status !== "collected" || !run.rawOutcome) continue;
			run.metrics = extractMetrics(run.rawOutcome, { def, run }, metrics);
			await ctx.host.store.put(keys.runRecordKey(experimentId, run.runId), run);
		}
		return { ok: true };
	},

	// ── saveDashboard — edit view-spec; re-renders from stored runs (no re-run) ──
	saveDashboard: async (ctx, req) => {
		const body = bodyOf(req);
		const experimentId = strOf(body.experimentId);
		if (!experimentId) return { error: "EXPERIMENT_ID_REQUIRED" };
		const def = await loadDef(ctx, experimentId);
		if (!def) return { error: "NOT_FOUND" };
		const dashboard = body.dashboard && Array.isArray(body.dashboard.widgets) ? body.dashboard : { widgets: [] };
		await ctx.host.store.put(keys.dashboardKey(experimentId), dashboard);
		return { ok: true };
	},

	// ── report — { model, html } via the shared reporting lib (single source) ──
	report: async (ctx, req) => {
		const experimentId = strOf(bodyOf(req).experimentId) || strOf(queryOf(req).experimentId);
		if (!experimentId) return { error: "EXPERIMENT_ID_REQUIRED" };
		const def = await loadDef(ctx, experimentId);
		if (!def) return { error: "NOT_FOUND" };
		const [runs, ledgerStored, dashboard, state] = await Promise.all([
			loadRuns(ctx, experimentId),
			ctx.host.store.get(keys.ledgerKey(experimentId)),
			ctx.host.store.get(keys.dashboardKey(experimentId)),
			ctx.host.store.get(keys.stateKey(experimentId)),
		]);
		const { resolved } = await resolvedMetricsFor(ctx, experimentId, def);
		const ledger = Array.isArray(ledgerStored) ? ledgerStored : def.mode === "autoresearch" ? buildLedger({ runs, objective: def.objective }) : [];
		const model = buildReportModel({ def, runs, ledger, dashboard, metrics: resolved, state });
		return { model, html: renderReportHtml(model) };
	},

	// ── listMetrics / listWidgets — registry introspection for the panel ──
	listMetrics: async () => listMetricExtractors(),
	listWidgets: async () => listWidgetDescriptors(),

	// ── cancel — flip in-flight runs cancelled + stop the AR loop (honest v1) ──
	// v1 has NO goal-stop host verb (host.agents.dismiss takes a host-agent child
	// SESSION id, not a goal id, so calling it with run.childGoalId only no-ops while
	// falsely reporting the run cancelled). So cancel does what it CAN do honestly:
	// it marks runs cancelled and sets state.stopped so the autoresearch loop stops
	// spawning further candidates (iterate early-returns on state.stopped). It does
	// NOT forcibly terminate arm goals already spawned — there is no host verb for it.
	cancel: async (ctx, req) => {
		const experimentId = strOf(bodyOf(req).experimentId);
		if (!experimentId) return { error: "EXPERIMENT_ID_REQUIRED" };
		const def = await loadDef(ctx, experimentId);
		if (!def) return { error: "NOT_FOUND" };
		const runs = await loadRuns(ctx, experimentId);
		let cancelled = 0;
		for (const run of runs) {
			if (["collected", "failed", "cancelled"].includes(run.status)) continue;
			run.status = "cancelled";
			await ctx.host.store.put(keys.runRecordKey(experimentId, run.runId), run);
			cancelled++;
		}
		const state = (await ctx.host.store.get(keys.stateKey(experimentId))) || {};
		await ctx.host.store.put(keys.stateKey(experimentId), { ...state, status: "cancelled", stopped: { reason: "cancelled" } });
		return { cancelled };
	},
};

/** v1 simple proposer: greedy seed around best-so-far from the ledger. Deterministic input. */
function seedCandidate(ledger, def) {
	const accepted = (ledger || []).filter((e) => e.decision === "accepted");
	const best = accepted.length ? accepted[accepted.length - 1] : undefined;
	return {
		summary: best ? `improve on best objective ${best.objective} from iteration ${best.iteration}` : "establish a baseline candidate",
		metadata: {},
	};
}

// Exposed for unit tests (pure helpers reachable without a live host).
export const __test = { validateDef, seedCandidate };
