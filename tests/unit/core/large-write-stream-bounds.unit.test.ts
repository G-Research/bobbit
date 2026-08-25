import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { EventBuffer } from "../../../src/server/agent/event-buffer.js";
import { emitSessionEvent } from "../../../src/server/agent/session-manager.js";
import {
	LARGE_CONTENT_THRESHOLD,
	truncateLargeToolContent,
} from "../../../src/server/agent/truncate-large-content.js";

const LARGE_WRITE_BYTES = 256 * 1024;
const END_MARKER = "LARGE_WRITE_END_MARKER";

function largeWriteUpdate() {
	const content = `${"x".repeat(LARGE_WRITE_BYTES)}${END_MARKER}`;
	const message = {
		role: "assistant",
		id: "large-write-stream",
		content: [{
			type: "toolCall",
			id: "large-write-call",
			name: "write",
			arguments: { path: "large-output.txt", content },
		}],
	};
	return {
		content,
		event: {
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "x",
				partial: structuredClone(message),
			},
		},
	};
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

describe("large streamed write transport bounds", () => {
	it("truncates every cumulative assistant snapshot in a message_update", () => {
		const { content, event } = largeWriteUpdate();
		const projected = truncateLargeToolContent(event) as any;
		assert.equal(projected.message.content[0].arguments.content._truncated, true);
		assert.equal(
			projected.assistantMessageEvent.partial.content[0].arguments.content._truncated,
			true,
			"assistantMessageEvent.partial must not retain a second full copy of the growing write",
		);
		assert.ok(
			serializedBytes(projected) < LARGE_CONTENT_THRESHOLD,
			`projected live event must stay bounded; received ${serializedBytes(projected)} bytes`,
		);
		assert.doesNotMatch(JSON.stringify(projected), new RegExp(END_MARKER));
		assert.equal(
			(event.assistantMessageEvent.partial.content[0].arguments.content as string).length,
			content.length,
			"transport projection must not mutate Pi's original cumulative event",
		);
	});

	it("keeps both EventBuffer retention and capable-client wire frames bounded", () => {
		const { event } = largeWriteUpdate();
		const sent: string[] = [];
		const client = {
			readyState: 1,
			bufferedAmount: 0,
			assistantStreamDeltaCapable: true,
			assistantStreamDeltaNeedsBaseline: true,
			send(data: string) { sent.push(data); },
		};
		const session = {
			clients: new Set([client]) as any,
			eventBuffer: new EventBuffer(),
		};
		emitSessionEvent(session, truncateLargeToolContent(event));
		assert.equal(sent.length, 1);
		assert.ok(
			Buffer.byteLength(sent[0], "utf8") < LARGE_CONTENT_THRESHOLD,
			`live WebSocket frame must stay bounded; received ${Buffer.byteLength(sent[0], "utf8")} bytes`,
		);
		const retained = session.eventBuffer.getAll()[0]?.event;
		assert.ok(
			serializedBytes(retained) < LARGE_CONTENT_THRESHOLD,
			`EventBuffer entry must stay bounded; received ${serializedBytes(retained)} bytes`,
		);
		assert.doesNotMatch(sent[0], new RegExp(END_MARKER));
	});
});
