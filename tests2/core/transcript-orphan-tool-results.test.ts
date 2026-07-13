// Reproducing test (TDD red) for persisted Pi 0.80.6 histories poisoned by
// message-level toolResult records whose immediately preceding assistant turn
// does not contain the corresponding toolCall blocks.
//
// The two toolCallIds below are from the affected session sequence. These are
// raw Pi parent-linked JSONL records, not Bobbit's normalized display shape.
// Current behavior leaves both records in the active branch, causing Anthropic
// to reject every later turn with `unexpected tool_use_id`.
//
// Distinctive failure token: ORPHAN_TOOL_RESULTS_ACTIVE_BRANCH.

import { describe, expect, it } from "vitest";
import { sanitizeTranscriptContent } from "../../src/server/agent/transcript-sanitizer.ts";

const AFFECTED_TOOL_CALL_IDS = [
	"toolu_011XxjFHDfiTyzt8UgF2eVe2",
	"toolu_01A5tBKqT9crbozrVf5CujD8",
] as const;

const AFFECTED_PI_0806_SEQUENCE = [
	{
		type: "message",
		id: "msg-user-before-affected-turn",
		parentId: null,
		timestamp: "2026-07-12T19:41:17.101Z",
		message: {
			role: "user",
			content: [{ type: "text", text: "Inspect the current test performance." }],
			timestamp: 1783885277101,
		},
	},
	{
		type: "message",
		id: "msg-text-only-assistant",
		parentId: "msg-user-before-affected-turn",
		timestamp: "2026-07-12T19:41:18.202Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "I will inspect the relevant test data." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			timestamp: 1783885278202,
		},
	},
	{
		type: "message",
		id: "msg-orphan-tool-result-one",
		parentId: "msg-text-only-assistant",
		timestamp: "2026-07-12T19:41:18.303Z",
		message: {
			role: "toolResult",
			toolCallId: "toolu_011XxjFHDfiTyzt8UgF2eVe2",
			toolName: "read",
			content: [{ type: "text", text: "fixture result one" }],
			isError: false,
			timestamp: 1783885278303,
		},
	},
	{
		type: "message",
		id: "msg-orphan-tool-result-two",
		parentId: "msg-orphan-tool-result-one",
		timestamp: "2026-07-12T19:41:18.404Z",
		message: {
			role: "toolResult",
			toolCallId: "toolu_01A5tBKqT9crbozrVf5CujD8",
			toolName: "grep",
			content: [{ type: "text", text: "fixture result two" }],
			isError: false,
			timestamp: 1783885278404,
		},
	},
].map((entry) => JSON.stringify(entry)).join("\n") + "\n";

describe("sanitizeTranscriptContent — orphan Pi tool results", () => {
	it("removes the consecutive orphan results from the affected active-branch sequence", () => {
		const repaired = sanitizeTranscriptContent(AFFECTED_PI_0806_SEQUENCE);
		const remainingAffectedResults = repaired.content
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((entry) =>
				entry?.type === "message" &&
				entry.message?.role === "toolResult" &&
				AFFECTED_TOOL_CALL_IDS.includes(entry.message.toolCallId),
			)
			.map((entry) => entry.message.toolCallId);

		expect(
			remainingAffectedResults,
			"ORPHAN_TOOL_RESULTS_ACTIVE_BRANCH: orphan tool results remain on active branch",
		).toEqual([]);
	});
});
