// Ported from tests/e2e/system-prompt-customise.spec.ts (v2-integration tier).
//
// POST /api/system-prompt/customise copies the shipped default system-prompt.md
// into <bobbitDir>/config/system-prompt.md on the first call (returns
// { created: true, path, content }); a second call leaves the file untouched
// (returns { created: false, ... }); the endpoint requires authentication.
//
// Uses the fork-scoped gateway fixture. The src-booted gateway resolves the
// shipped default via config.builtinsDir (repo-root defaults/), so `created`
// works without a dist build.
import { test, expect } from "./_e2e/in-process-harness.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { apiFetch, bobbitDir, base } from "./_e2e/e2e-setup.js";

// Run serially — tests share the user system-prompt.md file.
test.describe.configure({ mode: "serial" });

function userPromptPath(): string {
	return join(bobbitDir(), "config", "system-prompt.md");
}

function removeUserPrompt() {
	try { unlinkSync(userPromptPath()); } catch { /* doesn't exist */ }
}

test.describe.serial("system-prompt customise endpoint", () => {
	test.beforeAll(() => removeUserPrompt());
	test.afterAll(() => removeUserPrompt());

	test("POST /api/system-prompt/customise creates file on first call, no-ops on second", async () => {
		removeUserPrompt();
		expect(existsSync(userPromptPath())).toBe(false);

		// First call — should create the file.
		const r1 = await apiFetch("/api/system-prompt/customise", { method: "POST" });
		expect(r1.status).toBe(200);
		const d1 = await r1.json();
		expect(d1.created).toBe(true);
		expect(typeof d1.path).toBe("string");
		expect(typeof d1.content).toBe("string");
		expect(d1.content.length).toBeGreaterThan(0);
		expect(d1.path).toBe(userPromptPath());
		expect(existsSync(userPromptPath())).toBe(true);

		// Content on disk should match what was returned.
		const onDisk = readFileSync(userPromptPath(), "utf-8");
		expect(onDisk).toBe(d1.content);

		// Second call — file already exists, should NOT be re-created.
		const r2 = await apiFetch("/api/system-prompt/customise", { method: "POST" });
		expect(r2.status).toBe(200);
		const d2 = await r2.json();
		expect(d2.created).toBe(false);
		expect(d2.path).toBe(userPromptPath());
		expect(d2.content).toBe(d1.content);
	});

	test("POST /api/system-prompt/customise requires authentication", async () => {
		const resp = await fetch(`${base()}/api/system-prompt/customise`, { method: "POST" });
		expect(resp.status).toBe(401);
	});
});
