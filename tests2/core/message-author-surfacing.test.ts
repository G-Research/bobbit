import { describe, expect, it } from "vitest";
import {
	formatDisplayAuthorId,
	isAccountablePromptMessage,
	isToolResultOnlyMessage,
	normalizeMessageAuthorLabel,
	sanitizeAuthorIdComponent,
	type MessageAuthor,
} from "../../src/shared/message-author.ts";
import { modelPrefixForPromptAuthor } from "../../src/server/agent/message-author.ts";

describe("message author surfacing formatters", () => {
	it("sanitizes identity components with the existing stable construction rules", () => {
		expect(sanitizeAuthorIdComponent("  Test Coordinator / One  ")).toBe("test-coordinator-one");
		expect(sanitizeAuthorIdComponent("---", "Fallback Value")).toBe("fallback-value");
		expect(sanitizeAuthorIdComponent("abcdefgh", "unknown", 6)).toBe("abcdef");
	});

	it("normalizes labels onto one safe line without mutating author metadata", () => {
		const author = Object.freeze({
			kind: "agent" as const,
			id: "session:1ae73f53-dc48",
			label: "  Test\u0000\n Coordinator\u0085  ",
		});
		const originalLabel = author.label;

		expect(normalizeMessageAuthorLabel(author.label)).toBe("Test Coordinator");
		expect(author.label).toBe(originalLabel);
		expect(normalizeMessageAuthorLabel("\u0000\u001f\u0080")).toBeUndefined();
		expect(normalizeMessageAuthorLabel(123)).toBeUndefined();
	});

	it("formats deterministic user, session, and staff display ids", () => {
		expect(formatDisplayAuthorId({
			kind: "user",
			id: "user:username23",
			label: "User",
		})).toBe("username23");
		expect(formatDisplayAuthorId({
			kind: "agent",
			id: "session:1ae73f53-dc48-4ca4",
			label: "Coordinator",
		})).toBe("1ae73f");
		expect(formatDisplayAuthorId({
			kind: "agent",
			id: "staff:Test Coordinator",
			label: "Coordinator",
		})).toBe("test-c");
		expect(formatDisplayAuthorId({
			kind: "system",
			id: "system:bobbit",
			label: "Bobbit",
		})).toBeUndefined();
	});

	it("degrades safely for invalid or unusable display ids", () => {
		expect(formatDisplayAuthorId({
			kind: "agent",
			id: "session:!!!",
			label: "Coordinator",
		})).toBeUndefined();
		expect(formatDisplayAuthorId({
			kind: "agent",
			id: "session:",
			label: "Coordinator",
		})).toBeUndefined();
		expect(formatDisplayAuthorId({ kind: "tool" } as unknown as MessageAuthor)).toBeUndefined();
	});

	it("accepts only prompt rows that are not tool-result-only payloads", () => {
		expect(isAccountablePromptMessage({ role: "user", content: "hello" })).toBe(true);
		expect(isAccountablePromptMessage({
			role: "user-with-attachments",
			content: [{ type: "text", text: "photo" }],
		})).toBe(true);
		expect(isAccountablePromptMessage({ role: "assistant", content: "answer" })).toBe(false);
		expect(isAccountablePromptMessage({ role: "toolResult", content: "result" })).toBe(false);

		const toolOnly = {
			role: "user",
			content: [
				{ type: "tool_result", content: "result" },
				{ type: "text", text: "  " },
			],
		};
		expect(isToolResultOnlyMessage(toolOnly)).toBe(true);
		expect(isAccountablePromptMessage(toolOnly)).toBe(false);
		expect(isAccountablePromptMessage({
			...toolOnly,
			content: [...toolOnly.content, { type: "text", text: "human follow-up" }],
		})).toBe(true);
	});

	it("never prefixes human authors and uses the exact system prefix", () => {
		expect(modelPrefixForPromptAuthor({
			kind: "user",
			id: "user:username23",
			label: "User",
		})).toBeUndefined();
		expect(modelPrefixForPromptAuthor({
			kind: "system",
			id: "system:bobbit:batch",
			label: "Ignored system label",
		})).toBe("[System]: ");
	});

	it("formats an exact normalized agent prefix and rejects unsafe metadata", () => {
		expect(modelPrefixForPromptAuthor({
			kind: "agent",
			id: "session:1ae73f53-dc48",
			label: "  Test\n Coordinator ",
		})).toBe("[Test Coordinator (1ae73f)]: ");
		expect(modelPrefixForPromptAuthor({
			kind: "agent",
			id: "session:!!!",
			label: "Coordinator",
		})).toBeUndefined();
		expect(modelPrefixForPromptAuthor({
			kind: "agent",
			id: "session:1ae73f",
			label: "\u0000",
		})).toBeUndefined();
		expect(modelPrefixForPromptAuthor({ kind: "agent", id: 123, label: "Agent" })).toBeUndefined();
	});
});
