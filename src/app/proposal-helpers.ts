/**
 * Unified per-type proposal-draft and dismissal-fingerprint helpers.
 *
 * Generalises the goal-proposal-only helpers in `session-manager.ts`
 * (`isProposalDismissed` / `markProposalDismissed` / `clearProposalDismissed`
 * + the `goalDraft` / `projectDraft` / `roleDraft` `createDraftManager`
 * instances) over the full `ProposalType` union.
 *
 * Slice D ships this file as additive infrastructure. Slice E swaps the
 * legacy per-type helpers' call sites over to it.
 *
 * Storage:
 *   - dismissal fingerprint → `localStorage["bobbit-${type}-proposal-dismissed-${sessionId}"]`
 *   - draft body            → server-side draft table via `saveDraftToServer(sessionId, "${type}-proposal", ...)`
 *
 * Migration: on first read for `goal`, the legacy key
 * `bobbit-goal-proposal-dismissed-<sid>` (which used the same value format)
 * already lives at exactly the new key. The `goal` type therefore needs no
 * key migration — the new schema is byte-compatible. We still gate on a
 * one-shot migration flag so a future schema change has a place to hook in.
 */

import type { ProposalType } from "./proposal-registry.js";

// Mirror of the gateway-localStorage keys defined in `state.ts`. We can't
// import them from there because state.ts touches `localStorage` at
// module-load (browser-only), and we want this file unit-testable in node
// without elaborate global shims. If state.ts ever changes these keys,
// keep them in sync here — covered by the helper unit test using these
// exact strings.
const GW_URL_KEY = "gateway.url";
const GW_TOKEN_KEY = "gateway.token";

// We DO NOT import from `./api.js` here. The full api.js dep graph reaches
// `state.ts` at module-load (touches `localStorage`) and on through
// session-manager / render-helpers / lit, which is fine in the browser but
// blows up in node-only unit tests. The three draft endpoints we need are
// trivial; we duplicate them locally and keep this module browser+node
// safe. (`api.ts`'s `saveDraftToServer` etc remain the canonical impl for
// the rest of the app and are not removed.)
function draftFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const url = (typeof localStorage !== "undefined" && localStorage.getItem(GW_URL_KEY))
		|| (typeof window !== "undefined" ? window.location.origin : "");
	const token = (typeof localStorage !== "undefined" && localStorage.getItem(GW_TOKEN_KEY)) || "";
	return fetch(`${url}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(init.headers as Record<string, string> | undefined),
		},
	});
}

// ---- Dismissal fingerprint ----

function dismissalKey(sessionId: string, type: ProposalType): string {
	return `bobbit-${type}-proposal-dismissed-${sessionId}`;
}

const goalLegacyMigrated = new Set<string>();

/** One-shot legacy-key migration for the goal type. The new schema's storage
 *  key happens to equal the legacy `bobbit-goal-proposal-dismissed-<sid>` key
 *  byte-for-byte, so this is a no-op except as a documentation hook for any
 *  future schema bump. Idempotent and side-effect-free. */
function migrateLegacyDismissalKeyIfGoal(sessionId: string, type: ProposalType): void {
	if (type !== "goal") return;
	if (goalLegacyMigrated.has(sessionId)) return;
	goalLegacyMigrated.add(sessionId);
	// The legacy key (`bobbit-goal-proposal-dismissed-<sid>`) is identical to
	// the new schema's key for the `goal` type. Nothing to copy. If a future
	// change splits the namespaces, the legacy → new copy lives here.
}

/**
 * Stable, content-only fingerprint for the dismissed-proposal check.
 * `JSON.stringify` over the sorted keys of the field bag — sufficient for
 * "the user dismissed this exact proposal text" matching across reloads.
 */
function fingerprint(fields: Record<string, unknown>): string {
	try {
		const keys = Object.keys(fields).sort();
		const ordered: Record<string, unknown> = {};
		for (const k of keys) ordered[k] = fields[k];
		return JSON.stringify(ordered);
	} catch {
		return "";
	}
}

export function isProposalDismissed(
	sessionId: string,
	type: ProposalType,
	fields: Record<string, unknown>,
): boolean {
	migrateLegacyDismissalKeyIfGoal(sessionId, type);
	try {
		const stored = localStorage.getItem(dismissalKey(sessionId, type));
		if (!stored) return false;
		return stored === fingerprint(fields);
	} catch {
		return false;
	}
}

export function markProposalDismissed(
	sessionId: string,
	type: ProposalType,
	fields: Record<string, unknown>,
): void {
	migrateLegacyDismissalKeyIfGoal(sessionId, type);
	try {
		localStorage.setItem(dismissalKey(sessionId, type), fingerprint(fields));
	} catch {
		/* ignore quota errors */
	}
}

export function clearProposalDismissed(sessionId: string, type: ProposalType): void {
	migrateLegacyDismissalKeyIfGoal(sessionId, type);
	try {
		localStorage.removeItem(dismissalKey(sessionId, type));
	} catch {
		/* ignore */
	}
}

// ---- Draft persistence (debounced server write) ----

/**
 * Generic debounced draft manager parametrised by `(sessionId, type)`. One
 * instance keyed off the type so all six types share the same debounce
 * timer slot per type — mirrors the existing `createDraftManager` pattern
 * in `session-manager.ts` but parametric over the type.
 *
 * The `serialize` / `restore` callbacks are owned by Slice E (which knows
 * what to mirror into / out of state for each type). For Slice D we expose
 * a primitive (sid, type, body) → server-store API so the new files don't
 * need session-manager state knowledge.
 */
const debounceTimers: Partial<Record<ProposalType, ReturnType<typeof setTimeout>>> = {};
const DEBOUNCE_MS = 300;

const draftType = (type: ProposalType): string => `${type}-proposal`;

/**
 * Save an opaque draft body for a given (sessionId, type). The caller
 * owns the body shape — Slice E plugs each type's serializer in.
 */
export function saveProposalDraft(
	sessionId: string,
	type: ProposalType,
	body: unknown,
): void {
	const t = debounceTimers[type];
	if (t) clearTimeout(t);
	debounceTimers[type] = setTimeout(() => {
		debounceTimers[type] = undefined;
		void draftFetch(`/api/sessions/${sessionId}/draft`, {
			method: "PUT",
			body: JSON.stringify({ type: draftType(type), data: body }),
		}).catch((err) => {
			if (err instanceof DOMException && err.name === "AbortError") return;
			console.error(`[${type}-proposal-draft] Failed to save draft:`, err);
		});
	}, DEBOUNCE_MS);
}

/**
 * Load the persisted draft body for (sessionId, type). Returns `null` when
 * the server has no draft. The caller is responsible for shape validation.
 */
export async function loadProposalDraft(
	sessionId: string,
	type: ProposalType,
): Promise<unknown | null> {
	try {
		const res = await draftFetch(
			`/api/sessions/${sessionId}/draft?type=${encodeURIComponent(draftType(type))}`,
		);
		if (!res.ok) return null;
		const body = (await res.json()) as { data?: unknown };
		return body.data ?? null;
	} catch (err) {
		console.error(`[${type}-proposal-draft] Failed to load draft:`, err);
		return null;
	}
}

/**
 * Delete the on-disk proposal FILE for (sessionId, type) on the server.
 * Distinct from `deleteProposalDraft` (which targets the per-session draft
 * table). The proposal file is the source of truth for the editable
 * proposals feature; called from accept paths so the file disappears once
 * the user has committed the proposal. The server broadcasts
 * `proposal_cleared` which the unified onProposal callback handles for the
 * in-memory state cleanup. 404 is silently ignored — the file may already
 * have been removed by a prior accept or session archive.
 */
export function deleteProposalFile(sessionId: string, type: ProposalType): Promise<void> {
	return draftFetch(`/api/sessions/${sessionId}/proposal/${type}`, { method: "DELETE" })
		.then(() => undefined)
		.catch((err) => {
			if (err instanceof DOMException && err.name === "AbortError") return;
			console.error(`[${type}-proposal-file] Failed to delete proposal file:`, err);
		});
}

/** Delete the persisted draft for (sessionId, type) and cancel any pending save. */
export function deleteProposalDraft(sessionId: string, type: ProposalType): void {
	const t = debounceTimers[type];
	if (t) {
		clearTimeout(t);
		debounceTimers[type] = undefined;
	}
	void draftFetch(
		`/api/sessions/${sessionId}/draft?type=${encodeURIComponent(draftType(type))}`,
		{ method: "DELETE" },
	).catch((err) => {
		console.error(`[${type}-proposal-draft] Failed to delete draft:`, err);
	});
}

/** Test-only helper. Cancels every pending debounced save without flushing. */
export function _cancelAllPendingProposalDraftSaves(): void {
	for (const k of Object.keys(debounceTimers) as ProposalType[]) {
		const t = debounceTimers[k];
		if (t) clearTimeout(t);
		debounceTimers[k] = undefined;
	}
	goalLegacyMigrated.clear();
}
