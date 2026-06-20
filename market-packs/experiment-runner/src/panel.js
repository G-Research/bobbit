// Experiment Runner — pack CLIENT panel module (SOURCE; bundled to lib/panel.js
// by scripts/build-market-packs.mjs). One side panel that is a four-view state
// machine — mode-select → define → confirm → dashboard — per
// docs/design/experiment-runner-panel-ux.md.
//
// Two front doors, never a buried toggle:
//   • A/B comparison  — the safe, bounded DEFAULT. Fans out variant × repeat
//     child goals; run-count + cost projection shown BEFORE launch.
//   • Autoresearch    — explicit opt-in, OFF by default. Refuses to launch until
//     at least one hard cap AND one stop condition are set, a per-iteration
//     budget is given, and an explicit danger acknowledgement is ticked.
//
// ALL dynamic data flows through the bound Host API — never a raw fetch:
//   • host.callRoute(<name>, …) — the pack's OWN routes (the canonical 15). The
//     panel calls ONLY the canonical names: defineExperiment, projectCost,
//     launch, poll, collect, aggregate, iterate, listExperiments, getExperiment,
//     saveMetrics, saveDashboard, report, listMetrics, listWidgets, cancel.
//   • host.store.* — the results registry + draft autosave (best-effort; a
//     localStorage mirror gives instant cold paint).
//   • host.requestRender() — repaint after any state patch.
//   • host.ui.navigate(...) — write the deep-link hash on launch + view changes.
//
// The panel renders the dashboard from the `report` route's { model, html } (the
// shared reporting lib's single source of truth). When the route is unavailable
// it degrades to a client-side render of the same widget spec over the stored raw
// outcomes — so the dashboard, metrics edits and dashboard-spec edits always
// re-render WITHOUT a re-run.
//
// Theme tokens only (var(--background/foreground/card/muted-foreground/border/
// primary), the categorical --chart-1..6, and --positive/--negative/--warning for
// accept/reject/cap signals). No hardcoded colours, no :root palette.

// ── Canonical ids (owned by the backend; mirrored here as the offline default so
//    the metrics + dashboard editors render before any route responds). ──
const BUILTIN_METRIC_IDS = [
	"cost.totalUsd",
	"cost.tokensTotal",
	"cost.cacheHitRate",
	"gates.passRate",
	"gates.firstPassClean",
	"tasks.completionRate",
	"time.wallClockMs",
	"objective.value",
	"command.metric",
];

const METRIC_DIRECTION = {
	"cost.totalUsd": "lower-better",
	"cost.tokensTotal": "lower-better",
	"cost.cacheHitRate": "higher-better",
	"gates.passRate": "higher-better",
	"gates.firstPassClean": "higher-better",
	"tasks.completionRate": "higher-better",
	"time.wallClockMs": "lower-better",
	"objective.value": "higher-better",
	"command.metric": "neutral",
};

const DEFAULT_COLLECTED = new Set(["cost.totalUsd", "time.wallClockMs", "gates.passRate", "objective.value"]);

const BUILTIN_WIDGETS = [
	{ id: "comparison-table", label: "Comparison table" },
	{ id: "score-bars", label: "Score bars" },
	{ id: "objective-curve", label: "Objective curve" },
	{ id: "ledger-table", label: "Ledger" },
	{ id: "summary-cards", label: "Summary cards" },
	{ id: "raw-drilldown", label: "Raw runs" },
];

const AGGREGATIONS = ["median", "mean", "p90", "min", "max", "count"];

// ── Store-key schema (mirrors lib/store-keys.mjs — the backend's single source). ──
const K = {
	exp: (id) => `exp/${id}`,
	state: (id) => `exp/${id}/state`,
	runPrefix: (id) => `exp/${id}/run/`,
	ledger: (id) => `exp/${id}/ledger`,
	dashboard: (id) => `exp/${id}/dashboard`,
	metrics: (id) => `exp/${id}/metrics`,
	index: "index/experiments",
	draft: (key) => `drafts/${key}`,
};

const LOCAL_DRAFT_PREFIX = "bobbit:experiment-runner:draft:";

const arrayOf = (v) => (Array.isArray(v) ? v : []);
const asText = (v, fb = "") => (v == null ? fb : String(v));
const num = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
};
const safeId = (v) => asText(v, "exp").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "exp";

/** Parse a metadata-treatment value: number → boolean → JSON → string. */
function parseTreatmentValue(raw) {
	const t = asText(raw).trim();
	if (t === "") return "";
	if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
	if (t === "true") return true;
	if (t === "false") return false;
	if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
		try { return JSON.parse(t); } catch { /* fall through to string */ }
	}
	return t;
}

/** Convert a [{key,value}] editor list into a treatment object. */
function rowsToObject(rows) {
	const out = {};
	for (const row of arrayOf(rows)) {
		const key = asText(row && row.key).trim();
		if (!key) continue;
		out[key] = parseTreatmentValue(row && row.value);
	}
	return out;
}

function parseRolesJson(text) {
	const t = asText(text).trim();
	if (!t) return undefined;
	try {
		const parsed = JSON.parse(t);
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch { return undefined; }
}

const median = (xs) => {
	const a = xs.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
	if (!a.length) return undefined;
	const mid = Math.floor(a.length / 2);
	return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const aggregate = (xs, mode) => {
	const a = xs.filter((x) => Number.isFinite(x));
	if (mode === "count") return a.length;
	if (!a.length) return undefined;
	switch (mode) {
		case "mean": return a.reduce((s, x) => s + x, 0) / a.length;
		case "min": return Math.min(...a);
		case "max": return Math.max(...a);
		case "p90": { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(0.9 * s.length))]; }
		default: return median(a);
	}
};
const fmt = (v) => {
	if (v == null || !Number.isFinite(v)) return "—";
	const abs = Math.abs(v);
	if (abs !== 0 && abs < 0.01) return v.toExponential(2);
	if (Number.isInteger(v)) return String(v);
	return v.toFixed(abs >= 100 ? 1 : 3);
};
const usd = (v) => (v == null || !Number.isFinite(v) ? "—" : `$${v.toFixed(2)}`);

// ── Default draft ──────────────────────────────────────────────────────────────
function emptyTreatmentRows() { return [{ key: "", value: "" }]; }

function defaultMetricsSelection() {
	return BUILTIN_METRIC_IDS.map((id) => ({
		metric: id,
		source: "built-in",
		collect: DEFAULT_COLLECTED.has(id),
		aggregation: "median",
		direction: METRIC_DIRECTION[id] || "neutral",
		primary: id === "gates.passRate",
	}));
}

function defaultDraft() {
	return {
		view: "mode-select",
		mode: null,
		experimentId: undefined,
		basics: { name: "", runnableUnit: "command", body: "", workflowId: "" },
		ab: {
			variants: [
				{ label: "baseline", metadata: emptyTreatmentRows(), rolesJson: "", rolesOpen: false },
				{ label: "variant-b", metadata: emptyTreatmentRows(), rolesJson: "", rolesOpen: false },
			],
			repeats: 3,
			sameCompletionBar: true,
			concurrency: 3,
		},
		auto: {
			objectiveMetric: "objective.value",
			direction: "maximize",
			correctnessGateId: "",
			seed: emptyTreatmentRows(),
			seedRolesJson: "",
			caps: { maxIterations: "", wallClockHours: "", costUsd: "", perIterBudget: "" },
			stops: { plateauK: "", target: "" },
			strategy: "greedy",
			batchSize: "",
		},
		metrics: defaultMetricsSelection(),
		perRunBudget: "",
		confirmAck: false,
	};
}

// Module-level state: instanceKey → entry (survives panel re-creation in a page
// session, mirroring the pr-walkthrough `byJob` pattern).
const byInstance = globalThis.__bobbitExperimentRunnerState || (globalThis.__bobbitExperimentRunnerState = new Map());

// ── Validation ───────────────────────────────────────────────────────────────
function validateAB(d) {
	const errors = [];
	const basics = d.basics || {};
	if (!asText(basics.name).trim()) errors.push("Name is required");
	if (!asText(basics.body).trim()) errors.push("Spec / command body is required");
	const variants = arrayOf(d.ab && d.ab.variants);
	if (variants.length < 2) errors.push("A/B needs at least two variants");
	const labels = new Set();
	const signatures = [];
	variants.forEach((v, i) => {
		const label = asText(v.label).trim();
		if (!label) errors.push(`Variant ${i + 1} needs a label`);
		else if (labels.has(label)) errors.push(`Variant label "${label}" is duplicated`);
		labels.add(label);
		signatures.push(JSON.stringify({ m: rowsToObject(v.metadata), r: parseRolesJson(v.rolesJson) || null }));
	});
	for (let i = 0; i < signatures.length; i++) {
		for (let j = i + 1; j < signatures.length; j++) {
			if (signatures[i] === signatures[j]) {
				errors.push(`Variant "${asText(variants[j].label).trim() || j + 1}" is identical to "${asText(variants[i].label).trim() || i + 1}"`);
			}
		}
	}
	const repeats = num(d.ab && d.ab.repeats);
	if (!repeats || repeats < 1) errors.push("Repeats must be ≥ 1");
	const budget = num(d.perRunBudget);
	if (!budget || budget <= 0) errors.push("Set a per-run budget");
	const concurrency = num(d.ab && d.ab.concurrency);
	if (concurrency != null && (concurrency < 1 || concurrency > 8)) errors.push("Concurrency must be 1–8");
	if (!arrayOf(d.metrics).some((m) => m.collect)) errors.push("Select at least one metric");
	const runCount = variants.length * (repeats || 0);
	const estCostMax = budget ? runCount * budget : undefined;
	return { valid: errors.length === 0, errors, runCount, estCostMax };
}

function validateAuto(d) {
	const errors = [];
	const checklist = [];
	const basics = d.basics || {};
	if (!asText(basics.name).trim()) errors.push("Name is required");
	if (!asText(basics.body).trim()) errors.push("Spec / command body is required");
	const auto = d.auto || {};
	if (!asText(auto.objectiveMetric).trim()) errors.push("Choose an objective metric");
	const perIter = num(auto.caps && auto.caps.perIterBudget);
	if (!perIter || perIter <= 0) errors.push("Set a per-iteration budget");

	const caps = auto.caps || {};
	const hasCap = num(caps.maxIterations) > 0 || num(caps.wallClockHours) > 0 || num(caps.costUsd) > 0;
	const stops = auto.stops || {};
	const hasStop = num(stops.plateauK) > 0 || stops.target !== "" && Number.isFinite(num(stops.target));

	if (!hasCap) checklist.push("Set at least one hard cap (max-iterations, wall-clock, or cost)");
	if (!hasStop) checklist.push("Set at least one stop condition (plateau-K or target)");
	if (!d.confirmAck) checklist.push("Acknowledge the autonomous-run warning");

	const maxIter = num(caps.maxIterations);
	const costCap = num(caps.costUsd);
	let estCostMax;
	if (perIter && maxIter) estCostMax = maxIter * perIter;
	if (costCap != null) estCostMax = estCostMax == null ? costCap : Math.min(estCostMax, costCap);

	const valid = errors.length === 0 && checklist.length === 0;
	return { valid, errors, checklist, estCostMax, hasCap, hasStop };
}

function projectionFor(d) {
	return d.mode === "autoresearch" ? validateAuto(d) : validateAB(d);
}

// ── Definition serialization (the CANONICAL shape the routes consume — mirrors
//    lib/store-keys.mjs JSDoc / src/shared/experiment-report/types.ts). ────────────────
function buildDefinition(d) {
	const basics = d.basics || {};
	// MetricSelection[]: { metricId, aggregation?, directionOverride? } (+ ui-only
	// hints the backend ignores). The draft uses `metric` internally; emit metricId.
	// The canonical `directionOverride` is 'max'|'min' (aggregate.ts::metricDirection
	// reads it for winner selection). The draft carries a display value
	// (higher-better|lower-better|neutral); map it and only emit an override for a
	// non-neutral choice so the user's direction reaches winner selection.
	const DIR_TO_CANONICAL = { "higher-better": "max", "lower-better": "min" };
	const metrics = arrayOf(d.metrics).filter((m) => m.collect).map((m) => {
		const sel = { metricId: m.metric, aggregation: m.aggregation, primary: !!m.primary };
		const directionOverride = DIR_TO_CANONICAL[m.direction];
		if (directionOverride) sel.directionOverride = directionOverride;
		return sel;
	});
	// RunnableSpec: a command unit → kind 'command' (body → command); otherwise the
	// agent/goal-spec unit → kind 'agent' (body → spec). Never `body` / kind 'goal'.
	const isCommand = basics.runnableUnit === "command";
	const runnable = isCommand
		? { kind: "command", command: asText(basics.body) }
		: { kind: "agent", spec: asText(basics.body) };
	const def = {
		experimentId: d.experimentId,
		title: asText(basics.name).trim(),
		mode: d.mode === "autoresearch" ? "autoresearch" : "ab",
		runnable,
		workflowId: asText(basics.workflowId).trim() || undefined,
		metrics,
	};
	if (def.mode === "ab") {
		const ab = d.ab || {};
		def.variants = arrayOf(ab.variants).map((v, i) => ({
			armId: safeId(asText(v.label).trim() || `arm-${i}`),
			label: asText(v.label).trim() || `arm-${i}`,
			metadata: rowsToObject(v.metadata),
			inlineRoles: parseRolesJson(v.rolesJson),
		}));
		def.repeats = num(ab.repeats) || 1;
		def.sameCompletionBar = ab.sameCompletionBar !== false;
		def.maxConcurrency = num(ab.concurrency) || 3;
		def.perRunBudget = num(d.perRunBudget);
	} else {
		const auto = d.auto || {};
		// ObjectiveSpec: { metricId, direction: 'max'|'min' }.
		def.objective = { metricId: auto.objectiveMetric, direction: auto.direction === "minimize" ? "min" : "max" };
		def.correctnessGateId = asText(auto.correctnessGateId).trim() || undefined;
		def.seed = { metadata: rowsToObject(auto.seed), inlineRoles: parseRolesJson(auto.seedRolesJson) };
		// AutoresearchCaps: { maxIterations?, maxWallClockMs?, maxCostUsd? }. perRunBudget
		// is a SEPARATE top-level field, never nested in caps; no `wallClockMs` key.
		const wallClockHours = num(auto.caps && auto.caps.wallClockHours);
		def.caps = {
			maxIterations: num(auto.caps && auto.caps.maxIterations),
			maxWallClockMs: wallClockHours ? wallClockHours * 3_600_000 : undefined,
			maxCostUsd: num(auto.caps && auto.caps.costUsd),
		};
		// StopSpec: only include `target` when the user gave a finite number — coercing
		// a blank to 0 would falsely satisfy the stop-condition guard.
		const target = num(auto.stops && auto.stops.target);
		def.stop = { plateauK: num(auto.stops && auto.stops.plateauK) };
		if (target != null) def.stop.target = target;
		def.strategy = auto.strategy === "best-of-batch" ? "best-of-batch" : "greedy";
		def.batchSize = num(auto.batchSize);
		def.perRunBudget = num(auto.caps && auto.caps.perIterBudget);
	}
	return def;
}

export default function createPanel({ html, nothing, renderHeader }) {
	void renderHeader;

	// ── host wrappers (all best-effort / graceful) ──
	const callRoute = async (host, name, init) => {
		try {
			if (!host || !host.capabilities || !host.capabilities.callRoute || !host.callRoute) {
				return { ok: false, error: "routes-unavailable" };
			}
			const data = await host.callRoute(name, init);
			// A route that resolves with an { error } envelope is a FAILURE, not a
			// success — callers branch on res.ok, so surface it as ok:false. This stops
			// doLaunch from mirroring a rejected def to the store or navigating onward.
			if (data && typeof data === "object" && data.error) return { ok: false, error: data.error };
			return { ok: true, data };
		} catch (err) {
			return { ok: false, error: err && err.message ? String(err.message) : String(err) };
		}
	};
	const storeGet = async (host, key) => {
		try { return host && host.store && host.store.get ? await host.store.get(key) : null; }
		catch { return null; }
	};
	const storePut = async (host, key, value) => {
		try { if (host && host.store && host.store.put) await host.store.put(key, value); }
		catch { /* best-effort */ }
	};
	const storeList = async (host, prefix) => {
		try { return host && host.store && host.store.list ? (await host.store.list(prefix)) || [] : []; }
		catch { return []; }
	};

	const repaint = (host) => { try { host && host.requestRender && host.requestRender(); } catch { /* non-DOM */ } };

	const navigate = (host, params) => {
		try {
			if (host && host.capabilities && host.capabilities.ui && host.ui && host.ui.navigate) {
				host.ui.navigate({ route: "experiment-runner", params });
			}
		} catch { /* best-effort */ }
	};

	const localKey = (instanceKey) => `${LOCAL_DRAFT_PREFIX}${safeId(instanceKey)}`;
	const readLocalDraft = (instanceKey) => {
		try { const raw = globalThis.localStorage && globalThis.localStorage.getItem(localKey(instanceKey)); return raw ? JSON.parse(raw) : undefined; }
		catch { return undefined; }
	};
	const writeLocalDraft = (instanceKey, draft) => {
		try { globalThis.localStorage && globalThis.localStorage.setItem(localKey(instanceKey), JSON.stringify(draft)); }
		catch { /* unavailable/full */ }
	};

	const getEntry = (instanceKey) => byInstance.get(instanceKey);
	const setEntry = (host, instanceKey, entry) => { byInstance.set(instanceKey, entry); repaint(host); };
	const patch = (host, instanceKey, p) => {
		const cur = byInstance.get(instanceKey) || {};
		const next = { ...cur, ...p };
		byInstance.set(instanceKey, next);
		repaint(host);
		return next;
	};
	const patchDraft = (host, instanceKey, mutate) => {
		const cur = byInstance.get(instanceKey) || {};
		const draft = { ...(cur.draft || defaultDraft()) };
		mutate(draft);
		const next = { ...cur, draft };
		byInstance.set(instanceKey, next);
		// Autosave the draft (debounced via microtask coalescing through store).
		writeLocalDraft(instanceKey, draft);
		void storePut(cur.host, K.draft(instanceKey), draft);
		repaint(host);
	};

	// ── Hydration: kick off ONCE per instance (render stays pure). ──
	function ensureHydrated(host, instanceKey, focusExperimentId, focusView) {
		let entry = byInstance.get(instanceKey);
		if (entry && entry.hydrated) {
			entry.host = host;
			// A deep-link arriving after first mount still focuses its experiment.
			if (focusExperimentId && entry.draft && entry.draft.experimentId !== focusExperimentId) {
				void openExperiment(host, instanceKey, focusExperimentId, focusView);
			}
			return entry;
		}
		entry = { hydrated: false, host, draft: readLocalDraft(instanceKey) || defaultDraft(), dashboard: null, experiments: [] };
		byInstance.set(instanceKey, entry);
		(async () => {
			// Restore a persisted draft from the store (authoritative over local).
			const storedDraft = await storeGet(host, K.draft(instanceKey));
			const cur = byInstance.get(instanceKey) || entry;
			let draft = (storedDraft && typeof storedDraft === "object") ? storedDraft : cur.draft;
			// A deep-link experimentId always wins → land on the dashboard.
			if (focusExperimentId) {
				draft = { ...draft, experimentId: focusExperimentId, view: focusView || "dashboard" };
			}
			byInstance.set(instanceKey, { ...cur, hydrated: true, draft });
			repaint(host);
			void refreshExperimentIndex(host, instanceKey);
			if (draft.experimentId && draft.view === "dashboard") {
				void loadDashboard(host, instanceKey, draft.experimentId);
			}
		})();
		return byInstance.get(instanceKey);
	}

	// listExperiments returns an ARRAY of ExperimentDef objects; the store INDEX_KEY
	// is an ARRAY of experimentId strings. Derive the panel's display rows from
	// whichever is available — never the legacy `{ experiments: [...] }` object.
	const defToRow = (def) => ({ experimentId: def.experimentId, title: asText(def.title, def.experimentId), mode: def.mode === "autoresearch" ? "autoresearch" : "ab" });
	async function refreshExperimentIndex(host, instanceKey) {
		const res = await callRoute(host, "listExperiments", { method: "GET" });
		let experiments = [];
		if (res.ok && Array.isArray(res.data)) {
			experiments = res.data.filter((d) => d && typeof d === "object").map(defToRow);
		} else {
			// Offline store fallback: read the id array and load each def.
			const ids = arrayOf(await storeGet(host, K.index)).filter((id) => typeof id === "string");
			const defs = await Promise.all(ids.map((id) => storeGet(host, K.exp(id))));
			experiments = defs.filter((d) => d && typeof d === "object").map(defToRow);
		}
		patch(host, instanceKey, { experiments });
	}

	async function openExperiment(host, instanceKey, experimentId, view) {
		patchDraft(host, instanceKey, (d) => { d.experimentId = experimentId; d.view = view || "dashboard"; });
		await loadDashboard(host, instanceKey, experimentId);
	}

	// ── Dashboard data load (route-first, store-fallback). ──
	async function loadDashboard(host, instanceKey, experimentId) {
		patch(host, instanceKey, { dashboardLoading: true });
		let def, state, runs = [], ledger = [], dashboardSpec, metrics;

		const got = await callRoute(host, "getExperiment", { method: "GET", query: { experimentId } });
		if (got.ok && got.data && got.data.def) {
			def = got.data.def; state = got.data.state;
			runs = arrayOf(got.data.runs); ledger = arrayOf(got.data.ledger);
			dashboardSpec = got.data.dashboard; metrics = got.data.metrics;
		}
		if (!def) {
			def = await storeGet(host, K.exp(experimentId));
			state = await storeGet(host, K.state(experimentId));
			ledger = arrayOf(await storeGet(host, K.ledger(experimentId)));
			dashboardSpec = await storeGet(host, K.dashboard(experimentId));
			metrics = await storeGet(host, K.metrics(experimentId));
			const keys = await storeList(host, K.runPrefix(experimentId));
			for (const key of keys) {
				const r = await storeGet(host, key);
				if (r && typeof r === "object") runs.push(r);
			}
		}

		// The editable dashboard spec + metric selection persist in the store; pull
		// them in whenever the route didn't already supply them (so a saved spec edit
		// re-renders without a re-run regardless of getExperiment's payload).
		if (dashboardSpec == null) dashboardSpec = await storeGet(host, K.dashboard(experimentId));
		if (!arrayOf(metrics).length) {
			const storedMetrics = await storeGet(host, K.metrics(experimentId));
			if (arrayOf(storedMetrics).length) metrics = storedMetrics;
		}

		// Poll live runs if the experiment is still running (after a user gesture only).
		// `poll` only moves runs to `settled` + stores cost; metric extraction,
		// rawOutcome, completionBar, and verified are written ONLY by `collect`. So
		// follow the poll with a `collect` (idempotent — it only touches `settled`
		// runs, best-effort) BEFORE `report`, otherwise live A/B aggregates are empty.
		// Autoresearch is an autonomous LOOP: `iterate` collects the settled candidate,
		// makes the deterministic accept/reject decision, and spawns the NEXT candidate
		// (or records the deterministic stop). Driving poll+collect here would collect
		// the candidate but never advance the loop. A/B keeps the poll(+collect) path —
		// `poll` only settles + stores cost, so collect must follow to extract metrics.
		const hasSettled = (rs) => arrayOf(rs).some((r) => r && r.status === "settled");
		if (state && state.status === "running") {
			if (def && def.mode === "autoresearch") {
				// Best-effort, idempotent: one loop step per dashboard load.
				const iterated = await callRoute(host, "iterate", { method: "POST", body: { experimentId } });
				if (iterated.ok && iterated.data && Array.isArray(iterated.data.ledger)) ledger = iterated.data.ledger;
				// Re-read runs/state so the dashboard reflects the spawn/stop just made.
				const refreshed = await callRoute(host, "getExperiment", { method: "GET", query: { experimentId } });
				if (refreshed.ok && refreshed.data && refreshed.data.def) {
					state = refreshed.data.state;
					runs = arrayOf(refreshed.data.runs);
					if (arrayOf(refreshed.data.ledger).length) ledger = refreshed.data.ledger;
				}
			} else {
				const polled = await callRoute(host, "poll", { method: "POST", body: { experimentId } });
				if (polled.ok && polled.data && Array.isArray(polled.data.runs)) runs = polled.data.runs;
				if (hasSettled(runs)) {
					const collected = await callRoute(host, "collect", { method: "POST", body: { experimentId } });
					if (collected.ok && collected.data && Array.isArray(collected.data.runs)) runs = collected.data.runs;
				}
				// Concurrency top-up: `launch` is idempotent + capacity-aware, so re-invoking
				// it after poll/collect spawns the NEXT batch of still-pending runs as in-flight
				// ones settle/collect — honoring def.maxConcurrency (the batching the launch route
				// enforces). Without this the parked-pending runs would never start.
				if (arrayOf(runs).some((r) => r && r.status === "pending")) {
					const topUp = await callRoute(host, "launch", { method: "POST", body: { experimentId } });
					if (topUp.ok && topUp.data && Array.isArray(topUp.data.launched)) runs = topUp.data.launched;
				}
			}
		}

		// Render model from the shared reporting lib when the route is available.
		const reported = await callRoute(host, "report", { method: "POST", body: { experimentId } });
		const report = reported.ok && reported.data ? reported.data : null;

		patch(host, instanceKey, {
			dashboardLoading: false,
			dashboard: {
				experimentId, def, state, runs, ledger,
				spec: dashboardSpec, metrics: arrayOf(metrics).length ? metrics : (def && def.metrics) || [],
				report,
			},
		});
	}

	// ── Mutations ──
	async function doLaunch(host, instanceKey) {
		const entry = byInstance.get(instanceKey);
		const d = entry.draft;
		patch(host, instanceKey, { launching: true, launchError: undefined });
		const definition = buildDefinition(d);

		// Persist the definition (route-first, then store mirror for resilience).
		// defineExperiment reads req.body DIRECTLY (the def object IS the body).
		const defined = await callRoute(host, "defineExperiment", { method: "POST", body: definition });
		// A real route rejection (e.g. PER_RUN_BUDGET_REQUIRED / OBJECTIVE_REQUIRED) must
		// NOT mirror a bad def to the store or navigate to the dashboard. routes-unavailable
		// is the offline fallback that still persists via the store mirror below.
		if (!defined.ok && defined.error !== "routes-unavailable") {
			patch(host, instanceKey, { launching: false, launchError: defined.error });
			return;
		}
		let experimentId = d.experimentId;
		if (defined.ok && defined.data && defined.data.experimentId) experimentId = defined.data.experimentId;
		if (!experimentId) experimentId = `${safeId(definition.title)}-${Date.now().toString(36)}`;
		definition.experimentId = experimentId;
		// When the route SUCCEEDED, defineExperiment already persisted the SERVER-
		// normalized def — the ONLY copy carrying `createdAt`, which `iterate` uses to
		// compute elapsedMs for the wall-clock cap. Overwriting exp/<id> with the client
		// definition would erase createdAt and silently defeat a wall-clock-only cap
		// (elapsedMs stays ~0 forever → the validated run becomes effectively uncapped).
		// So mirror to the store ONLY as the offline fallback (route unavailable/errored).
		if (!defined.ok) {
			await storePut(host, K.exp(experimentId), definition);
			await storePut(host, K.metrics(experimentId), definition.metrics);
		}
		await appendIndex(host, instanceKey, { experimentId, title: definition.title, mode: definition.mode, status: "running" });

		// Branch on mode: the `launch` route is A/B-only (it returns LAUNCH_AB_ONLY
		// for autoresearch). For autoresearch, skip `launch` and call `iterate` to
		// spawn the FIRST candidate. Either backend `{error}` (other than the
		// offline routes-unavailable fallback) sets launchError and does NOT
		// navigate. Only one kick-off call fires per mode (no double iterate).
		const launchRoute = definition.mode === "autoresearch" ? "iterate" : "launch";
		const launched = await callRoute(host, launchRoute, { method: "POST", body: { experimentId } });
		if (!launched.ok && launched.error !== "routes-unavailable") {
			patch(host, instanceKey, { launching: false, launchError: launched.error });
			return;
		}
		patchDraft(host, instanceKey, (dd) => { dd.experimentId = experimentId; dd.view = "dashboard"; });
		patch(host, instanceKey, { launching: false });
		navigate(host, { experimentId, view: "dashboard" });
		await loadDashboard(host, instanceKey, experimentId);
	}

	async function appendIndex(host, instanceKey, row) {
		// INDEX_KEY store value is an ARRAY of experimentId strings (canonical). Never
		// overwrite it with an object — that corrupts the route-backed listing.
		const ids = arrayOf(await storeGet(host, K.index)).filter((id) => typeof id === "string" && id !== row.experimentId);
		ids.push(row.experimentId);
		await storePut(host, K.index, ids);
		// The panel's in-memory display list is derived rows (deduped by id).
		const cur = byInstance.get(instanceKey) || {};
		const experiments = arrayOf(cur.experiments).filter((e) => e.experimentId !== row.experimentId);
		experiments.push(row);
		patch(host, instanceKey, { experiments });
	}

	async function doCancel(host, instanceKey, experimentId) {
		await callRoute(host, "cancel", { method: "POST", body: { experimentId } });
		await loadDashboard(host, instanceKey, experimentId);
	}

	async function saveMetricsSelection(host, instanceKey, experimentId, metrics) {
		await callRoute(host, "saveMetrics", { method: "POST", body: { experimentId, metrics } });
		await storePut(host, K.metrics(experimentId), metrics);
		await loadDashboard(host, instanceKey, experimentId);
	}

	async function saveDashboardSpec(host, instanceKey, experimentId, spec) {
		// The store + saveDashboard route both speak the canonical { widgets: [...] }
		// DashboardSpec shape (resolveDashboard only honours stored.widgets); the
		// editor works with a bare widget array, so normalise here so an edited spec
		// survives the report-route path and re-renders without a re-run.
		const dashboard = Array.isArray(spec) ? { widgets: spec } : (spec && Array.isArray(spec.widgets) ? spec : { widgets: [] });
		await callRoute(host, "saveDashboard", { method: "POST", body: { experimentId, dashboard } });
		await storePut(host, K.dashboard(experimentId), dashboard);
		patch(host, instanceKey, { dashboardEditing: false });
		await loadDashboard(host, instanceKey, experimentId);
	}

	// ════════════════════════════════════════════════════════════════════════
	// Views
	// ════════════════════════════════════════════════════════════════════════
	const setView = (host, instanceKey, view) => patchDraft(host, instanceKey, (d) => { d.view = view; });

	function renderModeSelect(host, instanceKey, d) {
		const pick = (mode) => patchDraft(host, instanceKey, (dd) => { dd.mode = mode; dd.view = "define"; });
		return html`
			<div class="exp-view" data-testid="experiment-runner-view-mode-select">
				<h1 class="exp-h1">New experiment</h1>
				<p class="exp-sub">Pick how you want to run it. A/B is the safe, bounded default; Autoresearch is an opt-in autonomous loop.</p>
				<div class="exp-mode-grid">
					<button
						class="exp-mode-card recommended"
						data-testid="experiment-runner-mode-ab"
						type="button"
						autofocus
						@click=${() => pick("ab")}
					>
						<span class="exp-eyebrow">Recommended · bounded cost</span>
						<span class="exp-mode-title">A/B comparison</span>
						<span class="exp-mode-desc">Run a fixed set of variants × repeats, aggregate, and compare. Cost is projected before launch.</span>
					</button>
					<button
						class="exp-mode-card danger"
						data-testid="experiment-runner-mode-autoresearch"
						type="button"
						@click=${() => pick("autoresearch")}
					>
						<span class="exp-eyebrow warn">Autonomous · opt-in · hard caps required</span>
						<span class="exp-mode-title">Autoresearch</span>
						<span class="exp-mode-desc">Propose → evaluate → keep-best loop. Runs unattended until a cap or stop condition fires. Off by default.</span>
					</button>
				</div>
			</div>
		`;
	}

	// ── shared "basics" block ──
	function renderBasics(host, instanceKey, d) {
		const b = d.basics || {};
		const set = (k, v) => patchDraft(host, instanceKey, (dd) => { dd.basics = { ...dd.basics, [k]: v }; });
		return html`
			<section class="exp-card" data-testid="experiment-runner-basics">
				<h2 class="exp-h2">Experiment basics</h2>
				<label class="exp-label">Experiment name
					<input class="exp-input" data-testid="experiment-runner-name" type="text" maxlength="80"
						placeholder="e.g. retry-temperature-sweep" .value=${asText(b.name)}
						@input=${(e) => set("name", e.currentTarget.value)} />
				</label>
				<div class="exp-label">Runnable unit
					<div class="exp-radio-row" role="radiogroup" aria-label="Runnable unit">
						<label class="exp-radio"><input type="radio" name="exp-runnable-${safeId(instanceKey)}" data-testid="experiment-runner-runnable-goal"
							?checked=${b.runnableUnit === "goal"} @change=${() => set("runnableUnit", "goal")} /> Goal spec</label>
						<label class="exp-radio"><input type="radio" name="exp-runnable-${safeId(instanceKey)}" data-testid="experiment-runner-runnable-command"
							?checked=${b.runnableUnit !== "goal"} @change=${() => set("runnableUnit", "command")} /> Command</label>
					</div>
				</div>
				<label class="exp-label">${b.runnableUnit === "goal" ? "Goal spec" : "Command"} body
					<textarea class="exp-input exp-mono" data-testid="experiment-runner-body" rows="4"
						placeholder=${b.runnableUnit === "goal" ? "A goal spec template…" : "A shell command emitting { \"metric\": <name>, \"value\": <n> } on stdout…"}
						.value=${asText(b.body)} @input=${(e) => set("body", e.currentTarget.value)}></textarea>
				</label>
				<label class="exp-label">Workflow (optional)
					<input class="exp-input" data-testid="experiment-runner-workflow" type="text"
						placeholder="workflow id (optional)" .value=${asText(b.workflowId)}
						@input=${(e) => set("workflowId", e.currentTarget.value)} />
				</label>
			</section>
		`;
	}

	// ── treatment (key/value) editor ──
	// `mutate(updater)` applies updater(currentRows) against the LIVE draft. Cell
	// edits MUST NOT rebuild from the render-closure `rows` snapshot: the editor
	// re-renders asynchronously while patchDraft updates the draft synchronously, so
	// editing a row's key then its value before a repaint would otherwise drop the
	// first edit (an empty key is dropped by rowsToObject, leaving variants "identical").
	function renderTreatmentEditor(host, instanceKey, rows, mutate, testid) {
		const nonEmpty = (next) => (next.length ? next : emptyTreatmentRows());
		const setCell = (i, field, value) => mutate((cur) => { const next = cur.slice(); next[i] = { ...next[i], [field]: value }; return next; });
		const removeRow = (i) => mutate((cur) => { const next = cur.slice(); next.splice(i, 1); return nonEmpty(next); });
		const addRow = () => mutate((cur) => [...cur, { key: "", value: "" }]);
		return html`
			<div class="exp-kv" data-testid=${testid}>
				${arrayOf(rows).map((row, i) => html`
					<div class="exp-kv-row">
						<input class="exp-input exp-kv-key" type="text" placeholder="key" .value=${asText(row.key)}
							@input=${(e) => setCell(i, "key", e.currentTarget.value)} />
						<input class="exp-input exp-kv-val" type="text" placeholder="value" .value=${asText(row.value)}
							@input=${(e) => setCell(i, "value", e.currentTarget.value)} />
						<button class="exp-icon-btn" type="button" title="Remove" aria-label="Remove key"
							@click=${() => removeRow(i)}>✕</button>
					</div>`)}
				<button class="exp-btn secondary tiny" type="button" @click=${addRow}>+ Add key</button>
			</div>
		`;
	}

	// ── metrics editor (shared) ──
	function renderMetricsEditor(host, instanceKey, d) {
		const metrics = arrayOf(d.metrics);
		const setMetric = (i, p) => patchDraft(host, instanceKey, (dd) => {
			const next = arrayOf(dd.metrics).slice();
			if (p.primary) next.forEach((m, j) => { next[j] = { ...m, primary: j === i }; });
			next[i] = { ...next[i], ...p };
			dd.metrics = next;
		});
		return html`
			<section class="exp-card" data-testid="experiment-runner-metrics">
				<h2 class="exp-h2">Metrics</h2>
				<p class="exp-hint">What to collect for every run — editable later without a re-run.</p>
				<table class="exp-table">
					<thead><tr><th>Collect</th><th>Metric</th><th>Aggregation</th><th>Direction</th><th>Primary</th></tr></thead>
					<tbody>
						${metrics.map((m, i) => html`<tr data-testid="experiment-runner-metric-row" data-metric=${m.metric}>
							<td><input type="checkbox" data-testid="experiment-runner-metric-collect" data-metric=${m.metric}
								?checked=${!!m.collect} @change=${(e) => setMetric(i, { collect: e.currentTarget.checked })} /></td>
							<td><span class="exp-mono">${m.metric}</span> <span class="exp-badge">${m.source || "built-in"}</span></td>
							<td><select class="exp-input" ?disabled=${!m.collect} @change=${(e) => setMetric(i, { aggregation: e.currentTarget.value })}>
								${AGGREGATIONS.map((a) => html`<option value=${a} ?selected=${m.aggregation === a}>${a}</option>`)}
							</select></td>
							<td><select class="exp-input" ?disabled=${!m.collect} @change=${(e) => setMetric(i, { direction: e.currentTarget.value })}>
								${["higher-better", "lower-better", "neutral"].map((dir) => html`<option value=${dir} ?selected=${m.direction === dir}>${dir}</option>`)}
							</select></td>
							<td><input type="radio" name="exp-primary-${safeId(instanceKey)}" data-testid="experiment-runner-metric-primary" data-metric=${m.metric}
								?checked=${!!m.primary} ?disabled=${!m.collect} @change=${() => setMetric(i, { primary: true })} /></td>
						</tr>`)}
					</tbody>
				</table>
			</section>
		`;
	}

	// ── A/B variants block ──
	function renderABForm(host, instanceKey, d) {
		const ab = d.ab || {};
		const variants = arrayOf(ab.variants);
		const setAb = (p) => patchDraft(host, instanceKey, (dd) => { dd.ab = { ...dd.ab, ...p }; });
		const setVariant = (i, p) => patchDraft(host, instanceKey, (dd) => {
			const next = arrayOf(dd.ab.variants).slice(); next[i] = { ...next[i], ...p }; dd.ab = { ...dd.ab, variants: next };
		});
		const removeVariant = (i) => patchDraft(host, instanceKey, (dd) => {
			const next = arrayOf(dd.ab.variants).slice(); next.splice(i, 1); dd.ab = { ...dd.ab, variants: next };
		});
		const addVariant = (clone) => patchDraft(host, instanceKey, (dd) => {
			const next = arrayOf(dd.ab.variants).slice();
			const base = clone != null ? next[clone] : null;
			next.push({
				label: `variant-${next.length + 1}`,
				metadata: base ? base.metadata.map((r) => ({ ...r })) : emptyTreatmentRows(),
				rolesJson: base ? base.rolesJson : "",
				rolesOpen: false,
			});
			dd.ab = { ...dd.ab, variants: next };
		});
		const repeats = num(ab.repeats);
		return html`
			<section class="exp-card" data-testid="experiment-runner-ab-form">
				<h2 class="exp-h2">Variants</h2>
				${variants.map((v, i) => html`
					<div class="exp-variant" data-testid="experiment-runner-variant-row" data-variant-index=${i}>
						<div class="exp-variant-head">
							<input class="exp-input" type="text" data-testid="experiment-runner-variant-label" placeholder="variant label"
								.value=${asText(v.label)} @input=${(e) => setVariant(i, { label: e.currentTarget.value })} />
							<button class="exp-btn secondary tiny" type="button" @click=${() => addVariant(i)}>Duplicate</button>
							<button class="exp-btn secondary tiny" type="button" data-testid="experiment-runner-remove-variant"
								?disabled=${variants.length <= 2}
								title=${variants.length <= 2 ? "A/B needs at least two variants" : "Remove variant"}
								@click=${() => removeVariant(i)}>Remove</button>
						</div>
						<div class="exp-field-label">Metadata treatment</div>
						${renderTreatmentEditor(host, instanceKey, v.metadata, (updater) => patchDraft(host, instanceKey, (dd) => {
							const next = arrayOf(dd.ab && dd.ab.variants).slice();
							const cur = arrayOf(next[i] && next[i].metadata).slice();
							next[i] = { ...next[i], metadata: updater(cur) };
							dd.ab = { ...dd.ab, variants: next };
						}), "experiment-runner-variant-metadata")}
						<details class="exp-details" ?open=${v.rolesOpen}>
							<summary @click=${() => setVariant(i, { rolesOpen: !v.rolesOpen })}>Advanced: per-arm roles</summary>
							<textarea class="exp-input exp-mono" rows="3" placeholder='{"coder": {"model": "…"}}'
								.value=${asText(v.rolesJson)} @input=${(e) => setVariant(i, { rolesJson: e.currentTarget.value })}></textarea>
						</details>
					</div>`)}
				<button class="exp-btn secondary" type="button" data-testid="experiment-runner-add-variant" @click=${() => addVariant(null)}>+ Add variant</button>

				<div class="exp-grid2">
					<label class="exp-label">Repeats per variant
						<input class="exp-input" type="number" min="1" max="20" data-testid="experiment-runner-repeats"
							.value=${asText(ab.repeats)} @input=${(e) => setAb({ repeats: e.currentTarget.value })} />
						${repeats > 10 ? html`<span class="exp-warn-hint">high run count</span>` : nothing}
					</label>
					<label class="exp-label">Concurrency cap
						<input class="exp-input" type="number" min="1" max="8" data-testid="experiment-runner-concurrency"
							.value=${asText(ab.concurrency)} @input=${(e) => setAb({ concurrency: e.currentTarget.value })} />
					</label>
				</div>
				<label class="exp-checkbox"><input type="checkbox" data-testid="experiment-runner-same-bar"
					?checked=${ab.sameCompletionBar !== false} @change=${(e) => setAb({ sameCompletionBar: e.currentTarget.checked })} />
					Only aggregate runs that reached the same completion bar</label>
				<label class="exp-label">Per-run budget (USD, the fixed comparable budget)
					<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-per-run-budget"
						placeholder="e.g. 0.80" .value=${asText(d.perRunBudget)}
						@input=${(e) => patchDraft(host, instanceKey, (dd) => { dd.perRunBudget = e.currentTarget.value; })} />
				</label>
			</section>
		`;
	}

	// ── Autoresearch form ──
	function renderAutoForm(host, instanceKey, d) {
		const auto = d.auto || {};
		const setAuto = (p) => patchDraft(host, instanceKey, (dd) => { dd.auto = { ...dd.auto, ...p }; });
		const setCaps = (p) => patchDraft(host, instanceKey, (dd) => { dd.auto = { ...dd.auto, caps: { ...dd.auto.caps, ...p } }; });
		const setStops = (p) => patchDraft(host, instanceKey, (dd) => { dd.auto = { ...dd.auto, stops: { ...dd.auto.stops, ...p } }; });
		const metricOptions = arrayOf(d.metrics).map((m) => m.metric);
		return html`
			<div class="exp-warn-banner" data-testid="experiment-runner-autoresearch-banner">
				Autonomous optimization — runs unattended until a cap or stop condition is hit. Candidates failing verification are rejected even if the objective improves.
			</div>
			<section class="exp-card" data-testid="experiment-runner-auto-objective">
				<h2 class="exp-h2">Objective</h2>
				<div class="exp-grid2">
					<label class="exp-label">Objective metric
						<select class="exp-input" data-testid="experiment-runner-objective-metric" @change=${(e) => setAuto({ objectiveMetric: e.currentTarget.value })}>
							${metricOptions.map((m) => html`<option value=${m} ?selected=${auto.objectiveMetric === m}>${m}</option>`)}
						</select>
					</label>
					<div class="exp-label">Direction
						<div class="exp-radio-row" role="radiogroup" aria-label="Objective direction">
							<label class="exp-radio"><input type="radio" name="exp-dir-${safeId(instanceKey)}" data-testid="experiment-runner-direction-maximize"
								?checked=${auto.direction !== "minimize"} @change=${() => setAuto({ direction: "maximize" })} /> maximize</label>
							<label class="exp-radio"><input type="radio" name="exp-dir-${safeId(instanceKey)}" data-testid="experiment-runner-direction-minimize"
								?checked=${auto.direction === "minimize"} @change=${() => setAuto({ direction: "minimize" })} /> minimize</label>
						</div>
					</div>
				</div>
				<label class="exp-label">Correctness gate (optional workflow gate)
					<input class="exp-input" type="text" data-testid="experiment-runner-correctness-gate" placeholder="review-findings gate id (optional)"
						.value=${asText(auto.correctnessGateId)} @input=${(e) => setAuto({ correctnessGateId: e.currentTarget.value })} />
					<span class="exp-hint">Candidates failing verification are rejected even if the objective improves.</span>
				</label>
				<div class="exp-field-label">Search seed (iteration-0 candidate)</div>
				${renderTreatmentEditor(host, instanceKey, auto.seed, (updater) => patchDraft(host, instanceKey, (dd) => {
					dd.auto = { ...dd.auto, seed: updater(arrayOf(dd.auto && dd.auto.seed).slice()) };
				}), "experiment-runner-seed-metadata")}
			</section>

			<section class="exp-card" data-testid="experiment-runner-auto-caps">
				<h2 class="exp-h2">Caps <span class="exp-req">— at least one required</span></h2>
				<div class="exp-grid2">
					<label class="exp-label">Max iterations
						<input class="exp-input" type="number" min="1" data-testid="experiment-runner-cap-max-iterations"
							.value=${asText(auto.caps.maxIterations)} @input=${(e) => setCaps({ maxIterations: e.currentTarget.value })} />
					</label>
					<label class="exp-label">Wall-clock cap (hours)
						<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-cap-wallclock"
							.value=${asText(auto.caps.wallClockHours)} @input=${(e) => setCaps({ wallClockHours: e.currentTarget.value })} />
					</label>
					<label class="exp-label">Cost cap (USD)
						<input class="exp-input" type="number" min="0" step="1" data-testid="experiment-runner-cap-cost"
							.value=${asText(auto.caps.costUsd)} @input=${(e) => setCaps({ costUsd: e.currentTarget.value })} />
					</label>
					<label class="exp-label">Per-iteration budget (USD, required)
						<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-per-iter-budget"
							.value=${asText(auto.caps.perIterBudget)} @input=${(e) => setCaps({ perIterBudget: e.currentTarget.value })} />
					</label>
				</div>
			</section>

			<section class="exp-card" data-testid="experiment-runner-auto-stops">
				<h2 class="exp-h2">Stop conditions <span class="exp-req">— at least one required</span></h2>
				<div class="exp-grid2">
					<label class="exp-label">Plateau over K iterations
						<input class="exp-input" type="number" min="1" data-testid="experiment-runner-stop-plateau"
							.value=${asText(auto.stops.plateauK)} @input=${(e) => setStops({ plateauK: e.currentTarget.value })} />
					</label>
					<label class="exp-label">Target value
						<input class="exp-input" type="number" step="any" data-testid="experiment-runner-stop-target"
							.value=${asText(auto.stops.target)} @input=${(e) => setStops({ target: e.currentTarget.value })} />
					</label>
				</div>
				<details class="exp-details">
					<summary>Advanced: search strategy</summary>
					<div class="exp-grid2">
						<label class="exp-label">Strategy
							<select class="exp-input" @change=${(e) => setAuto({ strategy: e.currentTarget.value })}>
								<option value="greedy" ?selected=${auto.strategy !== "best-of-batch"}>greedy</option>
								<option value="best-of-batch" ?selected=${auto.strategy === "best-of-batch"}>best-of-batch</option>
							</select>
						</label>
						<label class="exp-label">Batch size
							<input class="exp-input" type="number" min="1" max="8" .value=${asText(auto.batchSize)}
								@input=${(e) => setAuto({ batchSize: e.currentTarget.value })} />
						</label>
					</div>
				</details>
			</section>
		`;
	}

	// ── projection strip (sticky footer) ──
	function renderProjection(host, instanceKey, d, proj) {
		if (d.mode === "autoresearch") {
			const checklist = arrayOf(proj.checklist);
			return html`
				<footer class="exp-projection" data-testid="experiment-runner-projection">
					<div class="exp-proj-stats">
						<span data-testid="experiment-runner-cost">${proj.estCostMax != null ? `≤ ${usd(proj.estCostMax)}` : "cost unbounded by iterations"}</span>
						${proj.hasStop ? html`<span class="exp-pos">stop set</span>` : nothing}
					</div>
					${checklist.length ? html`<ul class="exp-checklist" data-testid="experiment-runner-guardrail-checklist">
						${checklist.map((c) => html`<li class="exp-neg">✗ ${c}</li>`)}
					</ul>` : nothing}
					${arrayOf(proj.errors).length ? html`<ul class="exp-checklist" data-testid="experiment-runner-error">
						${proj.errors.map((e) => html`<li class="exp-neg">✗ ${e}</li>`)}
					</ul>` : nothing}
					<label class="exp-checkbox danger"><input type="checkbox" data-testid="experiment-runner-confirm-ack"
						?checked=${!!d.confirmAck} @change=${(e) => patchDraft(host, instanceKey, (dd) => { dd.confirmAck = e.currentTarget.checked; })} />
						I understand this runs autonomously and may cost ${proj.estCostMax != null ? `up to ${usd(proj.estCostMax)}` : "an unbounded amount until a cap is hit"}.</label>
					<button class="exp-btn primary" type="button" data-testid="experiment-runner-review-launch" ?disabled=${!proj.valid}
						title=${proj.valid ? "Review & launch" : "Set caps + stop condition + acknowledge"}
						@click=${() => setView(host, instanceKey, "confirm")}>Review &amp; launch →</button>
				</footer>
			`;
		}
		return html`
			<footer class="exp-projection" data-testid="experiment-runner-projection">
				<div class="exp-proj-stats">
					<span data-testid="experiment-runner-run-count">${arrayOf(d.ab && d.ab.variants).length} variants × ${num(d.ab && d.ab.repeats) || 0} repeats = ${proj.runCount} runs</span>
					<span data-testid="experiment-runner-cost">${proj.estCostMax != null ? `est. ≤ ${usd(proj.estCostMax)}` : "est. — set a per-run budget"}</span>
					<span>~${num(d.ab && d.ab.concurrency) || 1} concurrent</span>
				</div>
				${arrayOf(proj.errors).length ? html`<ul class="exp-checklist" data-testid="experiment-runner-error">
					${proj.errors.map((e) => html`<li class="exp-neg">✗ ${e}</li>`)}
				</ul>` : nothing}
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-review-launch" ?disabled=${!proj.valid}
					title=${proj.valid ? "Review & launch" : (arrayOf(proj.errors)[0] || "Complete the form")}
					@click=${() => setView(host, instanceKey, "confirm")}>Review &amp; launch →</button>
			</footer>
		`;
	}

	function renderDefine(host, instanceKey, d) {
		const proj = projectionFor(d);
		return html`
			<div class="exp-view exp-define" data-testid="experiment-runner-view-define" data-mode=${d.mode || "ab"}>
				<div class="exp-define-head">
					<button class="exp-btn link" type="button" @click=${() => setView(host, instanceKey, "mode-select")}>← mode</button>
					<span class="exp-mode-badge ${d.mode === "autoresearch" ? "warn" : ""}">${d.mode === "autoresearch" ? "AUTORESEARCH" : "A/B"}</span>
				</div>
				${renderBasics(host, instanceKey, d)}
				${d.mode === "autoresearch" ? renderAutoForm(host, instanceKey, d) : renderABForm(host, instanceKey, d)}
				${renderMetricsEditor(host, instanceKey, d)}
				${renderProjection(host, instanceKey, d, proj)}
			</div>
		`;
	}

	function renderConfirm(host, instanceKey, d) {
		const proj = projectionFor(d);
		const isAuto = d.mode === "autoresearch";
		const entry = byInstance.get(instanceKey) || {};
		return html`
			<div class="exp-view" data-testid="experiment-runner-view-confirm">
				<h1 class="exp-h1">Confirm launch</h1>
				<section class="exp-card">
					<div class="exp-confirm-row"><span>Mode</span><strong>${isAuto ? "Autoresearch" : "A/B comparison"}</strong></div>
					<div class="exp-confirm-row"><span>Name</span><strong>${asText(d.basics && d.basics.name)}</strong></div>
					${isAuto
						? html`
							<div class="exp-confirm-row"><span>Objective</span><strong>${asText(d.auto && d.auto.objectiveMetric)} (${asText(d.auto && d.auto.direction)})</strong></div>
							<div class="exp-confirm-row"><span>Caps</span><strong>${asText(num(d.auto.caps.maxIterations) ? `≤ ${num(d.auto.caps.maxIterations)} iters` : "")} ${num(d.auto.caps.wallClockHours) ? `≤ ${num(d.auto.caps.wallClockHours)}h` : ""} ${num(d.auto.caps.costUsd) ? `≤ ${usd(num(d.auto.caps.costUsd))}` : ""}</strong></div>
							<div class="exp-confirm-row"><span>Worst-case cost</span><strong>${proj.estCostMax != null ? `≤ ${usd(proj.estCostMax)}` : "unbounded by iterations"}</strong></div>
							<div class="exp-confirm-note">A candidate that fails verification is discarded even if its objective improved.</div>`
						: html`
							<div class="exp-confirm-row"><span>Fan-out</span><strong>${proj.runCount} child goals (${arrayOf(d.ab.variants).length} variants × ${num(d.ab.repeats)} repeats)</strong></div>
							<div class="exp-confirm-row"><span>Projected cost</span><strong>${proj.estCostMax != null ? `≤ ${usd(proj.estCostMax)}` : "—"}</strong></div>`}
				</section>
				${entry.launchError ? html`<div class="exp-error-box" data-testid="experiment-runner-launch-error">${entry.launchError}</div>` : nothing}
				<div class="exp-confirm-actions">
					<button class="exp-btn secondary" type="button" @click=${() => setView(host, instanceKey, "define")}>← Back</button>
					<button class="exp-btn primary" type="button" data-testid="experiment-runner-launch" ?disabled=${!proj.valid || entry.launching}
						@click=${() => doLaunch(host, instanceKey)}>${entry.launching ? "Launching…" : isAuto ? `Launch loop (≤ ${proj.estCostMax != null ? usd(proj.estCostMax) : "capped"})` : `Launch ${proj.runCount} runs`}</button>
				</div>
			</div>
		`;
	}

	// ════════════════════════════════════════════════════════════════════════
	// Dashboard
	// ════════════════════════════════════════════════════════════════════════
	function effectiveSpec(dash) {
		const spec = dash && Array.isArray(dash.spec) ? dash.spec : (dash && dash.spec && Array.isArray(dash.spec.widgets) ? dash.spec.widgets : null);
		if (spec && spec.length) return spec;
		const isAuto = dash && dash.def && dash.def.mode === "autoresearch";
		return isAuto
			? [
				{ type: "summary-cards", title: "Summary" },
				{ type: "objective-curve", title: "Best objective vs iteration" },
				{ type: "ledger-table", title: "Ledger" },
				{ type: "raw-drilldown", title: "Iterations" },
			]
			: [
				{ type: "summary-cards", title: "Summary" },
				{ type: "comparison-table", title: "Comparison" },
				{ type: "score-bars", title: "Secondary metrics" },
				{ type: "raw-drilldown", title: "Runs" },
			];
	}

	// Selection entries are canonical `{ metricId }`; tolerate the legacy `metric`
	// field (older stored selections / direct seeds).
	const selId = (m) => (m && (m.metricId || m.metric)) || undefined;
	function collectedMetricIds(dash) {
		const sel = arrayOf(dash && dash.metrics);
		const ids = sel.filter((m) => m.collect !== false).map(selId).filter(Boolean);
		return ids.length ? ids : ["objective.value", "cost.totalUsd", "time.wallClockMs"];
	}
	function primaryMetricId(dash) {
		const sel = arrayOf(dash && dash.metrics);
		const p = sel.find((m) => m.primary);
		if (p) return selId(p);
		if (dash && dash.def && dash.def.objective) return dash.def.objective.metricId || dash.def.objective.metric;
		return collectedMetricIds(dash)[0];
	}
	const metricValue = (run, id) => {
		const m = run && run.metrics;
		const v = m ? m[id] : undefined;
		return Number.isFinite(Number(v)) ? Number(v) : (v && Number.isFinite(Number(v.value)) ? Number(v.value) : undefined);
	};
	function runsByArm(dash) {
		const map = new Map();
		for (const r of arrayOf(dash && dash.runs)) {
			const arm = asText(r.armId, "arm");
			if (!map.has(arm)) map.set(arm, []);
			map.get(arm).push(r);
		}
		return map;
	}

	function widgetComparisonTable(host, dash) {
		const metricIds = collectedMetricIds(dash);
		const sameBar = !(dash.def && dash.def.sameCompletionBar === false);
		const arms = runsByArm(dash);
		const sel = arrayOf(dash.metrics);
		const aggOf = (id) => (sel.find((m) => selId(m) === id) || {}).aggregation || "median";
		return html`<table class="exp-table" data-testid="experiment-runner-widget-comparison-table">
			<thead><tr><th>Variant</th>${metricIds.map((id) => html`<th class="exp-mono">${id}</th>`)}<th>n</th></tr></thead>
			<tbody>
				${[...arms.entries()].map(([arm, runs]) => {
					const eligible = sameBar ? runs.filter((r) => r.completionBar === "passed") : runs;
					const used = eligible.length ? eligible : runs;
					return html`<tr data-testid="experiment-runner-comparison-arm" data-arm=${arm}>
						<td><strong>${arm}</strong></td>
						${metricIds.map((id) => html`<td class="exp-mono">${fmt(aggregate(used.map((r) => metricValue(r, id)), aggOf(id)))}</td>`)}
						<td>${used.length}</td>
					</tr>`;
				})}
			</tbody>
		</table>`;
	}

	function widgetScoreBars(host, dash) {
		const metricIds = collectedMetricIds(dash);
		const arms = runsByArm(dash);
		return html`<div class="exp-scorebars" data-testid="experiment-runner-widget-score-bars">
			${metricIds.map((id, mi) => {
				const rows = [...arms.entries()].map(([arm, runs]) => ({ arm, v: aggregate(runs.map((r) => metricValue(r, id)), "median") }));
				const max = Math.max(1, ...rows.map((r) => (Number.isFinite(r.v) ? Math.abs(r.v) : 0)));
				return html`<div class="exp-scorebar-group"><div class="exp-field-label exp-mono">${id}</div>
					${rows.map((r) => html`<div class="exp-scorebar-row"><span class="exp-scorebar-label">${r.arm}</span>
						<span class="exp-scorebar-track"><span class="exp-scorebar-fill" style=${`width:${Math.round((Number.isFinite(r.v) ? Math.abs(r.v) : 0) / max * 100)}%;background:var(--chart-${(mi % 6) + 1})`}></span></span>
						<span class="exp-mono">${fmt(r.v)}</span></div>`)}
				</div>`;
			})}
		</div>`;
	}

	function widgetObjectiveCurve(host, dash) {
		const id = primaryMetricId(dash);
		const dir = (dash.def && dash.def.objective && dash.def.objective.direction) || "maximize";
		const iters = arrayOf(dash.runs).filter((r) => r.iteration != null).sort((a, b) => a.iteration - b.iteration);
		let best = null;
		const points = iters.map((r) => {
			const v = metricValue(r, id);
			if (Number.isFinite(v)) best = best == null ? v : (dir === "minimize" ? Math.min(best, v) : Math.max(best, v));
			return { iteration: r.iteration, v, best, kept: r.verified !== false && r.completionBar !== "failed" };
		});
		const target = num(dash.def && dash.def.stop && dash.def.stop.target);
		return html`<div data-testid="experiment-runner-widget-objective-curve">
			${target != null ? html`<div class="exp-hint">target ${dir === "minimize" ? "≤" : "≥"} ${fmt(target)}</div>` : nothing}
			<table class="exp-table"><thead><tr><th>Iter</th><th>objective</th><th>best</th><th>verdict</th></tr></thead>
				<tbody>${points.map((p) => html`<tr><td>${p.iteration}</td><td class="exp-mono">${fmt(p.v)}</td><td class="exp-mono exp-pos">${fmt(p.best)}</td><td>${p.kept ? html`<span class="exp-pos">●</span>` : html`<span class="exp-neg">○</span>`}</td></tr>`)}</tbody>
			</table>
		</div>`;
	}

	function widgetLedgerTable(host, dash) {
		const ledger = arrayOf(dash.ledger);
		return html`<table class="exp-table" data-testid="experiment-runner-widget-ledger-table">
			<thead><tr><th>Iter</th><th>verdict</th><th>objective</th><th>best</th></tr></thead>
			<tbody>${ledger.map((l) => {
				const verdict = asText(l.verdict || l.decision, "—");
				const cls = /kept|accept/i.test(verdict) ? "exp-pos" : /verification|failed/i.test(verdict) ? "exp-neg" : "exp-muted";
				return html`<tr data-testid="experiment-runner-ledger-row"><td>${asText(l.iteration)}</td><td class=${cls}>${verdict}</td><td class="exp-mono">${fmt(num(l.objective))}</td><td class="exp-mono">${fmt(num(l.best))}</td></tr>`;
			})}</tbody>
		</table>`;
	}

	function widgetSummaryCards(host, dash) {
		const runs = arrayOf(dash.runs);
		const settled = runs.filter((r) => ["settled", "collected", "failed"].includes(r.status)).length;
		const passed = runs.filter((r) => r.completionBar === "passed").length;
		const cost = runs.reduce((s, r) => s + (num(r.cost && r.cost.totalUsd) || metricValue(r, "cost.totalUsd") || 0), 0);
		return html`<div class="exp-cards" data-testid="experiment-runner-widget-summary-cards">
			<div class="exp-stat"><span class="exp-stat-n">${runs.length}</span><span class="exp-stat-l">runs</span></div>
			<div class="exp-stat"><span class="exp-stat-n">${settled}</span><span class="exp-stat-l">settled</span></div>
			<div class="exp-stat"><span class="exp-stat-n exp-pos">${passed}</span><span class="exp-stat-l">passed bar</span></div>
			<div class="exp-stat"><span class="exp-stat-n">${usd(cost)}</span><span class="exp-stat-l">spend</span></div>
		</div>`;
	}

	function widgetRawDrilldown(host, dash) {
		const metricIds = collectedMetricIds(dash);
		const runs = arrayOf(dash.runs);
		return html`<table class="exp-table" data-testid="experiment-runner-widget-raw-drilldown">
			<thead><tr><th>run</th><th>arm</th><th>${dash.def && dash.def.mode === "autoresearch" ? "iter" : "rep"}</th><th>status</th><th>bar</th>${metricIds.map((id) => html`<th class="exp-mono">${id}</th>`)}</tr></thead>
			<tbody>${runs.map((r) => {
				const excluded = (dash.def && dash.def.sameCompletionBar !== false) && r.completionBar && r.completionBar !== "passed";
				return html`<tr class=${excluded ? "exp-excluded" : ""} data-testid="experiment-runner-run-row" data-run=${asText(r.runId)}>
					<td class="exp-mono">${asText(r.runId)}</td><td>${asText(r.armId)}</td>
					<td>${asText(r.iteration != null ? r.iteration : r.repeat)}</td>
					<td>${asText(r.status)}</td><td>${asText(r.completionBar)}${excluded ? html` <span class="exp-tag">excluded</span>` : nothing}</td>
					${metricIds.map((id) => html`<td class="exp-mono">${fmt(metricValue(r, id))}</td>`)}
				</tr>`;
			})}</tbody>
		</table>`;
	}

	const WIDGET_RENDERERS = {
		"comparison-table": widgetComparisonTable,
		"score-bars": widgetScoreBars,
		"objective-curve": widgetObjectiveCurve,
		"ledger-table": widgetLedgerTable,
		"summary-cards": widgetSummaryCards,
		"raw-drilldown": widgetRawDrilldown,
	};

	function renderReportHtml(htmlString) {
		try {
			const node = document.createElement("div");
			node.setAttribute("data-testid", "experiment-runner-report-html");
			node.innerHTML = String(htmlString);
			return node;
		} catch { return nothing; }
	}

	function renderDashboardBody(host, instanceKey, dash) {
		// Prefer the shared reporting lib's rendered html (single source of truth).
		if (dash.report && typeof dash.report.html === "string" && dash.report.html.trim()) {
			return html`<div class="exp-dashboard-body" data-testid="experiment-runner-dashboard-body">${renderReportHtml(dash.report.html)}</div>`;
		}
		const spec = effectiveSpec(dash);
		return html`<div class="exp-dashboard-body" data-testid="experiment-runner-dashboard-body">
			${spec.map((w) => {
				const renderer = WIDGET_RENDERERS[w.type];
				return html`<section class="exp-widget exp-card" data-testid="experiment-runner-widget" data-widget-type=${w.type}>
					<h3 class="exp-widget-title">${asText(w.title, w.type)}</h3>
					${renderer ? renderer(host, dash) : html`<div class="exp-hint">Unknown widget: ${w.type}</div>`}
				</section>`;
			})}
		</div>`;
	}

	function renderDashboardEditor(host, instanceKey, dash) {
		const spec = effectiveSpec(dash).slice();
		const setSpec = (next) => patch(host, instanceKey, { dashboardDraftSpec: next });
		const entry = byInstance.get(instanceKey) || {};
		const draftSpec = entry.dashboardDraftSpec || spec;
		const move = (i, delta) => {
			const next = draftSpec.slice();
			const j = i + delta;
			if (j < 0 || j >= next.length) return;
			[next[i], next[j]] = [next[j], next[i]];
			setSpec(next);
		};
		const remove = (i) => { const next = draftSpec.slice(); next.splice(i, 1); setSpec(next); };
		const add = (type) => setSpec([...draftSpec, { type, title: (BUILTIN_WIDGETS.find((w) => w.id === type) || {}).label || type }]);
		const setTitle = (i, title) => { const next = draftSpec.slice(); next[i] = { ...next[i], title }; setSpec(next); };
		const widgetTypes = entry.widgetTypes && entry.widgetTypes.length ? entry.widgetTypes : BUILTIN_WIDGETS;
		return html`<div class="exp-card" data-testid="experiment-runner-dashboard-editor">
			<h3 class="exp-h2">Edit dashboard</h3>
			${draftSpec.map((w, i) => html`<div class="exp-editor-row" data-testid="experiment-runner-editor-widget" data-widget-type=${w.type}>
				<input class="exp-input" type="text" .value=${asText(w.title)} @input=${(e) => setTitle(i, e.currentTarget.value)} />
				<span class="exp-badge exp-mono">${w.type}</span>
				<button class="exp-icon-btn" type="button" title="Move up" @click=${() => move(i, -1)}>↑</button>
				<button class="exp-icon-btn" type="button" title="Move down" @click=${() => move(i, 1)}>↓</button>
				<button class="exp-icon-btn" type="button" title="Remove" @click=${() => remove(i)}>✕</button>
			</div>`)}
			<div class="exp-editor-add">
				<select class="exp-input" data-testid="experiment-runner-add-widget-type">
					${widgetTypes.map((w) => html`<option value=${w.id}>${w.label || w.id}</option>`)}
				</select>
				<button class="exp-btn secondary" type="button" data-testid="experiment-runner-add-widget"
					@click=${(e) => { const sel = e.currentTarget.parentElement.querySelector("select"); add(sel.value); }}>+ Add widget</button>
			</div>
			<div class="exp-confirm-actions">
				<button class="exp-btn secondary" type="button" @click=${() => patch(host, instanceKey, { dashboardEditing: false, dashboardDraftSpec: undefined })}>Cancel</button>
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-save-dashboard"
					@click=${() => { patch(host, instanceKey, { dashboardDraftSpec: undefined }); void saveDashboardSpec(host, instanceKey, dash.experimentId, draftSpec); }}>Save dashboard</button>
			</div>
		</div>`;
	}

	function renderDashboard(host, instanceKey, d) {
		const entry = byInstance.get(instanceKey) || {};
		const dash = entry.dashboard;
		const newExperiment = () => patch(host, instanceKey, { dashboard: null }) && patchDraft(host, instanceKey, (dd) => { Object.assign(dd, defaultDraft()); });
		if (entry.dashboardLoading && !dash) {
			return html`<div class="exp-view" data-testid="experiment-runner-view-dashboard"><div class="exp-hint">Loading experiment…</div></div>`;
		}
		if (!dash) {
			return html`<div class="exp-view" data-testid="experiment-runner-view-dashboard">
				<div class="exp-empty">No experiment loaded.</div>
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-new-experiment" @click=${newExperiment}>New experiment</button>
			</div>`;
		}
		const def = dash.def || {};
		const state = dash.state || {};
		const isAuto = def.mode === "autoresearch";
		const status = asText(state.status, "running");
		const runs = arrayOf(dash.runs);
		const settled = runs.filter((r) => ["settled", "collected", "failed"].includes(r.status)).length;
		const stopReason = state.stopReason ? `stopped: ${state.stopReason}` : status;
		return html`
			<div class="exp-view" data-testid="experiment-runner-view-dashboard" data-experiment-id=${dash.experimentId}>
				<header class="exp-dash-head">
					<div class="exp-dash-titles">
						<span class="exp-mode-badge ${isAuto ? "warn" : ""}">${isAuto ? "AUTORESEARCH" : "A/B"}</span>
						<h1 class="exp-h1">${asText(def.title, dash.experimentId)}</h1>
					</div>
					<div class="exp-dash-meta">
						<span class="exp-status" data-testid="experiment-runner-status" role="status">${status === "running" ? `running ${settled}/${runs.length}` : stopReason}</span>
					</div>
					<div class="exp-dash-actions">
						${status === "running" ? html`<button class="exp-btn secondary" type="button" data-testid="experiment-runner-stop" @click=${() => doCancel(host, instanceKey, dash.experimentId)}>Stop experiment</button>` : nothing}
						<button class="exp-btn secondary" type="button" data-testid="experiment-runner-refresh" @click=${() => loadDashboard(host, instanceKey, dash.experimentId)}>Refresh</button>
						<button class="exp-btn secondary" type="button" data-testid="experiment-runner-edit-dashboard"
							@click=${() => patch(host, instanceKey, { dashboardEditing: !entry.dashboardEditing, dashboardDraftSpec: undefined })}>${entry.dashboardEditing ? "Close editor" : "Edit dashboard"}</button>
						<button class="exp-btn link" type="button" data-testid="experiment-runner-new-experiment" @click=${newExperiment}>New experiment</button>
					</div>
				</header>
				${entry.dashboardEditing ? renderDashboardEditor(host, instanceKey, dash) : nothing}
				<details class="exp-details" data-testid="experiment-runner-metrics-panel">
					<summary>Metrics — edit what is collected (re-extracts from stored outcomes, no re-run)</summary>
					${renderDashboardMetricsEditor(host, instanceKey, dash)}
				</details>
				${renderDashboardBody(host, instanceKey, dash)}
			</div>
		`;
	}

	function renderDashboardMetricsEditor(host, instanceKey, dash) {
		const metrics = arrayOf(dash.metrics).length ? arrayOf(dash.metrics) : defaultMetricsSelection();
		const toggle = (i, collect) => {
			const next = metrics.map((m, j) => (j === i ? { ...m, collect } : m));
			patch(host, instanceKey, { dashboard: { ...dash, metrics: next } });
			void saveMetricsSelection(host, instanceKey, dash.experimentId, next);
		};
		return html`<table class="exp-table">
			<thead><tr><th>Collect</th><th>Metric</th></tr></thead>
			<tbody>${metrics.map((m, i) => html`<tr><td><input type="checkbox" data-testid="experiment-runner-dash-metric-collect" data-metric=${selId(m)}
				?checked=${m.collect !== false} @change=${(e) => toggle(i, e.currentTarget.checked)} /></td><td class="exp-mono">${selId(m)}</td></tr>`)}</tbody>
		</table>`;
	}

	// ── styles ──
	const STYLE = `
		.exp-root{display:flex;flex-direction:column;height:100%;overflow:auto;background:var(--background);color:var(--foreground);font-size:13px;}
		.exp-view{padding:16px;display:flex;flex-direction:column;gap:14px;}
		.exp-h1{font-size:18px;font-weight:600;margin:0;}
		.exp-h2{font-size:14px;font-weight:600;margin:0 0 8px;}
		.exp-sub,.exp-hint,.exp-empty{color:var(--muted-foreground);font-size:12px;margin:0;}
		.exp-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;}
		.exp-mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
		.exp-mode-card{display:flex;flex-direction:column;gap:6px;text-align:left;padding:16px;border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--foreground);cursor:pointer;}
		.exp-mode-card.recommended{border-color:color-mix(in oklch, var(--primary) 50%, var(--border));}
		.exp-mode-card.danger{border-color:color-mix(in oklch, var(--warning) 45%, var(--border));}
		.exp-mode-card:hover{border-color:var(--primary);}
		.exp-mode-title{font-size:15px;font-weight:600;}
		.exp-mode-desc{font-size:12px;color:var(--muted-foreground);}
		.exp-eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-foreground);}
		.exp-eyebrow.warn,.exp-req{color:var(--warning);}
		.exp-label,.exp-field-label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted-foreground);}
		.exp-field-label{font-weight:600;}
		.exp-input{background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:7px;padding:6px 8px;font-size:13px;font-family:inherit;}
		.exp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}
		.exp-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
		.exp-radio-row{display:flex;gap:14px;align-items:center;color:var(--foreground);}
		.exp-radio,.exp-checkbox{display:flex;gap:6px;align-items:center;color:var(--foreground);font-size:12px;}
		.exp-checkbox.danger{color:var(--warning);}
		.exp-kv{display:flex;flex-direction:column;gap:6px;}
		.exp-kv-row{display:grid;grid-template-columns:1fr 1fr auto;gap:6px;}
		.exp-variant{border:1px dashed var(--border);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px;}
		.exp-variant-head{display:flex;gap:6px;align-items:center;}
		.exp-variant-head .exp-input{flex:1;}
		.exp-btn{border-radius:7px;padding:7px 12px;font-size:13px;cursor:pointer;border:1px solid var(--border);background:var(--card);color:var(--foreground);}
		.exp-btn.primary{background:var(--primary);color:var(--background);border-color:var(--primary);}
		.exp-btn.primary:disabled{opacity:.5;cursor:not-allowed;}
		.exp-btn.secondary{background:transparent;}
		.exp-btn.link{background:none;border:none;color:var(--muted-foreground);padding:4px;}
		.exp-btn.tiny{padding:3px 8px;font-size:11px;}
		.exp-icon-btn{background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--muted-foreground);cursor:pointer;width:26px;height:26px;}
		.exp-projection{position:sticky;bottom:0;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;}
		.exp-proj-stats{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;}
		.exp-checklist{margin:0;padding-left:4px;list-style:none;display:flex;flex-direction:column;gap:3px;font-size:12px;}
		.exp-neg{color:var(--negative);}.exp-pos{color:var(--positive);}.exp-muted{color:var(--muted-foreground);}
		.exp-warn-hint,.exp-warn-banner{color:var(--warning);}
		.exp-warn-banner{background:color-mix(in oklch, var(--warning) 12%, transparent);border:1px solid color-mix(in oklch, var(--warning) 40%, var(--border));border-radius:8px;padding:10px;font-size:12px;}
		.exp-mode-badge{font-size:10px;font-weight:700;letter-spacing:.05em;padding:2px 7px;border-radius:999px;border:1px solid var(--border);color:var(--muted-foreground);}
		.exp-mode-badge.warn{color:var(--warning);border-color:color-mix(in oklch, var(--warning) 45%, var(--border));}
		.exp-define-head,.exp-dash-titles{display:flex;gap:10px;align-items:center;}
		.exp-table{width:100%;border-collapse:collapse;font-size:12px;}
		.exp-table th,.exp-table td{border-bottom:1px solid var(--border);padding:5px 6px;text-align:left;}
		.exp-table th{color:var(--muted-foreground);font-weight:600;}
		.exp-badge{font-size:10px;padding:1px 5px;border-radius:5px;border:1px solid var(--border);color:var(--muted-foreground);}
		.exp-details{border:1px solid var(--border);border-radius:8px;padding:8px;}
		.exp-details summary{cursor:pointer;font-size:12px;color:var(--muted-foreground);}
		.exp-confirm-row{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;}
		.exp-confirm-note,.exp-confirm-actions{margin-top:6px;}
		.exp-confirm-note{color:var(--warning);font-size:12px;}
		.exp-confirm-actions{display:flex;gap:10px;justify-content:flex-end;}
		.exp-error-box{color:var(--negative);border:1px solid var(--negative);border-radius:8px;padding:8px;font-size:12px;}
		.exp-dash-head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;}
		.exp-dash-actions{display:flex;gap:6px;flex-wrap:wrap;}
		.exp-status{font-size:12px;color:var(--muted-foreground);}
		.exp-dashboard-body{display:flex;flex-direction:column;gap:12px;}
		.exp-widget-title{font-size:13px;font-weight:600;margin:0 0 8px;}
		.exp-cards{display:flex;gap:10px;flex-wrap:wrap;}
		.exp-stat{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;padding:8px 12px;min-width:70px;}
		.exp-stat-n{font-size:18px;font-weight:700;}.exp-stat-l{font-size:11px;color:var(--muted-foreground);}
		.exp-scorebar-row{display:grid;grid-template-columns:90px 1fr 56px;gap:8px;align-items:center;margin:3px 0;}
		.exp-scorebar-track{background:color-mix(in oklch, var(--muted-foreground) 18%, transparent);border-radius:5px;height:10px;overflow:hidden;}
		.exp-scorebar-fill{display:block;height:100%;}
		.exp-excluded{opacity:.5;}
		.exp-tag{font-size:9px;border:1px solid var(--border);border-radius:4px;padding:0 3px;color:var(--muted-foreground);}
		.exp-editor-row{display:flex;gap:6px;align-items:center;margin:4px 0;}
		.exp-editor-row .exp-input{flex:1;}
		.exp-editor-add{display:flex;gap:6px;align-items:center;margin-top:8px;}
	`;

	return {
		render(params, host) {
			const sessionId = params && typeof params.__sessionId === "string" ? params.__sessionId : "";
			const explicitId = params && typeof params.experimentId === "string" ? params.experimentId : "";
			const focusView = params && typeof params.view === "string" ? params.view : undefined;
			const instanceKey = sessionId || "experiment-runner";

			const entry = ensureHydrated(host, instanceKey, explicitId, focusView);
			const d = (entry && entry.draft) || defaultDraft();
			const view = d.view || "mode-select";

			let body;
			if (view === "dashboard") body = renderDashboard(host, instanceKey, d);
			else if (view === "confirm") body = renderConfirm(host, instanceKey, d);
			else if (view === "define") body = renderDefine(host, instanceKey, d);
			else body = renderModeSelect(host, instanceKey, d);

			return html`
				<style>${STYLE}</style>
				<div class="exp-root" data-testid="experiment-runner-panel-root" data-view=${view} data-mode=${d.mode || ""}>
					${body}
				</div>
			`;
		},
	};
}
