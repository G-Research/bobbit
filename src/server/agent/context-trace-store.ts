import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import path from "node:path";

export interface TraceProviderRow {
	id: string;
	ms: number;
	blocks: number;
	omitted: number;
	error?: string;
}

/** Core-owned terminal states for optional extension activity on a lifecycle event. */
export const TRACE_OUTCOMES = ["advised", "applied", "denied", "dropped", "error", "superseded"] as const;
export type TraceOutcome = typeof TRACE_OUTCOMES[number];

export const TRACE_OUTCOME_KINDS = ["decision", "advisory", "audit"] as const;
export type TraceOutcomeKind = typeof TRACE_OUTCOME_KINDS[number];

export const TRACE_OUTCOME_EVENTS = ["sessionSetup", "beforePrompt", "afterTurn", "beforeCompact", "sessionShutdown"] as const;
export type TraceOutcomeEvent = typeof TRACE_OUTCOME_EVENTS[number];

/** Persist only host-owned public labels, never extension-provided prose. */
export const TRACE_OUTCOME_REASONS = ["Grant required", "User pin", "Unavailable value", "Malformed result", "Timed out"] as const;
export type TraceOutcomeReason = typeof TRACE_OUTCOME_REASONS[number];

export interface TraceOutcomeRow {
	kind: TraceOutcomeKind;
	hookId: string;
	event: TraceOutcomeEvent;
	outcome: TraceOutcome;
	reason?: TraceOutcomeReason;
	value?: string;
	ms?: number;
}

export interface TraceEntry {
	ts: number;
	hook: string;
	sessionId: string;
	providers: TraceProviderRow[];
	/** Nested so lifecycle-event pagination can never split its extension activity. */
	outcomes?: TraceOutcomeRow[];
}

const MAX_TRACE_BYTES = 2 * 1024 * 1024;
const MAX_OUTCOMES_PER_ENTRY = 50;
const MAX_DISPLAY_NUMBER = 1_000_000_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TRACE_EVENTS = new Set<string>(TRACE_OUTCOME_EVENTS);
const OUTCOMES = new Set<string>(TRACE_OUTCOMES);
const OUTCOME_KINDS = new Set<string>(TRACE_OUTCOME_KINDS);
const OUTCOME_REASONS = new Set<string>(TRACE_OUTCOME_REASONS);
const VALUE_OUTCOMES = new Set<TraceOutcome>(["advised", "applied", "superseded"]);

/** Invoked only after a trace append (including cap rotation) has completed. */
export type TraceAppendObserver = (sessionId: string, entry: TraceEntry) => void;

export class ContextTraceStore {
	private readonly traceDir: string;
	private readonly fs: FsLike;
	private readonly onAppend?: TraceAppendObserver;

	constructor(stateDir: string, fsImpl: FsLike = realFs, onAppend?: TraceAppendObserver) {
		this.fs = fsImpl;
		this.traceDir = path.join(stateDir, "session-context-trace");
		this.onAppend = onAppend;
	}

	appendTrace(sessionId: string, entry: TraceEntry): void {
		const persisted = sanitizeTraceEntry(entry);
		this.fs.mkdirSync(this.traceDir, { recursive: true });
		const file = this.traceFile(sessionId);
		this.fs.appendFileSync(file, JSON.stringify(persisted) + "\n");
		this.enforceCap(file);
		try {
			this.onAppend?.(sessionId, persisted);
		} catch {
			// Observers are invalidation-only and must never affect durable traces.
		}
	}

	readTrace(sessionId: string, limit?: number): TraceEntry[] {
		const file = this.traceFile(sessionId);
		if (!this.fs.existsSync(file)) return [];
		const entries: TraceEntry[] = [];
		for (const line of this.fs.readFileSync(file, "utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = sanitizeTraceEntry(JSON.parse(line) as TraceEntry);
				// JSON omits an optional `error: undefined`; restore the in-memory
				// TraceProviderRow shape without changing the serialized API payload.
				if (Array.isArray(entry.providers)) {
					for (const provider of entry.providers) {
						if (provider && typeof provider === "object" && !Object.hasOwn(provider, "error")) provider.error = undefined;
					}
				}
				entries.push(entry);
			} catch {
				// Skip corrupt partial lines rather than failing trace reads.
			}
		}
		return typeof limit === "number" ? entries.slice(-Math.max(0, limit)) : entries;
	}

	private traceFile(sessionId: string): string {
		return path.join(this.traceDir, safeBasename(sessionId) + ".jsonl");
	}

	private enforceCap(file: string): void {
		let stat: ReturnType<FsLike["statSync"]>;
		try {
			stat = this.fs.statSync(file);
		} catch {
			return;
		}
		if (stat.size <= MAX_TRACE_BYTES) return;

		const lines = this.fs.readFileSync(file, "utf-8").split("\n").filter((line) => line.length > 0);
		const kept: string[] = [];
		let bytes = 0;
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i] + "\n";
			const lineBytes = Buffer.byteLength(line);
			if (bytes + lineBytes > MAX_TRACE_BYTES) break;
			kept.push(line);
			bytes += lineBytes;
		}
		kept.reverse();

		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		this.fs.writeFileSync(tmp, kept.join(""));
		this.fs.renameSync(tmp, file);
	}
}

function finiteDisplayNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.min(MAX_DISPLAY_NUMBER, Math.trunc(value));
}

function sanitizeOutcomes(value: unknown): TraceOutcomeRow[] {
	if (!Array.isArray(value)) return [];
	const rows: TraceOutcomeRow[] = [];
	for (const candidate of value.slice(0, MAX_OUTCOMES_PER_ENTRY)) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const row = candidate as Record<string, unknown>;
		if (typeof row.kind !== "string" || !OUTCOME_KINDS.has(row.kind)) continue;
		if (typeof row.hookId !== "string" || !SAFE_IDENTIFIER.test(row.hookId)) continue;
		if (typeof row.event !== "string" || !TRACE_EVENTS.has(row.event)) continue;
		if (typeof row.outcome !== "string" || !OUTCOMES.has(row.outcome)) continue;
		const outcome = row.outcome as TraceOutcome;
		const reason = typeof row.reason === "string" && OUTCOME_REASONS.has(row.reason)
			? row.reason as TraceOutcomeReason
			: undefined;
		const value = VALUE_OUTCOMES.has(outcome) && typeof row.value === "string" && SAFE_IDENTIFIER.test(row.value)
			? row.value
			: undefined;
		const ms = finiteDisplayNumber(row.ms);
		rows.push({
			kind: row.kind as TraceOutcomeKind,
			hookId: row.hookId,
			event: row.event as TraceOutcomeEvent,
			outcome,
			...(reason ? { reason } : {}),
			...(value ? { value } : {}),
			...(ms === undefined ? {} : { ms }),
		});
	}
	return rows;
}

/** Keep optional extension rows bounded and public before they reach JSONL or REST. */
function sanitizeTraceEntry(entry: TraceEntry): TraceEntry {
	const { outcomes: rawOutcomes, ...base } = entry;
	const outcomes = sanitizeOutcomes(rawOutcomes);
	return { ...base, ...(outcomes.length > 0 ? { outcomes } : {}) };
}

function safeBasename(sessionId: string): string {
	const stripped = sessionId.replace(/\.\./g, "_").replace(/[\\/]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
	return stripped || "session";
}
