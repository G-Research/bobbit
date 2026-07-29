import { readFileSync } from "node:fs";
import { join } from "node:path";

const key = (experimentId) => `experiments/${experimentId}`;
const now = () => new Date().toISOString();

function body(req) {
	return (req && req.body && typeof req.body === "object") ? req.body : {};
}

async function readStored(ctx, experimentId) {
	if (!experimentId) return null;
	return await ctx.host.store.get(key(experimentId));
}

async function writeStored(ctx, experiment) {
	experiment.updatedAt = now();
	await ctx.host.store.put(key(experiment.experimentId), experiment);
	return experiment;
}

function gatewayUrl() {
	return process.env.BOBBIT_GATEWAY_URL || (process.env.E2E_PORT ? `http://127.0.0.1:${process.env.E2E_PORT}` : "");
}

function gatewayToken() {
	const env = process.env.BOBBIT_TOKEN?.trim();
	if (env) return env;
	const dir = process.env.BOBBIT_DIR;
	if (dir) {
		try { return readFileSync(join(dir, "state", "token"), "utf8").trim(); } catch {}
	}
	return "";
}

async function gatewayFetch(path, init = {}) {
	const base = gatewayUrl();
	const token = gatewayToken();
	if (!base || !token) throw new Error("gateway credentials unavailable for smoke fixture");
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) };
	return await fetch(`${base}${path}`, { ...init, headers });
}

async function getGoal(goalId) {
	const res = await gatewayFetch("/api/goals");
	if (!res.ok) throw new Error(`GET /api/goals failed ${res.status}: ${await res.text()}`);
	const payload = await res.json();
	const goals = Array.isArray(payload.goals) ? payload.goals : payload;
	return goals.find((g) => g.id === goalId) || null;
}

function defaultDefinition(input, ctx) {
	const experimentId = String(input.experimentId || `smoke-${Date.now().toString(36)}`);
	return {
		experimentId,
		title: String(input.title || "E2E Experiment Runner smoke"),
		mode: input.mode || "ab",
		parentGoalId: input.parentGoalId,
		teamLeadSecret: input.teamLeadSecret,
		runnable: input.runnable || { kind: "spec", spec: "Minimal smoke arm; finish with one short sentence." },
		variants: Array.isArray(input.variants) && input.variants.length ? input.variants : [
			{ armId: "baseline", label: "baseline", metadata: { smokeTreatment: { arm: "baseline", marker: "smoke-baseline-101" } } },
			{ armId: "variant-b", label: "variant-b", metadata: { smokeTreatment: { arm: "variant-b", marker: "smoke-variant-b-202" } } },
		],
		repeats: Number.isFinite(Number(input.repeats)) ? Number(input.repeats) : 1,
		maxConcurrency: Math.min(2, Math.max(1, Number(input.maxConcurrency || 1))),
		perRunBudget: Math.min(0.05, Math.max(0, Number(input.perRunBudget || 0.01))),
		metrics: Array.isArray(input.metrics) ? input.metrics : [{ metricId: "command.metric", aggregation: "median" }],
		dashboard: input.dashboard && typeof input.dashboard === "object" ? input.dashboard : { widgets: [{ id: "smoke-summary", type: "summary-cards", title: "Smoke summary", bind: { metricIds: ["command.metric"] } }] },
		createdAt: now(),
		updatedAt: now(),
		status: "defined",
		ownerSessionId: ctx.sessionId,
		runs: [],
	};
}

async function spawnGoal(ctx, experiment, variant, repeat) {
	const parent = await getGoal(experiment.parentGoalId);
	if (!parent) throw new Error(`parent goal not found: ${experiment.parentGoalId}`);
	const planId = `${experiment.experimentId}:${variant.armId}:${repeat}`;
	const variantMetadata = variant.metadata && typeof variant.metadata === "object" ? variant.metadata : {};
	const metadata = {
		...variantMetadata,
		experiment: {
			...(variantMetadata.experiment && typeof variantMetadata.experiment === "object" ? variantMetadata.experiment : {}),
			id: experiment.experimentId,
			armId: variant.armId,
			repeat,
			budget: experiment.perRunBudget,
			planId,
		},
	};
	const res = await gatewayFetch("/api/goals", {
		method: "POST",
		headers: {
			"X-Bobbit-Session-Secret": experiment.teamLeadSecret,
			"X-Bobbit-Spawning-Session": ctx.sessionId,
		},
		body: JSON.stringify({
			title: `${experiment.title} — ${variant.label || variant.armId}`,
			spec: experiment.runnable?.spec || "Minimal deterministic Experiment Runner smoke child goal.",
			cwd: parent.cwd,
			projectId: parent.projectId,
			parentGoalId: experiment.parentGoalId,
			autoStartTeam: false,
			worktree: false,
			metadata,
		}),
	});
	const text = await res.text();
	let parsed;
	try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
	if (res.status !== 201) throw new Error(`spawnGoal ${planId} failed ${res.status}: ${text}`);
	return { runId: planId, armId: variant.armId, repeat, goalId: parsed.id, status: "launched", metadata };
}

function reportModel(experiment) {
	const metrics = Array.isArray(experiment.metrics) ? experiment.metrics : [];
	const widgets = Array.isArray(experiment.dashboard?.widgets) ? experiment.dashboard.widgets : [];
	return {
		experimentId: experiment.experimentId,
		status: experiment.status,
		runs: experiment.runs || [],
		metrics,
		dashboard: experiment.dashboard || { widgets },
		generatedAt: now(),
	};
}

export const routes = {
	async defineexperiment(ctx, req) {
		const input = body(req);
		if (input.mode === "autoresearch") {
			const maxRuns = Number(input.stop?.maxRuns ?? input.maxRuns ?? 0);
			const maxCost = Number(input.stop?.maxCostUsd ?? input.maxCostUsd ?? 0);
			if (!Number.isFinite(maxRuns) || maxRuns <= 0 || !Number.isFinite(maxCost) || maxCost <= 0) {
				return { error: "AR_UNCAPPED", message: "Autoresearch requires explicit finite maxRuns and maxCostUsd hard caps." };
			}
		}
		const experiment = defaultDefinition(input, ctx);
		if (experiment.mode !== "ab") return { error: "MODE_UNSUPPORTED" };
		if (!experiment.parentGoalId) return { error: "NO_PARENT_GOAL" };
		if (!experiment.teamLeadSecret) return { error: "NO_SESSION_SECRET" };
		await writeStored(ctx, experiment);
		return { ok: true, experimentId: experiment.experimentId, projection: { mode: "ab", arms: experiment.variants.length, repeats: experiment.repeats } };
	},

	async launch(ctx, req) {
		const { experimentId } = body(req);
		const experiment = await readStored(ctx, experimentId);
		if (!experiment) return { error: "EXPERIMENT_NOT_FOUND" };
		if (Array.isArray(experiment.runs) && experiment.runs.length) return { ok: true, experimentId, launched: experiment.runs, alreadyLaunched: true };
		const launched = [];
		for (const variant of experiment.variants) {
			for (let repeat = 1; repeat <= experiment.repeats; repeat++) {
				launched.push(await spawnGoal(ctx, experiment, variant, repeat));
			}
		}
		experiment.runs = launched;
		experiment.status = "launched";
		await writeStored(ctx, experiment);
		return { ok: true, experimentId, launched };
	},

	async poll(ctx, req) {
		const experiment = await readStored(ctx, body(req).experimentId);
		if (!experiment) return { error: "EXPERIMENT_NOT_FOUND" };
		return { ok: true, status: experiment.status, runs: experiment.runs || [] };
	},

	async collect(ctx, req) {
		const experiment = await readStored(ctx, body(req).experimentId);
		if (!experiment) return { error: "EXPERIMENT_NOT_FOUND" };
		experiment.status = "collected";
		experiment.runs = (experiment.runs || []).map((r) => ({ ...r, status: "collected", output: `${r.armId} smoke output` }));
		await writeStored(ctx, experiment);
		return { ok: true, collected: experiment.runs.length };
	},

	async aggregate(ctx, req) {
		const experiment = await readStored(ctx, body(req).experimentId);
		if (!experiment) return { error: "EXPERIMENT_NOT_FOUND" };
		experiment.status = "aggregated";
		experiment.aggregate = { arms: experiment.variants.map((v) => v.armId), runCount: (experiment.runs || []).length };
		await writeStored(ctx, experiment);
		return { ok: true, aggregate: experiment.aggregate };
	},

	async savemetrics(ctx, req) {
		const { experimentId, metrics } = body(req);
		const experiment = await readStored(ctx, experimentId);
		if (!experiment) return { error: "EXPERIMENT_NOT_FOUND" };
		experiment.metrics = Array.isArray(metrics) ? metrics : [];
		await writeStored(ctx, experiment);
		return { ok: true };
	},

	async savedashboard(ctx, req) {
		const { experimentId, dashboard } = body(req);
		const experiment = await readStored(ctx, experimentId);
		if (!experiment) return { error: "EXPERIMENT_NOT_FOUND" };
		experiment.dashboard = dashboard && typeof dashboard === "object" ? dashboard : { widgets: [] };
		await writeStored(ctx, experiment);
		return { ok: true };
	},

	async report(ctx, req) {
		const experiment = await readStored(ctx, body(req).experimentId);
		if (!experiment) return { error: "EXPERIMENT_NOT_FOUND" };
		experiment.status = "reported";
		const model = reportModel(experiment);
		const widgetTitles = (model.dashboard.widgets || []).map((w) => w.title || w.id).join(", ");
		const metricIds = (model.metrics || []).map((m) => m.metricId).join(", ");
		const html = `<section><h1>Experiment Runner Smoke Report</h1><p>Experiment ${experiment.experimentId} has ${model.runs.length} runs.</p><p>Widgets: ${widgetTitles}</p><p>Metrics: ${metricIds}</p></section>`;
		experiment.report = { html, model };
		await writeStored(ctx, experiment);
		return { ok: true, html, model };
	},

	async getexperiment(ctx, req) {
		const experiment = await readStored(ctx, body(req).experimentId || req.query?.experimentId);
		return experiment || { error: "EXPERIMENT_NOT_FOUND" };
	},

	async listmetrics() {
		return { ok: true, metrics: ["command.metric", "cost.totalUsd", "time.wallClockMs"] };
	},

	async listwidgets() {
		return { ok: true, widgets: ["summary-cards", "raw-drilldown"] };
	},

	async cancel(ctx, req) {
		const experiment = await readStored(ctx, body(req).experimentId);
		if (!experiment) return { error: "EXPERIMENT_NOT_FOUND" };
		experiment.status = "cancelled";
		await writeStored(ctx, experiment);
		return { ok: true, cancelled: true };
	},
};
