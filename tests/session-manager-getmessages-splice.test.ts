/**
 * Unit tests for `spliceInFlightMessage` — the server-side helper that
 * splices a session's tracked `latestMessageUpdate` payload onto the
 * snapshot returned by `session.rpcClient.getMessages()`.
 *
 * See the H3 design doc on the goal.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spliceInFlightMessage } from "../src/server/agent/splice-inflight-message.ts";

describe("spliceInFlightMessage (H3 server splice)", () => {
	const baseRow = (id: string, text: string) => ({
		id,
		role: "assistant",
		content: [{ type: "text", text }],
	});

	it("returns input unchanged when latest is undefined", () => {
		const messages = [baseRow("a1", "hello")];
		const out = spliceInFlightMessage(messages, undefined);
		assert.strictEqual(out, messages, "no copy when latest is undefined");
	});

	it("returns input unchanged when latest.message has empty content", () => {
		const messages = [baseRow("a1", "hello")];
		const out = spliceInFlightMessage(messages, {
			id: "a-live",
			message: { id: "a-live", role: "assistant", content: [] },
		});
		assert.strictEqual(out, messages);

		const out2 = spliceInFlightMessage(messages, {
			id: "a-live",
			message: { id: "a-live", role: "assistant", content: "" },
		});
		assert.strictEqual(out2, messages);
	});

	it("appends in-flight message when no row matches the id", () => {
		const messages = [baseRow("a1", "hello")];
		const inFlight = baseRow("a-live", "streaming...");
		const out = spliceInFlightMessage(messages, { id: "a-live", message: inFlight });
		assert.strictEqual(out.length, 2);
		assert.strictEqual(out[0].id, "a1");
		assert.strictEqual(out[1].id, "a-live");
		assert.notStrictEqual(out, messages, "must return a new array");
	});

	it("replaces in place when a row already has the same id (defensive path)", () => {
		const messages = [baseRow("a1", "hello"), baseRow("a-live", "stale partial")];
		const updated = baseRow("a-live", "fresher partial");
		const out = spliceInFlightMessage(messages, { id: "a-live", message: updated });
		assert.strictEqual(out.length, 2);
		assert.strictEqual(out[0].id, "a1");
		assert.strictEqual(out[1], updated, "row replaced with latest payload");
		assert.notStrictEqual(out, messages, "must return a new array");
	});

	it("appends when latest.id is undefined (no id-match short-circuit)", () => {
		const messages = [baseRow("a1", "hello")];
		const inFlight = { role: "assistant", content: [{ type: "text", text: "no id" }] };
		const out = spliceInFlightMessage(messages, { id: undefined, message: inFlight });
		assert.strictEqual(out.length, 2);
		assert.strictEqual(out[1], inFlight);
	});

	it("string-content message is treated as having content when non-empty", () => {
		const messages: any[] = [];
		const inFlight = { id: "a-live", role: "assistant", content: "streaming text" };
		const out = spliceInFlightMessage(messages, { id: "a-live", message: inFlight });
		assert.strictEqual(out.length, 1);
		assert.strictEqual(out[0], inFlight);
	});
});
