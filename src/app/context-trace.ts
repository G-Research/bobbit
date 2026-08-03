import { gatewayFetch } from "./gateway-fetch.js";
import { activeSessionId, renderApp, state } from "./state.js";
import { getSidePanelWorkspace } from "./side-panel-workspace.js";

const INITIAL_LIMIT = 100;
const LIMIT_STEP = 100;
const MAX_LIMIT = 1000;
const MAX_DISPLAY_NUMBER = 1_000_000_000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOOKS = new Set(["sessionSetup", "beforePrompt", "afterTurn", "beforeCompact", "sessionShutdown"]);

export type ContextTraceStatus = "idle" | "loading" | "ready" | "error";
export type SafeContextTraceHook = "sessionSetup" | "beforePrompt" | "afterTurn" | "beforeCompact" | "sessionShutdown" | "Unknown event";
export type SafeContextTraceError = "Timed out" | "Malformed blocks omitted" | "Provider error";

export interface SafeTraceProviderRow {
	id: string;
	latencyMs: number;
	keptBlocks: number;
	omittedBlocks: number;
	error?: SafeContextTraceError;
}

export interface SafeTraceEntry {
	hook: SafeContextTraceHook;
	ts: number;
	providers: SafeTraceProviderRow[];
}

/** Deliberately additive so future decision rows do not alter trace rendering. */
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
	return typeof value === "string" && PROVIDER_ID.test(value) ? value : "Unknown provider";
}

function safeError(value: unknown): SafeContextTraceError | undefined {
	if (!value) return undefined;
	if (typeof value === "string" && value.trim().toLowerCase() === "timeout") return "Timed out";
	if (typeof value === "string" && /^malformed blocks? dropped$/i.test(value.trim())) return "Malformed blocks omitted";
	return "Provider error";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Converts the untrusted REST payload into the only shapes the inspector sees. */
export function normalizeContextTracePayload(payload: unknown): ContextInspectorItem[] {
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
		entries.push({
			kind: "trace",
			entry: { hook: safeHook(entry.hook), ts: finiteTimestamp(entry.ts), providers },
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
		if (!canApply(current)) return;
		const items = normalizeContextTracePayload(payload);
		const received = asRecord(payload)?.entries;
		update(sessionId, {
			...stateFor(sessionId),
			status: "ready",
			items,
			hasEarlier: Array.isArray(received) && received.length >= previous.limit && previous.limit < MAX_LIMIT,
			isRefreshing: false,
			error: undefined,
			refreshError: false,
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
