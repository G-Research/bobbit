/**
 * Defensive localStorage wrappers.
 *
 * `localStorage.setItem` / `getItem` can THROW, not just no-op:
 *   - Quota exceeded (`QuotaExceededError`) once the origin's storage is full.
 *   - Storage disabled / partitioned (Safari private mode historically threw on
 *     every write; some embedded webviews and locked-down enterprise profiles
 *     deny access entirely so even reads throw `SecurityError`).
 *   - SSR / non-window contexts where `localStorage` is undefined.
 *
 * Persisted UI state (sidebar expand/collapse sets, widths, etc.) is a
 * convenience, never load-bearing. A storage failure must never abort a code
 * path — most dangerously the boot-critical `refreshSessions()` path, where a
 * thrown `setItem` used to bubble into `state.sessionsError` and render the raw
 * "Failed to execute 'setItem' on 'Storage'" string in the sidebar right before
 * the UI loaded.
 *
 * These helpers swallow all storage exceptions so callers can treat
 * persistence as best-effort. This is the single source of truth — prefer it
 * over scattered inline `try { localStorage… } catch {}` blocks.
 */

function hasLocalStorage(): boolean {
	try {
		return typeof localStorage !== "undefined";
	} catch {
		// Accessing `localStorage` itself can throw (SecurityError) in some
		// locked-down contexts.
		return false;
	}
}

/** Best-effort `localStorage.setItem`. Never throws. */
export function safeSetItem(key: string, value: string): void {
	if (!hasLocalStorage()) return;
	try {
		localStorage.setItem(key, value);
	} catch {
		/* quota exceeded / storage disabled / SSR — persistence is best-effort */
	}
}

/** Best-effort `localStorage.removeItem`. Never throws. */
export function safeRemoveItem(key: string): void {
	if (!hasLocalStorage()) return;
	try {
		localStorage.removeItem(key);
	} catch {
		/* storage disabled / SSR */
	}
}

/** Best-effort `localStorage.getItem`. Returns `null` on any failure. */
export function safeGetItem(key: string): string | null {
	if (!hasLocalStorage()) return null;
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

/**
 * Read and JSON.parse a localStorage value, returning `fallback` if the key is
 * absent, storage is unavailable, or the stored value is corrupted (so a single
 * bad write can never break module load via an uncaught `SyntaxError`).
 */
export function safeGetJSON<T>(key: string, fallback: T): T {
	const raw = safeGetItem(key);
	if (raw === null) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}
