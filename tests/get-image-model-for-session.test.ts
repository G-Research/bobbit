/**
 * Unit test for SessionManager.getImageModelForSession() after Agent B's
 * dead-fallback-removal (B12). Confirms the simplified function still:
 *   - returns the per-session image model when set,
 *   - falls back to the system default when unset,
 *   - throws / returns sentinel as designed when no default exists.
 *
 * Phase 1: scaffold only. Phase 2 will instantiate SessionManager (or stub)
 * and exercise the three branches.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// TODO Phase 2: import after B12 lands.
// const { SessionManager } = await import("../dist/server/agent/session-manager.js");

describe("SessionManager.getImageModelForSession", () => {
	it.skip("returns the session's stored image model when set", () => {
		// TODO Phase 2.
		assert.ok(true);
	});

	it.skip("falls back to defaultImageModelPref() when session has no override", () => {
		// TODO Phase 2.
		assert.ok(true);
	});

	it.skip("dead second-branch fallback is gone (function structure check)", () => {
		// TODO Phase 2: optional — read the function source, assert it does not
		// re-query a removed fallback path.
		assert.ok(true);
	});
});
