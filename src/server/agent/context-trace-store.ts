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

export const TRACE_OUTCOME_EVENTS = ["sessionSetup", "beforePrompt", "beforeToolCall", "afterToolResult", "afterTurn", "beforeCompact", "sessionShutdown", "projectImported", "decisionResolved"] as const;
export type TraceOutcomeEvent = typeof TRACE_OUTCOME_EVENTS[number];

/** Fixed startup capability-selection stages. Candidate names never enter the trace. */
export const TRACE_CAPABILITY_SELECTOR_STAGES = ["skills", "mcp"] as const;
export type TraceCapabilitySelectorStage = typeof TRACE_CAPABILITY_SELECTOR_STAGES[number];

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
	"Lower-priority selection",
	"Prompt mutation disabled",
	"Lower-priority proposal",
	"Tool warning",
	"Tool denied",
	"Prompt shaped",
	"Tool result passed",
	"Tool result replaced",
	"Tool result redacted",
	"Tool result withheld",
	"Filter unavailable",
	"Filter disabled or revoked",
	"Filter grant required",
	"Filter malformed",
	"Filter timed out",
	"Filter aborted",
	"Filter admission rejected",
	"Lower-priority filter",
	"Unavailable",
] as const;
export type TraceOutcomeReason = typeof TRACE_OUTCOME_REASONS[number];

/** Fixed selection categories; selection payloads and labels never enter the trace. */
export const TRACE_SELECTION_KINDS = ["model", "thinking", "role", "workflow"] as const;
export type TraceSelectionKind = typeof TRACE_SELECTION_KINDS[number];

export const TRACE_OUTCOME_ACTORS = ["extension", "user", "deadline", "headless"] as const;
export type TraceOutcomeActor = typeof TRACE_OUTCOME_ACTORS[number];

/** Fixed, core-owned consent metadata. Never persist operation or request payloads. */
export const TRACE_DECISION_CLASSES = ["deferrable", "consent-required"] as const;
export type TraceDecisionClass = typeof TRACE_DECISION_CLASSES[number];
export const TRACE_DECISION_STATUSES = ["resolved", "defaulted", "denied", "paused-awaiting-consent"] as const;
export type TraceDecisionStatus = typeof TRACE_DECISION_STATUSES[number];
export const TRACE_DECISION_CLASSIFICATION_REASONS = ["requested", "core-hard-cap", "core-unsafe-tool", "core-capability-change", "core-grant-change", "core-configuration-change"] as const;
export type TraceDecisionClassificationReason = typeof TRACE_DECISION_CLASSIFICATION_REASONS[number];
export const TRACE_CONSENT_TIMEOUT_ACTIONS = ["deny-operation", "pause-goal"] as const;
export type TraceConsentTimeoutAction = typeof TRACE_CONSENT_TIMEOUT_ACTIONS[number];
export const TRACE_CONSENT_RESUME_STATUSES = ["claimed", "resumed", "already-resumed", "not-matching", "denied"] as const;
export type TraceConsentResumeStatus = typeof TRACE_CONSENT_RESUME_STATUSES[number];

export interface TraceOutcomeRow {
	kind: TraceOutcomeKind;
	/** Server-derived extension pack identity; audit rows may retain it too. */
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
	/** Decision-class and consent settlement metadata; all values are fixed enums. */
	decisionClass?: TraceDecisionClass;
	decisionStatus?: TraceDecisionStatus;
	classificationReason?: TraceDecisionClassificationReason;
	timeoutAction?: TraceConsentTimeoutAction;
	resumeStatus?: TraceConsentResumeStatus;
	/** Fixed selection category; retained without a value for denied/dropped outcomes. */
	selectionKind?: TraceSelectionKind;
	/** Model is a verified provider/modelId tuple; all other kinds use a safe identifier. */
	selectionValue?: string;
	/** Dynamic capability selector stage; only valid on a session-setup decision row. */
	capabilityStage?: TraceCapabilitySelectorStage;
	/** Opaque SHA-256 snapshot fingerprint; never a query, proposal, or candidate id. */
	selectionFingerprint?: string;
	/** Safe aggregate startup-selection metrics; individual capability ids are never retained. */
	candidateCount?: number;
	selectedCount?: number;
	selectorCount?: number;
	contextBytesSaved?: number;
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
const DECISION_CLASSES = new Set<string>(TRACE_DECISION_CLASSES);
const DECISION_STATUSES = new Set<string>(TRACE_DECISION_STATUSES);
const DECISION_CLASSIFICATION_REASONS = new Set<string>(TRACE_DECISION_CLASSIFICATION_REASONS);
const CONSENT_TIMEOUT_ACTIONS = new Set<string>(TRACE_CONSENT_TIMEOUT_ACTIONS);
const CONSENT_RESUME_STATUSES = new Set<string>(TRACE_CONSENT_RESUME_STATUSES);
const SELECTION_KINDS = new Set<string>(TRACE_SELECTION_KINDS);
const CAPABILITY_SELECTOR_STAGES = new Set<string>(TRACE_CAPABILITY_SELECTOR_STAGES);
const VALUE_OUTCOMES = new Set<TraceOutcome>(["advised", "applied", "superseded"]);
/** Never persist a losing, rejected, or failed proposal value. */
const SELECTION_VALUE_OUTCOMES = new Set<TraceOutcome>(["advised", "applied"]);
const RESOLUTION_OUTCOMES = new Set<TraceOutcome>(["applied", "superseded"]);
const QUESTION_FINGERPRINT = /^(?:[a-f0-9]{64}|[a-z2-7]{52})$/;
const SAFE_MODEL_SELECTION_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

function safeSelectionValue(kind: TraceSelectionKind | undefined, value: unknown): string | undefined {
	if (typeof value !== "string" || !kind) return undefined;
	return kind === "model"
		? (SAFE_MODEL_SELECTION_VALUE.test(value) ? value : undefined)
		: (SAFE_IDENTIFIER.test(value) ? value : undefined);
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
		// Filter audit rows need the same server-derived pack attribution as
		// decision/advisory rows, while retaining the existing closed identifier gate.
		const packId = (isDecisionActivity || kind === "audit") && typeof row.packId === "string" && SAFE_IDENTIFIER.test(row.packId) ? row.packId : undefined;
		if (kind === "advisory" && event === "afterTurn" && !packId) continue;
		const requestId = isDecisionActivity && typeof row.requestId === "string" && SAFE_IDENTIFIER.test(row.requestId) ? row.requestId : undefined;
		const questionId = isDecisionActivity && typeof row.questionId === "string" && QUESTION_FINGERPRINT.test(row.questionId) ? row.questionId : undefined;
		const answer = isDecisionActivity && RESOLUTION_OUTCOMES.has(outcome) && typeof row.answer === "string" && SAFE_IDENTIFIER.test(row.answer) ? row.answer : undefined;
		const defaultApplied = isDecisionActivity && RESOLUTION_OUTCOMES.has(outcome) && typeof row.defaultApplied === "boolean" ? row.defaultApplied : undefined;
		const actor = isDecisionActivity && typeof row.actor === "string" && OUTCOME_ACTORS.has(row.actor) ? row.actor as TraceOutcomeActor : undefined;
		const decisionClass = isDecisionActivity && typeof row.decisionClass === "string" && DECISION_CLASSES.has(row.decisionClass)
			? row.decisionClass as TraceDecisionClass : undefined;
		const decisionStatus = isDecisionActivity && typeof row.decisionStatus === "string" && DECISION_STATUSES.has(row.decisionStatus)
			? row.decisionStatus as TraceDecisionStatus : undefined;
		const classificationReason = isDecisionActivity && typeof row.classificationReason === "string" && DECISION_CLASSIFICATION_REASONS.has(row.classificationReason)
			? row.classificationReason as TraceDecisionClassificationReason : undefined;
		const timeoutAction = isDecisionActivity && typeof row.timeoutAction === "string" && CONSENT_TIMEOUT_ACTIONS.has(row.timeoutAction)
			? row.timeoutAction as TraceConsentTimeoutAction : undefined;
		const resumeStatus = isDecisionActivity && typeof row.resumeStatus === "string" && CONSENT_RESUME_STATUSES.has(row.resumeStatus)
			? row.resumeStatus as TraceConsentResumeStatus : undefined;
		const selectionKind = isDecisionActivity && typeof row.selectionKind === "string" && SELECTION_KINDS.has(row.selectionKind)
			? row.selectionKind as TraceSelectionKind : undefined;
		const selectionValue = SELECTION_VALUE_OUTCOMES.has(outcome)
			? safeSelectionValue(selectionKind, row.selectionValue)
			: undefined;
		// Capability selection metrics are valid only for the startup decision path.
		// Do not retain raw selector output, candidate ids, query prose, or reasons.
		const capabilityStage = kind === "decision" && event === "sessionSetup"
			&& typeof row.capabilityStage === "string" && CAPABILITY_SELECTOR_STAGES.has(row.capabilityStage)
			? row.capabilityStage as TraceCapabilitySelectorStage
			: undefined;
		const selectionFingerprint = capabilityStage && typeof row.selectionFingerprint === "string" && QUESTION_FINGERPRINT.test(row.selectionFingerprint)
			? row.selectionFingerprint
			: undefined;
		const candidateCount = capabilityStage ? finiteDisplayNumber(row.candidateCount) : undefined;
		const selectedCount = capabilityStage ? finiteDisplayNumber(row.selectedCount) : undefined;
		const selectorCount = capabilityStage ? finiteDisplayNumber(row.selectorCount) : undefined;
		const contextBytesSaved = capabilityStage ? finiteDisplayNumber(row.contextBytesSaved) : undefined;
		const ms = finiteDisplayNumber(row.ms);
		rows.push({
			kind, ...(packId ? { packId } : {}), hookId: row.hookId, event, outcome,
			...(reason ? { reason } : {}), ...(value ? { value } : {}), ...(ms === undefined ? {} : { ms }),
			...(requestId ? { requestId } : {}), ...(questionId ? { questionId } : {}), ...(answer ? { answer } : {}),
			...(defaultApplied === undefined ? {} : { defaultApplied }), ...(actor ? { actor } : {}),
			...(decisionClass ? { decisionClass } : {}), ...(decisionStatus ? { decisionStatus } : {}),
			...(classificationReason ? { classificationReason } : {}), ...(timeoutAction ? { timeoutAction } : {}),
			...(resumeStatus ? { resumeStatus } : {}), ...(selectionKind ? { selectionKind } : {}),
			...(selectionValue ? { selectionValue } : {}),
			...(capabilityStage ? { capabilityStage } : {}), ...(selectionFingerprint ? { selectionFingerprint } : {}),
			...(candidateCount === undefined ? {} : { candidateCount }), ...(selectedCount === undefined ? {} : { selectedCount }),
			...(selectorCount === undefined ? {} : { selectorCount }), ...(contextBytesSaved === undefined ? {} : { contextBytesSaved }),
		});
	}
	return rows;
}

/** Keep trace metadata and optional extension rows bounded and public before JSONL or REST. */
function sanitizeTraceEntry(entry: TraceEntry): TraceEntry {
	const { ts, hook, sessionId, providers: rawProviders, outcomes: rawOutcomes } = entry;
	const providers = sanitizeProviders(rawProviders);
	const outcomes = sanitizeOutcomes(rawOutcomes);
	// Do not spread entry: every durable trace field must be named here.
	return { ts, hook, sessionId, providers, ...(outcomes.length > 0 ? { outcomes } : {}) };
}

function safeBasename(sessionId: string): string {
	const stripped = sessionId.replace(/\.\./g, "_").replace(/[\\/]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
	return stripped || "session";
}
