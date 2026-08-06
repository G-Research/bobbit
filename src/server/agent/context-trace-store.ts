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

export const TRACE_OUTCOME_EVENTS = ["sessionSetup", "beforePrompt", "afterTurn", "beforeCompact", "sessionShutdown", "decisionResolved"] as const;
export type TraceOutcomeEvent = typeof TRACE_OUTCOME_EVENTS[number];

/** Persist only host-owned public labels, never extension-provided prose. */
export const TRACE_OUTCOME_REASONS = [
	"Grant required",
	"User pin",
	"Unavailable value",
	"Malformed result",
	"Timed out",
	"Budget enforcement",
	"Overlapping invocation",
	"Cancelled",
	"Disabled or revoked",
	"Budget exhausted",
	"Deadline elapsed",
	"Headless default",
	"Invalid answer",
	"Duplicate",
	"Capability revoked",
	"Proposal failed",
] as const;
export type TraceOutcomeReason = typeof TRACE_OUTCOME_REASONS[number];

export const TRACE_OUTCOME_ACTORS = ["extension", "user", "deadline", "headless"] as const;
export type TraceOutcomeActor = typeof TRACE_OUTCOME_ACTORS[number];

export interface TraceOutcomeRow {
	kind: TraceOutcomeKind;
	/** Server-derived winning pack identity for scheduled advisor activity. */
	packId?: string;
	hookId: string;
	event: TraceOutcomeEvent;
	outcome: TraceOutcome;
	reason?: TraceOutcomeReason;
	value?: string;
	ms?: number;
	requestId?: string;
	/** SHA-256 base32 or hexadecimal fingerprint, never question prose. */
	questionId?: string;
	/** Safe selected option id or the literal `other`, never Other text. */
	answer?: string;
	defaultApplied?: boolean;
	actor?: TraceOutcomeActor;
}

export interface TraceDecisionOutcomeRow extends TraceOutcomeRow {
	kind: "decision" | "advisory";
	packId: string;
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
const MAX_PROVIDERS_PER_ENTRY = 100;
const MAX_OUTCOMES_PER_ENTRY = 50;
const MAX_DISPLAY_NUMBER = 1_000_000_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TRACE_EVENTS = new Set<string>(TRACE_OUTCOME_EVENTS);
const OUTCOMES = new Set<string>(TRACE_OUTCOMES);
const OUTCOME_KINDS = new Set<string>(TRACE_OUTCOME_KINDS);
const OUTCOME_REASONS = new Set<string>(TRACE_OUTCOME_REASONS);
const OUTCOME_ACTORS = new Set<string>(TRACE_OUTCOME_ACTORS);
const VALUE_OUTCOMES = new Set<TraceOutcome>(["advised", "applied", "superseded"]);
const RESOLUTION_OUTCOMES = new Set<TraceOutcome>(["applied", "superseded"]);
const QUESTION_FINGERPRINT = /^(?:[a-f0-9]{64}|[a-z2-7]{52})$/;

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

	/** Append a delayed decision resolution as a redacted standalone event. */
	appendOutcome(sessionId: string, outcome: TraceDecisionOutcomeRow): void {
		this.appendTrace(sessionId, {
			ts: Date.now(), hook: "decisionResolved", sessionId, providers: [],
			outcomes: [{ ...outcome, event: "decisionResolved" }],
		});
	}

	readTrace(sessionId: string, limit?: number): TraceEntry[] {
		const file = this.traceFile(sessionId);
		if (!this.fs.existsSync(file)) return [];
		const entries: TraceEntry[] = [];
		for (const line of this.fs.readFileSync(file, "utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				entries.push(sanitizeTraceEntry(JSON.parse(line) as TraceEntry));
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

function sanitizeProviderError(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "timeout" || normalized === "timed out") return "Timed out";
	// Keep this exact producer label in sync with LifecycleHub diagnostics.
	if (normalized === "malformed block(s) dropped" || normalized === "malformed blocks omitted") return "Malformed blocks omitted";
	return "Provider error";
}

/** Bound and classify provider metadata before it becomes durable or REST-visible. */
function sanitizeProviders(value: unknown): TraceProviderRow[] {
	if (!Array.isArray(value)) return [];
	const rows: TraceProviderRow[] = [];
	for (const candidate of value.slice(0, MAX_PROVIDERS_PER_ENTRY)) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const row = candidate as Record<string, unknown>;
		rows.push({
			id: typeof row.id === "string" && SAFE_IDENTIFIER.test(row.id) ? row.id : "Unknown provider",
			ms: finiteDisplayNumber(row.ms) ?? 0,
			blocks: finiteDisplayNumber(row.blocks) ?? 0,
			omitted: finiteDisplayNumber(row.omitted) ?? 0,
			error: sanitizeProviderError(row.error),
		});
	}
	return rows;
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
		const kind = row.kind as TraceOutcomeKind;
		const event = row.event as TraceOutcomeEvent;
		const outcome = row.outcome as TraceOutcome;
		const reason = typeof row.reason === "string" && OUTCOME_REASONS.has(row.reason)
			? row.reason as TraceOutcomeReason
			: undefined;
		const value = VALUE_OUTCOMES.has(outcome) && typeof row.value === "string" && SAFE_IDENTIFIER.test(row.value)
			? row.value
			: undefined;
		const isDecisionActivity = kind === "decision" || kind === "advisory";
		const packId = isDecisionActivity && typeof row.packId === "string" && SAFE_IDENTIFIER.test(row.packId) ? row.packId : undefined;
		if (kind === "advisory" && event === "afterTurn" && !packId) continue;
		const requestId = isDecisionActivity && typeof row.requestId === "string" && SAFE_IDENTIFIER.test(row.requestId) ? row.requestId : undefined;
		const questionId = isDecisionActivity && typeof row.questionId === "string" && QUESTION_FINGERPRINT.test(row.questionId) ? row.questionId : undefined;
		const answer = isDecisionActivity && RESOLUTION_OUTCOMES.has(outcome) && typeof row.answer === "string" && SAFE_IDENTIFIER.test(row.answer) ? row.answer : undefined;
		const defaultApplied = isDecisionActivity && RESOLUTION_OUTCOMES.has(outcome) && typeof row.defaultApplied === "boolean" ? row.defaultApplied : undefined;
		const actor = isDecisionActivity && typeof row.actor === "string" && OUTCOME_ACTORS.has(row.actor) ? row.actor as TraceOutcomeActor : undefined;
		const ms = finiteDisplayNumber(row.ms);
		rows.push({
			kind, ...(packId ? { packId } : {}), hookId: row.hookId, event, outcome,
			...(reason ? { reason } : {}), ...(value ? { value } : {}), ...(ms === undefined ? {} : { ms }),
			...(requestId ? { requestId } : {}), ...(questionId ? { questionId } : {}), ...(answer ? { answer } : {}),
			...(defaultApplied === undefined ? {} : { defaultApplied }), ...(actor ? { actor } : {}),
		});
	}
	return rows;
}

/** Keep trace metadata and optional extension rows bounded and public before JSONL or REST. */
function sanitizeTraceEntry(entry: TraceEntry): TraceEntry {
	const { providers: rawProviders, outcomes: rawOutcomes, ...base } = entry;
	const providers = sanitizeProviders(rawProviders);
	const outcomes = sanitizeOutcomes(rawOutcomes);
	return { ...base, providers, ...(outcomes.length > 0 ? { outcomes } : {}) };
}

function safeBasename(sessionId: string): string {
	const stripped = sessionId.replace(/\.\./g, "_").replace(/[\\/]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
	return stripped || "session";
}
