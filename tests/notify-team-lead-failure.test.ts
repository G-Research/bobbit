import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildVerificationFailureMessage } from "../src/server/agent/notify-team-lead-failure.ts";

describe("buildVerificationFailureMessage", () => {
	it("formats command failures as compact markdown with fenced output", () => {
		const message = buildVerificationFailureMessage("execution", [
			{ name: "Unit tests", type: "command", passed: false, output: "AssertionError: expected 1 to equal 2" },
		]);

		assert.match(message, /### Gate verification FAILED/);
		assert.match(message, /\*\*Gate:\*\* `execution`/);
		assert.match(message, /\*\*Failed:\*\* `Unit tests`/);
		assert.match(message, /\*\*First output:\*\* `Unit tests` \(`command`\)\n```text\nAssertionError: expected 1 to equal 2\n```/);
		assert.match(message, /\*\*Next:\*\* `gate_status` \/ `gate_inspect`; fix issues; re-signal gate\./);
		assert.doesNotMatch(message, /Possible merge gap/);
		assert.doesNotMatch(message, /git for-each-ref/);
	});

	it("formats reviewer failures as compact markdown with blockquoted output", () => {
		const message = buildVerificationFailureMessage("review", [
			{ name: "LLM review", type: "llm-review", passed: false, output: "Found an issue\n- src/app.ts:1" },
		]);

		assert.match(message, /\*\*First output:\*\* `LLM review` \(`llm-review`\)\n> Found an issue\n> - src\/app\.ts:1/);
		assert.doesNotMatch(message, /```/);
	});

	it("summarizes multiple failures and only includes the first output", () => {
		const message = buildVerificationFailureMessage("ready-to-merge", [
			{ name: "Unit tests", type: "command", passed: false, output: "unit output" },
			{ name: "Typecheck", type: "command", passed: false, output: "type output" },
			{ name: "E2E", type: "command", passed: false, output: "e2e output" },
			{ name: "Review", type: "llm-review", passed: false, output: "review output" },
			{ name: "QA", type: "agent-qa", passed: false, output: "qa output" },
			{ name: "Signoff", type: "human-signoff", passed: false, output: "signoff output" },
		]);

		assert.match(message, /\*\*Failed:\*\* `Unit tests`, `Typecheck`, `E2E`, `Review`, `QA` and 1 more/);
		assert.match(message, /unit output/);
		assert.doesNotMatch(message, /type output/);
		assert.doesNotMatch(message, /review output/);
	});

	it("truncates long failed-step output from the tail", () => {
		const output = `START\n${"x".repeat(610)}\nTAIL`;
		const message = buildVerificationFailureMessage("execution", [
			{ name: "Unit tests", type: "command", passed: false, output },
		]);

		assert.match(message, /… \(truncated, \d+ earlier chars\)/);
		assert.doesNotMatch(message, /START/);
		assert.match(message, /TAIL\n```\n\*\*Next:/);
	});

	it("uses a longer fence when command output contains backticks", () => {
		const message = buildVerificationFailureMessage("execution", [
			{ name: "Unit tests", type: "command", passed: false, output: "before\n```\ninside\n```\nafter" },
		]);

		assert.match(message, /````text\nbefore\n```\ninside\n```\nafter\n````/);
	});
});
