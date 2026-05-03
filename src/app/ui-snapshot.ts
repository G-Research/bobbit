/**
 * UI snapshot persistence — Stream A of the production-grade PWA resume fix.
 *
 * Goal: persist enough of the *last-rendered* UI into localStorage so that
 * cold launches (including iOS PWA snapshot restore) can paint the previous
 * view in the first frame, before any network call resolves. The freshly
 * arriving server state is then merged in via the existing
 * `message-reducer.ts` `"snapshot"` action — we never bypass the reducer
 * survivor filter / dedup tiers.
 *
 * Two layers:
 *   • Low-level (used by unit tests):
 *     - `serialize(state, { storage, key })` — writes a state-shaped object
 *       verbatim with per-session message arrays trimmed to the last 200
 *       (LRU tail-preserve), then byte-budgeted to ≤ 512 KB.
 *     - `hydrate({ storage, key })` — reads it back. Returns null on miss
 *       or version mismatch.
 *
 *   • High-level (used by the app bootstrap):
 *     - `saveSnapshot()`  — projects from `app/state.ts` into the canonical
 *                           payload (§6.1) and writes it to `localStorage`.
 *     - `loadSnapshot()`  — reverse, with permissive validation. Cold-start
 *                           safe: returns null if no snapshot, version
 *                           mismatch, or any error.
 *     - `scheduleSave()`  — debounced (~500 ms, idle-callback if available)
 *                           wrapper around `saveSnapshot`.
 *
 * Constraints honoured:
 *   • `BOBBIT_E2E=1` → high-level writers (`saveSnapshot`, `scheduleSave`)
 *     no-op, so tests aren't polluted by stale localStorage between runs.
 *     The low-level `serialize`/`hydrate` are unaffected (tests pass storage
 *     explicitly; e2e fixtures pre-seed localStorage manually).
 *   • Every code path is wrapped in `try/catch` and degrades silently —
 *     localStorage may be disabled, full, or cross-origin-restricted in
 *     some PWA modes.
 *   • Snapshot persistence MUST NOT bypass the reducer ordering invariant:
 *     hydrated `messages` are dispatched as `{ type: "snapshot", messages }`
 *     by the bootstrap, never pushed directly into `state.messages`.
 */

const SNAPSHOT_VERSION = 1;
const STORAGE_KEY = "bobbit.ui-snapshot.v1";
const MESSAGE_LRU_CAP = 200;
const BYTE_BUDGET = 512_000;
const DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// E2E gate
// ---------------------------------------------------------------------------

function isE2EAutoSaveDisabled(): boolean {
	try {
		if (typeof window !== "undefined" && (window as any).__bobbitE2E === true) return true;
		// Vite-injected env (build-time) — `import.meta.env.BOBBIT_E2E === "1"`
		// when test harness sets it. Wrap in try because some bundlers strip
		// `import.meta` outside ESM contexts.
		// @ts-ignore — `import.meta.env` is bundler-augmented.
		const env = (typeof import.meta !== "undefined" && (import.meta as any).env) || {};
		if (env.BOBBIT_E2E === "1" || env.MODE === "test") return true;
	} catch { /* ignore */ }
	return false;
}

// ---------------------------------------------------------------------------
// Low-level: serialize / hydrate (storage-agnostic, used by unit tests)
// ---------------------------------------------------------------------------

interface IoOpts {
	storage: Storage;
	key?: string;
}

/** Trim per-session message arrays to the last `cap` entries, preserving the tail. */
function trimMessages<T extends Record<string, any>>(state: T, cap: number): T {
	const out: any = { ...state };
	if (out.activeSession && Array.isArray(out.activeSession.messages)) {
		out.activeSession = {
			...out.activeSession,
			messages: out.activeSession.messages.slice(-cap),
		};
	}
	if (Array.isArray(out.messages)) {
		out.messages = out.messages.slice(-cap);
	}
	if (out.sessions && typeof out.sessions === "object") {
		const trimmedSessions: Record<string, any> = {};
		for (const [sid, sess] of Object.entries(out.sessions)) {
			if (sess && typeof sess === "object" && Array.isArray((sess as any).messages)) {
				trimmedSessions[sid] = { ...(sess as any), messages: (sess as any).messages.slice(-cap) };
			} else {
				trimmedSessions[sid] = sess;
			}
		}
		out.sessions = trimmedSessions;
	}
	return out as T;
}

/** Strip large/non-essential side-tables in priority order if over budget. */
function fitToBudget(payload: any): { payload: any; json: string } | null {
	let working = payload;
	let json = "";
	const sizes = [MESSAGE_LRU_CAP, 100, 50, 0];
	for (const cap of sizes) {
		working = trimMessages(payload, cap);
		try { json = JSON.stringify(working); } catch { return null; }
		if (json.length <= BYTE_BUDGET) return { payload: working, json };
	}
	// Still over budget — drop archivedSessions (sidebar can re-fetch on demand).
	if (working.archivedSessions && Array.isArray(working.archivedSessions)) {
		working = { ...working, archivedSessions: [] };
		try { json = JSON.stringify(working); } catch { return null; }
		if (json.length <= BYTE_BUDGET) return { payload: working, json };
	}
	// Give up — caller should skip-persist rather than throw.
	return null;
}

/**
 * Serialize a state-shaped object into the given storage.
 *
 * Test-friendly: takes (state, { storage, key? }). Writes a raw JSON blob
 * (no envelope) under `key`. Per-session message arrays are trimmed to the
 * last 200, total payload capped at ~512 KB.
 */
export function serialize(state: Record<string, any>, opts: IoOpts): boolean {
	if (!opts || !opts.storage) return false;
	const key = opts.key || STORAGE_KEY;
	try {
		const fitted = fitToBudget(state);
		if (!fitted) return false; // skip-persist on overrun
		const wrapped = { ...fitted.payload, v: SNAPSHOT_VERSION };
		opts.storage.setItem(key, JSON.stringify(wrapped));
		return true;
	} catch {
		// localStorage disabled / quota exceeded / serialisation cycle — silent.
		return false;
	}
}

/**
 * Hydrate a state-shaped object from storage. Returns null on miss, version
 * mismatch, or any parse/IO error.
 *
 * Supports two payload shapes (returns the raw parsed object either way; the
 * `activeSession` accessor below normalises both):
 *   1. Canonical (written by `buildPayload()` here):
 *        { activeSession: { id, messages, ... } }
 *   2. Legacy / E2E test-fixture:
 *        { sessions: { [id]: { messages, ... } }, selectedSessionId }
 */
export function hydrate(opts: IoOpts): Record<string, any> | null {
	if (!opts || !opts.storage) return null;
	const key = opts.key || STORAGE_KEY;
	try {
		const raw = opts.storage.getItem(key);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		// Permissive version check: accept missing `v` (legacy raw payload) or
		// matching `v: 1`. Reject explicit version mismatches.
		const v = (parsed as any).v;
		if (v !== undefined && v !== SNAPSHOT_VERSION) return null;
		return parsed;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// High-level: project from app `state` → localStorage with debounce
// ---------------------------------------------------------------------------

/** Build the canonical first-paint payload from the live app state. */
function buildPayload(state: any): Record<string, any> {
	const activeId = state.selectedSessionId || state.remoteAgent?.gatewaySessionId || null;
	let activeSession: any = null;
	if (activeId && state.remoteAgent && state.remoteAgent.gatewaySessionId === activeId) {
		const remote = state.remoteAgent;
		const session = state.gatewaySessions?.find?.((s: any) => s.id === activeId)
			|| state.archivedSessions?.find?.((s: any) => s.id === activeId);
		// Reducer-owned messages live on remoteAgent's `_state.messages`. Fall
		// back to anything resembling a messages array so we degrade rather
		// than crash if the internal shape evolves.
		const messages = (remote._state?.messages as any[] | undefined)
			|| (remote.state?.messages as any[] | undefined)
			|| [];
		const pending = (remote._state?.pendingToolCalls as any[] | undefined)
			|| (remote.state?.pendingToolCalls as any[] | undefined)
			|| [];
		activeSession = {
			id: activeId,
			title: session?.title ?? "",
			model: remote.model ? `${remote.model.provider}/${remote.model.id}` : null,
			connectionStatus: state.connectionStatus,
			messages,
			pendingToolCalls: pending,
			scrollTop: 0,
		};
	}

	const archivedSessions = Array.isArray(state.archivedSessions)
		? state.archivedSessions.slice(0, 50)
		: [];

	const route = (typeof window !== "undefined" && window.location?.hash) || "";

	return {
		v: SNAPSHOT_VERSION,
		savedAt: Date.now(),
		gatewayUrl: typeof localStorage !== "undefined" ? localStorage.getItem("gateway.url") : null,
		projects: Array.isArray(state.projects) ? state.projects : [],
		activeProjectId: state.activeProjectId ?? null,
		goals: Array.isArray(state.goals) ? state.goals : [],
		archivedSessions,
		selectedSessionId: state.selectedSessionId ?? null,
		hashRoute: route,
		activeSession,
		prefs: {
			sidebarCollapsed: !!state.sidebarCollapsed,
			showArchived: !!state.showArchived,
			palette: typeof localStorage !== "undefined" ? localStorage.getItem("palette") : null,
			showTimestamps:
				typeof document !== "undefined"
					? document.documentElement.dataset.showTimestamps === "true"
					: false,
			playAgentFinishSound:
				typeof document !== "undefined"
					? document.documentElement.dataset.playAgentFinishSound !== "false"
					: true,
		},
	};
}

/**
 * Project current `state` into the snapshot envelope and write to
 * `localStorage`. Idempotent. Silent no-op when E2E auto-save is gated off
 * or when localStorage is unavailable.
 */
export function saveSnapshot(state: any): boolean {
	if (isE2EAutoSaveDisabled()) return false;
	if (typeof localStorage === "undefined") return false;
	try {
		const payload = buildPayload(state);
		return serialize(payload, { storage: localStorage, key: STORAGE_KEY });
	} catch {
		return false;
	}
}

/**
 * Read the persisted snapshot. Returns null on cold-start, version mismatch,
 * or any error. Always usable — no E2E gate (tests pre-seed manually).
 */
export function loadSnapshot(): Record<string, any> | null {
	if (typeof localStorage === "undefined") return null;
	try {
		return hydrate({ storage: localStorage, key: STORAGE_KEY });
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Debounced scheduler
// ---------------------------------------------------------------------------

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
let _idleHandle: number | null = null;

function cancelPendingSave(): void {
	if (_saveTimer != null) { clearTimeout(_saveTimer); _saveTimer = null; }
	if (_idleHandle != null) {
		try { (globalThis as any).cancelIdleCallback?.(_idleHandle); } catch { /* ignore */ }
		_idleHandle = null;
	}
}

/**
 * Coalesce snapshot writes to one per ~500 ms. Off the main thread when
 * `requestIdleCallback` is available; otherwise next tick. Safe to call from
 * any state-mutation point — overhead is one timer reset.
 */
export function scheduleSave(state: any): void {
	if (isE2EAutoSaveDisabled()) return;
	cancelPendingSave();
	_saveTimer = setTimeout(() => {
		_saveTimer = null;
		const run = () => {
			_idleHandle = null;
			saveSnapshot(state);
		};
		const ric = (globalThis as any).requestIdleCallback as
			| ((cb: () => void, opts?: { timeout: number }) => number)
			| undefined;
		if (typeof ric === "function") {
			_idleHandle = ric(run, { timeout: 1000 });
		} else {
			setTimeout(run, 0);
		}
	}, DEBOUNCE_MS);
}

