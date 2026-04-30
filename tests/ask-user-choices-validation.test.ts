/**
 * Unit tests for src/server/agent/ask-user-choices-validation.ts —
 * specifically the `tab_label` rules added alongside the widget's keyboard
 * navigation work.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateQuestions, crossValidate } from "../src/server/agent/ask-user-choices-validation.ts";

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

describe("validateQuestions — always-on Other", () => {
	it("accepts a payload without allow_other (Other is automatic)", () => {
		const err = validateQuestions([
			{ question: "Q1", options: ["a", "b"] },
		]);
		assert.equal(err, null);
	});

	it("silently accepts stale allow_other=true (backward-compat)", () => {
		const err = validateQuestions([
			{ question: "Q1", options: ["a", "b"], allow_other: true } as any,
		]);
		assert.equal(err, null);
	});

	it("silently accepts stale allow_other=false (backward-compat)", () => {
		const err = validateQuestions([
			{ question: "Q1", options: ["a", "b"], allow_other: false } as any,
		]);
		assert.equal(err, null);
	});

	it("silently accepts stale allow_other set to a non-boolean value (ignored)", () => {
		const err = validateQuestions([
			{ question: "Q1", options: ["a", "b"], allow_other: "yes" } as any,
		]);
		assert.equal(err, null);
	});

	it("multi-select min/max boundary considers options.length + 1 (Other counts)", () => {
		// 2 options + Other = 3 max. min=3 should be accepted.
		const ok = validateQuestions([
			{ question: "Pick", options: ["a", "b"], multi: true, min: 3, max: 3 },
		]);
		assert.equal(ok, null);
		// min=4 exceeds (2 options + Other = 3) and is rejected.
		const err = validateQuestions([
			{ question: "Pick", options: ["a", "b"], multi: true, min: 4 },
		]);
		assert.ok(err);
		assert.match(err!, /min/);
	});
});

describe("crossValidate — always-on Other", () => {
	it("accepts a single-select 'Other' answer when question did not pass allow_other", () => {
		const err = crossValidate(
			[{ question: "Q1", options: ["a", "b"] }],
			[{ question: "Q1", selected: "Other", other_text: "freeform" }],
		);
		assert.equal(err, null);
	});

	it("requires non-empty other_text when 'Other' is selected", () => {
		const err = crossValidate(
			[{ question: "Q1", options: ["a", "b"] }],
			[{ question: "Q1", selected: "Other", other_text: "" }],
		);
		assert.ok(err);
		assert.match(err!, /other_text/);
	});

	it("accepts multi-select with all options + Other (max = options.length + 1)", () => {
		const err = crossValidate(
			[{ question: "Pick", options: ["a", "b"], multi: true }],
			[{ question: "Pick", selected: ["a", "b", "Other"], other_text: "x" }],
		);
		assert.equal(err, null);
	});
});
