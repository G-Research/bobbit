import { gatewayFetch } from "./gateway-fetch.js";
import { gatewayRoute } from "../shared/base-path.js";

export const ASK_DISMISSALS_CHANGED_EVENT = "bobbit-ask-dismissals-changed";

export interface AskDismissalsChangedDetail {
	sessionId: string;
	toolUseId?: string;
}

const dismissalsBySession = new Map<string, ReadonlySet<string>>();
const loadsBySession = new Map<string, Promise<ReadonlySet<string>>>();

function validIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function publish(sessionId: string, toolUseId?: string): void {
	if (typeof document === "undefined") return;
	document.dispatchEvent(new CustomEvent<AskDismissalsChangedDetail>(ASK_DISMISSALS_CHANGED_EVENT, {
		detail: { sessionId, ...(toolUseId ? { toolUseId } : {}) },
	}));
}

function replaceDismissals(sessionId: string, ids: readonly string[]): ReadonlySet<string> {
	const next = new Set(validIds(ids));
	const current = dismissalsBySession.get(sessionId);
	if (current && current.size === next.size && [...current].every((id) => next.has(id))) return current;
	dismissalsBySession.set(sessionId, next);
	publish(sessionId);
	return next;
}

export function dismissedAskToolUseIds(sessionId: string | undefined): ReadonlySet<string> {
	if (!sessionId) return new Set();
	return dismissalsBySession.get(sessionId) ?? new Set();
}

export function isAskQuestionDismissed(sessionId: string | undefined, toolUseId: string | undefined): boolean {
	return !!sessionId && !!toolUseId && dismissedAskToolUseIds(sessionId).has(toolUseId);
}

export function applyAskQuestionDismissed(sessionId: string, toolUseId: string): void {
	if (!sessionId || !toolUseId) return;
	const current = dismissalsBySession.get(sessionId) ?? new Set<string>();
	if (current.has(toolUseId)) return;
	const next = new Set(current);
	next.add(toolUseId);
	dismissalsBySession.set(sessionId, next);
	publish(sessionId, toolUseId);
}

export async function loadAskQuestionDismissals(sessionId: string, force = false): Promise<ReadonlySet<string>> {
	if (!sessionId) return new Set();
	if (!force) {
		const cached = dismissalsBySession.get(sessionId);
		if (cached) return cached;
		const pending = loadsBySession.get(sessionId);
		if (pending) return pending;
	}
	const load = (async () => {
		const response = await gatewayFetch(gatewayRoute(
			`/api/internal/user-question/dismissals?sessionId=${encodeURIComponent(sessionId)}`,
		));
		if (!response.ok) throw new Error(`Failed to load dismissed questions (HTTP ${response.status})`);
		const body = await response.json();
		return replaceDismissals(sessionId, validIds(body?.dismissedToolUseIds));
	})().finally(() => {
		if (loadsBySession.get(sessionId) === load) loadsBySession.delete(sessionId);
	});
	loadsBySession.set(sessionId, load);
	return load;
}

export function clearAskQuestionDismissals(sessionId: string): void {
	dismissalsBySession.delete(sessionId);
	loadsBySession.delete(sessionId);
}

export async function dismissAskQuestion(sessionId: string, toolUseId: string): Promise<void> {
	if (!sessionId || !toolUseId) throw new Error("Question identity is unavailable");
	const response = await gatewayFetch(gatewayRoute("/api/internal/user-question/dismiss"), {
		method: "POST",
		body: JSON.stringify({ sessionId, toolUseId }),
	});
	if (!response.ok) {
		let message = `Failed to dismiss question (HTTP ${response.status})`;
		try {
			const body = await response.json();
			if (typeof body?.error === "string" && body.error) message = body.error;
		} catch { /* retain the status-based message */ }
		throw new Error(message);
	}
	applyAskQuestionDismissed(sessionId, toolUseId);
}

/** Test-only cache reset; deliberately not used by production lifecycle code. */
export function resetAskDismissalsForTests(): void {
	dismissalsBySession.clear();
	loadsBySession.clear();
}
