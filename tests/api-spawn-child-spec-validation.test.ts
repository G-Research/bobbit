/**
 * Spec-validation for the spawn-child path.
 *
 * Tests the `validateSpawnChildSpec` helper that is called from both:
 *   - `nested-goal-routes.ts` (POST /api/goals/:id/spawn-child)
 *   - `verification-harness.ts` (runSubgoalStep)
 *
 * Cases:
 *   1. spec: "placeholder" → SPEC_PLACEHOLDER
 *   2. spec: "todo"        → SPEC_PLACEHOLDER
 *   3. spec: "wip"         → SPEC_PLACEHOLDER
 *   4. spec: "tbd."        → SPEC_PLACEHOLDER (trailing period allowed)
 *   5. spec: "short."      → SPEC_TOO_SHORT  (under 50 chars)
 *   6. spec: ""            → SPEC_TOO_SHORT  (empty)
 *   7. spec: <50-char padded meaningful string> → SPEC_TOO_SHORT
 *   8. spec: <51-char meaningful string> → ok (success)
 *   9. spec: <long real spec> → ok (success)
 *  10. "placeholder" embedded in longer text → ok (not a full-spec match)
 *  11. looksLikePlaceholder helper: placeholder → true, real spec → false
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	validateSpawnChildSpec,
	looksLikePlaceholder,
	MIN_SPEC_LENGTH,
} from "../src/server/agent/spawn-child-spec-validation.ts";

describe("validateSpawnChildSpec", () => {
	// ── Placeholder keyword rejections ────────────────────────────────

	it("rejects 'placeholder' with SPEC_PLACEHOLDER", () => {
		const result = validateSpawnChildSpec("placeholder");
		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.code, "SPEC_PLACEHOLDER");
	});

	it("rejects 'todo' with SPEC_PLACEHOLDER", () => {
		const result = validateSpawnChildSpec("todo");
		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.code, "SPEC_PLACEHOLDER");
	});

	it("rejects 'wip' with SPEC_PLACEHOLDER", () => {
		const result = validateSpawnChildSpec("wip");
		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.code, "SPEC_PLACEHOLDER");
	});

	it("rejects 'tbd.' (trailing period) with SPEC_PLACEHOLDER", () => {
		const result = validateSpawnChildSpec("tbd.");
		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.code, "SPEC_PLACEHOLDER");
	});

	it("rejects 'PLACEHOLDER' (case-insensitive) with SPEC_PLACEHOLDER", () => {
		const result = validateSpawnChildSpec("PLACEHOLDER");
		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.code, "SPEC_PLACEHOLDER");
	});

	it("rejects '  placeholder  ' (with whitespace) with SPEC_PLACEHOLDER", () => {
		const result = validateSpawnChildSpec("  placeholder  ");
		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.code, "SPEC_PLACEHOLDER");
	});

	// ── Too-short rejections ───────────────────────────────────────────

	it("rejects empty string with SPEC_TOO_SHORT", () => {
		const result = validateSpawnChildSpec("");
		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.code, "SPEC_TOO_SHORT");
		if (!result.ok && result.code === "SPEC_TOO_SHORT") {
			assert.equal(result.actualLength, 0);
			assert.equal(result.minLength, MIN_SPEC_LENGTH);
		}
	});

	it("rejects a 10-char string ('short.    ') with SPEC_TOO_SHORT", () => {
		const result = validateSpawnChildSpec("short.");
		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.code, "SPEC_TOO_SHORT");
	});

	it(`rejects a string exactly one char under the minimum (${MIN_SPEC_LENGTH - 1} chars)`, () => {
		const spec = "x".repeat(MIN_SPEC_LENGTH - 1);
		const result = validateSpawnChildSpec(spec);
		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.code, "SPEC_TOO_SHORT");
		if (!result.ok && result.code === "SPEC_TOO_SHORT") {
			assert.equal(result.actualLength, MIN_SPEC_LENGTH - 1);
		}
	});

	// ── Success cases ──────────────────────────────────────────────────

	it(`accepts a string exactly at the minimum (${MIN_SPEC_LENGTH} chars)`, () => {
		const spec = "x".repeat(MIN_SPEC_LENGTH);
		const result = validateSpawnChildSpec(spec);
		assert.equal(result.ok, true);
	});

	it("accepts a real task description (>50 chars)", () => {
		const spec = "Implement the server-side spec validation for spawn-child: reject placeholder specs at POST /api/goals/:id/spawn-child.";
		assert.ok(spec.length > MIN_SPEC_LENGTH);
		const result = validateSpawnChildSpec(spec);
		assert.equal(result.ok, true);
	});

	it("accepts a spec containing 'placeholder' as part of a longer description", () => {
		// The word 'placeholder' appears mid-sentence — this is NOT a full-match.
		const spec = "This goal must reject placeholder specs so the child team-lead always gets the real task in its first message.";
		assert.ok(spec.length > MIN_SPEC_LENGTH);
		const result = validateSpawnChildSpec(spec);
		assert.equal(result.ok, true);
	});

	it("accepts 'temp' embedded in a longer spec", () => {
		const spec = "Implement a temp-file cleanup routine for the build system output directory (removes stale artefacts on every build).";
		const result = validateSpawnChildSpec(spec);
		assert.equal(result.ok, true);
	});
});

describe("looksLikePlaceholder", () => {
	it("returns true for 'placeholder'", () => {
		assert.equal(looksLikePlaceholder("placeholder"), true);
	});

	it("returns true for 'TODO'", () => {
		assert.equal(looksLikePlaceholder("TODO"), true);
	});

	it("returns false for a real spec", () => {
		assert.equal(looksLikePlaceholder("Implement the real feature described in the parent goal."), false);
	});

	it("returns false for an empty string", () => {
		// Empty string does not match the placeholder keyword pattern.
		assert.equal(looksLikePlaceholder(""), false);
	});
});
