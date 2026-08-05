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

function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve a managed payload only from its trusted owning store root. `ref.path`
 * is retained for schema compatibility, but is never a trust anchor: it must be
 * the exact canonical path derived from the owning root and content hash.
 */
export function validateManagedGatePayloadRef(v2Root: string, ref: ManagedGatePayloadRef): string | undefined {
	if (ref.kind !== "gate-payload-v2" || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) return undefined;
	const expectedRoot = path.resolve(v2Root);
	const expected = payloadPath(expectedRoot, ref.sha256);
	if (ref.path !== expected) return undefined;
	try {
		const realRoot = nodeFs.realpathSync(expectedRoot);
		const realPayloadRoot = nodeFs.realpathSync(path.join(expectedRoot, "payloads"));
		const candidate = nodeFs.realpathSync(expected);
		if (!isWithinRoot(realRoot, candidate) || !isWithinRoot(realPayloadRoot, candidate)) return undefined;
		const stat = nodeFs.statSync(candidate);
		if (!stat.isFile() || stat.size !== ref.bytes) return undefined;
		return candidate;
	} catch {
		return undefined;
	}
}

export interface ManagedPayloadSelection {
	mode?: "full" | "head" | "tail" | "slice" | "grep";
	lines?: number;
	from?: number;
	to?: number;
	pattern?: string;
	context?: number;
	maxResults?: number;
	maxBytes?: number;
}

export interface ManagedPayloadSelectionResult {
	text: string;
	totalBytes: number;
	totalLines: number;
	truncated: boolean;
	matchCount?: number;
	shownMatches?: number;
	range?: { from: number; to: number };
}

interface SelectedPayloadLine {
	number: number;
	text: string;
}

function truncateUtf8Prefix(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let used = 0;
	let output = "";
	for (const character of text) {
		const bytes = Buffer.byteLength(character);
		if (used + bytes > maxBytes) break;
		output += character;
		used += bytes;
	}
	return output;
}

function truncateUtf8Suffix(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let used = 0;
	let output = "";
	for (let index = text.length; index > 0;) {
		const end = index;
		index--;
		if (index > 0 && /[\uDC00-\uDFFF]/.test(text[index]!) && /[\uD800-\uDBFF]/.test(text[index - 1]!)) index--;
		const character = text.slice(index, end);
		const bytes = Buffer.byteLength(character);
		if (used + bytes > maxBytes) break;
		output = character + output;
		used += bytes;
	}
	return output;
}

/**
 * Select UTF-8 text from an already-authorized stream. Memory is bounded by
 * `maxBytes`, including for a payload containing one line with no newline.
 */
export async function selectGateTextStream(
	chunks: AsyncIterable<Buffer | string>,
	selection: ManagedPayloadSelection = {},
	onChunk?: (chunk: Buffer) => void,
): Promise<ManagedPayloadSelectionResult> {
	const maxBytes = Math.max(1, Math.min(selection.maxBytes ?? 50 * 1024, 1024 * 1024));
	const lineLimit = Math.max(1, Math.min(selection.lines ?? (selection.mode === "full" ? 2_000 : 200), 2_000));
	const mode = selection.mode ?? "tail";
	const from = Math.max(1, selection.from ?? 1);
	const to = Math.max(from, selection.to ?? from + lineLimit - 1);
	const context = Math.max(0, Math.min(selection.context ?? 0, 2_000));
	const maxResults = Math.max(1, Math.min(selection.maxResults ?? 50, 2_000));
	let matcher: RegExp | undefined;
	if (mode === "grep") matcher = new RegExp(selection.pattern ?? "");

	const decoder = new StringDecoder("utf8");
	let totalBytes = 0;
	let totalLines = 0;
	let selectedBytes = 0;
	let truncated = false;
	let currentLine = "";
	let currentLineTruncated = false;
	let grepWindow = "";
	let currentLineMatched = false;
	let matchCount = 0;
	let shownMatches = 0;
	let futureContext = 0;
	const selected: SelectedPayloadLine[] = [];
	const previous: SelectedPayloadLine[] = [];
	let previousBytes = 0;

	const renderedBytes = (line: SelectedPayloadLine): number => Buffer.byteLength(line.text) + (mode === "grep" || mode === "slice" ? Buffer.byteLength(`${line.number}: `) : 0);
	const retain = (line: SelectedPayloadLine): boolean => {
		if (selected.some(candidate => candidate.number === line.number)) return true;
		const bytes = renderedBytes(line) + (selected.length > 0 ? 1 : 0);
		if (selected.length >= 2_000 || selectedBytes + bytes > maxBytes) { truncated = true; return false; }
		selected.push(line);
		selectedBytes += bytes;
		return true;
	};
	const retainTail = (line: SelectedPayloadLine): void => {
		selected.push(line);
		selectedBytes += renderedBytes(line) + (selected.length > 1 ? 1 : 0);
		while (selected.length > lineLimit || selectedBytes > maxBytes) {
			const removed = selected.shift()!;
			selectedBytes -= renderedBytes(removed) + (selected.length > 0 ? 1 : 0);
			truncated = true;
		}
	};
	const rememberPrevious = (line: SelectedPayloadLine): void => {
		if (context === 0) return;
		previous.push(line);
		previousBytes += Buffer.byteLength(line.text) + (previous.length > 1 ? 1 : 0);
		while (previous.length > context || previousBytes > maxBytes) {
			const removed = previous.shift()!;
			previousBytes -= Buffer.byteLength(removed.text) + (previous.length > 0 ? 1 : 0);
		}
	};
	const consume = (): void => {
		totalLines++;
		const line = { number: totalLines, text: currentLine.replace(/\r$/, "") };
		const matched = mode === "grep" && (currentLineMatched || !!matcher?.test(line.text));
		if (matcher) matcher.lastIndex = 0;
		if (currentLineTruncated) truncated = true;
		if (mode === "full" || mode === "head") {
			if (selected.length < lineLimit) retain(line); else truncated = true;
		} else if (mode === "tail") {
			retainTail(line);
		} else if (mode === "slice") {
			if (totalLines >= from && totalLines <= to) retain(line);
		} else if (mode === "grep") {
			if (matched) {
				matchCount++;
				if (shownMatches < maxResults) {
					shownMatches++;
					for (const prior of previous) retain(prior);
					retain(line);
					futureContext = context;
				} else {
					truncated = true;
				}
			} else if (futureContext > 0) {
				retain(line);
				futureContext--;
			}
			rememberPrevious(line);
		}
		currentLine = "";
		currentLineTruncated = false;
		grepWindow = "";
		currentLineMatched = false;
	};
	const appendFragment = (fragment: string): void => {
		if (!fragment) return;
		if (matcher && !currentLineMatched) {
			const scan = grepWindow + fragment;
			matcher.lastIndex = 0;
			currentLineMatched = matcher.test(scan);
			matcher.lastIndex = 0;
			grepWindow = truncateUtf8Suffix(scan, maxBytes);
		}
		const combined = currentLine + fragment;
		if (Buffer.byteLength(combined) <= maxBytes) {
			currentLine = combined;
			return;
		}
		currentLineTruncated = true;
		currentLine = mode === "tail" || mode === "grep"
			? truncateUtf8Suffix(combined, maxBytes)
			: truncateUtf8Prefix(combined, maxBytes);
	};
	const processDecoded = (decoded: string): void => {
		let offset = 0;
		for (;;) {
			const newline = decoded.indexOf("\n", offset);
			if (newline < 0) { appendFragment(decoded.slice(offset)); break; }
			appendFragment(decoded.slice(offset, newline));
			consume();
			offset = newline + 1;
		}
	};

	for await (const chunk of chunks) {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		totalBytes += bytes.length;
		onChunk?.(bytes);
		processDecoded(decoder.write(bytes));
	}
	processDecoded(decoder.end());
	if (currentLine.length > 0 || currentLineTruncated || totalBytes === 0) consume();
	selected.sort((left, right) => left.number - right.number);
	const numbered = mode === "grep" || mode === "slice";
	const text = selected.map(line => numbered ? `${line.number}: ${line.text}` : line.text).join("\n");
	return {
		text,
		totalBytes,
		totalLines,
		truncated,
		...(mode === "grep" ? { matchCount, shownMatches } : {}),
		...(selected.length ? { range: { from: selected[0]!.number, to: selected[selected.length - 1]!.number } } : {}),
	};
}

/**
 * Root-bound, single-pass payload verification and selection. The stream is
 * always hashed to EOF, while selected text and partial lines stay bounded.
 */
export async function selectManagedGatePayload(
	v2Root: string,
	ref: ManagedGatePayloadRef,
	selection: ManagedPayloadSelection = {},
): Promise<ManagedPayloadSelectionResult | undefined> {
	const candidate = validateManagedGatePayloadRef(v2Root, ref);
	if (!candidate) return undefined;
	const hash = createHash("sha256");
	try {
		const selected = await selectGateTextStream(
			nodeFs.createReadStream(candidate, { highWaterMark: 64 * 1024 }),
			selection,
			chunk => hash.update(chunk),
		);
		if (selected.totalBytes !== ref.bytes || hash.digest("hex") !== ref.sha256) return undefined;
		return selected;
	} catch {
		return undefined;
	}
}

/**
 * Transitional fail-closed shim for synchronous call sites. It deliberately
 * performs no filesystem read; integrations must move to one of the explicit
 * asynchronous root-bound readers below.
 */
export function safeReadManagedGatePayload(_ref: ManagedGatePayloadRef): undefined;
export function safeReadManagedGatePayload(_v2Root: string, _ref: ManagedGatePayloadRef): undefined;
export function safeReadManagedGatePayload(
	_v2RootOrRef: string | ManagedGatePayloadRef,
	_ref?: ManagedGatePayloadRef,
): undefined {
	return undefined;
}

/** Read a complete managed body only when the caller supplies an explicit cap. */
export async function readManagedGatePayloadBounded(
	v2Root: string,
	ref: ManagedGatePayloadRef,
	maxBytes: number,
): Promise<string | undefined> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || ref.bytes > maxBytes) return undefined;
	const candidate = validateManagedGatePayloadRef(v2Root, ref);
	if (!candidate) return undefined;
	const hash = createHash("sha256");
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	try {
		for await (const chunk of nodeFs.createReadStream(candidate, { highWaterMark: 64 * 1024 })) {
			const bytes = chunk as Buffer;
			totalBytes += bytes.length;
			hash.update(bytes);
			if (totalBytes <= maxBytes) chunks.push(bytes);
		}
		if (totalBytes !== ref.bytes || totalBytes > maxBytes || hash.digest("hex") !== ref.sha256) return undefined;
		return Buffer.concat(chunks, totalBytes).toString("utf8");
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
