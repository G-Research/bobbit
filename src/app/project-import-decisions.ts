import { gatewayFetch } from "./gateway-fetch.js";
import { gatewayRoute } from "../shared/base-path.js";
import type {
	DecisionClass,
	DecisionOptionProjection,
	DecisionStatus,
	DecisionValue,
	DecisionRequestWidgetProjection,
} from "./extension-decisions.js";

export interface ProjectImportDecisionRequestProjection extends DecisionRequestWidgetProjection {
	projectId: string;
}

type Listener = () => void;

type ProjectionState = "loading" | "loaded" | "error";

export type ProjectImportDecisionProjectionError = {
	message: string;
};

type ActiveProjection = {
	projectId: string;
	requests: ProjectImportDecisionRequestProjection[];
	listeners: Set<Listener>;
	generation: number;
	state: ProjectionState;
	error: ProjectImportDecisionProjectionError | null;
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

/** Convert the server-owned durable record into the bounded project projection. */
export function normalizeProjectImportDecisionRequest(value: unknown, projectId: string): ProjectImportDecisionRequestProjection | null {
	const stored = record(value);
	if (!stored) return null;
	const request = record(stored.request) ?? stored;
	const id = string(stored.id ?? stored.requestId, 128);
	const requestStatus = status(stored.status);
	const requestClass = decisionClass(stored.decisionClass ?? stored.class);
	const title = string(request.title, 120);
	const question = string(request.question, 320);
	if (!id || !requestStatus || !requestClass || !title || !question || !Array.isArray(request.options)) return null;

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
		projectId,
		status: requestStatus,
		decisionClass: requestClass,
		title,
		question,
		options,
		...(resolved ? { resolution: { value: resolved } } : {}),
	};
}

function actionableFromPayload(payload: unknown, projectId: string): ProjectImportDecisionRequestProjection[] {
	const root = record(payload);
	const rawRequests = Array.isArray(root?.requests)
		? root.requests
		: Array.isArray(root?.decisionRequests)
			? root.decisionRequests
			: Array.isArray(payload) ? payload : [];
	const seen = new Set<string>();
	const requests: ProjectImportDecisionRequestProjection[] = [];
	for (const raw of rawRequests) {
		const request = normalizeProjectImportDecisionRequest(raw, projectId);
		if (!request || (request.status !== "pending" && request.status !== "paused-awaiting-consent") || seen.has(request.id)) continue;
		seen.add(request.id);
		requests.push(request);
	}
	return requests;
}

function responseRequest(payload: unknown, projectId: string): ProjectImportDecisionRequestProjection | null {
	const root = record(payload);
	if (!root) return null;
	for (const candidate of [root.request, root.decisionRequest, root.decision, root]) {
		const normalized = normalizeProjectImportDecisionRequest(candidate, projectId);
		if (normalized) return normalized;
	}
	return null;
}

function notify(current: ActiveProjection): void {
	for (const listener of current.listeners) listener();
}

function setProjectionState(
	current: ActiveProjection,
	next: { state: ProjectionState; requests?: ProjectImportDecisionRequestProjection[]; error?: ProjectImportDecisionProjectionError | null },
): void {
	if (active !== current) return;
	current.state = next.state;
	if (next.requests) current.requests = next.requests;
	current.error = next.error ?? null;
	notify(current);
}

function finishFailedProjection(current: ActiveProjection, generation: number): void {
	if (active !== current || current.generation !== generation) return;
	setProjectionState(current, {
		state: "error",
		error: { message: "Could not load project import decisions. Retry to continue." },
	});
}

/** The currently visible registered project's durable import decisions. */
export function projectImportDecisionRequestsForProject(projectId: string): readonly ProjectImportDecisionRequestProjection[] {
	return active?.projectId === projectId ? active.requests : [];
}

export function projectImportDecisionRequestsLoaded(projectId: string): boolean {
	return active?.projectId === projectId && active.state === "loaded";
}

/** A projection error is distinct from an authoritative empty projection. */
export function projectImportDecisionProjectionError(projectId: string): ProjectImportDecisionProjectionError | null {
	return active?.projectId === projectId ? active.error : null;
}

/** Start the sole active project-owned projection. It never opens an agent transport. */
export function activateProjectImportDecisionRequests(projectId: string, listener: Listener): () => void {
	if (!projectId) return () => {};
	if (!active || active.projectId !== projectId) {
		active?.controller?.abort();
		active = { projectId, requests: [], listeners: new Set(), generation: 0, state: "loading", error: null };
		void refreshProjectImportDecisionRequests(projectId);
	}
	const current = active;
	current.listeners.add(listener);
	listener();
	return () => current.listeners.delete(listener);
}

export function deactivateProjectImportDecisionRequests(projectId?: string): void {
	if (!active || (projectId && active.projectId !== projectId)) return;
	active.controller?.abort();
	active = null;
}

/** Metadata-only WebSocket invalidation; REST remains the projection authority. */
export function notifyProjectImportDecisionRequestsUpdated(projectId: string): void {
	if (active?.projectId === projectId) void refreshProjectImportDecisionRequests(projectId);
}

export async function refreshProjectImportDecisionRequests(projectId: string): Promise<void> {
	const current = active;
	if (!current || current.projectId !== projectId) return;
	current.controller?.abort();
	const controller = new AbortController();
	current.controller = controller;
	const generation = ++current.generation;
	setProjectionState(current, { state: "loading" });
	try {
		const response = await gatewayFetch(
			gatewayRoute(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests?state=pending`),
			{ signal: controller.signal },
		);
		if (!response.ok) {
			finishFailedProjection(current, generation);
			return;
		}
		const payload: unknown = await response.json();
		if (active !== current || current.generation !== generation) return;
		setProjectionState(current, {
			state: "loaded",
			requests: actionableFromPayload(payload, projectId),
		});
	} catch {
		finishFailedProjection(current, generation);
	}
}

/** Submit one validated widget answer through the project-owned decision route only. */
export async function answerProjectImportDecisionRequest(
	projectId: string,
	requestId: string,
	value: DecisionValue,
): Promise<ProjectImportDecisionRequestProjection | null> {
	const response = await gatewayFetch(
		gatewayRoute(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests/${encodeURIComponent(requestId)}/answer`),
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
	const terminal = responseRequest(await response.json(), projectId);
	if (terminal) {
		// A settlement is not itself proof that no other actionable request exists.
		// Re-read the pending projection before permitting the import handoff.
		await refreshProjectImportDecisionRequests(projectId);
	}
	return terminal;
}

/** Test-only reset for isolated DOM fixtures. */
export function __resetProjectImportDecisionRequestsForTests(): void {
	active?.controller?.abort();
	active = null;
}
