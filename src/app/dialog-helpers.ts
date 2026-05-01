/**
 * Pure helpers for the New Goal dialog.
 *
 * Kept in a standalone module so the predicates can be unit-tested via the
 * Node test runner without bundling Lit / DOM dependencies. See
 * `docs/design/nested-goals.md` §10.4 + §14.2.
 */

import { parseAcceptanceCriteria } from "../shared/acceptance-criteria.js";

/**
 * Returns `true` if a goal spec looks like a multi-phase / multi-version
 * delivery program for which the `parent` workflow is the better default.
 *
 * Three independent signals — any one is sufficient:
 *
 *   1. `spec.length > 5000`
 *   2. `/v0\.\d|v\d\.\d|phase\s*\d|milestone/i.test(spec)`
 *   3. `parseAcceptanceCriteria(spec).length >= 5`
 *
 * The predicate is **suggestion-only** — the New Goal dialog never auto-
 * selects the `parent` workflow; it surfaces a non-blocking banner the
 * user can accept or dismiss.
 */
export function isMultiPhaseSpec(spec: string): boolean {
	if (!spec || typeof spec !== "string") return false;
	if (spec.length > 5000) return true;
	if (/v0\.\d|v\d\.\d|phase\s*\d|milestone/i.test(spec)) return true;
	if (parseAcceptanceCriteria(spec).length >= 5) return true;
	return false;
}

/**
 * Per-project localStorage key for the multi-phase suggestion banner's
 * "Keep current" dismissal. Sessions in the same project share the
 * dismissal; new projects re-show the banner.
 */
export function multiPhaseBannerDismissedKey(projectId: string): string {
	return `bobbit-multiphase-banner-dismissed-${projectId}`;
}

/**
 * Returns `true` if the user has dismissed the multi-phase banner for the
 * given project. Safe under privacy modes that disable storage.
 */
export function isMultiPhaseBannerDismissed(projectId: string): boolean {
	try {
		return localStorage.getItem(multiPhaseBannerDismissedKey(projectId)) === "1";
	} catch {
		return false;
	}
}

/**
 * Persist a "Keep current" dismissal of the multi-phase suggestion banner
 * for the given project. Idempotent.
 */
export function dismissMultiPhaseBanner(projectId: string): void {
	try {
		localStorage.setItem(multiPhaseBannerDismissedKey(projectId), "1");
	} catch {
		/* storage unavailable — banner stays open this session, no harm */
	}
}

/**
 * Coerce a desired workflow id against the project's actual workflow list.
 *
 * Rationale: brand-new projects (post commit `864ae63d` — #413 "No default
 * workflow scaffold") may have any subset of workflows. The proposal
 * panel + New Goal dialog historically defaulted `workflowId` to
 * `"general"` or `"feature"` without checking whether the project actually
 * has those, leading to opaque `400 Failed to create goal` toasts on
 * Accept. This helper normalises the resolution rule used at every entry
 * point:
 *
 *   - **No workflows at all** (`available.length === 0`) → returns the
 *     preferred id unchanged. Callers MUST treat zero-workflows as a
 *     hard block (Create button disabled with a clear error). The helper
 *     does not synthesise a non-existent id; it simply doesn't have
 *     anywhere safe to coerce to.
 *   - **Preferred id is in the list** → returns it unchanged.
 *   - **Preferred id is missing but workflows exist** → returns
 *     `available[0].id`. Server-side ordering is stable per project
 *     config; an alphabetical fallback is not imposed here because the
 *     server may surface workflows in a meaningful order.
 *
 * Pure: no side effects, no localStorage, no DOM access.
 */
export function coerceWorkflowId(
	preferred: string,
	available: ReadonlyArray<{ id: string }>,
): string {
	if (available.length === 0) return preferred;
	if (available.some((w) => w.id === preferred)) return preferred;
	return available[0].id;
}

/**
 * Format an HTTP error response from a JSON-bodied gateway endpoint into
 * a user-visible message that includes the server's actual error text
 * when present.
 *
 * Used by `createGoal()` and similar API helpers so the user sees
 * `"Failed to create goal: 400 — Workflow not found: general"` instead
 * of the bare `"Failed to create goal: 400"`.
 *
 * Resolution rule:
 *   - Body is JSON with `{ error: string }`     → "<prefix>: <status> — <error>"
 *   - Body is JSON without `error` field        → "<prefix>: <status> — <stringified body>"
 *   - Body is non-JSON / unreadable             → "<prefix>: <status>"
 *
 * Pure: takes the parsed body (or undefined) and the status; the caller
 * is responsible for awaiting `res.json()` in a try/catch and passing
 * the result. This keeps the helper trivially unit-testable without
 * mocking `fetch` or `Response`.
 */
export function formatGatewayError(
	prefix: string,
	status: number,
	body: unknown,
): string {
	if (body === undefined || body === null) return `${prefix}: ${status}`;
	if (typeof body === "object") {
		const rec = body as Record<string, unknown>;
		if (typeof rec.error === "string" && rec.error.length > 0) {
			return `${prefix}: ${status} — ${rec.error}`;
		}
		// If the only field is `error` and it's empty/non-string, treat the
		// body as carrying no useful info — fall back to bare prefix:status
		// rather than `— {"error":""}`.
		const keys = Object.keys(rec);
		if (keys.length === 1 && keys[0] === "error") {
			return `${prefix}: ${status}`;
		}
		try {
			const json = JSON.stringify(body);
			if (json && json !== "{}") return `${prefix}: ${status} — ${json}`;
		} catch { /* circular ref — fall through */ }
	}
	return `${prefix}: ${status}`;
}
