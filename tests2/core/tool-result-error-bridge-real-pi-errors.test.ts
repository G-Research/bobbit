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

describe("adversarial results through Pi's real extension runner", () => {
	it("canonicalizes errors and unsafe result metadata", async () => {
		const { root, loaded } = await loadRealPiLifecycleBoundaryFixture();
		const adversarialCases = [
			{
				label: "initial-error",
				params: { session_id: "target", fail: true },
				code: "STALE_READ_FAILED",
				status: 503,
				forbidden: ["INITIAL_ERROR_SIGNATURE", "INITIAL_ERROR_DETAILS_SIGNATURE", "DOWNSTREAM_ERROR_SIGNATURE", "INITIAL_ERROR_DETAILS"],
			},
			{
				label: "late-error",
				params: { session_id: "target", late_fail: true },
				code: "LATE_READ_FAILED",
				status: 429,
				forbidden: ["LATE_ERROR_SIGNATURE", "LATE_ERROR_ENCRYPTED", "LATE_USAGE_PROVIDER_DATA", "LATE_ERROR_DETAILS"],
			},
		] as const;
		for (const scenario of adversarialCases) {
			const agent = createLifecycleSession(loaded, root, scenario.params);
			const events = await runLifecycle(agent, scenario.label);
			const { emitted: failedEnd, persisted: failedMessage } = toolOutcome(events);
			assert.equal(failedEnd.isError, true);
			assert.equal(failedMessage.isError, true);
			assert.ok(bytes(failedEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(bytes(failedMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.deepEqual(failedEnd.result.details, { code: scenario.code, status: scenario.status });
			const errorPayload = JSON.parse(failedMessage.content[0].text);
			assert.equal(errorPayload.code, scenario.code);
			assert.equal(errorPayload.status, scenario.status);
			const stored = persistOutcome(agent);
			assert.ok(Buffer.byteLength(stored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.equal(stored.roundTrip.isError, true);
			for (const sentinel of scenario.forbidden) {
				assert.equal(JSON.stringify(failedEnd.result).includes(sentinel), false);
				assert.equal(stored.line.includes(sentinel), false);
			}
		}

		const providerOnlyError = createLifecycleSession(loaded, root, { session_id: "target", provider_only_fail: true });
		const providerOnlyEvents = await runLifecycle(providerOnlyError, "provider-only error");
		const { emitted: providerOnlyEnd } = toolOutcome(providerOnlyEvents);
		const providerOnlyStored = persistOutcome(providerOnlyError);
		assert.equal(providerOnlyEnd.isError, true);
		assert.deepEqual(JSON.parse(providerOnlyEnd.result.content[0].text), { error: "read_session_failed" });
		for (const sentinel of [
			"PROVIDER_ONLY_ERROR_SIGNATURE",
			"PROVIDER_ONLY_TEXT_SIGNATURE",
			"PROVIDER_ONLY_ENCRYPTED_DETAILS",
		]) {
			assert.equal(JSON.stringify(providerOnlyEnd.result).includes(sentinel), false);
			assert.equal(providerOnlyStored.line.includes(sentinel), false);
		}

		for (const scenario of [
			{ label: "accessor", params: { session_id: "target", accessor_attack: true }, forbidden: "ACCESSOR_HUGE_PROVIDER_DATA" },
			{ label: "to-json", params: { session_id: "target", hostile_to_json: true }, forbidden: "HOSTILE_TO_JSON_DATA" },
		] as const) {
			const agent = createLifecycleSession(loaded, root, scenario.params);
			const events = await runLifecycle(agent, scenario.label);
			const { emitted: safeEnd, persisted: safeMessage } = toolOutcome(events);
			assert.equal(safeEnd.isError, false);
			assert.equal(safeMessage.isError, false);
			assert.ok(bytes(safeEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.equal(JSON.stringify(safeEnd.result).includes(scenario.forbidden), false);
			assert.equal(Object.prototype.hasOwnProperty.call(safeEnd.result.details, "toJSON"), false);
			const stored = persistOutcome(agent);
			assert.ok(Buffer.byteLength(stored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.equal(stored.line.includes(scenario.forbidden), false);
		}

	});
});
