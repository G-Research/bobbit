import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { CoalescedJsonWriter } from "./coalesced-json-writer.js";
import { readDeletionTombstones } from "./deletion-tombstones.js";

export type TaskState = "todo" | "in-progress" | "blocked" | "complete" | "skipped";

export interface PersistedTask {
	id: string;
	goalId: string;
	parentTaskId?: string;
	title: string;
	type: string;
	state: TaskState;
	assignedSessionId?: string;
	spec?: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	dependsOn?: string[];
	baseSha?: string;
	headSha?: string;
	branch?: string;
	resultSummary?: string;
	/** Workflow gate ID this task should produce (0 or 1). */
	workflowGateId?: string;
	/** Workflow gate IDs whose accepted content to inject when prompting the agent. */
	inputGateIds?: string[];
	/** Per-repo git handoff (multi-repo). Falls back to flat baseSha/headSha/branch for single-repo. */
	gitHandoff?: Record<string, { baseSha?: string; headSha?: string; branch?: string }>;
}

/**
 * Read a task's git handoff for a specific repo, falling back to legacy flat
 * fields for single-repo tasks. Returns an empty object when neither is set.
 */
export function readHandoff(
	task: PersistedTask,
	repo: string,
): { baseSha?: string; headSha?: string; branch?: string } {
	if (task.gitHandoff && task.gitHandoff[repo]) return { ...task.gitHandoff[repo] };
	return { baseSha: task.baseSha, headSha: task.headSha, branch: task.branch };
}

interface TaskWriteMetrics {
	bytes: number;
	durationMs: number;
}

export type TaskCommittedFact =
	| {
		kind: "taskCreated";
		taskId: string;
		goalId: string;
		type: string;
		state: TaskState;
		parentTaskId?: string;
		revision: number;
	}
	| {
		kind: "taskUpdated";
		taskId: string;
		goalId: string;
		state: TaskState;
		changedFields: string[];
		revision: number;
	}
	| {
		kind: "taskStateChanged";
		taskId: string;
		goalId: string;
		previousState: TaskState;
		state: TaskState;
		revision: number;
	};

interface TaskFactBatch {
	facts: TaskCommittedFact[];
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
	started: boolean;
}

interface TaskPublication {
	/** Exact task projections immediately before and after the successful durable write. */
	previous: ReadonlyMap<string, PersistedTask>;
	current: ReadonlyMap<string, PersistedTask>;
}

interface TaskPersistence {
	loadInto(tasks: Map<string, PersistedTask>): void;
	schedule(ids: Iterable<string>): void;
	publishStrict(ids: Iterable<string>): Promise<TaskPublication>;
	flush(): Promise<void>;
	close(): Promise<void>;
	dispose(): void;
	getLastWriteMetrics(): TaskWriteMetrics | null;
}

/** Existing whole-file persistence retained for injected/memfs unit fixtures. */
class JsonTaskPersistence implements TaskPersistence {
	private readonly writer: CoalescedJsonWriter;
	private readonly storeFile: string;
	private durable = new Map<string, PersistedTask>();
	private publishing: TaskPublication | null = null;
	private lastPublication: TaskPublication = { previous: new Map(), current: new Map() };

	constructor(
		private readonly fs: FsLike,
		stateDir: string,
		tasks: Map<string, PersistedTask>,
	) {
		this.storeFile = path.join(stateDir, "tasks.json");
		this.writer = new CoalescedJsonWriter(
			fs,
			stateDir,
			this.storeFile,
			() => {
				const json = JSON.stringify(Array.from(tasks.values()));
				const current = new Map<string, PersistedTask>();
				for (const task of JSON.parse(json) as PersistedTask[]) current.set(task.id, task);
				this.publishing = { previous: this.durable, current };
				return json;
			},
			"task-store",
			undefined,
			undefined,
			() => {
				// The writer calls onWrite for the snapshot serialized immediately above.
				// Keep this callback non-throwing: the atomic rename is already authoritative.
				if (!this.publishing) return;
				this.lastPublication = this.publishing;
				this.durable = new Map(this.publishing.current);
				this.publishing = null;
			},
		);
	}

	loadInto(tasks: Map<string, PersistedTask>): void {
		try {
			if (!this.fs.existsSync(this.storeFile)) return;
			const parsed = JSON.parse(this.fs.readFileSync(this.storeFile, "utf-8"));
			if (!Array.isArray(parsed)) return;
			// Preserve the tolerant legacy JSON fixture behavior: invalid records are skipped.
			for (const value of parsed) {
				if (!value?.id || !value?.goalId || !value?.title || !value?.type || !value?.state) continue;
				canonicalizeTask(value as Record<string, unknown>);
				tasks.set(value.id, value as PersistedTask);
			}
			this.durable = new Map(JSON.parse(JSON.stringify([...tasks.values()])).map((task: PersistedTask) => [task.id, task]));
		} catch (error) {
			console.error("[task-store] Failed to load persisted tasks:", error);
		}
	}

	schedule(_ids: Iterable<string>): void { this.writer.schedule(); }
	publishStrict(_ids: Iterable<string>): Promise<TaskPublication> {
		return this.writer.publishStrict().then(() => this.lastPublication);
	}
	flush(): Promise<void> { return this.writer.flush(); }
	async close(): Promise<void> { await this.writer.flush(); }
	dispose(): void { /* no persistent handle */ }
	getLastWriteMetrics(): TaskWriteMetrics | null { return this.writer.getLastWriteMetrics(); }
}

type TaskWriteBarrier = {
	revision: number;
	resolve: () => void;
	reject: (error: unknown) => void;
};

const nodeRequire = createRequire(import.meta.url);
const TASK_SQLITE_SCHEMA_VERSION = 1;
const TASK_SQLITE_FILE = "tasks.sqlite";
const TASK_SQLITE_DEBOUNCE_MS = 500;
const TASK_SQLITE_CLOSE_ATTEMPTS = 2;
const TASK_MIGRATION_COMPLETE_KEY = "migration_complete";
const TASK_RECOVERY_COMPLETE_KEY = "pre_migration_recovery_complete";
const TASK_LEGACY_RETIREMENT_KEY = "pending_retirement:tasks.json";
const TASK_RECOVERY_RETIREMENT_KEY = "pending_retirement:tasks.json.pre-migration";
const TASK_STATES = new Set<TaskState>(["todo", "in-progress", "blocked", "complete", "skipped"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidTask(label: string, detail: string): never {
	throw new Error(`[task-store] Invalid ${label}: ${detail}`);
}

/** Apply every historical TaskStore field migration without removing extensions. */
function canonicalizeTask(task: Record<string, unknown>): void {
	if (task.workflowArtifactId && !task.workflowGateId) task.workflowGateId = task.workflowArtifactId;
	delete task.workflowArtifactId;
	if (task.inputArtifactIds && !task.inputGateIds) task.inputGateIds = task.inputArtifactIds;
	delete task.inputArtifactIds;
	if (task.commitSha && !task.headSha) task.headSha = task.commitSha;
	delete task.commitSha;
}

function validateOptionalString(value: Record<string, unknown>, field: string, label: string): void {
	if (value[field] !== undefined && typeof value[field] !== "string") invalidTask(label, `${field} must be a string`);
}

function validateStringArray(value: unknown, label: string): void {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) invalidTask(label, "must be an array of strings");
}

function validateTask(value: unknown, label: string, expectedId?: string, validateSerialization = true): PersistedTask {
	if (!isRecord(value)) invalidTask(label, "must be an object");
	canonicalizeTask(value);
	for (const field of ["id", "goalId", "title", "type"] as const) {
		if (typeof value[field] !== "string" || value[field].length === 0) invalidTask(label, `${field} must be a non-empty string`);
	}
	if (expectedId !== undefined && value.id !== expectedId) {
		throw new Error(`[task-store] SQLite row identity mismatch for ${expectedId}`);
	}
	if (typeof value.state !== "string" || !TASK_STATES.has(value.state as TaskState)) {
		invalidTask(label, `unsupported state ${String(value.state)}`);
	}
	if (!Number.isFinite(value.createdAt)) invalidTask(label, "createdAt must be finite");
	if (!Number.isFinite(value.updatedAt)) invalidTask(label, "updatedAt must be finite");
	if (value.completedAt !== undefined && !Number.isFinite(value.completedAt)) invalidTask(label, "completedAt must be finite");
	for (const field of [
		"parentTaskId", "assignedSessionId", "spec", "baseSha", "headSha", "branch",
		"resultSummary", "workflowGateId",
	] as const) validateOptionalString(value, field, label);
	if (value.dependsOn !== undefined) validateStringArray(value.dependsOn, `${label} dependsOn`);
	if (value.inputGateIds !== undefined) validateStringArray(value.inputGateIds, `${label} inputGateIds`);
	if (value.gitHandoff !== undefined) {
		if (!isRecord(value.gitHandoff)) invalidTask(label, "gitHandoff must be an object");
		for (const [repo, handoff] of Object.entries(value.gitHandoff)) {
			if (!repo || !isRecord(handoff)) invalidTask(label, `gitHandoff entry ${repo} must be an object`);
			for (const field of ["baseSha", "headSha", "branch"] as const) validateOptionalString(handoff, field, `${label} gitHandoff entry ${repo}`);
		}
	}
	if (validateSerialization) {
		try {
			if (JSON.stringify(value) === undefined) invalidTask(label, "must be JSON serializable");
		} catch (error) {
			invalidTask(label, `must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return value as unknown as PersistedTask;
}

function taskFactValuesEqual(left: unknown, right: unknown): boolean {
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((value, index) => value === right[index]);
	}
	return left === right;
}

function serializeTaskForPublication(task: PersistedTask, dirtyId: string): string {
	const label = `runtime task ${dirtyId}`;
	const payload = JSON.stringify(task);
	if (payload === undefined) invalidTask(label, "must be JSON serializable");

	// Validate the exact bytes being published so a toJSON hook cannot bypass
	// known-field or dirty-key identity checks. Canonicalization is confined to
	// this parsed copy; the in-memory task and its serialized payload stay exact.
	const serializedTask: unknown = JSON.parse(payload);
	validateTask(serializedTask, label, dirtyId, false);
	return payload;
}

function parseTaskArray(text: string, sourceLabel: string): PersistedTask[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`[task-store] Failed to parse ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed)) throw new Error(`[task-store] ${sourceLabel} must contain an array`);
	const seen = new Set<string>();
	return parsed.map((value, index) => {
		const kind = sourceLabel === "tasks.json" ? "legacy task" : "recovery task";
		const task = validateTask(value, `${kind} at index ${index}`);
		if (seen.has(task.id)) throw new Error(`[task-store] Duplicate ${sourceLabel} task ${task.id}`);
		seen.add(task.id);
		return task;
	});
}

type ValidatedTaskRow = { id: string; payload: string; task: PersistedTask };

class SqliteTaskPersistence implements TaskPersistence {
	private readonly db: Database.Database;
	private readonly legacyFile: string;
	private readonly stateDir: string;
	private readonly dirty = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inFlight: Promise<void> | null = null;
	private requested = false;
	private revision = 0;
	private publishedRevision = 0;
	private barriers: TaskWriteBarrier[] = [];
	private lastWriteMetrics: TaskWriteMetrics | null = null;
	private closePromise: Promise<void> | null = null;
	private closed = false;
	private durable = new Map<string, PersistedTask>();
	private lastPublication: TaskPublication = { previous: new Map(), current: new Map() };

	constructor(
		private readonly fs: FsLike,
		stateDir: string,
		private readonly tasks: Map<string, PersistedTask>,
	) {
		this.stateDir = stateDir;
		fs.mkdirSync(stateDir, { recursive: true });
		this.legacyFile = path.join(stateDir, "tasks.json");
		let BetterSqlite: new (filename: string, options?: Database.Options) => Database.Database;
		try {
			BetterSqlite = nodeRequire("better-sqlite3") as typeof BetterSqlite;
		} catch (error) {
			throw new Error(
				`[task-store] Failed to load the better-sqlite3 native binding for ${process.platform}-${process.arch}; reinstall Bobbit on a supported platform`,
				{ cause: error },
			);
		}
		this.db = new BetterSqlite(path.join(stateDir, TASK_SQLITE_FILE), { timeout: 5_000 });
		try {
			this.initialize();
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	private initialize(): void {
		const versionRow = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (versionRow.user_version > TASK_SQLITE_SCHEMA_VERSION) {
			throw new Error(`[task-store] Unsupported tasks.sqlite schema ${versionRow.user_version}`);
		}
		this.db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
		if (versionRow.user_version === 0) {
			this.db.exec("BEGIN IMMEDIATE");
			try {
				this.db.exec(`
					CREATE TABLE task_store_meta (
						key TEXT PRIMARY KEY,
						value TEXT NOT NULL
					) STRICT, WITHOUT ROWID;
					CREATE TABLE task_records (
						id TEXT PRIMARY KEY,
						payload TEXT NOT NULL
					) STRICT;
					PRAGMA user_version = ${TASK_SQLITE_SCHEMA_VERSION};
				`);
				this.db.exec("COMMIT");
			} catch (error) {
				if (this.db.inTransaction) this.db.exec("ROLLBACK");
				throw error;
			}
		}

		const marker = this.getMeta(TASK_MIGRATION_COMPLETE_KEY);
		if (marker === undefined) this.migrateLegacyOrInitialize();
		else if (marker !== "1") throw new Error(`[task-store] Invalid tasks.sqlite migration marker ${marker}`);

		const rows = this.readValidatedRows();
		this.retirePendingSources();
		this.recoverPreMigration(rows);
	}

	private getMeta(key: string): string | undefined {
		return (this.db.prepare("SELECT value FROM task_store_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
	}

	private setMeta(key: string, value: string): void {
		this.db.prepare(`
			INSERT INTO task_store_meta(key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run(key, value);
	}

	private readValidatedRows(): ValidatedTaskRow[] {
		const rows: ValidatedTaskRow[] = [];
		const seen = new Set<string>();
		for (const row of this.db.prepare("SELECT id, payload FROM task_records ORDER BY id").iterate() as Iterable<{ id: string; payload: string }>) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.payload);
			} catch (error) {
				throw new Error(`[task-store] Invalid SQLite payload for ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
			const task = validateTask(parsed, `SQLite payload for ${row.id}`, row.id);
			if (seen.has(task.id)) throw new Error(`[task-store] Duplicate SQLite identity ${task.id}`);
			seen.add(task.id);
			rows.push({ id: row.id, payload: row.payload, task });
		}
		return rows;
	}

	private verifyRows(expected: Map<string, string>): void {
		const actual = new Map(this.readValidatedRows().map(row => [row.id, row.payload]));
		if (actual.size !== expected.size) {
			throw new Error(`[task-store] SQLite import verification count mismatch: expected ${expected.size}, got ${actual.size}`);
		}
		for (const [id, payload] of expected) {
			if (actual.get(id) !== payload) throw new Error(`[task-store] SQLite import verification failed for ${id}`);
		}
	}

	private readSource(file: string, sourceLabel: string): PersistedTask[] {
		return parseTaskArray(this.fs.readFileSync(file, "utf-8"), sourceLabel);
	}

	private recoveryEligible(task: PersistedTask, tombstonedGoals: Set<string>): boolean {
		return !tombstonedGoals.has(task.goalId);
	}

	private migrateLegacyOrInitialize(): void {
		const row = this.db.prepare("SELECT COUNT(*) AS count FROM task_records").get() as { count: number };
		if (row.count !== 0) throw new Error("[task-store] tasks.sqlite contains records without a completed migration marker");

		const recoveryFile = `${this.legacyFile}.pre-migration`;
		const hadLegacy = this.fs.existsSync(this.legacyFile);
		const hadRecovery = this.fs.existsSync(recoveryFile);
		const recovery = hadRecovery ? this.readSource(recoveryFile, "tasks.json.pre-migration") : [];
		const legacy = hadLegacy ? this.readSource(this.legacyFile, "tasks.json") : [];
		const tombstonedGoals = readDeletionTombstones(this.stateDir, "goals.json");
		const merged = new Map<string, PersistedTask>();
		for (const task of recovery) {
			if (this.recoveryEligible(task, tombstonedGoals)) merged.set(task.id, task);
		}
		for (const task of legacy) merged.set(task.id, task);
		const expected = new Map([...merged].map(([id, task]) => [id, JSON.stringify(task)]));

		const insert = this.db.prepare("INSERT INTO task_records(id, payload) VALUES (?, ?)");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const task of merged.values()) insert.run(task.id, JSON.stringify(task));
			this.verifyRows(expected);
			this.setMeta(TASK_MIGRATION_COMPLETE_KEY, "1");
			if (hadLegacy) this.setMeta(TASK_LEGACY_RETIREMENT_KEY, "1");
			if (hadRecovery) {
				this.setMeta(TASK_RECOVERY_COMPLETE_KEY, "1");
				this.setMeta(TASK_RECOVERY_RETIREMENT_KEY, "1");
			}
			this.db.exec("COMMIT");
		} catch (error) {
			if (this.db.inTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private recoverPreMigration(existingRows: ValidatedTaskRow[]): void {
		const recoveryFile = `${this.legacyFile}.pre-migration`;
		if (!this.fs.existsSync(recoveryFile) || this.getMeta(TASK_RECOVERY_COMPLETE_KEY) === "1") return;
		const recovery = this.readSource(recoveryFile, "tasks.json.pre-migration");
		const tombstonedGoals = readDeletionTombstones(this.stateDir, "goals.json");
		const expected = new Map(existingRows.map(row => [row.id, row.payload]));
		const eligible = recovery.filter(task => expected.has(task.id) || this.recoveryEligible(task, tombstonedGoals));
		for (const task of eligible) {
			if (!expected.has(task.id)) expected.set(task.id, JSON.stringify(task));
		}

		const insert = this.db.prepare("INSERT INTO task_records(id, payload) VALUES (?, ?) ON CONFLICT(id) DO NOTHING");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const task of eligible) insert.run(task.id, JSON.stringify(task));
			this.verifyRows(expected);
			this.setMeta(TASK_RECOVERY_COMPLETE_KEY, "1");
			this.setMeta(TASK_RECOVERY_RETIREMENT_KEY, "1");
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
			{ key: TASK_LEGACY_RETIREMENT_KEY, source: this.legacyFile, preferred: `${this.legacyFile}.sqlite-retired` },
			{ key: TASK_RECOVERY_RETIREMENT_KEY, source: `${this.legacyFile}.pre-migration`, preferred: `${this.legacyFile}.pre-migration-recovered` },
		];
		for (const item of pending) {
			const intent = this.getMeta(item.key);
			if (intent === undefined) continue;
			if (intent !== "1") throw new Error(`[task-store] Invalid retirement intent ${item.key}=${intent}`);
			if (this.fs.existsSync(item.source)) this.retireSourceWithoutReplace(item.source, item.preferred);
			this.db.prepare("DELETE FROM task_store_meta WHERE key = ?").run(item.key);
		}
	}

	loadInto(tasks: Map<string, PersistedTask>): void {
		for (const row of this.readValidatedRows()) {
			tasks.set(row.id, row.task);
			this.durable.set(row.id, structuredClone(row.task));
		}
	}

	schedule(ids: Iterable<string>): void {
		this.assertOpen();
		let changed = false;
		for (const id of ids) {
			this.dirty.add(id);
			changed = true;
		}
		if (!changed) return;
		this.revision++;
		this.requested = true;
		if (this.inFlight || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.startDrain();
		}, TASK_SQLITE_DEBOUNCE_MS);
		this.timer.unref?.();
	}

	flush(): Promise<void> {
		if (!this.hasPendingWork()) return Promise.resolve();
		return this.requestBarrier();
	}

	publishStrict(ids: Iterable<string>): Promise<TaskPublication> {
		this.assertOpen();
		for (const id of ids) this.dirty.add(id);
		return this.requestBarrier().then(() => this.lastPublication);
	}

	getLastWriteMetrics(): TaskWriteMetrics | null { return this.lastWriteMetrics; }

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
		if (this.closed || this.closePromise) throw new Error("[task-store] SQLite persistence is closing or closed");
	}

	private hasPendingWork(): boolean {
		return this.dirty.size > 0 || this.requested || this.inFlight !== null || this.timer !== null;
	}

	private async flushForClose(): Promise<void> {
		if (!this.hasPendingWork()) return;
		let lastError: unknown;
		for (let attempt = 0; attempt < TASK_SQLITE_CLOSE_ATTEMPTS; attempt++) {
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
			const ids = [...this.dirty];
			this.dirty.clear();
			const snapshots = ids.map(id => ({ id, task: this.tasks.get(id) }));
			const startedAt = performance.now();
			let bytes = 0;
			const previous = new Map<string, PersistedTask>();
			const current = new Map<string, PersistedTask>();
			for (const { id } of snapshots) {
				const durable = this.durable.get(id);
				if (durable) previous.set(id, durable);
			}
			try {
				if (snapshots.length > 0) {
					const upsert = this.db.prepare(`
						INSERT INTO task_records(id, payload) VALUES (?, ?)
						ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
					`);
					const remove = this.db.prepare("DELETE FROM task_records WHERE id = ?");
					this.db.exec("BEGIN IMMEDIATE");
					for (const snapshot of snapshots) {
						if (!snapshot.task) {
							remove.run(snapshot.id);
							continue;
						}
						const payload = serializeTaskForPublication(snapshot.task, snapshot.id);
						const durableTask = JSON.parse(payload) as PersistedTask;
						current.set(snapshot.id, durableTask);
						bytes += Buffer.byteLength(payload);
						upsert.run(snapshot.id, payload);
					}
					this.db.exec("COMMIT");
				}
				for (const { id } of snapshots) {
					const durableTask = current.get(id);
					if (durableTask) this.durable.set(id, durableTask);
					else this.durable.delete(id);
				}
				this.lastPublication = { previous, current };
				this.lastWriteMetrics = { bytes, durationMs: performance.now() - startedAt };
				this.settlePublished(revision);
			} catch (error) {
				if (this.db.inTransaction) {
					try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
				}
				for (const { id } of snapshots) this.dirty.add(id);
				this.settleFailed(revision, error);
				console.error("[task-store] Failed to save SQLite tasks:", error);
				return;
			}
		}
	}

	private settlePublished(revision: number): void {
		this.publishedRevision = Math.max(this.publishedRevision, revision);
		const pending: TaskWriteBarrier[] = [];
		for (const barrier of this.barriers) {
			if (barrier.revision <= this.publishedRevision) barrier.resolve();
			else pending.push(barrier);
		}
		this.barriers = pending;
	}

	private settleFailed(revision: number, error: unknown): void {
		const pending: TaskWriteBarrier[] = [];
		for (const barrier of this.barriers) {
			if (barrier.revision <= revision) barrier.reject(error);
			else pending.push(barrier);
		}
		this.barriers = pending;
	}
}

export interface TaskStoreOptions {
	/** Explicit test adapter; production defaults to SQLite. */
	persistence?: "sqlite" | "json";
}

/** In-memory task read model with JSON fixtures and production SQLite persistence. */
export class TaskStore {
	private readonly persistence: TaskPersistence;
	private tasks: Map<string, PersistedTask> = new Map();
	private generation = 0;
	private acceptingMutations = true;
	private closePromise: Promise<void> | null = null;
	private committedFactBatch: TaskFactBatch | null = null;
	private lastFactBatchPromise: Promise<void> | null = null;
	private factPublishTail: Promise<void> = Promise.resolve();
	private retryCommittedFacts: TaskCommittedFact[] = [];

	/** Called only after a fact's task snapshot crosses a strict persistence fence. */
	onCommittedFact?: (fact: TaskCommittedFact) => void;

	constructor(stateDir: string, fsImpl: FsLike = realFs, options: TaskStoreOptions = {}) {
		const persistence = options.persistence ?? (fsImpl === realFs ? "sqlite" : "json");
		this.persistence = persistence === "json"
			? new JsonTaskPersistence(fsImpl, stateDir, this.tasks)
			: new SqliteTaskPersistence(fsImpl, stateDir, this.tasks);
		try {
			this.persistence.loadInto(this.tasks);
		} catch (error) {
			this.persistence.dispose();
			throw error;
		}
	}

	private assertAcceptingMutations(): void {
		// Some focused generation tests construct the historical in-memory read
		// model directly from the prototype; only an explicit close fence rejects.
		if (this.acceptingMutations === false) throw new Error("[task-store] TaskStore is closing or closed");
	}

	private save(ids: Iterable<string>): void {
		this.persistence.schedule(ids);
	}

	/** Await all pending persistence, primarily for orderly shutdown/tests. */
	flush(): Promise<void> {
		let batch = this.committedFactBatch;
		if (!batch && this.retryCommittedFacts.length > 0) {
			batch = this.createCommittedFactBatch();
			this.committedFactBatch = batch;
		}
		if (batch) this.startCommittedFactBatch(batch);
		const factBarrier = this.lastFactBatchPromise;
		return factBarrier ? factBarrier.then(() => this.persistence.flush()) : this.persistence.flush();
	}

	/** Flush pending persistence and release the SQLite database handle. */
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.acceptingMutations = false;
		if (!this.committedFactBatch && !this.lastFactBatchPromise && this.retryCommittedFacts.length === 0) {
			this.closePromise = this.persistence.close();
			return this.closePromise;
		}
		this.closePromise = (async () => {
			let lastError: unknown;
			try {
				for (let attempt = 0; attempt < TASK_SQLITE_CLOSE_ATTEMPTS; attempt++) {
					try {
						await this.flush();
						await this.persistence.close();
						return;
					} catch (error) {
						lastError = error;
					}
				}
				throw lastError;
			} finally {
				if (lastError) this.persistence.dispose();
			}
		})();
		return this.closePromise;
	}

	/** Release resources after a surrounding constructor fails before ownership transfers. */
	dispose(): void {
		this.acceptingMutations = false;
		this.persistence.dispose();
	}

	/** Latest transaction duration and serialized payload byte count. */
	getPersistenceMetrics() { return this.persistence.getLastWriteMetrics(); }

	/** Current generation counter. Loading persisted tasks does not increment it. */
	getGeneration(): number { return this.generation; }

	put(task: PersistedTask): void {
		this.assertAcceptingMutations();
		this.tasks.set(task.id, task);
		this.save([task.id]);
		this.generation++;
	}

	/**
	 * Publish a task mutation through the fail-loud persistence barrier, then
	 * report its already-bounded facts. Observer failures are isolated because
	 * the authoritative task mutation has already committed.
	 */
	putCommitted(task: PersistedTask, facts: readonly TaskCommittedFact[]): Promise<void> {
		this.assertAcceptingMutations();
		this.tasks.set(task.id, task);
		this.generation++;
		// Preserve the historical coalesced hot path until a host observer is
		// installed. With facts, the serialized strict batch below owns scheduling;
		// a separate trailing write could otherwise commit its mutable task first
		// and consume the durable delta before the fact batch observes it.
		if (!this.onCommittedFact || facts.length === 0) {
			this.save([task.id]);
			return Promise.resolve();
		}

		let batch = this.committedFactBatch;
		if (!batch) {
			batch = this.createCommittedFactBatch();
			this.committedFactBatch = batch;
			queueMicrotask(() => this.startCommittedFactBatch(batch!));
		}
		batch.facts.push(...facts);
		return batch.promise;
	}

	private createCommittedFactBatch(): TaskFactBatch {
		let resolve!: () => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<void>((batchResolve, batchReject) => {
			resolve = batchResolve;
			reject = batchReject;
		});
		return { facts: [], promise, resolve, reject, started: false };
	}

	private startCommittedFactBatch(batch: TaskFactBatch): void {
		if (batch.started) return;
		batch.started = true;
		if (this.committedFactBatch === batch) this.committedFactBatch = null;

		const publish = this.factPublishTail.then(async () => {
			const intents = [...this.retryCommittedFacts, ...batch.facts];
			this.retryCommittedFacts = [];
			const ids = [...new Set(intents.map(fact => fact.taskId))];
			try {
				const publication = await this.persistence.publishStrict(ids);
				this.reportCommittedTaskDeltas(intents, publication);
			} catch (error) {
				this.retryCommittedFacts = [...intents, ...this.retryCommittedFacts];
				throw error;
			}
		});
		this.factPublishTail = publish.catch(() => undefined);
		this.lastFactBatchPromise = batch.promise;
		void publish.then(batch.resolve, batch.reject).finally(() => {
			if (this.lastFactBatchPromise === batch.promise) this.lastFactBatchPromise = null;
		});
	}

	private reportCommittedTaskDeltas(intents: readonly TaskCommittedFact[], publication: TaskPublication): void {
		const orderedIds = [...new Set(intents.map(fact => fact.taskId))];
		for (const taskId of orderedIds) {
			const taskIntents = intents.filter(fact => fact.taskId === taskId);
			const previous = publication.previous.get(taskId);
			const current = publication.current.get(taskId);
			if (!current) continue;

			const facts: TaskCommittedFact[] = [];
			if (!previous) {
				facts.push({
					kind: "taskCreated", taskId, goalId: current.goalId, type: current.type,
					state: current.state, parentTaskId: current.parentTaskId, revision: current.updatedAt,
				});
			} else {
				const updateIntents = taskIntents.filter((fact): fact is Extract<TaskCommittedFact, { kind: "taskUpdated" }> => fact.kind === "taskUpdated");
				if (updateIntents.length > 0) {
					const candidates = [...new Set(updateIntents.flatMap(fact => fact.changedFields))];
					const changedFields = candidates.filter(field => !taskFactValuesEqual(
						(previous as unknown as Record<string, unknown>)[field],
						(current as unknown as Record<string, unknown>)[field],
					)).sort();
					facts.push({
						kind: "taskUpdated", taskId, goalId: current.goalId, state: current.state,
						changedFields, revision: current.updatedAt,
					});
				}
				if (taskIntents.some(fact => fact.kind === "taskStateChanged") && previous.state !== current.state) {
					facts.push({
						kind: "taskStateChanged", taskId, goalId: current.goalId,
						previousState: previous.state, state: current.state, revision: current.updatedAt,
					});
				}
			}

			for (const fact of facts) {
				try {
					this.onCommittedFact?.(Object.freeze({
						...fact,
						...(fact.kind === "taskUpdated" ? { changedFields: Object.freeze([...fact.changedFields]) as unknown as string[] } : {}),
					}));
				} catch (error) {
					console.error(`[task-store] Committed fact observer failed for ${fact.taskId}:`, error);
				}
			}
		}
	}

	get(id: string): PersistedTask | undefined { return this.tasks.get(id); }

	remove(id: string): void {
		this.assertAcceptingMutations();
		this.tasks.delete(id);
		this.save([id]);
		this.generation++;
	}

	removeMany(ids: string[]): void {
		this.assertAcceptingMutations();
		for (const id of ids) this.tasks.delete(id);
		if (ids.length > 0) {
			this.save(ids);
			this.generation++;
		}
	}

	getAll(): PersistedTask[] { return Array.from(this.tasks.values()); }
	getByGoalId(goalId: string): PersistedTask[] { return this.getAll().filter(task => task.goalId === goalId); }
	getBySessionId(sessionId: string): PersistedTask[] { return this.getAll().filter(task => task.assignedSessionId === sessionId); }
	getByParentTaskId(parentTaskId: string): PersistedTask[] { return this.getAll().filter(task => task.parentTaskId === parentTaskId); }
}
