import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import path from "node:path";

import type { FsLike } from "../gateway-deps.js";
import type { GateSignal, GateState, ManagedGatePayloadRef } from "./gate-store.js";
import { getCpuDiagnostics, recordEventLoopOperation } from "./cpu-diagnostics.js";

export const GATE_STORE_SCHEMA_VERSION = 2;
export const GATE_STORE_HOT_SIGNAL_LIMIT = 32;
export const GATE_STORE_ORDINARY_SIGNAL_LIMIT = 256;
export const GATE_STORE_ORDINARY_BYTES_LIMIT = 8 * 1024 * 1024;

export interface GateStoreV2Manifest {
	schemaVersion: 2;
	state: "complete";
	sourceFile: string;
	sourceBytes: number;
	sourceSha256: string;
	gateCount: number;
	signalCount: number;
	bypassCount: number;
	externalizedBytes: number;
	payloadBytes: number;
	migratedAt: number;
	validatedAt: number;
}

export interface GateStoreV2GoalRecord {
	schemaVersion: 2;
	goalId: string;
	/** Current truth plus at most the newest detailed hot rows per gate. */
	gates: GateState[];
	/** Older bounded post-v2 summaries, kept separate from hot rows. */
	history: Record<string, GateSignal[]>;
	retention: Record<string, {
		earliestRetainedOrdinal: number;
		prunedSignals: number;
		prunedBytes: number;
		lastCompactedAt?: number;
	}>;
}

export interface GateStoreV2LegacyRecord {
	schemaVersion: 2;
	sealed: true;
	goalId: string;
	gates: Array<{ gateId: string; signals: GateSignal[] }>;
}

export interface CompactionStats {
	prunedSignals: number;
	prunedBytes: number;
	retainedOrdinarySignals: number;
	retainedBypassSignals: number;
	earliestRetainedOrdinal: number;
	compacted: boolean;
}

export function gateStoreV2Root(stateDir: string): string {
	return path.join(stateDir, "gate-records", "v2");
}

export function stableGateStoreId(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function goalRecordPath(root: string, goalId: string): string {
	return path.join(root, "goals", `${stableGateStoreId(goalId)}.json`);
}

export function legacyRecordPath(root: string, goalId: string): string {
	return path.join(root, "legacy", `${stableGateStoreId(goalId)}.json`);
}

export function payloadPath(root: string, sha256: string): string {
	return path.join(root, "payloads", sha256.slice(0, 2), `${sha256}.payload`);
}

function writeManagedPayload(fs: FsLike, storageRoot: string, publishedRoot: string, content: string): { ref: ManagedGatePayloadRef; writtenBytes: number } {
	const startedAt = performance.now();
	const bytes = Buffer.byteLength(content);
	const sha256 = createHash("sha256").update(content).digest("hex");
	const storagePath = payloadPath(storageRoot, sha256);
	let writtenBytes = 0;
	if (!fs.existsSync(storagePath)) {
		fs.mkdirSync(path.dirname(storagePath), { recursive: true });
		const tmp = `${storagePath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, content, "utf8");
		try {
			fs.renameSync(tmp, storagePath);
			writtenBytes = bytes;
		} catch (error) {
			if (!fs.existsSync(storagePath)) throw error;
			try { fs.unlinkSync(tmp); } catch { /* another writer won */ }
		}
	}
	const durationMs = performance.now() - startedAt;
	if (writtenBytes > 0) {
		recordEventLoopOperation("gate-store:payload-write", durationMs, { bytes: writtenBytes });
		getCpuDiagnostics().recordPersistence("gate-store:payload-write", durationMs, writtenBytes);
	}
	return { ref: { kind: "gate-payload-v2", sha256, bytes, path: payloadPath(publishedRoot, sha256) }, writtenBytes };
}

function compactSignal(fs: FsLike, storageRoot: string, publishedRoot: string, signal: GateSignal): { signal: GateSignal; externalizedBytes: number; payloadBytesWritten: number } {
	let externalizedBytes = 0;
	let payloadBytesWritten = 0;
	const clone = structuredClone(signal);
	for (const step of clone.verification.steps) {
		if (step.output) {
			const retainedOutputExists = !!step.diagnostics
				&& [step.diagnostics.stdout?.path, step.diagnostics.stderr?.path].some(file => !!file && fs.existsSync(file));
			if (!retainedOutputExists) {
				const stored = writeManagedPayload(fs, storageRoot, publishedRoot, step.output);
				step.outputRef = stored.ref;
				payloadBytesWritten += stored.writtenBytes;
			}
			externalizedBytes += Buffer.byteLength(step.output);
			step.output = "";
		}
		if (step.artifact?.content) {
			const stored = writeManagedPayload(fs, storageRoot, publishedRoot, step.artifact.content);
			step.artifact.contentRef = stored.ref;
			payloadBytesWritten += stored.writtenBytes;
			externalizedBytes += Buffer.byteLength(step.artifact.content);
			step.artifact.content = "";
		}
		for (const artifact of step.diagnostics?.artifacts ?? []) {
			if (!artifact.content) continue;
			if (!fs.existsSync(artifact.path)) {
				const stored = writeManagedPayload(fs, storageRoot, publishedRoot, artifact.content);
				artifact.contentRef = stored.ref;
				payloadBytesWritten += stored.writtenBytes;
			}
			externalizedBytes += Buffer.byteLength(artifact.content);
			delete artifact.content;
		}
	}
	return { signal: clone, externalizedBytes, payloadBytesWritten };
}

export function compactSignalsForPersistence(fs: FsLike, storageRoot: string, signals: GateSignal[], publishedRoot = storageRoot): {
	signals: GateSignal[];
	externalizedBytes: number;
	payloadBytesWritten: number;
} {
	let externalizedBytes = 0;
	let payloadBytesWritten = 0;
	const compacted = signals.map(signal => {
		const result = compactSignal(fs, storageRoot, publishedRoot, signal);
		externalizedBytes += result.externalizedBytes;
		payloadBytesWritten += result.payloadBytesWritten;
		return result.signal;
	});
	return { signals: compacted, externalizedBytes, payloadBytesWritten };
}

function compactSignalBytes(signal: GateSignal): number {
	return Buffer.byteLength(JSON.stringify(signal));
}

/** Bypass rows are immutable audit records and are never counted against ordinary retention. */
export function enforceOrdinaryRetention(signals: GateSignal[], verificationCacheInvalidatedAt?: number): { signals: GateSignal[]; stats: CompactionStats } {
	const bypass = signals.filter(signal => signal.metadata?.bypass === "true");
	const running = signals.filter(signal => signal.metadata?.bypass !== "true" && signal.verification.status === "running");
	const ordinary = signals.filter(signal => signal.metadata?.bypass !== "true" && signal.verification.status !== "running");
	let start = Math.max(0, ordinary.length - GATE_STORE_ORDINARY_SIGNAL_LIMIT);
	let bytes = 0;
	for (let index = ordinary.length - 1; index >= start; index--) {
		const nextBytes = compactSignalBytes(ordinary[index]!);
		if (bytes + nextBytes > GATE_STORE_ORDINARY_BYTES_LIMIT) {
			start = index + 1;
			break;
		}
		bytes += nextBytes;
	}
	let retainedOrdinary = ordinary.slice(start);
	// Materialize a small cache-safe projection in the retained set. A cache row
	// may displace an older ordinary summary but never expands the history caps.
	const protectedCacheIds = new Set<string>();
	const seenCommits = new Set<string>();
	for (let index = ordinary.length - 1; index >= 0 && protectedCacheIds.size < GATE_STORE_HOT_SIGNAL_LIMIT; index--) {
		const signal = ordinary[index]!;
		if (signal.verification.status !== "passed"
			|| signal.timestamp <= (verificationCacheInvalidatedAt ?? Number.NEGATIVE_INFINITY)
			|| signal.verification.steps.some(step => step.type === "human-signoff")
			|| seenCommits.has(signal.commitSha)) continue;
		seenCommits.add(signal.commitSha);
		protectedCacheIds.add(signal.id);
	}
	const retainedOrdinaryIds = new Set(retainedOrdinary.map(signal => signal.id));
	for (const signal of ordinary) if (protectedCacheIds.has(signal.id)) retainedOrdinaryIds.add(signal.id);
	retainedOrdinary = ordinary.filter(signal => retainedOrdinaryIds.has(signal.id));
	let retainedOrdinaryBytes = retainedOrdinary.reduce((sum, signal) => sum + compactSignalBytes(signal), 0);
	while (retainedOrdinary.length > GATE_STORE_ORDINARY_SIGNAL_LIMIT
		|| retainedOrdinaryBytes > GATE_STORE_ORDINARY_BYTES_LIMIT) {
		// Prefer displacing ordinary summaries, but the retention ceilings are
		// absolute: if cache projections alone exceed them, evict the oldest
		// projection. Its commit then safely misses the cache and is reverified.
		const unprotected = retainedOrdinary.findIndex(signal => !protectedCacheIds.has(signal.id));
		const removable = unprotected >= 0 ? unprotected : 0;
		const [removed] = retainedOrdinary.splice(removable, 1);
		retainedOrdinaryBytes -= compactSignalBytes(removed!);
	}
	const retainedIds = new Set([...retainedOrdinary, ...running, ...bypass].map(signal => signal.id));
	const retained = signals.filter(signal => retainedIds.has(signal.id));
	const removed = ordinary.filter(signal => !retainedIds.has(signal.id));
	return {
		signals: retained,
		stats: {
			prunedSignals: removed.length,
			prunedBytes: removed.reduce((sum, signal) => sum + compactSignalBytes(signal), 0),
			retainedOrdinarySignals: retainedOrdinary.length,
			retainedBypassSignals: bypass.length,
			earliestRetainedOrdinal: retained.length
				? Math.min(...retained.map(signal => signal.persistenceOrdinal ?? signals.indexOf(signal)))
				: (signals[signals.length - 1]?.persistenceOrdinal ?? signals.length - 1) + 1,
			compacted: removed.length > 0,
		},
	};
}

export function hydrateHotSignalBodies(signals: GateSignal[]): void {
	const cache = new Map<string, string | undefined>();
	const read = (ref: ManagedGatePayloadRef): string | undefined => {
		if (!cache.has(ref.sha256)) cache.set(ref.sha256, safeReadManagedGatePayload(ref));
		return cache.get(ref.sha256);
	};
	for (const signal of signals.slice(-GATE_STORE_HOT_SIGNAL_LIMIT)) {
		for (const step of signal.verification.steps) {
			if (!step.output && step.outputRef) step.output = read(step.outputRef) ?? "";
			if (step.artifact && !step.artifact.content && step.artifact.contentRef) {
				step.artifact.content = read(step.artifact.contentRef) ?? "";
			}
		}
	}
}

export function safeReadManagedGatePayload(ref: ManagedGatePayloadRef): string | undefined {
	if (ref.kind !== "gate-payload-v2" || !/^[a-f0-9]{64}$/.test(ref.sha256)) return undefined;
	const normalized = path.resolve(ref.path);
	const expectedName = `${ref.sha256}.payload`;
	if (path.basename(normalized) !== expectedName || path.basename(path.dirname(normalized)) !== ref.sha256.slice(0, 2)) return undefined;
	const parts = normalized.split(path.sep);
	const payloadIndex = parts.lastIndexOf("payloads");
	if (payloadIndex < 2 || parts[payloadIndex - 1] !== "v2" || parts[payloadIndex - 2] !== "gate-records") return undefined;
	try {
		const payloadRootPath = path.dirname(path.dirname(normalized));
		const payloadRoot = nodeFs.realpathSync(payloadRootPath);
		const candidate = nodeFs.realpathSync(normalized);
		const relative = path.relative(payloadRoot, candidate);
		if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
		const content = nodeFs.readFileSync(candidate, "utf8");
		if (Buffer.byteLength(content) !== ref.bytes) return undefined;
		if (createHash("sha256").update(content).digest("hex") !== ref.sha256) return undefined;
		return content;
	} catch {
		return undefined;
	}
}

export function collectPayloadRefs(value: unknown, refs = new Set<string>()): Set<string> {
	if (!value || typeof value !== "object") return refs;
	if (Array.isArray(value)) {
		for (const child of value) collectPayloadRefs(child, refs);
		return refs;
	}
	const record = value as Record<string, unknown>;
	if (record.kind === "gate-payload-v2" && typeof record.sha256 === "string") refs.add(record.sha256);
	for (const child of Object.values(record)) collectPayloadRefs(child, refs);
	return refs;
}
