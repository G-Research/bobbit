import { describe, expect, it } from "vitest";

import { adaptSdkSessionMessages } from "../../src/server/agent/claude-agent-sdk-history-adapter.ts";
import type { SdkSessionMessage } from "../../src/server/agent/claude-agent-sdk-session-access.ts";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

function sdkMessage(
	type: SdkSessionMessage["type"],
	uuid: string,
	message: unknown,
): SdkSessionMessage {
	return {
		type,
		uuid,
		session_id: SESSION_ID,
		message,
		parent_tool_use_id: null,
		parent_agent_id: null,
	};
}

describe("Claude SDK history adapter", () => {
	it("omits orphan and already-hidden tool-result-only user frames", () => {
		const snapshot = adaptSdkSessionMessages([
			sdkMessage("assistant", "assistant", {
				content: [{ type: "text", text: "No tool call was made." }],
			}),
			sdkMessage("user", "orphan-result", {
				content: [{ type: "tool_result", tool_use_id: "missing", content: "orphan output" }],
			}),
			sdkMessage("assistant", "tool-call", {
				content: [{ type: "tool_use", id: "read-1", name: "Read", input: { path: "a.txt" } }],
			}),
			sdkMessage("user", "visible-result", {
				content: [{ type: "tool_result", tool_use_id: "read-1", content: "file contents" }],
			}),
			sdkMessage("user", "hidden-result", {
				content: [
					{ type: "tool_result", tool_use_id: "read-1", content: "duplicate output" },
					{ type: "text", text: "   " },
				],
			}),
		]);

		expect(snapshot.map((row) => ({ id: row.id, role: row.role }))).toEqual([
			{ id: "assistant", role: "assistant" },
			{ id: "tool-call", role: "assistant" },
			{ id: "visible-result", role: "toolResult" },
		]);
		expect(snapshot.some((row) => row.id === "orphan-result" || row.id === "hidden-result")).toBe(false);
	});

	it("preserves normal user prompts and translated tool results", () => {
		const snapshot = adaptSdkSessionMessages([
			sdkMessage("user", "prompt", { content: "Read a.txt" }),
			sdkMessage("assistant", "tool-call", {
				content: [{ type: "tool_use", id: "read-1", name: "Read", input: { path: "a.txt" } }],
			}),
			sdkMessage("user", "tool-result", {
				content: [{ type: "tool_result", tool_use_id: "read-1", content: "file contents" }],
			}),
		]);

		expect(snapshot.map((row) => ({ id: row.id, role: row.role }))).toEqual([
			{ id: "prompt", role: "user" },
			{ id: "tool-call", role: "assistant" },
			{ id: "tool-result", role: "toolResult" },
		]);
		expect(snapshot[0]?.content).toBe("Read a.txt");
		expect(snapshot[2]).toMatchObject({ toolCallId: "read-1", toolName: "Read" });
	});

	it("keeps mixed user content through the conservative fallback", () => {
		const content = [
			{ type: "tool_result", tool_use_id: "missing", content: "unmatched output" },
			{ type: "text", text: "Continue with the real prompt." },
		];
		const snapshot = adaptSdkSessionMessages([
			sdkMessage("user", "mixed", { content }),
		]);

		expect(snapshot).toHaveLength(1);
		expect(snapshot[0]).toMatchObject({ id: "mixed", role: "user", content });
	});
});
