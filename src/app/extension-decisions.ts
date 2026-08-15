import { gatewayFetch } from "./gateway-fetch.js";
import { gatewayRoute } from "../shared/base-path.js";

export type DecisionStatus = "pending" | "resolved" | "rejected" | "expired" | "superseded" | "defaulted" | "denied" | "paused-awaiting-consent";
export type DecisionClass = "deferrable" | "consent-required";

export interface DecisionOptionProjection {
	value: string;
	label: string;
}

export type DecisionValue =
	| { kind: "option"; value: string }
	| { kind: "other"; text: string };

/** Shared bounded fields rendered by both session and project-owned decisions. */
export interface DecisionRequestWidgetProjection {
	id: string;
	status: DecisionStatus;
	/** Absent historical records are compatible deferrable decisions. */
	decisionClass: DecisionClass;
	title: string;
	question: string;
	options: DecisionOptionProjection[];
	resolution?: { value: DecisionValue };
}

export interface DecisionRequestProjection extends DecisionRequestWidgetProjection {
	sessionId: string;
}

type Listener = () => void;

type ActiveProjection = {
	sessionId: string;
	requests: DecisionRequestProjection[];
	listeners: Set<Listener>;
	generation: number;
	controller?: AbortController;
};

let active: ActiveProjection | null = null;

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function string(value: unknown, max = 1_000): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function status(value: unknown): DecisionStatus | null {
	return value === "pending" || value === "resolved" || value === "rejected" || value === "expired" || value === "superseded"
		|| value === "defaulted" || value === "denied" || value === "paused-awaiting-consent"
		? value
		: null;
}

function decisionClass(value: unknown): DecisionClass | null {
	return value === undefined || value === "deferrable" ? "deferrable"
		: value === "consent-required" ? value
			: null;
}

function decisionValue(value: unknown): DecisionValue | undefined {
	const raw = record(value);
	if (!raw || typeof raw.kind !== "string") return undefined;
	if (raw.kind === "option") {
		const option = string(raw.value, 128);
		return option ? { kind: "option", value: option } : undefined;
	}
	if (raw.kind === "other") {
		const text = string(raw.text, 280);
		return text ? { kind: "other", text } : undefined;
	}
	return undefined;
}

/** Convert the server-owned durable record into the bounded UI projection. */
export function normalizeDecisionRequest(value: unknown): DecisionRequestProjection | null {
	const stored = record(value);
	if (!stored) return null;
	const request = record(stored.request) ?? stored;
	const id = string(stored.id ?? stored.requestId, 128);
	const sessionId = string(stored.sessionId, 256);
	const requestStatus = status(stored.status);
	const requestClass = decisionClass(stored.decisionClass ?? stored.class);
	const title = string(request.title, 120);
	const question = string(request.question, 320);
	if (!id || !sessionId || !requestStatus || !requestClass || !title || !question || !Array.isArray(request.options)) return null;

	const options: DecisionOptionProjection[] = [];
	const values = new Set<string>();
	for (const raw of request.options) {
		const option = record(raw);
		const optionValue = string(option?.value, 128);
		const label = string(option?.label, 120);
		if (!optionValue || !label || values.has(optionValue)) return null;
		values.add(optionValue);
		options.push({ value: optionValue, label });
	}
	if (options.length < 2 || options.length > 8) return null;

	const resolutionRecord = record(stored.resolution);
	const resolved = decisionValue(resolutionRecord?.value ?? stored.value);
	return {
		id,
		sessionId,
		status: requestStatus,
		decisionClass: requestClass,
		title,
		question,
		options,
		...(resolved ? { resolution: { value: resolved } } : {}),
	};
}

function responseRequest(payload: unknown): DecisionRequestProjection | null {
	const root = record(payload);
	if (!root) return null;
	for (const candidate of [root.request, root.decisionRequest, root.decision, root]) {
		const normalized = normalizeDecisionRequest(candidate);
		if (normalized) return normalized;
	}
	return null;
}

function notify(current: ActiveProjection): void {
	for (const listener of current.listeners) listener();
}

function setRequests(current: ActiveProjection, next: DecisionRequestProjection[]): void {
	if (active !== current) return;
	current.requests = next;
	notify(current);
}

function actionableFromPayload(payload: unknown): DecisionRequestProjection[] {
	const root = record(payload);
	const rawRequests = Array.isArray(root?.requests)
		? root.requests
		: Array.isArray(root?.decisionRequests)
			? root.decisionRequests
			: Array.isArray(payload) ? payload : [];
	const seen = new Set<string>();
	const requests: DecisionRequestProjection[] = [];
	for (const raw of rawRequests) {
		const request = normalizeDecisionRequest(raw);
		if (!request || (request.status !== "pending" && request.status !== "paused-awaiting-consent") || seen.has(request.id)) continue;
		seen.add(request.id);
		requests.push(request);
	}
	return requests;
}

/** The currently visible session's durable decision projection. */
export function decisionRequestsForSession(sessionId: string): readonly DecisionRequestProjection[] {
	return active?.sessionId === sessionId ? active.requests : [];
}

/**
 * Start the sole active conversation projection. A session switch discards the
 * previous projection before its fetch can apply, so decision data never leaks
 * between sessions.
 */
export function activateDecisionRequests(sessionId: string, listener: Listener): () => void {
	if (!sessionId) return () => {};
	if (!active || active.sessionId !== sessionId) {
		active?.controller?.abort();
		active = { sessionId, requests: [], listeners: new Set(), generation: 0 };
		void refreshDecisionRequests(sessionId);
	}
	const current = active;
	current.listeners.add(listener);
	listener();
	return () => current.listeners.delete(listener);
}

/** Drop the active projection when its conversation surface is no longer mounted. */
export function deactivateDecisionRequests(sessionId?: string): void {
	if (!active || (sessionId && active.sessionId !== sessionId)) return;
	active.controller?.abort();
	active = null;
}

/** Metadata-only WebSocket invalidation; REST remains the projection authority. */
export function notifyDecisionRequestsUpdated(sessionId: string): void {
	if (active?.sessionId === sessionId) void refreshDecisionRequests(sessionId);
}

export async function refreshDecisionRequests(sessionId: string): Promise<void> {
	const current = active;
	if (!current || current.sessionId !== sessionId) return;
	current.controller?.abort();
	const controller = new AbortController();
	current.controller = controller;
	const generation = ++current.generation;
	try {
		const response = await gatewayFetch(
			gatewayRoute(`/api/sessions/${encodeURIComponent(sessionId)}/decision-requests?state=pending`),
			{ signal: controller.signal },
		);
		if (!response.ok) return;
		const payload: unknown = await response.json();
		if (active !== current || current.generation !== generation) return;
		// A terminal result is retained only until the next authoritative actionable
		// projection. This makes a confirmed answer visibly read-only without
		// turning historical decisions into a second transcript system.
		setRequests(current, actionableFromPayload(payload));
	} catch {
		// A failed UI refresh leaves the existing durable projection untouched;
		// deadlines and resolution are wholly server-owned.
	}
}

/** Submit one validated widget answer through the decision route only. */
export async function answerDecisionRequest(
	sessionId: string,
	requestId: string,
	value: DecisionValue,
): Promise<DecisionRequestProjection | null> {
	const response = await gatewayFetch(
		gatewayRoute(`/api/sessions/${encodeURIComponent(sessionId)}/decision-requests/${encodeURIComponent(requestId)}/answer`),
		{ method: "POST", body: JSON.stringify({ value }) },
	);
	if (!response.ok) {
		let message = `HTTP ${response.status}`;
		try {
			const body = await response.json();
			if (typeof body?.error === "string" && body.error) message = body.error;
		} catch { /* fixed HTTP fallback */ }
		throw new Error(message);
	}
	const terminal = responseRequest(await response.json());
	const current = active;
	if (terminal && current?.sessionId === sessionId) {
		setRequests(current, current.requests.map((request) => request.id === terminal.id ? terminal : request));
	}
	return terminal;
}

/** Test-only reset for isolated DOM fixtures. */
export function __resetDecisionRequestsForTests(): void {
	active?.controller?.abort();
	active = null;
}
