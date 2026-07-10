/**
 * Client-side cache of the "is this session a git repo?" determination.
 *
 * Pure, `localStorage`-backed, and DI-safe (tolerates absent/broken storage so
 * it works under SSR and in tests without a DOM). Keyed by session id, this is
 * a *hint* used to avoid the visible "Checking git…" skeleton flash on every
 * connect/reload of a git-less session — it is never authoritative. The connect
 * path always fires a quiet background recheck that corrects the state (see
 * `computeConnectGitState` + `session-manager.ts::refreshGitStatusForSession`).
 *
 * See docs/design/git-status-widget-reliability.md and the reproducing tests
 * `tests2/core/git-repo-cache.test.ts` / `git-empty-widget-cache.test.ts`
 * which pin this module's contract.
 */

export type RepoState = "yes" | "no" | "hidden";

/** Single localStorage key holding `{ [sessionId]: 'yes'|'no'|'hidden' }`. */
const CACHE_KEY = "bobbit.gitRepoCache";

/** Upper bound on cached entries so the map cannot grow unbounded. */
const MAX_ENTRIES = 200;

export interface ConnectGitState {
	gitRepoKnown: "yes" | "no" | "hidden" | "unknown";
	quietRecheck: boolean;
}

/** Best-effort handle to localStorage. Returns undefined when unavailable. */
function storage(): Storage | undefined {
	try {
		const ls = (globalThis as { localStorage?: Storage }).localStorage;
		return ls ?? undefined;
	} catch {
		return undefined;
	}
}

/** Read + parse the cache map. Broken/absent storage → empty object. */
function readCache(): Record<string, RepoState> {
	const ls = storage();
	if (!ls) return {};
	try {
		const raw = ls.getItem(CACHE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		const out: Record<string, RepoState> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (v === "yes" || v === "no" || v === "hidden") out[k] = v;
		}
		return out;
	} catch {
		return {};
	}
}

/** Persist the cache map. Silently no-ops when storage is unavailable. */
function writeCache(map: Record<string, RepoState>): void {
	const ls = storage();
	if (!ls) return;
	try {
		ls.setItem(CACHE_KEY, JSON.stringify(map));
	} catch {
		/* quota / unavailable — best-effort */
	}
}

export function getCachedRepoState(sessionId: string): RepoState | undefined {
	return readCache()[sessionId];
}

export function setCachedRepoState(sessionId: string, state: RepoState): void {
	const map = readCache();
	// Re-insert at the end so this becomes the most-recently-written entry
	// (JS objects preserve string-key insertion order); this lets the cap drop
	// the oldest entries while preserving fresh ones.
	delete map[sessionId];
	map[sessionId] = state;
	const keys = Object.keys(map);
	if (keys.length > MAX_ENTRIES) {
		const excess = keys.length - MAX_ENTRIES;
		for (let i = 0; i < excess; i++) delete map[keys[i]];
	}
	writeCache(map);
}

/** Drop any cached entry whose session id is not in the live set. */
export function pruneGitRepoCache(liveSessionIds: Iterable<string>): void {
	const live = new Set(liveSessionIds);
	const map = readCache();
	let changed = false;
	for (const id of Object.keys(map)) {
		if (!live.has(id)) {
			delete map[id];
			changed = true;
		}
	}
	if (changed) writeCache(map);
}

/**
 * Decide the initial `gitRepoKnown` state (and whether the recheck should be
 * quiet) for a session about to connect:
 *   cached 'no'            → start 'no' + quiet recheck (no skeleton/loading)
 *   cached 'hidden'        → start hidden + quiet recheck (no skeleton/loading)
 *   cached 'yes' | no entry→ start 'unknown', normal check (skeleton allowed)
 */
export function computeConnectGitState(sessionId: string): ConnectGitState {
	const cached = getCachedRepoState(sessionId);
	if (cached === "no" || cached === "hidden") {
		return { gitRepoKnown: cached, quietRecheck: true };
	}
	return { gitRepoKnown: "unknown", quietRecheck: false };
}
