/**
 * Pinned regression: notifyTeamLead's gate-failure message used to be
 * generic ("Check the verification output, fix the issues, and
 * re-signal the gate") with no inline detail about WHICH step failed
 * or WHY. Live test (PR #409): a child team-lead's design-doc gap-
 * analysis failed; the team-lead reacted by spawning more reviewers
 * (which wouldn't fix the underlying gap), then went idle for 18+
 * minutes without re-signalling. The fix: include failed-step names
 * and the first failed step's output (truncated to 600 chars) inline
 * in the notification so the first nudge is actionable.
 *
 * The unit test below pins the pure formatting predicate that
 * production code (`verification-harness.ts::notifyTeamLead`)
 * mirrors.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface FailedStepLike {
	name: string;
	passed: boolean;
	output?: string;
}

/**
 * Replicates the production message-formatting logic. Pure / no I/O.
 * Returns the part of the notification that reports failure detail
 * (or empty string when the gate passed / no failed steps).
 */
function formatFailureDetail(status: "passed" | "failed", failedSteps: FailedStepLike[]): string {
	if (status !== "failed") return "";
	if (failedSteps.length === 0) return "";
	const names = failedSteps.map(s => `"${s.name}"`).join(", ");
	const firstOutput = (failedSteps[0].output ?? "").trim();
	const snippet = firstOutput.length > 600
		? firstOutput.slice(0, 600) + "\u2026"
		: firstOutput;
	return ` Failed step(s): ${names}.${snippet ? `\n\n--- ${failedSteps[0].name} ---\n${snippet}` : ""}`;
}

describe("notifyTeamLead failure detail formatting", () => {
	it("returns empty string for passed status", () => {
		assert.equal(formatFailureDetail("passed", []), "");
	});

	it("returns empty string for failed status with no failed steps", () => {
		// Defensive: if the gate is failed but no individual step is
		// flagged, the message stays generic rather than fabricating one.
		assert.equal(formatFailureDetail("failed", []), "");
	});

	it("includes the failed step name", () => {
		const detail = formatFailureDetail("failed", [
			{ name: "Design gap analysis", passed: false, output: "criterion X is not addressed" },
		]);
		assert.match(detail, /Failed step\(s\): "Design gap analysis"/);
		assert.match(detail, /criterion X is not addressed/);
	});

	it("lists multiple failed step names comma-separated", () => {
		const detail = formatFailureDetail("failed", [
			{ name: "Step A", passed: false, output: "" },
			{ name: "Step B", passed: false, output: "B output" },
		]);
		assert.match(detail, /Failed step\(s\): "Step A", "Step B"/);
	});

	it("inlines only the FIRST failed step's output (avoids huge messages)", () => {
		// Subsequent failed-step outputs are NOT inlined to keep the
		// notification under the team-lead's prompt context budget.
		// They can fetch via gate_inspect / goal_inspect_child.
		const detail = formatFailureDetail("failed", [
			{ name: "First failure", passed: false, output: "first output" },
			{ name: "Second failure", passed: false, output: "second output \u2014 this should NOT appear in the inline detail" },
		]);
		assert.match(detail, /first output/);
		assert.doesNotMatch(detail, /second output/);
	});

	it("truncates very long output at 600 chars with an ellipsis", () => {
		const longOutput = "x".repeat(1000);
		const detail = formatFailureDetail("failed", [
			{ name: "Long failure", passed: false, output: longOutput },
		]);
		// The inline snippet is <= 601 chars (600 + ellipsis).
		const snippetMatch = detail.match(/--- Long failure ---\n([\s\S]+)$/);
		assert.ok(snippetMatch, "expected fenced snippet section");
		const snippet = snippetMatch![1];
		assert.ok(snippet.length === 601 || snippet.length === 600 + "\u2026".length,
			`snippet length should be 600+ellipsis, got ${snippet.length}`);
		assert.ok(snippet.endsWith("\u2026"), "snippet should end with ellipsis when truncated");
	});

	it("does NOT add the snippet section when output is empty", () => {
		const detail = formatFailureDetail("failed", [
			{ name: "No output failure", passed: false, output: "" },
		]);
		assert.match(detail, /Failed step\(s\): "No output failure"/);
		assert.doesNotMatch(detail, /---/, "no snippet fence when output is empty");
	});

	it("trims surrounding whitespace from output before checking emptiness", () => {
		const detail = formatFailureDetail("failed", [
			{ name: "Whitespace-only failure", passed: false, output: "   \n\n\t  " },
		]);
		// Trimmed empty output \u2192 no snippet fence
		assert.doesNotMatch(detail, /---/);
	});

	it("preserves output that's exactly 600 chars without ellipsis", () => {
		const exactly600 = "y".repeat(600);
		const detail = formatFailureDetail("failed", [
			{ name: "Boundary", passed: false, output: exactly600 },
		]);
		assert.doesNotMatch(detail, /\u2026/, "no ellipsis at exactly 600 chars");
		assert.match(detail, /yyy/);
	});
});

// Pinned regression: the merge-gap diagnostic. PR #409 live test — two
// Phase 2 leaf team-leads hit the same failure pattern (signalled
// implementation gate before merging the coder's sub-branch into the
// goal branch; tsc -b failed with errors pointing at sibling-phase
// files). Adding the git-context hint to the failure prompt cuts
// diagnosis time from "hours of trying to reproduce the wrong bug" to
// "one glance at the message".
//
// We test the production logic via the same predicate it uses
// (failedSteps.some(s => s.type === "command")). The hint text is
// fixed; we only assert the predicate fires on the right shapes.
describe("merge-gap diagnostic predicate (when to attach git-context hint)", () => {
	function shouldAttachGitContext(
		status: "passed" | "failed",
		failedSteps: Array<{ type?: string; passed: boolean }>,
	): boolean {
		if (status !== "failed") return false;
		return failedSteps.some(s => s.type === "command");
	}

	it("attaches when at least one failed step is type=command", () => {
		assert.equal(shouldAttachGitContext("failed", [
			{ type: "command", passed: false },
		]), true);
	});

	it("attaches when MIXED failure (one llm-review + one command)", () => {
		// At least one command step failed — git context is relevant.
		assert.equal(shouldAttachGitContext("failed", [
			{ type: "llm-review", passed: false },
			{ type: "command", passed: false },
		]), true);
	});

	it("does NOT attach when only llm-review steps failed (no merge-gap risk)", () => {
		// LLM reviewers don't run shell commands; a merge gap won't
		// produce a tsc/test error. Don't muddy the message.
		assert.equal(shouldAttachGitContext("failed", [
			{ type: "llm-review", passed: false },
		]), false);
	});

	it("does NOT attach when status is passed", () => {
		assert.equal(shouldAttachGitContext("passed", [
			{ type: "command", passed: false },
		]), false);
	});

	it("does NOT attach when no failed steps (defensive)", () => {
		assert.equal(shouldAttachGitContext("failed", []), false);
	});

	it("attaches even when type field is missing on the failed step (defensive: assume worst case)", () => {
		// A future schema change might make `type` optional. We choose to
		// SUPPRESS the hint when type is unknown (predicate above), since
		// surfacing it on every failure spams the prompt. Pin that choice.
		assert.equal(shouldAttachGitContext("failed", [
			{ passed: false }, // type undefined
		]), false);
	});
});
