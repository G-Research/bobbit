/**
 * actionable failure notifications — verification failure notifications must be actionable.
 *
 * Pure builder for the message string passed to the team-lead when a
 * verification fails. Includes:
 *  - the gate id (for back-compat with the legacy generic message)
 *  - the failed step name(s) — first 5 comma-joined, "and N more" suffix
 *  - the first failed step's truncated output (max 600 chars)
 *  - a merge-gap diagnostic when ANY failed step is type=command
 *
 * Pure — no I/O, no side effects. Lives in its own module so unit tests can
 * import without dragging the whole verification-harness graph in.
 */

export interface FailureStepLike {
	name: string;
	type: string;
	passed: boolean;
	output?: string;
}

const MAX_STEP_NAMES_LISTED = 5;
const MAX_OUTPUT_CHARS = 600;

/**
 * Build the team-lead failure-notification message body for a failed gate.
 *
 * @param gateId The gate that failed (for the leading line).
 * @param steps All step results from this verification (failed + passed).
 *              Pass an empty array if step detail is unavailable — the
 *              builder degrades to the legacy generic message.
 * @param goalBranch Optional goal branch — when known, embedded into the
 *                   merge-gap diagnostic's `git log` command.
 */
export function buildVerificationFailureMessage(
	gateId: string,
	steps: ReadonlyArray<FailureStepLike>,
	goalBranch?: string,
): string {
	const failed = steps.filter((s) => !s.passed);

	// No detail available → fall back to the legacy single-line message
	// (same wording as pre-actionable-notification behavior, so existing tests still pass).
	if (failed.length === 0) {
		return `Gate verification FAILED: "${gateId}". Check the verification output, fix the issues, and re-signal the gate.`;
	}

	const lines: string[] = [];
	lines.push(`Gate verification FAILED: "${gateId}". Check the verification output, fix the issues, and re-signal the gate.`);

	// Failed step name list
	const head = failed.slice(0, MAX_STEP_NAMES_LISTED);
	const overflow = failed.length - head.length;
	const namesQuoted = head.map((s) => `"${s.name}"`).join(", ");
	let nameLine = `Failed step(s): ${namesQuoted}`;
	if (overflow > 0) nameLine += ` and ${overflow} more`;
	lines.push("");
	lines.push(nameLine);

	// First failed step's truncated output
	const first = failed[0];
	const out = (first.output ?? "").trim();
	if (out.length > 0) {
		const truncated = out.length > MAX_OUTPUT_CHARS
			? out.slice(0, MAX_OUTPUT_CHARS) + `\n… (truncated, ${out.length - MAX_OUTPUT_CHARS} more chars)`
			: out;
		lines.push("");
		lines.push(`Output from "${first.name}":`);
		lines.push(truncated);
	}

	// Merge-gap diagnostic — only when ANY failed step is type=command.
	const anyCommand = failed.some((s) => s.type === "command");
	if (anyCommand) {
		const branchHint = goalBranch ? goalBranch : "<branch>";
		lines.push("");
		lines.push("⚠ Possible merge gap: if the failure mentions files from a sibling phase, you may not have merged that sibling's branch yet. Check:");
		lines.push(`  git log --oneline -5 ${branchHint}`);
		lines.push(`  git for-each-ref --sort=-committerdate refs/heads/goal/* refs/heads/session/* | head -10`);
	}

	return lines.join("\n");
}
