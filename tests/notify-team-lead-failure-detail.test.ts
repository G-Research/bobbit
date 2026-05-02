/**
 * Phase 6 — Lesson 4.18: actionable verification-failure notifications.
 *
 * Tests for `buildVerificationFailureMessage`:
 *  - Single failed step → message includes step name + truncated output
 *  - Multiple steps → first 5 names listed, "and N more" suffix beyond that
 *  - Failed command step → merge-gap diagnostic appended (with branch hint)
 *  - Failed llm-review only → merge-gap diagnostic NOT appended
 *  - Empty step list → degrades to legacy generic message (no Stanza added)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { buildVerificationFailureMessage } = await import("../src/server/agent/notify-team-lead-failure.ts");

const MERGE_GAP_HEADER = "Possible merge gap";

describe("buildVerificationFailureMessage", () => {
	it("single failed command step → includes name + output", () => {
		const msg = buildVerificationFailureMessage("implementation", [
			{ name: "Type check passes", type: "command", passed: false, output: "tsc: error TS2304: cannot find name 'foo'" },
		], "goal/feature-x");
		assert.ok(msg.includes(`Failed step(s): "Type check passes"`), "step name listed");
		assert.ok(msg.includes("tsc: error TS2304"), "output included verbatim");
		assert.ok(msg.includes(MERGE_GAP_HEADER), "command failure → merge-gap appended");
		assert.ok(msg.includes("git log --oneline -5 goal/feature-x"), "branch substituted into git log hint");
	});

	it("up to 5 failed steps → all names comma-joined, no overflow suffix", () => {
		const fives = ["A", "B", "C", "D", "E"].map((n) => ({
			name: n, type: "command", passed: false, output: "x",
		}));
		const msg = buildVerificationFailureMessage("g", fives, "br");
		assert.ok(msg.includes(`"A", "B", "C", "D", "E"`), "all 5 names comma-joined");
		// The "and N more" suffix (specifically) must be absent; we don't blanket
		// match "and " since the merge-gap text legitimately contains it.
		assert.ok(!/and \d+ more/.test(msg), "no 'and N more' suffix for exactly 5 failures");
	});

	it("6+ failed steps → first 5 listed + 'and N more' suffix", () => {
		const sevens = ["A", "B", "C", "D", "E", "F", "G"].map((n) => ({
			name: n, type: "command", passed: false, output: "",
		}));
		const msg = buildVerificationFailureMessage("g", sevens, "br");
		assert.ok(msg.includes(`"A", "B", "C", "D", "E"`), "first 5 listed");
		assert.ok(msg.includes("and 2 more"), "overflow suffix present");
		assert.ok(!msg.includes(`"F"`), "F should not appear in the listed names");
		assert.ok(!msg.includes(`"G"`), "G should not appear in the listed names");
	});

	it("failed command step → merge-gap diagnostic appended", () => {
		const msg = buildVerificationFailureMessage("integration", [
			{ name: "Build", type: "command", passed: false, output: "build failed" },
		], "goal/x-y-z");
		assert.ok(msg.includes(MERGE_GAP_HEADER), "merge-gap header present");
		assert.ok(msg.includes("git for-each-ref"), "git for-each-ref command present");
		assert.ok(msg.includes("goal/x-y-z"), "branch substituted into git log hint");
	});

	it("failed llm-review ONLY (no command) → merge-gap NOT appended", () => {
		const msg = buildVerificationFailureMessage("review", [
			{ name: "Code review", type: "llm-review", passed: false, output: "fails: design concerns" },
		], "goal/x");
		assert.ok(!msg.includes(MERGE_GAP_HEADER), "no merge-gap for review-only failure");
		assert.ok(msg.includes(`Failed step(s): "Code review"`), "step name still listed");
		assert.ok(msg.includes("design concerns"), "output still included");
	});

	it("mix of llm-review + command failure → merge-gap APPENDED (any command qualifies)", () => {
		const msg = buildVerificationFailureMessage("integration", [
			{ name: "Code review", type: "llm-review", passed: false, output: "x" },
			{ name: "Build", type: "command", passed: false, output: "build failed" },
		], "goal/x");
		assert.ok(msg.includes(MERGE_GAP_HEADER), "any command-type failure triggers merge-gap");
	});

	it("output longer than 600 chars is truncated with marker", () => {
		const long = "X".repeat(2000);
		const msg = buildVerificationFailureMessage("g", [
			{ name: "Test", type: "command", passed: false, output: long },
		], "br");
		// Should NOT contain the full 2000 X chars — capped at 600
		assert.ok(msg.includes("X".repeat(600)), "first 600 chars present");
		assert.ok(!msg.includes("X".repeat(601)), "601st char should be truncated");
		assert.ok(msg.includes("truncated"), "truncation marker present");
	});

	it("empty step list → degrades to legacy generic FAILED message", () => {
		const msg = buildVerificationFailureMessage("g", [], undefined);
		assert.ok(msg.includes("Gate verification FAILED"), "still mentions failure");
		assert.ok(!msg.includes(MERGE_GAP_HEADER), "no merge-gap when no failed-step detail");
	});

	it("missing branch → falls back to <branch> placeholder in git command", () => {
		const msg = buildVerificationFailureMessage("g", [
			{ name: "x", type: "command", passed: false, output: "y" },
		], undefined);
		assert.ok(msg.includes("git log --oneline -5 <branch>"), "placeholder branch present");
	});
});
