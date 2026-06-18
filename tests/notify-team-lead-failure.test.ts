import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildVerificationFailureMessage } from "../src/server/agent/notify-team-lead-failure.ts";

describe("buildVerificationFailureMessage", () => {
	it("formats command failures as compact markdown with inspect command and no output snippet", () => {
		const message = buildVerificationFailureMessage("execution", [
			{ name: "Unit tests", type: "command", passed: false, output: "AssertionError: expected 1 to equal 2" },
		]);

		assert.match(message, /^\*\*Gate verification FAILED\*\*/);
		assert.doesNotMatch(message, /^#{1,6}\s+Gate verification FAILED/m);
		assert.match(message, /\*\*Failed gate:\*\* `execution` — `Unit tests`/);
		assert.match(message, /\*\*Failed step:\*\* `Unit tests` \(`command`\)/);
		assert.match(message, /\*\*Inspect:\*\*\n```text\ngate_inspect\(gate_id="execution", section="verification", step="Unit tests", mode="tail", lines=120\)\n```/);
		assert.match(message, /\*\*Next:\*\* inspect each failed step, fix issues, then re-signal gate\./);
		assert.doesNotMatch(message, /AssertionError: expected 1 to equal 2/);
		assert.doesNotMatch(message, /\*\*First output/);
		assert.doesNotMatch(message, /Possible merge gap/);
		assert.doesNotMatch(message, /git for-each-ref/);
	});

	it("formats reviewer failures without blockquoted output", () => {
		const message = buildVerificationFailureMessage("review", [
			{ name: "LLM review", type: "llm-review", passed: false, output: "Found an issue\n- src/app.ts:1" },
		]);

		assert.match(message, /\*\*Failed gate:\*\* `review` — `LLM review`/);
		assert.match(message, /\*\*Failed step:\*\* `LLM review` \(`llm-review`\)/);
		assert.match(message, /gate_inspect\(gate_id="review", section="verification", step="LLM review", mode="tail", lines=120\)/);
		assert.doesNotMatch(message, /Found an issue/);
		assert.doesNotMatch(message, /^> - src\/app\.ts:1/m);
	});

	it("summarizes multiple failures and interleaves each inspect command with its failed step", () => {
		const message = buildVerificationFailureMessage("ready-to-merge", [
			{ name: "Unit tests", type: "command", passed: false, output: "unit output" },
			{ name: "Typecheck", type: "command", passed: false, output: "type output" },
			{ name: "E2E", type: "command", passed: false, output: "e2e output" },
			{ name: "Review", type: "llm-review", passed: false, output: "review output" },
			{ name: "QA", type: "agent-qa", passed: false, output: "qa output" },
			{ name: "Signoff", type: "human-signoff", passed: false, output: "signoff output" },
		]);

		assert.match(message, /\*\*Failed gate:\*\* `ready-to-merge` — `Unit tests`, `Typecheck`, `E2E`, `Review`, `QA` and 1 more/);
		assert.doesNotMatch(message, /unit output/);
		assert.doesNotMatch(message, /type output/);
		assert.doesNotMatch(message, /review output/);
		const unitStepIndex = message.indexOf("**Failed step:** `Unit tests`");
		const unitInspectIndex = message.indexOf('gate_inspect(gate_id="ready-to-merge", section="verification", step="Unit tests", mode="tail", lines=120)');
		const typeStepIndex = message.indexOf("**Failed step:** `Typecheck`");
		const typeInspectIndex = message.indexOf('gate_inspect(gate_id="ready-to-merge", section="verification", step="Typecheck", mode="tail", lines=120)');
		assert.ok(unitStepIndex >= 0 && unitInspectIndex > unitStepIndex);
		assert.ok(typeStepIndex > unitInspectIndex && typeInspectIndex > typeStepIndex);
		assert.match(message, /step="Signoff"/);
	});

	it("omits skipped later-phase steps from failed-step inspect commands", () => {
		const message = buildVerificationFailureMessage("ready-to-merge", [
			{ name: "Unit tests", type: "command", passed: false, output: "unit output" },
			{ name: "Code review", type: "llm-review", passed: false, skipped: true, output: "Skipped — earlier phase failed" },
			{ name: "QA", type: "agent-qa", passed: false, skipped: true, output: "Skipped — earlier phase failed" },
		]);

		assert.match(message, /\*\*Failed gate:\*\* `ready-to-merge` — `Unit tests`/);
		assert.match(message, /step="Unit tests"/);
		assert.doesNotMatch(message, /\*\*Failed step:\*\* `Code review`/);
		assert.doesNotMatch(message, /\*\*Failed step:\*\* `QA`/);
		assert.doesNotMatch(message, /step="Code review"/);
		assert.doesNotMatch(message, /step="QA"/);
	});

	it("omits long failed-step output entirely instead of truncating it", () => {
		const output = `START\n${"x".repeat(610)}\nTAIL`;
		const message = buildVerificationFailureMessage("execution", [
			{ name: "Unit tests", type: "command", passed: false, output },
		]);

		assert.doesNotMatch(message, /\*\*First output \(truncated\):\*\*/);
		assert.doesNotMatch(message, /… \(truncated, \d+ earlier chars\)/);
		assert.doesNotMatch(message, /START/);
		assert.doesNotMatch(message, /TAIL/);
		assert.match(message, /gate_inspect\(gate_id="execution", section="verification", step="Unit tests", mode="tail", lines=120\)/);
	});

	it("does not need longer fences when command output contains backticks", () => {
		const message = buildVerificationFailureMessage("execution", [
			{ name: "Unit tests", type: "command", passed: false, output: "before\n```\ninside\n```\nafter" },
		]);

		assert.doesNotMatch(message, /````text/);
		assert.doesNotMatch(message, /inside/);
		assert.match(message, /```text\ngate_inspect\(gate_id="execution", section="verification", step="Unit tests", mode="tail", lines=120\)\n```/);
	});
});
