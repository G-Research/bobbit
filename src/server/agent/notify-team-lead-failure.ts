/**
 * actionable failure notifications — verification failure notifications must be actionable.
 *
 * Pure builder for the message string passed to the team-lead when a
 * verification fails. Includes the failed gate/step context and the exact
 * `gate_inspect(...)` command for each failed step. It intentionally omits
 * output snippets: agents should inspect the gate output directly so the
 * notification stays compact and the diagnostic source is authoritative.
 *
 * Pure — no I/O, no side effects. Lives in its own module so unit tests can
 * import without dragging the whole verification-harness graph in.
 */

import { isRestartInterruptedStep } from "./verification-logic.js";

export interface FailureStepLike {
	name: string;
	type: string;
	passed: boolean;
	skipped?: boolean;
	status?: "waiting" | "running" | "passed" | "failed" | "skipped";
	output?: string;
}

const MAX_STEP_NAMES_LISTED = 5;

function toolStringLiteral(value: string): string {
	return JSON.stringify(value);
}

function gateInspectCommand(gateId: string, stepName?: string): string {
	const stepArg = stepName ? `, step=${toolStringLiteral(stepName)}` : "";
	return `gate_inspect(gate_id=${toolStringLiteral(gateId)}, section="verification"${stepArg}, mode="tail", lines=120)`;
}

function appendInspectBlock(lines: string[], command: string): void {
	lines.push("**Inspect:**");
	lines.push("```text");
	lines.push(command);
	lines.push("```");
}

function describeFailedStep(step: FailureStepLike): string {
	return `\`${step.name}\` (\`${step.type}\`)`;
}

function isRestartInterruptedFailureStep(step: FailureStepLike): boolean {
	if (step.passed || step.skipped) return false;
	if (step.type === "command") return step.status === "waiting";
	return isRestartInterruptedStep({ passed: step.passed, output: step.output ?? "", type: step.type });
}

/**
 * Build the team-lead failure-notification message body for a failed gate.
 *
 * @param gateId The gate that failed (for the leading line).
 * @param steps All step results from this verification (failed + passed).
 *              Skipped steps are intentionally not listed as failures: later
 *              phases skipped after an earlier failure have no logs to inspect.
 *              Pass an empty array if step detail is unavailable — the
 *              builder degrades to a generic inspect/status prompt.
 */
export function buildVerificationFailureMessage(
	gateId: string,
	steps: ReadonlyArray<FailureStepLike>,
): string {
	const failed = steps.filter((s) =>
		!s.passed && !s.skipped && !isRestartInterruptedFailureStep(s),
	);

	const lines: string[] = [];
	lines.push("**Gate verification FAILED**");
	lines.push("");

	if (failed.length === 0) {
		lines.push(`**Failed gate:** \`${gateId}\``);
		lines.push("");
		appendInspectBlock(lines, `gate_status(gate_id=${toolStringLiteral(gateId)})`);
		lines.push("");
		appendInspectBlock(lines, gateInspectCommand(gateId));
		lines.push("**Next:** inspect the gate, fix issues, then re-signal gate.");
		return lines.join("\n");
	}

	const head = failed.slice(0, MAX_STEP_NAMES_LISTED);
	const overflow = failed.length - head.length;
	const namesQuoted = head.map((s) => `\`${s.name}\``).join(", ");
	let summary = `**Failed gate:** \`${gateId}\` — ${namesQuoted}`;
	if (overflow > 0) summary += ` and ${overflow} more`;
	lines.push(summary);
	lines.push("");
	lines.push("Inspect the failed gate output before retrying or continuing.");

	for (const step of failed) {
		lines.push("");
		lines.push(`**Failed step:** ${describeFailedStep(step)}`);
		appendInspectBlock(lines, gateInspectCommand(gateId, step.name));
	}

	lines.push("");
	lines.push("**Next:** inspect each failed step, fix issues, then re-signal gate.");
	return lines.join("\n");
}
