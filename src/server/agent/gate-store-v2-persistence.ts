import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

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
	/** Worker/synchronous migration wall time, retained for restart metrics. */
	migrationMs?: number;
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

/** One immutable post-v2 bypass row. Files are never amended after publication. */
export interface GateStoreV2BypassAuditRecord {
	schemaVersion: 2;
	goalId: string;
	gateId: string;
	ordinal: number;
	signal: GateSignal;
}

export const GATE_STORE_AUDIT_REASON_PREVIEW_BYTES = 16 * 1024;
export const GATE_STORE_CACHE_PROJECTION_BYTES = 1024 * 1024;

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

export function bypassAuditDirectory(root: string, goalId: string, gateId: string): string {
	return path.join(root, "audit", stableGateStoreId(goalId), stableGateStoreId(gateId));
}

export function bypassAuditRecordPath(root: string, goalId: string, gateId: string, ordinal: number, signalId: string): string {
	const stableOrdinal = String(Math.max(0, ordinal)).padStart(16, "0");
	return path.join(bypassAuditDirectory(root, goalId, gateId), `${stableOrdinal}-${stableGateStoreId(signalId)}.json`);
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

export function compactSignalForPersistence(fs: FsLike, storageRoot: string, publishedRoot: string, signal: GateSignal): { signal: GateSignal; externalizedBytes: number; payloadBytesWritten: number } {
	let externalizedBytes = 0;
	let payloadBytesWritten = 0;
	const clone = structuredClone(signal);
	if (clone.metadata?.bypass === "true" && clone.content) {
		const stored = writeManagedPayload(fs, storageRoot, publishedRoot, clone.content);
		clone.contentRef = stored.ref;
		payloadBytesWritten += stored.writtenBytes;
		externalizedBytes += Buffer.byteLength(clone.content);
		clone.content = "";
	}
	if (clone.metadata?.bypass === "true") {
		for (const [key, value] of Object.entries(clone.metadata)) {
			const valueBytes = Buffer.byteLength(value);
			if (valueBytes <= GATE_STORE_AUDIT_REASON_PREVIEW_BYTES) continue;
			const stored = writeManagedPayload(fs, storageRoot, publishedRoot, value);
			clone.auditMetadataRefs ??= {};
			clone.auditMetadataRefs[key] = stored.ref;
			if (key === "whyBypassed") clone.bypassReasonRef = stored.ref;
			payloadBytesWritten += stored.writtenBytes;
			externalizedBytes += valueBytes;
			clone.metadata[key] = Buffer.from(value).subarray(0, GATE_STORE_AUDIT_REASON_PREVIEW_BYTES).toString("utf8");
			clone.metadata[`${key}Truncated`] = "true";
		}
	}
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
		const result = compactSignalForPersistence(fs, storageRoot, publishedRoot, signal);
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

/**
 * Legacy compatibility hook. Canonical GateStore rows are deliberately never
 * passed here: payload bodies are resolved only by bounded read projections or
 * explicit inspection.
 */
export function hydrateHotSignalBodies(_signals: GateSignal[]): void {
	// Intentionally empty. Rehydrating hot rows recreated the original store-size
	// amplification in memory and made every later goal snapshot rehash the bodies.
}

function validateManagedPayloadLocation(v2Root: string, ref: ManagedGatePayloadRef): string | undefined {
	if (ref.kind !== "gate-payload-v2" || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) return undefined;
	const expectedRoot = path.resolve(v2Root);
	const expected = path.resolve(payloadPath(expectedRoot, ref.sha256));
	if (path.resolve(ref.path) !== expected) return undefined;
	try {
		const realRoot = nodeFs.realpathSync(expectedRoot);
		const realPayloadRoot = nodeFs.realpathSync(path.join(expectedRoot, "payloads"));
		const candidate = nodeFs.realpathSync(expected);
		const relativeToRoot = path.relative(realRoot, candidate);
		const relativeToPayloads = path.relative(realPayloadRoot, candidate);
		if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)
			|| relativeToPayloads.startsWith("..") || path.isAbsolute(relativeToPayloads)) return undefined;
		if (nodeFs.statSync(candidate).size !== ref.bytes) return undefined;
		return candidate;
	} catch {
		return undefined;
	}
}

export interface ManagedPayloadSelection {
	mode?: "head" | "tail" | "slice" | "grep";
	lines?: number;
	from?: number;
	to?: number;
	pattern?: string;
	maxResults?: number;
	maxBytes?: number;
}

export interface ManagedPayloadSelectionResult {
	text: string;
	totalBytes: number;
	totalLines: number;
	truncated: boolean;
}

/**
 * Root-bound, single-pass payload verification and selection. The stream is
 * always hashed to EOF, but only a bounded line window is retained in memory.
 */
export async function selectManagedGatePayload(
	v2Root: string,
	ref: ManagedGatePayloadRef,
	selection: ManagedPayloadSelection = {},
): Promise<ManagedPayloadSelectionResult | undefined> {
	const candidate = validateManagedPayloadLocation(v2Root, ref);
	if (!candidate) return undefined;
	const maxBytes = Math.max(1, Math.min(selection.maxBytes ?? 50 * 1024, 1024 * 1024));
	const lineLimit = Math.max(1, Math.min(selection.lines ?? 200, 2_000));
	const mode = selection.mode ?? "tail";
	let matcher: RegExp | undefined;
	try { if (mode === "grep") matcher = new RegExp(selection.pattern ?? ""); } catch { return undefined; }
	const from = Math.max(1, selection.from ?? 1);
	const to = Math.max(from, selection.to ?? from + lineLimit - 1);
	const maxResults = Math.max(1, Math.min(selection.maxResults ?? 50, 2_000));
	const hash = createHash("sha256");
	const decoder = new StringDecoder("utf8");
	let pending = "";
	let totalBytes = 0;
	let totalLines = 0;
	let selectedBytes = 0;
	let truncated = false;
	const selected: string[] = [];
	const retain = (line: string): void => {
		const bytes = Buffer.byteLength(line) + (selected.length > 0 ? 1 : 0);
		if (selectedBytes + bytes > maxBytes) { truncated = true; return; }
		selectedBytes += bytes;
		selected.push(line);
	};
	const consume = (line: string): void => {
		totalLines++;
		if (mode === "head") {
			if (selected.length < lineLimit) retain(line); else truncated = true;
		} else if (mode === "tail") {
			selected.push(line);
			selectedBytes += Buffer.byteLength(line) + (selected.length > 1 ? 1 : 0);
			while (selected.length > lineLimit || selectedBytes > maxBytes) {
				const removed = selected.shift()!;
				selectedBytes -= Buffer.byteLength(removed) + (selected.length > 0 ? 1 : 0);
				truncated = true;
			}
		} else if (mode === "slice") {
			if (totalLines >= from && totalLines <= to) retain(line);
			else if (totalLines > to) truncated = true;
		} else if (matcher?.test(line)) {
			matcher.lastIndex = 0;
			if (selected.length < maxResults) retain(line); else truncated = true;
		}
	};
	try {
		for await (const chunk of nodeFs.createReadStream(candidate, { highWaterMark: 64 * 1024 })) {
			const bytes = chunk as Buffer;
			totalBytes += bytes.length;
			hash.update(bytes);
			pending += decoder.write(bytes);
			let newline: number;
			while ((newline = pending.indexOf("\n")) >= 0) {
				const line = pending.slice(0, newline).replace(/\r$/, "");
				pending = pending.slice(newline + 1);
				consume(line);
			}
		}
		pending += decoder.end();
		if (pending.length > 0 || totalBytes === 0) consume(pending.replace(/\r$/, ""));
		if (totalBytes !== ref.bytes || hash.digest("hex") !== ref.sha256) return undefined;
		return { text: selected.join("\n"), totalBytes, totalLines, truncated };
	} catch {
		return undefined;
	}
}

/** Compatibility reader for existing callers; validates against the exact v2 root encoded by a canonical ref. */
export function safeReadManagedGatePayload(ref: ManagedGatePayloadRef): string | undefined {
	const normalized = path.resolve(ref.path);
	const payloadRoot = path.dirname(path.dirname(normalized));
	const v2Root = path.dirname(payloadRoot);
	const candidate = validateManagedPayloadLocation(v2Root, ref);
	if (!candidate) return undefined;
	try {
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
