import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const REMOTE_AGENT_SOURCE = readFileSync(new URL("../src/app/remote-agent.ts", import.meta.url), "utf8");

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function caseStatements(source: string, eventType: string): string | null {
	const withoutComments = stripComments(source);
	const caseNeedle = `case "${eventType}":`;
	const caseIndex = withoutComments.indexOf(caseNeedle);
	if (caseIndex < 0) return null;

	let labelEnd = caseIndex + caseNeedle.length;
	let searchFrom = labelEnd;

	// Consecutive `case` labels share the same statements. Skip forward until the
	// first non-label text so grouped gate events are checked against the block
	// they actually execute.
	while (true) {
		const remainder = withoutComments.slice(searchFrom);
		const match = remainder.match(/^\s*case\s+"[^"]+"\s*:/);
		if (!match) break;
		labelEnd = searchFrom + match[0].length;
		searchFrom = labelEnd;
	}

	const nextBreak = withoutComments.indexOf("break;", labelEnd);
	assert.notEqual(nextBreak, -1, `Could not find break for ${eventType}`);
	return withoutComments.slice(labelEnd, nextBreak);
}

function hasGateSummaryInvalidation(statements: string): boolean {
	return /\b(?:refreshGateStatusForGoal|invalidateGateStatusForGoal)\s*\(/.test(statements);
}

test("RemoteAgent invalidates shared gate summary cache for every count-changing gate event", () => {
	const eventsThatMustInvalidate = [
		"gate_signal_received",
		"gate_status_changed",
		"gate_reset",
		"gate_verification_started",
		"gate_verification_phase_started",
		"gate_verification_step_started",
		"gate_verification_awaiting_human",
		"gate_verification_step_complete",
		"gate_verification_complete",
	];

	const missing = eventsThatMustInvalidate.filter((eventType) => {
		const statements = caseStatements(REMOTE_AGENT_SOURCE, eventType);
		return !statements || !hasGateSummaryInvalidation(statements);
	});

	assert.deepEqual(
		missing,
		[],
		`Expected RemoteAgent to refresh gate summary cache for event(s): ${missing.join(", ")}`,
	);
});

test("RemoteAgent does not refetch gate summaries for detail-only step output", () => {
	const statements = caseStatements(REMOTE_AGENT_SOURCE, "gate_verification_step_output");
	assert.ok(statements, "gate_verification_step_output case should exist");
	assert.equal(
		hasGateSummaryInvalidation(statements!),
		false,
		"gate_verification_step_output should not refresh gate summary cache",
	);
});
