import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Workflow } from "./workflow-store.js";
import type { GateStepDiagnostics } from "../gate-diagnostics.js";
import { CoalescedJsonWriter, type JsonWriteMetrics } from "./coalesced-json-writer.js";
import { getCpuDiagnostics, recordEventLoopOperation } from "./cpu-diagnostics.js";
import {
	GATE_STORE_HOT_SIGNAL_LIMIT,
	GATE_STORE_ORDINARY_BYTES_LIMIT,
	GATE_STORE_ORDINARY_SIGNAL_LIMIT,
	GATE_STORE_SCHEMA_VERSION,
	collectPayloadRefs,
	compactSignalsForPersistence,
	enforceOrdinaryRetention,
	gateStoreV2Root,
	goalRecordPath,
	historyRecordPath,
	legacyRecordPath,
	payloadPath,
	stableGateStoreId,
	type CompactionStats,
	type GateStoreV2BypassAuditRecord,
	type GateStoreV2GoalRecord,
	type GateStoreV2HistoryRecord,
	type GateStoreV2LegacyRecord,
	type GateStoreV2Manifest,
	validateManagedGatePayloadRefOwnership,
} from "./gate-store-v2-persistence.js";
import {
	appendBypassAuditRecord,
	isBypassAuditRecordPublished,
	loadBypassAuditRecords,
} from "./gate-store-bypass-audit.js";
import {
	claimGateStorePreload,
	prepareGateStoreMigration,
	type GateStoreMigrationWorkerResult,
	type GateStorePreloadedState,
} from "./gate-store-migration-worker.js";
import {
	getGateStoreMaintenanceInventory,
	invalidateGateStoreMaintenanceInventory,
	type GateStoreMaintenanceEntry,
	type GateStoreMaintenanceScanResult,
	type GateStoreMaintenanceTotals,
	type GateStoreMaintenanceUnavailable,
} from "./gate-store-maintenance-worker.js";
import { prepareGateSignalsInWorker } from "./gate-store-payload-worker.js";

export interface ManagedGatePayloadRef {
	kind: "gate-payload-v2";
	sha256: string;
	bytes: number;
	/** Internal path validated by readers before use; never exposed by maintenance summaries. */
	path: string;
}

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
	/** Durable external body used after v2 compaction/migration. */
	outputRef?: ManagedGatePayloadRef;
	duration_ms: number;
	expect?: "success" | "failure";
	artifact?: {
		content: string;
		contentRef?: ManagedGatePayloadRef;
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

export interface GateSignal {
	id: string;
	gateId: string;
	goalId: string;
	sessionId: string;
	timestamp: number;
	commitSha: string;
	metadata?: Record<string, string>;
	content?: string;
	/** Durable external signal content (including complete bypass reasons). */
	contentRef?: ManagedGatePayloadRef;
	/** Full bypass reason when metadata contains only a bounded display preview. */
	bypassReasonRef?: ManagedGatePayloadRef;
	/** Oversized audit metadata values, keyed by their original metadata key. */
	auditMetadataRefs?: Record<string, ManagedGatePayloadRef>;
	contentVersion?: number;
	verification: {
		status: "running" | "passed" | "failed";
		steps: GateSignalStep[];
	};
	/** Stable history identity; unlike an array index it never shifts after compaction. */
	persistenceOrdinal?: number;
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
	/** Oldest stable ordinal still retained from post-v2 ordinary history. */
	earliestRetainedOrdinal?: number;
	/** Compact audit tombstones for removed post-v2 ordinal ranges. */
	prunedSignalRanges?: Array<{ from: number; to: number; reason: "count" | "bytes" | "count-and-bytes"; compactedAt: number }>;
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

export interface GateStorePersistenceMetrics extends JsonWriteMetrics {
	shardsWritten: number;
	payloadBytes: number;
	externalizedBytes: number;
	migrationBytes: number;
	migrationMs: number;
	compactions: number;
	prunedSignals: number;
	prunedBytes: number;
	reclaimedPayloadBytes: number;
	orphanPayloadBytes: number;
	orphanPayloads: number;
	reclaimFailureBytes: number;
	reclaimFailures: number;
	bypassAuditBytes: number;
	bypassAuditRecords: number;
	retention: {
		hotSignals: number;
		ordinarySignals: number;
		ordinaryBytes: number;
	};
}

export interface GateStoreMaintenanceReport extends Omit<GateStoreMaintenanceScanResult, "totals" | "largest"> {
	cutoffs: { hotSignals: number; ordinarySignals: number; ordinaryBytes: number };
	totals: GateStoreMaintenanceTotals;
	metrics: GateStorePersistenceMetrics;
	largest: GateStoreMaintenanceEntry[];
}

export type GateStoreMaintenanceResult = GateStoreMaintenanceReport | GateStoreMaintenanceUnavailable;

export class GateStore {
	private readonly storeFile: string;
	private readonly v2Root: string;
	private readonly fs: FsLike;
	private readonly writers = new Map<string, CoalescedJsonWriter>();
	private readonly historyWriters = new Map<string, CoalescedJsonWriter>();
	private readonly legacySignalIds = new Set<string>();
	private readonly retention = new Map<string, CompactionStats>();
	private readonly legacyPayloadRefs = new Set<string>();
	private readonly auditPayloadRefs = new Set<string>();
	/** Replaceable managed-payload owners keyed by the canonical goal::gate partition. */
	private readonly partitionPayloadRefs = new Map<string, Set<string>>();
	private readonly pendingPartitionPayloadRefs = new Map<string, Set<string>>();
	private readonly pendingReclaims = new Set<string>();
	private readonly pendingCompactions = new Map<string, Array<{
		gateId: string;
		removedIds: Set<string>;
		earliestRetainedOrdinal: number;
		prunedSignalRanges: NonNullable<GateState["prunedSignalRanges"]>;
		prunedSignals: number;
		prunedBytes: number;
	}>>();
	private readonly pendingCanonicalSignals = new Map<string, Array<{
		gateId: string;
		signalId: string;
		sourceVerification: GateSignal["verification"];
		sourceContent: string | undefined;
		compacted: GateSignal;
	}>>();
	/** Bypass rows embedded in the next shard until their immutable audit row exists. */
	private readonly pendingBypassAudit = new Map<string, Array<{ gateId: string; signal: GateSignal }>>();
	/** Goals whose shard-first bypass transaction still needs its cleanup shard. */
	private readonly pendingBypassCleanup = new Set<string>();
	private gates: Map<string, GateState> = new Map();
	private metrics: GateStorePersistenceMetrics = {
		bytes: 0,
		durationMs: 0,
		serializationMs: 0,
		writeMs: 0,
		filesWritten: 0,
		shardsWritten: 0,
		payloadBytes: 0,
		externalizedBytes: 0,
		migrationBytes: 0,
		migrationMs: 0,
		compactions: 0,
		prunedSignals: 0,
		prunedBytes: 0,
		reclaimedPayloadBytes: 0,
		orphanPayloadBytes: 0,
		orphanPayloads: 0,
		reclaimFailureBytes: 0,
		reclaimFailures: 0,
		bypassAuditBytes: 0,
		bypassAuditRecords: 0,
		retention: {
			hotSignals: GATE_STORE_HOT_SIGNAL_LIMIT,
			ordinarySignals: GATE_STORE_ORDINARY_SIGNAL_LIMIT,
			ordinaryBytes: GATE_STORE_ORDINARY_BYTES_LIMIT,
		},
	};

	/** Optional callback invoked when gate summary truth changes (for bumping goal generation). */
	onStatusChange?: (goalId: string, gateId: string) => void;

	/**
	 * Off-loop first-open boundary for production project contexts. Concurrent
	 * callers share one worker and must await it before publishing a GateStore.
	 * Injected FsLike callers may consume that same validated one-shot preload;
	 * without one, the constructor retains its deterministic synchronous seam.
	 */
	static prepare(stateDir: string): Promise<GateStoreMigrationWorkerResult> {
		return prepareGateStoreMigration(stateDir);
	}

	constructor(stateDir: string, fsImpl: FsLike = realFs, preload?: GateStorePreloadedState) {
		this.fs = fsImpl;
		this.storeFile = path.join(stateDir, "gates.json");
		const claimed = preload ? claimGateStorePreload(stateDir, preload) : undefined;
		this.v2Root = claimed?.v2Root ?? gateStoreV2Root(stateDir);
		if (claimed) this.loadPreloaded(claimed);
		else this.load();
	}

	private readJson<T>(file: string): T {
		return JSON.parse(this.fs.readFileSync(file, "utf-8")) as T;
	}

	/**
	 * Bind every persisted managed reference to this store's trusted root before
	 * it can participate in inspection, cache lookup, audit export, or payload
	 * reference accounting. This load-time pass is structural only: explicit
	 * bounded readers perform file identity, size, and checksum validation.
	 * Invalid references become safe misses and their persisted paths are unused.
	 */
	private bindLoadedPayloadRefs<T>(value: T): T {
		const bind = (candidate: unknown): unknown => {
			if (!candidate || typeof candidate !== "object") return candidate;
			if (Array.isArray(candidate)) {
				for (let index = candidate.length - 1; index >= 0; index--) {
					const bound = bind(candidate[index]);
					if (bound === undefined) candidate.splice(index, 1);
					else candidate[index] = bound;
				}
				return candidate;
			}
			const record = candidate as Record<string, unknown>;
			if (record.kind === "gate-payload-v2") {
				const ref = record as unknown as ManagedGatePayloadRef;
				return validateManagedGatePayloadRefOwnership(this.v2Root, ref) ? ref : undefined;
			}
			for (const [key, child] of Object.entries(record)) {
				const bound = bind(child);
				if (bound === undefined) delete record[key];
				else record[key] = bound;
			}
			return record;
		};
		return bind(value) as T;
	}

	/** Preserve every immutable bypass payload while rejecting foreign refs. */
	private collectOwnedBypassAuditPayloadRefs(): void {
		const auditRoot = path.join(this.v2Root, "audit");
		if (!this.fs.existsSync(auditRoot)) return;
		for (const goalDirectory of this.fs.readdirSync(auditRoot) as string[]) {
			if (!/^[a-f0-9]{64}$/.test(goalDirectory)) continue;
			const goalRoot = path.join(auditRoot, goalDirectory);
			for (const gateDirectory of this.fs.readdirSync(goalRoot) as string[]) {
				if (!/^[a-f0-9]{64}$/.test(gateDirectory)) continue;
				const gateRoot = path.join(goalRoot, gateDirectory);
				for (const name of this.fs.readdirSync(gateRoot) as string[]) {
					if (!/^\d{16}-[a-f0-9]{64}\.json$/.test(name)) continue;
					const record = this.bindLoadedPayloadRefs(this.readJson<GateStoreV2BypassAuditRecord>(path.join(gateRoot, name)));
					const ordinal = String(record.ordinal).padStart(16, "0");
					const expectedName = `${ordinal}-${stableGateStoreId(record.signal.id)}.json`;
					if (record.schemaVersion !== GATE_STORE_SCHEMA_VERSION
						|| stableGateStoreId(record.goalId) !== goalDirectory
						|| stableGateStoreId(record.gateId) !== gateDirectory
						|| record.signal.goalId !== record.goalId
						|| record.signal.gateId !== record.gateId
						|| record.signal.persistenceOrdinal !== record.ordinal
						|| record.signal.metadata?.bypass !== "true"
						|| name !== expectedName) throw new Error(`invalid bypass audit record ${name}`);
					collectPayloadRefs(record, this.auditPayloadRefs);
				}
			}
		}
	}

	private writeJsonAtomic(file: string, value: unknown): number {
		const json = JSON.stringify(value);
		this.fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		this.fs.writeFileSync(tmp, json, "utf8");
		this.fs.renameSync(tmp, file);
		return Buffer.byteLength(json);
	}

	private ensureEmptyV2(): void {
		if (this.fs.existsSync(path.join(this.v2Root, "manifest.json"))) return;
		this.fs.mkdirSync(path.join(this.v2Root, "goals"), { recursive: true });
		this.fs.mkdirSync(path.join(this.v2Root, "legacy"), { recursive: true });
		this.fs.mkdirSync(path.join(this.v2Root, "history"), { recursive: true });
		this.fs.mkdirSync(path.join(this.v2Root, "payloads"), { recursive: true });
		const now = Date.now();
		this.writeJsonAtomic(path.join(this.v2Root, "manifest.json"), {
			schemaVersion: GATE_STORE_SCHEMA_VERSION,
			state: "complete",
			sourceFile: "none",
			sourceBytes: 0,
			sourceSha256: createHash("sha256").update("").digest("hex"),
			gateCount: 0,
			signalCount: 0,
			bypassCount: 0,
			externalizedBytes: 0,
			payloadBytes: 0,
			inventory: [],
			migrationMs: 0,
			migratedAt: now,
			validatedAt: now,
		} satisfies GateStoreV2Manifest);
	}

	private migrateLegacy(data: GateState[], sourceJson: string): void {
		const startedAt = performance.now();
		const staging = `${this.v2Root}.staging`;
		try { this.fs.rmSync(staging, { recursive: true, force: true }); } catch { /* restart cleanup */ }
		try {
			this.fs.mkdirSync(path.join(staging, "goals"), { recursive: true });
			this.fs.mkdirSync(path.join(staging, "legacy"), { recursive: true });
			this.fs.mkdirSync(path.join(staging, "payloads"), { recursive: true });
		const byGoal = new Map<string, GateState[]>();
		for (const gate of data) {
			if (!gate?.gateId || !gate?.goalId) continue;
			const bucket = byGoal.get(gate.goalId) ?? [];
			bucket.push(gate);
			byGoal.set(gate.goalId, bucket);
		}
		let signalCount = 0;
		let bypassCount = 0;
		let externalizedBytes = 0;
		let writtenBytes = 0;
		for (const [goalId, gates] of byGoal) {
			const legacyGates: GateStoreV2LegacyRecord["gates"] = [];
			const currentGates: GateState[] = [];
			for (const gate of gates) {
				for (let ordinal = 0; ordinal < (gate.signals?.length ?? 0); ordinal++) {
					if (gate.signals[ordinal]!.persistenceOrdinal === undefined) gate.signals[ordinal]!.persistenceOrdinal = ordinal;
				}
				const compacted = compactSignalsForPersistence(this.fs, staging, gate.signals ?? [], this.v2Root);
				externalizedBytes += compacted.externalizedBytes;
				signalCount += compacted.signals.length;
				bypassCount += compacted.signals.filter(signal => signal.metadata?.bypass === "true").length;
				legacyGates.push({ gateId: gate.gateId, signals: compacted.signals });
				currentGates.push({ ...gate, signals: [] });
			}
			writtenBytes += this.writeJsonAtomic(legacyRecordPath(staging, goalId), {
				schemaVersion: GATE_STORE_SCHEMA_VERSION, sealed: true, goalId, gates: legacyGates,
			} satisfies GateStoreV2LegacyRecord);
			writtenBytes += this.writeJsonAtomic(goalRecordPath(staging, goalId), {
				schemaVersion: GATE_STORE_SCHEMA_VERSION, goalId, gates: currentGates, history: {}, retention: {},
			} satisfies GateStoreV2GoalRecord);
		}
		let payloadBytes = 0;
		const payloadDir = path.join(staging, "payloads");
		for (const prefix of this.fs.readdirSync(payloadDir) as string[]) {
			const dir = path.join(payloadDir, prefix);
			for (const file of this.fs.readdirSync(dir) as string[]) payloadBytes += this.fs.statSync(path.join(dir, file)).size;
		}
		const now = Date.now();
		const manifest: GateStoreV2Manifest = {
			schemaVersion: GATE_STORE_SCHEMA_VERSION,
			state: "complete",
			sourceFile: "gates.json",
			sourceBytes: Buffer.byteLength(sourceJson),
			sourceSha256: createHash("sha256").update(sourceJson).digest("hex"),
			gateCount: data.length,
			signalCount,
			bypassCount,
			externalizedBytes,
			payloadBytes,
			inventory: [...byGoal].map(([goalId, gates]) => ({ goalId, gateIds: gates.map(gate => gate.gateId).sort() })).sort((a, b) => a.goalId.localeCompare(b.goalId)),
			migrationMs: performance.now() - startedAt,
			migratedAt: now,
			validatedAt: now,
		};
		writtenBytes += this.writeJsonAtomic(path.join(staging, "manifest.json"), manifest);
		const validated = this.readJson<GateStoreV2Manifest>(path.join(staging, "manifest.json"));
		let validatedGates = 0;
		let validatedSignals = 0;
		const validatedKeys = new Set<string>();
		const validatedRefs = new Set<string>();
		for (const [goalId] of byGoal) {
			const current = this.readJson<GateStoreV2GoalRecord>(goalRecordPath(staging, goalId));
			const legacy = this.readJson<GateStoreV2LegacyRecord>(legacyRecordPath(staging, goalId));
			if (current.goalId !== goalId || legacy.goalId !== goalId || !legacy.sealed) throw new Error(`gate v2 migration identity validation failed for ${goalId}`);
			validatedGates += current.gates.length;
			for (const gate of legacy.gates) {
				const key = compositeKey(goalId, gate.gateId);
				if (validatedKeys.has(key)) throw new Error(`duplicate migrated gate ${key}`);
				validatedKeys.add(key);
				validatedSignals += gate.signals.length;
			}
			collectPayloadRefs(legacy, validatedRefs);
		}
		for (const hash of validatedRefs) {
			if (!this.fs.existsSync(payloadPath(staging, hash))) throw new Error(`missing migrated gate payload ${hash}`);
		}
		if (validated.signalCount !== signalCount
			|| validated.gateCount !== data.length
			|| validatedGates !== data.length
			|| validatedSignals !== signalCount
			|| validated.state !== "complete") {
			throw new Error("gate v2 migration validation failed");
		}
		this.fs.mkdirSync(path.dirname(this.v2Root), { recursive: true });
		this.fs.renameSync(staging, this.v2Root);
		try { this.fs.renameSync(this.storeFile, `${this.storeFile}.v1-retired`); } catch { /* v2 is authoritative */ }
		this.metrics.migrationBytes = manifest.sourceBytes;
		this.metrics.migrationMs = performance.now() - startedAt;
		recordEventLoopOperation("gate-store:migrate", this.metrics.migrationMs, { bytes: manifest.sourceBytes });
		getCpuDiagnostics().recordPersistence("gate-store:migrate", this.metrics.migrationMs, manifest.sourceBytes);
		this.metrics.externalizedBytes += externalizedBytes;
		this.metrics.payloadBytes = payloadBytes;
		this.metrics.bytes += writtenBytes;
		} catch (error) {
			try { this.fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
			throw error;
		}
	}

	private resumeReclaimCleanup(): void {
		const reclaimDir = path.join(this.v2Root, "reclaim");
		if (!this.fs.existsSync(reclaimDir)) return;
		for (const file of this.fs.readdirSync(reclaimDir) as string[]) {
			const candidate = path.join(reclaimDir, file);
			try {
				this.metrics.reclaimedPayloadBytes += this.fs.statSync(candidate).size;
				this.fs.unlinkSync(candidate);
			} catch { /* bounded maintenance reporting can surface a remaining orphan */ }
		}
	}

	/**
	 * Finish the shard-first bypass transaction. The shard is authoritative before
	 * an immutable audit row is exported; only after every export succeeds may the
	 * embedded copies be removed. Repeating this after any interruption is safe
	 * because audit filenames are stable by ordinal and signal identity.
	 */
	private repairEmbeddedBypassAudit(file: string, record: GateStoreV2GoalRecord): GateStoreV2GoalRecord {
		const embedded = new Map<string, { gateId: string; signal: GateSignal }>();
		for (const gate of record.gates) {
			for (const signal of [...(record.history?.[gate.gateId] ?? []), ...(gate.signals ?? [])]) {
				if (signal.metadata?.bypass !== "true") continue;
				embedded.set(`${gate.gateId}:${signal.persistenceOrdinal}:${signal.id}`, { gateId: gate.gateId, signal });
			}
		}
		if (embedded.size === 0) return record;

		for (const { gateId, signal } of embedded.values()) {
			const audit = appendBypassAuditRecord(this.fs, this.v2Root, record.goalId, gateId, signal);
			collectPayloadRefs(signal, this.auditPayloadRefs);
			if (audit.written) {
				this.metrics.bypassAuditBytes += audit.bytes;
				this.metrics.bypassAuditRecords++;
			}
		}

		const cleaned = structuredClone(record);
		for (const gate of cleaned.gates) {
			gate.signals = (gate.signals ?? []).filter(signal => signal.metadata?.bypass !== "true");
			if (cleaned.history?.[gate.gateId]) {
				cleaned.history[gate.gateId] = cleaned.history[gate.gateId]!.filter(signal => signal.metadata?.bypass !== "true");
			}
		}
		this.writeJsonAtomic(file, cleaned);
		return cleaned;
	}

	/**
	 * Adopt the worker's fully parsed canonical snapshot after the constructor
	 * validates its physical-root identity. No canonical shard or audit file is
	 * read, parsed, traversed, or remapped on the gateway thread here.
	 */
	private loadPreloaded(preload: GateStorePreloadedState): void {
		if (preload.manifest.schemaVersion !== GATE_STORE_SCHEMA_VERSION || preload.manifest.state !== "complete") {
			throw new Error("invalid preloaded gate v2 manifest");
		}
		this.metrics.migrationBytes = preload.manifest.sourceBytes;
		this.metrics.migrationMs = preload.manifest.migrationMs ?? 0;
		this.metrics.externalizedBytes = preload.manifest.externalizedBytes;
		this.metrics.payloadBytes = preload.manifest.payloadBytes;
		this.metrics.reclaimedPayloadBytes = preload.reclaimedPayloadBytes;
		this.metrics.orphanPayloadBytes = preload.orphanPayloadBytes;
		this.metrics.orphanPayloads = preload.orphanPayloads;
		this.metrics.reclaimFailureBytes = preload.reclaimFailureBytes;
		this.metrics.reclaimFailures = preload.reclaimFailures;
		for (const signalId of preload.legacySignalIds) this.legacySignalIds.add(signalId);
		for (const hash of preload.legacyPayloadRefs) this.legacyPayloadRefs.add(hash);
		for (const hash of preload.auditPayloadRefs) this.auditPayloadRefs.add(hash);
		for (const [ownerKey, hashes] of preload.partitionPayloadRefs) this.partitionPayloadRefs.set(ownerKey, hashes);
		// Structured clone preserves Map insertion order. The worker already bound
		// every metadata-only ref to preload.v2Root, which this store adopts above.
		this.gates = preload.gates;
	}

	private loadV2(): void {
		const manifest = this.readJson<GateStoreV2Manifest>(path.join(this.v2Root, "manifest.json"));
		if (manifest.schemaVersion !== GATE_STORE_SCHEMA_VERSION || manifest.state !== "complete") throw new Error("invalid gate v2 manifest");
		this.metrics.migrationBytes = manifest.sourceBytes;
		this.metrics.migrationMs = manifest.migrationMs ?? 0;
		this.metrics.externalizedBytes = manifest.externalizedBytes;
		this.metrics.payloadBytes = manifest.payloadBytes;
		this.collectOwnedBypassAuditPayloadRefs();
		const goalsDir = path.join(this.v2Root, "goals");
		if (!this.fs.existsSync(goalsDir)) return;

		// A .gates.json file is a complete shard whose final atomic rename failed.
		// Roll it forward instead of discarding the only copy of a bypass decision.
		for (const file of this.fs.readdirSync(goalsDir) as string[]) {
			if (!/^[a-f0-9]{64}\.gates\.json$/.test(file)) continue;
			const stagingFile = path.join(goalsDir, file);
			const staged = this.bindLoadedPayloadRefs(this.readJson<GateStoreV2GoalRecord>(stagingFile));
			const expected = `${stableGateStoreId(staged.goalId)}.gates.json`;
			if (staged.schemaVersion !== GATE_STORE_SCHEMA_VERSION || file !== expected) throw new Error(`invalid staged gate shard ${file}`);
			this.fs.renameSync(stagingFile, goalRecordPath(this.v2Root, staged.goalId));
		}
		for (const file of this.fs.readdirSync(goalsDir) as string[]) {
			if (!/^[a-f0-9]{64}\.json(?:\.\d+)?\.tmp$/.test(file)) continue;
			try { this.fs.unlinkSync(path.join(goalsDir, file)); } catch { /* stale incomplete/cleanup shard */ }
		}

		for (const file of this.fs.readdirSync(goalsDir) as string[]) {
			if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
			const recordFile = path.join(goalsDir, file);
			let record = this.bindLoadedPayloadRefs(this.readJson<GateStoreV2GoalRecord>(recordFile));
			if (record.schemaVersion !== GATE_STORE_SCHEMA_VERSION || file !== `${stableGateStoreId(record.goalId)}.json`) {
				throw new Error(`invalid gate shard identity ${file}`);
			}
			record = this.repairEmbeddedBypassAudit(recordFile, record);
			let legacyByGate = new Map<string, GateSignal[]>();
			const legacyFile = legacyRecordPath(this.v2Root, record.goalId);
			if (this.fs.existsSync(legacyFile)) {
				const legacy = this.bindLoadedPayloadRefs(this.readJson<GateStoreV2LegacyRecord>(legacyFile));
				collectPayloadRefs(legacy, this.legacyPayloadRefs);
				if (!legacy.sealed || legacy.goalId !== record.goalId) throw new Error(`invalid sealed legacy gate archive for ${record.goalId}`);
				legacyByGate = new Map(legacy.gates.map(gate => [gate.gateId, gate.signals]));
			}
			for (const gate of record.gates) {
				const legacySignals = legacyByGate.get(gate.gateId) ?? [];
				const ownerRefs = new Set<string>();
				// Early v2 stored history in the goal shard. Attribute those refs to
				// the same replaceable owner as this gate's canonical partition.
				collectPayloadRefs(record.history?.[gate.gateId] ?? [], ownerRefs);
				collectPayloadRefs(gate.signals ?? [], ownerRefs);
				let partitionSignals: GateSignal[] = [];
				const partitionFile = historyRecordPath(this.v2Root, record.goalId, gate.gateId);
				if (this.fs.existsSync(partitionFile)) {
					const partition = this.bindLoadedPayloadRefs(this.readJson<GateStoreV2HistoryRecord>(partitionFile));
					if (partition.schemaVersion !== GATE_STORE_SCHEMA_VERSION || partition.goalId !== record.goalId || partition.gateId !== gate.gateId) throw new Error(`invalid gate history partition ${record.goalId}/${gate.gateId}`);
					partitionSignals = partition.signals;
					for (const signal of partitionSignals.filter(signal => signal.metadata?.bypass === "true")) appendBypassAuditRecord(this.fs, this.v2Root, record.goalId, gate.gateId, signal);
					collectPayloadRefs(partition, ownerRefs);
				}
				this.partitionPayloadRefs.set(compositeKey(record.goalId, gate.gateId), ownerRefs);
				const auditSignals = this.bindLoadedPayloadRefs(loadBypassAuditRecords(this.fs, this.v2Root, record.goalId, gate.gateId));
				collectPayloadRefs(auditSignals, this.auditPayloadRefs);
				const postV2Signals = [...(record.history?.[gate.gateId] ?? []), ...partitionSignals, ...(gate.signals ?? []), ...auditSignals];
				const postV2Ids = new Set(postV2Signals.map(signal => signal.id));
				for (const signal of legacySignals) if (!postV2Ids.has(signal.id)) this.legacySignalIds.add(signal.id);
				const merged = [...legacySignals];
				const mergedIndexes = new Map(merged.map((signal, index) => [signal.id, index]));
				for (const signal of postV2Signals) {
					const existing = mergedIndexes.get(signal.id);
					if (existing === undefined) {
						mergedIndexes.set(signal.id, merged.length);
						merged.push(signal);
					} else {
						merged[existing] = signal;
					}
				}
				gate.signals = merged;
				for (let ordinal = 0; ordinal < gate.signals.length; ordinal++) {
					if (gate.signals[ordinal]!.persistenceOrdinal === undefined) gate.signals[ordinal]!.persistenceOrdinal = ordinal;
				}
				gate.signals.sort((a, b) => (a.persistenceOrdinal ?? 0) - (b.persistenceOrdinal ?? 0));
				this.gates.set(compositeKey(gate.goalId, gate.gateId), gate);
			}
		}
		this.resumeReclaimCleanup();
	}

	private load(): void {
		try {
			const manifest = path.join(this.v2Root, "manifest.json");
			if (!this.fs.existsSync(manifest) && this.fs.existsSync(this.storeFile)) {
				// Without a complete manifest the legacy file remains authoritative;
				// an incomplete final directory is safe to rebuild idempotently.
				if (this.fs.existsSync(this.v2Root)) this.fs.rmSync(this.v2Root, { recursive: true, force: true });
				const sourceJson = this.fs.readFileSync(this.storeFile, "utf-8");
				const data = JSON.parse(sourceJson);
				if (!Array.isArray(data)) throw new Error("legacy gates.json is not an array");
				this.migrateLegacy(data, sourceJson);
			} else if (!this.fs.existsSync(manifest) && this.fs.existsSync(this.v2Root)) {
				throw new Error("incomplete gate v2 state has no authoritative legacy source");
			}
			this.ensureEmptyV2();
			this.loadV2();
		} catch (err) {
			console.error("[gate-store] Failed to load persisted gates:", err);
			throw err;
		}
	}

	private async historySnapshot(goalId: string, gateId: string): Promise<GateStoreV2HistoryRecord> {
		const gate = this.gates.get(compositeKey(goalId, gateId));
		if (!gate) {
			const key = compositeKey(goalId, gateId);
			for (const hash of this.partitionPayloadRefs.get(key) ?? []) this.pendingReclaims.add(hash);
			this.pendingPartitionPayloadRefs.set(key, new Set());
			return {
				schemaVersion: GATE_STORE_SCHEMA_VERSION, goalId, gateId, signals: [],
				retention: { earliestRetainedOrdinal: 0, prunedSignals: 0, prunedBytes: 0 },
			};
		}
		const snapshotCandidateRefs = new Set<string>();
		const postV2 = gate.signals.filter(signal => !this.legacySignalIds.has(signal.id));
		const sourceById = new Map(postV2.map(signal => [signal.id, {
			verification: signal.verification,
			content: signal.content,
			requiresCanonicalization: (signal.metadata?.bypass === "true" && (!!signal.content || Object.values(signal.metadata).some(value => Buffer.byteLength(value) > 16 * 1024)))
				|| signal.verification.steps.some(step => !!step.output || !!step.artifact?.content || (step.diagnostics?.artifacts ?? []).some(artifact => !!artifact.content)),
		}]));
		const compacted = this.fs === realFs
			? await prepareGateSignalsInWorker(this.v2Root, postV2)
			: { ...compactSignalsForPersistence(this.fs, this.v2Root, postV2), signalBytes: undefined };
		const knownBytes = compacted.signalBytes
			? new Map(compacted.signals.map((signal, index) => [signal.id, compacted.signalBytes![index]!]))
			: undefined;
		collectPayloadRefs(compacted.signals, snapshotCandidateRefs);
		this.metrics.externalizedBytes += compacted.externalizedBytes;
		this.metrics.payloadBytes += compacted.payloadBytesWritten;

		const bypass = compacted.signals.filter(signal => signal.metadata?.bypass === "true");
		const unexportedBypass = bypass.filter(signal => !isBypassAuditRecordPublished(this.fs, this.v2Root, goalId, gateId, signal));
		const pendingAudit = unexportedBypass.map(signal => ({ gateId, signal }));
		const ordinaryAndRunning = compacted.signals.filter(signal => signal.metadata?.bypass !== "true");
		const compactStartedAt = performance.now();
		const retained = enforceOrdinaryRetention(ordinaryAndRunning, gate.verificationCacheInvalidatedAt, knownBytes);
		const compactMs = performance.now() - compactStartedAt;
		if (retained.stats.compacted) {
			recordEventLoopOperation("gate-store:compact", compactMs, { bytes: retained.stats.prunedBytes });
			getCpuDiagnostics().recordPersistence("gate-store:compact", compactMs, retained.stats.prunedBytes);
		}
		const key = compositeKey(goalId, gateId);
		this.retention.set(key, { ...retained.stats, retainedBypassSignals: bypass.length });
		let earliestRetainedOrdinal = gate.earliestRetainedOrdinal ?? retained.stats.earliestRetainedOrdinal;
		let prunedSignalRanges = gate.prunedSignalRanges;
		const pendingCompactions: NonNullable<ReturnType<typeof this.pendingCompactions.get>> = [];
		if (retained.stats.compacted) {
			const retainedIds = new Set(retained.signals.map(signal => signal.id));
			const removedSignals = ordinaryAndRunning.filter(signal => !retainedIds.has(signal.id));
			const removedOrdinals = removedSignals.map(signal => signal.persistenceOrdinal).filter((ordinal): ordinal is number => ordinal !== undefined).sort((a, b) => a - b);
			const countExceeded = ordinaryAndRunning.filter(signal => signal.verification.status !== "running").length > GATE_STORE_ORDINARY_SIGNAL_LIMIT;
			const bytesExceeded = retained.stats.inputOrdinaryBytes > GATE_STORE_ORDINARY_BYTES_LIMIT;
			const reason = countExceeded && bytesExceeded ? "count-and-bytes" : countExceeded ? "count" : "bytes";
			const ranges = structuredClone(gate.prunedSignalRanges ?? []);
			for (const ordinal of removedOrdinals) {
				const prior = ranges[ranges.length - 1];
				if (prior && ordinal <= prior.to + 1 && prior.reason === reason) prior.to = Math.max(prior.to, ordinal);
				else ranges.push({ from: ordinal, to: ordinal, reason, compactedAt: Date.now() });
			}
			prunedSignalRanges = ranges.slice(-32);
			earliestRetainedOrdinal = retained.stats.earliestRetainedOrdinal;
			pendingCompactions.push({ gateId, removedIds: new Set(removedSignals.map(signal => signal.id)), earliestRetainedOrdinal, prunedSignalRanges, prunedSignals: retained.stats.prunedSignals, prunedBytes: retained.stats.prunedBytes });
		}
		const pendingCanonical: NonNullable<ReturnType<typeof this.pendingCanonicalSignals.get>> = [];
		for (const compactSignal of [...retained.signals, ...bypass]) {
			const source = sourceById.get(compactSignal.id);
			if (source?.requiresCanonicalization) pendingCanonical.push({ gateId, signalId: compactSignal.id, sourceVerification: source.verification, sourceContent: source.content, compacted: compactSignal });
		}
		const record: GateStoreV2HistoryRecord = {
			schemaVersion: GATE_STORE_SCHEMA_VERSION,
			goalId,
			gateId,
			signals: [...retained.signals, ...unexportedBypass],
			retention: {
				earliestRetainedOrdinal,
				prunedSignals: retained.stats.prunedSignals,
				prunedBytes: retained.stats.prunedBytes,
				...(retained.stats.compacted ? { lastCompactedAt: Date.now() } : {}),
			},
		};
		const nextRefs = collectPayloadRefs(record);
		const priorRefs = this.partitionPayloadRefs.get(key) ?? new Set<string>();
		for (const hash of [...priorRefs, ...snapshotCandidateRefs]) if (!nextRefs.has(hash) && !this.auditPayloadRefs.has(hash)) this.pendingReclaims.add(hash);
		this.pendingPartitionPayloadRefs.set(key, nextRefs);
		this.pendingCompactions.set(key, pendingCompactions);
		this.pendingCanonicalSignals.set(key, pendingCanonical);
		if (pendingAudit.length > 0) this.pendingBypassAudit.set(key, pendingAudit);
		else this.pendingBypassAudit.delete(key);
		return record;
	}

	private async goalSnapshot(goalId: string): Promise<GateStoreV2GoalRecord> {
		// History publication is the durability boundary for signal movement. The
		// small truth shard may be committed only after every dirty gate partition.
		await Promise.all([...this.historyWriters.entries()]
			.filter(([key]) => key.startsWith(`${goalId}::`))
			.map(([, writer]) => writer.flush()));
		const gates = [...this.gates.values()]
			.filter(gate => gate.goalId === goalId)
			.map(gate => ({ ...gate, signals: [] }));
		return { schemaVersion: GATE_STORE_SCHEMA_VERSION, goalId, gates, history: {}, retention: {} };
	}

	private payloadIsReferenced(hash: string): boolean {
		if (this.legacyPayloadRefs.has(hash) || this.auditPayloadRefs.has(hash)) return true;
		for (const refs of this.partitionPayloadRefs.values()) if (refs.has(hash)) return true;
		for (const refs of this.pendingPartitionPayloadRefs.values()) if (refs.has(hash)) return true;
		return false;
	}

	private reclaimUnreferencedPayloads(): void {
		for (const hash of [...this.pendingReclaims]) {
			if (this.payloadIsReferenced(hash)) continue;
			const source = payloadPath(this.v2Root, hash);
			if (!this.fs.existsSync(source)) {
				this.pendingReclaims.delete(hash);
				continue;
			}
			const reclaim = path.join(this.v2Root, "reclaim", `${hash}.payload`);
			try {
				const bytes = this.fs.statSync(source).size;
				this.fs.mkdirSync(path.dirname(reclaim), { recursive: true });
				this.fs.renameSync(source, reclaim);
				this.fs.unlinkSync(reclaim);
				this.metrics.reclaimedPayloadBytes += bytes;
				this.pendingReclaims.delete(hash);
			} catch {
				// Publication already succeeded. Leave either source or staging file for startup retry.
			}
		}
	}

	private historyWriterFor(goalId: string, gateId: string): CoalescedJsonWriter {
		const key = compositeKey(goalId, gateId);
		let writer = this.historyWriters.get(key);
		if (writer) return writer;
		writer = new CoalescedJsonWriter(
			this.fs,
			path.dirname(historyRecordPath(this.v2Root, goalId, gateId)),
			historyRecordPath(this.v2Root, goalId, gateId),
			() => this.historySnapshot(goalId, gateId),
			"gate-store-history",
			500,
			undefined,
			metrics => {
				const canonical = this.pendingCanonicalSignals.get(key) ?? [];
				this.pendingCanonicalSignals.delete(key);
				for (const publication of canonical) {
					const gate = this.gates.get(key);
					const index = gate?.signals.findIndex(signal => signal.id === publication.signalId) ?? -1;
					if (!gate || index < 0) continue;
					const current = gate.signals[index]!;
					if (current.verification === publication.sourceVerification && current.content === publication.sourceContent) gate.signals[index] = publication.compacted;
				}
				const compactions = this.pendingCompactions.get(key) ?? [];
				this.pendingCompactions.delete(key);
				for (const compaction of compactions) {
					const gate = this.gates.get(key);
					if (gate) {
						gate.signals = gate.signals.filter(signal => !compaction.removedIds.has(signal.id));
						gate.earliestRetainedOrdinal = compaction.earliestRetainedOrdinal;
						gate.prunedSignalRanges = compaction.prunedSignalRanges;
					}
					this.metrics.compactions++; this.metrics.prunedSignals += compaction.prunedSignals; this.metrics.prunedBytes += compaction.prunedBytes;
				}
				const nextRefs = this.pendingPartitionPayloadRefs.get(key);
				if (nextRefs) {
					if (nextRefs.size > 0) this.partitionPayloadRefs.set(key, nextRefs);
					else this.partitionPayloadRefs.delete(key);
					this.pendingPartitionPayloadRefs.delete(key);
				}
				if (this.pendingBypassCleanup.has(key) && !this.pendingBypassAudit.has(key)) this.pendingBypassCleanup.delete(key);
				this.metrics = { ...this.metrics, ...metrics, filesWritten: this.metrics.filesWritten + metrics.filesWritten, shardsWritten: this.metrics.shardsWritten + 1 };
				invalidateGateStoreMaintenanceInventory(this.v2Root);
			},
		);
		this.historyWriters.set(key, writer);
		return writer;
	}

	private writerFor(goalId: string): CoalescedJsonWriter {
		let writer = this.writers.get(goalId);
		if (writer) return writer;
		writer = new CoalescedJsonWriter(
			this.fs,
			path.join(this.v2Root, "goals"),
			goalRecordPath(this.v2Root, goalId),
			() => this.goalSnapshot(goalId),
			"gate-store",
			500,
			undefined,
			metrics => {
				// Current truth is durable now. Export immutable bypass audit rows only
				// after that commit, then rewrite just their gate partition to remove the
				// embedded crash-recovery copy.
				for (const [key, bypassAudit] of [...this.pendingBypassAudit]) {
					if (!key.startsWith(`${goalId}::`)) continue;
					this.pendingBypassAudit.delete(key);
					for (const publication of bypassAudit) {
						const audit = appendBypassAuditRecord(this.fs, this.v2Root, goalId, publication.gateId, publication.signal);
						collectPayloadRefs(publication.signal, this.auditPayloadRefs);
						if (audit.written) { this.metrics.bypassAuditBytes += audit.bytes; this.metrics.bypassAuditRecords++; }
					}
					if (bypassAudit.length > 0) {
						this.pendingBypassCleanup.add(key);
						this.historyWriterFor(goalId, bypassAudit[0]!.gateId).schedule();
					} else this.pendingBypassCleanup.delete(key);
				}
				this.metrics = { ...this.metrics, ...metrics, filesWritten: this.metrics.filesWritten + metrics.filesWritten, shardsWritten: this.metrics.shardsWritten + 1 };
				// History owners are replaced when their partitions publish, but an
				// early-v2 goal shard can still contain the prior embedded refs until
				// this truth publication completes. Reclaim only after this boundary.
				this.reclaimUnreferencedPayloads();
				invalidateGateStoreMaintenanceInventory(this.v2Root);
			},
			path.join(this.v2Root, "goals", `${stableGateStoreId(goalId)}.gates.json`),
		);
		this.writers.set(goalId, writer);
		return writer;
	}

	private save(goalId: string, gateId?: string): void {
		if (gateId) this.historyWriterFor(goalId, gateId).schedule();
		this.writerFor(goalId).schedule();
	}

	/** Await dirty history partitions before their small goal-truth shards. */
	async flush(): Promise<void> {
		do {
			await Promise.all([...this.historyWriters.values()].map(writer => writer.flush()));
			await Promise.all([...this.writers.values()].map(writer => writer.flush()));
		} while (this.pendingBypassCleanup.size > 0);
	}

	/** Detailed bounded-persistence, migration, and compaction metrics. */
	getPersistenceMetrics(): GateStorePersistenceMetrics {
		return structuredClone(this.metrics);
	}

	/** Worker-backed, bounded, body-free data source for maintenance_inspect(probe=gate_store). */
	async getMaintenanceReport(): Promise<GateStoreMaintenanceResult> {
		const inventory = await getGateStoreMaintenanceInventory(this.v2Root);
		if ("error" in inventory) return inventory;
		const metrics = this.getPersistenceMetrics();
		metrics.bypassAuditBytes = inventory.totals.auditBytes;
		metrics.bypassAuditRecords = inventory.totals.auditRecords;
		metrics.orphanPayloadBytes = inventory.totals.orphanPayloadBytes;
		metrics.orphanPayloads = inventory.totals.orphanPayloads;
		metrics.reclaimFailureBytes = inventory.totals.reclaimBytes;
		metrics.reclaimFailures = inventory.totals.reclaimFiles;
		return {
			...inventory,
			cutoffs: structuredClone(metrics.retention),
			metrics,
		};
	}

	/** Strict lifecycle writes share the affected goal shard's publication queue. */
	private saveStrict(goalId: string): Promise<void> {
		return this.writerFor(goalId).publishStrict();
	}

	/** Initialize pending gate states for a new goal. */
	initGatesForGoal(goalId: string, gateIds: string[]): void {
		const now = Date.now();
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
			}
		}
		this.save(goalId);
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
		const remainingGateIds = new Set(nextGateIds);
		const modifiedIds = new Set(modifiedGateIds);
		const removedGateIds: string[] = [];
		const now = Date.now();
		let changed = false;

		for (const [key, gate] of this.gates) {
			if (gate.goalId !== goalId) continue;

			if (!remainingGateIds.has(gate.gateId)) {
				this.gates.delete(key);
				removedGateIds.push(gate.gateId);
				changed = true;
				continue;
			}

			remainingGateIds.delete(gate.gateId);
			if (modifiedIds.has(gate.gateId)) {
				gate.status = "pending";
				gate.verificationCacheInvalidatedAt = now;
				gate.updatedAt = now;
				changed = true;
			}
		}

		for (const gateId of remainingGateIds) {
			this.gates.set(compositeKey(goalId, gateId), {
				gateId,
				goalId,
				status: "pending",
				signals: [],
				updatedAt: now,
			});
			changed = true;
		}

		if (changed) {
			for (const gateId of removedGateIds) this.historyWriterFor(goalId, gateId).schedule();
			this.save(goalId);
		}
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
		const key = compositeKey(signal.goalId, signal.gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		if (signal.persistenceOrdinal === undefined) {
			const prior = gate.signals[gate.signals.length - 1]?.persistenceOrdinal;
			signal.persistenceOrdinal = prior === undefined ? gate.signals.length : prior + 1;
		}
		gate.signals.push(signal);
		gate.updatedAt = Date.now();
		this.save(signal.goalId, signal.gateId);
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
		const priorOrdinal = gate.signals[gate.signals.length - 1]?.persistenceOrdinal;
		signal.persistenceOrdinal = priorOrdinal === undefined ? gate.signals.length : priorOrdinal + 1;
		gate.signals.push(signal);
		gate.status = "bypassed";
		gate.updatedAt = now;
		this.save(goalId, gateId);
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
		const key = compositeKey(goalId, gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.status = status;
		gate.updatedAt = Date.now();
		this.save(goalId);
		this.onStatusChange?.(goalId, gateId);
	}

	updateGateContent(goalId: string, gateId: string, content: string, version: number): void {
		const key = compositeKey(goalId, gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.currentContent = content;
		gate.currentContentVersion = version;
		gate.updatedAt = Date.now();
		this.save(goalId);
	}

	updateGateMetadata(goalId: string, gateId: string, metadata: Record<string, string>): void {
		const key = compositeKey(goalId, gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.currentMetadata = metadata;
		gate.updatedAt = Date.now();
		this.save(goalId);
	}

	/** Update a signal's verification results by signal ID. */
	updateSignalVerification(signalId: string, verification: GateSignal["verification"]): void {
		for (const gate of this.gates.values()) {
			const signal = gate.signals.find(s => s.id === signalId);
			if (signal) {
				if (signal.verification.status !== "running") return; // already finalized
				// A migrated running row remains in the sealed archive as historical
				// input, while this mutable projection becomes authoritative in v2.
				this.legacySignalIds.delete(signal.id);
				signal.verification = verification;
				gate.updatedAt = Date.now();
				this.save(gate.goalId, gate.gateId);
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
		const affectedGateIds = this.getDependentGateIds(gateId, workflow, true);
		const changedGateIds: string[] = [];
		const unchangedGateIds: string[] = [];
		const previousStatuses: Record<string, GateStatus> = {};
		const snapshots = new Map<string, { status: GateStatus; updatedAt: number; cacheAt?: number; hadCacheAt: boolean }>();
		const now = Date.now();

		for (const affectedGateId of affectedGateIds) {
			const key = compositeKey(goalId, affectedGateId);
			const gate = this.gates.get(key);
			const previousStatus = gate?.status ?? "pending";
			previousStatuses[affectedGateId] = previousStatus;

			if (gate) {
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
			if (affectedGateIds.length > 0) {
				if (strict) await this.saveStrict(goalId);
				else if (persist) this.save(goalId);
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
		const dependents = this.getDependentGateIds(gateId, workflow, false);
		const changedGateIds: string[] = [];
		const now = Date.now();

		for (const depId of dependents) {
			const key = compositeKey(goalId, depId);
			const gate = this.gates.get(key);
			if (gate && gate.status !== "pending") {
				gate.status = "pending";
				gate.updatedAt = now;
				changedGateIds.push(depId);
			}
		}
		if (changedGateIds.length > 0) this.save(goalId);
	}

	/** Remove all gates for a goal (cleanup on goal deletion). */
	removeGoalGates(goalId: string): void {
		const keysToRemove: string[] = [];
		for (const [key, gate] of this.gates) {
			if (gate.goalId === goalId) keysToRemove.push(key);
		}
		for (const key of keysToRemove) this.gates.delete(key);
		if (keysToRemove.length > 0) {
			for (const key of keysToRemove) this.historyWriterFor(goalId, key.slice(key.indexOf("::") + 2)).schedule();
			this.save(goalId);
		}
	}
}
