import assert from "node:assert/strict";
import fs from "node:fs";

import { afterEach, describe, it } from "vitest";

import {
	bytes,
	cleanupRealPiRoots,
	createLifecycleSession,
	loadRealPiLifecycleBoundaryFixture,
	persistOutcome,
	READ_SESSION_FINAL_RESULT_MAX_BYTES,
	resultValueFromMessage,
	runLifecycle,
} from "./tool-result-error-bridge-real-pi-fixture.js";

afterEach(cleanupRealPiRoots);

describe("tool result boundary through Pi's real extension runner", () => {
	it("reprojects in-place post-listener mutations before emission and persistence", async () => {
		const { root, loaded } = await loadRealPiLifecycleBoundaryFixture();
		const success = createLifecycleSession(loaded, root, {
			session_id: "target",
			include_tool_results: true,
			limit: 1,
		});
		const successEvents = await runLifecycle(success, "read it");
		assert.equal(success.getActiveToolNames().includes("read_session"), true);

		const emitted = successEvents.find((event) => event.type === "tool_execution_end");
		const persisted = successEvents.find((event) => event.type === "message_end" && event.message.role === "toolResult")?.message;
		assert.ok(emitted);
		assert.ok(persisted);
		assert.equal(emitted.isError, false);
		assert.equal(persisted.isError, false);
		assert.ok(bytes(emitted.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.ok(bytes(persisted) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.equal(Object.isFrozen(emitted.result.content), true,
			"the final listener-controlled value must be an immutable plain snapshot");

		const stateMessage = success.state.messages.find((message) => message.role === "toolResult") as any;
		assert.ok(stateMessage, "the canonical result must reach Agent state");
		const successStored = persistOutcome(success);
		const { roundTrip: persistedRoundTrip, line: persistedJsonlLine } = successStored;
		const jsonlMessage = JSON.parse(persistedJsonlLine).message;
		for (const [label, value] of [
			["tool_execution_end", emitted.result],
			["message_end", persisted],
			["Agent state", stateMessage],
			["SessionManager round trip", persistedRoundTrip],
			["JSONL", jsonlMessage],
		] as const) {
			assert.deepEqual(resultValueFromMessage(value), emitted.result,
				`${label} must retain the exact emitted canonical result`);
			for (const key of [
				"usage", "api", "provider", "model", "providerMetadata",
				"thinkingSignature", "textSignature", "encryptedContent",
			]) {
				assert.equal(Object.prototype.hasOwnProperty.call(value, key), false,
					`${label} must omit provider-only ${key} metadata`);
				assert.equal(Object.prototype.hasOwnProperty.call((value as any).details, key), false,
					`${label} details must omit provider-only ${key} metadata`);
			}
		}
		assert.ok(bytes(persistedRoundTrip) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);

		const projected = JSON.parse(persistedRoundTrip.content[0].text);
		assert.equal(JSON.stringify(projected).includes("PROVIDER_SIGNATURE_MUST_NOT_SURVIVE"), false);
		assert.equal(JSON.stringify(persisted).includes("WRAPPER_PROVIDER_SIGNATURE"), false);
		assert.equal(JSON.stringify(persisted).includes("WRAPPER_ONLY_PROVIDER_DATA"), false);
		const downstreamProviderData = [
			"LATER_MESSAGE_THINKING_SIGNATURE",
			"LATER_MESSAGE_TEXT_SIGNATURE",
			"LATER_DETAILS_THINKING_SIGNATURE",
			"LATER_DETAILS_TEXT_SIGNATURE",
			"LATER_ENCRYPTED_PROVIDER_BLOB",
		];
		assert.ok(Buffer.byteLength(persistedJsonlLine, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		for (const sentinel of downstreamProviderData) {
			assert.equal(JSON.stringify(emitted.result).includes(sentinel), false);
			assert.equal(JSON.stringify(persisted).includes(sentinel), false);
			assert.equal(JSON.stringify(stateMessage).includes(sentinel), false);
			assert.equal(JSON.stringify(persistedRoundTrip).includes(sentinel), false);
			assert.equal(persistedJsonlLine.includes(sentinel), false);
		}
		assert.equal(persistedRoundTrip.content.length, 1,
			"the final runner seam must discard downstream wrapper content");
		assert.deepEqual(Object.keys(projected.messages[0].toolResults[0]).sort(),
			["excerpt", "handle", "name", "omitted", "ref", "size", "status"].sort());
		assert.equal(projected.messages[0].toolResults[0].name, "read");
		assert.equal(projected.messages[0].toolResults[0].status, "ok");

		const mutationThenThrow = createLifecycleSession(loaded, root, {
			session_id: "target",
			include_tool_results: true,
			limit: 1,
			throw_after_mutation: true,
		});
		const mutationThenThrowEvents = await runLifecycle(mutationThenThrow, "read it after a throwing mutator");
		const throwEmitted = mutationThenThrowEvents.find((event) => event.type === "tool_execution_end");
		const throwPersisted = mutationThenThrowEvents.find((event) =>
			event.type === "message_end" && event.message.role === "toolResult")?.message;
		assert.ok(throwEmitted, "Pi must continue after reporting a tool_result listener error");
		assert.ok(throwPersisted);
		assert.equal(throwEmitted.isError, false);
		assert.equal(throwPersisted.isError, false);
		assert.ok(bytes(throwEmitted.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.ok(bytes(throwPersisted) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.deepEqual(throwPersisted.content, throwEmitted.result.content);
		assert.deepEqual(throwPersisted.details, throwEmitted.result.details);
		for (const sentinel of downstreamProviderData) {
			assert.equal(JSON.stringify(throwEmitted.result).includes(sentinel), false);
			assert.equal(JSON.stringify(throwPersisted).includes(sentinel), false);
		}

		const throwStored = persistOutcome(mutationThenThrow);
		const throwSessionFile = throwStored.sessionFile;
		const throwPersistedRoundTrip = throwStored.roundTrip;
		assert.ok(bytes(throwPersistedRoundTrip) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.deepEqual(throwPersistedRoundTrip.content, throwPersisted.content);
		assert.deepEqual(throwPersistedRoundTrip.details, JSON.parse(JSON.stringify(throwPersisted.details)));
		assert.equal(throwPersistedRoundTrip.content.length, 1);
		const throwPersistedJsonlLine = fs.readFileSync(throwSessionFile, "utf8")
			.split(/\r?\n/)
			.find((line) => line.includes('"role":"toolResult"'));
		assert.ok(throwPersistedJsonlLine);
		assert.ok(Buffer.byteLength(throwPersistedJsonlLine, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		for (const sentinel of downstreamProviderData) {
			assert.equal(JSON.stringify(throwPersistedRoundTrip).includes(sentinel), false);
			assert.equal(throwPersistedJsonlLine.includes(sentinel), false);
		}

	});
});
