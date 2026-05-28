import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const REMOTE_AGENT_SOURCE = readFileSync(new URL("../src/app/remote-agent.ts", import.meta.url), "utf8");
const API_SOURCE = readFileSync(new URL("../src/app/api.ts", import.meta.url), "utf8");
const DASHBOARD_SOURCE = readFileSync(new URL("../src/app/goal-dashboard.ts", import.meta.url), "utf8");

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

test("api.ts exposes a debounced per-goal shared gate summary invalidator", () => {
	assert.match(API_SOURCE, /export function invalidateGateStatusForGoal\s*\(/, "expected exported invalidator");
	assert.match(API_SOURCE, /GATE_STATUS_INVALIDATION_DEBOUNCE_MS/, "expected debounce window");
	assert.match(API_SOURCE, /_gateStatusInvalidateTimers/, "expected per-goal debounce timers");
	assert.match(API_SOURCE, /_gateStatusInFlight/, "expected per-goal in-flight coalescing");
	assert.match(API_SOURCE, /_gateStatusTrailing/, "expected trailing refresh coalescing");
	assert.match(API_SOURCE, /setTimeout\s*\(/, "expected invalidations to be scheduled, not fetched inline");
});

test("Goal dashboard schedules shared summary refreshes without writing partial cache entries", () => {
	assert.doesNotMatch(
		DASHBOARD_SOURCE,
		/state\.gateStatusCache\.set\s*\(/,
		"dashboard must not write stale partial signoff counters into state.gateStatusCache",
	);
	assert.match(DASHBOARD_SOURCE, /invalidateGateStatusForGoal/, "dashboard should use the shared gate summary invalidator");

	const eventSet = DASHBOARD_SOURCE.match(/GATE_SUMMARY_INVALIDATING_EVENTS\s*=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
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
	for (const eventType of eventsThatMustInvalidate) {
		assert.match(eventSet, new RegExp(`"${eventType}"`), `dashboard should invalidate on ${eventType}`);
	}
	assert.doesNotMatch(eventSet, /"gate_verification_step_output"/, "step output is detail-only and should not invalidate summaries");
});
