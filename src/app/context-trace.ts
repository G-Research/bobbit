import { gatewayFetch } from "./gateway-fetch.js";
import { activeSessionId, renderApp, state } from "./state.js";
import { getSidePanelWorkspace } from "./side-panel-workspace.js";

const INITIAL_LIMIT = 100;
const LIMIT_STEP = 100;
const MAX_LIMIT = 1000;
const MAX_DISPLAY_NUMBER = 1_000_000_000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOOKS = new Set(["sessionSetup", "beforePrompt", "afterTurn", "beforeCompact", "sessionShutdown", "projectImported", "decisionResolved"]);
const OUTCOME_KINDS = new Set(["decision", "advisory", "audit"]);
const OUTCOMES = new Set(["advised", "applied", "denied", "dropped", "error", "superseded"]);
const VALUE_OUTCOMES = new Set(["advised", "applied", "superseded"]);
const SELECTION_VALUE_OUTCOMES = new Set(["advised", "applied"]);
const RESOLUTION_OUTCOMES = new Set(["applied", "superseded"]);
const OUTCOME_REASONS = new Set<string>([
	"Grant required",
	"User pin",
	"Unavailable value",
	"Malformed result",
	"Timed out",
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
	"Unavailable",
]);
const SELECTION_KINDS = new Set(["model", "thinking", "role", "workflow"]);
const CAPABILITY_SELECTOR_STAGES = new Set(["skills", "mcp"]);
const SAFE_MODEL_SELECTION_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OUTCOME_ACTORS = new Set(["extension", "user", "deadline", "headless"]);
const DECISION_CLASSES = new Set(["deferrable", "consent-required"]);
const DECISION_STATUSES = new Set(["resolved", "defaulted", "denied", "paused-awaiting-consent"]);
const DECISION_CLASSIFICATION_REASONS = new Set(["requested", "core-hard-cap", "core-unsafe-tool", "core-capability-change", "core-grant-change", "core-configuration-change"]);
const CONSENT_TIMEOUT_ACTIONS = new Set(["deny-operation", "pause-goal"]);
const CONSENT_RESUME_STATUSES = new Set(["claimed", "resumed", "already-resumed", "not-matching", "denied"]);
const QUESTION_FINGERPRINT = /^(?:[a-f0-9]{64}|[a-z2-7]{52})$/;
const MAX_OUTCOMES_PER_ENTRY = 50;
const MAX_AUDIT_DIFF_BYTES = 256 * 1024;
const AUDIT_STATUSES = new Set(["requested", "proposed", "accepted", "rejected", "failed", "cancelled", "superseded"]);
const SECRET_PATTERNS = [
	/\b(?:sk|rk|pk)_[A-Za-z0-9_-]{16,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\b(?:api[_-]?key|password|secret)\s*[:=]\s*[^\s]+/gi,
];

export type ContextTraceStatus = "idle" | "loading" | "ready" | "error";
export type SafeContextTraceHook = "sessionSetup" | "beforePrompt" | "afterTurn" | "beforeCompact" | "sessionShutdown" | "projectImported" | "decisionResolved" | "Unknown event";
export type SafeContextTraceError = "Timed out" | "Malformed blocks omitted" | "Provider error";
export type SafeTraceOutcomeKind = "decision" | "advisory" | "audit";
export type SafeTraceOutcome = "advised" | "applied" | "denied" | "dropped" | "error" | "superseded";
export type SafeTraceOutcomeReason = "Grant required" | "User pin" | "Unavailable value" | "Malformed result" | "Timed out" | "Overlapping invocation" | "Cancelled" | "Disabled or revoked" | "Budget exhausted" | "Deadline elapsed" | "Headless default" | "Invalid answer" | "Duplicate" | "Capability revoked" | "Proposal failed" | "Lower-priority selection" | "Unavailable";
export type SafeTraceSelectionKind = "model" | "thinking" | "role" | "workflow";
export type SafeTraceCapabilitySelectorStage = "skills" | "mcp";
export type SafeTraceOutcomeActor = "extension" | "user" | "deadline" | "headless";
/** Fixed consent metadata retained by the safe REST projection. */
export type SafeTraceDecisionClass = "deferrable" | "consent-required";
export type SafeTraceDecisionStatus = "resolved" | "defaulted" | "denied" | "paused-awaiting-consent";
export type SafeTraceDecisionClassificationReason = "requested" | "core-hard-cap" | "core-unsafe-tool" | "core-capability-change" | "core-grant-change" | "core-configuration-change";
export type SafeTraceConsentTimeoutAction = "deny-operation" | "pause-goal";
export type SafeTraceConsentResumeStatus = "claimed" | "resumed" | "already-resumed" | "not-matching" | "denied";

export interface SafeTraceProviderRow {
	id: string;
	latencyMs: number;
	keptBlocks: number;
	omittedBlocks: number;
	error?: SafeContextTraceError;
}

export interface SafePromptExtensionAudit {
	id: string;
	status: string;
	packId: string;
	hookId: string;
	event: string;
	sectionId: string;
	actor: string;
	trigger: string;
	proposalId?: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	durationMs?: number;
	sectionBytes?: number;
	totalPromptBytes?: number;
	sectionShare?: number;
	usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number };
	/** Durable authorized detail, defense-in-depth redacted again before rendering. */
	diff?: string;
}

export interface SafeTraceOutcomeRow {
	kind: SafeTraceOutcomeKind;
	/** Safe server-derived pack attribution for scheduled advisor activity. */
	packId?: string;
	hookId: string;
	event: Exclude<SafeContextTraceHook, "Unknown event">;
	outcome: SafeTraceOutcome;
	reason?: SafeTraceOutcomeReason;
	value?: string;
	latencyMs?: number;
	audit?: SafePromptExtensionAudit;
	requestId?: string;
	questionId?: string;
	answer?: string;
	defaultApplied?: boolean;
	actor?: SafeTraceOutcomeActor;
	decisionClass?: SafeTraceDecisionClass;
	decisionStatus?: SafeTraceDecisionStatus;
	classificationReason?: SafeTraceDecisionClassificationReason;
	timeoutAction?: SafeTraceConsentTimeoutAction;
	resumeStatus?: SafeTraceConsentResumeStatus;
	selectionKind?: SafeTraceSelectionKind;
	selectionValue?: string;
	/** Aggregate startup capability-selection telemetry; no candidate ids or query data. */
	capabilityStage?: SafeTraceCapabilitySelectorStage;
	selectionFingerprint?: string;
	candidateCount?: number;
	selectedCount?: number;
	selectorCount?: number;
	contextBytesSaved?: number;
}

export interface SafeTraceEntry {
	hook: SafeContextTraceHook;
	ts: number;
	providers: SafeTraceProviderRow[];
	/** Outcome rows remain with their lifecycle event through all pagination. */
	outcomes?: SafeTraceOutcomeRow[];
}

export type ContextInspectorItem = { kind: "trace"; entry: SafeTraceEntry };

export interface ContextTraceState {
	status: ContextTraceStatus;
	items: ContextInspectorItem[];
	limit: number;
	hasEarlier: boolean;
	isRefreshing: boolean;
	/** Fixed local copy only; never a server error string. */
	error?: "Unable to load context trace.";
	/** True when a refresh failed but cached rows remain available. */
	refreshError: boolean;
	/** Authorized audit detail is optional; trace activity remains available without it. */
	auditUnavailable?: boolean;
}

type Request = {
	sessionId: string;
	generation: number;
	controller: AbortController;
};

const states = new Map<string, ContextTraceState>();
/** Invalidation received while its session is inactive; consume on the next open/sync. */
const staleSessions = new Set<string>();
let request: Request | null = null;
let requestGeneration = 0;
let openedSessionId: string | null = null;
const openers = new Map<string, HTMLElement>();

function emptyState(): ContextTraceState {
	return {
		status: "idle",
		items: [],
		limit: INITIAL_LIMIT,
		hasEarlier: false,
		isRefreshing: false,
		refreshError: false,
	};
}

function stateFor(sessionId: string): ContextTraceState {
	let value = states.get(sessionId);
	if (!value) {
		value = emptyState();
		states.set(sessionId, value);
	}
	return value;
}

function update(sessionId: string, next: ContextTraceState): void {
	states.set(sessionId, next);
	renderApp();
}

function tabIsContextForSession(tab: unknown, sessionId: string): boolean {
	if (!tab || typeof tab !== "object") return false;
	const value = tab as { kind?: unknown; source?: { type?: unknown; sessionId?: unknown } };
	return value.kind === "context"
		&& value.source?.type === "context"
		&& value.source.sessionId === sessionId;
}

function workspaceHasContextInspector(sessionId: string): boolean {
	return getSidePanelWorkspace(sessionId).tabs.some((tab) => tabIsContextForSession(tab, sessionId));
}

function inspectorIsOpen(sessionId: string): boolean {
	// `openContextTraceInspector` is called as part of the optimistic open action;
	// the persisted workspace can arrive just after it. Thereafter, sync owns the
	// durable tab check and clears this marker if that action is rolled back/closed.
	return openedSessionId === sessionId || workspaceHasContextInspector(sessionId);
}

function isActiveSession(sessionId: string): boolean {
	return activeSessionId() === sessionId
		&& state.selectedSessionId === sessionId
		&& state.remoteAgent?.gatewaySessionId === sessionId;
}

function canApply(current: Request): boolean {
	return request === current
		&& current.generation === requestGeneration
		&& isActiveSession(current.sessionId)
		&& inspectorIsOpen(current.sessionId);
}

function abortRequest(): void {
	requestGeneration++;
	if (request) request.controller.abort();
	request = null;
}

function finiteDisplayNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.min(MAX_DISPLAY_NUMBER, Math.max(0, Math.trunc(value)));
}

function finiteTimestamp(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.min(MAX_TIMESTAMP, Math.max(0, Math.trunc(value)));
}

function safeHook(value: unknown): SafeContextTraceHook {
	return typeof value === "string" && HOOKS.has(value)
		? value as Exclude<SafeContextTraceHook, "Unknown event">
		: "Unknown event";
}

function safeProviderId(value: unknown): string {
	return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : "Unknown provider";
}

function safeError(value: unknown): SafeContextTraceError | undefined {
	if (!value) return undefined;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "timeout" || normalized === "timed out") return "Timed out";
		// LifecycleHub emits this exact diagnostic label for malformed provider blocks.
		if (normalized === "malformed block(s) dropped" || normalized === "malformed blocks omitted") return "Malformed blocks omitted";
	}
	return "Provider error";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeAuditText(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function safeAuditNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? finiteDisplayNumber(value) : undefined;
}

function redactAuditDiff(value: string): string {
	return SECRET_PATTERNS.reduce((output, pattern) => output.replace(pattern, "[REDACTED]"), value).slice(0, MAX_AUDIT_DIFF_BYTES);
}

/** Normalize authorized detail separately: it never becomes Context trace JSONL. */
export function normalizePromptExtensionAuditPayload(payload: unknown): Map<string, SafePromptExtensionAudit> {
	const records = asRecord(payload);
	const audits = new Map<string, SafePromptExtensionAudit>();
	if (!records || !Array.isArray(records.entries)) return audits;
	for (const raw of records.entries) {
		const entry = asRecord(raw);
		if (!entry || typeof entry.id !== "string" || !SAFE_IDENTIFIER.test(entry.id)
			|| typeof entry.status !== "string" || !AUDIT_STATUSES.has(entry.status)) continue;
		const packId = safeProviderId(entry.packId);
		const hookId = safeProviderId(entry.hookId);
		const sectionId = safeProviderId(entry.sectionId);
		const actor = safeAuditText(entry.actor);
		const event = safeAuditText(entry.event);
		const trigger = safeAuditText(entry.trigger);
		if (!actor || !event || !trigger || packId === "Unknown provider" || hookId === "Unknown provider" || sectionId === "Unknown provider") continue;
		const usage = asRecord(entry.usage);
		const normalizedUsage = usage ? Object.fromEntries(
			["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost"]
				.flatMap(key => {
					const amount = safeAuditNumber(usage[key]);
					return amount === undefined ? [] : [[key, amount]];
				}),
		) as SafePromptExtensionAudit["usage"] : undefined;
		audits.set(entry.id, {
			id: entry.id, status: entry.status, packId, hookId, sectionId, actor, event, trigger,
			...(typeof entry.proposalId === "string" && SAFE_IDENTIFIER.test(entry.proposalId) ? { proposalId: entry.proposalId } : {}),
			...(safeAuditText(entry.model) ? { model: safeAuditText(entry.model) } : {}),
			...(safeAuditText(entry.provider) ? { provider: safeAuditText(entry.provider) } : {}),
			...(safeAuditText(entry.thinkingLevel) ? { thinkingLevel: safeAuditText(entry.thinkingLevel) } : {}),
			...(safeAuditNumber(entry.durationMs) !== undefined ? { durationMs: safeAuditNumber(entry.durationMs) } : {}),
			...(safeAuditNumber(entry.sectionBytes) !== undefined ? { sectionBytes: safeAuditNumber(entry.sectionBytes) } : {}),
			...(safeAuditNumber(entry.totalPromptBytes) !== undefined ? { totalPromptBytes: safeAuditNumber(entry.totalPromptBytes) } : {}),
			...(typeof entry.sectionShare === "number" && Number.isFinite(entry.sectionShare) && entry.sectionShare >= 0 && entry.sectionShare <= 1 ? { sectionShare: entry.sectionShare } : {}),
			...(normalizedUsage && Object.keys(normalizedUsage).length ? { usage: normalizedUsage } : {}),
			...(typeof entry.diff === "string" ? { diff: redactAuditDiff(entry.diff) } : {}),
		});
	}
	return audits;
}

function safeSelectionValue(kind: SafeTraceSelectionKind | undefined, value: unknown): string | undefined {
	if (typeof value !== "string" || !kind) return undefined;
	return kind === "model"
		? (SAFE_MODEL_SELECTION_VALUE.test(value) ? value : undefined)
		: (SAFE_IDENTIFIER.test(value) ? value : undefined);
}

function safeOutcomes(value: unknown, audits?: ReadonlyMap<string, SafePromptExtensionAudit>): SafeTraceOutcomeRow[] {
	if (!Array.isArray(value)) return [];
	const outcomes: SafeTraceOutcomeRow[] = [];
	for (const rawOutcome of value.slice(0, MAX_OUTCOMES_PER_ENTRY)) {
		const outcome = asRecord(rawOutcome);
		if (!outcome || typeof outcome.kind !== "string" || !OUTCOME_KINDS.has(outcome.kind)) continue;
		if (typeof outcome.hookId !== "string" || !SAFE_IDENTIFIER.test(outcome.hookId)) continue;
		if (typeof outcome.event !== "string" || !HOOKS.has(outcome.event)) continue;
		if (typeof outcome.outcome !== "string" || !OUTCOMES.has(outcome.outcome)) continue;
		const kind = outcome.kind as SafeTraceOutcomeKind;
		const event = outcome.event as Exclude<SafeContextTraceHook, "Unknown event">;
		const status = outcome.outcome as SafeTraceOutcome;
		const reason = typeof outcome.reason === "string" && OUTCOME_REASONS.has(outcome.reason)
			? outcome.reason as SafeTraceOutcomeReason
			: undefined;
		const selectedValue = VALUE_OUTCOMES.has(status) && typeof outcome.value === "string" && SAFE_IDENTIFIER.test(outcome.value)
			? outcome.value
			: undefined;
		const latencyMs = typeof outcome.ms === "number" && Number.isFinite(outcome.ms) && outcome.ms >= 0
			? finiteDisplayNumber(outcome.ms)
			: undefined;
		const isDecisionActivity = kind === "decision" || kind === "advisory";
		const packId = isDecisionActivity && typeof outcome.packId === "string" && SAFE_IDENTIFIER.test(outcome.packId)
			? outcome.packId : undefined;
		// Scheduled advisors require safe, server-derived attribution before display.
		if (kind === "advisory" && event === "afterTurn" && !packId) continue;
		const requestId = isDecisionActivity && typeof outcome.requestId === "string" && SAFE_IDENTIFIER.test(outcome.requestId) ? outcome.requestId : undefined;
		const questionId = isDecisionActivity && typeof outcome.questionId === "string" && QUESTION_FINGERPRINT.test(outcome.questionId) ? outcome.questionId : undefined;
		const answer = isDecisionActivity && RESOLUTION_OUTCOMES.has(status) && typeof outcome.answer === "string" && SAFE_IDENTIFIER.test(outcome.answer) ? outcome.answer : undefined;
		const defaultApplied = isDecisionActivity && RESOLUTION_OUTCOMES.has(status) && typeof outcome.defaultApplied === "boolean" ? outcome.defaultApplied : undefined;
		const actor = isDecisionActivity && typeof outcome.actor === "string" && OUTCOME_ACTORS.has(outcome.actor) ? outcome.actor as SafeTraceOutcomeActor : undefined;
		const decisionClass = isDecisionActivity && typeof outcome.decisionClass === "string" && DECISION_CLASSES.has(outcome.decisionClass)
			? outcome.decisionClass as SafeTraceDecisionClass : undefined;
		const decisionStatus = isDecisionActivity && typeof outcome.decisionStatus === "string" && DECISION_STATUSES.has(outcome.decisionStatus)
			? outcome.decisionStatus as SafeTraceDecisionStatus : undefined;
		const classificationReason = isDecisionActivity && typeof outcome.classificationReason === "string" && DECISION_CLASSIFICATION_REASONS.has(outcome.classificationReason)
			? outcome.classificationReason as SafeTraceDecisionClassificationReason : undefined;
		const timeoutAction = isDecisionActivity && typeof outcome.timeoutAction === "string" && CONSENT_TIMEOUT_ACTIONS.has(outcome.timeoutAction)
			? outcome.timeoutAction as SafeTraceConsentTimeoutAction : undefined;
		const resumeStatus = isDecisionActivity && typeof outcome.resumeStatus === "string" && CONSENT_RESUME_STATUSES.has(outcome.resumeStatus)
			? outcome.resumeStatus as SafeTraceConsentResumeStatus : undefined;
		const selectionKind = isDecisionActivity && typeof outcome.selectionKind === "string" && SELECTION_KINDS.has(outcome.selectionKind)
			? outcome.selectionKind as SafeTraceSelectionKind : undefined;
		const selectionValue = SELECTION_VALUE_OUTCOMES.has(status)
			? safeSelectionValue(selectionKind, outcome.selectionValue)
			: undefined;
		// Keep dynamic-selection telemetry on the same strict allow-list as its
		// durable trace. It is aggregate-only and valid solely for session setup.
		const capabilityStage = kind === "decision" && event === "sessionSetup"
			&& typeof outcome.capabilityStage === "string" && CAPABILITY_SELECTOR_STAGES.has(outcome.capabilityStage)
			? outcome.capabilityStage as SafeTraceCapabilitySelectorStage
			: undefined;
		const selectionFingerprint = capabilityStage && typeof outcome.selectionFingerprint === "string" && QUESTION_FINGERPRINT.test(outcome.selectionFingerprint)
			? outcome.selectionFingerprint
			: undefined;
		const candidateCount = capabilityStage && typeof outcome.candidateCount === "number" && Number.isFinite(outcome.candidateCount) && outcome.candidateCount >= 0
			? finiteDisplayNumber(outcome.candidateCount) : undefined;
		const selectedCount = capabilityStage && typeof outcome.selectedCount === "number" && Number.isFinite(outcome.selectedCount) && outcome.selectedCount >= 0
			? finiteDisplayNumber(outcome.selectedCount) : undefined;
		const selectorCount = capabilityStage && typeof outcome.selectorCount === "number" && Number.isFinite(outcome.selectorCount) && outcome.selectorCount >= 0
			? finiteDisplayNumber(outcome.selectorCount) : undefined;
		const contextBytesSaved = capabilityStage && typeof outcome.contextBytesSaved === "number" && Number.isFinite(outcome.contextBytesSaved) && outcome.contextBytesSaved >= 0
			? finiteDisplayNumber(outcome.contextBytesSaved) : undefined;
		outcomes.push({
			kind, ...(packId ? { packId } : {}), hookId: outcome.hookId, event, outcome: status,
			...(reason ? { reason } : {}), ...(selectedValue ? { value: selectedValue } : {}), ...(latencyMs === undefined ? {} : { latencyMs }),
			...(selectedValue && audits?.get(selectedValue) ? { audit: audits.get(selectedValue) } : {}),
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
	return outcomes;
}

function hasPromptExtensionAuditOutcome(payload: unknown): boolean {
	const entries = asRecord(payload)?.entries;
	return Array.isArray(entries) && entries.some(rawEntry => {
		const outcomes = asRecord(rawEntry)?.outcomes;
		return Array.isArray(outcomes) && outcomes.some(raw => {
			const outcome = asRecord(raw);
			return outcome?.kind === "audit" && outcome.outcome === "applied"
				&& typeof outcome.value === "string" && SAFE_IDENTIFIER.test(outcome.value);
		});
	});
}

/** Converts the untrusted REST payload into the only shapes the inspector sees. */
export function normalizeContextTracePayload(payload: unknown, audits?: ReadonlyMap<string, SafePromptExtensionAudit>): ContextInspectorItem[] {
	const record = asRecord(payload);
	if (!record || !Array.isArray(record.entries)) return [];

	const entries: ContextInspectorItem[] = [];
	for (const rawEntry of record.entries) {
		const entry = asRecord(rawEntry);
		if (!entry) continue;
		const providers: SafeTraceProviderRow[] = [];
		for (const rawProvider of Array.isArray(entry.providers) ? entry.providers : []) {
			const provider = asRecord(rawProvider);
			if (!provider) continue;
			const error = safeError(provider.error);
			providers.push({
				id: safeProviderId(provider.id),
				latencyMs: finiteDisplayNumber(provider.ms),
				keptBlocks: finiteDisplayNumber(provider.blocks),
				omittedBlocks: finiteDisplayNumber(provider.omitted),
				...(error ? { error } : {}),
			});
		}
		const outcomes = safeOutcomes(entry.outcomes, audits);
		entries.push({
			kind: "trace",
			entry: {
				hook: safeHook(entry.hook),
				ts: finiteTimestamp(entry.ts),
				providers,
				...(outcomes.length > 0 ? { outcomes } : {}),
			},
		});
	}
	// API order is oldest → newest. Reverse entries only; provider order is data.
	return entries.reverse();
}

export function contextTraceStateFor(sessionId: string): ContextTraceState {
	return stateFor(sessionId);
}

export function openContextTraceInspector(sessionId: string, opener?: HTMLElement): void {
	// Session-menu callbacks can outlive their session. Ignore them before they
	// can disturb the active inspector's request or focus restoration target.
	if (!isActiveSession(sessionId)) return;
	if (openedSessionId && openedSessionId !== sessionId) abortRequest();
	if (opener) openers.set(sessionId, opener);
	openedSessionId = sessionId;
	staleSessions.delete(sessionId);
	void refreshContextTrace(sessionId);
}

/** Reconcile the controller with the authoritative, hydrated side-panel tabs. */
export function syncContextTraceInspector(sessionId: string): void {
	// A stale connection/workspace callback for an inactive session must not
	// cancel the inspector currently owned by the active connection.
	if (!isActiveSession(sessionId)) return;
	if (!workspaceHasContextInspector(sessionId)) {
		if (openedSessionId === sessionId) stopContextTraceInspector();
		return;
	}
	if (openedSessionId && openedSessionId !== sessionId) abortRequest();
	openedSessionId = sessionId;
	const current = stateFor(sessionId);
	const needsRevalidation = staleSessions.delete(sessionId);
	if (current.status === "idle" || needsRevalidation) void refreshContextTrace(sessionId);
}

export async function refreshContextTrace(sessionId: string): Promise<void> {
	if (!isActiveSession(sessionId) || !inspectorIsOpen(sessionId)) return;
	abortRequest();
	const controller = new AbortController();
	const current: Request = { sessionId, generation: requestGeneration, controller };
	request = current;
	const previous = stateFor(sessionId);
	const hasCachedItems = previous.items.length > 0;
	update(sessionId, {
		...previous,
		status: hasCachedItems ? "ready" : "loading",
		// A full initial page can have earlier history. The response confirms or
		// clears this before any rows (and therefore the paging control) render.
		hasEarlier: hasCachedItems ? previous.hasEarlier : previous.limit < MAX_LIMIT,
		isRefreshing: hasCachedItems,
		error: undefined,
		refreshError: false,
	});
	try {
		const response = await gatewayFetch(
			`/api/sessions/${encodeURIComponent(sessionId)}/context-trace?limit=${previous.limit}`,
			{ signal: controller.signal },
		);
		if (!response.ok) throw new Error("Context trace request failed");
		const payload: unknown = await response.json();
		// Exact authoring content lives only in its authorized durable endpoint.
		// Its absence must not hide the safe Context trace activity.
		let audits = new Map<string, SafePromptExtensionAudit>();
		let auditUnavailable = false;
		// Avoid an extra request for ordinary provider-only traces. A matching
		// bounded audit outcome is the sole join key for authorized detail.
		if (hasPromptExtensionAuditOutcome(payload)) {
			try {
				const auditResponse = await gatewayFetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompt-extension-audit`, { signal: controller.signal });
				if (!auditResponse.ok) auditUnavailable = true;
				else audits = normalizePromptExtensionAuditPayload(await auditResponse.json());
			} catch {
				if (!controller.signal.aborted) auditUnavailable = true;
			}
		}
		if (!canApply(current)) return;
		const items = normalizeContextTracePayload(payload, audits);
		const received = asRecord(payload)?.entries;
		update(sessionId, {
			...stateFor(sessionId),
			status: "ready",
			items,
			hasEarlier: Array.isArray(received) && received.length >= previous.limit && previous.limit < MAX_LIMIT,
			isRefreshing: false,
			error: undefined,
			refreshError: false,
			auditUnavailable,
		});
	} catch {
		if (controller.signal.aborted || !canApply(current)) return;
		const latest = stateFor(sessionId);
		const cached = latest.items.length > 0;
		update(sessionId, {
			...latest,
			status: cached ? "ready" : "error",
			isRefreshing: false,
			error: "Unable to load context trace.",
			refreshError: cached,
		});
	} finally {
		if (request === current) request = null;
	}
}

export async function loadEarlierContextTrace(sessionId: string): Promise<void> {
	if (!isActiveSession(sessionId) || !inspectorIsOpen(sessionId)) return;
	const previous = stateFor(sessionId);
	if (!previous.hasEarlier || previous.limit >= MAX_LIMIT) return;
	update(sessionId, { ...previous, limit: Math.min(MAX_LIMIT, previous.limit + LIMIT_STEP) });
	await refreshContextTrace(sessionId);
}

/** Metadata-only WS invalidation. Trace rows always remain on the REST endpoint. */
export function notifyContextTraceUpdated(sessionId: string): void {
	if (!isActiveSession(sessionId)) {
		// The trace is session-scoped. Remember this metadata-only invalidation so
		// reopening the persisted inspector performs one bounded revalidation.
		staleSessions.add(sessionId);
		return;
	}
	if (!inspectorIsOpen(sessionId)) return;
	void refreshContextTrace(sessionId);
}

/** Cancel work on session switch, connection loss, or Context-tab close. */
export function stopContextTraceInspector(): void {
	abortRequest();
	openedSessionId = null;
}

/** Restore focus after Context closes without moving focus during a refresh. */
export function restoreContextTraceInspectorFocus(sessionId: string): void {
	const opener = openers.get(sessionId);
	openers.delete(sessionId);
	queueMicrotask(() => {
		if (activeSessionId() !== sessionId || state.selectedSessionId !== sessionId) return;
		const target = opener?.isConnected
			? opener
			: document.querySelector<HTMLElement>('[data-testid="session-actions-trigger"]')
				?? document.querySelector<HTMLElement>("textarea");
		try { target?.focus({ preventScroll: true }); } catch { target?.focus(); }
	});
}

/** Test-only reset to keep module state from leaking between DOM fixtures. */
export function __resetContextTraceForTests(): void {
	abortRequest();
	states.clear();
	staleSessions.clear();
	openers.clear();
	openedSessionId = null;
}
