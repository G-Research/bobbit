import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import type { Workflow } from "./workflow-store.js";
import type { GateStepDiagnostics } from "../gate-diagnostics.js";
import { CoalescedJsonWriter } from "./coalesced-json-writer.js";
import type { VerificationContentDigest, VerificationContentDigestErrorSummary } from "./verification-content-digest.js";

export type GateStatus = "pending" | "passed" | "failed" | "bypassed";

export interface VerificationTimeoutInfo {
	/** Resolved per-turn review allowance. */
	configuredSeconds: number;
	/** Elapsed time for the specific active turn that exhausted its allowance. */
	elapsedMs: number;
}

export interface GateSignalStep {
	name: string;
	type: "command" | "llm-review" | "agent-qa" | "subgoal" | "human-signoff";
	passed: boolean;
	skipped?: boolean;
	output: string;
	duration_ms: number;
	expect?: "success" | "failure";
	artifact?: {
		content: string;
		contentType: string;
		metadata?: Record<string, string>;
	};
	/** Durable diagnostics for completed command steps, stored under Bobbit state. */
	diagnostics?: GateStepDiagnostics;
	/**
	 * Lifecycle status for in-flight rows and durable terminal verdict for
	 * completed rows. Set on initial enumeration by
	 * `VerificationHarness.beginVerification()` so the gate-store signal
	 * carries useful progress information from the moment it is recorded,
	 * then preserved as `passed`/`failed`/`timeout`/`skipped` for historical rendering.
	 */
	status?: "waiting" | "running" | "passed" | "failed" | "timeout" | "skipped";
	/** Present only when a review turn exhausted its configured allowance. */
	timeout?: VerificationTimeoutInfo;
	/** Optional phase number, mirrored from the workflow VerifyStep for ordering. */
	phase?: number;
}

export type PinnedCheckoutAttestation = {
	/** Existing single-root representation; preserve it byte-for-byte. */
	version: 1;
	commitSha: string;
	contentDigest: VerificationContentDigest;
} | {
	/** A branch-container layout with independently pinned Git repositories. */
	version: 2;
	layout: "multi-repo";
	contentDigest: VerificationContentDigest;
	repositories: readonly {
		repoKey: string;
		commitSha: string;
		contentDigest: VerificationContentDigest;
	}[];
};

export type PinnedCheckoutErrorCode =
	| "PINNED_CHECKOUT_ACQUIRE_FAILED"
	| "PINNED_CHECKOUT_MUTATED"
	| "PINNED_CHECKOUT_UNREADABLE"
	| "PINNED_CHECKOUT_UNSUPPORTED_LAYOUT";

export interface PinnedCheckoutError {
	code: PinnedCheckoutErrorCode;
	/** Fixed, sanitized operator-facing diagnosis; never a filesystem or Git error. */
	message: string;
}

export interface GateSignal {
	id: string;
	gateId: string;
	goalId: string;
	sessionId: string;
	timestamp: number;
	commitSha: string;
	metadata?: Record<string, string>;
	content?: string;
	contentVersion?: number;
	/** Source-byte witness used for cache eligibility; absent on legacy signals. */
	contentDigest?: VerificationContentDigest;
	/** Sanitized durable reason when the source-byte witness could not be computed. */
	contentDigestError?: VerificationContentDigestErrorSummary;
	/** Durable proof that this signal ran from materialized, pinned source bytes. */
	pinnedCheckout?: PinnedCheckoutAttestation;
	/** Sanitized durable reason why a pinned checkout could not attest this signal. */
	pinnedCheckoutError?: PinnedCheckoutError;
	verification: {
		status: "running" | "passed" | "failed";
		steps: GateSignalStep[];
	};
}

export interface GateState {
	gateId: string;
	goalId: string;
	status: GateStatus;
	currentContent?: string;
	currentContentVersion?: number;
	currentMetadata?: Record<string, string>;
	signals: GateSignal[];
	/** Signals at or before this timestamp are ineligible for verification-step cache reuse. */
	verificationCacheInvalidatedAt?: number;
	updatedAt: number;
}

export interface GateResetResult {
	requestedGateId: string;
	affectedGateIds: string[];
	changedGateIds: string[];
	unchangedGateIds: string[];
	previousStatuses: Record<string, GateStatus>;
}

function compositeKey(goalId: string, gateId: string): string {
	return `${goalId}::${gateId}`;
}

interface GateWriteMetrics {
	bytes: number;
	durationMs: number;
}

interface GatePersistence {
	loadInto(gates: Map<string, GateState>): void;
	schedule(keys: Iterable<string>): void;
	publishStrict(keys: Iterable<string>): Promise<void>;
	flush(): Promise<void>;
	close(): Promise<void>;
	dispose(): void;
	getLastWriteMetrics(): GateWriteMetrics | null;
}

/** Existing JSON persistence retained for FsLike-backed unit fixtures. */
class JsonGatePersistence implements GatePersistence {
	private readonly writer: CoalescedJsonWriter;
	private readonly storeFile: string;

	constructor(
		private readonly fs: FsLike,
		stateDir: string,
		gates: Map<string, GateState>,
	) {
		this.storeFile = path.join(stateDir, "gates.json");
		this.writer = new CoalescedJsonWriter(
			fs,
			stateDir,
			this.storeFile,
			() => JSON.stringify(Array.from(gates.values())),
			"gate-store",
		);
	}

	loadInto(gates: Map<string, GateState>): void {
		try {
			if (!this.fs.existsSync(this.storeFile)) return;
			const data = JSON.parse(this.fs.readFileSync(this.storeFile, "utf-8"));
			if (!Array.isArray(data)) return;
			for (const gate of data) {
				if (gate?.gateId && gate?.goalId) gates.set(compositeKey(gate.goalId, gate.gateId), gate);
			}
		} catch (error) {
			console.error("[gate-store] Failed to load persisted gates:", error);
		}
	}

	schedule(_keys: Iterable<string>): void { this.writer.schedule(); }
	publishStrict(_keys: Iterable<string>): Promise<void> { return this.writer.publishStrict(); }
	flush(): Promise<void> { return this.writer.flush(); }
	async close(): Promise<void> { await this.writer.flush(); }
	dispose(): void { /* no persistent handle */ }
	getLastWriteMetrics(): GateWriteMetrics | null { return this.writer.getLastWriteMetrics(); }
}

type GateWriteBarrier = {
	revision: number;
	resolve: () => void;
	reject: (error: unknown) => void;
};

const nodeRequire = createRequire(import.meta.url);
const GATE_SQLITE_SCHEMA_VERSION = 1;
const GATE_SQLITE_FILE = "gates.sqlite";
const GATE_SQLITE_DEBOUNCE_MS = 500;
const GATE_SQLITE_CLOSE_ATTEMPTS = 2;
const GATE_MIGRATION_COMPLETE_KEY = "migration_complete";
const GATE_RECOVERY_COMPLETE_KEY = "pre_migration_recovery_complete";
const GATE_LEGACY_RETIREMENT_KEY = "pending_retirement:gates.json";
const GATE_RECOVERY_RETIREMENT_KEY = "pending_retirement:gates.json.pre-migration";

const GATE_STATUSES = new Set<GateStatus>(["pending", "passed", "failed", "bypassed"]);
const SIGNAL_STATUSES = new Set(["running", "passed", "failed"]);
const STEP_STATUSES = new Set(["waiting", "running", "passed", "failed", "timeout", "skipped"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidGate(label: string, detail: string): never {
	throw new Error(`[gate-store] Invalid ${label}: ${detail}`);
}

function validateStringRecord(value: unknown, label: string): void {
	if (!isRecord(value) || Object.values(value).some(item => typeof item !== "string")) {
		invalidGate(label, "must be an object with string values");
	}
}

function validateDiagnosticLog(value: unknown, label: string): void {
	if (!isRecord(value)
		|| typeof value.path !== "string"
		|| !Number.isFinite(value.bytes)
		|| !Number.isFinite(value.lines)
		|| (value.truncated !== undefined && typeof value.truncated !== "boolean")
		|| (value.truncationReason !== undefined && typeof value.truncationReason !== "string")) {
		invalidGate(label, "has an invalid retained-log shape");
	}
}

function validateDiagnostics(value: unknown, label: string): void {
	if (!isRecord(value)
		|| value.type !== "retained-command-diagnostics"
		|| typeof value.baseDir !== "string"
		|| !Number.isFinite(value.createdAt)
		|| (value.truncated !== undefined && typeof value.truncated !== "boolean")
		|| (value.truncationReason !== undefined && typeof value.truncationReason !== "string")) {
		invalidGate(label, "has an invalid retained-command-diagnostics shape");
	}
	if (value.stdout !== undefined) validateDiagnosticLog(value.stdout, `${label} stdout`);
	if (value.stderr !== undefined) validateDiagnosticLog(value.stderr, `${label} stderr`);
	if (value.artifacts !== undefined) {
		if (!Array.isArray(value.artifacts)) invalidGate(label, "artifacts must be an array");
		for (let index = 0; index < value.artifacts.length; index++) {
			const artifact = value.artifacts[index];
			if (!isRecord(artifact)
				|| typeof artifact.path !== "string"
				|| typeof artifact.relativePath !== "string"
				|| typeof artifact.sourcePath !== "string"
				|| !Number.isFinite(artifact.bytes)
				|| (artifact.kind !== "test-results" && artifact.kind !== "playwright-report")
				|| (artifact.content !== undefined && typeof artifact.content !== "string")
				|| (artifact.contentType !== undefined && typeof artifact.contentType !== "string")) {
				invalidGate(`${label} artifact at index ${index}`, "has an invalid artifact shape");
			}
		}
	}
}

/**
 * Validate known GateState fields without normalizing away historical extensions.
 * The one narrow exception is backfilling a missing verification-step `duration_ms`
 * (see the step loop): human bypasses and hand-recorded manual passes mark a step
 * passed without a timed command run and legitimately omit it.
 */
function validateGateState(value: unknown, label: string, expectedIdentity?: { goalId: string; gateId: string }): GateState {
	if (!isRecord(value)) invalidGate(label, "must be an object");
	if (typeof value.goalId !== "string" || value.goalId.length === 0) invalidGate(label, "goalId must be a non-empty string");
	if (typeof value.gateId !== "string" || value.gateId.length === 0) invalidGate(label, "gateId must be a non-empty string");
	if (expectedIdentity && (value.goalId !== expectedIdentity.goalId || value.gateId !== expectedIdentity.gateId)) {
		throw new Error(`[gate-store] SQLite row identity mismatch for ${expectedIdentity.goalId}/${expectedIdentity.gateId}`);
	}
	if (typeof value.status !== "string" || !GATE_STATUSES.has(value.status as GateStatus)) invalidGate(label, `unsupported status ${String(value.status)}`);
	if (!Number.isFinite(value.updatedAt)) invalidGate(label, "updatedAt must be finite");
	if (!Array.isArray(value.signals)) invalidGate(label, "signals must be an array");
	if (value.currentContent !== undefined && typeof value.currentContent !== "string") invalidGate(label, "currentContent must be a string");
	if (value.currentContentVersion !== undefined && !Number.isFinite(value.currentContentVersion)) invalidGate(label, "currentContentVersion must be finite");
	if (value.currentMetadata !== undefined) validateStringRecord(value.currentMetadata, `${label} currentMetadata`);
	if (value.verificationCacheInvalidatedAt !== undefined && !Number.isFinite(value.verificationCacheInvalidatedAt)) {
		invalidGate(label, "verificationCacheInvalidatedAt must be finite");
	}

	for (let signalIndex = 0; signalIndex < value.signals.length; signalIndex++) {
		const signal = value.signals[signalIndex];
		const signalLabel = `${label} signal at index ${signalIndex}`;
		if (!isRecord(signal)) invalidGate(signalLabel, "must be an object");
		for (const field of ["id", "goalId", "gateId", "sessionId", "commitSha"] as const) {
			if (typeof signal[field] !== "string") invalidGate(signalLabel, `${field} must be a string`);
		}
		if (signal.goalId !== value.goalId || signal.gateId !== value.gateId) invalidGate(signalLabel, "identity must match its gate");
		if (!Number.isFinite(signal.timestamp)) invalidGate(signalLabel, "timestamp must be finite");
		if (signal.metadata !== undefined) validateStringRecord(signal.metadata, `${signalLabel} metadata`);
		if (signal.content !== undefined && typeof signal.content !== "string") invalidGate(signalLabel, "content must be a string");
		if (signal.contentVersion !== undefined && !Number.isFinite(signal.contentVersion)) invalidGate(signalLabel, "contentVersion must be finite");
		if (!isRecord(signal.verification)
			|| typeof signal.verification.status !== "string"
			|| !SIGNAL_STATUSES.has(signal.verification.status)
			|| !Array.isArray(signal.verification.steps)) {
			invalidGate(signalLabel, "verification must have a supported status and steps array");
		}
		for (let stepIndex = 0; stepIndex < signal.verification.steps.length; stepIndex++) {
			const step = signal.verification.steps[stepIndex];
			const stepLabel = `${signalLabel} verification step at index ${stepIndex}`;
			if (!isRecord(step)) invalidGate(stepLabel, "must be an object");
			// Step types have changed over time (for example remote-state and
			// integration-test). Historical signal history remains valid as long as
			// the persisted discriminator is a non-empty string.
			if (typeof step.name !== "string" || typeof step.type !== "string" || step.type.length === 0) invalidGate(stepLabel, "name and type are required");
			// Human bypasses and hand-recorded manual passes mark a step passed
			// without running a timed command, so historical data legitimately omits
			// duration_ms. Backfill the default instead of failing the whole load; a
			// present-but-non-finite value is still corruption and stays rejected.
			if (step.duration_ms === undefined) step.duration_ms = 0;
			if (typeof step.passed !== "boolean" || typeof step.output !== "string" || !Number.isFinite(step.duration_ms)) {
				invalidGate(stepLabel, "passed, output, and finite duration_ms are required");
			}
			if (step.skipped !== undefined && typeof step.skipped !== "boolean") invalidGate(stepLabel, "skipped must be boolean");
			if (step.expect !== undefined && step.expect !== "success" && step.expect !== "failure") invalidGate(stepLabel, "expect is unsupported");
			if (step.status !== undefined && (typeof step.status !== "string" || !STEP_STATUSES.has(step.status))) invalidGate(stepLabel, "status is unsupported");
			if (step.phase !== undefined && !Number.isFinite(step.phase)) invalidGate(stepLabel, "phase must be finite");
			if (step.artifact !== undefined) {
				if (!isRecord(step.artifact) || typeof step.artifact.content !== "string" || typeof step.artifact.contentType !== "string") {
					invalidGate(stepLabel, "artifact must contain string content and contentType");
				}
				if (step.artifact.metadata !== undefined) validateStringRecord(step.artifact.metadata, `${stepLabel} artifact metadata`);
			}
			if (step.diagnostics !== undefined) validateDiagnostics(step.diagnostics, `${stepLabel} diagnostics`);
			if (step.timeout !== undefined) {
				if (!isRecord(step.timeout) || !Number.isFinite(step.timeout.configuredSeconds) || !Number.isFinite(step.timeout.elapsedMs)) {
					invalidGate(stepLabel, "timeout values must be finite");
				}
			}
		}
	}

	try {
		if (JSON.stringify(value) === undefined) invalidGate(label, "must be JSON serializable");
	} catch (error) {
		invalidGate(label, `must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
	}
	return value as unknown as GateState;
}

function parseGateArray(text: string, sourceLabel: string): GateState[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`[gate-store] Failed to parse ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed)) throw new Error(`[gate-store] ${sourceLabel} must contain an array`);
	const seen = new Set<string>();
	return parsed.map((value, index) => {
		const gate = validateGateState(value, `${sourceLabel === "gates.json" ? "legacy gate" : "recovery gate"} at index ${index}`);
		const key = compositeKey(gate.goalId, gate.gateId);
		if (seen.has(key)) throw new Error(`[gate-store] Duplicate ${sourceLabel} gate ${gate.goalId}/${gate.gateId}`);
		seen.add(key);
		return gate;
	});
}

type ValidatedGateRow = { goalId: string; gateId: string; payload: string; gate: GateState };

class SqliteGatePersistence implements GatePersistence {
	private readonly db: Database.Database;
	private readonly legacyFile: string;
	private readonly dirty = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inFlight: Promise<void> | null = null;
	private requested = false;
	private revision = 0;
	private publishedRevision = 0;
	private barriers: GateWriteBarrier[] = [];
	private lastWriteMetrics: GateWriteMetrics | null = null;
	private closePromise: Promise<void> | null = null;
	private closed = false;

	constructor(
		private readonly fs: FsLike,
		stateDir: string,
		private readonly gates: Map<string, GateState>,
	) {
		fs.mkdirSync(stateDir, { recursive: true });
		this.legacyFile = path.join(stateDir, "gates.json");
		let BetterSqlite: new (filename: string, options?: Database.Options) => Database.Database;
		try {
			BetterSqlite = nodeRequire("better-sqlite3") as typeof BetterSqlite;
		} catch (error) {
			throw new Error(
				`[gate-store] Failed to load the better-sqlite3 native binding for ${process.platform}-${process.arch}; reinstall Bobbit on a supported platform`,
				{ cause: error },
			);
		}
		this.db = new BetterSqlite(path.join(stateDir, GATE_SQLITE_FILE), { timeout: 5_000 });
		try {
			this.initialize();
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	private initialize(): void {
		const versionRow = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (versionRow.user_version > GATE_SQLITE_SCHEMA_VERSION) {
			throw new Error(`[gate-store] Unsupported gates.sqlite schema ${versionRow.user_version}`);
		}
		this.db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
		if (versionRow.user_version === 0) {
			this.db.exec("BEGIN IMMEDIATE");
			try {
				this.db.exec(`
					CREATE TABLE gate_store_meta (
						key TEXT PRIMARY KEY,
						value TEXT NOT NULL
					) STRICT, WITHOUT ROWID;
					CREATE TABLE gate_records (
						goal_id TEXT NOT NULL,
						gate_id TEXT NOT NULL,
						payload TEXT NOT NULL,
						PRIMARY KEY (goal_id, gate_id)
					) STRICT;
					CREATE INDEX gate_records_goal_id_idx ON gate_records(goal_id);
					PRAGMA user_version = ${GATE_SQLITE_SCHEMA_VERSION};
				`);
				this.db.exec("COMMIT");
			} catch (error) {
				if (this.db.inTransaction) this.db.exec("ROLLBACK");
				throw error;
			}
		}

		const marker = this.getMeta(GATE_MIGRATION_COMPLETE_KEY);
		if (marker === undefined) this.migrateLegacyOrInitialize();
		else if (marker !== "1") throw new Error(`[gate-store] Invalid gates.sqlite migration marker ${marker}`);

		// Validate authoritative state before touching either recovery source.
		const rows = this.readValidatedRows();
		this.retirePendingSources();
		this.recoverPreMigration(rows);
	}

	private getMeta(key: string): string | undefined {
		return (this.db.prepare("SELECT value FROM gate_store_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
	}

	private setMeta(key: string, value: string): void {
		this.db.prepare(`
			INSERT INTO gate_store_meta(key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run(key, value);
	}

	private readValidatedRows(): ValidatedGateRow[] {
		const rows: ValidatedGateRow[] = [];
		const seen = new Set<string>();
		for (const row of this.db.prepare("SELECT goal_id, gate_id, payload FROM gate_records ORDER BY goal_id, gate_id").iterate() as Iterable<{ goal_id: string; gate_id: string; payload: string }>) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.payload);
			} catch (error) {
				throw new Error(`[gate-store] Invalid SQLite payload for ${row.goal_id}/${row.gate_id}: ${error instanceof Error ? error.message : String(error)}`);
			}
			const gate = validateGateState(parsed, `SQLite payload for ${row.goal_id}/${row.gate_id}`, { goalId: row.goal_id, gateId: row.gate_id });
			const key = compositeKey(gate.goalId, gate.gateId);
			if (seen.has(key)) throw new Error(`[gate-store] Duplicate SQLite composite identity ${gate.goalId}/${gate.gateId}`);
			seen.add(key);
			rows.push({ goalId: row.goal_id, gateId: row.gate_id, payload: row.payload, gate });
		}
		return rows;
	}

	private verifyRows(expected: Map<string, string>): void {
		const actual = new Map(this.readValidatedRows().map(row => [compositeKey(row.goalId, row.gateId), row.payload]));
		if (actual.size !== expected.size) {
			throw new Error(`[gate-store] SQLite import verification count mismatch: expected ${expected.size}, got ${actual.size}`);
		}
		for (const [key, payload] of expected) {
			if (actual.get(key) !== payload) throw new Error(`[gate-store] SQLite import verification failed for ${key}`);
		}
	}

	private readSource(file: string, sourceLabel: string): GateState[] {
		return parseGateArray(this.fs.readFileSync(file, "utf-8"), sourceLabel);
	}

	private migrateLegacyOrInitialize(): void {
		const row = this.db.prepare("SELECT COUNT(*) AS count FROM gate_records").get() as { count: number };
		if (row.count !== 0) throw new Error("[gate-store] gates.sqlite contains records without a completed migration marker");

		const recoveryFile = `${this.legacyFile}.pre-migration`;
		const hadLegacy = this.fs.existsSync(this.legacyFile);
		const hadRecovery = this.fs.existsSync(recoveryFile);
		// Read and validate every source before the transaction or any retirement.
		const recovery = hadRecovery ? this.readSource(recoveryFile, "gates.json.pre-migration") : [];
		const legacy = hadLegacy ? this.readSource(this.legacyFile, "gates.json") : [];
		const merged = new Map<string, GateState>();
		for (const gate of recovery) merged.set(compositeKey(gate.goalId, gate.gateId), gate);
		for (const gate of legacy) merged.set(compositeKey(gate.goalId, gate.gateId), gate);
		const expected = new Map([...merged].map(([key, gate]) => [key, JSON.stringify(gate)]));

		const insert = this.db.prepare("INSERT INTO gate_records(goal_id, gate_id, payload) VALUES (?, ?, ?)");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const gate of merged.values()) insert.run(gate.goalId, gate.gateId, JSON.stringify(gate));
			this.verifyRows(expected);
			this.setMeta(GATE_MIGRATION_COMPLETE_KEY, "1");
			if (hadLegacy) this.setMeta(GATE_LEGACY_RETIREMENT_KEY, "1");
			if (hadRecovery) {
				this.setMeta(GATE_RECOVERY_COMPLETE_KEY, "1");
				this.setMeta(GATE_RECOVERY_RETIREMENT_KEY, "1");
			}
			this.db.exec("COMMIT");
		} catch (error) {
			if (this.db.inTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private recoverPreMigration(existingRows: ValidatedGateRow[]): void {
		const recoveryFile = `${this.legacyFile}.pre-migration`;
		if (!this.fs.existsSync(recoveryFile) || this.getMeta(GATE_RECOVERY_COMPLETE_KEY) === "1") return;
		const recovery = this.readSource(recoveryFile, "gates.json.pre-migration");
		const expected = new Map(existingRows.map(row => [compositeKey(row.goalId, row.gateId), row.payload]));
		for (const gate of recovery) {
			const key = compositeKey(gate.goalId, gate.gateId);
			if (!expected.has(key)) expected.set(key, JSON.stringify(gate));
		}

		const insert = this.db.prepare(`
			INSERT INTO gate_records(goal_id, gate_id, payload) VALUES (?, ?, ?)
			ON CONFLICT(goal_id, gate_id) DO NOTHING
		`);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const gate of recovery) insert.run(gate.goalId, gate.gateId, JSON.stringify(gate));
			this.verifyRows(expected);
			this.setMeta(GATE_RECOVERY_COMPLETE_KEY, "1");
			this.setMeta(GATE_RECOVERY_RETIREMENT_KEY, "1");
			this.db.exec("COMMIT");
		} catch (error) {
			if (this.db.inTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
		this.retirePendingSources();
	}

	/**
	 * Publish one retained name without a check-then-rename overwrite window.
	 * A same-directory hard link is atomic and refuses an occupied destination on
	 * both Windows and POSIX. The source name is removed only after preservation
	 * succeeds; any other failure leaves the durable retirement intent intact.
	 */
	private retireSourceWithoutReplace(source: string, preferred: string): void {
		for (let suffix = 0; ; suffix++) {
			const target = suffix === 0 ? preferred : `${preferred}.${suffix}`;
			try {
				this.fs.linkSync(source, target);
			} catch (error) {
				if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") continue;
				throw error;
			}
			this.fs.unlinkSync(source);
			return;
		}
	}

	private retirePendingSources(): void {
		const pending = [
			{ key: GATE_LEGACY_RETIREMENT_KEY, source: this.legacyFile, preferred: `${this.legacyFile}.sqlite-retired` },
			{ key: GATE_RECOVERY_RETIREMENT_KEY, source: `${this.legacyFile}.pre-migration`, preferred: `${this.legacyFile}.pre-migration-recovered` },
		];
		for (const item of pending) {
			const intent = this.getMeta(item.key);
			if (intent === undefined) continue;
			if (intent !== "1") throw new Error(`[gate-store] Invalid retirement intent ${item.key}=${intent}`);
			if (this.fs.existsSync(item.source)) this.retireSourceWithoutReplace(item.source, item.preferred);
			this.db.prepare("DELETE FROM gate_store_meta WHERE key = ?").run(item.key);
		}
	}

	loadInto(gates: Map<string, GateState>): void {
		const rows = this.readValidatedRows();
		for (const row of rows) gates.set(compositeKey(row.gate.goalId, row.gate.gateId), row.gate);
	}

	schedule(keys: Iterable<string>): void {
		this.assertOpen();
		let changed = false;
		for (const key of keys) {
			this.dirty.add(key);
			changed = true;
		}
		if (!changed) return;
		this.revision++;
		this.requested = true;
		if (this.inFlight || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.startDrain();
		}, GATE_SQLITE_DEBOUNCE_MS);
		this.timer.unref?.();
	}

	flush(): Promise<void> {
		if (!this.hasPendingWork()) return Promise.resolve();
		return this.requestBarrier();
	}

	publishStrict(keys: Iterable<string>): Promise<void> {
		this.assertOpen();
		for (const key of keys) this.dirty.add(key);
		return this.requestBarrier();
	}

	getLastWriteMetrics(): GateWriteMetrics | null { return this.lastWriteMetrics; }

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		if (this.closed) return Promise.resolve();
		this.closePromise = this.flushForClose().finally(() => this.dispose());
		return this.closePromise;
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.closed) return;
		this.closed = true;
		if (this.db.open) this.db.close();
	}

	private assertOpen(): void {
		if (this.closed || this.closePromise) throw new Error("[gate-store] SQLite persistence is closing or closed");
	}

	private hasPendingWork(): boolean {
		return this.dirty.size > 0 || this.requested || this.inFlight !== null || this.timer !== null;
	}

	/** Retry one failed shutdown publication immediately, then fail loud and release the handle. */
	private async flushForClose(): Promise<void> {
		if (!this.hasPendingWork()) return;
		let lastError: unknown;
		for (let attempt = 0; attempt < GATE_SQLITE_CLOSE_ATTEMPTS; attempt++) {
			try {
				await this.requestBarrier(true);
				return;
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError;
	}

	private requestBarrier(allowClosing = false): Promise<void> {
		if (!allowClosing) this.assertOpen();
		const revision = ++this.revision;
		this.requested = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
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
			const keys = [...this.dirty];
			this.dirty.clear();
			const snapshots = keys.map(key => ({ key, gate: this.gates.get(key) }));
			const startedAt = performance.now();
			let bytes = 0;
			try {
				if (snapshots.length > 0) {
					const upsert = this.db.prepare(`
						INSERT INTO gate_records(goal_id, gate_id, payload) VALUES (?, ?, ?)
						ON CONFLICT(goal_id, gate_id) DO UPDATE SET payload = excluded.payload
					`);
					const remove = this.db.prepare("DELETE FROM gate_records WHERE goal_id = ? AND gate_id = ?");
					this.db.exec("BEGIN IMMEDIATE");
					for (const snapshot of snapshots) {
						const separator = snapshot.key.indexOf("::");
						const goalId = snapshot.key.slice(0, separator);
						const gateId = snapshot.key.slice(separator + 2);
						if (!snapshot.gate) {
							remove.run(goalId, gateId);
							continue;
						}
						const payload = JSON.stringify(snapshot.gate);
						bytes += Buffer.byteLength(payload);
						upsert.run(snapshot.gate.goalId, snapshot.gate.gateId, payload);
					}
					this.db.exec("COMMIT");
				}
				this.lastWriteMetrics = { bytes, durationMs: performance.now() - startedAt };
				this.settlePublished(revision);
			} catch (error) {
				if (this.db.inTransaction) {
					try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
				}
				for (const { key } of snapshots) this.dirty.add(key);
				this.settleFailed(revision, error);
				console.error("[gate-store] Failed to save SQLite gates:", error);
				return;
			}
		}
	}

	private settlePublished(revision: number): void {
		this.publishedRevision = Math.max(this.publishedRevision, revision);
		const pending: GateWriteBarrier[] = [];
		for (const barrier of this.barriers) {
			if (barrier.revision <= this.publishedRevision) barrier.resolve();
			else pending.push(barrier);
		}
		this.barriers = pending;
	}

	private settleFailed(revision: number, error: unknown): void {
		const pending: GateWriteBarrier[] = [];
		for (const barrier of this.barriers) {
			if (barrier.revision <= revision) barrier.reject(error);
			else pending.push(barrier);
		}
		this.barriers = pending;
	}
}

export interface GateStoreOptions {
	/** Explicit test adapter; production defaults to SQLite. */
	persistence?: "sqlite" | "json";
}

export class GateStore {
	private readonly persistence: GatePersistence;
	private gates: Map<string, GateState> = new Map();
	private acceptingMutations = true;
	private closePromise: Promise<void> | null = null;

	/** Optional callback invoked when gate summary truth changes (for bumping goal generation). */
	onStatusChange?: (goalId: string, gateId: string) => void;

	constructor(stateDir: string, fsImpl: FsLike = realFs, options: GateStoreOptions = {}) {
		const persistence = options.persistence ?? (fsImpl === realFs ? "sqlite" : "json");
		this.persistence = persistence === "json"
			? new JsonGatePersistence(fsImpl, stateDir, this.gates)
			: new SqliteGatePersistence(fsImpl, stateDir, this.gates);
		try {
			this.persistence.loadInto(this.gates);
		} catch (error) {
			this.persistence.dispose();
			throw error;
		}
	}

	private assertAcceptingMutations(): void {
		if (!this.acceptingMutations) throw new Error("[gate-store] GateStore is closing or closed");
	}

	private save(keys: Iterable<string>): void {
		this.persistence.schedule(keys);
	}

	/** Await all pending persistence, primarily for orderly shutdown/tests. */
	flush(): Promise<void> {
		return this.persistence.flush();
	}

	/** Flush pending persistence and release the SQLite database handle. */
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		// This synchronous fence makes every mutation linearize either before the
		// persistence close barrier or before touching the in-memory snapshot.
		this.acceptingMutations = false;
		this.closePromise = this.persistence.close();
		return this.closePromise;
	}

	/** Release resources after a surrounding constructor fails before ownership transfers. */
	dispose(): void {
		this.acceptingMutations = false;
		this.persistence.dispose();
	}

	/** Latest transaction duration and serialized payload byte count. */
	getPersistenceMetrics() {
		return this.persistence.getLastWriteMetrics();
	}

	/** Strict lifecycle writes share the coalesced persistence queue. */
	private saveStrict(keys: Iterable<string>): Promise<void> {
		return this.persistence.publishStrict(keys);
	}

	/** Initialize pending gate states for a new goal. */
	initGatesForGoal(goalId: string, gateIds: string[]): void {
		this.assertAcceptingMutations();
		const now = Date.now();
		const dirtyKeys: string[] = [];
		for (const gateId of gateIds) {
			const key = compositeKey(goalId, gateId);
			if (!this.gates.has(key)) {
				this.gates.set(key, {
					gateId,
					goalId,
					status: "pending",
					signals: [],
					updatedAt: now,
				});
				dirtyKeys.push(key);
			}
		}
		if (dirtyKeys.length > 0) this.save(dirtyKeys);
	}

	/**
	 * Reconcile persisted gate state after replacing a goal's workflow snapshot.
	 * Existing gates retain their exact state unless explicitly marked modified.
	 */
	reconcileGatesForGoal(
		goalId: string,
		nextGateIds: Iterable<string>,
		modifiedGateIds: Iterable<string> = [],
	): void {
		this.assertAcceptingMutations();
		const remainingGateIds = new Set(nextGateIds);
		const modifiedIds = new Set(modifiedGateIds);
		const now = Date.now();
		const dirtyKeys: string[] = [];

		for (const [key, gate] of this.gates) {
			if (gate.goalId !== goalId) continue;

			if (!remainingGateIds.has(gate.gateId)) {
				this.gates.delete(key);
				dirtyKeys.push(key);
				continue;
			}

			remainingGateIds.delete(gate.gateId);
			if (modifiedIds.has(gate.gateId)) {
				gate.status = "pending";
				gate.verificationCacheInvalidatedAt = now;
				gate.updatedAt = now;
				dirtyKeys.push(key);
			}
		}

		for (const gateId of remainingGateIds) {
			const key = compositeKey(goalId, gateId);
			this.gates.set(key, {
				gateId,
				goalId,
				status: "pending",
				signals: [],
				updatedAt: now,
			});
			dirtyKeys.push(key);
		}

		if (dirtyKeys.length > 0) this.save(dirtyKeys);
	}

	getGate(goalId: string, gateId: string): GateState | undefined {
		return this.gates.get(compositeKey(goalId, gateId));
	}

	getGatesForGoal(goalId: string): GateState[] {
		const result: GateState[] = [];
		for (const g of this.gates.values()) {
			if (g.goalId === goalId) result.push(g);
		}
		return result;
	}

	/** Append a signal to a gate's history. */
	recordSignal(signal: GateSignal): void {
		this.assertAcceptingMutations();
		const key = compositeKey(signal.goalId, signal.gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.signals.push(signal);
		gate.updatedAt = Date.now();
		this.save([key]);
		this.onStatusChange?.(signal.goalId, signal.gateId);
	}

	/**
	 * Human-only bypass: force a gate past verification. Appends a synthetic
	 * audit signal (so the action is auditable like any other signal), sets the
	 * gate status to "bypassed", persists, and fires onStatusChange.
	 *
	 * This is an honesty-system override surfaced ONLY via the human UI — it is
	 * never advertised to agents (no MCP tool). See docs/design Human Gate Bypass.
	 */
	bypassGate(goalId: string, gateId: string, opts: { whyBypassed: string; whoAmI: string }): GateSignal {
		this.assertAcceptingMutations();
		const key = compositeKey(goalId, gateId);
		const gate = this.gates.get(key);
		if (!gate) {
			throw new Error(`Unknown gate: ${gateId}`);
		}
		const now = Date.now();
		const signal: GateSignal = {
			id: `bypass-${randomUUID()}`,
			gateId,
			goalId,
			sessionId: "human-bypass",
			timestamp: now,
			commitSha: "",
			content: opts.whyBypassed,
			metadata: {
				bypass: "true",
				whyBypassed: opts.whyBypassed,
				whoAmI: opts.whoAmI,
				bypassedAt: String(now),
			},
			verification: { status: "passed", steps: [] },
		};
		gate.signals.push(signal);
		gate.status = "bypassed";
		gate.updatedAt = now;
		this.save([key]);
		this.onStatusChange?.(goalId, gateId);
		return signal;
	}

	/** Returns the last signal whose metadata.bypass === "true", if any. */
	getLatestBypassSignal(gate: GateState): GateSignal | undefined {
		for (let i = gate.signals.length - 1; i >= 0; i--) {
			if (gate.signals[i]?.metadata?.bypass === "true") return gate.signals[i];
		}
		return undefined;
	}

	updateGateStatus(goalId: string, gateId: string, status: GateStatus): void {
		this.assertAcceptingMutations();
		const key = compositeKey(goalId, gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.status = status;
		gate.updatedAt = Date.now();
		this.save([key]);
		this.onStatusChange?.(goalId, gateId);
	}

	updateGateContent(goalId: string, gateId: string, content: string, version: number): void {
		this.assertAcceptingMutations();
		const key = compositeKey(goalId, gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.currentContent = content;
		gate.currentContentVersion = version;
		gate.updatedAt = Date.now();
		this.save([key]);
	}

	updateGateMetadata(goalId: string, gateId: string, metadata: Record<string, string>): void {
		this.assertAcceptingMutations();
		const key = compositeKey(goalId, gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.currentMetadata = metadata;
		gate.updatedAt = Date.now();
		this.save([key]);
	}

	/**
	 * Atomically repin a running signal after an ancestry-safe remote sync.
	 *
	 * This must commit before a pinned checkout is acquired: the checkout manager
	 * treats the signal SHA as its expected immutable base. Roll back in-memory
	 * state if publication fails so later writes cannot accidentally persist an
	 * unacknowledged ref movement.
	 */
	async updateSignalCommitSha(signalId: string, commitSha: string): Promise<void> {
		if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error("Invalid gate signal commit SHA");
		for (const [key, gate] of this.gates) {
			const signal = gate.signals.find(s => s.id === signalId);
			if (!signal) continue;
			if (signal.verification.status !== "running") throw new Error("Cannot repin a finalized gate signal");
			const previousCommitSha = signal.commitSha;
			signal.commitSha = commitSha;
			gate.updatedAt = Date.now();
			try {
				await this.saveStrict([key]);
			} catch (error) {
				signal.commitSha = previousCommitSha;
				throw error;
			}
			return;
		}
		throw new Error(`Unknown gate signal: ${signalId}`);
	}

	/** Persist the authoritative source-byte witness without changing verification state. */
	updateSignalContentDigest(
		signalId: string,
		result: VerificationContentDigest | VerificationContentDigestErrorSummary,
	): void {
		for (const [key, gate] of this.gates) {
			const signal = gate.signals.find(s => s.id === signalId);
			if (!signal) continue;
			if ("digest" in result) {
				signal.contentDigest = result;
				delete signal.contentDigestError;
			} else {
				signal.contentDigestError = result;
				delete signal.contentDigest;
			}
			gate.updatedAt = Date.now();
			this.save([key]);
			return;
		}
	}

	/** Persist a pinned-checkout attestation or its sanitized operational failure. */
	updateSignalPinnedCheckout(
		signalId: string,
		result: PinnedCheckoutAttestation | PinnedCheckoutError,
	): void {
		for (const [key, gate] of this.gates) {
			const signal = gate.signals.find(s => s.id === signalId);
			if (!signal) continue;
			if ("code" in result) {
				signal.pinnedCheckoutError = result;
				delete signal.pinnedCheckout;
			} else {
				signal.pinnedCheckout = result;
				delete signal.pinnedCheckoutError;
			}
			gate.updatedAt = Date.now();
			this.save([key]);
			return;
		}
	}

	/** Update a signal's verification results by signal ID. */
	updateSignalVerification(signalId: string, verification: GateSignal["verification"]): void {
		this.assertAcceptingMutations();
		for (const [key, gate] of this.gates) {
			const signal = gate.signals.find(s => s.id === signalId);
			if (signal) {
				if (signal.verification.status !== "running") return; // already finalized
				signal.verification = verification;
				gate.updatedAt = Date.now();
				this.save([key]);
				return;
			}
		}
	}

	private getDependentGateIds(gateId: string, workflow: Workflow, includeRequested: boolean): string[] {
		const gateIds = new Set(workflow.gates.map(g => g.id));
		if (!gateIds.has(gateId)) {
			throw new Error(`Unknown gate: ${gateId}`);
		}

		const adjacency = new Map<string, string[]>();
		for (const gate of workflow.gates) {
			for (const depId of gate.dependsOn) {
				const list = adjacency.get(depId) ?? [];
				list.push(gate.id);
				adjacency.set(depId, list);
			}
		}

		const result: string[] = [];
		const visited = new Set<string>();
		const queue = [gateId];
		visited.add(gateId);
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (includeRequested || current !== gateId) result.push(current);
			for (const depId of adjacency.get(current) ?? []) {
				if (visited.has(depId)) continue;
				visited.add(depId);
				queue.push(depId);
			}
		}
		return result;
	}

	/**
	 * Reset a selected gate and every transitive dependent to pending.
	 * Preserves signal history, current content, content version, and metadata.
	 */
	async resetGateAndDependents(goalId: string, gateId: string, workflow: Workflow): Promise<GateResetResult> {
		return this.resetGateAndDependentsInternal(goalId, gateId, workflow, false, true);
	}

	/** Reset gates with an atomic, fail-loud publication fence for lifecycle transactions. */
	async resetGateAndDependentsStrict(goalId: string, gateId: string, workflow: Workflow): Promise<GateResetResult> {
		return this.resetGateAndDependentsInternal(goalId, gateId, workflow, true, true);
	}

	/**
	 * Apply a reset only to the in-memory snapshot. The caller owns a later
	 * publication fence, which is needed by cross-store WAL recovery to keep
	 * the goal-state write ahead of a gate-state write.
	 */
	resetGateAndDependentsInMemory(goalId: string, gateId: string, workflow: Workflow): Promise<void> {
		return this.resetGateAndDependentsInternal(goalId, gateId, workflow, false, false).then(() => undefined);
	}

	private async resetGateAndDependentsInternal(
		goalId: string,
		gateId: string,
		workflow: Workflow,
		strict: boolean,
		persist: boolean,
	): Promise<GateResetResult> {
		this.assertAcceptingMutations();
		const affectedGateIds = this.getDependentGateIds(gateId, workflow, true);
		const changedGateIds: string[] = [];
		const unchangedGateIds: string[] = [];
		const previousStatuses: Record<string, GateStatus> = {};
		const snapshots = new Map<string, { status: GateStatus; updatedAt: number; cacheAt?: number; hadCacheAt: boolean }>();
		const affectedKeys: string[] = [];
		const now = Date.now();

		for (const affectedGateId of affectedGateIds) {
			const key = compositeKey(goalId, affectedGateId);
			const gate = this.gates.get(key);
			const previousStatus = gate?.status ?? "pending";
			previousStatuses[affectedGateId] = previousStatus;

			if (gate) {
				affectedKeys.push(key);
				snapshots.set(key, {
					status: gate.status,
					updatedAt: gate.updatedAt,
					cacheAt: gate.verificationCacheInvalidatedAt,
					hadCacheAt: Object.prototype.hasOwnProperty.call(gate, "verificationCacheInvalidatedAt"),
				});
				gate.verificationCacheInvalidatedAt = now;
				gate.updatedAt = now;
			}

			if (gate && gate.status !== "pending") {
				gate.status = "pending";
				changedGateIds.push(affectedGateId);
			} else {
				unchangedGateIds.push(affectedGateId);
			}
		}

		try {
			if (affectedKeys.length > 0) {
				if (strict) await this.saveStrict(affectedKeys);
				else if (persist) this.save(affectedKeys);
			}
		} catch (err) {
			for (const [key, snapshot] of snapshots) {
				const gate = this.gates.get(key);
				if (!gate) continue;
				gate.status = snapshot.status;
				gate.updatedAt = snapshot.updatedAt;
				if (snapshot.hadCacheAt) gate.verificationCacheInvalidatedAt = snapshot.cacheAt;
				else delete gate.verificationCacheInvalidatedAt;
			}
			throw err;
		}
		for (const changedGateId of changedGateIds) {
			if (!strict) {
				this.onStatusChange?.(goalId, changedGateId);
				continue;
			}
			try {
				this.onStatusChange?.(goalId, changedGateId);
			} catch (err) {
				// Persistence has committed. Observer failures must not make the
				// coordinator compensate the goal back to complete over pending gates.
				console.error(`[gate-store] Status observer failed after strict reset ${goalId}/${changedGateId}:`, err);
			}
		}

		return {
			requestedGateId: gateId,
			affectedGateIds,
			changedGateIds,
			unchangedGateIds,
			previousStatuses,
		};
	}

	/**
	 * Reset downstream gates to pending when an upstream gate is re-signaled.
	 * Uses the workflow definition to find transitive dependents.
	 */
	cascadeReset(goalId: string, gateId: string, workflow: Workflow): void {
		this.assertAcceptingMutations();
		const dependents = this.getDependentGateIds(gateId, workflow, false);
		const changedGateIds: string[] = [];
		const dirtyKeys: string[] = [];
		const now = Date.now();

		for (const depId of dependents) {
			const key = compositeKey(goalId, depId);
			const gate = this.gates.get(key);
			if (gate && gate.status !== "pending") {
				gate.status = "pending";
				gate.updatedAt = now;
				changedGateIds.push(depId);
				dirtyKeys.push(key);
			}
		}
		if (dirtyKeys.length > 0) this.save(dirtyKeys);
	}

	/** Remove all gates for a goal (cleanup on goal deletion). */
	removeGoalGates(goalId: string): void {
		this.assertAcceptingMutations();
		const keysToRemove: string[] = [];
		for (const [key, gate] of this.gates) {
			if (gate.goalId === goalId) keysToRemove.push(key);
		}
		for (const key of keysToRemove) {
			this.gates.delete(key);
		}
		if (keysToRemove.length > 0) this.save(keysToRemove);
	}
}
