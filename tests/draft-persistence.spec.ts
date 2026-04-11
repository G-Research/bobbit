import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Tests that reproduce draft persistence bugs (PI-04b, PI-04c).
 * These are source-level verification tests that prove the bugs exist
 * by analyzing the actual implementation code.
 */

const SESSION_MANAGER_PATH = path.resolve(
	import.meta.dirname ?? __dirname,
	"../src/app/session-manager.ts",
);

test.describe("Draft Persistence Bugs", () => {
	let source: string;

	test.beforeAll(() => {
		source = fs.readFileSync(SESSION_MANAGER_PATH, "utf-8");
	});

	test("BUG: _flushDraft returns void — save promise is discarded (PI-04b)", () => {
		// Bug 3: _flushDraft() is fire-and-forget. It calls saveDraftToServer()
		// but discards the promise. This means:
		// 1. selectSession() calls _flushDraft() before switching
		// 2. The save hasn't reached the server yet
		// 3. Switching back immediately → loadDraftFromServer returns stale data
		// 4. The user's draft is lost
		//
		// The fix: _flushDraft should return the save promise so callers can await it.

		// Verify _flushDraft has return type void (the bug)
		const flushDraftMatch = source.match(
			/function\s+_flushDraft\s*\([^)]*\)\s*:\s*(\w+)/,
		);
		expect(flushDraftMatch).not.toBeNull();
		const returnType = flushDraftMatch![1];

		// BUG: return type is "void" — it should return a Promise
		// This assertion FAILS until the fix changes the return type
		expect(returnType).not.toBe("void");
	});

	test("BUG: draft restore uses single queueMicrotask — clobbered by Lit re-renders (PI-04c)", () => {
		// Bug 4: After loading a draft from the server, the code applies it to the
		// editor and uses a single queueMicrotask as a safety net. But Lit re-renders
		// triggered by connection status changes, message loading, etc. can fire AFTER
		// the microtask, clobbering the restored value.
		//
		// The fix: Use requestAnimationFrame with multi-frame retry instead of
		// a single queueMicrotask.

		// Find the draft restore code in _setupPromptDraftHandlers
		const hasQueueMicrotask = source.includes("queueMicrotask(() => {");
		const hasRAFRetry = source.includes("requestAnimationFrame(reapply)");

		// BUG: Uses queueMicrotask (fragile) instead of rAF retry (robust)
		// This assertion FAILS until the fix replaces the approach
		expect(hasQueueMicrotask).toBe(false);
		expect(hasRAFRetry).toBe(true);
	});
});
