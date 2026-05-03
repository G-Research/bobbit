/**
 * E2E tests for POST /api/system-prompt/customise.
 *
 * First call copies dist/server/defaults/system-prompt.md → .bobbit/config/system-prompt.md
 * and returns { created: true, path, content }. Second call leaves the file
 * untouched and returns { created: false, path, content }.
 */
import { test, expect } from "./in-process-harness.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { apiFetch, bobbitDir } from "./e2e-setup.js";

// Run serially — tests share the user system-prompt.md file.
test.describe.configure({ mode: "serial" });

function userPromptPath(): string {
	return join(bobbitDir(), "config", "system-prompt.md");
}

function removeUserPrompt() {
	try { unlinkSync(userPromptPath()); } catch { /* doesn't exist */ }
}

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
	const { base } = await import("./e2e-setup.js");
	const resp = await fetch(`${base()}/api/system-prompt/customise`, { method: "POST" });
	expect(resp.status).toBe(401);
});
