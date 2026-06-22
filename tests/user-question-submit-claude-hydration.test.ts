import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
	findAskUserChoicesQuestions,
	loadHydratedMessagesForAskSubmit,
} from "../src/server/server.ts";

const questions = [
	{
		question: "Which fix should run?",
		options: ["Hydrate transcript", "Skip"],
	},
];

describe("user-question submit Claude Code transcript hydration", () => {
	it("finds a restored Claude Code ask widget when bridge memory is empty", async () => {
		const restoredMessages = [
			{
				id: "assistant-ask",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "toolu_restored_ask",
						name: "ask_user_choices",
						input: { questions },
					},
				],
			},
		];
		const session = {
			rpcClient: {
				getMessages: mock.fn(async () => ({ success: true, data: { messages: [] } })),
			},
		};
		const manager = {
			hydrateClaudeCodeSnapshotMessages: mock.fn(async (_sessionId: string, _liveData: unknown) => ({ messages: restoredMessages })),
		};

		const messages = await loadHydratedMessagesForAskSubmit(manager as any, "session-restored", session);
		const matched = findAskUserChoicesQuestions(messages, "toolu_restored_ask");

		assert.equal(session.rpcClient.getMessages.mock.callCount(), 1);
		assert.equal(manager.hydrateClaudeCodeSnapshotMessages.mock.callCount(), 1);
		assert.deepEqual(matched, questions);
	});
});
