import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { normalizeWorkflow, type Workflow } from "./workflow-store.js";
import { readDeletionTombstones, recordDeletionTombstone } from "./deletion-tombstones.js";
import { CoalescedJsonWriter } from "./coalesced-json-writer.js";

export type GoalState = "todo" | "in-progress" | "complete" | "shelved" | "blocked";

/** Durable visible scheduler terminal/circuit-breaker recovery state. */
export interface PersistedSchedulerRecovery {
	kind: "child" | "root";
	/** Durable restart targets for a root circuit-breaker recovery. */
	affectedChildGoalIds?: string[];
	code: string;
	reason: string;
	retryable: boolean;
	updatedAt: number;
}

/** Authoritative lifecycle for goal worktree setup. */
export type SetupStatus = "ready" | "preparing" | "retrying" | "error";

export interface PersistedGoal {
	id: string;
	title: string;
	cwd: string;
	state: GoalState;
	/** Markdown spec content (inline) */
	spec: string;
	createdAt: number;
	updatedAt: number;
	/** Git worktree path (if goal has its own worktree) */
	worktreePath?: string;
	/** Git branch name for this goal's worktree */
	branch?: string;
	/** The original repo path (for worktree cleanup) */
	repoPath?: string;
	/** Which project this goal belongs to */
	projectId?: string;
	/** Whether this is a team goal with Team Lead orchestration */
	team?: boolean;
	/** Session ID of the Team Lead agent (for team goals) */
	teamLeadSessionId?: string;
	/** Gate types to skip requirement enforcement for */
	skipGateRequirements?: string[];
	/** ID of the workflow template this goal was created from */
	workflowId?: string;
	/** Frozen snapshot of the workflow at goal creation time */
	workflow?: Workflow;
	/** Worktree setup status: ready (done/not needed), preparing/retrying (in progress), error (failed) */
	setupStatus?: SetupStatus;
	/** Error message when setupStatus === "error" */
	setupError?: string;
	/** Visible scheduler terminal/circuit-breaker recovery state. Cleared by a new scheduler request. */
	schedulerRecovery?: PersistedSchedulerRecovery;
	/**
	 * Arbitrary, hierarchically-inherited per-goal metadata (namespaced keys,
	 * e.g. `bobbit.disabledProviders`, `bobbit.disabledTools`,
	 * `bobbit.promptSectionOrder`, `hindsight.memory.enabled`). Resolved via
	 * `resolveGoalMetadata` which deep-merges ancestors → self. Absent ⇒
	 * current behaviour at every edge. See docs/design/goal-metadata.md.
	 */
	metadata?: Record<string, unknown>;
	/** If this goal is a re-attempt of another goal, the original goal's ID */
	reattemptOf?: string;
	/** Whether this goal has been archived (soft-deleted) */
	archived?: boolean;
	/** Epoch ms when the goal was archived */
	archivedAt?: number;
	/** Whether team agents should run in Docker sandbox */
	sandboxed?: boolean;
	/** Whether to automatically start the team after worktree setup (defaults to true) */
	autoStartTeam?: boolean;
	/** Names of optional verification steps enabled for this goal */
	enabledOptionalSteps?: string[];
	/** Per-repo worktree paths (multi-repo only). Single-repo uses flat worktreePath. */
	repoWorktrees?: Record<string, string>;

	// ── Nested goals & DAG subgoals (Phase 1 data model) ─────────────────
	// All fields below are optional and lazy-migrated. Top-level (non-nested)
	// goals leave them undefined; the data layer never backfills defaults —
	// callers compute defaults at use sites. See docs/goals-workflows-tasks.md
	// "Nested goals (Phase 1 data model)".

	/** Parent goal ID (undefined for root goals). */
	parentGoalId?: string;
	/** Root of this goal's tree (== id for root, == parent's rootGoalId for children). */
	rootGoalId?: string;
	/** Where this goal's branch merges: "master" for root, "parent" for children. Auto-derived at createGoal. */
	mergeTarget?: "master" | "parent";
	/** Mutation policy for post-freeze plan changes. Default "balanced". Only meaningful on root. */
	divergencePolicy?: "strict" | "balanced" | "autonomous";
	/** Max parallel children across the tree. Only meaningful on root. Default 3, hard max 8. */
	maxConcurrentChildren?: number;
	/** Acceptance criteria parsed from spec, used by criteria-coverage check. */
	acceptanceCriteria?: string[];
	/** Subgoal idempotency key — set immediately after createGoal in runSubgoalStep (stamp `spawnedFromPlanId` IMMEDIATELY after createGoal — no awaits between). */
	spawnedFromPlanId?: string;
	/**
	 * Sibling planIds this child depends on (Phase 5 — explicit DAG). Empty
	 * or undefined → the child is a parallel sibling at column 0. Stamped
	 * at spawn-time alongside `spawnedFromPlanId`. Validated upstream by
	 * `depends-on-validation.ts` (no self-deps, no unknown refs, no cycles).
	 */
	dependsOnPlanIds?: string[];
	/**
	 * Paused flag — user can pause a goal mid-flight (children may inherit via cascade).
	 * Paused children do NOT count as in-flight for `anyInFlightChild`/parent nudge
	 * suppression — paused != failed; the parent (or user) must act before the child can resume.
	 */
	paused?: boolean;
	/**
	 * Why a goal is paused. Operator provenance preserves an explicit pause across
	 * boot-time legacy dependency-pause migration; absent values are legacy records.
	 */
	pauseSource?: "operator" | "legacy-deps";
	/** Increments on every successful post-freeze mutation. > 5 triggers auto-pause. */
	replanCount?: number;
	/**
	 * Durable merge-conflict flag for child goals. Set `true` when this child's
	 * branch fails to merge into its parent's branch (conflict) on either the
	 * integrate-child REST path or the runSubgoalStep harness path. Cleared to
	 * `false` on a subsequent successful merge and on resume/retry of the child.
	 *
	 * This is a DATA CONTRACT consumed by the dashboard Plan-tab frontend
	 * (`GET /descendants` exposes it per-descendant) — do not rename. Only
	 * meaningful on non-root (child) goals.
	 */
	mergeConflict?: boolean;
	/**
	 * Optional role hint set by `goal_spawn_child` when the parent specifies
	 * which role should pick up the child first. Read by the child team-lead's
	 * system prompt to bias the first delegation; not enforced — the team-lead
	 * is free to pick a different role if the work demands it.
	 */
	suggestedRole?: string;
	/**
	 * The team-lead session id that spawned this child via `goal_spawn_child`
	 * (or the equivalent fallback path). Lets the sidebar render sub-goals
	 * visually under their spawning team-lead, so collapsing the team-lead
	 * also hides the sub-goals it spawned (matches the user's mental model
	 * — "this team-lead owns this work"). Optional — sub-goals created via
	 * REST without a session context (E2E tests, manual user clicks) leave
	 * this undefined and render at the parent-goal level as before.
	 */
	spawnedBySessionId?: string;
	/**
	 * Ephemeral role definitions snapshotted onto this goal at creation time.
	 * Resolved BEFORE the project/server/builtin role-store cascade by
	 * `resolveRole(goal, name, roleStore)` (src/server/agent/resolve-role.ts).
	 *
	 * Mirrors the `goal.workflow` snapshot pattern: the live store is bypassed
	 * for any name present here, so the goal's verification gates and team
	 * spawns can use one-off roles that don't pollute the project's role
	 * library. Subsequent edits to the project's role store don't affect
	 * already-running goals — the snapshot is frozen.
	 *
	 * Inheritance: when `goal_spawn_child` spawns a child, the parent's
	 * `inlineRoles` are merged into the child's (`{...parent, ...body}`),
	 * with the child's own additions overriding parent definitions of the
	 * same name. See server.ts spawn-child handler.
	 */
	inlineRoles?: Record<string, import("./role-store.js").Role>;

	// ── Subgoal nesting-limit overrides (per-goal) ───────────────────────
	// Both optional, lazy-migrated to undefined. System prefs supply
	// defaults; per-goal values are TIGHTENING overrides only (the system
	// pref is the ceiling). See subgoal-nesting-limit.ts.

	/** Per-goal subgoals-allowed override. `false` disables even when system ON. */
	subgoalsAllowed?: boolean;
	/** Per-goal max nesting depth override (root=1, +1 per hop). Cannot exceed system pref. */
	maxNestingDepth?: number;
}

interface GoalWriteMetrics {
	bytes: number;
	durationMs: number;
}

interface GoalPersistence {
	loadInto(goals: Map<string, PersistedGoal>): void;
	schedule(ids: Iterable<string>): void;
	publishStrict(ids: Iterable<string>): Promise<void>;
	flush(): Promise<void>;
	close(): Promise<void>;
	dispose(): void;
	getLastWriteMetrics(): GoalWriteMetrics | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Apply the exact historical repairs that the JSON store has always applied. */
function canonicalizeGoal(value: Record<string, unknown>): Record<string, unknown> {
	if (value.swarm !== undefined && value.team === undefined) {
		value.team = value.swarm;
		delete value.swarm;
	}
	if (value.skipArtifactRequirements && !value.skipGateRequirements) {
		value.skipGateRequirements = value.skipArtifactRequirements;
		delete value.skipArtifactRequirements;
	}
	if (!value.setupStatus) value.setupStatus = "ready";
	// An active diagnostic belongs exclusively to the terminal failure state.
	// Clear stale errors while loading recovered JSON and SQLite records.
	if (value.setupStatus !== "error") delete value.setupError;
	delete value.worktreeSetupCommand;
	delete value.worktreeSetupTimeoutMs;
	if (value.metadata !== undefined && !isRecord(value.metadata)) {
		console.warn(`[goal-store] Dropping malformed metadata on goal ${String(value.id)}`);
		delete value.metadata;
	}
	if (value.inlineRoles !== undefined && !isRecord(value.inlineRoles)) {
		console.warn(`[goal-store] Dropping malformed inlineRoles on goal ${String(value.id)}`);
		delete value.inlineRoles;
	}
	if (isRecord(value.workflow)) {
		const gates = value.workflow.gates;
		const needsNormalize = Array.isArray(gates) && gates.some(gate => isRecord(gate) && !Array.isArray(gate.dependsOn));
		if (needsNormalize) {
			const normalized = normalizeWorkflow(value.workflow, typeof value.workflow.id === "string" && value.workflow.id
				? value.workflow.id
				: typeof value.workflowId === "string" ? value.workflowId : "");
			if (normalized) value.workflow = normalized;
		}
	}
	return value;
}

const GOAL_STATES = new Set<GoalState>(["todo", "in-progress", "complete", "shelved", "blocked"]);
const SETUP_STATUSES = new Set<SetupStatus>(["ready", "preparing", "retrying", "error"]);
const MERGE_TARGETS = new Set(["master", "parent"]);
const DIVERGENCE_POLICIES = new Set(["strict", "balanced", "autonomous"]);
const STRING_FIELDS = [
	"worktreePath", "branch", "repoPath", "projectId", "teamLeadSessionId", "setupError",
	"reattemptOf", "parentGoalId", "rootGoalId", "spawnedFromPlanId", "suggestedRole", "spawnedBySessionId",
] as const;
const BOOLEAN_FIELDS = [
	"team", "archived", "sandboxed", "autoStartTeam", "paused", "mergeConflict", "subgoalsAllowed",
] as const;
const NUMBER_FIELDS = ["archivedAt", "maxConcurrentChildren", "replanCount", "maxNestingDepth"] as const;
const STRING_ARRAY_FIELDS = [
	"skipGateRequirements", "enabledOptionalSteps", "acceptanceCriteria", "dependsOnPlanIds",
] as const;

function invalidGoal(label: string, detail: string): never {
	throw new Error(`[goal-store] Invalid ${label}: ${detail}`);
}

function validateStringArray(value: unknown, label: string): void {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) invalidGoal(label, "must be an array of strings");
}

function validateStringRecord(value: unknown, label: string): void {
	if (!isRecord(value) || Object.values(value).some(item => typeof item !== "string")) {
		invalidGoal(label, "must be an object with string values");
	}
}

function validateWorkflow(value: unknown, label: string): void {
	if (!isRecord(value)) invalidGoal(label, "must be an object");
	for (const field of ["id", "name", "description"] as const) {
		if (typeof value[field] !== "string") invalidGoal(label, `${field} must be a string`);
	}
	for (const field of ["createdAt", "updatedAt"] as const) {
		if (!Number.isFinite(value[field])) invalidGoal(label, `${field} must be finite`);
	}
	if (value.hidden !== undefined && typeof value.hidden !== "boolean") invalidGoal(label, "hidden must be boolean");
	if (!Array.isArray(value.gates)) invalidGoal(label, "gates must be an array");
	for (let gateIndex = 0; gateIndex < value.gates.length; gateIndex++) {
		const gate = value.gates[gateIndex];
		const gateLabel = `${label} gate at index ${gateIndex}`;
		if (!isRecord(gate) || typeof gate.id !== "string" || !gate.id || typeof gate.name !== "string") {
			invalidGoal(gateLabel, "id and name are required strings");
		}
		validateStringArray(gate.dependsOn, `${gateLabel} dependsOn`);
		for (const field of ["content", "injectDownstream", "optional", "manual"] as const) {
			if (gate[field] !== undefined && typeof gate[field] !== "boolean") invalidGoal(gateLabel, `${field} must be boolean`);
		}
		if (gate.metadata !== undefined) validateStringRecord(gate.metadata, `${gateLabel} metadata`);
		if (gate.verify !== undefined) {
			if (!Array.isArray(gate.verify)) invalidGoal(gateLabel, "verify must be an array");
				// Verify-step types have changed over time (for example the retired
				// remote-state and integration-test types). A legacy goal stays valid as
				// long as the step discriminator is a non-empty string — mirror the
				// gate-store's tolerance so a retired type cannot brick the migration.
			for (let stepIndex = 0; stepIndex < gate.verify.length; stepIndex++) {
				const step = gate.verify[stepIndex];
				const stepLabel = `${gateLabel} verify step at index ${stepIndex}`;
				if (!isRecord(step) || typeof step.name !== "string"
					|| typeof step.type !== "string" || step.type.length === 0) {
					invalidGoal(stepLabel, "name and a non-empty type are required");
				}
				for (const field of ["run", "prompt", "label", "optionalLabel", "role", "description", "failureGuidance", "component", "command"] as const) {
					if (step[field] !== undefined && typeof step[field] !== "string") invalidGoal(stepLabel, `${field} must be a string`);
				}
				if (step.expect !== undefined && step.expect !== "success" && step.expect !== "failure") invalidGoal(stepLabel, "expect is unsupported");
				if (step.timeout !== undefined && !Number.isFinite(step.timeout)) invalidGoal(stepLabel, "timeout must be finite");
				if (step.phase !== undefined && !Number.isFinite(step.phase)) invalidGoal(stepLabel, "phase must be finite");
				if (step.optional !== undefined && typeof step.optional !== "boolean") invalidGoal(stepLabel, "optional must be boolean");
				if (step.subgoal !== undefined) {
					if (!isRecord(step.subgoal)
						|| typeof step.subgoal.planId !== "string"
						|| typeof step.subgoal.title !== "string"
						|| typeof step.subgoal.spec !== "string") invalidGoal(stepLabel, "subgoal has an invalid shape");
					for (const field of ["workflowId", "suggestedRole"] as const) {
						if (step.subgoal[field] !== undefined && typeof step.subgoal[field] !== "string") invalidGoal(stepLabel, `subgoal ${field} must be a string`);
					}
					if (step.subgoal.dependsOn !== undefined) validateStringArray(step.subgoal.dependsOn, `${stepLabel} subgoal dependsOn`);
				}
			}
		}
	}
}

function validateInlineRoles(value: unknown, label: string): void {
	if (!isRecord(value)) invalidGoal(label, "must be an object");
	for (const [name, role] of Object.entries(value)) {
		if (!isRecord(role) || typeof role.name !== "string" || role.name !== name
			|| typeof role.label !== "string" || typeof role.promptTemplate !== "string") {
			invalidGoal(`${label} role ${name}`, "must have matching name, label, and promptTemplate");
		}
		for (const field of ["accessory", "model", "thinkingLevel"] as const) {
			if (role[field] !== undefined && typeof role[field] !== "string") invalidGoal(`${label} role ${name}`, `${field} must be a string`);
		}
		for (const field of ["createdAt", "updatedAt"] as const) {
			if (role[field] !== undefined && !Number.isFinite(role[field])) invalidGoal(`${label} role ${name}`, `${field} must be finite`);
		}
		if (role.toolPolicies !== undefined) validateStringRecord(role.toolPolicies, `${label} role ${name} toolPolicies`);
	}
}

function validateGoal(
	value: unknown,
	label: string,
	expectedId?: string,
	applyCanonicalization = true,
	validateSerialization = true,
): PersistedGoal {
	if (!isRecord(value)) invalidGoal(label, "must be an object");
	if (applyCanonicalization) canonicalizeGoal(value);
	if (typeof value.id !== "string" || value.id.length === 0) invalidGoal(label, "id must be a non-empty string");
	if (expectedId !== undefined && value.id !== expectedId) throw new Error(`[goal-store] SQLite row identity mismatch for ${expectedId}`);
	for (const field of ["title", "cwd", "spec"] as const) {
		if (typeof value[field] !== "string") invalidGoal(label, `${field} must be a string`);
	}
	if (typeof value.state !== "string" || !GOAL_STATES.has(value.state as GoalState)) invalidGoal(label, `unsupported state ${String(value.state)}`);
	for (const field of ["createdAt", "updatedAt"] as const) {
		if (!Number.isFinite(value[field])) invalidGoal(label, `${field} must be finite`);
	}
	for (const field of STRING_FIELDS) if (value[field] !== undefined && typeof value[field] !== "string") invalidGoal(label, `${field} must be a string`);
	if (value.workflowId !== undefined && value.workflowId !== null && typeof value.workflowId !== "string") {
		invalidGoal(label, "workflowId must be a string or null");
	}
	for (const field of BOOLEAN_FIELDS) if (value[field] !== undefined && typeof value[field] !== "boolean") invalidGoal(label, `${field} must be boolean`);
	for (const field of NUMBER_FIELDS) if (value[field] !== undefined && !Number.isFinite(value[field])) invalidGoal(label, `${field} must be finite`);
	for (const field of STRING_ARRAY_FIELDS) if (value[field] !== undefined) validateStringArray(value[field], `${label} ${field}`);
	if (value.setupStatus !== undefined && (typeof value.setupStatus !== "string" || !SETUP_STATUSES.has(value.setupStatus as SetupStatus))) invalidGoal(label, "setupStatus is unsupported");
	if (value.mergeTarget !== undefined && (typeof value.mergeTarget !== "string" || !MERGE_TARGETS.has(value.mergeTarget))) invalidGoal(label, "mergeTarget is unsupported");
	if (value.divergencePolicy !== undefined && (typeof value.divergencePolicy !== "string" || !DIVERGENCE_POLICIES.has(value.divergencePolicy))) invalidGoal(label, "divergencePolicy is unsupported");
	if (value.metadata !== undefined && !isRecord(value.metadata)) invalidGoal(label, "metadata must be an object");
	if (value.repoWorktrees !== undefined) validateStringRecord(value.repoWorktrees, `${label} repoWorktrees`);
	if (value.inlineRoles !== undefined) validateInlineRoles(value.inlineRoles, `${label} inlineRoles`);
	if (value.workflow !== undefined && value.workflow !== null) validateWorkflow(value.workflow, `${label} workflow`);
	if (validateSerialization) {
		try {
			if (JSON.stringify(value) === undefined) invalidGoal(label, "must be JSON serializable");
		} catch (error) {
			invalidGoal(label, `must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return value as unknown as PersistedGoal;
}

function serializeGoalForPublication(goal: PersistedGoal, dirtyId: string): string {
	const label = `runtime goal ${dirtyId}`;
	const payload = JSON.stringify(goal);
	if (payload === undefined) invalidGoal(label, "must be JSON serializable");

	// Validate the exact bytes being published so a toJSON hook cannot bypass
	// known-field or dirty-key identity checks. Then prove those same bytes remain
	// valid after authoritative reload applies historical canonicalization. Both
	// checks stay confined to the parsed temporary object; publish the original
	// payload without mutating or reserializing the in-memory goal.
	const serializedGoal: unknown = JSON.parse(payload);
	validateGoal(serializedGoal, label, dirtyId, false, false);
	validateGoal(serializedGoal, label, dirtyId, true, false);
	return payload;
}

function parseGoalArray(text: string, sourceLabel: string): PersistedGoal[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`[goal-store] Failed to parse ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed)) throw new Error(`[goal-store] ${sourceLabel} must contain an array`);
	const seen = new Set<string>();
	return parsed.map((value, index) => {
		const goal = validateGoal(value, `${sourceLabel === "goals.json" ? "legacy goal" : "recovery goal"} at index ${index}`);
		if (seen.has(goal.id)) throw new Error(`[goal-store] Duplicate ${sourceLabel} goal ${goal.id}`);
		seen.add(goal.id);
		return goal;
	});
}

class JsonGoalPersistence implements GoalPersistence {
	private readonly writer: CoalescedJsonWriter;
	private readonly storeFile: string;

	constructor(private readonly fs: FsLike, stateDir: string, goals: Map<string, PersistedGoal>) {
		this.storeFile = path.join(stateDir, "goals.json");
		this.writer = new CoalescedJsonWriter(fs, stateDir, this.storeFile,
			() => JSON.stringify(Array.from(goals.values())), "goal-store");
	}

	loadInto(goals: Map<string, PersistedGoal>): void {
		try {
			if (!this.fs.existsSync(this.storeFile)) return;
			const data = JSON.parse(this.fs.readFileSync(this.storeFile, "utf-8"));
			if (!Array.isArray(data)) return;
			for (const value of data) {
				if (!isRecord(value) || !value.id) continue;
				const goal = canonicalizeGoal(value) as unknown as PersistedGoal;
				goals.set(goal.id, goal);
			}
		} catch (error) {
			console.error("[goal-store] Failed to load persisted goals:", error);
		}
	}

	schedule(_ids: Iterable<string>): void { this.writer.schedule(); }
	publishStrict(_ids: Iterable<string>): Promise<void> { return this.writer.publishStrict(); }
	flush(): Promise<void> { return this.writer.flush(); }
	async close(): Promise<void> { await this.writer.flush(); }
	dispose(): void { /* no persistent handle */ }
	getLastWriteMetrics(): GoalWriteMetrics | null { return this.writer.getLastWriteMetrics(); }
}

type GoalWriteBarrier = { revision: number; resolve: () => void; reject: (error: unknown) => void };
type ValidatedGoalRow = { id: string; payload: string; goal: PersistedGoal };

const nodeRequire = createRequire(import.meta.url);
const GOAL_SQLITE_SCHEMA_VERSION = 1;
const GOAL_SQLITE_DEBOUNCE_MS = 500;
const GOAL_SQLITE_CLOSE_ATTEMPTS = 2;
const GOAL_MIGRATION_COMPLETE_KEY = "migration_complete";
const GOAL_RECOVERY_COMPLETE_KEY = "pre_migration_recovery_complete";
const GOAL_LEGACY_RETIREMENT_KEY = "pending_retirement:goals.json";
const GOAL_RECOVERY_RETIREMENT_KEY = "pending_retirement:goals.json.pre-migration";

class SqliteGoalPersistence implements GoalPersistence {
	private readonly db: Database.Database;
	private readonly legacyFile: string;
	private readonly dirty = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inFlight: Promise<void> | null = null;
	private requested = false;
	private revision = 0;
	private publishedRevision = 0;
	private barriers: GoalWriteBarrier[] = [];
	private lastWriteMetrics: GoalWriteMetrics | null = null;
	private closePromise: Promise<void> | null = null;
	private closed = false;

	constructor(private readonly fs: FsLike, private readonly stateDir: string, private readonly goals: Map<string, PersistedGoal>) {
		fs.mkdirSync(stateDir, { recursive: true });
		this.legacyFile = path.join(stateDir, "goals.json");
		let BetterSqlite: new (filename: string, options?: Database.Options) => Database.Database;
		try {
			BetterSqlite = nodeRequire("better-sqlite3") as typeof BetterSqlite;
		} catch (error) {
			throw new Error(`[goal-store] Failed to load the better-sqlite3 native binding for ${process.platform}-${process.arch}; reinstall Bobbit on a supported platform`, { cause: error });
		}
		this.db = new BetterSqlite(path.join(stateDir, "goals.sqlite"), { timeout: 5_000 });
		try { this.initialize(); } catch (error) { this.db.close(); throw error; }
	}

	private initialize(): void {
		const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
		if (version > GOAL_SQLITE_SCHEMA_VERSION) throw new Error(`[goal-store] Unsupported goals.sqlite schema ${version}`);
		this.db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
		if (version === 0) {
			this.db.exec("BEGIN IMMEDIATE");
			try {
				this.db.exec(`
					CREATE TABLE goal_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
					CREATE TABLE goal_records (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
					PRAGMA user_version = ${GOAL_SQLITE_SCHEMA_VERSION};
				`);
				this.db.exec("COMMIT");
			} catch (error) {
				if (this.db.inTransaction) this.db.exec("ROLLBACK");
				throw error;
			}
		}
		const marker = this.getMeta(GOAL_MIGRATION_COMPLETE_KEY);
		if (marker === undefined) this.migrateLegacyOrInitialize();
		else if (marker !== "1") throw new Error(`[goal-store] Invalid goals.sqlite migration marker ${marker}`);
		const rows = this.readValidatedRows();
		this.retirePendingSources();
		this.recoverPreMigration(rows);
	}

	private getMeta(key: string): string | undefined {
		return (this.db.prepare("SELECT value FROM goal_store_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
	}

	private setMeta(key: string, value: string): void {
		this.db.prepare(`INSERT INTO goal_store_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
	}

	private readValidatedRows(): ValidatedGoalRow[] {
		const rows: ValidatedGoalRow[] = [];
		const seen = new Set<string>();
		for (const row of this.db.prepare("SELECT id, payload FROM goal_records ORDER BY id").iterate() as Iterable<{ id: string; payload: string }>) {
			let parsed: unknown;
			try { parsed = JSON.parse(row.payload); }
			catch (error) { throw new Error(`[goal-store] Invalid SQLite payload for ${row.id}: ${error instanceof Error ? error.message : String(error)}`); }
			const goal = validateGoal(parsed, `SQLite payload for ${row.id}`, row.id);
			if (seen.has(goal.id)) throw new Error(`[goal-store] Duplicate SQLite identity ${goal.id}`);
			seen.add(goal.id);
			rows.push({ id: row.id, payload: row.payload, goal });
		}
		return rows;
	}

	private verifyRows(expected: Map<string, string>): void {
		const actual = new Map(this.readValidatedRows().map(row => [row.id, row.payload]));
		if (actual.size !== expected.size) throw new Error(`[goal-store] SQLite import verification count mismatch: expected ${expected.size}, got ${actual.size}`);
		for (const [id, payload] of expected) if (actual.get(id) !== payload) throw new Error(`[goal-store] SQLite import verification failed for ${id}`);
	}

	private readSource(file: string, sourceLabel: string): PersistedGoal[] {
		return parseGoalArray(this.fs.readFileSync(file, "utf-8"), sourceLabel);
	}

	private migrateLegacyOrInitialize(): void {
		const count = (this.db.prepare("SELECT COUNT(*) AS count FROM goal_records").get() as { count: number }).count;
		if (count !== 0) throw new Error("[goal-store] goals.sqlite contains records without a completed migration marker");
		const recoveryFile = `${this.legacyFile}.pre-migration`;
		const hadLegacy = this.fs.existsSync(this.legacyFile);
		const hadRecovery = this.fs.existsSync(recoveryFile);
		const recovery = hadRecovery ? this.readSource(recoveryFile, "goals.json.pre-migration") : [];
		const legacy = hadLegacy ? this.readSource(this.legacyFile, "goals.json") : [];
		const tombstones = readDeletionTombstones(this.stateDir, "goals.json");
		const merged = new Map<string, PersistedGoal>();
		for (const goal of recovery) if (!tombstones.has(goal.id)) merged.set(goal.id, goal);
		for (const goal of legacy) merged.set(goal.id, goal);
		const expected = new Map([...merged].map(([id, goal]) => [id, JSON.stringify(goal)]));
		const insert = this.db.prepare("INSERT INTO goal_records(id, payload) VALUES (?, ?)");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const goal of merged.values()) insert.run(goal.id, JSON.stringify(goal));
			this.verifyRows(expected);
			this.setMeta(GOAL_MIGRATION_COMPLETE_KEY, "1");
			if (hadLegacy) this.setMeta(GOAL_LEGACY_RETIREMENT_KEY, "1");
			if (hadRecovery) {
				this.setMeta(GOAL_RECOVERY_COMPLETE_KEY, "1");
				this.setMeta(GOAL_RECOVERY_RETIREMENT_KEY, "1");
			}
			this.db.exec("COMMIT");
		} catch (error) {
			if (this.db.inTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private recoverPreMigration(existingRows: ValidatedGoalRow[]): void {
		const recoveryFile = `${this.legacyFile}.pre-migration`;
		if (!this.fs.existsSync(recoveryFile) || this.getMeta(GOAL_RECOVERY_COMPLETE_KEY) === "1") return;
		const recovery = this.readSource(recoveryFile, "goals.json.pre-migration");
		const tombstones = readDeletionTombstones(this.stateDir, "goals.json");
		const expected = new Map(existingRows.map(row => [row.id, row.payload]));
		const eligible = recovery.filter(goal => expected.has(goal.id) || !tombstones.has(goal.id));
		for (const goal of eligible) if (!expected.has(goal.id)) expected.set(goal.id, JSON.stringify(goal));
		const insert = this.db.prepare("INSERT INTO goal_records(id, payload) VALUES (?, ?) ON CONFLICT(id) DO NOTHING");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const goal of eligible) insert.run(goal.id, JSON.stringify(goal));
			this.verifyRows(expected);
			this.setMeta(GOAL_RECOVERY_COMPLETE_KEY, "1");
			this.setMeta(GOAL_RECOVERY_RETIREMENT_KEY, "1");
			this.db.exec("COMMIT");
		} catch (error) {
			if (this.db.inTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
		this.retirePendingSources();
	}

	private retireSourceWithoutReplace(source: string, preferred: string): void {
		for (let suffix = 0; ; suffix++) {
			const target = suffix === 0 ? preferred : `${preferred}.${suffix}`;
			try { this.fs.linkSync(source, target); }
			catch (error) {
				if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") continue;
				throw error;
			}
			this.fs.unlinkSync(source);
			return;
		}
	}

	private retirePendingSources(): void {
		const pending = [
			{ key: GOAL_LEGACY_RETIREMENT_KEY, source: this.legacyFile, preferred: `${this.legacyFile}.sqlite-retired` },
			{ key: GOAL_RECOVERY_RETIREMENT_KEY, source: `${this.legacyFile}.pre-migration`, preferred: `${this.legacyFile}.pre-migration-recovered` },
		];
		for (const item of pending) {
			const intent = this.getMeta(item.key);
			if (intent === undefined) continue;
			if (intent !== "1") throw new Error(`[goal-store] Invalid retirement intent ${item.key}=${intent}`);
			if (this.fs.existsSync(item.source)) this.retireSourceWithoutReplace(item.source, item.preferred);
			this.db.prepare("DELETE FROM goal_store_meta WHERE key = ?").run(item.key);
		}
	}

	loadInto(goals: Map<string, PersistedGoal>): void {
		for (const row of this.readValidatedRows()) goals.set(row.id, row.goal);
	}

	schedule(ids: Iterable<string>): void {
		this.assertOpen();
		let changed = false;
		for (const id of ids) { this.dirty.add(id); changed = true; }
		if (!changed) return;
		this.revision++;
		this.requested = true;
		if (this.inFlight || this.timer) return;
		this.timer = setTimeout(() => { this.timer = null; void this.startDrain(); }, GOAL_SQLITE_DEBOUNCE_MS);
		this.timer.unref?.();
	}

	flush(): Promise<void> { return this.hasPendingWork() ? this.requestBarrier() : Promise.resolve(); }
	publishStrict(ids: Iterable<string>): Promise<void> {
		this.assertOpen();
		for (const id of ids) this.dirty.add(id);
		return this.requestBarrier();
	}
	getLastWriteMetrics(): GoalWriteMetrics | null { return this.lastWriteMetrics; }
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		if (this.closed) return Promise.resolve();
		this.closePromise = this.flushForClose().finally(() => this.dispose());
		return this.closePromise;
	}
	dispose(): void {
		if (this.timer) { clearTimeout(this.timer); this.timer = null; }
		if (this.closed) return;
		this.closed = true;
		if (this.db.open) this.db.close();
	}

	private assertOpen(): void {
		if (this.closed || this.closePromise) throw new Error("[goal-store] SQLite persistence is closing or closed");
	}
	private hasPendingWork(): boolean { return this.dirty.size > 0 || this.requested || this.inFlight !== null || this.timer !== null; }
	private async flushForClose(): Promise<void> {
		if (!this.hasPendingWork()) return;
		let lastError: unknown;
		for (let attempt = 0; attempt < GOAL_SQLITE_CLOSE_ATTEMPTS; attempt++) {
			try { await this.requestBarrier(true); return; } catch (error) { lastError = error; }
		}
		throw lastError;
	}
	private requestBarrier(allowClosing = false): Promise<void> {
		if (!allowClosing) this.assertOpen();
		const revision = ++this.revision;
		this.requested = true;
		if (this.timer) { clearTimeout(this.timer); this.timer = null; }
		const barrier = new Promise<void>((resolve, reject) => this.barriers.push({ revision, resolve, reject }));
		void this.startDrain();
		return barrier;
	}
	private startDrain(): Promise<void> {
		if (!this.inFlight) {
			this.inFlight = Promise.resolve().then(() => this.drain()).finally(() => {
				this.inFlight = null;
				if (this.requested) queueMicrotask(() => { void this.startDrain(); });
			});
		}
		return this.inFlight;
	}
	private drain(): void {
		while (this.requested) {
			this.requested = false;
			const revision = this.revision;
			const ids = [...this.dirty];
			this.dirty.clear();
			const snapshots = ids.map(id => ({ id, goal: this.goals.get(id) }));
			const startedAt = performance.now();
			let bytes = 0;
			try {
				if (snapshots.length > 0) {
					const upsert = this.db.prepare("INSERT INTO goal_records(id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload");
					const remove = this.db.prepare("DELETE FROM goal_records WHERE id = ?");
					this.db.exec("BEGIN IMMEDIATE");
					for (const snapshot of snapshots) {
						if (!snapshot.goal) { remove.run(snapshot.id); continue; }
						// Validate at the asynchronous publication boundary rather than in
						// public mutators. Invalid runtime data rolls back and requeues the
						// complete dirty batch instead of creating a row that bricks restart.
						const payload = serializeGoalForPublication(snapshot.goal, snapshot.id);
						bytes += Buffer.byteLength(payload);
						upsert.run(snapshot.id, payload);
					}
					this.db.exec("COMMIT");
				}
				this.lastWriteMetrics = { bytes, durationMs: performance.now() - startedAt };
				this.settlePublished(revision);
			} catch (error) {
				if (this.db.inTransaction) try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
				for (const { id } of snapshots) this.dirty.add(id);
				this.settleFailed(revision, error);
				console.error("[goal-store] Failed to save SQLite goals:", error);
				return;
			}
		}
	}
	private settlePublished(revision: number): void {
		this.publishedRevision = Math.max(this.publishedRevision, revision);
		const pending: GoalWriteBarrier[] = [];
		for (const barrier of this.barriers) barrier.revision <= this.publishedRevision ? barrier.resolve() : pending.push(barrier);
		this.barriers = pending;
	}
	private settleFailed(revision: number, error: unknown): void {
		const pending: GoalWriteBarrier[] = [];
		for (const barrier of this.barriers) barrier.revision <= revision ? barrier.reject(error) : pending.push(barrier);
		this.barriers = pending;
	}
}

export interface GoalStoreOptions {
	/** Explicit test adapter; production defaults to SQLite. */
	persistence?: "sqlite" | "json";
}

/** In-memory goal read model backed by JSON fixtures or production SQLite. */
export class GoalStore {
	private readonly storeDir: string;
	private readonly persistence: GoalPersistence;
	private goals: Map<string, PersistedGoal> = new Map();
	private generation = 0;
	private acceptingMutations = true;
	private closePromise: Promise<void> | null = null;

	constructor(stateDir: string, fsImpl: FsLike = realFs, options: GoalStoreOptions = {}) {
		this.storeDir = stateDir;
		const adapter = options.persistence ?? (fsImpl === realFs ? "sqlite" : "json");
		this.persistence = adapter === "json"
			? new JsonGoalPersistence(fsImpl, stateDir, this.goals)
			: new SqliteGoalPersistence(fsImpl, stateDir, this.goals);
		try { this.persistence.loadInto(this.goals); }
		catch (error) { this.persistence.dispose(); throw error; }
	}

	private assertAcceptingMutations(): void {
		if (!this.acceptingMutations) throw new Error("[goal-store] GoalStore is closing or closed");
	}
	private save(ids: Iterable<string>): void { this.persistence.schedule(ids); }
	flush(): Promise<void> { return this.persistence.flush(); }
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.acceptingMutations = false;
		this.closePromise = this.persistence.close();
		return this.closePromise;
	}
	dispose(): void {
		this.acceptingMutations = false;
		this.persistence.dispose();
	}
	getPersistenceMetrics() { return this.persistence.getLastWriteMetrics(); }
	private saveStrict(ids: Iterable<string>): Promise<void> { return this.persistence.publishStrict(ids); }

	/** Current generation counter — bumped on every mutation. */
	getGeneration(): number {
		return this.generation;
	}

	/** Optional callback invoked after any goal mutation (put/update/archive). */
	onIndexUpdate?: (goal: PersistedGoal) => void;

	/**
	 * Called once when a goal id appears in the store for the first time.
	 * Wired by `ProjectContext.setGoalTriggerDispatcher` from `server.ts`.
	 * MUST be assigned independently of `onIndexUpdate` — the search index
	 * relies on the latter and must not be stomped.
	 */
	onGoalCreated?: (goal: PersistedGoal) => void;

	/**
	 * Called once per archive transition (false → true). Idempotent —
	 * a second `archive` call on an already-archived goal does NOT fire.
	 */
	onGoalArchived?: (goal: PersistedGoal) => void;

	/** Bump generation without mutating goal data (e.g. when gate status changes). */
	bumpGeneration(): void {
		this.assertAcceptingMutations();
		this.generation++;
	}

	put(goal: PersistedGoal): void {
		this.assertAcceptingMutations();
		// A whole-record reconciliation cannot reintroduce a stale active error.
		if (goal.setupStatus !== "error") delete goal.setupError;
		// Detect "new id" BEFORE the set so the goal_created callback fires
		// exactly once per id. Subsequent puts (updates) skip the callback.
		const isNew = !this.goals.has(goal.id);
		this.generation++;
		this.goals.set(goal.id, goal);
		this.save([goal.id]);
		this.onIndexUpdate?.(goal);
		if (isNew) this.onGoalCreated?.(goal);
	}

	get(id: string): PersistedGoal | undefined {
		return this.goals.get(id);
	}

	remove(id: string): void {
		this.assertAcceptingMutations();
		this.generation++;
		this.goals.delete(id);
		this.save([id]);
		// Durably tombstone this hard-delete so the boot-time headquarters
		// migration does not resurrect the record from a stale
		// `.pre-headquarters-id-migration` backup on the next restart.
		// NOTE: archive() intentionally does NOT tombstone — it keeps the record.
		recordDeletionTombstone(this.storeDir, "goals.json", id);
	}

	getAll(): PersistedGoal[] {
		return Array.from(this.goals.values());
	}

	archive(id: string): boolean {
		this.assertAcceptingMutations();
		const existing = this.goals.get(id);
		if (!existing) return false;
		// Capture the transition BEFORE mutating so onGoalArchived fires only
		// once. Idempotent: re-archiving an already-archived goal still returns
		// true (back-compat with existing callers) but does NOT re-fire.
		const wasAlreadyArchived = existing.archived === true;
		this.generation++;
		existing.archived = true;
		existing.archivedAt = Date.now();
		this.save([id]);
		this.onIndexUpdate?.(existing);
		if (!wasAlreadyArchived) this.onGoalArchived?.(existing);
		return true;
	}

	/**
	 * Durably publish terminal archive intent before cross-store cleanup starts.
	 * Replays fence an already-archived row without changing its archive time.
	 */
	async archiveStrict(id: string): Promise<boolean> {
		this.assertAcceptingMutations();
		const existing = this.goals.get(id);
		if (!existing) return false;
		if (existing.archived === true) {
			await this.saveStrict([id]);
			return true;
		}

		const previous = { ...existing };
		this.generation++;
		existing.archived = true;
		existing.archivedAt = Date.now();
		try {
			await this.saveStrict([id]);
		} catch (err) {
			this.generation--;
			for (const key of Object.keys(existing)) {
				if (!(key in previous)) delete (existing as unknown as Record<string, unknown>)[key];
			}
			Object.assign(existing, previous);
			throw err;
		}
		this.onIndexUpdate?.(existing);
		this.onGoalArchived?.(existing);
		return true;
	}

	getLive(): PersistedGoal[] {
		return Array.from(this.goals.values()).filter(g => !g.archived);
	}

	getArchived(): PersistedGoal[] {
		return Array.from(this.goals.values()).filter(g => g.archived === true);
	}

	/** Explicit deletion for optional scheduler recovery metadata. `update()`
	 * intentionally strips undefined fields, so clearing must not be expressed as
	 * `{ schedulerRecovery: undefined }`.
	 */
	clearSchedulerRecovery(id: string): boolean {
		this.assertAcceptingMutations();
		const existing = this.goals.get(id);
		if (!existing || existing.schedulerRecovery === undefined) return false;
		this.generation++;
		delete existing.schedulerRecovery;
		existing.updatedAt = Date.now();
		this.save([id]);
		this.onIndexUpdate?.(existing);
		return true;
	}

	/** Normalize updates and enforce the canonical setup state invariant. */
	private prepareUpdate(updates: Partial<Omit<PersistedGoal, "id" | "createdAt">>): {
		cleaned: Record<string, unknown>;
		clearSetupError: boolean;
	} {
		const cleaned: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(updates)) {
			if (value !== undefined) cleaned[key] = value;
		}
		const status = cleaned.setupStatus as SetupStatus | undefined;
		if (status !== undefined && !SETUP_STATUSES.has(status)) {
			throw new Error(`Invalid goal setup status: ${String(status)}`);
		}
		const clearSetupError = status !== undefined && status !== "error";
		if (clearSetupError) delete cleaned.setupError;
		return { cleaned, clearSetupError };
	}

	private hasUpdateChanged(existing: PersistedGoal, cleaned: Record<string, unknown>, clearSetupError: boolean): boolean {
		const record = existing as unknown as Record<string, unknown>;
		return (clearSetupError && existing.setupError !== undefined)
			|| Object.keys(cleaned).some(key => record[key] !== cleaned[key]);
	}

	private applyUpdate(existing: PersistedGoal, cleaned: Record<string, unknown>, clearSetupError: boolean): void {
		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		if (clearSetupError) delete existing.setupError;
	}

	update(id: string, updates: Partial<Omit<PersistedGoal, "id" | "createdAt">>): boolean {
		this.assertAcceptingMutations();
		const existing = this.goals.get(id);
		if (!existing) return false;
		const { cleaned, clearSetupError } = this.prepareUpdate(updates);
		if (!this.hasUpdateChanged(existing, cleaned, clearSetupError)) return true;
		this.generation++;
		this.applyUpdate(existing, cleaned, clearSetupError);
		this.save([id]);
		this.onIndexUpdate?.(existing);
		return true;
	}

	/** Canonical setup transition with an atomic active-error update. */
	transitionSetup(
		id: string,
		status: Exclude<SetupStatus, "error">,
		updates?: Partial<Omit<PersistedGoal, "id" | "createdAt" | "setupStatus" | "setupError">>,
	): boolean;
	transitionSetup(
		id: string,
		status: "error",
		error: string,
		updates?: Partial<Omit<PersistedGoal, "id" | "createdAt" | "setupStatus" | "setupError">>,
	): boolean;
	transitionSetup(
		id: string,
		status: SetupStatus,
		errorOrUpdates?: string | Partial<Omit<PersistedGoal, "id" | "createdAt" | "setupStatus" | "setupError">>,
		maybeUpdates?: Partial<Omit<PersistedGoal, "id" | "createdAt" | "setupStatus" | "setupError">>,
	): boolean {
		const error = status === "error" ? errorOrUpdates as string : undefined;
		const updates = (status === "error" ? maybeUpdates : errorOrUpdates) as Partial<Omit<PersistedGoal, "id" | "createdAt" | "setupStatus" | "setupError">> | undefined;
		if (status === "error" && (typeof error !== "string" || error.trim() === "")) {
			throw new Error("Goal setup error transitions require an actionable error message");
		}
		return this.update(id, { ...updates, setupStatus: status, ...(status === "error" ? { setupError: error } : {}) });
	}

	/**
	 * Update a goal with an awaitable publication fence for lifecycle
	 * transactions. No strict caller can observe success before its snapshot has
	 * won the shared rename queue.
	 */
	async updateStrict(id: string, updates: Partial<Omit<PersistedGoal, "id" | "createdAt">>): Promise<boolean> {
		return this.updateStrictInternal(id, updates);
	}

	/** Strict persistence variant of transitionSetup for readiness boundaries. */
	async transitionSetupStrict(
		id: string,
		status: Exclude<SetupStatus, "error">,
		updates?: Partial<Omit<PersistedGoal, "id" | "createdAt" | "setupStatus" | "setupError">>,
	): Promise<boolean>;
	async transitionSetupStrict(
		id: string,
		status: "error",
		error: string,
		updates?: Partial<Omit<PersistedGoal, "id" | "createdAt" | "setupStatus" | "setupError">>,
	): Promise<boolean>;
	async transitionSetupStrict(
		id: string,
		status: SetupStatus,
		errorOrUpdates?: string | Partial<Omit<PersistedGoal, "id" | "createdAt" | "setupStatus" | "setupError">>,
		maybeUpdates?: Partial<Omit<PersistedGoal, "id" | "createdAt" | "setupStatus" | "setupError">>,
	): Promise<boolean> {
		const error = status === "error" ? errorOrUpdates as string : undefined;
		const updates = (status === "error" ? maybeUpdates : errorOrUpdates) as Partial<Omit<PersistedGoal, "id" | "createdAt" | "setupStatus" | "setupError">> | undefined;
		if (status === "error" && (typeof error !== "string" || error.trim() === "")) {
			throw new Error("Goal setup error transitions require an actionable error message");
		}
		return this.updateStrictInternal(id, { ...updates, setupStatus: status, ...(status === "error" ? { setupError: error } : {}) });
	}

	private async updateStrictInternal(
		id: string,
		updates: Partial<Omit<PersistedGoal, "id" | "createdAt">>,
	): Promise<boolean> {
		this.assertAcceptingMutations();
		const existing = this.goals.get(id);
		if (!existing) return false;
		const { cleaned, clearSetupError } = this.prepareUpdate(updates);
		// A lifecycle caller may be replaying an already-applied state. It still
		// needs a publication fence before the cross-store WAL can be cleared.
		if (!this.hasUpdateChanged(existing, cleaned, clearSetupError)) {
			await this.saveStrict([id]);
			return true;
		}

		const previous = { ...existing };
		this.generation++;
		this.applyUpdate(existing, cleaned, clearSetupError);
		try {
			await this.saveStrict([id]);
		} catch (err) {
			this.generation--;
			for (const key of Object.keys(existing)) {
				if (!(key in previous)) delete (existing as unknown as Record<string, unknown>)[key];
			}
			Object.assign(existing, previous);
			throw err;
		}
		this.onIndexUpdate?.(existing);
		return true;
	}

	/**
	 * Paginated listing of archived goals, sorted by archivedAt DESC.
	 * @param limit Max items per page
	 * @param afterCursor archivedAt timestamp — return items with archivedAt < cursor
	 */
	listArchivedGoalsPaginated(limit: number, afterCursor?: number): { goals: PersistedGoal[]; total: number; hasMore: boolean; nextCursor?: number } {
		let archived = this.getArchived().sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
		const total = archived.length;
		if (afterCursor !== undefined) {
			archived = archived.filter(g => (g.archivedAt ?? 0) < afterCursor);
		}
		const page = archived.slice(0, limit);
		const hasMore = archived.length > limit;
		const nextCursor = page.length > 0 ? page[page.length - 1].archivedAt : undefined;
		return { goals: page, total, hasMore, nextCursor };
	}
}
