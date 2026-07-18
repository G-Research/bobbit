import { describe, expect, it } from "vitest";

import {
	mergeAuthorSidecarIntoMessages,
	type PromptAuthorBinding,
} from "../../src/server/agent/author-sidecar.ts";
import { spliceInFlightSteers } from "../../src/server/agent/splice-inflight-message.ts";
import { LOCAL_USER_AUTHOR, type MessageAuthor } from "../../src/shared/message-author.ts";

const SYSTEM_AUTHOR: MessageAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" };
const AGENT_AUTHOR: MessageAuthor = { kind: "agent", id: "session:relay", label: "Relay" };

function userRow(id: string, text: string, author: MessageAuthor = LOCAL_USER_AUTHOR) {
	return { id, role: "user", content: [{ type: "text", text }], author };
}

function steer(text: string, promptId: string, author: MessageAuthor = SYSTEM_AUTHOR) {
	return { text, promptId, source: author.kind === "agent" ? "agent" as const : "system" as const, author };
}

function binding(
	promptId: string,
	text: string,
	messageId?: string,
	messageTimestamp?: number,
	author: MessageAuthor = SYSTEM_AUTHOR,
): PromptAuthorBinding {
	return {
		schemaVersion: 1,
		type: "prompt-author",
		promptId,
		dispatchedAt: 10_000,
		modelText: text,
		source: author.kind === "agent" ? "agent" : "system",
		author,
		settlement: {
			schemaVersion: 1,
			type: "prompt-author-settlement",
			promptId,
			settledAt: 11_000,
			outcome: "echoed",
			...(messageId ? { messageId } : {}),
			...(messageTimestamp === undefined ? {} : { messageTimestamp }),
		},
	};
}

function unresolvedBinding(promptId: string, text: string, author: MessageAuthor): PromptAuthorBinding {
	const { settlement: _settlement, ...dispatch } = binding(promptId, text, undefined, undefined, author);
	return dispatch;
}

describe("spliceInFlightSteers occurrence correlation", () => {
	it("does not let a historical same-text row hide a newer structured steer", () => {
		const historical = userRow("old-user", "reroute");
		const messages = [historical, { id: "assistant", role: "assistant", content: "working" }];

		const result = spliceInFlightSteers(messages, [steer("reroute", "new-system-steer")]);

		expect(result).toHaveLength(3);
		expect(result.slice(0, 2)).toEqual(messages);
		expect(result[2]).toMatchObject({
			id: "inflight-steer:new-system-steer",
			role: "user",
			author: SYSTEM_AUTHOR,
			_inFlightSteer: true,
		});
	});

	it("keeps different-author repeated occurrences distinct through snapshot author merge", () => {
		const rawMessages = [{ id: "old-user", role: "user", content: [{ type: "text", text: "same" }] }];
		const bindings = [unresolvedBinding("agent-steer", "same", AGENT_AUTHOR)];
		const spliced = spliceInFlightSteers(
			rawMessages,
			[steer("same", "agent-steer", AGENT_AUTHOR)],
			bindings,
		);

		const result = mergeAuthorSidecarIntoMessages(bindings, spliced);

		expect(result).toHaveLength(2);
		expect(result[0].author).toEqual(LOCAL_USER_AUTHOR);
		expect(result[1].author).toEqual(AGENT_AUTHOR);
		expect(result[1].id).toBe("inflight-steer:agent-steer");
	});

	it("suppresses only the structured occurrence proven echoed by its settlement id", () => {
		const messages = [
			userRow("old-user", "reroute"),
			userRow("current-echo", "reroute", SYSTEM_AUTHOR),
		];
		const bindings = [binding("new-system-steer", "reroute", "current-echo")];

		const result = spliceInFlightSteers(
			messages,
			[steer("reroute", "new-system-steer")],
			bindings,
		);

		expect(result).toBe(messages);
	});

	it("does not use another same-text prompt's settlement as occurrence evidence", () => {
		const messages = [userRow("old-echo", "reroute")];
		const bindings = [binding("old-prompt", "reroute", "old-echo")];

		const result = spliceInFlightSteers(
			messages,
			[steer("reroute", "new-system-steer")],
			bindings,
		);

		expect(result).toHaveLength(2);
		expect(result[1].id).toBe("inflight-steer:new-system-steer");
		expect(result[1].author).toEqual(SYSTEM_AUTHOR);
	});

	it("retains occurrence-unaware multiset compatibility for legacy string records", () => {
		const messages = [userRow("legacy-echo", "legacy")];

		const result = spliceInFlightSteers(messages, ["legacy", "legacy"]);

		expect(result).toHaveLength(2);
		expect(result[1]).toMatchObject({
			id: "inflight-steer:1:legacy",
			author: LOCAL_USER_AUTHOR,
			_inFlightSteer: true,
		});
	});
});
