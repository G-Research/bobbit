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
	GATE_STORE_CACHE_PROJECTION_BYTES,
	collectPayloadRefs,
	compactSignalsForPersistence,
	enforceOrdinaryRetention,
	gateStoreV2Root,
	goalRecordPath,
	legacyRecordPath,
	payloadPath,
	stableGateStoreId,
	type CompactionStats,
	type GateStoreV2GoalRecord,
	type GateStoreV2LegacyRecord,
	type GateStoreV2Manifest,
	safeReadManagedGatePayload,
} from "./gate-store-v2-persistence.js";
import { appendBypassAuditRecord, collectBypassAuditPayloadRefs, loadBypassAuditRecords, measureBypassAudit } from "./gate-store-bypass-audit.js";
import { prepareGateStoreMigration, type GateStoreMigrationWorkerResult } from "./gate-store-migration-worker.js";
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
	bypassAuditBytes: number;
	bypassAuditRecords: number;
	retention: {
		hotSignals: number;
		ordinarySignals: number;
		ordinaryBytes: number;
	};
}

export interface GateStoreMaintenanceReport {
	schemaVersion: number;
	migration: Pick<GateStoreV2Manifest, "state" | "sourceBytes" | "gateCount" | "signalCount" | "externalizedBytes" | "payloadBytes" | "migratedAt" | "validatedAt">;
	cutoffs: { hotSignals: number; ordinarySignals: number; ordinaryBytes: number };
	totals: { goalBytes: number; legacyBytes: number; auditBytes: number; payloadBytes: number; goalShards: number; legacyShards: number; auditRecords: number; payloads: number };
	staleStaging: boolean;
	metrics: GateStorePersistenceMetrics;
	largest: Array<{ name: string; kind: "goal" | "legacy" | "audit" | "payload"; bytes: number; exceedsLimit: boolean }>;
}

export class GateStore {
	private readonly storeFile: string;
	private readonly v2Root: string;
	private readonly fs: FsLike;
	private readonly writers = new Map<string, CoalescedJsonWriter>();
	private readonly legacySignalIds = new Set<string>();
	private readonly retention = new Map<string, CompactionStats>();
	private readonly legacyPayloadRefs = new Set<string>();
	private readonly auditPayloadRefs = new Set<string>();
	private readonly goalPayloadRefs = new Map<string, Set<string>>();
	private readonly pendingGoalPayloadRefs = new Map<string, Set<string>>();
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
	private readonly cacheProjection = new Map<string, string>();
	private cacheProjectionBytes = 0;
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
	 * Injected FsLike tests retain the constructor's deterministic sync seam.
	 */
	static prepare(stateDir: string): Promise<GateStoreMigrationWorkerResult> {
		return prepareGateStoreMigration(stateDir);
	}

	constructor(stateDir: string, fsImpl: FsLike = realFs) {
		this.fs = fsImpl;
		this.storeFile = path.join(stateDir, "gates.json");
		this.v2Root = gateStoreV2Root(stateDir);
		this.load();
	}

	private readJson<T>(file: string): T {
		return JSON.parse(this.fs.readFileSync(file, "utf-8")) as T;
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

	private loadV2(): void {
		const manifest = this.readJson<GateStoreV2Manifest>(path.join(this.v2Root, "manifest.json"));
		if (manifest.schemaVersion !== GATE_STORE_SCHEMA_VERSION || manifest.state !== "complete") throw new Error("invalid gate v2 manifest");
		this.metrics.migrationBytes = manifest.sourceBytes;
		this.metrics.migrationMs = manifest.migrationMs ?? 0;
		this.metrics.externalizedBytes = manifest.externalizedBytes;
		this.metrics.payloadBytes = manifest.payloadBytes;
		collectBypassAuditPayloadRefs(this.fs, this.v2Root, this.auditPayloadRefs);
		const goalsDir = path.join(this.v2Root, "goals");
		if (!this.fs.existsSync(goalsDir)) return;
		for (const file of this.fs.readdirSync(goalsDir) as string[]) {
			if (/^[a-f0-9]{64}\.gates\.json$/.test(file)) {
				try { this.fs.unlinkSync(path.join(goalsDir, file)); } catch { /* stale pre-publication file */ }
				continue;
			}
			if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
			const record = this.readJson<GateStoreV2GoalRecord>(path.join(goalsDir, file));
			let legacyByGate = new Map<string, GateSignal[]>();
			const legacyFile = legacyRecordPath(this.v2Root, record.goalId);
			if (this.fs.existsSync(legacyFile)) {
				const legacy = this.readJson<GateStoreV2LegacyRecord>(legacyFile);
				collectPayloadRefs(legacy, this.legacyPayloadRefs);
				if (!legacy.sealed || legacy.goalId !== record.goalId) throw new Error(`invalid sealed legacy gate archive for ${record.goalId}`);
				legacyByGate = new Map(legacy.gates.map(gate => [gate.gateId, gate.signals]));
			}
			this.goalPayloadRefs.set(record.goalId, collectPayloadRefs(record));
			for (const gate of record.gates) {
				const legacySignals = legacyByGate.get(gate.gateId) ?? [];
				const auditSignals = loadBypassAuditRecords(this.fs, this.v2Root, record.goalId, gate.gateId);
				collectPayloadRefs(auditSignals, this.auditPayloadRefs);
				const postV2Signals = [...(record.history?.[gate.gateId] ?? []), ...(gate.signals ?? []), ...auditSignals];
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
				this.loadCacheProjection(gate.signals);
				this.gates.set(compositeKey(gate.goalId, gate.gateId), gate);
			}
		}
		this.resumeReclaimCleanup();
	}

	private loadCacheProjection(signals: GateSignal[]): void {
		for (let index = signals.length - 1; index >= 0 && this.cacheProjectionBytes < GATE_STORE_CACHE_PROJECTION_BYTES; index--) {
			const signal = signals[index]!;
			if (signal.verification.status !== "passed") continue;
			for (const step of signal.verification.steps) {
				if (!step.passed || step.type === "human-signoff" || step.output || !step.outputRef) continue;
				if (step.outputRef.bytes > GATE_STORE_CACHE_PROJECTION_BYTES - this.cacheProjectionBytes) continue;
				const output = safeReadManagedGatePayload(step.outputRef);
				if (output === undefined) continue;
				this.cacheProjection.set(`${signal.id}:${step.name}`, output);
				this.cacheProjectionBytes += Buffer.byteLength(output);
			}
		}
	}

	private readProjection(gate: GateState): GateState {
		const needsProjection = gate.signals.some(signal => signal.verification.steps.some(step => this.cacheProjection.has(`${signal.id}:${step.name}`) && !step.output));
		if (!needsProjection) return gate;
		const projected = structuredClone(gate);
		for (const signal of projected.signals) {
			for (const step of signal.verification.steps) {
				const cached = this.cacheProjection.get(`${signal.id}:${step.name}`);
				if (!step.output && cached !== undefined) step.output = cached;
			}
		}
		return projected;
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

	private async goalSnapshot(goalId: string): Promise<GateStoreV2GoalRecord> {
		const snapshotCandidateRefs = new Set<string>();
		const history: Record<string, GateSignal[]> = {};
		const pendingCompactions: NonNullable<ReturnType<typeof this.pendingCompactions.get>> = [];
		const pendingCanonical: NonNullable<ReturnType<typeof this.pendingCanonicalSignals.get>> = [];
		const sourceGates = [...this.gates.values()].filter(gate => gate.goalId === goalId);
		const gates = await Promise.all(sourceGates.map(async gate => {
			const postV2 = gate.signals.filter(signal => !this.legacySignalIds.has(signal.id));
			const sourceById = new Map(postV2.map(signal => [signal.id, {
				verification: signal.verification,
				content: signal.content,
				requiresCanonicalization: (signal.metadata?.bypass === "true" && (!!signal.content || Object.values(signal.metadata).some(value => Buffer.byteLength(value) > 16 * 1024)))
					|| signal.verification.steps.some(step => !!step.output || !!step.artifact?.content || (step.diagnostics?.artifacts ?? []).some(artifact => !!artifact.content)),
			}]));
			const compacted = this.fs === realFs
				? await prepareGateSignalsInWorker(this.v2Root, postV2)
				: compactSignalsForPersistence(this.fs, this.v2Root, postV2);
			collectPayloadRefs(compacted.signals, snapshotCandidateRefs);
			this.metrics.externalizedBytes += compacted.externalizedBytes;
			this.metrics.payloadBytes += compacted.payloadBytesWritten;

			const bypass = compacted.signals.filter(signal => signal.metadata?.bypass === "true");
			for (const signal of bypass) {
				const audit = appendBypassAuditRecord(this.fs, this.v2Root, goalId, gate.gateId, signal);
				collectPayloadRefs(signal, this.auditPayloadRefs);
				if (audit.written) {
					this.metrics.bypassAuditBytes += audit.bytes;
					this.metrics.bypassAuditRecords++;
				}
			}
			const ordinaryAndRunning = compacted.signals.filter(signal => signal.metadata?.bypass !== "true");
			const compactStartedAt = performance.now();
			const retained = enforceOrdinaryRetention(ordinaryAndRunning, gate.verificationCacheInvalidatedAt);
			const compactMs = performance.now() - compactStartedAt;
			if (retained.stats.compacted) {
				recordEventLoopOperation("gate-store:compact", compactMs, { bytes: retained.stats.prunedBytes });
				getCpuDiagnostics().recordPersistence("gate-store:compact", compactMs, retained.stats.prunedBytes);
			}
			const key = compositeKey(goalId, gate.gateId);
			this.retention.set(key, { ...retained.stats, retainedBypassSignals: bypass.length });
			let earliestRetainedOrdinal = gate.earliestRetainedOrdinal;
			let prunedSignalRanges = gate.prunedSignalRanges;
			if (retained.stats.compacted) {
				const retainedIds = new Set(retained.signals.map(signal => signal.id));
				const removedSignals = ordinaryAndRunning.filter(signal => !retainedIds.has(signal.id));
				const removedOrdinals = removedSignals
					.map(signal => signal.persistenceOrdinal)
					.filter((ordinal): ordinal is number => ordinal !== undefined)
					.sort((a, b) => a - b);
				const countExceeded = ordinaryAndRunning.filter(signal => signal.verification.status !== "running").length > GATE_STORE_ORDINARY_SIGNAL_LIMIT;
				const bytesExceeded = Buffer.byteLength(JSON.stringify(ordinaryAndRunning)) > GATE_STORE_ORDINARY_BYTES_LIMIT;
				const reason = countExceeded && bytesExceeded ? "count-and-bytes" : countExceeded ? "count" : "bytes";
				const ranges = structuredClone(gate.prunedSignalRanges ?? []);
				for (const ordinal of removedOrdinals) {
					const prior = ranges[ranges.length - 1];
					if (prior && ordinal <= prior.to + 1 && prior.reason === reason) prior.to = Math.max(prior.to, ordinal);
					else ranges.push({ from: ordinal, to: ordinal, reason, compactedAt: Date.now() });
				}
				prunedSignalRanges = ranges.slice(-32);
				earliestRetainedOrdinal = retained.stats.earliestRetainedOrdinal;
				pendingCompactions.push({
					gateId: gate.gateId,
					removedIds: new Set(removedSignals.map(signal => signal.id)),
					earliestRetainedOrdinal,
					prunedSignalRanges,
					prunedSignals: retained.stats.prunedSignals,
					prunedBytes: retained.stats.prunedBytes,
				});
			}
			for (const compactSignal of [...retained.signals, ...bypass]) {
				const source = sourceById.get(compactSignal.id);
				if (source?.requiresCanonicalization) pendingCanonical.push({ gateId: gate.gateId, signalId: compactSignal.id, sourceVerification: source.verification, sourceContent: source.content, compacted: compactSignal });
			}
			const hotStart = Math.max(0, retained.signals.length - GATE_STORE_HOT_SIGNAL_LIMIT);
			history[gate.gateId] = retained.signals.slice(0, hotStart);
			return { ...gate, earliestRetainedOrdinal, prunedSignalRanges, signals: retained.signals.slice(hotStart) };
		}));
		const retention: GateStoreV2GoalRecord["retention"] = {};
		for (const gate of gates) {
			const stats = this.retention.get(compositeKey(goalId, gate.gateId));
			if (stats) retention[gate.gateId] = {
				earliestRetainedOrdinal: stats.earliestRetainedOrdinal,
				prunedSignals: stats.prunedSignals,
				prunedBytes: stats.prunedBytes,
				...(stats.compacted ? { lastCompactedAt: Date.now() } : {}),
			};
		}
		const record = { schemaVersion: GATE_STORE_SCHEMA_VERSION, goalId, gates, history, retention } satisfies GateStoreV2GoalRecord;
		const nextRefs = collectPayloadRefs(record);
		const priorRefs = this.goalPayloadRefs.get(goalId) ?? new Set<string>();
		for (const hash of [...priorRefs, ...snapshotCandidateRefs]) if (!nextRefs.has(hash) && !this.auditPayloadRefs.has(hash)) this.pendingReclaims.add(hash);
		this.pendingGoalPayloadRefs.set(goalId, nextRefs);
		this.pendingCompactions.set(goalId, pendingCompactions);
		this.pendingCanonicalSignals.set(goalId, pendingCanonical);
		return record;
	}

	private payloadIsReferenced(hash: string): boolean {
		if (this.legacyPayloadRefs.has(hash) || this.auditPayloadRefs.has(hash)) return true;
		for (const refs of this.goalPayloadRefs.values()) if (refs.has(hash)) return true;
		for (const refs of this.pendingGoalPayloadRefs.values()) if (refs.has(hash)) return true;
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
				const canonical = this.pendingCanonicalSignals.get(goalId) ?? [];
				this.pendingCanonicalSignals.delete(goalId);
				for (const publication of canonical) {
					const gate = this.gates.get(compositeKey(goalId, publication.gateId));
					const index = gate?.signals.findIndex(signal => signal.id === publication.signalId) ?? -1;
					if (!gate || index < 0) continue;
					const current = gate.signals[index]!;
					// Do not let an older in-flight publication erase a newer verification update.
					if (current.verification === publication.sourceVerification && current.content === publication.sourceContent) {
						gate.signals[index] = publication.compacted;
					}
				}
				const compactions = this.pendingCompactions.get(goalId) ?? [];
				this.pendingCompactions.delete(goalId);
				for (const compaction of compactions) {
					const gate = this.gates.get(compositeKey(goalId, compaction.gateId));
					if (gate) {
						gate.signals = gate.signals.filter(signal => !compaction.removedIds.has(signal.id));
						gate.earliestRetainedOrdinal = compaction.earliestRetainedOrdinal;
						gate.prunedSignalRanges = compaction.prunedSignalRanges;
					}
					this.metrics.compactions++;
					this.metrics.prunedSignals += compaction.prunedSignals;
					this.metrics.prunedBytes += compaction.prunedBytes;
				}
				const nextRefs = this.pendingGoalPayloadRefs.get(goalId);
				if (nextRefs) {
					this.goalPayloadRefs.set(goalId, nextRefs);
					this.pendingGoalPayloadRefs.delete(goalId);
				}
				this.metrics = {
					...this.metrics,
					...metrics,
					filesWritten: this.metrics.filesWritten + metrics.filesWritten,
					shardsWritten: this.metrics.shardsWritten + 1,
				};
				this.reclaimUnreferencedPayloads();
			},
			path.join(this.v2Root, "goals", `${stableGateStoreId(goalId)}.gates.json`),
		);
		this.writers.set(goalId, writer);
		return writer;
	}

	private save(goalId: string): void {
		this.writerFor(goalId).schedule();
	}

	/** Await all dirty goal-shard publications, primarily for orderly shutdown/tests. */
	async flush(): Promise<void> {
		await Promise.all([...this.writers.values()].map(writer => writer.flush()));
	}

	/** Detailed bounded-persistence, migration, and compaction metrics. */
	getPersistenceMetrics(): GateStorePersistenceMetrics {
		return structuredClone(this.metrics);
	}

	/** Bounded, body-free data source for maintenance_inspect(probe=gate_store). */
	getMaintenanceReport(): GateStoreMaintenanceReport {
		const manifest = this.readJson<GateStoreV2Manifest>(path.join(this.v2Root, "manifest.json"));
		const entries: GateStoreMaintenanceReport["largest"] = [];
		const totals = { goalBytes: 0, legacyBytes: 0, auditBytes: 0, payloadBytes: 0, goalShards: 0, legacyShards: 0, auditRecords: 0, payloads: 0 };
		const collectJsonDir = (directory: string, kind: "goal" | "legacy") => {
			if (!this.fs.existsSync(directory)) return;
			for (const name of this.fs.readdirSync(directory) as string[]) {
				if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
				const bytes = this.fs.statSync(path.join(directory, name)).size;
				if (kind === "goal") { totals.goalBytes += bytes; totals.goalShards++; }
				else { totals.legacyBytes += bytes; totals.legacyShards++; }
				entries.push({ name, kind, bytes, exceedsLimit: kind === "goal" && bytes > GATE_STORE_ORDINARY_BYTES_LIMIT });
			}
		};
		collectJsonDir(path.join(this.v2Root, "goals"), "goal");
		collectJsonDir(path.join(this.v2Root, "legacy"), "legacy");
		const audit = measureBypassAudit(this.fs, this.v2Root);
		totals.auditBytes = audit.bytes;
		totals.auditRecords = audit.files;
		this.metrics.bypassAuditBytes = audit.bytes;
		this.metrics.bypassAuditRecords = audit.files;
		for (const row of audit.largest) entries.push({ name: row.name, kind: "audit", bytes: row.bytes, exceedsLimit: row.bytes > 64 * 1024 });
		const payloads = path.join(this.v2Root, "payloads");
		if (this.fs.existsSync(payloads)) {
			for (const prefix of this.fs.readdirSync(payloads) as string[]) {
				const directory = path.join(payloads, prefix);
				for (const name of this.fs.readdirSync(directory) as string[]) {
					if (!/^[a-f0-9]{64}\.payload$/.test(name)) continue;
					const bytes = this.fs.statSync(path.join(directory, name)).size;
					totals.payloadBytes += bytes;
					totals.payloads++;
					entries.push({ name, kind: "payload", bytes, exceedsLimit: false });
				}
			}
		}
		entries.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
		return {
			schemaVersion: manifest.schemaVersion,
			migration: {
				state: manifest.state,
				sourceBytes: manifest.sourceBytes,
				gateCount: manifest.gateCount,
				signalCount: manifest.signalCount,
				externalizedBytes: manifest.externalizedBytes,
				payloadBytes: manifest.payloadBytes,
				migratedAt: manifest.migratedAt,
				validatedAt: manifest.validatedAt,
			},
			cutoffs: structuredClone(this.metrics.retention),
			totals,
			staleStaging: this.fs.existsSync(`${this.v2Root}.staging`),
			metrics: this.getPersistenceMetrics(),
			largest: entries.slice(0, 20),
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
		const now = Date.now();
		let changed = false;

		for (const [key, gate] of this.gates) {
			if (gate.goalId !== goalId) continue;

			if (!remainingGateIds.has(gate.gateId)) {
				this.gates.delete(key);
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

		if (changed) this.save(goalId);
	}

	getGate(goalId: string, gateId: string): GateState | undefined {
		const gate = this.gates.get(compositeKey(goalId, gateId));
		return gate ? this.readProjection(gate) : undefined;
	}

	getGatesForGoal(goalId: string): GateState[] {
		const result: GateState[] = [];
		for (const g of this.gates.values()) {
			if (g.goalId === goalId) result.push(this.readProjection(g));
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
		this.save(signal.goalId);
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
		this.save(goalId);
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
				this.save(gate.goalId);
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
		for (const key of keysToRemove) {
			this.gates.delete(key);
		}
		if (keysToRemove.length > 0) this.save(goalId);
	}
}
