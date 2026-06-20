// Experiment-runner ENGINE — mode-agnostic run-config mapping, fan-out, and
// outcome collection. The pure mappers (run-config → spawnGoal args, REST payload
// → RawOutcome, cost projection, budget enforcement) are testable without a
// server; the IO helpers (goal-id-keyed REST reads, creds) accept an injected
// fetch so unit tests run with mocked payloads.
//
// SECURITY: arm outcomes are read ONLY via goal-id-keyed REST reads (cost/gates/
// tasks/meta endpoints). The pack NEVER parses a sibling goal's session-costs.json
// / gates.json / tasks.json through ambient fs/worktree paths — those state files
// live under the centralized .bobbit/state and a sandboxed arm's files may be on a
// container path the pack cannot reach (design-doc §5.2 / §11).

import { readFileSync } from "node:fs";
import { abRunId, arRunId, spawnRunKey } from "./store-keys.mjs";

const DEFAULT_PRIOR_USD = 0.5;

/** Deep-merge plain objects (arrays/scalars replace wholesale — #822 semantics). */
export function deepMerge(base, overlay) {
	if (!isPlainObject(base)) return isPlainObject(overlay) ? structuredCloneSafe(overlay) : overlay;
	if (!isPlainObject(overlay)) return structuredCloneSafe(base);
	const out = structuredCloneSafe(base);
	for (const [k, v] of Object.entries(overlay)) {
		out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : structuredCloneSafe(v);
	}
	return out;
}

function isPlainObject(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function structuredCloneSafe(v) {
	if (v === null || typeof v !== "object") return v;
	try {
		return structuredClone(v);
	} catch {
		return JSON.parse(JSON.stringify(v));
	}
}

/** Turn a RunnableSpec + variant into the arm child goal's spec text. */
export function runnableSpecToGoalSpec(runnable, variant) {
	if (!runnable) return "Run the experiment arm.";
	if (runnable.kind === "command" && runnable.command) {
		const channel = runnable.metricChannel || "stdout-json";
		return [
			`# Experiment arm: ${variant ? variant.label : "candidate"}`,
			"",
			"Run the following command and report its emitted metric.",
			"",
			"```sh",
			runnable.command,
			"```",
			"",
			channel === "stdout-json"
				? "The command prints a final JSON line `{\"experiment\":{\"userMetrics\":{\"metric\":<number>}}}`. Capture that metric into this goal's metadata under `experiment.userMetrics`."
				: `The command writes its metric to \`${channel}\` as \`{ userMetrics: { ... } }\`. Capture it into this goal's metadata under \`experiment.userMetrics\`.`,
		].join("\n");
	}
	const base = runnable.spec || "Complete the experiment arm task.";
	return variant ? `# Variant: ${variant.label}\n\n${base}` : base;
}

/**
 * Plan the A/B fan-out: one entry per (variant × repeat). Pure.
 * @returns {Array<{ armId, repeat, runId, runKey }>}
 */
export function planAbRuns(exp) {
	const out = [];
	const variants = Array.isArray(exp.variants) ? exp.variants : [];
	const repeats = Math.max(1, Number(exp.repeats) || 1);
	for (const variant of variants) {
		for (let repeat = 0; repeat < repeats; repeat++) {
			const runId = abRunId(variant.armId, repeat);
			out.push({ armId: variant.armId, repeat, runId, runKey: spawnRunKey(exp.experimentId, runId) });
		}
	}
	return out;
}

/** Build spawnGoal opts for an A/B variant×repeat run. Pure. */
export function buildAbSpawnArgs(exp, variant, repeat) {
	const runId = abRunId(variant.armId, repeat);
	const runKey = spawnRunKey(exp.experimentId, runId);
	const baseMeta = { experiment: { experimentId: exp.experimentId, armId: variant.armId, repeat } };
	if (typeof exp.perRunBudget === "number") baseMeta.experiment.budget = exp.perRunBudget;
	return {
		title: `${exp.title} — ${variant.label} #${repeat}`,
		spec: runnableSpecToGoalSpec(exp.runnable, variant),
		runKey,
		metadata: deepMerge(baseMeta, variant.metadata || {}),
		inlineRoles: variant.inlineRoles,
		workflowId: exp.workflowId,
		parentGoalId: exp.parentGoalId,
	};
}

/** Build spawnGoal opts for an autoresearch candidate. Pure. */
export function buildCandidateSpawnArgs(exp, iteration, candidate) {
	const runId = arRunId(iteration);
	const runKey = spawnRunKey(exp.experimentId, runId);
	const armId = `iter-${iteration}`;
	const baseMeta = { experiment: { experimentId: exp.experimentId, armId, iteration } };
	if (typeof exp.perRunBudget === "number") baseMeta.experiment.budget = exp.perRunBudget;
	const treatment = (candidate && candidate.metadata) || {};
	return {
		title: `${exp.title} — candidate #${iteration}`,
		spec: candidateSpec(exp, iteration, candidate),
		runKey,
		metadata: deepMerge(baseMeta, treatment),
		inlineRoles: candidate && candidate.inlineRoles,
		workflowId: exp.workflowId,
		parentGoalId: exp.parentGoalId,
	};
}

function candidateSpec(exp, iteration, candidate) {
	const base = runnableSpecToGoalSpec(exp.runnable, { label: `candidate #${iteration}` });
	const seed = candidate && candidate.summary ? `\n\nLedger seed: ${candidate.summary}` : "";
	return `${base}${seed}`;
}

/** Make a fresh RunRecord for a planned run. Pure. */
export function newRunRecord(exp, { armId, repeat, iteration, runId, runKey }) {
	const rec = {
		experimentId: exp.experimentId,
		runId,
		armId,
		runKey,
		status: "pending",
		metrics: {},
	};
	if (typeof repeat === "number") rec.repeat = repeat;
	if (typeof iteration === "number") rec.iteration = iteration;
	return rec;
}

// ── outcome parsing (REST payload → RawOutcome) ──

/** Map goal-id-keyed REST reads into a RawOutcome. Pure. */
export function parseRawOutcome({ cost, gates, tasks, meta } = {}) {
	const raw = {};
	if (cost && typeof cost === "object") {
		if (typeof cost.totalCostUsd === "number") raw.costUsd = cost.totalCostUsd;
		else if (typeof cost.costUsd === "number") raw.costUsd = cost.costUsd;
		if (typeof cost.tokensIn === "number") raw.tokensIn = cost.tokensIn;
		if (typeof cost.tokensOut === "number") raw.tokensOut = cost.tokensOut;
		if (typeof cost.cacheHitRate === "number") raw.cacheHitRate = cost.cacheHitRate;
		if (typeof cost.wallClockMs === "number") raw.wallClockMs = cost.wallClockMs;
	}
	if (gates && Array.isArray(gates.gates)) {
		raw.gateVerdicts = {};
		for (const g of gates.gates) {
			if (g && g.id) raw.gateVerdicts[g.id] = normalizeVerdict(g.verdict || g.status);
		}
	} else if (gates && typeof gates === "object" && gates.gateVerdicts) {
		raw.gateVerdicts = gates.gateVerdicts;
	}
	if (tasks && Array.isArray(tasks.tasks)) {
		const total = tasks.tasks.length;
		const complete = tasks.tasks.filter((t) => t && (t.state === "complete" || t.status === "complete")).length;
		raw.taskCounts = { complete, total };
	} else if (tasks && tasks.taskCounts) {
		raw.taskCounts = tasks.taskCounts;
	}
	const userMetrics = extractUserMetrics(meta);
	if (userMetrics) raw.userMetrics = userMetrics;
	return raw;
}

function normalizeVerdict(v) {
	if (v === "passed" || v === "pass") return "passed";
	if (v === "failed" || v === "fail") return "failed";
	return "pending";
}

function extractUserMetrics(meta) {
	if (!meta || typeof meta !== "object") return undefined;
	const md = meta.metadata || meta;
	const exp = md && md.experiment;
	if (exp && exp.userMetrics && typeof exp.userMetrics === "object") return exp.userMetrics;
	return undefined;
}

/** Completion bar from gate verdicts. Pure. */
export function completionBarFromRaw(raw) {
	const verdicts = raw && raw.gateVerdicts;
	if (!verdicts || typeof verdicts !== "object") return "incomplete";
	const values = Object.values(verdicts);
	if (values.length === 0) return "incomplete";
	if (values.some((v) => v === "pending")) return "incomplete";
	if (values.every((v) => v === "passed")) return "passed";
	return "failed";
}

/** Whether all gate verdicts are resolved (no pending) → the run has settled. Pure. */
export function isSettledFromRaw(raw) {
	const verdicts = raw && raw.gateVerdicts;
	if (!verdicts || typeof verdicts !== "object") return false;
	const values = Object.values(verdicts);
	if (values.length === 0) return false;
	return values.every((v) => v !== "pending");
}

/** Cost summary from a RawOutcome. Pure. */
export function costSummaryFromRaw(raw) {
	if (!raw) return undefined;
	const out = {};
	if (typeof raw.costUsd === "number") out.costUsd = raw.costUsd;
	if (typeof raw.tokensIn === "number") out.tokensIn = raw.tokensIn;
	if (typeof raw.tokensOut === "number") out.tokensOut = raw.tokensOut;
	return Object.keys(out).length ? out : undefined;
}

/**
 * Enforce a per-run budget in framework space. If the monitored cost exceeds
 * perRunBudget, the run is marked failed/over_budget and excluded from acceptance.
 * Mutates and returns the run record. Pure (no IO). Overshoot by one poll interval
 * is expected; the same threshold is used for every run so comparisons stay fair.
 */
export function applyBudget(run, perRunBudget) {
	if (typeof perRunBudget !== "number" || !Number.isFinite(perRunBudget)) return run;
	const cost = run.cost && typeof run.cost.costUsd === "number" ? run.cost.costUsd : run.rawOutcome && typeof run.rawOutcome.costUsd === "number" ? run.rawOutcome.costUsd : undefined;
	if (typeof cost === "number" && cost > perRunBudget) {
		run.status = "failed";
		run.error = "over_budget";
		run.verified = false;
		run.completionBar = run.completionBar === "passed" ? "incomplete" : run.completionBar;
	}
	return run;
}

/** Bounded A/B cost projection (pre-launch). Pure. */
export function projectCost(exp) {
	const variants = Array.isArray(exp.variants) ? exp.variants : [];
	const repeats = Math.max(1, Number(exp.repeats) || 1);
	if (exp.mode === "autoresearch") {
		const maxIter = exp.caps && Number.isFinite(exp.caps.maxIterations) ? exp.caps.maxIterations : undefined;
		const estPerIter = numberOr(exp.perRunBudget, numberOr(exp.runnable && exp.runnable.estCostUsd, DEFAULT_PRIOR_USD));
		const arms = maxIter !== undefined ? maxIter : null;
		return {
			mode: "autoresearch",
			arms,
			estPerArmUsd: estPerIter,
			estCostUsd: arms !== null ? arms * estPerIter : null,
			maxCostUsd: exp.caps ? exp.caps.maxCostUsd : undefined,
			concurrencyCap: exp.maxConcurrency,
		};
	}
	const arms = variants.length * repeats;
	const estPerArm = numberOr(exp.runnable && exp.runnable.estCostUsd, DEFAULT_PRIOR_USD);
	return {
		mode: "ab",
		arms,
		estPerArmUsd: estPerArm,
		estCostUsd: arms * estPerArm,
		concurrencyCap: exp.maxConcurrency,
	};
}

function numberOr(v, fallback) {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// ── injectable goal-id-keyed REST reader ──

/** Read gateway creds from disk (never env). Returns { token, gatewayUrl }. */
export function loadCreds() {
	const token = tryRead(".bobbit/state/token");
	const gatewayUrl = tryRead(".bobbit/state/gateway-url");
	return { token: token ? token.trim() : undefined, gatewayUrl: gatewayUrl ? gatewayUrl.trim() : undefined };
}

function tryRead(path) {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * Create a goal-id-keyed REST reader. `io` may inject `{ fetchImpl, creds }` for
 * tests. The reader returns parsed JSON or null on any failure (never throws).
 */
export function createGoalReader(io = {}) {
	const creds = io.creds || loadCreds();
	const fetchImpl = io.fetchImpl || (typeof fetch === "function" ? fetch : undefined);
	async function get(path) {
		if (!fetchImpl || !creds.gatewayUrl) return null;
		try {
			const res = await fetchImpl(`${creds.gatewayUrl}${path}`, {
				headers: creds.token ? { Authorization: `Bearer ${creds.token}` } : {},
			});
			if (!res || !res.ok) return null;
			return await res.json();
		} catch {
			return null;
		}
	}
	return {
		cost: (goalId) => get(`/api/goals/${goalId}/cost`),
		gates: (goalId) => get(`/api/goals/${goalId}/gates`),
		tasks: (goalId) => get(`/api/goals/${goalId}/tasks`),
		meta: (goalId) => get(`/api/goals/${goalId}`),
		/** Read all four channels for a goal and assemble a RawOutcome. */
		async readOutcome(goalId) {
			const [cost, gates, tasks, meta] = await Promise.all([
				this.cost(goalId),
				this.gates(goalId),
				this.tasks(goalId),
				this.meta(goalId),
			]);
			return parseRawOutcome({ cost, gates, tasks, meta });
		},
	};
}
