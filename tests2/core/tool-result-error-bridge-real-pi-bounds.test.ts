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
	runLifecycle,
	toolOutcome,
} from "./tool-result-error-bridge-real-pi-fixture.js";

afterEach(cleanupRealPiRoots);

describe("result size and correlation bounds through Pi's real extension runner", () => {
	it("preserves useful near-ceiling output while bounding lifecycle correlation IDs", async () => {
		const { root, loaded } = await loadRealPiLifecycleBoundaryFixture();
		const nearCeiling = createLifecycleSession(loaded, root, {
			session_id: "target",
			verbose: true,
			near_ceiling: true,
		});
		const nearCeilingEvents = await runLifecycle(nearCeiling, "near ceiling");
		const { emitted: ceilingEnd, persisted: ceilingMessage } = toolOutcome(nearCeilingEvents);
		const ceilingStored = persistOutcome(nearCeiling);
		assert.ok(bytes(ceilingEnd.result) > 40 * 1024, "the fitter should preserve useful near-ceiling capacity");
		assert.ok(bytes(ceilingEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.ok(bytes(ceilingMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.ok(Buffer.byteLength(ceilingStored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.deepEqual(ceilingStored.roundTrip.content, ceilingEnd.result.content);
		assert.deepEqual(ceilingStored.roundTrip.details, ceilingEnd.result.details);

		for (const correlation of [
			{ label: "boundary", source: "b".repeat(128), hashed: false },
			{ label: "over-boundary", source: "o".repeat(129), hashed: true },
			{ label: "oversized", source: "z".repeat(100_000), hashed: true },
			{ label: "snapshot-limit-plus-one", source: "j".repeat(2 * 1024 * 1024 + 1), hashed: true },
			{ label: "far-over-snapshot-limit", source: "f".repeat(8 * 1024 * 1024 + 17), hashed: true },
		] as const) {
			const correlationSession = createLifecycleSession(loaded, root, {
				session_id: "target",
				limit: 1,
			}, "read_session", correlation.source);
			const correlationEvents = await runLifecycle(correlationSession, correlation.label);
			const assistant = correlationSession.state.messages.find((message) =>
				message.role === "assistant" && message.stopReason === "toolUse") as any;
			const result = correlationSession.state.messages.find((message) => message.role === "toolResult") as any;
			assert.ok(assistant);
			assert.ok(result);
			const normalizedId = assistant.content.find((block: any) => block.type === "toolCall")?.id;
			assert.equal(typeof normalizedId, "string");
			assert.equal(result.toolCallId, normalizedId);
			assert.equal(correlationEvents.find((event) => event.type === "tool_execution_start")?.toolCallId, normalizedId);
			assert.equal(correlationEvents.find((event) => event.type === "tool_execution_end")?.toolCallId, normalizedId);
			if (correlation.hashed) {
				assert.match(normalizedId, /^brs1:[0-9a-f]{40}$/);
				assert.notEqual(normalizedId, correlation.source);
			} else {
				assert.equal(normalizedId, correlation.source);
			}
			const stored = persistOutcome(correlationSession);
			for (const line of fs.readFileSync(stored.sessionFile, "utf8").split(/\r?\n/).filter(Boolean)) {
				if (line.includes('"role":"assistant"') || line.includes('"role":"toolResult"')) {
					assert.ok(Buffer.byteLength(line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
				}
			}
			assert.equal(stored.roundTrip.toolCallId, normalizedId);
		}
	});
});
