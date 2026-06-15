/**
 * inbox-panel.ts — per-session inbox subscription lifecycle.
 *
 * Mirrors src/app/preview-panel.ts. The inbox panel surfaces a staff
 * agent's persisted work queue (pending + recent terminal entries).
 *
 * Lifecycle:
 *   - On session select with `session.staffId` set, `startInboxSubscription`
 *     is called: bootstrap fetches GET /api/staff/:id/inbox?state=pending
 *     and ?state=completed&limit=100, merges into `state.inboxEntries`.
 *     It does not create a side-panel tab; closed inbox tabs stay closed until
 *     the user explicitly reopens them.
 *   - WS events `inbox.entry.added` / `updated` / `removed` are routed
 *     into this module's callbacks by `remote-agent.ts` and mutate the
 *     local entry list.
 *   - On session switch / non-staff session, `stopInboxSubscription` clears
 *     the active subscription and resets state.
 *
 * Persistence: there is no SSE here — the gateway WebSocket already carries
 * the events. The "subscription" is therefore just a pair of (staffId, sid)
 * pointers + a bootstrap fetch.
 */

import { state, renderApp } from "./state.js";
import { getSidePanelWorkspace, openSidePanelTab } from "./side-panel-workspace.js";
import { INBOX_PANEL_TAB_ID } from "./panel-workspace.js";
import type { InboxEntry } from "../server/agent/inbox-store.js";

let currentSid: string | null = null;
let currentStaffId: string | null = null;
let bootstrapToken = 0;

/**
 * Begin tracking inbox entries for the given staff session. The session
 * must belong to a staff agent — the caller is responsible for the
 * staffId lookup (typically via `gatewaySessions.find(...)`).
 */
export function startInboxSubscription(sessionId: string, staffId: string): void {
	stopInboxSubscription();
	currentSid = sessionId;
	currentStaffId = staffId;
	state.inboxPanelOpen = getSidePanelWorkspace(sessionId).tabs.some((tab) => tab.id === INBOX_PANEL_TAB_ID && tab.kind === "inbox");
	state.inboxEntries = [];
	const token = ++bootstrapToken;

	void (async () => {
		try {
			const pendingResp = await fetch(
				`/api/staff/${encodeURIComponent(staffId)}/inbox?state=pending`,
				{ credentials: "include" },
			);
			if (!pendingResp.ok) return;
			if (token !== bootstrapToken) return;          // session switched mid-flight
			const pendingData = await pendingResp.json();

			const completedResp = await fetch(
				`/api/staff/${encodeURIComponent(staffId)}/inbox?state=completed&limit=100`,
				{ credentials: "include" },
			);
			if (token !== bootstrapToken) return;
			const completedData = completedResp.ok ? await completedResp.json() : { entries: [] };

			// Many terminal states are interesting in History — try to fetch
			// failed/cancelled too if the API supports it. Best-effort.
			const failedResp = await fetch(
				`/api/staff/${encodeURIComponent(staffId)}/inbox?state=failed&limit=100`,
				{ credentials: "include" },
			).catch(() => null);
			const cancelledResp = await fetch(
				`/api/staff/${encodeURIComponent(staffId)}/inbox?state=cancelled&limit=100`,
				{ credentials: "include" },
			).catch(() => null);
			if (token !== bootstrapToken) return;
			const failedEntries = failedResp && failedResp.ok ? ((await failedResp.json()).entries || []) : [];
			const cancelledEntries = cancelledResp && cancelledResp.ok ? ((await cancelledResp.json()).entries || []) : [];

			const merged: InboxEntry[] = [
				...((pendingData.entries as InboxEntry[]) || []),
				...((completedData.entries as InboxEntry[]) || []),
				...(failedEntries as InboxEntry[]),
				...(cancelledEntries as InboxEntry[]),
			];
			// Dedupe by id (preserves first occurrence — pending wins over historical
			// in the unlikely case the server returns the same entry twice).
			const byId = new Map<string, InboxEntry>();
			for (const e of merged) if (!byId.has(e.id)) byId.set(e.id, e);
			state.inboxEntries = [...byId.values()];
			renderApp();
		} catch {
			/* bootstrap failures are non-fatal; live WS will catch up */
		}
	})();
}

export function openInboxPanel(sessionId: string = currentSid || "", staffId: string = currentStaffId || ""): void {
	if (!sessionId || !staffId) return;
	state.inboxPanelOpen = true;
	void openSidePanelTab({
		id: INBOX_PANEL_TAB_ID,
		kind: "inbox",
		title: "Inbox",
		label: "Inbox",
		source: { type: "inbox", sessionId, staffId },
		updatedAt: Date.now(),
	}, { focus: true });
	renderApp();
}

/** Tear down the current subscription. Clears local state. */
export function stopInboxSubscription(): void {
	bootstrapToken++;
	currentSid = null;
	currentStaffId = null;
	state.inboxPanelOpen = false;
	state.inboxAddDialogOpen = false;
	state.inboxEntries = [];
}

/** Currently subscribed staff id, or null. Used by WS handlers to filter events. */
export function activeInboxStaffId(): string | null {
	return currentStaffId;
}

/** Currently subscribed session id, or null. */
export function activeInboxSessionId(): string | null {
	return currentSid;
}

/**
 * Apply an `inbox.entry.added` WS event. No-op if the event is for a
 * different staff than the currently subscribed one.
 */
export function applyEntryAdded(staffId: string, entry: InboxEntry): void {
	if (currentStaffId !== staffId) return;
	const existing = state.inboxEntries.findIndex((e) => e.id === entry.id);
	if (existing >= 0) {
		state.inboxEntries = [...state.inboxEntries.slice(0, existing), entry, ...state.inboxEntries.slice(existing + 1)];
	} else {
		state.inboxEntries = [...state.inboxEntries, entry];
	}
	renderApp();
}

/** Apply an `inbox.entry.updated` WS event. */
export function applyEntryUpdated(staffId: string, entry: InboxEntry): void {
	if (currentStaffId !== staffId) return;
	const idx = state.inboxEntries.findIndex((e) => e.id === entry.id);
	if (idx >= 0) {
		state.inboxEntries = [...state.inboxEntries.slice(0, idx), entry, ...state.inboxEntries.slice(idx + 1)];
	} else {
		// Unknown id — treat as added (live-late case).
		state.inboxEntries = [...state.inboxEntries, entry];
	}
	renderApp();
}

/** Apply an `inbox.entry.removed` WS event. */
export function applyEntryRemoved(staffId: string, entryId: string): void {
	if (currentStaffId !== staffId) return;
	const before = state.inboxEntries.length;
	state.inboxEntries = state.inboxEntries.filter((e) => e.id !== entryId);
	if (state.inboxEntries.length !== before) renderApp();
}
