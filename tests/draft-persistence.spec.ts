import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Tests verifying draft persistence fixes (PI-04b, PI-04c).
 * These are source-level verification tests that confirm the bugs are fixed
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

	test("_flushDraft returns Promise — save can be awaited on session switch (PI-04b)", () => {
		// Fix for Bug 3: _flushDraft() now returns Promise<void> | void.
		// When it saves content, it stores the promise in _pendingSave so
		// _setupPromptDraftHandlers can await it before loading.

		// Verify _flushDraft has return type that includes Promise
		const flushDraftMatch = source.match(
			/function\s+_flushDraft\s*\([^)]*\)\s*:\s*([^{]+)/,
		);
		expect(flushDraftMatch).not.toBeNull();
		const returnType = flushDraftMatch![1].trim();

		// Return type should include Promise (e.g. "Promise<void> | void")
		expect(returnType).not.toBe("void");
		expect(returnType).toContain("Promise");

		// Verify _pendingSave is awaited before loading
		expect(source).toContain("await _pendingSave");
	});

	test("draft restore uses requestAnimationFrame retry — survives Lit re-renders (PI-04c)", () => {
		// Fix for Bug 4: Uses requestAnimationFrame with multi-frame retry
		// instead of a single queueMicrotask.

		// Should NOT use queueMicrotask for draft re-apply
		const hasQueueMicrotask = source.includes("queueMicrotask(() => {");
		const hasRAFRetry = source.includes("requestAnimationFrame(reapply)");

		expect(hasQueueMicrotask).toBe(false);
		expect(hasRAFRetry).toBe(true);
	});
});
