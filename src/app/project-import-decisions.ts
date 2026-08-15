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

/** A bounded parsed proposal draft owned by a durable import request. */
export type ProjectImportProposalProjection = {
	projectId: string;
	requestId: string;
	proposalType: "goal" | "project" | "role" | "tool" | "staff";
	rev: number;
	fields: Record<string, unknown>;
};

type Listener = () => void;

type ProjectionState = "loading" | "loaded" | "error";

export type ProjectImportDecisionProjectionError = {
	message: string;
};

/** Bounded redacted activity rows from the project-owned EP-5 trace endpoint. */
export type ProjectImportDecisionActivity = {
	packId?: string;
	hookId: string;
	outcome: "advised" | "applied" | "denied" | "dropped" | "error" | "superseded";
	reason?: string;
};

type ActiveProjection = {
	projectId: string;
	requests: ProjectImportDecisionRequestProjection[];
	proposals: ProjectImportProposalProjection[];
	activity: ProjectImportDecisionActivity[];
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

function importActivityFromPayload(payload: unknown): ProjectImportDecisionActivity[] {
	const root = record(payload);
	const entries = Array.isArray(root?.activity) ? root.activity
		: Array.isArray(root?.entries) ? root.entries : [];
	const rows: ProjectImportDecisionActivity[] = [];
	for (const rawEntry of entries.slice(-50)) {
		const entry = record(rawEntry);
		const outcomes = Array.isArray(entry?.outcomes) ? entry.outcomes : [];
		for (const raw of outcomes.slice(0, 50)) {
			const outcome = record(raw);
			const hookId = string(outcome?.hookId, 128);
			const status = outcome?.outcome;
			if (!hookId || status !== "advised" && status !== "applied" && status !== "denied" && status !== "dropped" && status !== "error" && status !== "superseded") continue;
			const packId = string(outcome?.packId, 128) ?? undefined;
			const reason = string(outcome?.reason, 120) ?? undefined;
			rows.push({ hookId, outcome: status, ...(packId ? { packId } : {}), ...(reason ? { reason } : {}) });
		}
	}
	return rows.slice(-50).reverse();
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
	next: { state: ProjectionState; requests?: ProjectImportDecisionRequestProjection[]; proposals?: ProjectImportProposalProjection[]; activity?: ProjectImportDecisionActivity[]; error?: ProjectImportDecisionProjectionError | null },
): void {
	if (active !== current) return;
	current.state = next.state;
	if (next.requests) current.requests = next.requests;
	if (next.proposals) current.proposals = next.proposals;
	if (next.activity) current.activity = next.activity;
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

/** Safe trace rows for the Add Project decision workspace; no raw hook payload crosses here. */
export function projectImportDecisionActivityForProject(projectId: string): readonly ProjectImportDecisionActivity[] {
	return active?.projectId === projectId ? active.activity : [];
}

/** Parsed, project-owned proposal drafts awaiting explicit review. */
export function projectImportProposalsForProject(projectId: string): readonly ProjectImportProposalProjection[] {
	return active?.projectId === projectId ? active.proposals : [];
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
		active = { projectId, requests: [], proposals: [], activity: [], listeners: new Set(), generation: 0, state: "loading", error: null };
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
		const [response, proposalsResponse] = await Promise.all([
			gatewayFetch(
				gatewayRoute(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests?state=pending`),
				{ signal: controller.signal },
			),
			gatewayFetch(
				gatewayRoute(`/api/projects/${encodeURIComponent(projectId)}/import-proposals`),
				{ signal: controller.signal },
			),
		]);
		if (!response.ok || !proposalsResponse.ok) {
			finishFailedProjection(current, generation);
			return;
		}
		const [payload, proposalsPayload]: [unknown, unknown] = await Promise.all([response.json(), proposalsResponse.json()]);
		if (active !== current || current.generation !== generation) return;
		const rawProposals = record(proposalsPayload)?.proposals;
		const proposals: ProjectImportProposalProjection[] = [];
		if (Array.isArray(rawProposals)) for (const raw of rawProposals.slice(0, 20)) {
			const candidate = record(raw);
			const requestId = string(candidate?.requestId, 128);
			const proposalType = candidate?.proposalType;
			const rev = candidate?.rev;
			const fields = record(candidate?.fields);
			if (requestId && (proposalType === "goal" || proposalType === "project" || proposalType === "role" || proposalType === "tool" || proposalType === "staff")
				&& typeof rev === "number" && Number.isInteger(rev) && rev > 0 && fields) {
				proposals.push({ projectId, requestId, proposalType, rev, fields });
			}
		}
		// One project-owned response is the complete decision projection. Keeping
		// its optional trace rows on that response avoids a second GET racing the
		// pending snapshot or consuming a settlement refresh.
		setProjectionState(current, {
			state: "loaded",
			requests: actionableFromPayload(payload, projectId),
			proposals,
			activity: importActivityFromPayload(payload),
		});
	} catch {
		finishFailedProjection(current, generation);
	}
}

/** Submit one validated widget answer through the project-owned decision route only. */
export async function acceptProjectImportProposal(proposal: ProjectImportProposalProjection): Promise<void> {
	await decideProjectImportProposal(proposal, "accept");
}

export async function rejectProjectImportProposal(proposal: ProjectImportProposalProjection): Promise<void> {
	await decideProjectImportProposal(proposal, "reject");
}

async function decideProjectImportProposal(proposal: ProjectImportProposalProjection, action: "accept" | "reject"): Promise<void> {
	const response = await gatewayFetch(gatewayRoute(
		`/api/projects/${encodeURIComponent(proposal.projectId)}/import-proposals/${encodeURIComponent(proposal.requestId)}/${encodeURIComponent(proposal.proposalType)}/${action}`,
	), { method: "POST", body: JSON.stringify({ rev: proposal.rev }) });
	if (!response.ok) {
		const body = await response.json().catch(() => null);
		throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
	}
	await refreshProjectImportDecisionRequests(proposal.projectId);
}

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
