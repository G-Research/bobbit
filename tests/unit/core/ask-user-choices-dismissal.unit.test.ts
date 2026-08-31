import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	AskQuestionTerminalGuard,
	backfillUnansweredAskState,
	findAskUserChoicesQuestions,
	hasUnansweredAskUserChoices,
	normalizeDismissedAskToolUseIds,
	successfulPostedAskToolUseId,
} from "../../../src/server/agent/ask-user-choices-dismissal.js";

const questions = [{ question: "Pick one", options: ["a", "b"] }];

function ask(id: string) {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "ask_user_choices", arguments: { questions } }] };
}

function posted(id: string) {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "ask_user_choices",
		content: [{ type: "text", text: JSON.stringify({ status: "posted", tool_use_id: id }) }],
	};
}

describe("ask_user_choices durable dismissal state", () => {
	it("linearizes answer-vs-dismiss by first reservation and permits rollback", () => {
		const submitFirst = new AskQuestionTerminalGuard();
		assert.deepEqual(submitFirst.reserveSubmit("s", "a"), { acquired: true });
		assert.deepEqual(submitFirst.reserveDismiss("s", "a"), { acquired: false, state: "submitting" });
		assert.equal(submitFirst.completeSubmit("s", "a"), true);
		assert.deepEqual(submitFirst.reserveDismiss("s", "a"), { acquired: false, state: "answered" });

		const dismissFirst = new AskQuestionTerminalGuard();
		assert.deepEqual(dismissFirst.reserveDismiss("s", "a"), { acquired: true });
		assert.deepEqual(dismissFirst.reserveSubmit("s", "a"), { acquired: false, state: "dismissing" });
		assert.equal(dismissFirst.rollbackDismiss("s", "a"), true);
		assert.deepEqual(dismissFirst.reserveSubmit("s", "a"), { acquired: true });
		assert.equal(dismissFirst.rollbackSubmit("s", "a"), true);
		assert.equal(dismissFirst.state("s", "a"), undefined);
	});

	it("does not let durable observation overwrite an in-flight winner", () => {
		const guard = new AskQuestionTerminalGuard();
		guard.reserveDismiss("s", "a");
		assert.equal(guard.observeAnswered("s", "a"), "dismissing");
		assert.equal(guard.state("s", "a"), "dismissing");
	});

	it("normalizes opaque IDs without trimming and removes malformed duplicates", () => {
		assert.deepEqual(normalizeDismissedAskToolUseIds(["a", "a", " b ", "", 7, null]), ["a", " b "]);
		assert.deepEqual(normalizeDismissedAskToolUseIds({}), []);
	});

	it("finds both Pi tool-call shapes and rejects non-ask matches", () => {
		assert.deepEqual(findAskUserChoicesQuestions([ask("ask-1")], "ask-1"), questions);
		assert.deepEqual(findAskUserChoicesQuestions([{
			role: "assistant",
			content: [{ type: "tool_use", id: "ask-2", name: "ask_user_choices", input: { questions } }],
		}], "ask-2"), questions);
		assert.equal(findAskUserChoicesQuestions([ask("ask-1")], "other"), null);
	});

	it("recognizes only a successful posted result with the matching opaque ID", () => {
		assert.equal(successfulPostedAskToolUseId(posted("ask|1")), "ask|1");
		assert.equal(successfulPostedAskToolUseId({ ...posted("ask-1"), isError: true }), null);
		assert.equal(successfulPostedAskToolUseId({ ...posted("ask-1"), toolName: "other" }), null);
	});

	it("keeps multiple asks pending until each is answered, failed, or dismissed", () => {
		const messages: any[] = [ask("a"), posted("a"), ask("b"), posted("b")];
		assert.equal(hasUnansweredAskUserChoices(messages, new Set()), true);
		assert.equal(hasUnansweredAskUserChoices(messages, new Set(["a"])), true);
		assert.equal(hasUnansweredAskUserChoices(messages, new Set(["a", "b"])), false);
		assert.equal(hasUnansweredAskUserChoices(messages, new Set(["a"]), new Set(["b"])), false);

		messages.push({
			role: "user",
			content: `[ask_user_choices_response tool_use_id=b]\n${JSON.stringify({ answers: [{ question: "Pick one", selected: "a", other_text: null }] })}`,
		});
		assert.equal(hasUnansweredAskUserChoices(messages, new Set(["a"])), false);
	});

	it("does not count failed or completed unknown results as unanswered", () => {
		const errored = { ...posted("a"), isError: true };
		const unknown = { ...posted("b"), content: [{ type: "text", text: "{}" }] };
		assert.equal(hasUnansweredAskUserChoices([ask("a"), errored, ask("b"), unknown], new Set()), false);
	});

	it("backfills only legacy rows from restored transcript state", () => {
		const pending = [ask("a"), posted("a")];
		assert.equal(backfillUnansweredAskState(undefined, pending, []), true);
		assert.equal(backfillUnansweredAskState(undefined, pending, ["a"]), false);
		assert.equal(backfillUnansweredAskState(false, pending, []), undefined);
		assert.equal(backfillUnansweredAskState(undefined, { messages: pending }, []), undefined);
	});
});
