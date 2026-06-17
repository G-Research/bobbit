/**
 * actionable failure notifications — verification failure notifications must be actionable.
 *
 * Pure builder for the message string passed to the team-lead when a
 * verification fails. Includes:
 *  - the gate id
 *  - the failed step name(s) — first 5 comma-joined, "and N more" suffix
 *  - the first failed step's truncated output tail (max 600 chars), formatted
 *    as a code fence for command output or a blockquote for reviewer output
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

function markdownCodeFenceFor(text: string): string {
	const longestRun = Math.max(2, ...Array.from(text.matchAll(/`+/g), m => m[0].length));
	return "`".repeat(longestRun + 1);
}

function blockquote(text: string): string {
	return text.split(/\r?\n/).map(line => `> ${line}`).join("\n");
}

function toolStringLiteral(value: string): string {
	return JSON.stringify(value);
}

function gateInspectCommand(gateId: string, stepName?: string): string {
	const stepArg = stepName ? `, step=${toolStringLiteral(stepName)}` : "";
	return `gate_inspect(gate_id=${toolStringLiteral(gateId)}, section="verification"${stepArg}, mode="tail", lines=120)`;
}

function appendInspectCommands(lines: string[], gateId: string, failed: ReadonlyArray<FailureStepLike>): void {
	lines.push("");
	lines.push("**Inspect:**");
	lines.push("```text");
	if (failed.length === 0) {
		lines.push(`gate_status(gate_id=${toolStringLiteral(gateId)})`);
		lines.push(gateInspectCommand(gateId));
	} else {
		for (const step of failed) lines.push(gateInspectCommand(gateId, step.name));
	}
	lines.push("```");
}

/**
 * Build the team-lead failure-notification message body for a failed gate.
 *
 * @param gateId The gate that failed (for the leading line).
 * @param steps All step results from this verification (failed + passed).
 *              Pass an empty array if step detail is unavailable — the
 *              builder degrades to the legacy generic message.
 */
export function buildVerificationFailureMessage(
	gateId: string,
	steps: ReadonlyArray<FailureStepLike>,
): string {
	const failed = steps.filter((s) => !s.passed);

	const lines: string[] = [];
	lines.push("### Gate verification FAILED");
	lines.push(`**Gate:** \`${gateId}\``);

	if (failed.length === 0) {
		appendInspectCommands(lines, gateId, failed);
		lines.push("**Next:** fix issues; re-signal gate.");
		return lines.join("\n");
	}

	// Failed step name list
	const head = failed.slice(0, MAX_STEP_NAMES_LISTED);
	const overflow = failed.length - head.length;
	const namesQuoted = head.map((s) => `\`${s.name}\``).join(", ");
	let nameLine = `**Failed:** ${namesQuoted}`;
	if (overflow > 0) nameLine += ` and ${overflow} more`;
	lines.push(nameLine);

	// First failed step's truncated output tail
	const first = failed[0];
	const out = (first.output ?? "").trim();
	if (out.length > 0) {
		const wasTruncated = out.length > MAX_OUTPUT_CHARS;
		const truncated = wasTruncated
			? `… (truncated, ${out.length - MAX_OUTPUT_CHARS} earlier chars)\n` + out.slice(-MAX_OUTPUT_CHARS)
			: out;
		lines.push("");
		lines.push(`**First output${wasTruncated ? " (truncated)" : ""}:** \`${first.name}\` (\`${first.type}\`)`);
		if (first.type === "command") {
			const fence = markdownCodeFenceFor(truncated);
			lines.push(`${fence}text`);
			lines.push(truncated);
			lines.push(fence);
		} else {
			lines.push(blockquote(truncated));
		}
	}

	appendInspectCommands(lines, gateId, failed);
	lines.push("**Next:** fix issues; re-signal gate.");
	return lines.join("\n");
}
