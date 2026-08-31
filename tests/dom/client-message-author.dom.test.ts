import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../../src/app/message-reducer.js";
import { LOCAL_USER_AUTHOR, type MessageAuthor } from "../../src/shared/message-author.js";

const AGENT_AUTHOR: MessageAuthor = {
	kind: "agent",
	id: "session:test-agent",
	label: "Test agent",
};

const SYSTEM_AUTHOR: MessageAuthor = {
	kind: "system",
	id: "system:bobbit",
	label: "Bobbit",
};

function textMessage(role: "user" | "assistant", text: string, author: MessageAuthor, id: string) {
	return {
		id,
		role,
		content: [{ type: "text", text }],
		timestamp: 1,
		author,
	};
}

function visibleText(message: Record<string, any>): string {
	return Array.isArray(message.content)
		? message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n")
		: String(message.message ?? message.content ?? "");
}

describe("client message author metadata", () => {
	it("preserves snapshot/live authors while optimistic reconciliation remains role/text based", () => {
		let state = initialState();
		state = reduce(state, {
			type: "optimistic-prompt",
			message: textMessage("user", "same prompt", LOCAL_USER_AUTHOR, "optimistic_1"),
		});
		expect(state.messages[0].author).toEqual(LOCAL_USER_AUTHOR);

		state = reduce(state, {
			type: "live-event",
			seq: 1,
			frame: {
				type: "message_end",
				message: textMessage("user", "same prompt", SYSTEM_AUTHOR, "server_1"),
			},
		});
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0].author).toEqual(SYSTEM_AUTHOR);

		state = reduce(state, {
			type: "snapshot",
			messages: [
				textMessage("user", "same prompt", SYSTEM_AUTHOR, "server_1"),
				textMessage("assistant", "reply", AGENT_AUTHOR, "assistant_1"),
			],
		});
		expect(state.messages.map((message) => message.author)).toEqual([
			SYSTEM_AUTHOR,
			AGENT_AUTHOR,
		]);
		expect(state.messages.map(visibleText)).toEqual(["same prompt", "reply"]);
		expect(state.messages.map(visibleText).join(" ")).not.toContain(SYSTEM_AUTHOR.label);
		expect(state.messages.map(visibleText).join(" ")).not.toContain(AGENT_AUTHOR.label);
	});

	it("preserves local-user identity on optimistic prompts and steers", () => {
		let state = initialState();
		state = reduce(state, {
			type: "optimistic-prompt",
			message: textMessage("user", "hello", LOCAL_USER_AUTHOR, "optimistic_1"),
		});
		state = reduce(state, {
			type: "optimistic-steer",
			message: textMessage("user", "redirect", LOCAL_USER_AUTHOR, "optimistic_2"),
		});

		expect(state.messages.map((message) => message.author)).toEqual([
			LOCAL_USER_AUTHOR,
			LOCAL_USER_AUTHOR,
		]);
		expect(state.messages.map(visibleText)).toEqual(["hello", "redirect"]);
	});

	it("retains author on finalized assistant rows", () => {
		const state = reduce(initialState(), {
			type: "live-event",
			seq: 2,
			frame: {
				type: "message_end",
				message: textMessage("assistant", "complete", AGENT_AUTHOR, "assistant_1"),
			},
		});
		expect(state.messages.at(-1)?.author).toEqual(AGENT_AUTHOR);
		expect(visibleText(state.messages.at(-1)!)).toBe("complete");
	});

	it("preserves client-created system-row identity without injecting its label into display text", () => {
		const notification = {
			id: "notification_1",
			role: "system-notification",
			message: "maintenance",
			author: SYSTEM_AUTHOR,
		};
		const state = reduce(initialState(), { type: "system-notification", message: notification });

		expect(state.messages[0].author).toEqual(SYSTEM_AUTHOR);
		expect(visibleText(state.messages[0])).toBe("maintenance");
		expect(visibleText(state.messages[0])).not.toContain(SYSTEM_AUTHOR.label);
	});
});
