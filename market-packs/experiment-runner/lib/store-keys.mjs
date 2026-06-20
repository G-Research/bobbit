// Experiment-runner pack — results-registry key schema (SINGLE source of keys).
//
// Every store read/write in the pack builds its key through a builder here; no
// route inlines a key string. The canonical schema (design-doc gate §3):
//
//   exp/<experimentId>                 ExperimentDef
//   exp/<experimentId>/state           ExperimentState
//   exp/<experimentId>/run/<runId>     RunRecord
//   exp/<experimentId>/ledger          LedgerEntry[]
//   exp/<experimentId>/dashboard       DashboardSpec
//   exp/<experimentId>/metrics         MetricSelection[]
//   index/experiments                  experiment index
//
// Rejected/replaced keys (never use): bare `index`, `run/<expId>/...`,
// `outcome/<expId>/<runId>`, `agg/<expId>`, `exp/<id>/runs`, `exp/<id>/best`.
// Per-run raw outcome AND extracted metrics live together inside the RunRecord;
// aggregation/best-so-far are computed on read (never persisted as a 2nd source).
//
// The JSDoc typedefs below MIRROR src/shared/experiment-report/types.ts — the
// single TS source for these shapes. The backend (writer) writes exactly these
// fields; the reporting lib (reader) reads exactly these fields.

/**
 * @typedef {'ab'|'autoresearch'} ExperimentMode
 * @typedef {'pending'|'spawned'|'running'|'settled'|'collected'|'failed'|'cancelled'} RunStatus
 * @typedef {'passed'|'failed'|'incomplete'} CompletionBar
 * @typedef {number|null} MetricValue
 */

/**
 * @typedef {Object} RunnableSpec
 * @property {'agent'|'command'} kind
 * @property {string} [spec]            agent: goal-spec text for the arm child goal
 * @property {string} [command]         command: shell that emits a metric (§9)
 * @property {string} [metricChannel]   command: 'stdout-json' | a file path | a userMetrics key
 * @property {number} [estCostUsd]      projection prior (per-arm)
 */

/**
 * @typedef {Object} VariantDef
 * @property {string} armId
 * @property {string} label
 * @property {Record<string,unknown>} metadata     arm treatment → child goal metadata
 * @property {Record<string,unknown>} [inlineRoles] per-arm ephemeral roles
 */

/**
 * @typedef {Object} ObjectiveSpec
 * @property {string} metricId
 * @property {'max'|'min'} direction
 */

/**
 * @typedef {Object} AutoresearchCaps    at least ONE must be finite (else AR_UNCAPPED)
 * @property {number} [maxIterations]
 * @property {number} [maxWallClockMs]
 * @property {number} [maxCostUsd]
 */

/**
 * @typedef {Object} StopSpec            at least ONE condition required for AR
 * @property {number} [plateauK]
 * @property {number} [plateauEps]
 * @property {number} [target]
 */

/**
 * @typedef {Object} ExperimentDef
 * @property {string} experimentId
 * @property {string} title
 * @property {ExperimentMode} mode       DEFAULT 'ab'
 * @property {string} parentGoalId
 * @property {string} [workflowId]
 * @property {RunnableSpec} runnable
 * @property {VariantDef[]} [variants]   A/B arms
 * @property {number} [repeats]          A/B repeats per variant (>=1)
 * @property {ObjectiveSpec} [objective] autoresearch objective
 * @property {AutoresearchCaps} [caps]
 * @property {StopSpec} [stop]
 * @property {number} [maxConcurrency]
 * @property {number} [perRunBudget]     comparable per-run budget (AR required; A/B projection input)
 * @property {number} [createdAt]
 */

/**
 * @typedef {Object} CostSummary
 * @property {number} [costUsd]
 * @property {number} [tokensIn]
 * @property {number} [tokensOut]
 */

/**
 * @typedef {Object} RawOutcome
 * @property {number} [costUsd]
 * @property {number} [tokensIn]
 * @property {number} [tokensOut]
 * @property {number} [cacheHitRate]
 * @property {number} [wallClockMs]
 * @property {Record<string,'passed'|'failed'|'pending'>} [gateVerdicts]
 * @property {{complete:number,total:number}} [taskCounts]
 * @property {Record<string,number>} [userMetrics]
 */

/**
 * @typedef {Object} RunRecord
 * @property {string} experimentId
 * @property {string} runId
 * @property {string} armId
 * @property {number} [repeat]
 * @property {number} [iteration]
 * @property {string} [childGoalId]
 * @property {string} runKey
 * @property {RunStatus} status
 * @property {RawOutcome} [rawOutcome]
 * @property {Record<string,MetricValue>} metrics
 * @property {CompletionBar} [completionBar]
 * @property {boolean} [verified]
 * @property {CostSummary} [cost]
 * @property {number} [spawnedAt]
 * @property {number} [settledAt]
 * @property {number} [collectedAt]
 * @property {string} [error]
 */

/**
 * @typedef {Object} ExperimentState
 * @property {RunStatus|'defined'|'running'|'done'|'cancelled'} status
 * @property {number} [createdAt]
 * @property {number} [iteration]      autoresearch cursor
 * @property {{reason:string}} [stopped]
 */

/**
 * @typedef {Object} LedgerEntry
 * @property {number} iteration
 * @property {string} runId
 * @property {Record<string,unknown>} candidate
 * @property {MetricValue} objective
 * @property {CompletionBar} [completionBar]
 * @property {'accepted'|'rejected'} decision
 * @property {MetricValue} bestObjectiveAfter
 * @property {string} reason
 */

/**
 * @typedef {Object} MetricSelection
 * @property {string} metricId
 * @property {'median'|'mean'|'min'|'max'|'p90'|'count'} [aggregation]
 * @property {'max'|'min'} [directionOverride]
 */

/**
 * @typedef {Object} WidgetSpec
 * @property {string} id
 * @property {string} type            registered renderer id (canonical built-in or pack-registered)
 * @property {string} [title]
 * @property {{metricIds?:string[],armIds?:string[],objective?:boolean}} [bind]
 * @property {Record<string,unknown>} [options]
 */

/**
 * @typedef {Object} DashboardSpec
 * @property {WidgetSpec[]} widgets
 */

/** Store key for the experiment definition. */
export function experimentKey(experimentId) {
	return `exp/${experimentId}`;
}

/** Store key for the mutable experiment state/progress cursor. */
export function stateKey(experimentId) {
	return `exp/${experimentId}/state`;
}

/** Store key for a single run record. */
export function runRecordKey(experimentId, runId) {
	return `exp/${experimentId}/run/${runId}`;
}

/** List-prefix for all run records of an experiment (host.store.list). */
export function runPrefix(experimentId) {
	return `exp/${experimentId}/run/`;
}

/** Store key for the autoresearch ledger (append-only). */
export function ledgerKey(experimentId) {
	return `exp/${experimentId}/ledger`;
}

/** Store key for the editable dashboard view-spec. */
export function dashboardKey(experimentId) {
	return `exp/${experimentId}/dashboard`;
}

/** Store key for the editable metric selection. */
export function metricsKey(experimentId) {
	return `exp/${experimentId}/metrics`;
}

/** Single key for the experiment index (list of experimentIds). */
export const INDEX_KEY = "index/experiments";

/** Deterministic runId for an A/B run (variant × repeat). */
export function abRunId(armId, repeat) {
	return `${armId}--r${repeat}`;
}

/** Deterministic runId for an autoresearch candidate run (per iteration). */
export function arRunId(iteration) {
	return `iter-${iteration}`;
}

/** Deterministic idempotency runKey passed to spawnGoal (unique under the parent). */
export function spawnRunKey(experimentId, runId) {
	return `${experimentId}:${runId}`;
}
