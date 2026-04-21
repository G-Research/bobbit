/**
 * Unit tests for src/server/agent/ask-user-choices-validation.ts —
 * specifically the `tab_label` rules added alongside the widget's keyboard
 * navigation work.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateQuestions } from "../src/server/agent/ask-user-choices-validation.ts";

describe("validateQuestions — tab_label", () => {
	it("accepts a single-question ask without tab_label", () => {
		const err = validateQuestions([
			{ question: "Only?", options: ["a", "b"] },
		]);
		assert.equal(err, null);
	});

	it("accepts a single-question ask with a valid tab_label", () => {
		const err = validateQuestions([
			{ question: "Only?", options: ["a", "b"], tab_label: "Topic" },
		]);
		assert.equal(err, null);
	});

	it("accepts a multi-question ask where every question has a valid tab_label", () => {
		const err = validateQuestions([
			{ question: "Q1", options: ["a", "b"], tab_label: "First" },
			{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
		]);
		assert.equal(err, null);
	});

	it("rejects a multi-question ask when any tab_label is missing", () => {
		const err = validateQuestions([
			{ question: "Q1", options: ["a", "b"], tab_label: "First" },
			{ question: "Q2", options: ["c", "d"] },
		]);
		assert.ok(err);
		assert.match(err!, /tab_label/);
		assert.match(err!, /\[1\]/);
	});

	it("rejects a multi-question ask when tab_label is an empty string", () => {
		const err = validateQuestions([
			{ question: "Q1", options: ["a", "b"], tab_label: "" },
			{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
		]);
		assert.ok(err);
		assert.match(err!, /tab_label/);
	});

	it("rejects tab_label longer than 24 characters", () => {
		const longLabel = "x".repeat(25);
		const err = validateQuestions([
			{ question: "Q1", options: ["a", "b"], tab_label: longLabel },
			{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
		]);
		assert.ok(err);
		assert.match(err!, /24/);
	});

	it("rejects tab_label longer than 24 characters on a single-question ask", () => {
		// Even if optional, when present it must be valid.
		const longLabel = "x".repeat(25);
		const err = validateQuestions([
			{ question: "Only?", options: ["a", "b"], tab_label: longLabel },
		]);
		assert.ok(err);
		assert.match(err!, /24/);
	});

	it("rejects non-string tab_label", () => {
		const err = validateQuestions([
			{ question: "Q1", options: ["a", "b"], tab_label: 42 as any },
			{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
		]);
		assert.ok(err);
		assert.match(err!, /tab_label/);
	});
});
