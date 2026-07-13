import { describe, expect, it } from "vitest";
import "../../src/app/session-manager.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import { customConvertToLlm, createSystemNotification } from "../../src/app/custom-messages.js";
import { initialState, reduce } from "../../src/app/message-reducer.js";
import { defaultConvertToLlm } from "../../src/ui/components/Messages.js";
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
	});

	it("stamps optimistic prompts, steers, and offline queue rows as the local user", async () => {
		const agent = new RemoteAgent() as any;
		agent.ws = { readyState: 1, send: () => {} };

		await agent.prompt("hello");
		expect(agent.state.messages.at(-1)?.author).toEqual(LOCAL_USER_AUTHOR);

		agent.steer("redirect");
		expect(agent.state.messages.at(-1)?.author).toEqual(LOCAL_USER_AUTHOR);

		agent.reset();
		agent.ws = null;
		await agent.prompt("offline");
		expect(agent.getQueue()[0].author).toEqual(LOCAL_USER_AUTHOR);
		expect(agent.getQueue()[0].source).toBe("user");
	});

	it("retains author on in-flight updates and finalized assistant rows", () => {
		const agent = new RemoteAgent() as any;
		agent._highestSeq = 1;
		agent.handleAgentEvent({
			type: "message_update",
			message: textMessage("assistant", "streaming", AGENT_AUTHOR, "assistant_1"),
		});
		expect(agent.state.streamingMessage.author).toEqual(AGENT_AUTHOR);

		agent.handleAgentEvent({
			type: "message_end",
			message: textMessage("assistant", "complete", AGENT_AUTHOR, "assistant_1"),
		});
		expect(agent.state.messages.at(-1)?.author).toEqual(AGENT_AUTHOR);
	});

	it("stamps client-created system rows and strips author at Pi conversion boundaries", () => {
		const notification = createSystemNotification("maintenance");
		expect(notification.author).toEqual(SYSTEM_AUTHOR);

		const standard = defaultConvertToLlm([
			textMessage("assistant", "reply", AGENT_AUTHOR, "assistant_1") as any,
		]);
		expect(standard[0]).not.toHaveProperty("author");
		expect(standard[0]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "reply" }] });

		const custom = customConvertToLlm([notification as any]);
		expect(custom[0]).not.toHaveProperty("author");
		expect(custom[0]).toMatchObject({ role: "user", content: "<system>maintenance</system>" });
	});
});
