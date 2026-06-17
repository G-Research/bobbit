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
		assert.match(message, /\*\*Inspect:\*\*\n```text\ngate_inspect\(gate_id="execution", section="verification", step="Unit tests", mode="tail", lines=120\)\n```/);
		assert.match(message, /\*\*Next:\*\* fix issues; re-signal gate\./);
		assert.doesNotMatch(message, /Possible merge gap/);
		assert.doesNotMatch(message, /git for-each-ref/);
	});

	it("formats reviewer failures as compact markdown with blockquoted output", () => {
		const message = buildVerificationFailureMessage("review", [
			{ name: "LLM review", type: "llm-review", passed: false, output: "Found an issue\n- src/app.ts:1" },
		]);

		assert.match(message, /\*\*First output:\*\* `LLM review` \(`llm-review`\)\n> Found an issue\n> - src\/app\.ts:1/);
		assert.match(message, /gate_inspect\(gate_id="review", section="verification", step="LLM review", mode="tail", lines=120\)/);
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
		assert.match(message, /step="Unit tests"/);
		assert.match(message, /step="Typecheck"/);
		assert.match(message, /step="Signoff"/);
	});

	it("truncates long failed-step output from the tail", () => {
		const output = `START\n${"x".repeat(610)}\nTAIL`;
		const message = buildVerificationFailureMessage("execution", [
			{ name: "Unit tests", type: "command", passed: false, output },
		]);

		assert.match(message, /\*\*First output \(truncated\):\*\*/);
		assert.match(message, /… \(truncated, \d+ earlier chars\)/);
		assert.doesNotMatch(message, /START/);
		assert.match(message, /TAIL\n```\n\n\*\*Inspect:/);
	});

	it("uses a longer fence when command output contains backticks", () => {
		const message = buildVerificationFailureMessage("execution", [
			{ name: "Unit tests", type: "command", passed: false, output: "before\n```\ninside\n```\nafter" },
		]);

		assert.match(message, /````text\nbefore\n```\ninside\n```\nafter\n````/);
	});
});
