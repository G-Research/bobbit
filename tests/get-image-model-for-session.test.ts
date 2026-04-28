/**
 * Unit test for SessionManager.getImageModelForSession() after Agent B's
 * dead-fallback removal (B12). The simplified function:
 *   1. Returns the per-session imageModel{Provider,Id} when both fields are set.
 *   2. Falls back to defaultImageModelPref() (parsed) otherwise.
 *
 * Source-level structure check: confirm the dead second `parseImageModelPref(
 * defaultImageModelPref())` fallback chain has been removed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

describe("SessionManager.getImageModelForSession — post-B12 simplification", () => {
	it("source no longer contains the dead `|| parseImageModelPref(defaultImageModelPref())` fallback", () => {
		const src = fs.readFileSync(
			path.join(PROJECT_ROOT, "src/server/agent/session-manager.ts"),
			"utf-8",
		);
		// Locate the function body.
		const fnStart = src.indexOf("getImageModelForSession(sessionId: string):");
		assert.ok(fnStart >= 0, "function getImageModelForSession not found");
		const fnEnd = src.indexOf("\n\t}", fnStart);
		assert.ok(fnEnd > fnStart, "function body end not found");
		const body = src.slice(fnStart, fnEnd);
		// Strip line comments and block comments so we count code references,
		// not historical breadcrumbs about the dead branch we removed.
		const codeOnly = body
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/[^\n]*/g, "");
		// The dead chain re-parsed defaultImageModelPref() twice. After B12 the
		// function coalesces upstream and parses exactly once.
		const matches = codeOnly.match(/parseImageModelPref/g) || [];
		assert.equal(matches.length, 1, `expected exactly one parseImageModelPref call; got ${matches.length} in code body:\n${codeOnly}`);
		assert.ok(!/\|\|\s*parseImageModelPref\(defaultImageModelPref\(\)\)/.test(codeOnly), "dead fallback chain still present");
	});

	it("function still references the defaultImageModelPref() coalesce path", () => {
		const src = fs.readFileSync(
			path.join(PROJECT_ROOT, "src/server/agent/session-manager.ts"),
			"utf-8",
		);
		const fnStart = src.indexOf("getImageModelForSession(sessionId: string):");
		const fnEnd = src.indexOf("\n\t}", fnStart);
		const body = src.slice(fnStart, fnEnd);
		// Default coalesce must still be there — without it the function can't
		// fall back when no per-session override is set.
		assert.match(body, /defaultImageModelPref\(\)/);
		// Per-session override branch.
		assert.match(body, /imageModelProvider/);
		assert.match(body, /imageModelId/);
	});
});
