import assert from "node:assert/strict";

import { afterEach, describe, it } from "vitest";

import {
	bytes,
	cleanupRealPiRoots,
	createLifecycleSession,
	loadRealPiLifecycleBoundaryFixture,
	persistOutcome,
	READ_SESSION_FINAL_RESULT_MAX_BYTES,
	runLifecycle,
	toolOutcome,
} from "./tool-result-error-bridge-real-pi-fixture.js";

afterEach(cleanupRealPiRoots);

function projectedEnvelope(value: any): any {
	return JSON.parse(value.content[0].text);
}

function assertProjectionFlags(value: any, label: string): void {
	const envelope = projectedEnvelope(value);
	assert.equal(envelope.messages[0].index, 0, label);
	assert.equal(envelope.messages[0].role, "r".repeat(32), label);
	assert.equal(envelope.messages[0].roleTruncated, true, label);
	assert.equal(envelope.messages[0].ts, "t".repeat(64), label);
	assert.equal(envelope.messages[0].tsTruncated, true, label);
	assert.equal(envelope.messages[0].textTruncated, true, label);
	assert.equal(envelope.messages[1].index, 1, label);
	assert.equal(envelope.messages[1].role, "assistant", label);
	assert.equal(envelope.messages[1].ts, null, label);
	assert.equal(envelope.messages[1].tsInvalid, true,
		`${label} must distinguish an invalid timestamp from an absent timestamp`);
}

describe("projection-state flags through Pi's real persisted lifecycle", () => {
	it("preserves roleTruncated, tsTruncated, and tsInvalid in emitted and JSONL values", async () => {
		const { root, loaded } = await loadRealPiLifecycleBoundaryFixture();
		const session = createLifecycleSession(loaded, root, {
			session_id: "target",
			limit: 2,
			projection_flags: true,
		});
		const events = await runLifecycle(session, "projection flags");
		const { emitted, persisted } = toolOutcome(events);
		const stateMessage = session.state.messages.find((message) => message.role === "toolResult") as any;
		assert.ok(stateMessage);
		const stored = persistOutcome(session);
		const jsonlMessage = JSON.parse(stored.line).message;

		for (const [label, value] of [
			["tool_execution_end", emitted.result],
			["message_end", persisted],
			["Agent state", stateMessage],
			["SessionManager round trip", stored.roundTrip],
			["JSONL", jsonlMessage],
		] as const) {
			assertProjectionFlags(value, label);
			assert.ok(bytes(value) <= READ_SESSION_FINAL_RESULT_MAX_BYTES, `${label} must remain bounded`);
		}
		assert.ok(Buffer.byteLength(stored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
	});
});
