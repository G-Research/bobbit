/**
 * Reproducer for the `bash_bg.wait` toolCall card dual-render bug.
 *
 * When an assistant `message_end` arrives without a string `id` (id is
 * undefined / null / numeric), `RemoteAgent` sets `streamingMessageId =
 * undefined`. Then the visible-messages filter in `AgentInterface.ts:919`
 * short-circuits (`!streamingMessageId` truthy) and never hides the in-flight
 * row, so the same message renders twice (MessageList + StreamingMessageContainer).
 *
 * Fix: fall back to a synthetic id derived from the first toolCall.id, e.g.
 * `synth:tc:<toolCallId>`, when `msg.id` is missing.
 *
 * Today: tests #1 + #2 pass (baseline + auto-correct). Tests #3 #4 #5 fail with
 * the helper returning `undefined` instead of the expected `synth:tc:tc-1`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeStreamingMessageId } from "../src/app/streaming-message-id.ts";

// Mirrors the visible-messages filter in `src/ui/components/AgentInterface.ts` ~L919.
function visibleMessagesFilter(
	messages: Array<{ id?: unknown }>,
	streamingMessageId: string | undefined,
): Array<{ id?: unknown }> {
	return messages.filter((m) => !streamingMessageId || m.id !== streamingMessageId);
}

const toolCallBlock = (id: string) => ({ type: "toolCall", id, name: "bash_bg", input: { action: "wait", id: "bg-1" } });

describe("dual-render bug: assistant message_end without string id", () => {
	it("baseline: id is non-empty string \u2192 streamingMessageId set, filter hides in-flight row", () => {
		const msg = { id: "msg-abc", role: "assistant", content: [toolCallBlock("tc-1")] };
		const sid = computeStreamingMessageId(msg);
		assert.equal(sid, "msg-abc");

		// State has the in-flight row mirrored from the streaming container.
		const messages = [{ id: "msg-abc" }];
		const visible = visibleMessagesFilter(messages, sid);
		assert.equal(visible.length, 0, "in-flight row must be hidden by the filter");
	});

	it("auto-correct: after streamingMessage cleared by next event, exactly one card remains", () => {
		const msg = { id: "msg-abc", role: "assistant", content: [toolCallBlock("tc-1")] };
		const sid = computeStreamingMessageId(msg);
		const messages = [{ id: "msg-abc" }];

		// MessageList renders `visible`, StreamingMessageContainer renders the
		// in-flight msg while sid is set. Sum = 1 card.
		let cardsRendered = visibleMessagesFilter(messages, sid).length + (sid ? 1 : 0);
		assert.equal(cardsRendered, 1, "during streaming exactly one card");

		// Next event clears the streaming container \u2192 sid becomes undefined,
		// MessageList now shows the row.
		const sidAfter: string | undefined = undefined;
		cardsRendered = visibleMessagesFilter(messages, sidAfter).length + (sidAfter ? 1 : 0);
		assert.equal(cardsRendered, 1, "after reconciliation still exactly one card");
	});

	it("bug: id is undefined \u2192 must fall back to synth:tc:<toolCallId>", () => {
		const msg = { id: undefined, role: "assistant", content: [toolCallBlock("tc-1")] };
		const sid = computeStreamingMessageId(msg);
		assert.equal(sid, "synth:tc:tc-1", "expected synthetic id derived from first toolCall.id");

		// Reducer/live-event path must stamp the same synthetic id on the row.
		const messages = [{ id: "synth:tc:tc-1" }];
		const visible = visibleMessagesFilter(messages, sid);
		assert.equal(visible.length, 0, "filter must hide the in-flight row \u2014 only one card should render");
	});

	it("bug: id is null \u2192 must fall back to synth:tc:<toolCallId>", () => {
		const msg = { id: null, role: "assistant", content: [toolCallBlock("tc-1")] };
		const sid = computeStreamingMessageId(msg);
		assert.equal(sid, "synth:tc:tc-1", "expected synthetic id derived from first toolCall.id");

		const messages = [{ id: "synth:tc:tc-1" }];
		const visible = visibleMessagesFilter(messages, sid);
		assert.equal(visible.length, 0, "filter must hide the in-flight row \u2014 only one card should render");
	});

	it("bug: id is numeric 42 \u2192 must fall back to synth:tc:<toolCallId>", () => {
		const msg = { id: 42, role: "assistant", content: [toolCallBlock("tc-1")] };
		const sid = computeStreamingMessageId(msg);
		assert.equal(sid, "synth:tc:tc-1", "expected synthetic id derived from first toolCall.id");

		const messages = [{ id: "synth:tc:tc-1" }];
		const visible = visibleMessagesFilter(messages, sid);
		assert.equal(visible.length, 0, "filter must hide the in-flight row \u2014 only one card should render");
	});
});
