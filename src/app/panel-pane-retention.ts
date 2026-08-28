// Retention policy for side-panel panes (design: docs/design/keep-side-panels-mounted.md §4).
//
// Pure policy unit: no DOM, no app state imports. The render pass supplies the active
// key and a `resolve` callback that reports liveness, and receives back the slots to
// render in STABLE INSERTION ORDER — insertion order IS DOM order, so a retained
// <iframe> never moves and therefore never re-navigates.

/** Retained panes including the active one. Active + 2 hidden. */
export const PANEL_PANE_RETENTION_LIMIT = 3;

const KEY_SEPARATOR = "\u0000";

/** `${sessionKey}\u0000${tabId}` — sessionKey from panelWorkspaceSessionKey(). */
export function panePaneKey(sessionKey: string, tabId: string): string {
	return `${sessionKey}${KEY_SEPARATOR}${tabId}`;
}

export function parsePanePaneKey(key: string): { sessionKey: string; tabId: string } | undefined {
	const separator = key.indexOf(KEY_SEPARATOR);
	if (separator < 0) return undefined;
	const sessionKey = key.slice(0, separator);
	const tabId = key.slice(separator + KEY_SEPARATOR.length);
	if (!tabId || tabId.includes(KEY_SEPARATOR)) return undefined;
	return { sessionKey, tabId };
}

export interface RetainedPaneSlot<T> {
	key: string;
	sessionKey: string;
	tab: T;
	hidden: boolean;
}

/** Append-only; insertion order = DOM order. Never derived from tab order or recency. */
let order: string[] = [];
/** Recency, used only to pick an eviction victim. */
let lastActiveAt = new Map<string, number>();
let tick = 0;

/**
 * Resolve → prune dead keys → touch `activeKey` → evict beyond the limit
 * (least-recently-active first, never the active key). Returns survivors in
 * STABLE INSERTION ORDER. The ONLY mutator of retention state, called at most
 * once per render (§3.4).
 */
export function retainedPanePlan<T>(input: {
	activeKey?: string;
	/**
	 * Keys whose panes the caller ALREADY has mounted, even though they are not
	 * the active pane, so retention must observe them or they are destroyed on
	 * the next session switch.
	 *
	 * The mobile active track mounts the chat pane plus EVERY content tab of the
	 * selected session, so an open-but-inactive pack tab already has a live
	 * <iframe>. Without this input such a pane never enters the plan, a hidden
	 * foreign track (which projects only the plan's slots) drops it, and the
	 * feature would retain LESS than the slider already had mounted — well below
	 * the limit.
	 *
	 * Appended after `activeKey` in the given order, and they do NOT touch
	 * recency: only `activeKey` does, so an observed-but-inactive pane is the
	 * first eviction victim once the limit is exceeded.
	 */
	observedKeys?: readonly string[];
	resolve: (key: string) => T | undefined;
	limit?: number;
}): RetainedPaneSlot<T>[] {
	const { activeKey, observedKeys, resolve } = input;
	const limit = Math.max(1, input.limit ?? PANEL_PANE_RETENTION_LIMIT);

	// 1. Append the active key, then any already-mounted observed key, if they are
	//    not already tracked (append-only: insertion order IS DOM order).
	if (activeKey !== undefined && !order.includes(activeKey)) order.push(activeKey);
	if (observedKeys) for (const key of observedKeys) if (!order.includes(key)) order.push(key);

	// 2. Resolve every tracked key; drop anything that is no longer live.
	const resolved = new Map<string, T>();
	const survivors: string[] = [];
	for (const key of order) {
		const tab = resolve(key);
		if (tab === undefined) {
			lastActiveAt.delete(key);
			continue;
		}
		resolved.set(key, tab);
		survivors.push(key);
	}

	// 3. Touch the active key's recency stamp.
	if (activeKey !== undefined && resolved.has(activeKey)) lastActiveAt.set(activeKey, ++tick);

	// 4. Evict least-recently-active survivors beyond the limit, never the active key.
	while (survivors.length > limit) {
		let victim: string | undefined;
		let victimStamp = Number.POSITIVE_INFINITY;
		for (const key of survivors) {
			if (key === activeKey) continue;
			const stamp = lastActiveAt.get(key) ?? 0;
			if (stamp < victimStamp) {
				victim = key;
				victimStamp = stamp;
			}
		}
		if (victim === undefined) break;
		survivors.splice(survivors.indexOf(victim), 1);
		resolved.delete(victim);
		lastActiveAt.delete(victim);
	}

	order = survivors;

	// 5. Project survivors in insertion order.
	return survivors.map((key) => {
		const parsed = parsePanePaneKey(key);
		return {
			key,
			sessionKey: parsed?.sessionKey ?? "",
			tab: resolved.get(key) as T,
			hidden: key !== activeKey,
		};
	});
}

/** Tests / desktop↔mobile viewport flip: policy state must never outlive the DOM it describes. */
export function resetPanelPaneRetention(): void {
	order = [];
	lastActiveAt = new Map();
	tick = 0;
}
