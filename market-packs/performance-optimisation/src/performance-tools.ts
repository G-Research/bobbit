import { PerformanceDatabaseError, inventoryTrackedProductionFiles, openPerformanceDatabase, type BenchmarkReferenceInput, type BenchmarkRunInput, type CoverageInventoryDependencies, type CrossCuttingInput, type HypothesisInput, type HypothesisMergeInput, type OutcomeInput, type ProgrammeSettingsInput } from "./performance-database.ts";
import { EXPLORE_HYPOTHESIS_INLINE_WORKFLOW } from "../templates/explore-hypothesis.ts";

export const PERFORMANCE_PACK_ID = "performance-optimisation";
export const PACK_LOCAL_DATA_ENV = "BOBBIT_PACK_LOCAL_DATA_JSON";

export type PerformanceToolName =
	| "perf_coverage_refresh"
	| "perf_coverage_get_modules_to_scan"
	| "perf_coverage_mark_module_as"
	| "perf_coverage_get_attempts"
	| "perf_coverage_upsert_cross_cutting_unit"
	| "perf_hypothesis_search"
	| "perf_hypothesis_create"
	| "perf_hypothesis_merge"
	| "perf_hypothesis_get_highest_priority"
	| "perf_hypothesis_get_goal_payload"
	| "perf_hypothesis_mark_goal_creation"
	| "perf_hypothesis_link_goal"
	| "perf_hypothesis_record_outcome"
	| "perf_benchmark_sync"
	| "perf_benchmark_register"
	| "perf_benchmark_list"
	| "perf_benchmark_record_run"
	| "perf_programme_get_session_context"
	| "perf_programme_get_settings"
	| "perf_programme_set_settings"
	| "perf_programme_get_activity";

export interface PerformanceToolContext {
	localDataDirectory?: string;
	cwd?: string;
	inventoryDependencies?: CoverageInventoryDependencies;
	nativeBinding?: string;
	sessionId?: string;
}

export interface PerformanceToolDefinition {
	name: PerformanceToolName;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
}

const string = (description: string, maxLength = 4_000) => ({ type: "string", description, minLength: 1, maxLength });
const integer = (description: string, minimum: number, maximum: number) => ({ type: "integer", description, minimum, maximum });
const stringArray = (description: string, maxItems = 100) => ({ type: "array", description, maxItems, items: { type: "string", minLength: 1, maxLength: 1_000 } });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const levels = { type: "string", enum: ["low", "medium", "high"] };
const location = object({ scanUnitId: string("Structural or cross-cutting unit ID.", 100), file: string("Repository-relative source file.", 1_000), symbol: string("Function or symbol identity.", 300), lineStart: integer("Optional line hint.", 1, 10_000_000), lineEnd: integer("Optional ending line hint.", 1, 10_000_000) }, ["file"]);
const benchmark = object({
	id: string("Optional stable benchmark ID.", 100), name: string("Display name.", 180), component: string("Bobbit-resolved project component name.", 180),
	commandName: string("Existing named project command or package script; never shell text.", 180), metric: string("Primary metric name.", 120), unit: string("Metric unit.", 80),
	direction: { type: "string", enum: ["higher", "lower"] }, scanUnitIds: stringArray("Applicable scan units.", 50), fileGlobs: stringArray("Applicability globs retained as metadata.", 50), tags: stringArray("Applicability tags.", 50),
	warmup: integer("Warm-up repetitions.", 0, 1_000), repetitions: integer("Measured repetitions.", 1, 10_000),
}, ["name", "component", "commandName", "metric", "unit", "direction"]);

export const PERFORMANCE_TOOL_DEFINITIONS: readonly PerformanceToolDefinition[] = [
	{ name: "perf_coverage_refresh", label: "Refresh Performance Coverage", description: "Inventory Git-tracked production files in the current workspace and transactionally refresh deterministic structural and cross-cutting coverage.", parameters: object({}) },
	{ name: "perf_coverage_get_modules_to_scan", label: "List Performance Scan Units", description: "List a bounded, deterministic coverage queue, prioritising stale and unscanned units.", parameters: object({ states: stringArray("Optional coverage states.", 5), kinds: stringArray("structural or cross-cutting.", 2), limit: integer("Maximum returned units.", 1, 100) }) },
	{ name: "perf_coverage_mark_module_as", label: "Transition Performance Scan", description: "Claim or transition a durable scan attempt. Completion only marks coverage current when the claimed fingerprint still matches.", parameters: object({ unitId: string("Scan unit ID.", 100), state: { type: "string", enum: ["claimed", "running", "completed", "failed", "cancelled"] }, attemptId: string("Required after claim.", 100), claimedFingerprint: string("Fingerprint returned by the coverage read/claim.", 128), scannerStaffId: string("Scanner staff ID.", 120), scannerSessionId: string("Scanner session ID.", 120), delegateSessionId: string("Delegate session ID.", 120), summary: string("Bounded transition summary.", 1_000) }, ["unitId", "state"]) },
	{ name: "perf_coverage_get_attempts", label: "List Performance Scan Attempts", description: "Read bounded outstanding or historical scan attempts for Scanner reconciliation.", parameters: object({ activeOnly: { type: "boolean" }, limit: integer("Maximum attempts.", 1, 100) }) },
	{ name: "perf_coverage_upsert_cross_cutting_unit", label: "Upsert Cross-Cutting Unit", description: "Create or update a validated semantic cross-cutting unit from known structural units and production files.", parameters: object({ id: string("Optional stable ID.", 100), label: string("Semantic flow label.", 180), unitIds: stringArray("Known structural unit IDs.", 50), files: stringArray("Known repository-relative production files.", 200) }, ["label"]) },
	{ name: "perf_hypothesis_search", label: "Search Performance Hypotheses", description: "Search exact and likely existing hypotheses by bounded description terms, file, or scan unit before writing an idea.", parameters: object({ query: string("Possible improvement description.", 500), file: string("Repository-relative source file.", 1_000), scanUnitId: string("Scan unit ID.", 100), limit: integer("Maximum matches.", 1, 50) }) },
	{ name: "perf_hypothesis_create", label: "Create Performance Hypothesis", description: "Create a structurally validated open hypothesis, with transactional exact-fingerprint deduplication and an initial observation.", parameters: object({ title: string("Short hypothesis title.", 180), description: string("Possible improvement and mechanism.", 12_000), improvementTypes: stringArray("Speed, responsiveness, CPU, memory, or other improvement types.", 10), confidence: levels, impact: levels, risk: levels, locations: { type: "array", minItems: 1, maxItems: 50, items: location }, sourceAttemptId: string("Originating scan attempt.", 100), observation: string("Initial observation; defaults to description.", 12_000) }, ["description", "improvementTypes", "confidence", "impact", "risk", "locations"]) },
	{ name: "perf_hypothesis_merge", label: "Merge Performance Observation", description: "Append an observation and merge current locations/types without erasing history.", parameters: object({ hypothesisId: string("Existing hypothesis ID.", 100), observation: string("New observation.", 12_000), improvementTypes: stringArray("Additional improvement types.", 10), locations: { type: "array", maxItems: 50, items: location }, sourceAttemptId: string("Originating scan attempt.", 100) }, ["hypothesisId", "observation"]) },
	{ name: "perf_hypothesis_get_highest_priority", label: "Prioritise Performance Hypotheses", description: "List open hypotheses ordered by lower risk, higher impact, higher confidence, then oldest first.", parameters: object({ limit: integer("Maximum hypotheses.", 1, 50) }) },
	{ name: "perf_hypothesis_get_goal_payload", label: "Read Performance Goal Payload", description: "Read one hypothesis with the canonical Explore Hypothesis inline workflow and namespaced metadata for direct goal creation.", parameters: object({ hypothesisId: string("Hypothesis ID.", 100) }, ["hypothesisId"]) },
	{ name: "perf_hypothesis_mark_goal_creation", label: "Mark Performance Goal Creation", description: "Atomically claim an open hypothesis for direct goal creation or release an owned failed claim.", parameters: object({ hypothesisId: string("Hypothesis ID.", 100), state: { type: "string", enum: ["claimed", "released"] }, directorSessionId: string("Persistent Director session ID owning the claim.", 120), summary: string("Bounded release rationale.", 1_000) }, ["hypothesisId", "state", "directorSessionId"]) },

	{ name: "perf_hypothesis_link_goal", label: "Link Performance Goal", description: "Correlate a directly created Bobbit goal with its hypothesis and move scheduling state to active.", parameters: object({ hypothesisId: string("Hypothesis ID.", 100), goalId: string("Created Bobbit goal ID.", 120) }, ["hypothesisId", "goalId"]) },
	{ name: "perf_hypothesis_record_outcome", label: "Record Performance Outcome", description: "Record one idempotent terminal recommendation with measurement, behaviour, and complexity assessments.", parameters: object({ hypothesisId: string("Hypothesis ID.", 100), outcome: { type: "string", enum: ["No improvement found", "Improvement doesn’t justify complication", "Changes system behaviour", "Recommend merging", "Abandoned"] }, rationale: string("Recommendation rationale.", 12_000), measurementSummary: string("Baseline/candidate and repeatability summary.", 12_000), behaviourAssessment: string("Behavioural validation summary.", 12_000), complexityAssessment: string("Complexity and maintainability trade-off.", 12_000) }, ["hypothesisId", "outcome", "rationale", "measurementSummary", "behaviourAssessment", "complexityAssessment"]) },
	{ name: "perf_benchmark_sync", label: "Sync Performance Benchmarks", description: "Reconcile a bounded set of Bobbit-resolved existing named project commands into benchmark references; arbitrary shell commands are rejected.", parameters: object({ benchmarks: { type: "array", maxItems: 100, items: benchmark } }, ["benchmarks"]) },
	{ name: "perf_benchmark_register", label: "Register Performance Benchmark", description: "Register metadata for one existing named project command. This does not create or execute a shell command.", parameters: benchmark },
	{ name: "perf_benchmark_list", label: "List Performance Benchmarks", description: "List bounded benchmark references, optionally filtered by hypothesis or scan unit applicability.", parameters: object({ hypothesisId: string("Hypothesis ID.", 100), scanUnitId: string("Scan unit ID.", 100), limit: integer("Maximum benchmarks.", 1, 100) }) },
	{ name: "perf_benchmark_record_run", label: "Record Performance Benchmark Run", description: "Record a structured baseline or candidate run produced through normal project command tools.", parameters: object({ hypothesisId: string("Hypothesis ID.", 100), benchmarkId: string("Benchmark reference ID.", 100), kind: { type: "string", enum: ["baseline", "candidate"] }, commit: string("Measured commit identity.", 200), environment: string("Bounded environment summary.", 12_000), metrics: { type: "object", minProperties: 1, maxProperties: 50, additionalProperties: { type: "number" } }, variability: { type: "object", maxProperties: 50, additionalProperties: { type: "number" } }, interpretation: string("Repeatability and result interpretation.", 12_000) }, ["hypothesisId", "benchmarkId", "kind", "commit", "environment", "metrics"]) },
	{ name: "perf_programme_get_session_context", label: "Read Programme Session Context", description: "Return the gateway-issued current session ID so the caller can resolve its authoritative Bobbit project with an exact session read.", parameters: object({}) },
	{ name: "perf_programme_get_settings", label: "Read Performance Programme", description: "Read programme revision, schedules, concurrency targets, and stable staff IDs.", parameters: object({}) },
	{ name: "perf_programme_set_settings", label: "Configure Performance Programme", description: "Transactionally configure bounded programme settings and stable Scanner/Director staff IDs.", parameters: object({ scannerSchedule: string("Scanner schedule trigger.", 200), directorSchedule: string("Director schedule trigger.", 200), maxParallelIdeators: integer("Maximum parallel Ideators.", 1, 20), targetActiveGoals: integer("Target concurrent optimisation goals.", 0, 50), scannerStaffId: { anyOf: [string("Scanner staff ID.", 120), { type: "null" }] }, directorStaffId: { anyOf: [string("Director staff ID.", 120), { type: "null" }] } }) },
	{ name: "perf_programme_get_activity", label: "Read Performance Activity", description: "Read newest-first programme activity, bounded to the retained latest 50 events.", parameters: object({ limit: integer("Maximum activity rows.", 1, 50) }) },
] as const;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new PerformanceDatabaseError("VALIDATION_FAILED", "tool input must be an object");
	return value as Record<string, unknown>;
}

export function resolvePerformanceLocalDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env[PACK_LOCAL_DATA_ENV];
	if (!raw) throw new PerformanceDatabaseError("INVALID_BINDING", `${PACK_LOCAL_DATA_ENV} is unavailable`);
	let decoded: unknown;
	try { decoded = JSON.parse(raw); } catch (cause) { throw new PerformanceDatabaseError("INVALID_BINDING", `${PACK_LOCAL_DATA_ENV} is invalid`, { cause }); }
	const directory = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? (decoded as Record<string, unknown>)[PERFORMANCE_PACK_ID] : undefined;
	if (typeof directory !== "string" || !directory) throw new PerformanceDatabaseError("INVALID_BINDING", `no local-data binding exists for ${PERFORMANCE_PACK_ID}`);
	return directory;
}

export function executePerformanceTool(name: PerformanceToolName, rawInput: unknown = {}, context: PerformanceToolContext = {}): unknown {
	const input = record(rawInput);
	const directory = context.localDataDirectory ?? resolvePerformanceLocalDataDirectory();
	const db = openPerformanceDatabase(directory, context.nativeBinding ? { nativeBinding: context.nativeBinding } : undefined);
	try {
		switch (name) {
			case "perf_coverage_refresh": return db.refreshCoverage(inventoryTrackedProductionFiles(context.cwd ?? process.cwd(), context.inventoryDependencies));
			case "perf_coverage_get_modules_to_scan": return db.listCoverage({ states: input.states as string[] | undefined, kinds: input.kinds as string[] | undefined, limit: input.limit as number | undefined });
			case "perf_coverage_mark_module_as": return db.markCoverage(input as Parameters<typeof db.markCoverage>[0]);
			case "perf_coverage_get_attempts": return db.listAttempts({ activeOnly: input.activeOnly as boolean | undefined, limit: input.limit as number | undefined });
			case "perf_coverage_upsert_cross_cutting_unit": return db.upsertCrossCutting(input as unknown as CrossCuttingInput);
			case "perf_hypothesis_search": return db.searchHypotheses(input as Parameters<typeof db.searchHypotheses>[0]);
			case "perf_hypothesis_create": return db.createHypothesis(input as unknown as HypothesisInput);
			case "perf_hypothesis_merge": return db.mergeHypothesis(String(input.hypothesisId ?? ""), input as unknown as HypothesisMergeInput);
			case "perf_hypothesis_get_highest_priority": return db.highestPriority(input.limit as number | undefined);
			case "perf_hypothesis_get_goal_payload": {
				const hypothesisId = String(input.hypothesisId ?? "");
				return {
					hypothesis: db.hypothesisById(hypothesisId),
					metadata: { "performance-optimisation": { hypothesisId } },
					inlineWorkflow: EXPLORE_HYPOTHESIS_INLINE_WORKFLOW,
				};
			}
			case "perf_hypothesis_mark_goal_creation": return db.markGoalCreation(String(input.hypothesisId ?? ""), String(input.state ?? ""), String(input.directorSessionId ?? ""), input.summary as string | undefined);
			case "perf_hypothesis_link_goal": return db.linkGoal(String(input.hypothesisId ?? ""), String(input.goalId ?? ""));
			case "perf_hypothesis_record_outcome": return db.recordOutcome(String(input.hypothesisId ?? ""), input as unknown as OutcomeInput);
			case "perf_benchmark_register": return db.registerBenchmark(input as unknown as BenchmarkReferenceInput);
			case "perf_benchmark_sync": {
				const benchmarks = input.benchmarks;
				if (!Array.isArray(benchmarks) || benchmarks.length > 100) throw new PerformanceDatabaseError("VALIDATION_FAILED", "benchmarks must contain at most 100 descriptors");
				return { items: benchmarks.map(item => db.registerBenchmark(record(item) as unknown as BenchmarkReferenceInput)), revision: db.revision() };
			}
			case "perf_benchmark_list": return db.listBenchmarks({ hypothesisId: input.hypothesisId as string | undefined, scanUnitId: input.scanUnitId as string | undefined, limit: input.limit as number | undefined });
			case "perf_benchmark_record_run": return db.recordBenchmarkRun(input as unknown as BenchmarkRunInput);
			case "perf_programme_get_session_context": {
				const sessionId = context.sessionId ?? process.env.BOBBIT_SESSION_ID;
				if (!sessionId) throw new PerformanceDatabaseError("INVALID_BINDING", "gateway-issued current session identity is unavailable");
				return { sessionId };
			}
			case "perf_programme_get_settings": return db.programmeStatus();
			case "perf_programme_set_settings": return db.configureProgramme(input as ProgrammeSettingsInput);
			case "perf_programme_get_activity": return db.activity(input.limit as number | undefined);
		}
	} finally {
		db.close();
	}
}

export function formatPerformanceToolError(error: unknown): { error: true; code: string; message: string } {
	if (error instanceof PerformanceDatabaseError) return { error: true, code: error.code, message: error.message };
	return { error: true, code: "PERFORMANCE_TOOL_FAILED", message: "The performance registry operation failed without committing changes." };
}
