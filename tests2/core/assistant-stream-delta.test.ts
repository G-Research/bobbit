import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	compactAssistantStreamDelta,
	parsePartialToolArguments,
	PiAssistantStreamNormalizer,
	reconstructAssistantStreamDelta,
} from "../../src/shared/assistant-stream-delta.ts";

type AnyObject = Record<string, any>;

const usage = {
	input: 3,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};

function message(content: AnyObject[] = []): AnyObject {
	return {
		role: "assistant",
		id: "message-7",
		author: { kind: "agent", id: "session-reviewer", label: "Reviewer" },
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage,
		stopReason: "stop",
		timestamp: 1_735_000_000_000,
	};
}

function update(messageValue: AnyObject, assistantMessageEvent: AnyObject): AnyObject {
	const snapshot = structuredClone(messageValue);
	return {
		type: "message_update",
		sequence: 42,
		message: snapshot,
		assistantMessageEvent: { ...assistantMessageEvent, partial: structuredClone(snapshot) },
	};
}

function withoutTransportPartialJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutTransportPartialJson);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "partialJson")
			.map(([key, item]) => [key, withoutTransportPartialJson(item)]),
	);
}

function roundTrip(events: AnyObject[]): AnyObject[] {
	let previous: AnyObject | undefined;
	return events.map((original, index) => {
		const compact = compactAssistantStreamDelta(original, previous) as AnyObject;
		assert.equal(compact.assistantStreamDelta, 1);
		assert.equal("message" in compact, false);
		assert.equal("partial" in compact.assistantMessageEvent, false);
		assert.equal("assistantMessageBaseline" in compact, index === 0);
		const reconstructed = reconstructAssistantStreamDelta(compact, previous) as AnyObject;
		assert.deepEqual(withoutTransportPartialJson(reconstructed), withoutTransportPartialJson(original));
		previous = reconstructed.message;
		return compact;
	});
}

describe("assistant stream delta compaction", () => {
	it("reconstructs Pi delta-only text and defers final content to terminal authority", () => {
		const normalizer = new PiAssistantStreamNormalizer();
		const baseline = message([]);
		normalizer.normalize({ type: "message_start", message: baseline });

		const start = normalizer.normalize({
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		}) as AnyObject;
		const first = normalizer.normalize({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "first" },
		}) as AnyObject;
		const second = normalizer.normalize({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " + second" },
		}) as AnyObject;

		assert.equal(start.message.content[0].text, "");
		assert.equal(first.message.content[0].text, "first");
		assert.equal(second.message.content[0].text, "first + second");
		assert.deepEqual(second.assistantMessageEvent.partial, second.message);

		const terminal: AnyObject = {
			type: "message_end",
			message: { ...message([{ type: "text", text: "exact provider terminal" }]), stopReason: "stop" },
		};
		assert.strictEqual(normalizer.normalize(terminal), terminal);
		assert.equal(terminal.message.content[0].text, "exact provider terminal");
		assert.equal(
			"message" in (normalizer.normalize({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "orphan" },
			}) as AnyObject),
			false,
			"terminal must reset the reconstruction baseline",
		);
	});

	it("round-trips text start, deltas, and end while preserving baseline metadata", () => {
		const current = message([{ type: "text", text: "" }]);
		const events = [update(current, { type: "text_start", contentIndex: 0 })];
		current.content[0].text = "Hello";
		events.push(update(current, { type: "text_delta", contentIndex: 0, delta: "Hello" }));
		current.content[0].text = "Hello world";
		events.push(update(current, { type: "text_delta", contentIndex: 0, delta: " world" }));
		current.content[0].textSignature = "signed-text";
		events.push(update(current, { type: "text_end", contentIndex: 0, content: "Hello world" }));

		const compact = roundTrip(events);
		assert.deepEqual(compact[0].assistantMessageBaseline.author, current.author);
		assert.equal(compact[0].assistantMessageBaseline.id, "message-7");
		assert.equal(compact[0].assistantMessageBaseline.model, "claude-test");
		assert.equal(compact[0].assistantMessageBaseline.timestamp, 1_735_000_000_000);
	});

	it("round-trips thinking blocks including end-only metadata", () => {
		const current = message([{ type: "thinking", thinking: "" }]);
		const events = [update(current, { type: "thinking_start", contentIndex: 0 })];
		current.content[0].thinking = "Check";
		events.push(update(current, { type: "thinking_delta", contentIndex: 0, delta: "Check" }));
		current.content[0].thinking = "Check constraints";
		events.push(update(current, { type: "thinking_delta", contentIndex: 0, delta: " constraints" }));
		current.content[0].thinkingSignature = "opaque-thinking";
		current.content[0].redacted = false;
		events.push(update(current, { type: "thinking_end", contentIndex: 0, content: "Check constraints" }));

		roundTrip(events);
	});

	it("tolerantly rebuilds progressive tool-call JSON and closes with the exact tool call", () => {
		assert.deepEqual(parsePartialToolArguments('{"path":"src/assi'), { path: "src/assi" });
		assert.deepEqual(parsePartialToolArguments('{"path":"src/a.ts","flags":[true,2'), {
			path: "src/a.ts",
			flags: [true, 2],
		});

		const tool: AnyObject = { type: "toolCall", id: "call-1", name: "edit", arguments: {} };
		const current = message([tool]);
		const events = [update(current, { type: "toolcall_start", contentIndex: 0 })];
		let json = "";
		for (const delta of ['{"path":"src/assi', 'stant-stream.ts","flags":[tru', 'e,2],"nested":{"ok":"yes"}}']) {
			json += delta;
			tool.arguments = parsePartialToolArguments(json);
			events.push(update(current, { type: "toolcall_delta", contentIndex: 0, delta }));
		}
		tool.arguments = { path: "src/assistant-stream.ts", flags: [true, 2], nested: { ok: "yes" } };
		tool.thoughtSignature = "tool-signature";
		events.push(update(current, {
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: structuredClone(tool),
		}));

		roundTrip(events);
	});

	it("forces a self-contained progressive tool baseline from reconstructed session state", () => {
		const tool: AnyObject = { type: "toolCall", id: "call-attach", name: "edit", arguments: {} };
		const current = message([tool]);
		const start = update(current, { type: "toolcall_start", contentIndex: 0 });
		const compactStart = compactAssistantStreamDelta(start) as AnyObject;
		let previous = (reconstructAssistantStreamDelta(compactStart) as AnyObject).message;

		const fragments = ['{"path":"src/assi', 'stant.ts","flags":[tru', 'e]}'];
		let json = fragments[0];
		tool.arguments = parsePartialToolArguments(json);
		const firstDelta = update(current, { type: "toolcall_delta", contentIndex: 0, delta: fragments[0] });
		const compactFirst = compactAssistantStreamDelta(firstDelta, previous) as AnyObject;
		previous = (reconstructAssistantStreamDelta(compactFirst, previous) as AnyObject).message;

		json += fragments[1];
		tool.arguments = parsePartialToolArguments(json);
		const attachDelta = update(current, { type: "toolcall_delta", contentIndex: 0, delta: fragments[1] });
		const selfContained = compactAssistantStreamDelta(attachDelta, previous, { selfContained: true }) as AnyObject;
		assert.equal(selfContained.assistantStreamDelta, 1);
		assert.equal("message" in selfContained, false);
		assert.equal(selfContained.assistantMessageBaseline.content[0].partialJson, fragments[0]);
		const attached = reconstructAssistantStreamDelta(selfContained) as AnyObject;
		assert.deepEqual(withoutTransportPartialJson(attached), withoutTransportPartialJson(attachDelta));
		assert.equal(attached.message.content[0].partialJson, json);

		json += fragments[2];
		tool.arguments = parsePartialToolArguments(json);
		const nextDelta = update(current, { type: "toolcall_delta", contentIndex: 0, delta: fragments[2] });
		const steady = compactAssistantStreamDelta(nextDelta, attached.message) as AnyObject;
		assert.equal(steady.assistantStreamDelta, 1);
		assert.equal("assistantMessageBaseline" in steady, false);
		const continued = reconstructAssistantStreamDelta(steady, attached.message) as AnyObject;
		assert.deepEqual(continued.message.content[0].arguments, { path: "src/assistant.ts", flags: [true] });
		assert.equal(continued.message.content[0].partialJson, json);
	});

	it("round-trips mixed text, thinking, and tool blocks", () => {
		const current = message([{ type: "thinking", thinking: "" }]);
		const events = [update(current, { type: "thinking_start", contentIndex: 0 })];
		current.content[0].thinking = "Plan";
		events.push(update(current, { type: "thinking_delta", contentIndex: 0, delta: "Plan" }));
		events.push(update(current, { type: "thinking_end", contentIndex: 0, content: "Plan" }));

		current.content.push({ type: "text", text: "" });
		events.push(update(current, { type: "text_start", contentIndex: 1 }));
		current.content[1].text = "Calling a tool";
		events.push(update(current, { type: "text_delta", contentIndex: 1, delta: "Calling a tool" }));
		events.push(update(current, { type: "text_end", contentIndex: 1, content: "Calling a tool" }));

		const tool = { type: "toolCall", id: "call-mixed", name: "read", arguments: {} };
		current.content.push(tool);
		events.push(update(current, { type: "toolcall_start", contentIndex: 2 }));
		tool.arguments = { path: "README.md" };
		events.push(update(current, { type: "toolcall_delta", contentIndex: 2, delta: '{"path":"README.md"}' }));
		events.push(update(current, { type: "toolcall_end", contentIndex: 2, toolCall: structuredClone(tool) }));

		roundTrip(events);
	});

	it("compacts Bobbit-author-enriched messages when Pi partials omit only that transport metadata", () => {
		const enriched = update(message([{ type: "text", text: "Hello" }]), {
			type: "text_delta",
			contentIndex: 0,
			delta: "Hello",
		});
		delete enriched.assistantMessageEvent.partial.author;

		const compact = compactAssistantStreamDelta(enriched) as AnyObject;
		assert.equal(compact.assistantStreamDelta, 1);
		const reconstructed = reconstructAssistantStreamDelta(compact) as AnyObject;
		assert.deepEqual(reconstructed.message.author, enriched.message.author);
		assert.equal(reconstructed.message.content[0].text, "Hello");
	});

	it("returns unsupported or non-convergent events unchanged", () => {
		const unsupported = update(message([{ type: "image", data: "abc" }]), {
			type: "image_delta",
			contentIndex: 0,
			delta: "abc",
		});
		assert.equal(compactAssistantStreamDelta(unsupported), unsupported);

		const inconsistent = update(message([{ type: "text", text: "not-the-delta" }]), {
			type: "text_delta",
			contentIndex: 0,
			delta: "different",
		});
		assert.equal(compactAssistantStreamDelta(inconsistent), inconsistent);

		const mismatchedPartial = update(message([{ type: "text", text: "x" }]), {
			type: "text_delta",
			contentIndex: 0,
			delta: "x",
		});
		mismatchedPartial.assistantMessageEvent.partial.model = "other-model";
		assert.equal(compactAssistantStreamDelta(mismatchedPartial), mismatchedPartial);
	});

	it("substantially reduces serialized bytes for a 64KB cumulative text stream", () => {
		const chunk = "x".repeat(1024);
		const current = message([{ type: "text", text: "" }]);
		const events = [update(current, { type: "text_start", contentIndex: 0 })];
		for (let index = 0; index < 64; index++) {
			current.content[0].text += chunk;
			events.push(update(current, { type: "text_delta", contentIndex: 0, delta: chunk }));
		}
		events.push(update(current, { type: "text_end", contentIndex: 0, content: current.content[0].text }));
		const originalBytes = events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0);
		const compact = roundTrip(events);
		const compactBytes = compact.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0);

		assert.ok(compactBytes < originalBytes * 0.05, `${compactBytes} should be under 5% of ${originalBytes}`);
	});
});
