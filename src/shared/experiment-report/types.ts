// Canonical shared types for the experiment-runner reporting library.
//
// This file is the SINGLE source of truth for ExperimentDef, VariantDef,
// RunRecord, RunStatus, CompletionBar, MetricSelection, DashboardSpec,
// WidgetSpec, and ReportModel (see docs/design/experiment-runner-reporting.md
// §4.1 + §11). The reporting lib (reader) and the experiment-runner pack engine
// (writer, docs/design/experiment-runner-pack-backend.md) import these EXACT
// types; the pack's lib/store-keys.mjs JSDoc mirrors them. Backend writes
// exactly these fields and reporting reads exactly these fields — a schema-parity
// pinning test enforces it (no drift on field names / RunStatus / CompletionBar).
//
// Pure types only: no node:/server imports so this module bundles cleanly into
// the pack's confined worker via build:packs.

/** Permissive ephemeral-role shape (the pack/engine owns the concrete contract). */
export type Role = Record<string, unknown>;

/** Two front doors, one engine. A/B is the safe default; autoresearch is opt-in. */
export type ExperimentMode = "ab" | "autoresearch";

/** Optimization direction for a metric/objective. */
export type Direction = "max" | "min";

/** A single extracted metric value. `null` means "not measured" (never coerce to 0). */
export type MetricValue = number | null;

/** What each arm actually runs. The runner is agnostic (agent goal or generic command). */
export interface RunnableSpec {
	kind: "agent" | "command";
	/** agent: the goal spec text for the arm child goal. */
	spec?: string;
	/** command: shell that emits a metric line. */
	command?: string;
	/** command: how the metric is reported (stdout JSON | file path). */
	metricChannel?: string;
}

/** Autoresearch objective: which selected metric to optimize, and which way. */
export interface ObjectiveSpec {
	metricId: string;
	direction: Direction;
	/** Optional target value; crossing it (direction-aware) is a stop condition. */
	target?: number;
}

/** Mandatory autoresearch hard caps — at least one must be finite. */
export interface AutoresearchCaps {
	maxIterations?: number;
	maxWallClockMs?: number;
	maxCostUsd?: number;
}

/** Autoresearch stop conditions — at least one is required. */
export interface StopSpec {
	/** No accepted improvement over K consecutive iterations. */
	plateauK?: number;
	/** Improvement smaller than eps counts as no-improvement. */
	plateauEps?: number;
	/** Stop when the best objective crosses target (direction-aware). */
	target?: number;
}

/** Canonical experiment definition (reporting reads the marked subset). */
export interface ExperimentDef {
	experimentId: string;
	title: string;
	/** DEFAULT 'ab' — chosen by the define route, not a buried toggle. */
	mode: ExperimentMode;
	/** The experiment goal under which arms are spawned. */
	parentGoalId: string;
	/** Comparable verification bar applied to every arm. */
	workflowId?: string;
	/** What each arm runs (agent spec or generic command). */
	runnable: RunnableSpec;
	/** A/B: each variant = an arm treatment bundle. */
	variants?: VariantDef[];
	/** A/B: N repeats per variant (>=1). */
	repeats?: number;
	/** Autoresearch objective. */
	objective?: ObjectiveSpec;
	/** Autoresearch hard caps. */
	caps?: AutoresearchCaps;
	/** Autoresearch plateau/target stop spec. */
	stop?: StopSpec;
	/** Clamped to the per-root concurrency cap. */
	maxConcurrency?: number;
}

/** A single A/B arm treatment bundle. */
export interface VariantDef {
	armId: string;
	label: string;
	/** Arm treatment → child goal metadata (deep-merged onto experiment metadata). */
	metadata: Record<string, unknown>;
	/** Per-arm ephemeral roles. */
	inlineRoles?: Record<string, Role>;
}

/** Run lifecycle state machine (pack-backend §5.1). */
export type RunStatus =
	| "pending"
	| "spawned"
	| "running"
	| "settled"
	| "collected"
	| "failed"
	| "cancelled";

/** Same-completion-bar filtering enum (NOT a free string). */
export type CompletionBar = "passed" | "failed" | "incomplete";

/** Cost rollup for an arm child goal. */
export interface CostSummary {
	costUsd?: number;
	tokensIn?: number;
	tokensOut?: number;
}

/** Underlying outcome data, retained on the record for re-extraction (no re-run). */
export interface RawOutcome {
	costUsd?: number;
	tokensIn?: number;
	tokensOut?: number;
	gateVerdicts?: Record<string, "passed" | "failed" | "pending">;
	taskCounts?: { complete: number; total: number };
	/** §7 pluggable user-metric channel. */
	userMetrics?: Record<string, number>;
}

/** The unit reporting aggregates — one per variant×repeat (A/B) or per iteration (AR). */
export interface RunRecord {
	experimentId: string;
	runId: string;
	/** A/B: which variant; autoresearch: candidate id. */
	armId: string;
	/** A/B: 0..repeats-1. */
	repeat?: number;
	/** Autoresearch: 0..n. */
	iteration?: number;
	/** The spawned child goal (spawnGoal result). */
	childGoalId?: string;
	/** Idempotency key under the parent goal. */
	runKey: string;
	status: RunStatus;
	/** Underlying outcome data, retained for re-extraction. */
	rawOutcome?: RawOutcome;
	/** Already-extracted metric values keyed by metricId. */
	metrics: Record<string, MetricValue>;
	/** Canonical completion-bar enum (default comparison keeps `passed`). */
	completionBar?: CompletionBar;
	/** Correctness-gate result (autoresearch rejects if false). */
	verified?: boolean;
	/** Cost rollup for the arm child goal. */
	cost?: CostSummary;
	spawnedAt?: number;
	settledAt?: number;
	collectedAt?: number;
	error?: string;
}

/** Autoresearch ledger entry (append-only, fed forward to the proposer). */
export interface LedgerEntry {
	iteration: number;
	runId: string;
	candidate: Record<string, unknown>;
	objective: number | null;
	completionBar?: CompletionBar;
	decision: "accepted" | "rejected";
	bestObjectiveAfter: number | null;
	/** e.g. "improved & passed", "regressed", "failed-correctness-gate". */
	reason: string;
}

/** How values within an arm are reduced across repeats. */
export type Aggregation = "median" | "mean" | "min" | "max" | "p90" | "count";

/** Editable, declarative metric selection (stored at exp/<id>/metrics). */
export interface MetricSelection {
	metricId: string;
	aggregation?: Aggregation;
	/** Override the built-in direction for winner determination. */
	directionOverride?: Direction;
	/** Which completion bar to keep when aggregating ('all' = no same-bar filtering; default 'passed'). */
	bar?: CompletionBar | "all";
	/** Marks the primary metric (used for headline/summary surfaces). */
	primary?: boolean;
}

/** A spread descriptor over an arm's repeated values. */
export interface Spread {
	min: number;
	max: number;
	p25: number;
	p75: number;
	iqr: number;
}

/** One aggregated (arm × metric) result. */
export interface ArmAggregate {
	armId: string;
	metricId: string;
	/** Reduced value after same-completion-bar filtering, or null if all-null/empty. */
	value: MetricValue;
	spread: Spread | null;
	/** Number of kept (same-bar, non-null) samples. */
	n: number;
	/** Number of samples dropped by completion-bar filtering. */
	droppedN: number;
}

/** Direction-aware comparison for a single metric across arms. */
export interface MetricComparison {
	metricId: string;
	direction: Direction;
	baselineArmId?: string;
	/** The winning arm (best value for the direction), or null if no data. */
	winnerArmId: string | null;
	arms: Array<{
		armId: string;
		value: MetricValue;
		spread: Spread | null;
		n: number;
		droppedN: number;
		isWinner: boolean;
		/** value - baselineValue (raw), null if either side missing. */
		delta: number | null;
		/** delta as a fraction of the baseline value, null if undefined. */
		deltaPct: number | null;
	}>;
}

/** One point on the best-objective-vs-iteration curve. */
export interface ObjectivePoint {
	iteration: number;
	runId: string;
	armId: string;
	/** Candidate's own objective value (may regress). */
	objective: number | null;
	/** Whether this candidate was accepted (improved AND verified). */
	accepted: boolean;
	/** Whether the candidate passed the correctness gate. */
	verified: boolean;
	/** Running best objective among accepted/verified candidates. */
	bestSoFar: number | null;
}

/** Why the autoresearch loop stopped (annotated on the curve / surfaced in summary). */
export interface StopAnnotation {
	stopped: boolean;
	reason: string;
	/** Iteration at which the stop condition first held, if applicable. */
	iteration?: number;
}

/** A registered widget instance in a dashboard. */
export interface WidgetSpec {
	id: string;
	/** Registered renderer id, e.g. "comparison-table". */
	type: string;
	title?: string;
	/** Declarative binding into the ReportModel. */
	bind: {
		metricIds?: string[];
		armIds?: string[];
		/** Autoresearch curve widgets. */
		objective?: boolean;
	};
	options?: Record<string, unknown>;
}

/** The editable view-spec (stored at exp/<id>/dashboard). */
export interface DashboardSpec {
	mode?: ExperimentMode;
	widgets: WidgetSpec[];
}

/** Headline numbers shown by summary-cards and the report header. */
export interface ReportSummary {
	mode: ExperimentMode;
	totalRuns: number;
	settledRuns: number;
	failedRuns: number;
	/** A/B: the winning arm of the primary metric. */
	bestArmId: string | null;
	/** Autoresearch: the running best objective. */
	bestObjective: number | null;
	/** Sum of measured cost across runs. */
	actualCostUsd: number | null;
	primaryMetricId: string | null;
}

/** The pure projection of registry + raw outcomes that every surface renders. */
export interface ReportModel {
	experimentId: string;
	title: string;
	mode: ExperimentMode;
	/** Resolved metric selection. */
	metrics: MetricSelection[];
	/** Resolved dashboard spec (stored ?? default for mode). */
	dashboard: DashboardSpec;
	/** The raw run records (raw outcome + extracted metrics inline). */
	runs: RunRecord[];
	/** A/B: per (arm × metric) aggregates. */
	aggregates: ArmAggregate[];
	/** A/B: per-metric direction-aware comparison. */
	comparisons: MetricComparison[];
	/** Autoresearch: best-objective-vs-iteration curve. */
	series: ObjectivePoint[];
	/** Autoresearch ledger (feed-forward). */
	ledger: LedgerEntry[];
	/** Autoresearch: stop annotation, if the loop stopped. */
	stop: StopAnnotation | null;
	summary: ReportSummary;
}

/** Lightweight metric descriptor for registry introspection (define form). */
export interface MetricDescriptor {
	metricId: string;
	label: string;
	direction: Direction;
	description?: string;
}

/** Lightweight widget descriptor for registry introspection (dashboard editor). */
export interface WidgetDescriptor {
	type: string;
	label: string;
	/** Which modes the widget is meaningful for. */
	modes: ExperimentMode[];
	description?: string;
}
