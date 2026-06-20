// Metric-extractor contract + registry + built-ins (the metric extensibility seam).
//
// A MetricExtractor is PURE: given a RunRecord.rawOutcome (and ctx), it returns a
// number or null (absent). Adding a metric is a REGISTRATION, not a refactor.
// Reporting NEVER runs extractors — `collect`/`saveMetrics` run them and store the
// numbers on RunRecord.metrics; reporting consumes those.
//
//   interface MetricExtractor {
//     id: string; label: string; direction: 'max'|'min'; unit?: string;
//     extract(raw, ctx): number | null;
//   }

const registry = new Map();

/** Register a metric extractor (last-write-wins on id). */
export function registerMetric(extractor) {
	if (!extractor || typeof extractor.id !== "string" || typeof extractor.extract !== "function") {
		throw new Error("registerMetric: { id, extract } required");
	}
	registry.set(extractor.id, {
		id: extractor.id,
		label: extractor.label || extractor.id,
		direction: extractor.direction || "max",
		unit: extractor.unit,
		extract: extractor.extract,
	});
}

/** Resolve a registered extractor by id, including the dynamic `user.<name>` channel. */
export function getMetric(id) {
	if (registry.has(id)) return registry.get(id);
	if (typeof id === "string" && id.startsWith("user.")) {
		const name = id.slice("user.".length);
		return {
			id,
			label: name,
			direction: "max",
			extract: (raw) => numOrNull(raw && raw.userMetrics ? raw.userMetrics[name] : undefined),
		};
	}
	return undefined;
}

/** Descriptors for the define form (`listMetrics` route). */
export function listMetrics() {
	return [...registry.values()].map((m) => ({ id: m.id, label: m.label, direction: m.direction, unit: m.unit }));
}

function numOrNull(v) {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Resolve a MetricSelection[] into full descriptors merged with the run-extracted
 * values. Returns descriptors `{ metricId, label, direction, unit, aggregation }`
 * the shared aggregation/report functions consume. Unknown ids are skipped.
 */
export function resolveSelection(selection = []) {
	const out = [];
	for (const sel of selection) {
		const id = typeof sel === "string" ? sel : sel && sel.metricId;
		if (!id) continue;
		const ex = getMetric(id);
		if (!ex) continue;
		// The user's explicit override wins; otherwise the metric's REGISTERED direction
		// (built-in OR code-registered custom). Emit it as `directionOverride` too, because
		// the shared winner selection (aggregate.ts::metricDirection) reads ONLY
		// directionOverride or its built-in table — a custom min-metric would otherwise be
		// compared as max. So the resolved direction must travel as the override.
		const direction = (sel && sel.directionOverride) || ex.direction;
		out.push({
			metricId: id,
			label: ex.label,
			direction,
			directionOverride: direction,
			unit: ex.unit,
			aggregation: (sel && sel.aggregation) || "median",
		});
	}
	return out;
}

/**
 * Extract the selected metrics from a run's rawOutcome. Returns
 * `{ [metricId]: number|null }`. This is what `collect` writes onto
 * RunRecord.metrics and what `saveMetrics` re-runs over stored rawOutcome (no re-run).
 *
 * @param {object} raw RunRecord.rawOutcome
 * @param {object} ctx { def, run }
 * @param {Array} selection MetricSelection[] (or metricId[])
 */
export function extractMetrics(raw, ctx, selection = []) {
	const metrics = {};
	for (const sel of selection) {
		const id = typeof sel === "string" ? sel : sel && sel.metricId;
		if (!id) continue;
		const ex = getMetric(id);
		metrics[id] = ex ? safeExtract(ex, raw, ctx) : null;
	}
	return metrics;
}

function safeExtract(ex, raw, ctx) {
	try {
		return numOrNull(ex.extract(raw || {}, ctx || {}));
	} catch {
		return null;
	}
}

// ── canonical built-in extractors (the deliberately small core set) ──

registerMetric({
	id: "cost.totalUsd",
	label: "Total cost (USD)",
	direction: "min",
	unit: "$",
	extract: (raw) => numOrNull(raw.costUsd),
});

registerMetric({
	id: "cost.tokensTotal",
	label: "Total tokens",
	direction: "min",
	extract: (raw) => {
		const inTok = typeof raw.tokensIn === "number" ? raw.tokensIn : 0;
		const outTok = typeof raw.tokensOut === "number" ? raw.tokensOut : 0;
		const total = inTok + outTok;
		return total > 0 ? total : null;
	},
});

registerMetric({
	id: "cost.cacheHitRate",
	label: "Cache hit rate",
	direction: "max",
	extract: (raw) => numOrNull(raw.cacheHitRate),
});

registerMetric({
	id: "gates.passRate",
	label: "Gate pass rate",
	direction: "max",
	extract: (raw) => {
		const verdicts = raw.gateVerdicts;
		if (!verdicts || typeof verdicts !== "object") return null;
		const values = Object.values(verdicts);
		if (values.length === 0) return null;
		const passed = values.filter((v) => v === "passed").length;
		return passed / values.length;
	},
});

registerMetric({
	id: "gates.firstPassClean",
	label: "First-pass clean",
	direction: "max",
	extract: (raw) => {
		const verdicts = raw.gateVerdicts;
		if (!verdicts || typeof verdicts !== "object") return null;
		const values = Object.values(verdicts);
		if (values.length === 0) return null;
		return values.every((v) => v === "passed") ? 1 : 0;
	},
});

registerMetric({
	id: "tasks.completionRate",
	label: "Task completion rate",
	direction: "max",
	extract: (raw) => {
		const tc = raw.taskCounts;
		if (!tc || typeof tc.total !== "number" || tc.total === 0) return null;
		return (typeof tc.complete === "number" ? tc.complete : 0) / tc.total;
	},
});

registerMetric({
	id: "time.wallClockMs",
	label: "Wall clock (ms)",
	direction: "min",
	unit: "ms",
	extract: (raw) => numOrNull(raw.wallClockMs),
});

registerMetric({
	id: "objective.value",
	label: "Objective value",
	direction: "max",
	// Autoresearch objective passthrough: the arm reports its objective number
	// under the user-metric channel keyed `objective`.
	extract: (raw) => numOrNull(raw.userMetrics ? raw.userMetrics.objective : undefined),
});

registerMetric({
	id: "command.metric",
	label: "Command metric",
	direction: "max",
	// Generic command-runnable metric: the arm's command emits a number on its
	// metric channel; the configured channel key (def.runnable.metricChannel) names
	// the userMetrics field, defaulting to `metric`.
	extract: (raw, ctx) => {
		const um = raw.userMetrics;
		if (!um || typeof um !== "object") return null;
		const channel = ctx && ctx.def && ctx.def.runnable ? ctx.def.runnable.metricChannel : undefined;
		const key = channel && um[channel] !== undefined ? channel : "metric";
		return numOrNull(um[key]);
	},
});
