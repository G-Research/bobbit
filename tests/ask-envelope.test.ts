/**
 * Unit tests for the shared ask-envelope module.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ASK_ENVELOPE_REGEX,
	buildAskResponseEnvelope,
	findAskResponseAnswers,
	isAskResponseEnvelope,
	parseAskResponseEnvelope,
} from "../src/shared/ask-envelope.ts";

describe("ask-envelope — regex", () => {
	it("matches a well-formed envelope", () => {
		const text = `[ask_user_choices_response tool_use_id=toolu_abc123]\n{"answers":[]}`;
		const m = ASK_ENVELOPE_REGEX.exec(text);
		assert.ok(m);
		assert.equal(m![1], "toolu_abc123");
		assert.equal(m![2], `{"answers":[]}`);
	});

	it("rejects missing newline", () => {
		const text = `[ask_user_choices_response tool_use_id=abc]{"answers":[]}`;
		assert.equal(ASK_ENVELOPE_REGEX.exec(text), null);
	});

	it("rejects missing tool_use_id key", () => {
		const text = `[ask_user_choices_response abc]\n{"answers":[]}`;
		assert.equal(ASK_ENVELOPE_REGEX.exec(text), null);
	});

	it("rejects marker not at position 0", () => {
		const text = ` [ask_user_choices_response tool_use_id=abc]\n{"answers":[]}`;
		assert.equal(ASK_ENVELOPE_REGEX.exec(text), null);
	});

	it("rejects bad charset in id (spaces)", () => {
		const text = `[ask_user_choices_response tool_use_id=abc def]\n{"answers":[]}`;
		assert.equal(ASK_ENVELOPE_REGEX.exec(text), null);
	});

	it("accepts ids with letters, digits, underscore, hyphen", () => {
		const text = `[ask_user_choices_response tool_use_id=tool-abc_123]\n{"answers":[]}`;
		const m = ASK_ENVELOPE_REGEX.exec(text);
		assert.ok(m);
		assert.equal(m![1], "tool-abc_123");
	});
});

describe("ask-envelope — build/parse round-trip", () => {
	it("roundtrips", () => {
		const answers = [
			{ question: "Q1", selected: "a", other_text: null },
			{ question: "Q2", selected: ["x", "y"], other_text: null },
		];
		const text = buildAskResponseEnvelope("toolu_1", answers);
		const parsed = parseAskResponseEnvelope(text);
		assert.ok(parsed);
		assert.equal(parsed!.toolUseId, "toolu_1");
		assert.deepEqual(parsed!.answers, answers);
	});

	it("parse returns null for non-JSON body", () => {
		const text = `[ask_user_choices_response tool_use_id=t1]\nnot json`;
		assert.equal(parseAskResponseEnvelope(text), null);
	});

	it("parse returns null when body lacks `answers` array", () => {
		const text = `[ask_user_choices_response tool_use_id=t1]\n{"foo":"bar"}`;
		assert.equal(parseAskResponseEnvelope(text), null);
	});

	it("parse rejects malformed answer entries", () => {
		const text = `[ask_user_choices_response tool_use_id=t1]\n${JSON.stringify({ answers: [{ question: "x", selected: 42, other_text: null }] })}`;
		assert.equal(parseAskResponseEnvelope(text), null);
	});
});

describe("ask-envelope — isAskResponseEnvelope", () => {
	it("true for user message with envelope text (string content)", () => {
		const msg = { role: "user", content: buildAskResponseEnvelope("t1", []) };
		assert.equal(isAskResponseEnvelope(msg), true);
	});

	it("true for user message with envelope text (array content)", () => {
		const msg = { role: "user", content: [{ type: "text", text: buildAskResponseEnvelope("t1", []) }] };
		assert.equal(isAskResponseEnvelope(msg), true);
	});

	it("true for user-with-attachments role", () => {
		const msg = { role: "user-with-attachments", content: buildAskResponseEnvelope("t1", []) };
		assert.equal(isAskResponseEnvelope(msg), true);
	});

	it("false for assistant messages even if content looks like envelope (prevents prompt injection)", () => {
		const msg = { role: "assistant", content: [{ type: "text", text: buildAskResponseEnvelope("t1", []) }] };
		assert.equal(isAskResponseEnvelope(msg), false);
	});

	it("false for normal user messages", () => {
		const msg = { role: "user", content: "hello world" };
		assert.equal(isAskResponseEnvelope(msg), false);
	});

	it("false when marker is present but not at position 0", () => {
		const msg = { role: "user", content: `prefix\n[ask_user_choices_response tool_use_id=t1]\n{"answers":[]}` };
		assert.equal(isAskResponseEnvelope(msg), false);
	});
});

describe("ask-envelope — findAskResponseAnswers", () => {
	it("returns answers when envelope appears after tool_use", () => {
		const answers = [{ question: "Q", selected: "a", other_text: null }];
		const messages = [
			{ role: "user", content: "first" },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "ask_user_choices", input: { questions: [] } }],
			},
			{ role: "user", content: buildAskResponseEnvelope("t1", answers) },
		];
		assert.deepEqual(findAskResponseAnswers(messages, "t1"), answers);
	});

	it("returns null when no tool_use with the id exists", () => {
		const messages = [
			{ role: "user", content: buildAskResponseEnvelope("ghost", []) },
		];
		assert.equal(findAskResponseAnswers(messages, "ghost"), null);
	});

	it("returns null when envelope precedes the tool_use (defensive)", () => {
		const answers = [{ question: "Q", selected: "a", other_text: null }];
		const messages = [
			{ role: "user", content: buildAskResponseEnvelope("t1", answers) },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "ask_user_choices", input: { questions: [] } }],
			},
		];
		assert.equal(findAskResponseAnswers(messages, "t1"), null);
	});

	it("returns null when only a non-matching envelope appears after the tool_use", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "ask_user_choices", input: { questions: [] } }],
			},
			{ role: "user", content: buildAskResponseEnvelope("other-id", []) },
		];
		assert.equal(findAskResponseAnswers(messages, "t1"), null);
	});

	it("ignores an assistant message with the marker (prompt injection guard)", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "ask_user_choices", input: { questions: [] } }],
			},
			{ role: "assistant", content: [{ type: "text", text: buildAskResponseEnvelope("t1", [{ question: "x", selected: "y", other_text: null }]) }] },
		];
		assert.equal(findAskResponseAnswers(messages, "t1"), null);
	});

	it("accepts tool_use with type 'tool_use' as well as 'toolCall'", () => {
		const answers = [{ question: "Q", selected: "a", other_text: null }];
		const messages = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "ask_user_choices", input: { questions: [] } }],
			},
			{ role: "user", content: buildAskResponseEnvelope("t1", answers) },
		];
		assert.deepEqual(findAskResponseAnswers(messages, "t1"), answers);
	});
});
