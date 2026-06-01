/**
 * Unit tests for `spliceInFlightMessage` — the server-side helper that
 * splices a session's tracked `latestMessageUpdate` payload onto the
 * snapshot returned by `session.rpcClient.getMessages()`.
 *
 * See the H3 design doc on the goal.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spliceInFlightMessage, spliceInFlightSteers } from "../src/server/agent/splice-inflight-message.ts";

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

/**
 * Steer continuity splice — regression coverage for the dispatch→echo
 * window.
 *
 * `_dispatchSteer()` removes the queue row and broadcasts the empty queue
 * *before* awaiting `rpcClient.steer()`. The SDK eventually echoes the
 * text back as `message_end(role:user)`, but until then the agent's
 * `.jsonl` doesn't contain a user-message row for the steer. A
 * `get_messages` snapshot taken in that window must include the in-flight
 * steer text as a synthetic user row — otherwise the client sees neither
 * a queue pill nor a transcript row (the steer text appears to vanish
 * and reappear).
 */
describe("spliceInFlightSteers (steer continuity splice)", () => {
	const userRow = (id: string, text: string) => ({
		id,
		role: "user",
		content: [{ type: "text", text }],
	});
	const assistantRow = (id: string, text: string) => ({
		id,
		role: "assistant",
		content: [{ type: "text", text }],
	});

	it("returns input unchanged when ledger is undefined or empty", () => {
		const messages = [assistantRow("a1", "hi")];
		assert.strictEqual(spliceInFlightSteers(messages, undefined), messages);
		assert.strictEqual(spliceInFlightSteers(messages, []), messages);
	});

	it("appends synthetic user rows for each in-flight steer text", () => {
		const messages = [assistantRow("a1", "working...")];
		const out = spliceInFlightSteers(messages, ["please reroute", "also do X"]);
		assert.strictEqual(out.length, 3);
		assert.notStrictEqual(out, messages, "returns a new array when appending");
		assert.strictEqual(out[1].role, "user");
		assert.strictEqual(out[1].content[0].text, "please reroute");
		assert.match(out[1].id, /^inflight-steer:/);
		assert.strictEqual((out[1] as any)._inFlightSteer, true);
		assert.strictEqual(out[2].role, "user");
		assert.strictEqual(out[2].content[0].text, "also do X");
		assert.notStrictEqual(out[1].id, out[2].id);
	});

	it("is a no-op when the echo has already flushed to .jsonl (defensive dedup)", () => {
		const messages = [
			assistantRow("a1", "sure"),
			userRow("u-real", "please reroute"),
		];
		const out = spliceInFlightSteers(messages, ["please reroute"]);
		assert.strictEqual(out, messages, "no new row when text already present");
	});

	it("dedupes one entry but still splices distinct unrepresented ones", () => {
		const messages = [userRow("u1", "already echoed")];
		const out = spliceInFlightSteers(messages, ["already echoed", "not yet echoed"]);
		assert.strictEqual(out.length, 2);
		assert.strictEqual(out[1].content[0].text, "not yet echoed");
	});

	it("handles string-content user messages in the snapshot", () => {
		const messages = [{ id: "u1", role: "user", content: "please reroute" }];
		const out = spliceInFlightSteers(messages, ["please reroute"]);
		assert.strictEqual(out, messages);
	});

	it("recognises user-with-attachments role for dedup", () => {
		const messages = [
			{
				id: "u1",
				role: "user-with-attachments",
				content: [{ type: "text", text: "with file" }],
			},
		];
		const out = spliceInFlightSteers(messages, ["with file"]);
		assert.strictEqual(out, messages, "matches user-with-attachments text");
	});

	it("appended synthetic ids encode ledger position", () => {
		const out = spliceInFlightSteers([], ["first", "second", "third"]);
		assert.strictEqual(out.length, 3);
		assert.strictEqual(out[0].id, "inflight-steer:0:first");
		assert.strictEqual(out[1].id, "inflight-steer:1:second");
		assert.strictEqual(out[2].id, "inflight-steer:2:third");
	});

	it("is a no-op when given a non-array messages value", () => {
		const notArr: any = { messages: [] };
		assert.strictEqual(spliceInFlightSteers(notArr as any, ["x"]), notArr);
	});

	it("S42: two identical-text steers each splice a distinct row (multiset, not Set)", () => {
		const out = spliceInFlightSteers([], ["reroute", "reroute"]);
		// Master (Set-based) returned 1; multiset returns 2 distinct rows.
		assert.strictEqual(out.length, 2);
		assert.strictEqual(out[0].id, "inflight-steer:0:reroute");
		assert.strictEqual(out[1].id, "inflight-steer:1:reroute");
		assert.strictEqual(out[0].content[0].text, "reroute");
		assert.strictEqual(out[1].content[0].text, "reroute");
	});

	it("S42: one identical text already in the snapshot consumes exactly one ledger entry", () => {
		const messages = [{ role: "user", content: [{ type: "text", text: "reroute" }] }];
		const out = spliceInFlightSteers(messages, ["reroute", "reroute"]);
		// One real row + one spliced (the other is represented by the snapshot row).
		assert.strictEqual(out.length, 2);
		const synthetic = out.filter((m: any) => m._inFlightSteer);
		assert.strictEqual(synthetic.length, 1);
	});
});
