/**
 * Unit tests for ToolRetryHarness.
 *
 * Mirrors `tests/verification-reminder-race.test.ts` — uses a FakeSession
 * with a tiny event bus, no real pi-coding-agent dependency.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	ToolRetryHarness,
	detectStructuredValidationError,
	type ToolExecutionEndEvent,
} from "../src/server/agent/tool-retry-harness.js";

class FakeSession {
	id: string;
	prompts: string[] = [];
	private cbs: Array<(e: any) => void> = [];
	_verificationOwnedToolUses?: Set<string>;

	rpcClient = {
		prompt: async (text: string) => {
			this.prompts.push(text);
		},
		onEvent: (cb: (e: any) => void) => {
			this.cbs.push(cb);
			return () => {
				const i = this.cbs.indexOf(cb);
				if (i >= 0) this.cbs.splice(i, 1);
			};
		},
	};

	constructor(id: string) { this.id = id; }
	fire(event: any) { for (const cb of [...this.cbs]) cb(event); }
}

/** Wait for the next microtask drain so the harness's async _handleEvent can run. */
async function drain(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

function makeJsonErrEvent(toolUseId: string, toolName = "verification_result"): ToolExecutionEndEvent {
	return {
		type: "tool_execution_end",
		toolCallId: toolUseId,
		toolName,
		isError: true,
		result: {
			content: [{
				type: "text",
				text: "Validation failed for tool verification_result: Expected ',' or '}' after property value in JSON at position 320",
			}],
		},
	};
}

function makeOkErrEvent(toolUseId: string, toolName: string, errorText: string): ToolExecutionEndEvent {
	return {
		type: "tool_execution_end",
		toolCallId: toolUseId,
		toolName,
		isError: false,
		result: {
			content: [{ type: "text", text: JSON.stringify({ error: errorText }) }],
		},
	};
}

function makeDomainErrEvent(toolUseId: string, toolName = "bash"): ToolExecutionEndEvent {
	return {
		type: "tool_execution_end",
		toolCallId: toolUseId,
		toolName,
		isError: true,
		result: {
			content: [{ type: "text", text: "/bin/sh: 1: nosuch: not found\nexit code 127" }],
		},
	};
}

describe("tool-retry-harness — classifier + retry loop", () => {
	it("schema-class JSON error triggers exactly one nudge prompt", async () => {
		const session = new FakeSession("s1");
		const metadataEvents: Array<{ count: number; lastReason: string }> = [];
		const harness = new ToolRetryHarness({
			session,
			onMetadata: (d) => metadataEvents.push(d),
			debug: () => {},
		});
		harness.start();

		session.fire(makeJsonErrEvent("tu_1"));
		await drain();

		assert.equal(session.prompts.length, 1);
		assert.match(session.prompts[0], /verification_result/);
		assert.match(session.prompts[0], /validation error/i);
		assert.equal(metadataEvents.length, 1);
		assert.equal(metadataEvents[0].count, 1);
		assert.match(metadataEvents[0].lastReason, /verification_result/);
		harness.stop();
	});

	it("domain error (bash exit 127) does NOT trigger a nudge", async () => {
		const session = new FakeSession("s2");
		const harness = new ToolRetryHarness({ session, debug: () => {} });
		harness.start();

		session.fire(makeDomainErrEvent("tu_2"));
		await drain();

		assert.equal(session.prompts.length, 0);
		// Classifier sanity:
		assert.equal(harness.classify(makeDomainErrEvent("tu_2")), "domain");
		harness.stop();
	});

	it("three consecutive schema errors with same tool_use_id → exactly two nudges (cap)", async () => {
		const session = new FakeSession("s3");
		const harness = new ToolRetryHarness({ session, maxRetries: 2, debug: () => {} });
		harness.start();

		for (let i = 0; i < 3; i++) {
			session.fire(makeJsonErrEvent("tu_cap"));
			await drain();
		}

		assert.equal(session.prompts.length, 2);
		harness.stop();
	});

	it("ask_user_choices ok({error}) body is classified as schema (isError=false)", async () => {
		const session = new FakeSession("s4");
		const harness = new ToolRetryHarness({ session, debug: () => {} });
		harness.start();

		const evt = makeOkErrEvent(
			"tu_ask",
			"ask_user_choices",
			"ask_user_choices: questions[0].tab_label is required for multi-question asks (2–4 words, ≤24 chars).",
		);
		assert.equal(harness.classify(evt), "schema");

		session.fire(evt);
		await drain();

		assert.equal(session.prompts.length, 1);
		assert.match(session.prompts[0], /ask_user_choices/);
		harness.stop();
	});

	it("propose_* ok({error}) body is classified as schema", () => {
		// Pure classifier test — no harness wiring needed.
		const text = JSON.stringify({ error: "propose_goal: title must be ≤29 chars (got 42)." });
		assert.equal(detectStructuredValidationError(text)?.startsWith("propose_goal:"), true);
	});

	it("verification-owned tool_use_id is skipped by the generic harness", async () => {
		const session = new FakeSession("s5");
		session._verificationOwnedToolUses = new Set(["tu_owned"]);
		const harness = new ToolRetryHarness({ session, debug: () => {} });
		harness.start();

		session.fire(makeJsonErrEvent("tu_owned"));
		await drain();

		assert.equal(session.prompts.length, 0, "verification-owned tool_use should not be retried by the generic harness");

		// A different tool_use_id IS retried.
		session.fire(makeJsonErrEvent("tu_other"));
		await drain();
		assert.equal(session.prompts.length, 1);
		harness.stop();
	});

	it("success after a nudge clears the retry count for that tool_use_id", async () => {
		const session = new FakeSession("s6");
		const harness = new ToolRetryHarness({ session, maxRetries: 2, debug: () => {} });
		harness.start();

		// Two errors → two nudges (cap reached).
		session.fire(makeJsonErrEvent("tu_seq"));
		await drain();
		session.fire(makeJsonErrEvent("tu_seq"));
		await drain();
		assert.equal(session.prompts.length, 2);

		// Success on the same tool_use_id resets the counter.
		session.fire({
			type: "tool_execution_end",
			toolCallId: "tu_seq",
			toolName: "verification_result",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }] },
		});
		await drain();

		// Now another error on the same id should produce another nudge (counter reset).
		session.fire(makeJsonErrEvent("tu_seq"));
		await drain();
		assert.equal(session.prompts.length, 3);
		harness.stop();
	});
});
