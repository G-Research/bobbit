/**
 * In-memory LRU message cache for instant session switching.
 * Stores completed message arrays keyed by session ID.
 * Shallow-copies on get/set to prevent mutation of cached data.
 */

const MAX_CACHED_SESSIONS = 20;

// Map<sessionId, messages[]> — ordered by insertion (most recent last)
const cache = new Map<string, any[]>();

/** Store a snapshot of messages for a session. */
export function cacheMessages(sessionId: string, messages: any[]): void {
	// Delete and re-insert to maintain LRU order
	cache.delete(sessionId);
	// Only cache completed message arrays (shallow copy to avoid mutation)
	cache.set(sessionId, [...messages]);
	// Evict oldest if over limit
	if (cache.size > MAX_CACHED_SESSIONS) {
		const oldest = cache.keys().next().value;
		if (oldest) cache.delete(oldest);
	}
}

/** Retrieve cached messages for a session, or null if not cached. */
export function getCachedMessages(sessionId: string): any[] | null {
	const msgs = cache.get(sessionId);
	return msgs ? [...msgs] : null;
}

/** Remove a session's cached messages (e.g. on terminate). */
export function evictCachedMessages(sessionId: string): void {
	cache.delete(sessionId);
}

/** Clear entire cache. */
export function clearMessageCache(): void {
	cache.clear();
}
