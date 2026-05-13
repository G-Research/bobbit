/**
 * Regression test for the "duplicate Thinking... bubble after reconnect" bug.
 *
 * Repro:
 *   1. Mid-turn, the server emits `message_update` with an assistant message
 *      whose content is just a thinking chunk. `RemoteAgent` stores it on
 *      `_state.streamingMessage`; `StreamingMessageContainer` renders it.
 *   2. The WebSocket drops (or the tab is backgrounded, or we otherwise
 *      resync via a fresh `messages` snapshot).
 *   3. Snapshot arrives carrying the completed assistant row in the message
 *      list. `RemoteAgent` clears `streamingMessageId` but leaves
 *      `_state.streamingMessage` untouched.
 *   4. The snapshot handler emits synthetic `message_end` frames for each
 *      message. `AgentInterface`'s `message_end` listener reads
 *      `state.streamingMessage`; it's still non-null, so it does NOT call
 *      `streamingContainer.setMessage(null, true)`.
 *   5. Result: the streaming container keeps rendering the stale partial
 *      (a lone "Thinking..." block), while the completed message renders in
 *      the message list — visually a duplicate Thinking bubble at the tail of
 *      an idle chat. Only a hard page reload clears it.
 *
 * Fix: clear `_state.streamingMessage = null` in the snapshot path, alongside
 * `streamingMessageId`. A still-in-flight turn will repopulate it via the
 * next live `message_update`; a finished turn produces no further updates
 * and the container correctly shows nothing.
 *
 * This test is a source-level pin: rather than wire up the full RemoteAgent
 * (which requires a live WebSocket harness), it scans the snapshot path in
 * `src/app/remote-agent.ts` and asserts the clear is present.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve("src/app/remote-agent.ts");

test("snapshot path in remote-agent.ts clears _state.streamingMessage", () => {
	const text = fs.readFileSync(SRC, "utf8");

	// Locate the `case "messages":` branch (the snapshot handler).
	const caseIdx = text.indexOf("case \"messages\":");
	assert.notEqual(caseIdx, -1, "expected `case \"messages\":` branch in remote-agent.ts");

	// Take a window from `case "messages":` to the next `case ` at the same
	// switch depth. The handler is long; 4000 chars is a comfortable upper
	// bound.
	const windowEnd = text.indexOf("\n\t\t\tcase \"", caseIdx + 20);
	const windowText = text.slice(caseIdx, windowEnd === -1 ? caseIdx + 4000 : windowEnd);

	assert.match(
		windowText,
		/this\._state\.streamingMessage\s*=\s*null/,
		"snapshot handler must clear `_state.streamingMessage` — otherwise a stale partial " +
			"from a pre-disconnect `message_update` keeps rendering in the StreamingMessage" +
			"Container alongside the completed message, producing the duplicate Thinking " +
			"bubble bug.",
	);
	// Belt-and-braces: ensure the clear is paired with the existing
	// `streamingMessageId = undefined` clear so they can't drift apart.
	assert.match(
		windowText,
		/this\.streamingMessageId\s*=\s*undefined/,
		"existing `streamingMessageId = undefined` clear must remain in the snapshot path",
	);
});
