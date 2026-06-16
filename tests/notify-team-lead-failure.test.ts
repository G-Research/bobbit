import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildVerificationFailureMessage } from "../src/server/agent/notify-team-lead-failure.ts";

describe("buildVerificationFailureMessage", () => {
	it("does not append merge-gap diagnostics for command failures", () => {
		const message = buildVerificationFailureMessage("execution", [
			{ name: "Unit tests", type: "command", passed: false, output: "AssertionError: expected 1 to equal 2" },
		]);

		assert.match(message, /Gate verification FAILED: "execution"/);
		assert.match(message, /Failed step\(s\): "Unit tests"/);
		assert.doesNotMatch(message, /Possible merge gap/);
		assert.doesNotMatch(message, /git for-each-ref/);
	});

	it("truncates long failed-step output from the tail", () => {
		const output = `START\n${"x".repeat(610)}\nTAIL`;
		const message = buildVerificationFailureMessage("execution", [
			{ name: "Unit tests", type: "command", passed: false, output },
		]);

		assert.match(message, /… \(truncated, \d+ earlier chars\)/);
		assert.doesNotMatch(message, /START/);
		assert.match(message, /TAIL$/);
	});
});
